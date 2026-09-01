import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import {
  encryptBackup,
  parseServiceAccount
} from '../netlify/functions/_shared/database-backup.mjs';
import {
  assertRestoreSourceApiToken,
  assertRestoreSourceRuntime,
  normalizeExactRestoreSource,
  normalizeRestoreSourceRequest,
  RESTORE_DATA_DOMAINS,
  RESTORE_OBJECT_DOMAINS
} from '../netlify/functions/_shared/restore-source.mjs';
import { configuration as restoreSourceConfiguration } from '../netlify/functions/restore-source.mts';
import {
  assertRestoreSourceEndpoint,
  downloadInspectedDriveObject,
  fetchExactRestoreSource,
  fetchGoogleRestoreReaderAccessToken,
  inspectRestoreFolder,
  inspectRestoreObject,
  validateBackupManifest,
  validateEncryptedObjectEnvelope
} from '../scripts/_shared/drive-restore-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFile(path.join(root, file), 'utf8');
const migration = await read('supabase/migrations/202609010900_backup_restore_source_binding.sql');
const terminalRunGuardMigration = await read('supabase/migrations/202609011200_backup_terminal_run_guard.sql');

// Database security and lease ordering contracts.
assert.match(migration, /create or replace function public\.begin_backup_export_run/);
const beginBody = migration.slice(
  migration.indexOf('create or replace function public.begin_backup_export_run'),
  migration.indexOf('$$;', migration.indexOf('create or replace function public.begin_backup_export_run'))
);
assert.ok(
  beginBody.indexOf('from public.clinics c') < beginBody.indexOf('from public.backup_export_runs r'),
  'the clinic row must be locked before the backup slot is acquired'
);
assert.match(beginBody, /from public\.clinics c[\s\S]*for update/);
assert.match(migration, /create or replace function public\.get_exact_backup_restore_source\(\s*p_clinic_code text,\s*p_scheduled_for timestamptz,\s*p_environment text/);
assert.match(migration, /r\.status = 'completed'/);
assert.match(migration, /r\.destination = 'google_drive'/);
assert.match(migration, /jsonb_array_length\(v_run\.object_manifest\) <> 5/);
assert.match(migration, /v_file_id is null[\s\S]*v_folder_id is null/);
assert.match(migration, /jsonb_typeof\(v_object->'drive_assignment_version'\) is distinct from 'number'/);
assert.match(migration, /jsonb_typeof\(v_object->'plaintext_bytes'\) is distinct from 'number'/);
assert.match(migration, /revoke all on function public\.get_exact_backup_restore_source\(text, timestamptz, text\)[\s\S]*from public, anon, authenticated/);
assert.match(migration, /grant execute on function public\.get_exact_backup_restore_source\(text, timestamptz, text\)[\s\S]*to service_role/);
assert.match(terminalRunGuardMigration, /create or replace function public\.begin_backup_export_run\(\s*p_clinic_id uuid,\s*p_scheduled_for timestamptz,\s*p_request_id text/);
assert.match(terminalRunGuardMigration, /security definer\s*set search_path = pg_catalog, public/);
assert.match(terminalRunGuardMigration, /auth\.role\(\) <> 'service_role'/);
assert.match(terminalRunGuardMigration, /v_run\.status in \('completed', 'partial', 'failed'\)/);
assert.match(terminalRunGuardMigration, /v_run\.request_id is not distinct from v_request_id/);
assert.match(terminalRunGuardMigration, /revoke all on function public\.begin_backup_export_run\(uuid, timestamptz, text\)\s*from public, anon, authenticated/);
assert.match(terminalRunGuardMigration, /grant execute on function public\.begin_backup_export_run\(uuid, timestamptz, text\)\s*to service_role/);

const db = new PGlite();
await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create function auth.role() returns text language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'authenticated')::text
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
    clinic_id uuid not null references public.clinics(id) on delete restrict,
    destination text not null default 'google_drive',
    scheduled_for timestamptz,
    status text not null check (status in ('started','completed','partial','failed')),
    domain_counts jsonb not null default '{}'::jsonb,
    object_manifest jsonb not null default '[]'::jsonb,
    request_id text,
    error_code text,
    started_at timestamptz not null default now(),
    completed_at timestamptz,
    created_at timestamptz not null default now()
  );
  create unique index backup_export_runs_clinic_slot_uidx
    on public.backup_export_runs(clinic_id, scheduled_for)
    where scheduled_for is not null;
