import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = await fs.readFile(
  path.join(root, 'supabase', 'migrations', '202609010800_owner_subscription_concurrency.sql'),
  'utf8'
);

const db = new PGlite();

await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;

  create schema auth;
  create function auth.role() returns text language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.role', true), ''),
      'authenticated'
    )::text
  $$;
  grant usage on schema auth to authenticated, service_role;
  grant execute on function auth.role() to authenticated, service_role;

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

  create table public.clinics (
    id uuid primary key,
    code text not null unique,
    name_th text not null,
    name_en text,
    active boolean not null default true,
    subscription_state text not null default 'active'
      check (subscription_state in ('active','suspended')),
    subscription_version bigint not null default 1
      check (subscription_version > 0),
    subscription_changed_at timestamptz,
    subscription_changed_by text,
    subscription_reason text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );

  create table public.clinic_subscription_control_events (
    id uuid primary key default public.gen_random_uuid(),
    request_id uuid not null unique,
    clinic_id uuid not null references public.clinics(id) on delete restrict,
    clinic_code text not null,
    previous_state text not null check (previous_state in ('active','suspended')),
    new_state text not null check (new_state in ('active','suspended')),
    subscription_version bigint not null check (subscription_version > 0),
    reason text not null check (char_length(reason) between 8 and 500),
    actor_user_id uuid not null,
    actor_email text not null,
    created_at timestamptz not null default now()
  );
  alter table public.clinic_subscription_control_events enable row level security;
  revoke all on public.clinic_subscription_control_events
    from public, anon, authenticated, service_role;
  grant select on public.clinic_subscription_control_events to service_role;

  create function public.set_clinic_subscription_state(
    p_request_id uuid,
    p_clinic_id uuid,
    p_expected_clinic_code text,
    p_enabled boolean,
    p_reason text,
    p_actor_user_id uuid,
    p_actor_email text
  ) returns jsonb
  language sql
  security definer
  set search_path = public
  as $$ select '{}'::jsonb $$;
  grant execute on function public.set_clinic_subscription_state(uuid,uuid,text,boolean,text,uuid,text)
    to service_role;

  insert into public.clinics (
    id, code, name_th, name_en, subscription_changed_at,
    subscription_changed_by, subscription_reason
  ) values
    (
      '00000000-0000-4000-8000-00000000a001',
      'JITARSA-STG',
      'คลินิกจิตอาสา',
      'Jitarsa Clinic',
      now(),
      'migration:test',
      'Initial active subscription'
    ),
    (
      '00000000-0000-4000-8000-00000000a002',
      'LEGACY-STG',
      'คลินิกเดิม',
      'Legacy Clinic',
      now(),
      'migration:test',
      'Legacy migration evidence'
    );

  insert into public.clinic_subscription_control_events (
    request_id, clinic_id, clinic_code, previous_state, new_state,
    subscription_version, reason, actor_user_id, actor_email
  ) values (
    '11111111-1111-4111-a111-111111111111',
    '00000000-0000-4000-8000-00000000a002',
    'LEGACY-STG',
    'active',
    'suspended',
    2,
    'Legacy state transition event',
    'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
    'legacy-owner@example.test'
  );
