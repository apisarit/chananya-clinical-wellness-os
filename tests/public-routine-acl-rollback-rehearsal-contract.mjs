import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACL_RELEASE_BLOCKERS,
  CHANANYA_ACL_REHEARSAL_PROFILE,
  buildPublicRoutineAclRollbackRehearsalSql,
  buildPublicRoutineAclStateSnapshotSql,
  sha256
} from '../scripts/generate-public-routine-acl-rollback-rehearsal.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidatePath = path.join(
  root,
  CHANANYA_ACL_REHEARSAL_PROFILE.candidateRelativePath
);
const runnerPath = path.join(
  root,
  'scripts',
  'run-public-routine-acl-rollback-rehearsal.mjs'
);
const nativeE2ePath = path.join(
  root,
  'tests',
  'public-routine-acl-rollback-rehearsal-psql-e2e.mjs'
);
const [candidateSource, runnerSource, nativeE2eSource] = await Promise.all([
  fs.readFile(candidatePath, 'utf8'),
  fs.readFile(runnerPath, 'utf8'),
  fs.readFile(nativeE2ePath, 'utf8')
]);
const sourceRevision = 'a'.repeat(40);

assert.equal(
  sha256(Buffer.from(candidateSource, 'utf8')),
  CHANANYA_ACL_REHEARSAL_PROFILE.candidateSha256,
  'rollback rehearsal must pin the exact independently reviewed candidate bytes'
);
for (const blocker of ACL_RELEASE_BLOCKERS) {
  assert.equal(
    candidateSource.split(`raise exception '${blocker}';`).length - 1,
    1,
    `source candidate must retain unconditional blocker ${blocker}`
  );
}
const sourcePolicyBlockerDo = candidateSource.match(
  /do \$cnyos_complete_acl_policy_blockers\$[\s\S]*?\$cnyos_complete_acl_policy_blockers\$;/g
);
assert.equal(
  sourcePolicyBlockerDo?.length,
  1,
  'all source blockers must live in one standalone pre-acquisition DO'
);
assert.ok(
  candidateSource.indexOf(sourcePolicyBlockerDo[0]) <
    candidateSource.indexOf('-- CNYOS_COMPLETE_ACL_SQL_ACQUISITION_BEGIN'),
  'source blocker DO must precede every advisory/relation lock and BEGIN'
);
assert.equal(
  (candidateSource.match(/^\s*commit\s*;/gimu) || []).length,
  1,
  'source candidate shape changed: expected one normal candidate COMMIT'
);

const successSql = buildPublicRoutineAclRollbackRehearsalSql({
  candidateSource,
  sourceRevision,
  failureMode: 'none'
});
const injectedFailureSql = buildPublicRoutineAclRollbackRehearsalSql({
  candidateSource,
  sourceRevision,
  failureMode: 'after-mutation'
});