`);
await db.exec(migration);
await db.exec(terminalRunGuardMigration);

const CLINIC_ID = '7f760bc7-8a6f-4bfe-8bf3-5c349a15c070';
const RUN_ID = '11111111-1111-4111-a111-111111111111';
const SLOT = '2026-09-01T20:00:00.000Z';
const ENVIRONMENT = 'staging';
const CLINIC_CODE = 'JITARSA-STG';
const ROOT_FOLDER = 'root-folder-restore-001';
const folders = Object.freeze({
  patients: 'patients-folder-restore-001',
  products: 'products-folder-restore-001',
  pharmacy: 'pharmacy-folder-restore-001',
  transactions: 'transactions-folder-restore-001',
  manifests: 'manifests-folder-restore-001'
});
const fileName = domain => `STAGING_${CLINIC_CODE}_${domain}_20260901T200000Z.${domain === 'manifest' ? 'manifest.json' : 'cdb.json.enc'}`;
const fileId = domain => `${domain}-drive-file-restore-001`;
const rowCounts = Object.freeze({
  patients: { patients: 1 },
  products: { products: 2 },
  pharmacy: { prescriptions: 3 },
  transactions: { payments: 4 }
});
const objectManifest = [
  ...RESTORE_DATA_DOMAINS.map((domain, index) => ({
    domain,
    environment: ENVIRONMENT,
    destination_folder_id: folders[domain],
    drive_root_folder_id: ROOT_FOLDER,
    drive_assignment_version: 7,
    file_id: fileId(domain),
    file_name: fileName(domain),
    plaintext_bytes: 100 + index,
    encrypted_bytes: 500 + index,
    plaintext_sha256: String(index + 1).repeat(64),
    ciphertext_sha256: String(index + 5).repeat(64),
    key_id: String(index + 1).repeat(16)
  })),
  {
    domain: 'manifest',
    environment: ENVIRONMENT,
    destination_folder_id: folders.manifests,
    drive_root_folder_id: ROOT_FOLDER,
    drive_assignment_version: 7,
    file_id: fileId('manifest'),
    file_name: fileName('manifest')
  }
];

await db.query(
  `insert into public.clinics(id, code, name_th, name_en) values ($1,$2,$3,$4)`,
  [CLINIC_ID, CLINIC_CODE, 'คลินิกจิตอาสา', 'Jitarsa Clinic']
);
await db.query(`
  insert into public.backup_export_runs(
    id, clinic_id, destination, scheduled_for, status, domain_counts,
    object_manifest, started_at, completed_at
  ) values ($1,$2,'google_drive',$3,'completed',$4,$5,$6,$7)