`);

await db.exec(migration);

assert.equal(
  (await db.query(`
    select expected_version
    from public.clinic_subscription_control_events
    where request_id='11111111-1111-4111-a111-111111111111'
  `)).rows[0].expected_version,
  1,
  'the forward migration must infer the expected version of legacy state-changing events'
);

assert.equal(
  (await db.query(`
    select to_regprocedure(
      'public.set_clinic_subscription_state(uuid,uuid,text,boolean,text,uuid,text)'
    ) is null removed
  `)).rows[0].removed,
  true,
  'the unversioned legacy overload must be removed'
);
assert.equal(
  (await db.query(`
    select to_regprocedure(
      'public.set_clinic_subscription_state(uuid,uuid,text,boolean,bigint,text,uuid,text)'
    ) is not null present
  `)).rows[0].present,
  true,
  'the version-bound RPC must be the only supported overload'
);

const CLINIC_ID = '00000000-0000-4000-8000-00000000a001';
const ACTOR_ID = 'bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb';

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

async function setSubscription({
  requestId,
  enabled,
  expectedVersion,
  reason = 'Reviewed staging subscription transition'
}) {
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

const offRequestId = '22222222-2222-4222-a222-222222222222';
const off = await setSubscription({
  requestId: offRequestId,
  enabled: false,
  expectedVersion: 1
});
assert.equal(off.rows[0].result.state, 'suspended');
assert.equal(off.rows[0].result.version, 2);
assert.equal(off.rows[0].result.changed, true);
assert.equal(off.rows[0].result.idempotent, false);

const offRetry = await setSubscription({
  requestId: offRequestId,
  enabled: false,
  expectedVersion: 1
});
assert.equal(offRetry.rows[0].result.version, 2);
assert.equal(offRetry.rows[0].result.idempotent, true);
assert.equal(
  (await db.query(`
    select count(*)::int count
    from public.clinic_subscription_control_events
    where request_id='${offRequestId}'
  `)).rows[0].count,
  1,
  'an identical request retry must not append a duplicate event'
);

await assert.rejects(
  setSubscription({
    requestId: offRequestId,
    enabled: false,
    expectedVersion: 1,
    reason: 'Conflicting reuse of the same request identifier'
  }),
  /CNYOS_OWNER_REQUEST_ID_CONFLICT/
);
await db.exec('rollback;');

await assert.rejects(
  setSubscription({
    requestId: '33333333-3333-4333-a333-333333333333',
    enabled: true,
    expectedVersion: 1
  }),
  /CNYOS_OWNER_SUBSCRIPTION_VERSION_CONFLICT/
);
await db.exec('rollback;');
assert.deepEqual(
  (await db.query(`
    select subscription_state, subscription_version
    from public.clinics
    where id='${CLINIC_ID}'
  `)).rows,
  [{ subscription_state: 'suspended', subscription_version: 2 }],
  'a stale distinct request must not change state or version'
);

const on = await setSubscription({
  requestId: '44444444-4444-4444-a444-444444444444',
  enabled: true,
  expectedVersion: 2
});
assert.equal(on.rows[0].result.state, 'active');
assert.equal(on.rows[0].result.version, 3);

await assert.rejects(
  setSubscription({
    requestId: '66666666-6666-4666-a666-666666666666',
    enabled: true,
    expectedVersion: 2,
    reason: 'Reject stale confirmation even when state now matches'
  }),
  /CNYOS_OWNER_SUBSCRIPTION_VERSION_CONFLICT/
);
await db.exec('rollback;');

const noOp = await setSubscription({
  requestId: '55555555-5555-4555-a555-555555555555',
  enabled: true,
  expectedVersion: 3,
  reason: 'Confirm current staging subscription remains active'
});
assert.equal(noOp.rows[0].result.version, 3);
assert.equal(noOp.rows[0].result.changed, false);
assert.equal(noOp.rows[0].result.idempotent, false);
const noOpRetry = await setSubscription({
  requestId: '55555555-5555-4555-a555-555555555555',
  enabled: true,
  expectedVersion: 3,
  reason: 'Confirm current staging subscription remains active'
});
assert.equal(noOpRetry.rows[0].result.idempotent, true);
assert.equal(noOpRetry.rows[0].result.changedAt, noOp.rows[0].result.changedAt);
assert.deepEqual(
  (await db.query(`
    select expected_version, subscription_version, previous_state, new_state
    from public.clinic_subscription_control_events
    where clinic_id='${CLINIC_ID}'
    order by created_at, request_id
  `)).rows,
  [
    { expected_version: 1, subscription_version: 2, previous_state: 'active', new_state: 'suspended' },
    { expected_version: 2, subscription_version: 3, previous_state: 'suspended', new_state: 'active' },
    { expected_version: 3, subscription_version: 3, previous_state: 'active', new_state: 'active' }
  ]
);

const listed = await asService(`
  select clinic_code, enabled, subscription_version
  from public.list_owner_subscription_clinics()
  where clinic_id='${CLINIC_ID}'::uuid
`);
assert.deepEqual(listed.rows, [{
  clinic_code: 'JITARSA-STG',
  enabled: true,
  subscription_version: 3
}]);

await assert.rejects(
  db.exec(`
    update public.clinic_subscription_control_events
    set reason='Attempted evidence rewrite'
    where request_id='${offRequestId}'
  `),
  /APPEND_ONLY_RECORD_MUTATION_DENIED/
);
await db.exec('rollback;');
await assert.rejects(
  db.exec(`
    delete from public.clinic_subscription_control_events
    where request_id='${offRequestId}'
  `),
  /APPEND_ONLY_RECORD_MUTATION_DENIED/
);
await db.exec('rollback;');

for (const role of ['anon', 'authenticated']) {
  assert.equal(
    (await db.query(`
      select has_function_privilege(
        '${role}',
        'public.set_clinic_subscription_state(uuid,uuid,text,boolean,bigint,text,uuid,text)',
        'EXECUTE'
      ) allowed
    `)).rows[0].allowed,
    false,
    `${role} must not execute the Owner subscription RPC`
  );
}
assert.equal(
  (await db.query(`
    select has_function_privilege(
      'service_role',
      'public.set_clinic_subscription_state(uuid,uuid,text,boolean,bigint,text,uuid,text)',
      'EXECUTE'
    ) allowed
  `)).rows[0].allowed,
  true
);

await db.close();
console.log(
  'Owner subscription concurrency contract passed: version-bound ON/OFF, serialized idempotency, stale-write rejection and append-only evidence'
);
