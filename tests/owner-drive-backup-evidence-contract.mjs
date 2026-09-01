import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationPath = path.join(
  root,
  'supabase',
  'migrations',
  '202609010600_owner_drive_backup_evidence.sql'
);
const migration = await fs.readFile(migrationPath, 'utf8');

assert.match(migration, /^begin;/i, 'the forward-only wrapper must be transactional');
assert.match(migration, /export_clinic_backup_domain_v20260831\(uuid,text\)/);
assert.match(migration, /verify_clinic_restore_trace_v20260831\(uuid\)/);
assert.match(migration, /if to_regprocedure\('public\.export_clinic_backup_domain_v20260831\(uuid,text\)'\) is null/);
assert.match(migration, /if to_regprocedure\('public\.verify_clinic_restore_trace_v20260831\(uuid\)'\) is null/);
assert.match(migration, /v_export := public\.export_clinic_backup_domain_v20260831\(p_clinic_id, p_domain\)/);
assert.match(migration, /v_trace := public\.verify_clinic_restore_trace_v20260831\(p_clinic_id\)/);
assert.match(migration, /'clinic_drive_destination_events'/);
assert.match(migration, /where e\.clinic_id = p_clinic_id/g);
assert.match(migration, /'\{schema_version\}', '"2026-09-01\.1"'::jsonb/g);
assert.match(migration, /select true, '2026-09-01\.1', 4, 31, 16, 7, 12, true/);
assert.doesNotMatch(migration, /jsonb_agg\(\s*to_jsonb\(e\)/i, 'event rows must use an explicit sanitized allowlist');

for (const functionName of [
  'export_clinic_backup_domain',
  'backup_restore_contract_healthcheck',
  'verify_clinic_restore_trace'
]) {
  const functionStart = migration.indexOf(`create or replace function public.${functionName}`);
  assert.notEqual(functionStart, -1, `${functionName} must exist`);
  const functionBody = migration.slice(functionStart, migration.indexOf('$$;', functionStart) + 3);
  assert.match(functionBody, /security definer/);
  assert.match(functionBody, /set search_path = pg_catalog, public/);
}

const exporterStart = migration.indexOf('create or replace function public.export_clinic_backup_domain');
const exporter = migration.slice(exporterStart, migration.indexOf('$$;', exporterStart) + 3);
assert.doesNotMatch(exporter, /e\.actor_email|e\.reason/);
assert.doesNotMatch(exporter, /->'updatedBy'|->'reason'/);
assert.match(migration, /revoke all on function public\.export_clinic_backup_domain\(uuid, text\)[\s\S]*from public, anon, authenticated/);
assert.match(migration, /grant execute on function public\.export_clinic_backup_domain\(uuid, text\)[\s\S]*to service_role/);
assert.match(migration, /revoke all on function public\.verify_clinic_restore_trace\(uuid\)[\s\S]*from public, anon, authenticated/);
assert.match(migration, /grant execute on function public\.verify_clinic_restore_trace\(uuid\)[\s\S]*to service_role/);
assert.match(migration, /commit;\s*select 'OWNER_DRIVE_BACKUP_EVIDENCE_READY' as status;/i);

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

  create function public.is_super_admin()
  returns boolean
  language sql
  stable
  security definer
  set search_path = pg_catalog
  as $$ select false $$;

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

  create function public.export_clinic_backup_domain(
    p_clinic_id uuid,
    p_domain text
  ) returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = pg_catalog, public
  as $$
  begin
    if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
    return jsonb_build_object(
      'format', 'chananya-domain-export/v1',
      'schema_version', '2026-08-31.1',
      'clinic_id', p_clinic_id,
      'domain', p_domain,
      'prior_marker', jsonb_build_object('preserved', true),
      'included_tables', jsonb_build_array('prior_events'),
      'data', jsonb_build_object(
        'prior_events', jsonb_build_array(jsonb_build_object('id', 'prior-1'))
      )
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
  set search_path = pg_catalog, public
  as $$ select true, '2026-08-31.1', 4, 31, 16, 7, 11, true $$;
  revoke all on function public.backup_restore_contract_healthcheck()
    from public, anon;
  grant execute on function public.backup_restore_contract_healthcheck()
    to authenticated, service_role;

  create function public.verify_clinic_restore_trace(p_clinic_id uuid)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = pg_catalog, public
  as $$
  begin
    if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
    return jsonb_build_object(
      'ready', true,
      'schema_version', '2026-08-31.1',
      'clinic_id', p_clinic_id,
      'prior_marker', 'preserved',
      'counts', jsonb_build_object('prior_events', 7)
    );
  end;
  $$;
  revoke all on function public.verify_clinic_restore_trace(uuid)
    from public, anon, authenticated;
  grant execute on function public.verify_clinic_restore_trace(uuid)
    to service_role;
`);

const CLINIC_A = '00000000-0000-4000-8000-00000000a001';
const CLINIC_B = '00000000-0000-4000-8000-00000000b002';
const EVENT_A = '11111111-1111-4111-a111-111111111111';
const EVENT_B = '22222222-2222-4222-a222-222222222222';
const REQUEST_A = '33333333-3333-4333-a333-333333333333';
const REQUEST_B = '44444444-4444-4444-a444-444444444444';
const ACTOR_A = '55555555-5555-4555-a555-555555555555';
const ACTOR_B = '66666666-6666-4666-a666-666666666666';

function assignment(environment, suffix, version) {
  return {
    environment,
    patientsFolderId: `patients-folder-${suffix}`,
    productsFolderId: `products-folder-${suffix}`,
    pharmacyFolderId: `pharmacy-folder-${suffix}`,
    transactionsFolderId: `transactions-folder-${suffix}`,
    manifestsFolderId: `manifests-folder-${suffix}`,
    version,
    updatedAt: `2026-09-01T0${version}:00:00.000Z`,
    updatedByUserId: ACTOR_A,
    updatedBy: 'owner-personal@example.test',
    reason: 'free text must not be exported'
  };
}

const previousA = assignment('staging', 'old-a', 1);
const newA = assignment('staging', 'new-a', 2);
const previousB = assignment('staging', 'old-b', 3);
const newB = assignment('staging', 'new-b', 4);

function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

await db.exec(`
  insert into public.clinic_drive_destination_events (
    id, request_id, clinic_id, clinic_code, environment,
    expected_version, assignment_version, previous_assignment, new_assignment,
    changed, reason, actor_user_id, actor_email, created_at
  ) values
  (
    '${EVENT_A}', '${REQUEST_A}', '${CLINIC_A}', 'JITARSA-STG', 'staging',
    1, 2, ${quote(JSON.stringify(previousA))}::jsonb, ${quote(JSON.stringify(newA))}::jsonb,
    true, 'Reason could contain sensitive free text', '${ACTOR_A}',
    'owner-personal@example.test', '2026-09-01T02:00:00.000Z'
  ),
  (
    '${EVENT_B}', '${REQUEST_B}', '${CLINIC_B}', 'OTHER-STG', 'staging',
    3, 4, ${quote(JSON.stringify(previousB))}::jsonb, ${quote(JSON.stringify(newB))}::jsonb,
    true, 'Other tenant reason', '${ACTOR_B}',
    'other-owner@example.test', '2026-09-01T03:00:00.000Z'
  );
`);

// Reapplying must replace only the outer wrapper, never rename that wrapper
// into a recursive archive or duplicate evidence.
await db.exec(migration);
await db.exec(migration);

async function asRole(role, sql) {
  await db.exec(`
    reset role;
    select set_config('request.jwt.claim.role', '${role}', false);
    set role ${role};
  `);
  try {
    return await db.query(sql);
  } finally {
    await db.exec('reset role;');
  }
}

await assert.rejects(
  asRole('authenticated', `select public.export_clinic_backup_domain('${CLINIC_A}', 'transactions')`),
  /permission denied/
);

const transactionResult = await asRole(
  'service_role',
  `select public.export_clinic_backup_domain('${CLINIC_A}', 'transactions') payload`
);
const transaction = transactionResult.rows[0].payload;
assert.equal(transaction.schema_version, '2026-09-01.1');
assert.deepEqual(transaction.prior_marker, { preserved: true });
assert.deepEqual(transaction.data.prior_events, [{ id: 'prior-1' }]);
assert.deepEqual(
  [...transaction.included_tables].sort(),
  Object.keys(transaction.data).sort(),
  'included_tables must exactly describe the extended encrypted payload'
);

const driveEvents = transaction.data.clinic_drive_destination_events;
assert.equal(driveEvents.length, 1, 'Drive assignment evidence must stay tenant scoped');
const driveEvent = driveEvents[0];
assert.deepEqual(Object.keys(driveEvent).sort(), [
  'actor_user_id',
  'assignment_version',
  'changed',
  'clinic_code',
  'clinic_id',
  'created_at',
  'environment',
  'expected_version',
  'id',
  'new_assignment',
  'previous_assignment',
  'request_id'
].sort());
assert.equal(driveEvent.id, EVENT_A);
assert.equal(driveEvent.clinic_id, CLINIC_A);
assert.equal(driveEvent.new_assignment.patientsFolderId, newA.patientsFolderId);
assert.equal(driveEvent.new_assignment.manifestsFolderId, newA.manifestsFolderId);
assert.equal(driveEvent.actor_email, undefined);
assert.equal(driveEvent.reason, undefined);
for (const assignmentEvidence of [driveEvent.previous_assignment, driveEvent.new_assignment]) {
  assert.equal(assignmentEvidence.updatedBy, undefined);
  assert.equal(assignmentEvidence.reason, undefined);
  assert.deepEqual(Object.keys(assignmentEvidence).sort(), [
    'environment',
    'manifestsFolderId',
    'patientsFolderId',
    'pharmacyFolderId',
    'productsFolderId',
    'transactionsFolderId',
    'updatedAt',
    'updatedByUserId',
    'version'
  ].sort());
}

const productResult = await asRole(
  'service_role',
  `select public.export_clinic_backup_domain('${CLINIC_A}', 'products') payload`
);
assert.equal(productResult.rows[0].payload.schema_version, '2026-09-01.1');
assert.deepEqual(productResult.rows[0].payload.data, {
  prior_events: [{ id: 'prior-1' }]
});
assert.deepEqual(productResult.rows[0].payload.prior_marker, { preserved: true });

const health = await asRole(
  'service_role',
  'select * from public.backup_restore_contract_healthcheck()'
);
assert.equal(health.rows[0].schema_version, '2026-09-01.1');
assert.equal(Number(health.rows[0].transaction_table_count), 12);

const restoreResult = await asRole(
  'service_role',
  `select public.verify_clinic_restore_trace('${CLINIC_A}') trace`
);
assert.equal(restoreResult.rows[0].trace.schema_version, '2026-09-01.1');
assert.equal(restoreResult.rows[0].trace.prior_marker, 'preserved');
assert.equal(Number(restoreResult.rows[0].trace.counts.prior_events), 7);
assert.equal(Number(restoreResult.rows[0].trace.counts.clinic_drive_destination_events), 1);

assert.equal(
  (await db.query("select to_regprocedure('public.export_clinic_backup_domain_v20260831(uuid,text)')::text archived")).rows[0].archived,
  'export_clinic_backup_domain_v20260831(uuid,text)'
);
assert.equal(
  (await db.query("select to_regprocedure('public.verify_clinic_restore_trace_v20260831(uuid)')::text archived")).rows[0].archived,
  'verify_clinic_restore_trace_v20260831(uuid)'
);

console.log(
  'Owner Drive backup evidence contract passed: replay-safe wrapper, tenant-scoped sanitized events, preserved prior payload, v2026-09-01.1 health and restore trace'
);