`, [
  RUN_ID,
  CLINIC_ID,
  SLOT,
  JSON.stringify(rowCounts),
  JSON.stringify(objectManifest),
  '2026-09-01T20:00:01.000Z',
  '2026-09-01T20:00:10.000Z'
]);

async function asRole(role, sql) {
  await db.exec(`
    reset role;
    select set_config('request.jwt.claim.role', '${role}', false);
    set role ${role};
  `);
  try { return await db.query(sql); }
  finally { await db.exec('reset role;'); }
}

const sourceSql = `select public.get_exact_backup_restore_source('${CLINIC_CODE}','${SLOT}','${ENVIRONMENT}') source`;
await assert.rejects(asRole('authenticated', sourceSql), /permission denied|RESTORE_SOURCE_SERVICE_ROLE_REQUIRED/i);
const exact = (await asRole('service_role', sourceSql)).rows[0].source;
assert.equal(exact.run_id, RUN_ID);
assert.equal(exact.objects.manifest.file_id, fileId('manifest'));
assert.deepEqual(exact.objects.patients.row_counts, rowCounts.patients);
assert.equal(exact.drive_assignment.version, 7);
assert.equal(exact.drive_assignment.root_folder_id, ROOT_FOLDER);

async function mutateAndReject(expression, expectedCode) {
  await db.query('update public.backup_export_runs set object_manifest=$1 where id=$2', [
    JSON.stringify(expression), RUN_ID
  ]);
  await assert.rejects(asRole('service_role', sourceSql), new RegExp(expectedCode));
  await db.query('update public.backup_export_runs set object_manifest=$1 where id=$2', [
    JSON.stringify(objectManifest), RUN_ID
  ]);
}

const missingFileId = structuredClone(objectManifest);
delete missingFileId[0].file_id;
await mutateAndReject(missingFileId, 'RESTORE_SOURCE_DRIVE_ID_INVALID');
const missingHash = structuredClone(objectManifest);
delete missingHash[0].plaintext_sha256;
await mutateAndReject(missingHash, 'RESTORE_SOURCE_DOMAIN_EVIDENCE_INVALID');
const duplicateFile = structuredClone(objectManifest);
duplicateFile[1].file_id = duplicateFile[0].file_id;
await mutateAndReject(duplicateFile, 'RESTORE_SOURCE_DRIVE_IDS_NOT_UNIQUE');
const wrongEnvironment = structuredClone(objectManifest);
wrongEnvironment[2].environment = 'production';
await mutateAndReject(wrongEnvironment, 'RESTORE_SOURCE_OBJECT_ENVIRONMENT_MISMATCH');
await db.exec(`update public.backup_export_runs set destination='s3' where id='${RUN_ID}'`);
await assert.rejects(asRole('service_role', sourceSql), /RESTORE_SOURCE_COMPLETED_RUN_NOT_FOUND/);
await db.exec(`update public.backup_export_runs set destination='google_drive' where id='${RUN_ID}'`);

const lease = await asRole('service_role', `
  select * from public.begin_backup_export_run(
    '${CLINIC_ID}', '2026-09-02T20:00:00.000Z', '22222222-2222-4222-8222-222222222222'
  )
`);
assert.equal(lease.rows[0].acquired, true);
await assert.rejects(asRole('authenticated', `
  select * from public.begin_backup_export_run(
    '${CLINIC_ID}', '2026-09-02T20:00:00.000Z', '33333333-3333-4333-8333-333333333333'
  )
`), /permission denied|SERVICE_ROLE_REQUIRED/i);
for (const invalidRequestId of [
  'null',
  "''",
  "'not-a-uuid'",
  "' 33333333-3333-4333-8333-333333333333 '",
  "'33333333-3333-1333-8333-333333333333'"
]) {
  await assert.rejects(asRole('service_role', `
    select * from public.begin_backup_export_run(
      '${CLINIC_ID}', '2026-09-03T20:00:00.000Z', ${invalidRequestId}
    )
  `), /BACKUP_REQUEST_ID_INVALID/);
}

const GUARDED_SLOT = '2026-09-04T20:00:00.000Z';
const REQUEST_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REQUEST_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REQUEST_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const REQUEST_D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const REQUEST_E = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const firstGuardedLease = await asRole('service_role', `
  select * from public.begin_backup_export_run('${CLINIC_ID}','${GUARDED_SLOT}','${REQUEST_A}')
`);
assert.equal(firstGuardedLease.rows[0].acquired, true);
const guardedRunEvidence = () => db.query(`
  select status, request_id, started_at::text, completed_at::text,
         domain_counts::text, object_manifest::text, error_code
  from public.backup_export_runs
  where clinic_id=$1 and scheduled_for=$2
`, [CLINIC_ID, GUARDED_SLOT]);
const freshEvidence = (await guardedRunEvidence()).rows[0];
const freshDifferentRequest = await asRole('service_role', `
  select * from public.begin_backup_export_run('${CLINIC_ID}','${GUARDED_SLOT}','${REQUEST_B}')
`);
assert.equal(freshDifferentRequest.rows[0].acquired, false, 'a fresh started lease must reject a different request ID');
assert.deepEqual((await guardedRunEvidence()).rows[0], freshEvidence, 'a rejected fresh lease must not mutate evidence');
await db.query(`
  update public.backup_export_runs
  set started_at=pg_catalog.now() - interval '31 minutes'
  where clinic_id=$1 and scheduled_for=$2
