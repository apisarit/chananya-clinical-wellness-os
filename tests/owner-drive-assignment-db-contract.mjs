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
  '202609010500_owner_drive_assignment.sql'
);
const migration = await fs.readFile(migrationPath, 'utf8');

// Static security contract: the only data path is a service-role SECURITY
// DEFINER RPC with a pinned search path. The two backing tables remain closed.
assert.match(migration, /create table if not exists public\.clinic_drive_backup_destinations/);
assert.match(migration, /primary key \(clinic_id, environment\)/);
assert.match(migration, /environment in \('staging', 'production'\)/);
assert.match(migration, /patients_folder_id[\s\S]*products_folder_id[\s\S]*pharmacy_folder_id[\s\S]*transactions_folder_id[\s\S]*manifests_folder_id/);
assert.match(migration, /request_id uuid not null unique/);
assert.match(migration, /previous_assignment jsonb not null/);
assert.match(migration, /new_assignment jsonb not null/);
assert.match(migration, /clinic_drive_destination_events_append_only/);
assert.match(migration, /execute function public\.reject_append_only_mutation\(\)/);
assert.match(migration, /alter table public\.clinic_drive_backup_destinations enable row level security/);
assert.match(migration, /alter table public\.clinic_drive_destination_events enable row level security/);
assert.match(migration, /revoke all on public\.clinic_drive_backup_destinations[\s\S]*from public, anon, authenticated, service_role/);
assert.match(migration, /revoke all on public\.clinic_drive_destination_events[\s\S]*from public, anon, authenticated, service_role/);

for (const functionName of [
  'list_owner_drive_assignments',
  'get_clinic_drive_backup_destination',
  'set_clinic_drive_assignment'
]) {
  const functionStart = migration.indexOf(`create or replace function public.${functionName}`);
  assert.notEqual(functionStart, -1, `${functionName} must exist`);
  const functionBody = migration.slice(functionStart, migration.indexOf('$$;', functionStart) + 3);
  assert.match(functionBody, /security definer/);
  assert.match(functionBody, /set search_path = pg_catalog, public/);
  assert.match(functionBody, /auth\.role\(\) <> 'service_role'/);
}

