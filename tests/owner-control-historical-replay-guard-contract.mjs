import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.join(root, 'supabase', 'migrations');
const historical = await fs.readFile(
  path.join(migrationsDir, '202608311800_owner_subscription_control.sql'),
  'utf8'
);
const driveEvidence = await fs.readFile(
  path.join(migrationsDir, '202609010600_owner_drive_backup_evidence.sql'),
  'utf8'
);
const replayGuard = await fs.readFile(
  path.join(migrationsDir, '202609010700_owner_control_historical_replay_guard.sql'),
  'utf8'
);
const subscriptionConcurrency = await fs.readFile(
  path.join(migrationsDir, '202609010800_owner_subscription_concurrency.sql'),
  'utf8'
);
const forwardOnlyGuard = await fs.readFile(
  path.join(migrationsDir, '202609011100_owner_subscription_forward_only_guard.sql'),
  'utf8'
);

assert.equal(
  createHash('sha256').update(historical).digest('hex'),
  'f4a00ed5595d710cb2c66107e7f1071fdb2179adfa3fff6b9a690a88556f8c43',
  'the already-applied historical migration must remain byte-for-byte identical to HEAD'
);
assert.doesNotMatch(historical, /owner_control_historical_replay_guard|HISTORICAL_REPLAY_BLOCKED/);
assert.match(replayGuard, /^begin;/i);
assert.match(replayGuard, /create table if not exists public\.owner_control_historical_replay_guard/);
assert.match(replayGuard, /historical_sha256/);
assert.match(replayGuard, /f4a00ed5595d710cb2c66107e7f1071fdb2179adfa3fff6b9a690a88556f8c43/);
assert.match(replayGuard, /alter table public\.owner_control_historical_replay_guard force row level security/);
assert.match(
  replayGuard,
  /revoke all on public\.owner_control_historical_replay_guard\s+from public, anon, authenticated, service_role/
);
assert.doesNotMatch(
  replayGuard,
  /grant\s+(?:select|insert|update|delete|all)[^;]*owner_control_historical_replay_guard/i
);
assert.match(replayGuard, /commit;\s*select 'OWNER_CONTROL_HISTORICAL_REPLAY_GUARD_READY' as status;/i);
assert.match(forwardOnlyGuard, /set_clinic_subscription_state_v20260901/);
assert.match(forwardOnlyGuard, /cnyos\.owner_subscription_forward_guard/);
assert.match(forwardOnlyGuard, /service-role-rpc\/v1/);
assert.match(forwardOnlyGuard, /v_result := public\.set_clinic_subscription_state_v20260901/);
assert.match(
  forwardOnlyGuard,
  /pg_catalog\.set_config\(\s*'cnyos\.owner_subscription_forward_guard',\s*'',\s*true\s*\)/
);
assert.match(forwardOnlyGuard, /exception\s+when others then/i);
assert.match(forwardOnlyGuard, /trg_clinics_owner_subscription_forward_only/);
assert.match(forwardOnlyGuard, /for each statement execute function public\.guard_owner_subscription_forward_only\(\)/);
assert.match(forwardOnlyGuard, /CNYOS_OWNER_SUBSCRIPTION_HISTORICAL_REPLAY_BLOCKED/);

const db = new PGlite();