`, [CLINIC_ID, GUARDED_SLOT]);
const staleEvidence = (await guardedRunEvidence()).rows[0];
const staleExactReplay = await asRole('service_role', `
  select * from public.begin_backup_export_run('${CLINIC_ID}','${GUARDED_SLOT}','${REQUEST_A}')
`);
assert.equal(staleExactReplay.rows[0].acquired, false, 'an exact signed dispatch replay must not refresh a stale lease');
assert.deepEqual((await guardedRunEvidence()).rows[0], staleEvidence, 'an exact stale replay must not reset its timestamp or evidence');
const staleDifferentRequest = await asRole('service_role', `
  select * from public.begin_backup_export_run('${CLINIC_ID}','${GUARDED_SLOT}','${REQUEST_B}')
`);
assert.equal(staleDifferentRequest.rows[0].acquired, true, 'one fresh dispatch ID may recover a stale started lease');
const recoveredEvidence = (await guardedRunEvidence()).rows[0];
assert.equal(recoveredEvidence.request_id, REQUEST_B);
assert.notEqual(recoveredEvidence.started_at, staleEvidence.started_at, 'a distinct stale recovery must obtain a new lease timestamp');
const repeatedRecoveredRequest = await asRole('service_role', `
  select * from public.begin_backup_export_run('${CLINIC_ID}','${GUARDED_SLOT}','${REQUEST_B}')
