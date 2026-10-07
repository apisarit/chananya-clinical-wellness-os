import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const migration = fs.readFileSync(new URL('../supabase/migrations/20261003162550_treatment_session_idempotency.sql', import.meta.url), 'utf8');
const browser = fs.readFileSync(new URL('../opd-workflow.js', import.meta.url), 'utf8');
const compactMigration = migration.replace(/\s+/g, '').toLowerCase();
const legacySignature = 'public.create_clinical_treatment_session(uuid,text[],text,boolean,text,text,smallint,smallint,text,text)';
const keyedSignature = 'public.create_clinical_treatment_session(uuid,uuid,text[],text,boolean,text,text,smallint,smallint,text,text)';
const indexGuard = migration.match(
  /do \$treatment_session_idempotency_index\$[\s\S]*?\$treatment_session_idempotency_index\$;/i
)?.[0];

assert.match(migration, /add column if not exists client_request_id uuid/i);
assert.match(migration, /unique index[\s\S]*\(encounter_id, client_request_id\)[\s\S]*where client_request_id is not null/i);
assert.ok(indexGuard, 'migration must include the treatment-session index guard');
assert.doesNotMatch(indexGuard, /create unique index if not exists/i);
assert.match(indexGuard, /to_regclass\(\s*'public\.uq_treatment_session_client_request'\s*\)/i);
assert.match(indexGuard, /if v_index_oid is null then[\s\S]*create unique index uq_treatment_session_client_request/i);
for (const requiredCatalogCheck of [
  'indisunique',
  'indisvalid',
  'indisready',
  'indislive',
  'indimmediate',
  'indkey',
  'indnkeyatts',
  'indnatts',
  'indexprs',
  'indpred'
]) {
  assert.match(indexGuard, new RegExp(`index_definition\\.${requiredCatalogCheck}`, 'i'));
}
assert.match(indexGuard, /pg_get_expr\([\s\S]*?index_definition\.indpred,[\s\S]*?index_definition\.indrelid,[\s\S]*?false[\s\S]*?\)\s*=\s*'\(client_request_id IS NOT NULL\)'/i);
assert.match(indexGuard, /raise exception 'TREATMENT_SESSION_IDEMPOTENCY_INDEX_DRIFT'/i);
assert.match(migration, /create or replace function public\.create_clinical_treatment_session\(\s*p_encounter_id uuid,\s*p_client_request_id uuid,/i);
assert.match(migration, /security definer[\s\S]*set search_path = pg_catalog, public, pg_temp/i);
assert.match(migration, /if p_client_request_id is null then raise exception 'CLIENT_REQUEST_ID_REQUIRED'/i);
assert.match(migration, /where e\.id = p_encounter_id and e\.clinic_id = v_clinic\s*for update/i);
assert.match(migration, /s\.client_request_id = p_client_request_id/i);
assert.match(migration, /raise exception 'CLIENT_REQUEST_ID_REUSE'/i);
assert.match(migration, /client_request_id, session_no, treatment_modalities/i);
assert.match(migration, /'client_request_id',p_client_request_id/i);
assert.ok(compactMigration.includes(`revokeallonfunction${legacySignature}frompublic,anon,authenticated,service_role;`));
assert.ok(compactMigration.includes(`revokeallonfunction${keyedSignature}frompublic,anon,authenticated,service_role;`));
assert.ok(compactMigration.includes(`grantexecuteonfunction${keyedSignature}toauthenticated;`));
assert.ok(!compactMigration.includes(`grantexecuteonfunction${legacySignature}`));
assert.match(migration, /revoke insert, update, delete on public\.clinical_treatment_sessions\s*from authenticated/i);

assert.match(browser, /p_client_request_id: operationId/);
assert.match(browser, /SESSION_OPERATION_PREFIX/);
assert.match(browser, /sessionStorage\?\.setItem/);
assert.match(browser, /eq\('client_request_id', attempt\.operationId\)/);
assert.match(browser, /row\.client_request_id === attempt\.operationId/);
assert.doesNotMatch(browser, /localStorage/);

async function withIndexFixture(setupSql, check) {
  const db = new PGlite();
  try {
    await db.exec(`
      create table public.clinical_treatment_sessions (
        encounter_id uuid not null,
        client_request_id uuid
      );
    `);
    if (setupSql) await db.exec(setupSql);
    await check(db);
  } finally {
    await db.close();
  }
}

await withIndexFixture('', async db => {
  await db.exec(indexGuard);
  await db.exec(indexGuard);

  const result = await db.query(`
    select
      index_definition.indisunique,
      index_definition.indisvalid,
      index_definition.indisready,
      index_definition.indislive,
      pg_catalog.pg_get_expr(
        index_definition.indpred,
        index_definition.indrelid,
        false
      ) predicate
    from pg_catalog.pg_index index_definition
    where index_definition.indexrelid =
      pg_catalog.to_regclass('public.uq_treatment_session_client_request')
  `);
  assert.deepEqual(result.rows, [{
    indisunique: true,
    indisvalid: true,
    indisready: true,
    indislive: true,
    predicate: '(client_request_id IS NOT NULL)'
  }]);

  const encounterId = '11111111-1111-4111-a111-111111111111';
  const requestId = '22222222-2222-4222-a222-222222222222';
  await db.exec(`
    insert into public.clinical_treatment_sessions values
      ('${encounterId}', null),
      ('${encounterId}', null),
      ('${encounterId}', '${requestId}');
  `);
  await assert.rejects(
    db.exec(`
      insert into public.clinical_treatment_sessions values
        ('${encounterId}', '${requestId}');
    `),
    /duplicate key value violates unique constraint/i
  );
});

for (const drift of [
  {
    label: 'wrong predicate',
    sql: `
      create unique index uq_treatment_session_client_request
        on public.clinical_treatment_sessions(encounter_id, client_request_id)
        where client_request_id is null;
    `
  },
  {
    label: 'non-unique index',
    sql: `
      create index uq_treatment_session_client_request
        on public.clinical_treatment_sessions(encounter_id, client_request_id)
        where client_request_id is not null;
    `
  },
  {
    label: 'reversed key order',
    sql: `
      create unique index uq_treatment_session_client_request
        on public.clinical_treatment_sessions(client_request_id, encounter_id)
        where client_request_id is not null;
    `
  },
  {
    label: 'index on another table',
    sql: `
      create table public.other_treatment_sessions (
        encounter_id uuid not null,
        client_request_id uuid
      );
      create unique index uq_treatment_session_client_request
        on public.other_treatment_sessions(encounter_id, client_request_id)
        where client_request_id is not null;
    `
  }
]) {
  await withIndexFixture(drift.sql, async db => {
    await assert.rejects(
      db.exec(indexGuard),
      /TREATMENT_SESSION_IDEMPOTENCY_INDEX_DRIFT/,
      drift.label
    );
  });
}

await withIndexFixture(`
  create table public.uq_treatment_session_client_request(id integer);
`, async db => {
  await assert.rejects(
    db.exec(indexGuard),
    /TREATMENT_SESSION_IDEMPOTENCY_INDEX_DRIFT/
  );
});

console.log('Treatment-session idempotency contract passed: exact partial-unique index enforcement, durable operation UUID, exact replay, payload-reuse rejection, narrow ACL and browser recovery wiring');