await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create function auth.role() returns text language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.role', true), ''),
      'authenticated'
    )::text
  $$;
  grant usage on schema auth to authenticated, service_role;
  grant execute on function auth.uid(), auth.role() to authenticated, service_role;

  create function public.gen_random_uuid() returns uuid language sql volatile as $$
    select (
      substr(x,1,8)||'-'||substr(x,9,4)||'-4'||substr(x,14,3)||
      '-a'||substr(x,18,3)||'-'||substr(x,21,12)
    )::uuid
    from (select md5(random()::text || clock_timestamp()::text) x) s
  $$;

  create function public.reject_append_only_mutation()
  returns trigger
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog
  as $$
  begin
    raise exception 'APPEND_ONLY_RECORD_MUTATION_DENIED'
      using errcode = '55000', detail = tg_table_schema || '.' || tg_table_name;
  end;
  $$;
  revoke all on function public.reject_append_only_mutation()
    from public, anon, authenticated, service_role;

  create table public.profiles (
    id uuid primary key,
    system_role text not null default 'staff'
  );
  create table public.clinics (
    id uuid primary key,
    code text not null unique,
    name_th text not null,
    name_en text,
    active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  create table public.clinic_memberships (
    clinic_id uuid not null references public.clinics(id),
    profile_id uuid not null references public.profiles(id),
    clinic_role text not null,
    active boolean not null default true,
    is_primary boolean not null default false,
    joined_at timestamptz not null default now(),
    primary key (clinic_id, profile_id)
  );

  create function public.current_user_role()
  returns text
  language sql
  stable
  as $$ select 'viewer'::text $$;

  create function public.export_clinic_backup_domain(
    p_clinic_id uuid,
    p_domain text
  ) returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = public
  as $$
  begin
    if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
    return jsonb_build_object(
      'format', 'chananya-domain-export/v1',
      'schema_version', '2026-08-29.1',
      'clinic_id', p_clinic_id,
      'domain', p_domain,
      'included_tables', '[]'::jsonb,
      'data', '{}'::jsonb
    );
  end;
  $$;
  revoke all on function public.export_clinic_backup_domain(uuid, text)
    from public, anon, authenticated;
  grant execute on function public.export_clinic_backup_domain(uuid, text)
    to service_role;

  create function public.backup_restore_contract_healthcheck()
  returns table (
    ready boolean,
    schema_version text,
    domain_count integer,
    patient_table_count integer,
    product_table_count integer,
    pharmacy_table_count integer,
    transaction_table_count integer,
    managed_database_restore_required boolean
  )
  language sql
  stable
  security definer
  set search_path = public
  as $$ select true, '2026-08-29.1', 4, 31, 16, 7, 10, true $$;

  create function public.verify_clinic_restore_trace(p_clinic_id uuid)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = public
  as $$
  begin
    if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
    return jsonb_build_object(
      'ready', true,
      'schema_version', '2026-08-29.1',
      'clinic_id', p_clinic_id,
      'counts', '{}'::jsonb
    );
  end;
  $$;

  insert into public.clinics (
    id, code, name_th, name_en, active
  ) values (
    '00000000-0000-4000-8000-00000000a001',
    'JITARSA-STG',
    'คลินิกจิตอาสา',
    'Jitarsa Clinic',
    true
  );
`);

// The forward marker and terminal trigger do not exist during the first
// ordered application, so the immutable historical migration applies once.
await db.exec(historical);

await db.exec(`
  create table public.clinic_drive_destination_events (
    id uuid primary key,
    request_id uuid not null unique,
    clinic_id uuid not null,
    clinic_code text not null,
    environment text not null,
    expected_version bigint not null,
    assignment_version bigint not null,
    previous_assignment jsonb not null,
    new_assignment jsonb not null,
    changed boolean not null,
    reason text not null,
    actor_user_id uuid not null,
    actor_email text not null,
    created_at timestamptz not null
  );
  revoke all on public.clinic_drive_destination_events
    from public, anon, authenticated, service_role;
`);

await db.exec(driveEvidence);
await db.exec(replayGuard);
await db.exec(subscriptionConcurrency);
await db.exec(forwardOnlyGuard);

assert.equal(
  (await db.query(`
    select count(*)::int count
    from public.owner_control_historical_replay_guard
    where singleton
      and protected_migration='202608311800_owner_subscription_control'
      and historical_sha256='f4a00ed5595d710cb2c66107e7f1071fdb2179adfa3fff6b9a690a88556f8c43'
  `)).rows[0].count,
  1
);
assert.equal(
  (await db.query(`
    select relrowsecurity and relforcerowsecurity locked
    from pg_class
    where oid='public.owner_control_historical_replay_guard'::regclass
  `)).rows[0].locked,
  true
);

for (const role of ['anon', 'authenticated', 'service_role']) {
  for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
    assert.equal(
      (await db.query(`
        select has_table_privilege(
          '${role}',
          'public.owner_control_historical_replay_guard',
          '${privilege}'
        ) allowed
      `)).rows[0].allowed,
      false,
      `${role} must not receive ${privilege} on the replay sentinel`
    );
  }
}

assert.deepEqual(
  (await db.query(`
    select t.tgenabled, t.tgtype::int, p.proname
    from pg_trigger t
    join pg_proc p on p.oid=t.tgfoid
    where t.tgrelid='public.clinics'::regclass
      and t.tgname='trg_clinics_owner_subscription_forward_only'
  `)).rows,
  [{ tgenabled: 'O', tgtype: 18, proname: 'guard_owner_subscription_forward_only' }]
);
assert.equal(
  (await db.query(`
    select has_function_privilege(
      'service_role',
      'public.set_clinic_subscription_state_v20260901(uuid,uuid,text,boolean,bigint,text,uuid,text)',
      'EXECUTE'
    ) allowed
  `)).rows[0].allowed,
  false,
  'the archived concurrency implementation must not be directly executable'
);

// Statement-level protection must fire even when a replay-style UPDATE would
// match zero clinics; it cannot depend on a suspended row already existing.
await assert.rejects(
  db.exec(`
    update public.clinics
    set subscription_state=subscription_state
    where false
  `),
  /CNYOS_OWNER_SUBSCRIPTION_HISTORICAL_REPLAY_BLOCKED/
);
await db.exec('rollback;');

const CLINIC_ID = '00000000-0000-4000-8000-00000000a001';
const ACTOR_ID = '11111111-1111-4111-a111-111111111111';

async function asService(sql) {
  await db.exec(`
    reset role;
    select set_config('request.jwt.claim.role', 'service_role', false);
    set role service_role;
  `);
  try {
    return await db.query(sql);
  } finally {
    await db.exec('reset role;');
  }
}

async function setSubscription({ requestId, enabled, expectedVersion, reason }) {
  return asService(`
    select public.set_clinic_subscription_state(
      '${requestId}'::uuid,
      '${CLINIC_ID}'::uuid,
      'JITARSA-STG',
      ${enabled},
      ${expectedVersion}::bigint,
      '${reason}',
      '${ACTOR_ID}'::uuid,
      'owner@example.test'
    ) result
  `);
}

await setSubscription({
  requestId: '22222222-2222-4222-a222-222222222222',
  enabled: false,
  expectedVersion: 1,
  reason: 'Suspend staging before historical replay test'
});
assert.deepEqual(
  (await db.query(`
    select active, subscription_state, subscription_version
    from public.clinics
    where id='${CLINIC_ID}'
  `)).rows,
  [{ active: true, subscription_state: 'suspended', subscription_version: 2 }]
);

async function wrapperSources() {
  return (await db.query(`
    select p.proname, p.prosrc
    from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public'
      and p.proname in ('export_clinic_backup_domain','verify_clinic_restore_trace')
    order by p.proname
  `)).rows;
}

const wrappersBeforeReplay = await wrapperSources();
assert.equal(wrappersBeforeReplay.length, 2);
assert.ok(wrappersBeforeReplay.every(row => row.prosrc.includes('2026-09-01.1')));

// Every attempted historical replay must abort its transaction before the
// clinics update or CREATE OR REPLACE wrapper statements can run.
for (let attempt = 0; attempt < 2; attempt += 1) {
  await assert.rejects(
    db.exec(historical),
    /CNYOS_OWNER_SUBSCRIPTION_HISTORICAL_REPLAY_BLOCKED/
  );
  await db.exec('rollback;');

  assert.deepEqual(
    (await db.query(`
      select active, subscription_state, subscription_version
      from public.clinics
      where id='${CLINIC_ID}'
    `)).rows,
    [{ active: true, subscription_state: 'suspended', subscription_version: 2 }],
    'historical replay must not derive suspended state back to active'
  );
  assert.deepEqual(
    await wrapperSources(),
    wrappersBeforeReplay,
    'historical replay must not replace the 202609010600 export/restore wrappers'
  );
}

const transactionExport = await asService(`
  select public.export_clinic_backup_domain('${CLINIC_ID}'::uuid, 'transactions') payload
`);
assert.equal(transactionExport.rows[0].payload.schema_version, '2026-09-01.1');
assert.ok(Array.isArray(transactionExport.rows[0].payload.data.clinic_drive_destination_events));
const restoreTrace = await asService(`
  select public.verify_clinic_restore_trace('${CLINIC_ID}'::uuid) trace
`);
assert.equal(restoreTrace.rows[0].trace.schema_version, '2026-09-01.1');

// The forward trigger blocks direct mutation while the current audited RPC
// remains the supported reversible state transition.
const reactivated = await setSubscription({
  requestId: '33333333-3333-4333-a333-333333333333',
  enabled: true,
  expectedVersion: 2,
  reason: 'Reactivate staging through current owner control RPC'
});
assert.equal(reactivated.rows[0].result.state, 'active');
assert.deepEqual(
  (await db.query(`
    select active, subscription_state, subscription_version
    from public.clinics
    where id='${CLINIC_ID}'
  `)).rows,
  [{ active: true, subscription_state: 'active', subscription_version: 3 }]
);

// A successful/idempotent wrapper call must clear its transaction-local
// marker before returning. Otherwise the next direct UPDATE in the same
// service-role transaction could reuse the marker and bypass the guard.
await assert.rejects(
  db.exec(`
    begin;
    select set_config('request.jwt.claim.role', 'service_role', false);
    select public.set_clinic_subscription_state(
      '33333333-3333-4333-a333-333333333333'::uuid,
      '${CLINIC_ID}'::uuid,
      'JITARSA-STG',
      true,
      2::bigint,
      'Reactivate staging through current owner control RPC',
      '${ACTOR_ID}'::uuid,
      'owner@example.test'
    );
    update public.clinics
    set subscription_reason='Forbidden same-transaction direct mutation'
    where id='${CLINIC_ID}'::uuid;
    commit;
  `),
  /CNYOS_OWNER_SUBSCRIPTION_HISTORICAL_REPLAY_BLOCKED/
);
await db.exec('rollback;');
assert.equal(
  (await db.query(`
    select subscription_reason
    from public.clinics
    where id='${CLINIC_ID}'::uuid
  `)).rows[0].subscription_reason,
  'Reactivate staging through current owner control RPC'
);

await db.close();
console.log(
  'Owner Control historical replay guard contract passed: immutable historical SHA, locked marker, forward statement guard, preserved v0600 wrappers and functional audited ON/OFF'
);