`);
assert.equal(repeatedRecoveredRequest.rows[0].acquired, false, 'the distinct stale recovery request may acquire only once');
assert.deepEqual((await guardedRunEvidence()).rows[0], recoveredEvidence, 'the accepted request replay must not mutate the new lease');
for (const [status, requestId] of [
  ['partial', REQUEST_C],
  ['failed', REQUEST_D],
  ['completed', REQUEST_E]
]) {
  await db.query(`
    update public.backup_export_runs
    set status=$1,
        started_at=pg_catalog.now() - interval '31 minutes',
        completed_at=case when $1='completed' then pg_catalog.now() else null end
    where clinic_id=$2 and scheduled_for=$3
  `, [status, CLINIC_ID, GUARDED_SLOT]);
  const terminalEvidence = (await guardedRunEvidence()).rows[0];
  const terminalRetry = await asRole('service_role', `
    select * from public.begin_backup_export_run('${CLINIC_ID}','${GUARDED_SLOT}','${requestId}')
  `);
  assert.equal(
    terminalRetry.rows[0].acquired,
    false,
    `${status} evidence must never be reacquired with a new request ID`
  );
  assert.deepEqual(
    (await guardedRunEvidence()).rows[0],
    terminalEvidence,
    `${status} evidence must remain byte-for-byte unchanged after a rejected retry`
  );
}

// Pure API/result normalization and site-bound configuration.
assert.deepEqual(normalizeRestoreSourceRequest({ clinicCode: 'jitarsa-stg', slot: SLOT }), {
  clinicCode: CLINIC_CODE,
  slot: SLOT
});
assert.throws(() => normalizeRestoreSourceRequest({
  clinicCode: CLINIC_CODE,
  slot: SLOT,
  environment: 'production'
}), /SERVER_BOUND_FIELD_DENIED/);

const apiSource = normalizeExactRestoreSource(exact, {
  clinicCode: CLINIC_CODE,
  slot: SLOT,
  environment: ENVIRONMENT,
  expectedRootFolderId: ROOT_FOLDER
});
assert.equal(apiSource.objects.transactions.fileId, fileId('transactions'));

const token = 'a'.repeat(48);
const tokenHash = createHash('sha256').update(token).digest('hex');
assert.equal(assertRestoreSourceApiToken(token, tokenHash), true);
assert.throws(() => assertRestoreSourceApiToken('b'.repeat(48), tokenHash), /TOKEN_INVALID/);

const stagingConfig = {
  RESTORE_SOURCE_API_ENABLED: 'true',
  SUPABASE_URL: 'https://stagingprojectrefabc.supabase.co',
  BACKUP_EXPECTED_SUPABASE_PROJECT_REF: 'stagingprojectrefabc',
  BACKUP_ENVIRONMENT: 'staging',
  BACKUP_DEPLOYMENT_ID: 'jitarsa-clinical-staging',
  // Synthetic same-customer Production identity for contract testing only.
  // Never substitute CNYOS staging/Production refs into Jitarsa live config.
  BACKUP_PRODUCTION_SUPABASE_URL: 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co',
  RESTORE_SOURCE_EXPECTED_PRODUCTION_PROJECT_REF: 'zzzzzzzzzzzzzzzzzzzz',
  BACKUP_EXPECTED_NETLIFY_SITE_ID: '10000000-0000-4000-8000-000000000010',
  BACKUP_EXPECTED_SITE_ORIGIN: 'https://synthetic-drive-staging.netlify.app',
  SUPABASE_SERVICE_ROLE_KEY: 's'.repeat(64),
  RESTORE_SOURCE_API_TOKEN_SHA256: tokenHash,
  GOOGLE_DRIVE_EXPECTED_ROOT_FOLDER_ID: ROOT_FOLDER,
  RESTORE_SOURCE_CLINIC_CODES: CLINIC_CODE
};
globalThis.Netlify = { env: { get: name => stagingConfig[name] || '' } };
assert.equal(restoreSourceConfiguration().environment, 'staging');
const exactRestoreContext = Object.freeze({
  site: Object.freeze({
    id: stagingConfig.BACKUP_EXPECTED_NETLIFY_SITE_ID,
    url: stagingConfig.BACKUP_EXPECTED_SITE_ORIGIN
  }),
  deploy: Object.freeze({
    id: 'deploy_restore_123456',
    context: 'production',
    published: true
  })
});
assert.deepEqual(assertRestoreSourceRuntime(
  new Request('https://synthetic-drive-staging.netlify.app/api/restore-source'),
  exactRestoreContext,
  stagingConfig.BACKUP_EXPECTED_NETLIFY_SITE_ID,
  stagingConfig.BACKUP_EXPECTED_SITE_ORIGIN
), {
  siteId: stagingConfig.BACKUP_EXPECTED_NETLIFY_SITE_ID,
  siteOrigin: stagingConfig.BACKUP_EXPECTED_SITE_ORIGIN,
  deployId: exactRestoreContext.deploy.id
});
assert.throws(() => assertRestoreSourceRuntime(
  new Request('https://synthetic-drive-staging.netlify.app/api/restore-source'),
  {
    ...exactRestoreContext,
    site: { ...exactRestoreContext.site, id: '20000000-0000-4000-8000-000000000020' }
  },
  stagingConfig.BACKUP_EXPECTED_NETLIFY_SITE_ID,
  stagingConfig.BACKUP_EXPECTED_SITE_ORIGIN
), /RUNTIME_MISMATCH/);
assert.throws(() => assertRestoreSourceRuntime(
  new Request('https://copied-site.netlify.app/api/restore-source'),
  exactRestoreContext,
  stagingConfig.BACKUP_EXPECTED_NETLIFY_SITE_ID,
  stagingConfig.BACKUP_EXPECTED_SITE_ORIGIN
), /RUNTIME_MISMATCH/);
assert.throws(() => assertRestoreSourceRuntime(
  new Request('https://synthetic-drive-staging.netlify.app/api/restore-source'),
  {
    ...exactRestoreContext,
    deploy: { ...exactRestoreContext.deploy, context: 'deploy-preview', published: false }
  },
  stagingConfig.BACKUP_EXPECTED_NETLIFY_SITE_ID,
  stagingConfig.BACKUP_EXPECTED_SITE_ORIGIN
), /DEPLOY_CONTEXT_DENIED/);
globalThis.Netlify = { env: { get: name => ({
  ...stagingConfig,
  BACKUP_PRODUCTION_SUPABASE_URL: ''
})[name] || '' } };
assert.throws(() => restoreSourceConfiguration(), /PRODUCTION_DENYLIST_INVALID/);
globalThis.Netlify = { env: { get: name => ({
  ...stagingConfig,
  BACKUP_PRODUCTION_SUPABASE_URL: stagingConfig.SUPABASE_URL,
  RESTORE_SOURCE_EXPECTED_PRODUCTION_PROJECT_REF: stagingConfig.BACKUP_EXPECTED_SUPABASE_PROJECT_REF
})[name] || '' } };
assert.throws(() => restoreSourceConfiguration(), /PRODUCTION_TARGET_DENIED/);

assert.equal(
  assertRestoreSourceEndpoint('https://synthetic-drive-staging.netlify.app/api/restore-source'),
  'https://synthetic-drive-staging.netlify.app/api/restore-source'
);
assert.throws(() => assertRestoreSourceEndpoint('https://example.test/api/restore-source'), /URL_INVALID/);
const apiCalls = [];
const fetched = await fetchExactRestoreSource({
  endpoint: 'https://synthetic-drive-staging.netlify.app/api/restore-source',
  apiToken: token,
  clinicCode: CLINIC_CODE,
  slot: SLOT,
  expectedEnvironment: ENVIRONMENT,
  expectedRootFolderId: ROOT_FOLDER,
  fetchImpl: async (url, options) => {
    apiCalls.push({ url: String(url), options });
    return new Response(JSON.stringify({ ok: true, source: exact }), { status: 200 });
  }
});
assert.equal(fetched.runId, RUN_ID);
assert.equal(apiCalls[0].options.headers.Authorization, `Bearer ${token}`);
assert.deepEqual(JSON.parse(apiCalls[0].options.body), { clinicCode: CLINIC_CODE, slot: SLOT });
assert.doesNotMatch(apiCalls[0].options.body, /environment|service.role/i);

// Read-only Drive topology and exact metadata validation.
const folderMetadataFetch = async url => {
  const id = decodeURIComponent(new URL(url).pathname.split('/').pop());
  return new Response(JSON.stringify({
    id,
    name: id,
    mimeType: 'application/vnd.google-apps.folder',
    parents: [ROOT_FOLDER],
    trashed: false
  }), { status: 200 });
};
await inspectRestoreFolder({
  accessToken: 'reader-access-token',
  folderId: folders.patients,
  expectedParentId: ROOT_FOLDER,
  fetchImpl: folderMetadataFetch
});

const patientObject = apiSource.objects.patients;
const objectMetadata = {
  id: patientObject.fileId,
  name: patientObject.fileName,
  mimeType: 'application/vnd.chananya.backup+json',
  size: String(patientObject.encryptedBytes),
  parents: [patientObject.destinationFolderId],
  trashed: false
};
const inspected = await inspectRestoreObject({
  accessToken: 'reader-access-token',
  sourceObject: patientObject,
  fetchImpl: async () => new Response(JSON.stringify(objectMetadata), { status: 200 })
});
assert.equal(inspected.size, patientObject.encryptedBytes);
await assert.rejects(inspectRestoreObject({
  accessToken: 'reader-access-token',
  sourceObject: patientObject,
  fetchImpl: async () => new Response(JSON.stringify({
    ...objectMetadata,
    parents: [folders.products]
  }), { status: 200 })
}), /PARENT_MISMATCH/);
await assert.rejects(inspectRestoreObject({
  accessToken: 'reader-access-token',
  sourceObject: patientObject,
  fetchImpl: async () => new Response(JSON.stringify({
    ...objectMetadata,
    size: String(patientObject.encryptedBytes + 1)
  }), { status: 200 })
}), /SIZE_MISMATCH/);

const downloadedBytes = Buffer.alloc(patientObject.encryptedBytes, 7);
assert.deepEqual(await downloadInspectedDriveObject({
  accessToken: 'reader-access-token',
  metadata: inspected,
  fetchImpl: async url => {
    assert.match(String(url), new RegExp(patientObject.fileId));
    return new Response(downloadedBytes, { status: 200 });
  }
}), downloadedBytes);

// Strict plaintext manifest and mutable-file-ID envelope binding.
const key = Buffer.alloc(32, 21);
const sourceRevision = '1234567890abcdef1234567890abcdef12345678';
const deploymentId = 'jitarsa-clinical-staging';
const encryptedByDomain = {};
const exactObjects = {};
for (const [index, domain] of RESTORE_DATA_DOMAINS.entries()) {
  const encrypted = encryptBackup({
    format: 'chananya-domain-export/v1',
    schema_version: '2026-09-01.1',
    clinic_id: CLINIC_ID,
    domain,
    included_tables: Object.keys(rowCounts[domain]),
    data: Object.fromEntries(Object.keys(rowCounts[domain]).map(table => [table, []]))
  }, key, {
    environment: ENVIRONMENT,
    deploymentId,
    sourceRevision,
    clinicId: CLINIC_ID,
    clinicCode: CLINIC_CODE,
    domain,
    slot: SLOT
  }, {
    iv: Buffer.alloc(12, index + 1),
    createdAt: '2026-09-01T20:00:02.000Z'
  });
  encryptedByDomain[domain] = encrypted.bytes;
  exactObjects[domain] = {
    domain,
    environment: ENVIRONMENT,
    destination_folder_id: folders[domain],
    drive_root_folder_id: ROOT_FOLDER,
    drive_assignment_version: 7,
    file_id: fileId(domain),
    file_name: fileName(domain),
    plaintext_bytes: encrypted.plaintextBytes,
    encrypted_bytes: encrypted.encryptedBytes,
    plaintext_sha256: encrypted.envelope.plaintext_sha256,
    ciphertext_sha256: encrypted.envelope.ciphertext_sha256,
    key_id: encrypted.envelope.key_id,
    row_counts: rowCounts[domain]
  };
}
exactObjects.manifest = {
  domain: 'manifest',
  environment: ENVIRONMENT,
  destination_folder_id: folders.manifests,
  drive_root_folder_id: ROOT_FOLDER,
  drive_assignment_version: 7,
  file_id: fileId('manifest'),
  file_name: fileName('manifest')
};
const boundSource = normalizeExactRestoreSource({
  format: 'chananya-exact-restore-source/v1',
  run_id: RUN_ID,
  clinic_id: CLINIC_ID,
  clinic_code: CLINIC_CODE,
  environment: ENVIRONMENT,
  slot: SLOT,
  completed_at: '2026-09-01T20:00:10.000Z',
  drive_assignment: {
    version: 7,
    root_folder_id: ROOT_FOLDER,
    folder_ids: folders
  },
  objects: exactObjects
});
const manifest = {
  format: 'chananya-backup-manifest/v2',
  environment: ENVIRONMENT,
  deployment_id: deploymentId,
  source_revision: sourceRevision,
  clinic_id: CLINIC_ID,
  clinic_code: CLINIC_CODE,
  slot: SLOT,
  generated_at: '2026-09-01T20:00:05.000Z',
  drive_assignment: {
    version: 7,
    root_folder_id: ROOT_FOLDER,
    folder_ids: folders
  },
  domains: RESTORE_DATA_DOMAINS.map(domain => ({
    domain,
    destination_folder_id: exactObjects[domain].destination_folder_id,
    drive_assignment_version: 7,
    file_id: exactObjects[domain].file_id,
    file_name: exactObjects[domain].file_name,
    plaintext_bytes: exactObjects[domain].plaintext_bytes,
    encrypted_bytes: exactObjects[domain].encrypted_bytes,
    plaintext_sha256: exactObjects[domain].plaintext_sha256,
    ciphertext_sha256: exactObjects[domain].ciphertext_sha256,
    key_id: exactObjects[domain].key_id,
    row_counts: rowCounts[domain]
  })),
  failures: []
};
const manifestBytes = Buffer.from(JSON.stringify(manifest));
assert.match(validateBackupManifest(manifestBytes, boundSource, sourceRevision).manifestSha256, /^[0-9a-f]{64}$/);
const changedManifest = structuredClone(manifest);
changedManifest.domains[0].file_id = fileId('products');
assert.throws(() => validateBackupManifest(
  Buffer.from(JSON.stringify(changedManifest)), boundSource, sourceRevision
), /DOMAIN_EVIDENCE_MISMATCH_PATIENTS/);

for (const domain of RESTORE_DATA_DOMAINS) {
  assert.equal(validateEncryptedObjectEnvelope({
    bytes: encryptedByDomain[domain],
    source: boundSource,
    domain,
    expectedSourceRevision: sourceRevision,
    expectedDeploymentId: deploymentId
  }).domain, domain);
}
const tamperedSameFileId = JSON.parse(encryptedByDomain.patients.toString('utf8'));
tamperedSameFileId.plaintext_sha256 = 'f'.repeat(64);
assert.throws(() => validateEncryptedObjectEnvelope({
  bytes: Buffer.from(JSON.stringify(tamperedSameFileId)),
  source: boundSource,
  domain: 'patients',
  expectedSourceRevision: sourceRevision,
  expectedDeploymentId: deploymentId
}), /ENVELOPE_(?:SIZE|EVIDENCE)_MISMATCH/);

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const reader = parseServiceAccount(JSON.stringify({
  client_email: 'restore-reader@example.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  token_uri: 'https://oauth2.googleapis.com/token'
}));
let readerAssertion = '';
await fetchGoogleRestoreReaderAccessToken(reader, async (_url, options) => {
  readerAssertion = new URLSearchParams(options.body).get('assertion');
  return new Response(JSON.stringify({ access_token: 'reader-token' }), { status: 200 });
});
const readerClaims = JSON.parse(Buffer.from(readerAssertion.split('.')[1], 'base64url').toString('utf8'));
assert.equal(readerClaims.scope, 'https://www.googleapis.com/auth/drive.readonly');

// CI must not expose a source service-role, uploader credential or any secret
// to npm ci/check. The historical source commit is separate from verifier SHA.
const workflow = await read('.github/workflows/isolated-restore-drill.yml');
const beforeSteps = workflow.slice(0, workflow.indexOf('    steps:'));
assert.doesNotMatch(beforeSteps, /secrets\./);
assert.doesNotMatch(workflow, /RESTORE_SOURCE_SUPABASE_SERVICE_ROLE_KEY|RESTORE_SOURCE_SUPABASE_URL/);
assert.match(workflow, /RESTORE_SOURCE_API_TOKEN: \$\{\{ secrets\.RESTORE_SOURCE_API_TOKEN \}\}/);
assert.match(workflow, /GOOGLE_DRIVE_RESTORE_READER_SERVICE_ACCOUNT_JSON/);
assert.doesNotMatch(workflow, /GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON/);
assert.match(workflow, /expected_source_commit:/);
assert.match(workflow, /Reject an unprotected verifier ref/);
assert.match(workflow, /restore-test-staging/);
assert.match(workflow, /RESTORE_SOURCE_ENVIRONMENT: staging/);
assert.doesNotMatch(workflow, /RESTORE_SOURCE_ENVIRONMENT: \$\{\{/);
assert.match(workflow, /verify-restore-source-binding\.mjs/);

const fetchScript = await read('scripts/fetch-drive-restore-set.mjs');
assert.match(fetchScript, /source\.objects\[domain\]/);
assert.match(fetchScript, /metadata\.manifest/);
assert.match(fetchScript, /validateBackupManifest/);
assert.match(fetchScript, /validateEncryptedObjectEnvelope/);
assert.doesNotMatch(fetchScript, /findDriveFile|list_owner_drive_assignments|SUPABASE_SERVICE_ROLE/);
const functionSource = await read('netlify/functions/restore-source.mts');
assert.match(functionSource, /get_exact_backup_restore_source/);
assert.match(functionSource, /RESTORE_SOURCE_API_TOKEN_SHA256/);
assert.match(functionSource, /RESTORE_SOURCE_API_ENABLED/);
assert.match(functionSource, /BACKUP_PRODUCTION_SUPABASE_URL/);
assert.match(functionSource, /BACKUP_EXPECTED_NETLIFY_SITE_ID/);
assert.match(functionSource, /BACKUP_EXPECTED_SITE_ORIGIN/);
assert.match(functionSource, /assertRestoreSourceRuntime/);
assert.doesNotMatch(functionSource, /serviceRoleKey[,:]\s*source|apiTokenSha256[,:]\s*source/);

console.log('Exact restore-source contracts passed: clinic-lock lease, completed-run recipe, narrow API, five exact Drive IDs, strict manifest/envelope binding, read-only reader and step-scoped CI secrets');