assert.notEqual(successSql, injectedFailureSql, 'failure mode must be generation-pinned');
for (const [mode, sql] of [
  ['none', successSql],
  ['after-mutation', injectedFailureSql]
]) {
  assert.doesNotMatch(sql, /^\s*commit\s*;/imu, `${mode} SQL exposes COMMIT`);
  assert.doesNotMatch(
    sql,
    /do \$cnyos_complete_acl_policy_blockers\$/,
    `${mode} derivative retained the source blocker DO instead of replacing it`
  );
  assert.equal(
    (sql.match(/do \$cnyos_complete_acl_rehearsal_policy_gate\$/g) || []).length,
    1,
    `${mode} derivative must have one replacement rehearsal gate DO`
  );
  assert.ok(
    sql.indexOf('do $cnyos_complete_acl_rehearsal_policy_gate$') <
      sql.indexOf('-- CNYOS_COMPLETE_ACL_SQL_ACQUISITION_BEGIN'),
    `${mode} rehearsal gate must remain before every candidate lock and BEGIN`
  );
  assert.doesNotMatch(sql, /^\s*\\(?:gexec|include|ir)\b/imu);
  assert.equal(
    (sql.match(
      /^\s*begin\s+isolation\s+level\s+repeatable\s+read\s+read\s+write\s*;/gimu
    ) || []).length,
    1,
    `${mode} SQL must have exactly one explicit read-write transaction`
  );
  assert.equal(
    (sql.match(/^\s*set session characteristics as transaction read only\s*;/gimu) || [])
      .length,
    1,
    `${mode} SQL must make every outside transaction read-only`
  );
  assert.match(sql, /CNYOS_COMPLETE_ACL_REHEARSAL_SESSION_READ_ONLY_REQUIRED/);
  assert.ok(
    sql.indexOf("current_setting('transaction_read_only')='on'") <
      sql.indexOf('set search_path = pg_catalog, pg_temp;'),
    `${mode} SQL must verify startup read-only mode before candidate SQL`
  );
  assert.doesNotMatch(
    sql,
    /^\s*set\s+(?:default_transaction_read_only\s*=\s*off|transaction\s+read\s+write)/imu
  );
  assert.ok(
    sql.lastIndexOf('rollback;') > sql.indexOf('-- CNYOS_COMPLETE_ACL_MUTATION_END'),
    `${mode} SQL must roll back after the exact candidate mutation region`
  );
  assert.match(sql, /CNYOS_COMPLETE_ACL_REHEARSAL_ROLLBACK_NOT_REACHED/);
  assert.match(sql, /CNYOS_COMPLETE_ACL_REHEARSAL_TAIL_INVALID/);
  assert.match(sql, /current_setting\('transaction_read_only'\)='on'/);
  assert.match(sql, /CNYOS_COMPLETE_ACL_REHEARSAL_INTERLOCK_INVALID/);
  assert.match(sql, /CNYOS_COMPLETE_ACL_REHEARSAL_PRELOCK_TARGET_INVALID/);
  assert.match(sql, /pg_catalog\.host\(pg_catalog\.inet_server_addr\(\)\)/);
  assert.match(sql, /current_setting\('application_name'\)/);
  assert.match(sql, /CNYOS_COMPLETE_ACL_REHEARSAL_CLINIC_IDENTITY_INVALID/);
  assert.match(
    sql,
    /CNYOS_COMPLETE_ACL_REHEARSAL_TRANSACTION_CLINIC_IDENTITY_INVALID/
  );
  assert.ok(
    sql.indexOf('CNYOS_COMPLETE_ACL_TRIGGER_RELATION_LOCK_SET_INVALID') <
      sql.indexOf(
        'CNYOS_COMPLETE_ACL_REHEARSAL_TRANSACTION_CLINIC_IDENTITY_INVALID'
      ) &&
    sql.indexOf(
      'CNYOS_COMPLETE_ACL_REHEARSAL_TRANSACTION_CLINIC_IDENTITY_INVALID'
    ) < sql.indexOf('-- CNYOS_COMPLETE_ACL_MUTATION_BEGIN'),
    `${mode} SQL must recheck clinic identity after lock proof and before mutation`
  );
  assert.match(sql, /"rollback_only":true/);
  assert.match(sql, /"commit_allowed":false/);
  assert.match(sql, /"authorization":false/);
  assert.match(sql, /"production_eligible":false/);
  assert.ok(sql.includes(CHANANYA_ACL_REHEARSAL_PROFILE.candidateSha256));
  assert.ok(sql.includes(CHANANYA_ACL_REHEARSAL_PROFILE.projectRef));
  assert.ok(sql.includes(CHANANYA_ACL_REHEARSAL_PROFILE.systemIdentifier));
  assert.ok(sql.includes(CHANANYA_ACL_REHEARSAL_PROFILE.clinicId));
  assert.ok(sql.includes(CHANANYA_ACL_REHEARSAL_PROFILE.clinicCode));
  assert.ok(sql.includes(sourceRevision));
  for (const blocker of ACL_RELEASE_BLOCKERS) {
    assert.doesNotMatch(
      sql,
      new RegExp(`^\\s*raise exception '${blocker}';`, 'imu'),
      `${mode} derivative retained executable source blocker ${blocker}`
    );
    assert.match(
      sql,
      new RegExp(`rollback-only rehearsal bypassed source blocker: ${blocker}`),
      `${mode} derivative must identify each bypassed source blocker`
    );
  }
  if (mode === 'after-mutation') {
    assert.match(
      sql,
      /<> 'after-mutation' then[\s\S]*CNYOS_COMPLETE_ACL_REHEARSAL_INTERLOCK_INVALID/
    );
  } else {
    assert.match(
      sql,
      /<> 'none' then[\s\S]*CNYOS_COMPLETE_ACL_REHEARSAL_INTERLOCK_INVALID/
    );
  }
}
assert.equal(
  candidateSource,
  await fs.readFile(candidatePath, 'utf8'),
  'generating a derivative must not change the inert source candidate'
);