assert.match(migration, /grant execute on function public\.list_owner_drive_assignments\(\)[\s\S]*to service_role/);
assert.match(migration, /grant execute on function public\.get_clinic_drive_backup_destination\(uuid, text\)[\s\S]*to service_role/);
assert.match(migration, /grant execute on function public\.set_clinic_drive_assignment\([\s\S]*to service_role/);
assert.doesNotMatch(migration, /grant execute on function public\.(?:list_owner_drive_assignments|get_clinic_drive_backup_destination|set_clinic_drive_assignment)[^;]*to (?:anon|authenticated)/i);
assert.match(migration, /pg_catalog\.pg_advisory_xact_lock\([\s\S]*pg_catalog\.hashtextextended\(p_request_id::text, 0\)/);
assert.match(migration, /for v_lock_attempt in 1\.\.2 loop[\s\S]*for update/);
assert.match(migration, /CNYOS_DRIVE_VERSION_CONFLICT/);
assert.match(migration, /CNYOS_DRIVE_REQUEST_ID_CONFLICT/);
assert.match(migration, /CNYOS_DRIVE_FOLDER_IDS_NOT_DISTINCT/);
assert.match(migration, /cnyos:drive-folder-assignment-registry/);
assert.match(migration, /CNYOS_DRIVE_FOLDER_ALREADY_ASSIGNED/);
assert.ok(migration.includes("patients_folder_id ~ '^[A-Za-z0-9_-]+$'"));
assert.match(migration, /commit;\s*select 'OWNER_DRIVE_ASSIGNMENT_READY' as status;/i);

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

  create table public.clinics (
    id uuid primary key,
    code text not null unique,
    name_th text not null,
    name_en text,
    active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );

  create table public.backup_export_runs (
    id uuid primary key default public.gen_random_uuid(),
    clinic_id uuid not null references public.clinics(id),
    status text not null,
    started_at timestamptz not null default now()
  );

  create function public.reject_append_only_mutation()
  returns trigger
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog
  as $$
  begin
    raise exception 'APPEND_ONLY_RECORD_MUTATION_DENIED'
      using errcode = '55000',
        detail = tg_table_schema || '.' || tg_table_name;
  end;
  $$;
  revoke all on function public.reject_append_only_mutation()
    from public, anon, authenticated, service_role;
`);

await db.exec(migration);

const CLINIC_ID = '00000000-0000-4000-8000-00000000a001';
const INACTIVE_CLINIC_ID = '00000000-0000-4000-8000-00000000b002';
const ACTOR_ID = '11111111-1111-4111-a111-111111111111';
const REQUEST_A = '22222222-2222-4222-a222-222222222222';
const REQUEST_B = '33333333-3333-4333-a333-333333333333';
const REQUEST_C = '44444444-4444-4444-a444-444444444444';
const REQUEST_D = '55555555-5555-4555-a555-555555555555';
const REQUEST_E = '66666666-6666-4666-a666-666666666666';
const REQUEST_F = '77777777-7777-4777-a777-777777777777';
const REQUEST_G = '88888888-8888-4888-a888-888888888888';
const REQUEST_H = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const REQUEST_FIRST_VERSION_CONFLICT = 'bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb';
const REQUEST_ACTIVE_BACKUP_CONFLICT = 'cccccccc-cccc-4ccc-accc-cccccccccccc';
const OTHER_ACTIVE_CLINIC_ID = '99999999-9999-4999-a999-999999999999';
const NON_V4_REQUEST = '88888888-8888-1888-a888-888888888888';
const initialFolders = {
  patients: 'patients-folder-001',
  products: 'products-folder-001',
  pharmacy: 'pharmacy-folder-001',
  transactions: 'transactions-folder-001',
  manifests: 'manifests-folder-001'
};

await db.exec(`
  insert into public.clinics(id, code, name_th, name_en, active) values
    ('${CLINIC_ID}', 'JITARSA-STG', 'คลินิกจิตอาสา', 'Jitarsa Clinic', true),
    ('${INACTIVE_CLINIC_ID}', 'OLD-STG', 'คลินิกปิด', 'Inactive Clinic', false);
`);

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

async function expectDatabaseError(promise, code) {
  await assert.rejects(promise, error => String(error.message).includes(code));
}

function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function assignmentSql({
  requestId,
  clinicId = CLINIC_ID,
  clinicCode = 'JITARSA-STG',
  environment = 'staging',
  folders = initialFolders,
  expectedVersion = 0,
  reason = 'Assign isolated staging backup folders',
  actorId = ACTOR_ID,
  actorEmail = 'owner@example.test'
}) {
  return `
    select public.set_clinic_drive_assignment(
      ${quote(requestId)}::uuid,
      ${quote(clinicId)}::uuid,
      ${quote(clinicCode)},
      ${quote(environment)},
      ${quote(folders.patients)},
      ${quote(folders.products)},
      ${quote(folders.pharmacy)},
      ${quote(folders.transactions)},
      ${quote(folders.manifests)},
      ${expectedVersion}::bigint,
      ${quote(reason)},
      ${quote(actorId)}::uuid,
      ${quote(actorEmail)}
    ) result
  `;
}

// RLS and ACLs must deny every direct client path, including service_role.
for (const table of [
  'clinic_drive_backup_destinations',
  'clinic_drive_destination_events'
]) {
  assert.equal(
    (await db.query(`select relrowsecurity from pg_class where oid='public.${table}'::regclass`)).rows[0].relrowsecurity,
    true
  );
  for (const role of ['anon', 'authenticated', 'service_role']) {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      assert.equal(
        (await db.query(`select has_table_privilege('${role}','public.${table}','${privilege}') allowed`)).rows[0].allowed,
        false,
        `${role} must not receive ${privilege} on ${table}`
      );
    }
  }
}

assert.equal(
  (await db.query("select has_function_privilege('service_role','public.list_owner_drive_assignments()','EXECUTE') allowed")).rows[0].allowed,
  true
);
assert.equal(
  (await db.query("select has_function_privilege('authenticated','public.list_owner_drive_assignments()','EXECUTE') allowed")).rows[0].allowed,
  false
);

await expectDatabaseError(
  asRole('authenticated', assignmentSql({ requestId: REQUEST_A })),
  'permission denied'
);
await expectDatabaseError(
  asRole('authenticated', 'select * from public.list_owner_drive_assignments()'),
  'permission denied'
);

const beforeAssignment = await asRole(
  'service_role',
  'select * from public.list_owner_drive_assignments()'
);
assert.equal(beforeAssignment.rows.length, 2, 'only the active clinic should produce staging and production rows');
assert.deepEqual(beforeAssignment.rows.map(row => row.environment).sort(), ['production', 'staging']);
assert.ok(beforeAssignment.rows.every(row => row.assigned === false && Number(row.version) === 0));

await expectDatabaseError(
  asRole('service_role', assignmentSql({
    requestId: REQUEST_FIRST_VERSION_CONFLICT,
    expectedVersion: 1
  })),
  'CNYOS_DRIVE_VERSION_CONFLICT'
);

const created = await asRole(
  'service_role',
  assignmentSql({ requestId: REQUEST_A })
);
assert.equal(created.rows[0].result.clinicId, CLINIC_ID);
assert.equal(created.rows[0].result.clinicCode, 'JITARSA-STG');
assert.equal(created.rows[0].result.environment, 'staging');
assert.equal(created.rows[0].result.version, 1);
assert.equal(created.rows[0].result.changed, true);
assert.equal(created.rows[0].result.idempotent, false);

await db.exec(`
  insert into public.backup_export_runs(clinic_id, status, started_at)
  values ('${CLINIC_ID}', 'started', now());
`);
await expectDatabaseError(
  asRole('service_role', assignmentSql({
    requestId: REQUEST_ACTIVE_BACKUP_CONFLICT,
    expectedVersion: 1,
    folders: { ...initialFolders, manifests: 'manifests-folder-active-run' },
    reason: 'Reject reassignment during an active export run'
  })),
  'CNYOS_DRIVE_BACKUP_RUN_ACTIVE'
);
await db.exec(`update public.backup_export_runs set status='failed' where clinic_id='${CLINIC_ID}'`);

const replay = await asRole(
  'service_role',
  assignmentSql({ requestId: REQUEST_A })
);
assert.equal(replay.rows[0].result.version, 1);
assert.equal(replay.rows[0].result.changed, true);
assert.equal(replay.rows[0].result.idempotent, true);
assert.equal(
  (await db.query(`select count(*)::int count from public.clinic_drive_destination_events where request_id='${REQUEST_A}'`)).rows[0].count,
  1,
  'an identical request UUID retry must not append another event'
);

await expectDatabaseError(
  asRole('service_role', assignmentSql({
    requestId: REQUEST_A,
    reason: 'Conflicting payload with reused request id'
  })),
  'CNYOS_DRIVE_REQUEST_ID_CONFLICT'
);

await expectDatabaseError(
  asRole('service_role', assignmentSql({
    requestId: REQUEST_B,
    expectedVersion: 0,
    folders: { ...initialFolders, manifests: 'manifests-folder-002' }
  })),
  'CNYOS_DRIVE_VERSION_CONFLICT'
);

const changedFolders = {
  ...initialFolders,
  manifests: 'manifests-folder-002'
};
const changed = await asRole(
  'service_role',
  assignmentSql({
    requestId: REQUEST_C,
    expectedVersion: 1,
    folders: changedFolders,
    reason: 'Rotate the isolated manifest destination'
  })
);
assert.equal(changed.rows[0].result.version, 2);
assert.equal(changed.rows[0].result.changed, true);

await db.exec(`
  insert into public.clinics(id, code, name_th, name_en, active)
  values ('${OTHER_ACTIVE_CLINIC_ID}', 'OTHER-ACTIVE-STG', 'คลินิกทดสอบแยก', 'Other active clinic', true);
`);
await expectDatabaseError(
  asRole('service_role', assignmentSql({
    requestId: REQUEST_F,
    clinicId: OTHER_ACTIVE_CLINIC_ID,
    clinicCode: 'OTHER-ACTIVE-STG',
    expectedVersion: 0,
    folders: changedFolders,
    reason: 'Reject cross-clinic Drive folder reuse'
  })),
  'CNYOS_DRIVE_FOLDER_ALREADY_ASSIGNED'
);
await expectDatabaseError(
  asRole('service_role', assignmentSql({
    requestId: REQUEST_G,
    environment: 'production',
    expectedVersion: 0,
    folders: changedFolders,
    reason: 'Reject cross-environment Drive folder reuse'
  })),
  'CNYOS_DRIVE_FOLDER_ALREADY_ASSIGNED'
);

const event = (await db.query(`
  select expected_version, assignment_version, previous_assignment, new_assignment
  from public.clinic_drive_destination_events
  where request_id='${REQUEST_C}'
`)).rows[0];
assert.equal(Number(event.expected_version), 1);
assert.equal(Number(event.assignment_version), 2);
assert.equal(event.previous_assignment.manifestsFolderId, initialFolders.manifests);
assert.equal(event.previous_assignment.version, 1);
assert.equal(event.new_assignment.manifestsFolderId, changedFolders.manifests);
assert.equal(event.new_assignment.version, 2);

const unchanged = await asRole(
  'service_role',
  assignmentSql({
    requestId: REQUEST_H,
    expectedVersion: 2,
    folders: changedFolders,
    reason: 'Reconfirm the current isolated destinations'
  })
);
assert.equal(unchanged.rows[0].result.version, 2);
assert.equal(unchanged.rows[0].result.changed, false);
assert.equal(unchanged.rows[0].result.idempotent, false);
assert.equal(
  (await db.query(`select assignment_version from public.clinic_drive_destination_events where request_id='${REQUEST_H}'`)).rows[0].assignment_version,
  2,
  'a separately audited no-op must not increment the optimistic version'
);

const destination = await asRole(
  'service_role',
  `select * from public.get_clinic_drive_backup_destination('${CLINIC_ID}'::uuid, ' STAGING ')`
);
assert.equal(destination.rows.length, 1);
assert.equal(destination.rows[0].clinic_code, 'JITARSA-STG');
assert.equal(destination.rows[0].manifests_folder_id, changedFolders.manifests);
assert.equal(Number(destination.rows[0].version), 2);

await expectDatabaseError(
  asRole('service_role', assignmentSql({
    requestId: REQUEST_D,
    expectedVersion: 2,
    environment: 'preview'
  })),
  'CNYOS_DRIVE_ENVIRONMENT_INVALID'
);
await expectDatabaseError(
  asRole('service_role', assignmentSql({
    requestId: REQUEST_D,
    expectedVersion: 2,
    clinicCode: 'WRONG-STG'
  })),
  'CNYOS_OWNER_CLINIC_CONFIRMATION_MISMATCH'
);
await expectDatabaseError(
  asRole('service_role', assignmentSql({
    requestId: REQUEST_D,
    expectedVersion: 2,
    folders: { ...changedFolders, products: changedFolders.patients }
  })),
  'CNYOS_DRIVE_FOLDER_IDS_NOT_DISTINCT'
);
await expectDatabaseError(
  asRole('service_role', assignmentSql({
    requestId: REQUEST_D,
    expectedVersion: 0,
    clinicId: INACTIVE_CLINIC_ID,
    clinicCode: 'OLD-STG'
  })),
  'CNYOS_DRIVE_CLINIC_INACTIVE'
);
await expectDatabaseError(
  asRole('service_role', assignmentSql({
    requestId: REQUEST_E,
    expectedVersion: 2,
    folders: { ...changedFolders, patients: ' ' }
  })),
  'CNYOS_DRIVE_FOLDER_ID_INVALID'
);
await expectDatabaseError(
  asRole('service_role', assignmentSql({
    requestId: NON_V4_REQUEST,
    expectedVersion: 2,
    folders: changedFolders
  })),
  'CNYOS_DRIVE_REQUEST_ID_INVALID'
);

await expectDatabaseError(
  db.exec(`update public.clinic_drive_destination_events set reason='Tampered evidence' where request_id='${REQUEST_A}'`),
  'APPEND_ONLY_RECORD_MUTATION_DENIED'
);
await db.exec('rollback;');
await expectDatabaseError(
  db.exec(`delete from public.clinic_drive_destination_events where request_id='${REQUEST_A}'`),
  'APPEND_ONLY_RECORD_MUTATION_DENIED'
);
await db.exec('rollback;');

assert.equal(
  (await db.query('select count(*)::int count from public.clinic_drive_destination_events')).rows[0].count,
  3,
  'the initial assignment, versioned change and separately requested no-op should be recorded'
);

console.log('Owner Drive DB contracts passed: isolated environment mapping, optimistic versions, idempotent immutable audit and service-role-only RPCs');
