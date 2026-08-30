import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import {
  buildMigrationLedgerRepairSql,
  loadMigrationEntries
} from '../scripts/generate-migration-ledger-repair-sql.mjs';
import { buildTenantBootstrapSql } from '../scripts/generate-tenant-bootstrap-sql.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.join(root, 'supabase', 'migrations');
const config = JSON.parse(await fs.readFile(path.join(root, 'config', 'tenant.staging.example.json'), 'utf8'));
const entries = loadMigrationEntries(root);

assert.equal(entries.length, 31);
assert.deepEqual(entries, [...entries].sort((a, b) => a.file.localeCompare(b.file)));
assert.equal(config.tenant.expectedClinicId, '00000000-0000-4000-8000-00000000a001');
assert.ok(entries.every(entry => /^[0-9a-f]{64}$/.test(entry.sha256)));

const recoverySql = buildMigrationLedgerRepairSql({
  config,
  entries,
  sourceRevision: 'a'.repeat(40)
});
const bootstrapSql = buildTenantBootstrapSql(config);
assert.match(bootstrapSql, /insert into public\.clinics/i);
assert.match(bootstrapSql, /on conflict \(id\) do update/i);
assert.match(bootstrapSql, /TENANT_BOOTSTRAP_CLINIC_CODE_CONFLICT/);
assert.match(bootstrapSql, /TENANT_BOOTSTRAP_CLINIC_ID_CONFLICT/);
assert.match(bootstrapSql, /where clinics\.code = excluded\.code/i);
assert.match(bootstrapSql, /CHANANYA_TENANT_BOOTSTRAP_READY/);
assert.doesNotMatch(bootstrapSql, /^update public\.clinics/im);
assert.match(recoverySql, /STAGING_LEDGER_RECOVERY_REQUIRES_EMPTY_TRANSACTIONAL_DATA/);
assert.match(recoverySql, /STAGING_SCHEMA_RELATIONS_MISSING/);
assert.match(recoverySql, /STAGING_SECURITY_DEFINERS_MISSING/);
assert.match(recoverySql, /supabase_migrations\.schema_migrations/);
assert.match(recoverySql, /statements text\[\]/);
assert.match(recoverySql, /name text/);
assert.match(recoverySql, /CHANANYA_STAGING_MIGRATION_LEDGER_READY/);
for (const entry of entries) {
  assert.match(recoverySql, new RegExp(entry.version));
  assert.match(recoverySql, new RegExp(entry.sha256));
}
assert.doesNotMatch(recoverySql, /qptxnrldzzinlcabudjv|sb_secret_|service_role\s*[:=]\s*['"][A-Za-z0-9_.-]{10,}/i);
assert.throws(
  () => buildMigrationLedgerRepairSql({
    config: { ...config, deploymentId: 'chananya-clinical-production' },
    entries
  }),
  /staging\/non-production/
);

const db = new PGlite();
await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (
    id uuid primary key,
    email text,
    raw_user_meta_data jsonb default '{}'::jsonb,
    raw_app_meta_data jsonb default '{}'::jsonb,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
  );
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create function auth.role() returns text language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'authenticated')::text
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
  create function public.gen_random_bytes(n integer) returns bytea language sql volatile as $$
    select decode(substr(repeat(md5(random()::text || clock_timestamp()::text), greatest(1,n)),1,n*2), 'hex')
  $$;
  create function public.digest(value text, algorithm text) returns bytea language sql immutable as $$
    select decode(md5(value) || md5(value || algorithm), 'hex')
  $$;
`);

for (const entry of entries) {
  const source = (await fs.readFile(path.join(migrationsDir, entry.file), 'utf8'))
    .replace(/create extension if not exists pgcrypto\s*;/gi, '');
  await db.exec(source);
}

const LEGACY_CLINIC_ID = '00000000-0000-0000-0000-000000000001';
const legacyClinicBefore = await db.query(`
  select id,code,name_th,name_en,active
  from public.clinics where id='${LEGACY_CLINIC_ID}'
`);
assert.equal(legacyClinicBefore.rows.length, 1);

await db.exec(`
  insert into public.clinics(id,code,name_th,name_en)
  values ('00000000-0000-4000-8000-00000000b002','${config.tenant.expectedClinicCode}','ชนกัน','Collision');
`);
await assert.rejects(db.exec(bootstrapSql), /TENANT_BOOTSTRAP_CLINIC_CODE_CONFLICT/);
await db.exec('rollback;');
assert.equal((await db.query(`select count(*)::int count from public.clinics where id='${config.tenant.expectedClinicId}'`)).rows[0].count, 0);
await db.exec(`delete from public.clinics where id='00000000-0000-4000-8000-00000000b002'`);

await db.exec(`
  insert into public.clinics(id,code,name_th,name_en)
  values ('${config.tenant.expectedClinicId}','OTHER-STG','ชนกัน','Collision');
`);
await assert.rejects(db.exec(bootstrapSql), /TENANT_BOOTSTRAP_CLINIC_ID_CONFLICT/);
await db.exec('rollback;');
assert.equal((await db.query(`select code from public.clinics where id='${config.tenant.expectedClinicId}'`)).rows[0].code, 'OTHER-STG');
await db.exec(`delete from public.clinics where id='${config.tenant.expectedClinicId}'`);

await db.exec(bootstrapSql);
await db.exec(bootstrapSql);
const stagingClinic = await db.query(`
  select id,code,active
  from public.clinics
  where id='${config.tenant.expectedClinicId}'
`);
assert.deepEqual(stagingClinic.rows, [{
  id: config.tenant.expectedClinicId,
  code: config.tenant.expectedClinicCode,
  active: true
}]);
assert.deepEqual(
  (await db.query(`select id,code,name_th,name_en,active from public.clinics where id='${LEGACY_CLINIC_ID}'`)).rows,
  legacyClinicBefore.rows,
  'additive bootstrap must not mutate or re-key the canonical migration seed'
);

const ADMIN_ID = '33333333-3333-4333-a333-333333333333';
await db.exec(`
  insert into auth.users(id,email,raw_user_meta_data)
  values ('${ADMIN_ID}','staging-admin@example.test','{"full_name":"Staging Admin"}');
  update public.profiles
  set role='viewer',system_role='super_admin'
  where id='${ADMIN_ID}';
  insert into public.clinic_memberships(clinic_id,profile_id,clinic_role,is_primary)
  values ('${config.tenant.expectedClinicId}','${ADMIN_ID}','owner',true);
`);

await db.exec(recoverySql);
const ledger = await db.query(`
  select version,name,statements
  from supabase_migrations.schema_migrations
  order by version
`);
assert.equal(ledger.rows.length, entries.length);
assert.deepEqual(ledger.rows.map(row => row.version), entries.map(entry => entry.version));
assert.deepEqual(ledger.rows.map(row => row.name), entries.map(entry => entry.name));
assert.ok(ledger.rows.every(row => Array.isArray(row.statements) && row.statements.length === 1));
assert.ok(ledger.rows.every((row, index) => row.statements[0].includes(entries[index].sha256)));

await db.close();
console.log(`Migration ledger contract passed: ${entries.length} exact migrations, staging guards, schema fingerprint and non-null SHA-256 evidence`);