assert.throws(
  () => buildPublicRoutineAclRollbackRehearsalSql({
    candidateSource: `${candidateSource}\n-- tampered\n`,
    sourceRevision,
    failureMode: 'none'
  }),
  /candidate SHA-256 mismatch/
);
assert.throws(
  () => buildPublicRoutineAclRollbackRehearsalSql({
    candidateSource,
    sourceRevision: 'not-a-git-sha',
    failureMode: 'none'
  }),
  /source revision/
);
assert.throws(
  () => buildPublicRoutineAclRollbackRehearsalSql({
    candidateSource,
    sourceRevision,
    failureMode: 'commit'
  }),
  /Unsupported ACL rehearsal failure mode/
);
assert.throws(
  () => buildPublicRoutineAclRollbackRehearsalSql({
    candidateSource,
    sourceRevision,
    profile: {
      ...CHANANYA_ACL_REHEARSAL_PROFILE,
      environment: 'production'
    }
  }),
  /must target staging/
);
assert.throws(
  () => buildPublicRoutineAclRollbackRehearsalSql({
    candidateSource,
    sourceRevision,
    profile: {
      ...CHANANYA_ACL_REHEARSAL_PROFILE,
      psqlClientSha256: 'not-a-sha'
    }
  }),
  /psql client SHA-256/
);

const snapshotSql = buildPublicRoutineAclStateSnapshotSql();
assert.match(snapshotSql, /^\\set ON_ERROR_STOP 1$/m);
assert.match(snapshotSql, /^set session characteristics as transaction read only;$/m);
assert.match(snapshotSql, /^begin isolation level repeatable read read only;$/m);
assert.doesNotMatch(snapshotSql, /^\s*commit\s*;/imu);
assert.doesNotMatch(snapshotSql, /\bread\s+write\b/iu);
assert.equal((snapshotSql.match(/^rollback;$/gmu) || []).length, 2);
assert.match(snapshotSql, /CNYOS_COMPLETE_ACL_SNAPSHOT_TARGET_INVALID/);
assert.match(snapshotSql, /CNYOS_COMPLETE_ACL_SNAPSHOT_CLINIC_INVALID/);
assert.match(snapshotSql, /CNYOS_COMPLETE_ACL_SNAPSHOT_CARDINALITY_INVALID/);
assert.match(snapshotSql, /pg_catalog\.pg_stat_ssl/);
assert.match(snapshotSql, /pg_catalog\.host\(pg_catalog\.inet_server_addr\(\)\)/);
assert.ok(snapshotSql.includes(CHANANYA_ACL_REHEARSAL_PROFILE.systemIdentifier));
assert.ok(snapshotSql.includes(CHANANYA_ACL_REHEARSAL_PROFILE.applicationName));
assert.ok(snapshotSql.includes("'public_routine_sha256'"));
assert.ok(snapshotSql.includes("'function_default_acl_sha256'"));
assert.ok(snapshotSql.includes("'trigger_sha256'"));
assert.ok(snapshotSql.includes("'event_trigger_sha256'"));

