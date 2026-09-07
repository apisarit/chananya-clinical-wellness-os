import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACL_RELEASE_BLOCKERS,
  CHANANYA_ACL_REHEARSAL_PROFILE,
  buildPublicRoutineAclRollbackRehearsalSql,
  buildPublicRoutineAclStateSnapshotSql,
  sha256
} from '../scripts/generate-public-routine-acl-rollback-rehearsal.mjs';

// This test never connects to staging. It is deliberately opt-in because its
// fixture is a protected, local-only PG17 schema clone rather than a public CI
// artifact. The clone contains schema/catalog shape only and synthetic clinic
// identity; it must expose no live patient data or credentials.
const acknowledgement =
  'I_ACKNOWLEDGE_LOCAL_SCHEMA_ONLY_CHANANYA_ACL_CLONE';
if (process.env.CNYOS_ACL_FULL_CLONE_ACK !== acknowledgement) {
  throw new Error(
    `Set CNYOS_ACL_FULL_CLONE_ACK=${acknowledgement} for the protected local clone`
  );
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const psqlPath = process.env.CNYOS_PSQL_BIN || '';
const databaseHost = process.env.CNYOS_PGHOST || '';
const databasePort = process.env.CNYOS_PGPORT || '';
const databaseName = process.env.CNYOS_PGDATABASE || '';
const databaseUser = process.env.CNYOS_PGUSER || '';
const evidenceParent = process.env.CNYOS_ACL_CLONE_EVIDENCE_DIR || '';
if (!path.isAbsolute(psqlPath)) throw new Error('CNYOS_PSQL_BIN must be absolute');
if (databaseHost !== '127.0.0.1') {
  throw new Error('Full-clone rehearsal refuses every non-loopback database host');
}
if (!/^\d{4,5}$/.test(databasePort) || Number(databasePort) > 65535) {
  throw new Error('CNYOS_PGPORT must be an explicit local TCP port');
}
if (databaseName !== 'postgres' || databaseUser !== 'postgres') {
  throw new Error('Full-clone rehearsal requires the isolated postgres/postgres fixture');
}
for (const value of [psqlPath, databaseHost, databasePort, databaseName, databaseUser]) {
  if (/[\x00-\x1f\x7f]/u.test(value)) throw new Error('Unsafe local fixture setting');
}
if (evidenceParent && (!path.isAbsolute(evidenceParent) ||
    /[\x00-\x1f\x7f]/u.test(evidenceParent) ||
    !path.relative(root, evidenceParent).startsWith('..'))) {
  throw new Error('Clone evidence directory must be a safe absolute path outside the repository');
}

const temporaryDirectory = await fs.mkdtemp(
  path.join(os.tmpdir(), 'cnyos-acl-full-clone-rehearsal-')
);
const applicationName = CHANANYA_ACL_REHEARSAL_PROFILE.applicationName;
const sourceRevision = 'c'.repeat(40);
const startedAt = new Date().toISOString();

function runPsql(args, { allowFailure = false } = {}) {
  const result = spawnSync(psqlPath, [
    '-X', '--quiet', '--no-align', '--tuples-only', '--no-password',
    '-h', databaseHost,
    '-p', databasePort,
    '-U', databaseUser,
    '-d', databaseName,
    ...args
  ], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: {
      LANG: process.env.LANG || 'C',
      PATH: process.env.PATH || '/usr/bin:/bin',
      PGAPPNAME: applicationName,
      PGCONNECT_TIMEOUT: '3',
      PGOPTIONS: '-c default_transaction_read_only=on'
    },
    timeout: 180_000
  });
  if (result.error) throw result.error;
  const completed = {
    status: typeof result.status === 'number' ? result.status : -1,
    signal: result.signal || null,
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
  if (!allowFailure && (completed.status !== 0 || completed.signal)) {
    throw new Error(
      `Local clone psql failed (exit=${completed.status}): ${completed.stderr}`
    );
  }
  return completed;
}

function replaceExactly(source, needle, replacement, expectedCount, label) {
  const count = source.split(needle).length - 1;
  assert.equal(count, expectedCount, `${label} source shape changed`);
  return source.split(needle).join(replacement);
}

function localOnlyTargetRebind(generatedSql, localSystemIdentifier) {
  // Two substitutions are permitted, both target identity only. The complete
  // 147/141 routine program, 91-relation lock/proof, 173 trigger checks, seven
  // event-trigger checks, ACL/default-ACL mutation and all postconditions stay
  // byte-for-byte generated from the reviewed candidate.
  const productionGate = `     or pg_catalog.host(pg_catalog.inet_server_addr())<>'${
    CHANANYA_ACL_REHEARSAL_PROFILE.directHostAddress
  }'
     or v_system_identifier<>'${
    CHANANYA_ACL_REHEARSAL_PROFILE.systemIdentifier
  }'
     or not coalesce((
       select ssl from pg_catalog.pg_stat_ssl
       where pid=pg_catalog.pg_backend_pid()
     ),false) then`;
  const localGate = `     or pg_catalog.host(pg_catalog.inet_server_addr())<>'127.0.0.1'
     or v_system_identifier<>'${localSystemIdentifier}' then`;
  let rebound = replaceExactly(
    generatedSql,
    productionGate,
    localGate,
    1,
    'pre-lock target gate'
  );
  rebound = replaceExactly(
    rebound,
    `if v_system_identifier <> '${CHANANYA_ACL_REHEARSAL_PROFILE.systemIdentifier}' then`,
    `if v_system_identifier <> '${localSystemIdentifier}' then`,
    1,
    'candidate transaction system identifier gate'
  );
  return rebound;
}

async function writeSql(name, source) {
  const target = path.join(temporaryDirectory, name);
  await fs.writeFile(target, source, { mode: 0o600, flag: 'wx' });
  return target;
}

function parseSingleJson(stdout, label) {
  const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  assert.equal(lines.length, 1, `${label} must emit exactly one JSON row`);
  return JSON.parse(lines[0]);
}

function stateHash(snapshot) {
  return sha256(Buffer.from(JSON.stringify(snapshot.state), 'utf8'));
}

function processDigest(result) {
  return {
    exit_status: result.status,
    signal: result.signal,
    stdout_bytes: Buffer.byteLength(result.stdout),
    stdout_sha256: sha256(Buffer.from(result.stdout, 'utf8')),
    stderr_bytes: Buffer.byteLength(result.stderr),
    stderr_sha256: sha256(Buffer.from(result.stderr, 'utf8'))
  };
}

async function writeProtected(filePath, contents) {
  await fs.writeFile(filePath, contents, { mode: 0o600, flag: 'wx' });
  await fs.chmod(filePath, 0o600);
}

try {
  const psqlBytes = await fs.readFile(psqlPath);
  assert.equal(
    sha256(psqlBytes),
    CHANANYA_ACL_REHEARSAL_PROFILE.psqlClientSha256,
    'full-clone test must use the production-pinned PG17 psql bytes'
  );
  const probe = parseSingleJson(runPsql([
    '--set=ON_ERROR_STOP=1',
    '--command', String.raw`
select pg_catalog.jsonb_build_object(
  'server_version_num',current_setting('server_version_num'),
  'server_encoding',current_setting('server_encoding'),
  'transaction_read_only',current_setting('transaction_read_only'),
  'server_address',pg_catalog.host(pg_catalog.inet_server_addr()),
  'ssl',coalesce((select ssl from pg_catalog.pg_stat_ssl
                  where pid=pg_catalog.pg_backend_pid()),false),
  'system_identifier',(select system_identifier::text
                       from pg_catalog.pg_control_system()),
  'database',current_database(),
  'session_user',session_user,
  'current_user',current_user,
  'public_creators',(select jsonb_agg(rolname order by rolname collate "C")
    from pg_catalog.pg_roles
    where pg_catalog.has_schema_privilege(oid,'public','CREATE')),
  'postgres_role',(select pg_catalog.jsonb_build_array(
      rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
    ) from pg_catalog.pg_roles where rolname='postgres'),
  'public_routines',(select count(*) from pg_catalog.pg_proc p
                     join pg_catalog.pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public'),
  'security_definers',(select count(*) from pg_catalog.pg_proc p
                       join pg_catalog.pg_namespace n on n.oid=p.pronamespace
                       where n.nspname='public' and p.prosecdef),
  'triggers',(select count(*) from pg_catalog.pg_trigger where not tgisinternal),
  'event_triggers',(select count(*) from pg_catalog.pg_event_trigger),
  'clinic_rows',(select count(*) from public.clinics),
  'clinic_match',(select count(*)=1 from public.clinics
    where id='00000000-0000-4000-8000-00000000a001'::uuid
      and code='CHANANYA-STG' and active)
)::text;
`
  ]).stdout, 'local clone probe');
  assert.equal(Number(probe.server_version_num / 10000 | 0), 17);
  assert.equal(probe.server_encoding, 'UTF8');
  assert.equal(probe.transaction_read_only, 'on');
  assert.equal(probe.server_address, '127.0.0.1');
  assert.equal(probe.ssl, false);
  assert.equal(probe.database, 'postgres');
  assert.equal(probe.session_user, 'postgres');
  assert.equal(probe.current_user, 'postgres');
  assert.deepEqual(probe.public_creators, [
    'pg_database_owner', 'postgres', 'supabase_admin'
  ]);
  assert.deepEqual(probe.postgres_role, [true, false, true, true, true, true]);
  assert.equal(Number(probe.public_routines), 147);
  assert.equal(Number(probe.security_definers), 141);
  assert.equal(Number(probe.triggers), 173);
  assert.equal(Number(probe.event_triggers), 7);
  assert.equal(Number(probe.clinic_rows), 1);
  assert.equal(probe.clinic_match, true);
  assert.match(probe.system_identifier, /^\d+$/);

  const candidatePath = path.join(
    root,
    CHANANYA_ACL_REHEARSAL_PROFILE.candidateRelativePath
  );
  const candidateSource = await fs.readFile(candidatePath, 'utf8');
  assert.equal(
    sha256(Buffer.from(candidateSource, 'utf8')),
    CHANANYA_ACL_REHEARSAL_PROFILE.candidateSha256
  );
  const generatedByMode = new Map();
  for (const mode of ['none', 'after-mutation']) {
    const productionGenerated = buildPublicRoutineAclRollbackRehearsalSql({
      candidateSource,
      sourceRevision,
      failureMode: mode
    });
    const localGenerated = localOnlyTargetRebind(
      productionGenerated,
      probe.system_identifier
    );
    assert.doesNotMatch(localGenerated, /^\s*commit\s*;/imu);
    assert.doesNotMatch(localGenerated, /^\s*prepare\s+transaction\b/imu);
    assert.doesNotMatch(localGenerated, /^\s*\\(?:gexec|include|ir)\b/imu);
    assert.equal(
      (localGenerated.match(/^\s*begin isolation level repeatable read read write;/gimu) || [])
        .length,
      1
    );
    assert.equal((localGenerated.match(/^lock table only$/gimu) || []).length, 1);
    assert.match(localGenerated, /<>91[\s\S]*TRIGGER_RELATION_LOCK_SET_INVALID/);
    assert.match(localGenerated, /jsonb_array_length\(v_reviewed_path_plan\)<>141/);
    assert.match(localGenerated, /count\(\*\).*pg_catalog\.pg_trigger[\s\S]*<> 173/);
    assert.match(localGenerated, /count\(\*\).*pg_catalog\.pg_event_trigger[\s\S]*<> 7/);
    assert.match(localGenerated, /CNYOS_COMPLETE_ACL_MUTATION_BEGIN/);
    assert.match(localGenerated, /CNYOS_COMPLETE_ACL_MUTATION_END/);
    assert.match(
      localGenerated,
      /CNYOS_COMPLETE_ACL_REHEARSAL_TRANSACTION_CLINIC_IDENTITY_INVALID/
    );
    assert.ok(
      localGenerated.indexOf('CNYOS_COMPLETE_ACL_TRIGGER_RELATION_LOCK_SET_INVALID') <
        localGenerated.indexOf(
          'CNYOS_COMPLETE_ACL_REHEARSAL_TRANSACTION_CLINIC_IDENTITY_INVALID'
        ) &&
      localGenerated.indexOf(
        'CNYOS_COMPLETE_ACL_REHEARSAL_TRANSACTION_CLINIC_IDENTITY_INVALID'
      ) < localGenerated.indexOf('-- CNYOS_COMPLETE_ACL_MUTATION_BEGIN')
    );
    for (const blocker of ACL_RELEASE_BLOCKERS) {
      assert.ok(candidateSource.includes(`raise exception '${blocker}';`));
      assert.ok(localGenerated.includes(`rollback-only rehearsal bypassed source blocker: ${blocker}`));
    }
    generatedByMode.set(mode, {
      productionGenerated,
      localGenerated,
      path: await writeSql(`full-${mode}.sql`, localGenerated)
    });
  }

  const snapshotProfile = {
    ...CHANANYA_ACL_REHEARSAL_PROFILE,
    systemIdentifier: probe.system_identifier,
    directHostAddress: '127.0.0.1',
    requireSsl: false
  };
  const snapshotSql = buildPublicRoutineAclStateSnapshotSql({
    profile: snapshotProfile,
    requireSsl: false
  });
  const snapshotPath = await writeSql('full-state-snapshot.sql', snapshotSql);
  const snapshot = label => parseSingleJson(runPsql([
    '--set=ON_ERROR_STOP=1', '--set=AUTOCOMMIT=on', '--file', snapshotPath
  ]).stdout, label);
  const variables = mode => [
    '--set=ON_ERROR_STOP=1',
    '--set=AUTOCOMMIT=on',
    `--set=cnyos_complete_acl_rehearsal_ack=${
      CHANANYA_ACL_REHEARSAL_PROFILE.acknowledgement
    }`,
    `--set=cnyos_complete_acl_rehearsal_source_revision=${sourceRevision}`,
    `--set=cnyos_complete_acl_rehearsal_candidate_sha256=${
      CHANANYA_ACL_REHEARSAL_PROFILE.candidateSha256
    }`,
    `--set=cnyos_complete_acl_rehearsal_project_ref=${
      CHANANYA_ACL_REHEARSAL_PROFILE.projectRef
    }`,
    `--set=cnyos_complete_acl_rehearsal_failure_mode=${mode}`
  ];

  const beforeSuccess = snapshot('before full success rehearsal');
  const success = runPsql([
    ...variables('none'), '--file', generatedByMode.get('none').path
  ]);
  assert.equal(success.status, 0);
  assert.equal(success.signal, null);
  assert.equal(success.stderr, '');
  const successReceipt = parseSingleJson(success.stdout, 'full success rehearsal');
  assert.equal(successReceipt.status, 'CNYOS_COMPLETE_ACL_REHEARSAL_ROLLED_BACK');
  assert.equal(successReceipt.rollback_only, true);
  assert.equal(successReceipt.commit_allowed, false);
  const afterSuccess = snapshot('after full success rehearsal');
  assert.equal(stateHash(afterSuccess), stateHash(beforeSuccess));

  const beforeFailure = snapshot('before full injected-failure rehearsal');
  const failure = runPsql([
    ...variables('after-mutation'),
    '--file', generatedByMode.get('after-mutation').path
  ], { allowFailure: true });
  assert.equal(failure.status, 3, 'ON_ERROR_STOP script error must exit 3');
  assert.equal(failure.signal, null);
  assert.equal(failure.stdout.trim(), '');
  assert.match(
    failure.stderr,
    /CNYOS_COMPLETE_ACL_REHEARSAL_INJECTED_FAILURE_AFTER_MUTATION/
  );
  const afterFailure = snapshot('after full injected-failure rehearsal');
  assert.equal(stateHash(afterFailure), stateHash(beforeFailure));
  assert.equal(runPsql([
    '--set=ON_ERROR_STOP=1',
    '--command', String.raw`
select count(*) from pg_catalog.pg_locks
where locktype='advisory'
  and classid::bigint=(202608302100::bigint >> 32)
  and objid::bigint=(202608302100::bigint & 4294967295::bigint)
  and objsubid=1;
`
  ]).stdout.trim(), '0');

  const receipt = {
    artifact_schema: 'cnyos-public-routine-acl-full-clone-rehearsal/v1',
    status: 'CNYOS_COMPLETE_ACL_FULL_CLONE_ROLLBACK_REHEARSAL_PASSED',
    authorization: false,
    production_eligible: false,
    live_target_contacted: false,
    target: {
      kind: 'local-schema-only-clone',
      server_address: probe.server_address,
      port: databasePort,
      database: probe.database,
      user: probe.session_user,
      ssl: probe.ssl,
      system_identifier: probe.system_identifier,
      public_routines: Number(probe.public_routines),
      security_definers: Number(probe.security_definers),
      triggers: Number(probe.triggers),
      event_triggers: Number(probe.event_triggers),
      clinic_rows: Number(probe.clinic_rows),
      synthetic_clinic_identity_matched: probe.clinic_match,
      public_creators: probe.public_creators,
      postgres_role: probe.postgres_role
    },
    source_revision_fixture_value: sourceRevision,
    candidate_sha256: CHANANYA_ACL_REHEARSAL_PROFILE.candidateSha256,
    psql_client_sha256: sha256(psqlBytes),
    snapshot_sql_sha256: sha256(Buffer.from(snapshotSql, 'utf8')),
    production_success_derivative_sha256: sha256(Buffer.from(
      generatedByMode.get('none').productionGenerated,
      'utf8'
    )),
    local_success_derivative_sha256: sha256(Buffer.from(
      generatedByMode.get('none').localGenerated,
      'utf8'
    )),
    production_failure_derivative_sha256: sha256(Buffer.from(
      generatedByMode.get('after-mutation').productionGenerated,
      'utf8'
    )),
    local_failure_derivative_sha256: sha256(Buffer.from(
      generatedByMode.get('after-mutation').localGenerated,
      'utf8'
    )),
    before_success_acl_catalog_sha256: stateHash(beforeSuccess),
    after_success_acl_catalog_sha256: stateHash(afterSuccess),
    before_failure_acl_catalog_sha256: stateHash(beforeFailure),
    after_failure_acl_catalog_sha256: stateHash(afterFailure),
    successful_full_derivative_explicitly_rolled_back: true,
    full_derivative_91_relation_lock_proof_passed: true,
    injected_failure_full_derivative_acl_catalog_rollback_verified: true,
    commit_path_present: false,
    success_execution: processDigest(success),
    injected_failure_execution: processDigest(failure),
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    local_only_substitutions: [
      'pre-lock loopback/no-TLS/system-identifier gate',
      'transaction system-identifier gate'
    ]
  };
  if (evidenceParent) {
    await fs.mkdir(evidenceParent, { recursive: true, mode: 0o700 });
    const parentStats = await fs.lstat(evidenceParent);
    if (!parentStats.isDirectory() || parentStats.isSymbolicLink() ||
        (parentStats.mode & 0o077) !== 0) {
      throw new Error('Clone evidence directory must be a protected non-symlink directory');
    }
    const evidenceDirectory = path.join(
      evidenceParent,
      `full-clone-rollback-${Date.now()}`
    );
    await fs.mkdir(evidenceDirectory, { mode: 0o700 });
    await fs.chmod(evidenceDirectory, 0o700);
    receipt.restricted_evidence_directory = evidenceDirectory;
    await Promise.all([
      writeProtected(
        path.join(evidenceDirectory, 'receipt.json'),
        `${JSON.stringify(receipt, null, 2)}\n`
      ),
      writeProtected(path.join(evidenceDirectory, 'success.stdout'), success.stdout),
      writeProtected(path.join(evidenceDirectory, 'success.stderr'), success.stderr),
      writeProtected(path.join(evidenceDirectory, 'injected-failure.stdout'), failure.stdout),
      writeProtected(path.join(evidenceDirectory, 'injected-failure.stderr'), failure.stderr),
      writeProtected(
        path.join(evidenceDirectory, 'before-success-snapshot.json'),
        `${JSON.stringify(beforeSuccess, null, 2)}\n`
      ),
      writeProtected(
        path.join(evidenceDirectory, 'after-success-snapshot.json'),
        `${JSON.stringify(afterSuccess, null, 2)}\n`
      ),
      writeProtected(
        path.join(evidenceDirectory, 'before-failure-snapshot.json'),
        `${JSON.stringify(beforeFailure, null, 2)}\n`
      ),
      writeProtected(
        path.join(evidenceDirectory, 'after-failure-snapshot.json'),
        `${JSON.stringify(afterFailure, null, 2)}\n`
      )
    ]);
  }
  console.log(JSON.stringify(receipt));
} finally {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
}