for (const requiredRunnerFragment of [
  "'-X'",
  "'--set=ON_ERROR_STOP=1'",
  "'--set=AUTOCOMMIT=on'",
  "'--no-password'",
  "'status', '--porcelain=v1', '--untracked-files=all'",
  "'show', `${head}:${profile.candidateRelativePath}`",
  "writeProtected(path.join(directory, `${prefix}.stdout`)",
  "writeProtected(path.join(directory, `${prefix}.stderr`)",
  "writeProtected(\n      path.join(runDirectory, 'receipt.json')",
  "{ mode, flag: 'wx' }",
  "const before = await executePinnedPsqlFile",
  "execution = await executePinnedPsqlFile",
  "after = await executePinnedPsqlFile",
  'post_run_acl_catalog_state_equal: postRunAclCatalogStateEqual',
  'post_run_target_identity_equal: targetStateEqual',
  'expectedCandidateSha256 !== profile.candidateSha256',
  "values.get(name) !== value",
  'JSON.stringify(observedKeys) !== JSON.stringify(expectedKeys)',
  "options='-c default_transaction_read_only=on'",
  "if (isWithin(root, evidenceParent))",
  "PGPASSFILE: '/dev/fd/3'",
  "sqlFileFd === undefined ? sqlPath : '/dev/fd/4'",
  'expectedSha256: sqlSha256',
  'expectedSha256: profile.psqlClientSha256',
  'expectedSha256: profile.sslRootCertificateSha256',
  'expectedSha256: profile.serviceFileSha256',
  'PostgreSQL passfile must contain exactly one active entry',
  'Private runtime CA',
  'source_service_file_sha256',
  'runtime_service_file_sha256',
  'INJECTED_FAILURE_ACL_CATALOG_ROLLBACK_VERIFIED',
  'execution.status === 3',
  'execution.stdout === \'\'',
  "execution.stderr.match(/\\bERROR:/gu)",
  'const sourceAfter = await validateRepositorySource',
  "recordHarnessError(harnessErrors, 'execution_integrity'",
  "recordHarnessError(harnessErrors, 'execution_evidence'",
  "recordHarnessError(harnessErrors, 'post_observer_integrity'",
  "recordHarnessError(harnessErrors, 'post_observer_evidence'",
  'harnessErrors.length === 0',
  'harness_errors: harnessErrors',
  'this fresh observer is',
  'path contains a control character',
  'inspection.bytes.fill(0)'
]) {
  assert.ok(
    runnerSource.includes(requiredRunnerFragment),
    `runner is missing fail-closed fragment: ${requiredRunnerFragment}`
  );
}
assert.doesNotMatch(
  runnerSource.match(/function sanitizedLibpqEnvironment[\s\S]*?\n}\n/)[0],
  /PGPASSWORD/,
  'runner must not pass a plaintext password through its sanitized environment'
);
assert.doesNotMatch(
  runnerSource,
  /passfile_sha256|password\s*:/iu,
  'runner must not derive a reportable passfile digest or store a password field'
);
for (const digest of [
  CHANANYA_ACL_REHEARSAL_PROFILE.candidateSha256,
  CHANANYA_ACL_REHEARSAL_PROFILE.psqlClientSha256,
  CHANANYA_ACL_REHEARSAL_PROFILE.sslRootCertificateSha256,
  CHANANYA_ACL_REHEARSAL_PROFILE.serviceFileSha256
]) {
  assert.match(digest, /^[0-9a-f]{64}$/);
}
assert.match(runnerSource, /PostgreSQL 17 psql/);
assert.match(runnerSource, /requires a completely clean exact-source checkout/);
assert.match(runnerSource, /fresh observer/);
assert.match(
  nativeE2eSource,
  /process\.env\.CNYOS_PG17_DISPOSABLE_ACK !== disposableAcknowledgement/,
  'native rollback E2E must retain the exact disposable-cluster acknowledgement'
);
assert.match(
  nativeE2eSource,
  /databaseHost !== '127\.0\.0\.1'/,
  'native rollback E2E input must remain hard-locked to loopback'
);
assert.match(
  nativeE2eSource,
  /databaseUser !== 'postgres'/,
  'native rollback E2E must retain its disposable administrator guard'
);
assert.match(
  nativeE2eSource,
  /disposable server must report loopback or an RFC1918 container address/,
  'runtime identity may admit only loopback or private CI-container addresses'
);
assert.match(
  nativeE2eSource,
  /directHostAddress: serverAddress/,
  'snapshot profile must pin the already-validated server-reported address'
);
assert.doesNotMatch(
  nativeE2eSource,
  /server_address:\s*'127\.0\.0\.1'/,
  'runtime probe must not confuse a Docker service address with the guarded client target'
);

console.log(
  'public-routine ACL rollback rehearsal contract passed ' +
  '(exact candidate pin; source blockers preserved; no COMMIT derivative; ' +
  'read-only snapshots; explicit rollback; failure injection)'
);
