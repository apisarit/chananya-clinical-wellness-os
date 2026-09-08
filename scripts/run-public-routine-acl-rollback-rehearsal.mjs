import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACL_REHEARSAL_FAILURE_MODES,
  CHANANYA_ACL_REHEARSAL_PROFILE,
  buildPublicRoutineAclRollbackRehearsalSql,
  buildPublicRoutineAclStateSnapshotSql,
  sha256
} from './generate-public-routine-acl-rollback-rehearsal.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gitPath = '/usr/bin/git';
const expectedArgumentNames = new Set([
  'acknowledge',
  'evidence-dir',
  'expected-candidate-sha256',
  'expected-source-revision',
  'mode',
  'passfile',
  'psql',
  'service-file'
]);

function usage() {
  return `Usage:
  node scripts/run-public-routine-acl-rollback-rehearsal.mjs \\
    --psql /absolute/path/to/psql \\
    --service-file /protected/path/pg_service.conf \\
    --passfile /protected/path/pgpass \\
    --evidence-dir /protected/path/evidence \\
    --mode none|after-mutation \\
    --expected-source-revision <40-hex-git-sha> \\
    --expected-candidate-sha256 ${CHANANYA_ACL_REHEARSAL_PROFILE.candidateSha256} \\
    --acknowledge ${CHANANYA_ACL_REHEARSAL_PROFILE.acknowledgement}

This command is fixed to the direct Chananya staging service and never emits or
executes a COMMIT. It refuses a dirty checkout and writes mode-0600 evidence.
`;
}

function parseArguments(argv) {
  if (argv.includes('--help')) return { help: true };
  if (argv.length === 0 || argv.length % 2 !== 0) {
    throw new Error(usage());
  }
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const rawName = argv[index];
    const value = argv[index + 1];
    if (!rawName.startsWith('--')) throw new Error(`Invalid argument ${rawName}`);
    const name = rawName.slice(2);
    if (!expectedArgumentNames.has(name)) {
      throw new Error(`Unsupported argument --${name}`);
    }
    if (Object.hasOwn(parsed, name)) {
      throw new Error(`Duplicate argument --${name}`);
    }
    if (!value || value.startsWith('--')) {
      throw new Error(`Argument --${name} requires a value`);
    }
    parsed[name] = value;
  }
  for (const name of expectedArgumentNames) {
    if (!Object.hasOwn(parsed, name)) {
      throw new Error(`Missing --${name}\n${usage()}`);
    }
  }
  return parsed;
}

function runCommand(executable, args, options = {}) {
  const stdio = ['ignore', 'pipe', 'pipe'];
  if (options.passfileFd !== undefined) stdio.push(options.passfileFd);
  if (options.sqlFileFd !== undefined) stdio.push(options.sqlFileFd);
  const result = spawnSync(executable, args, {
    cwd: options.cwd || root,
    encoding: Object.hasOwn(options, 'encoding') ? options.encoding : 'utf8',
    env: options.env || process.env,
    stdio,
    maxBuffer: options.maxBuffer || 64 * 1024 * 1024,
    timeout: options.timeout || 180_000
  });
  return {
    status: typeof result.status === 'number' ? result.status : -1,
    signal: result.signal || null,
    error: result.error ? result.error.message : null,
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
}

function requireSuccessful(result, label) {
  if (result.status !== 0 || result.error) {
    throw new Error(
      `${label} failed (exit=${result.status}, signal=${result.signal || 'none'}): ` +
      `${result.error || result.stderr.trim() || 'no diagnostic'}`
    );
  }
  return result.stdout.trim();
}

function parseServiceFile(source, serviceName) {
  const sections = new Map();
  let current = null;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      if (sections.has(section[1])) {
        throw new Error(`Service file contains duplicate [${section[1]}] section`);
      }
      current = new Map();
      sections.set(section[1], current);
      continue;
    }
    const assignment = line.match(/^([^=]+?)\s*=\s*(.*)$/);
    if (!current || !assignment) {
      throw new Error('Service file contains an unsupported line');
    }
    const key = assignment[1].trim().toLowerCase();
    if (current.has(key)) {
      throw new Error(`Service file contains duplicate ${key} key`);
    }
    current.set(key, assignment[2].trim());
  }
  if (sections.size !== 1) {
    throw new Error('Service file must contain exactly one section');
  }
  const selected = sections.get(serviceName);
  if (!selected) throw new Error(`Service file is missing [${serviceName}]`);
  return selected;
}

function serializeFileIdentity(stats) {
  return {
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    size: stats.size.toString(),
    mode: Number(stats.mode & 0o777n),
    uid: Number(stats.uid),
    gid: Number(stats.gid),
    mtime_ns: stats.mtimeNs.toString(),
    ctime_ns: stats.ctimeNs.toString()
  };
}

function sameIdentity(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function inspectRegularFile(filePath, {
  label,
  expectedMode,
  expectedOwnerUid,
  expectedSha256 = null,
  readBytes = false
}) {
  if (!path.isAbsolute(filePath)) throw new Error(`${label} path must be absolute`);
  let handle;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`${label} cannot be opened without following a symlink: ${error.message}`);
  }
  try {
    const beforeStats = await handle.stat({ bigint: true });
    if (!beforeStats.isFile()) throw new Error(`${label} must be a regular file`);
    const beforeIdentity = serializeFileIdentity(beforeStats);
    if (beforeIdentity.mode !== expectedMode) {
      throw new Error(
        `${label} mode must be ${expectedMode.toString(8)}, got ` +
        beforeIdentity.mode.toString(8)
      );
    }
    if (beforeIdentity.uid !== expectedOwnerUid) {
      throw new Error(
        `${label} owner UID must be ${expectedOwnerUid}, got ${beforeIdentity.uid}`
      );
    }
    const bytes = expectedSha256 || readBytes ? await handle.readFile() : null;
    const digest = expectedSha256 && bytes ? sha256(bytes) : null;
    if (expectedSha256 && digest !== expectedSha256) {
      throw new Error(
        `${label} SHA-256 mismatch: expected ${expectedSha256}, got ${digest}`
      );
    }
    const afterIdentity = serializeFileIdentity(await handle.stat({ bigint: true }));
    if (!sameIdentity(beforeIdentity, afterIdentity)) {
      throw new Error(`${label} changed while it was inspected`);
    }
    return { identity: afterIdentity, sha256: digest, bytes };
  } finally {
    await handle.close();
  }
}

function parsePgpassLine(line) {
  const fields = [''];
  let escaped = false;
  for (const character of line) {
    if (escaped) {
      fields[fields.length - 1] += character;
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === ':') {
      fields.push('');
    } else {
      fields[fields.length - 1] += character;
    }
  }
  if (escaped) throw new Error('PostgreSQL passfile has a trailing escape');
  if (fields.length !== 5) {
    throw new Error('PostgreSQL passfile entry must contain exactly five fields');
  }
  return fields;
}

function validatePassfileBytes(bytes, profile) {
  const activeLines = bytes.toString('utf8').split(/\r?\n/)
    .filter(line => line.length > 0 && !line.startsWith('#'));
  if (activeLines.length !== 1) {
    throw new Error('PostgreSQL passfile must contain exactly one active entry');
  }
  const [host, port, database, user, password] = parsePgpassLine(activeLines[0]);
  if (host !== profile.directHost || port !== profile.directPort ||
      database !== profile.databaseName || user !== profile.databaseUser ||
      password.length === 0) {
    throw new Error('PostgreSQL passfile entry is not the exact Chananya staging tuple');
  }
}

async function inspectValidatedPassfile(passfilePath, profile) {
  const inspection = await inspectRegularFile(passfilePath, {
    label: 'PostgreSQL passfile',
    expectedMode: 0o600,
    expectedOwnerUid: profile.protectedFileOwnerUid,
    readBytes: true
  });
  try {
    validatePassfileBytes(inspection.bytes, profile);
  } finally {
    // Do not retain password bytes or derive a reportable digest.
    inspection.bytes.fill(0);
    inspection.bytes = null;
  }
  return inspection;
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertSafePathText(filePath, label) {
  if (/[\x00-\x1f\x7f]/u.test(filePath)) {
    throw new Error(`${label} path contains a control character`);
  }
}

async function assertProtectedDirectory(directoryPath, label, expectedOwnerUid) {
  const stats = await fs.lstat(directoryPath, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink directory`);
  }
  const mode = Number(stats.mode & 0o777n);
  if ((mode & 0o077) !== 0) {
    throw new Error(`${label} must deny group and other access`);
  }
  if (Number(stats.uid) !== expectedOwnerUid) {
    throw new Error(`${label} owner UID must be ${expectedOwnerUid}`);
  }
}

async function writeProtected(filePath, bytes, mode = 0o600) {
  await fs.writeFile(filePath, bytes, { mode, flag: 'wx' });
  await fs.chmod(filePath, mode);
}

function parseSingleJsonRow(stdout, label) {
  const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length !== 1) {
    throw new Error(`${label} must emit exactly one non-empty row, got ${lines.length}`);
  }
  try {
    return JSON.parse(lines[0]);
  } catch (error) {
    throw new Error(`${label} emitted invalid JSON: ${error.message}`);
  }
}

function summarizeProcess(result) {
  return {
    exit_status: result.status,
    signal: result.signal,
    spawn_error: result.error,
    stdout_bytes: Buffer.byteLength(result.stdout),
    stdout_sha256: sha256(Buffer.from(result.stdout, 'utf8')),
    stderr_bytes: Buffer.byteLength(result.stderr),
    stderr_sha256: sha256(Buffer.from(result.stderr, 'utf8'))
  };
}

function unavailableProcess(error) {
  return {
    status: -1,
    signal: null,
    error: error instanceof Error ? error.message : String(error),
    stdout: '',
    stderr: ''
  };
}

function recordHarnessError(errors, stage, error) {
  errors.push({
    stage,
    message: error instanceof Error ? error.message : String(error)
  });
}

function executePsqlFileUnverified({
  psqlPath,
  connectionArguments,
  environment,
  sqlPath,
  variables = {},
  passfileFd,
  sqlFileFd,
  timeout = 180_000
}) {
  const variableArguments = [];
  for (const [name, value] of Object.entries(variables)) {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      throw new Error(`Unsafe psql variable name ${name}`);
    }
    if (/[\r\n\0]/.test(String(value))) {
      throw new Error(`Unsafe psql variable value for ${name}`);
    }
    variableArguments.push(`--set=${name}=${value}`);
  }
  return runCommand(psqlPath, [
    '-X',
    '--quiet',
    '--no-align',
    '--tuples-only',
    '--no-password',
    '--set=ON_ERROR_STOP=1',
    '--set=AUTOCOMMIT=on',
    ...variableArguments,
    ...connectionArguments,
    '--file', sqlFileFd === undefined ? sqlPath : '/dev/fd/4'
  ], { env: environment, passfileFd, sqlFileFd, timeout });
}

async function inspectPinnedRuntimeFiles({
  psqlPath,
  runtimeCaPath,
  runtimeCaSha256,
  runtimeServicePath,
  runtimeServiceSha256,
  sqlPath,
  sqlSha256,
  profile
}) {
  const [psql, ca, service, sql] = await Promise.all([
    inspectRegularFile(psqlPath, {
      label: 'PostgreSQL 17 psql executable',
      expectedMode: 0o755,
      expectedOwnerUid: profile.protectedFileOwnerUid,
      expectedSha256: profile.psqlClientSha256
    }),
    inspectRegularFile(runtimeCaPath, {
      label: 'private runtime PostgreSQL SSL root certificate',
      expectedMode: 0o400,
      expectedOwnerUid: profile.protectedFileOwnerUid,
      expectedSha256: runtimeCaSha256
    }),
    inspectRegularFile(runtimeServicePath, {
      label: 'private runtime PostgreSQL service file',
      expectedMode: 0o400,
      expectedOwnerUid: profile.protectedFileOwnerUid,
      expectedSha256: runtimeServiceSha256
    }),
    inspectRegularFile(sqlPath, {
      label: 'pinned generated SQL program',
      expectedMode: 0o600,
      expectedOwnerUid: profile.protectedFileOwnerUid,
      expectedSha256: sqlSha256
    })
  ]);
  return { psql, ca, service, sql };
}

async function executePinnedPsqlFile({
  psqlPath,
  connectionArguments,
  environment,
  sqlPath,
  variables = {},
  passfilePath,
  runtimeCaPath,
  runtimeCaSha256,
  runtimeServicePath,
  runtimeServiceSha256,
  sqlSha256,
  profile,
  timeout = 180_000
}) {
  const before = await inspectPinnedRuntimeFiles({
    psqlPath,
    runtimeCaPath,
    runtimeCaSha256,
    runtimeServicePath,
    runtimeServiceSha256,
    sqlPath,
    sqlSha256,
    profile
  });
  const passfileBefore = await inspectValidatedPassfile(passfilePath, profile);
  let passfileHandle;
  let sqlFileHandle;
  let spawnedResult = null;
  let operationError = null;
  try {
    passfileHandle = await fs.open(
      passfilePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
    );
    const passedIdentity = serializeFileIdentity(
      await passfileHandle.stat({ bigint: true })
    );
    if (!sameIdentity(passfileBefore.identity, passedIdentity)) {
      throw new Error('PostgreSQL passfile changed before descriptor handoff');
    }
    sqlFileHandle = await fs.open(
      sqlPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
    );
    const sqlIdentity = serializeFileIdentity(
      await sqlFileHandle.stat({ bigint: true })
    );
    if (!sameIdentity(before.sql.identity, sqlIdentity)) {
      throw new Error('Generated SQL changed before descriptor handoff');
    }
    spawnedResult = executePsqlFileUnverified({
      psqlPath,
      connectionArguments,
      environment: {
        ...environment,
        // The child reads the already-open descriptor; it never re-resolves
        // the caller-controlled passfile path and no secret is copied to disk.
        PGPASSFILE: '/dev/fd/3'
      },
      sqlPath,
      variables,
      passfileFd: passfileHandle.fd,
      sqlFileFd: sqlFileHandle.fd,
      timeout
    });
    const passedIdentityAfter = serializeFileIdentity(
      await passfileHandle.stat({ bigint: true })
    );
    if (!sameIdentity(passedIdentity, passedIdentityAfter)) {
      throw new Error('PostgreSQL passfile changed during psql execution');
    }
    const sqlIdentityAfter = serializeFileIdentity(
      await sqlFileHandle.stat({ bigint: true })
    );
    if (!sameIdentity(sqlIdentity, sqlIdentityAfter)) {
      throw new Error('Generated SQL changed during psql execution');
    }
    const [after, passfileAfter] = await Promise.all([
      inspectPinnedRuntimeFiles({
        psqlPath,
        runtimeCaPath,
        runtimeCaSha256,
        runtimeServicePath,
        runtimeServiceSha256,
        sqlPath,
        sqlSha256,
        profile
      }),
      inspectValidatedPassfile(passfilePath, profile)
    ]);
    for (const name of ['psql', 'ca', 'service', 'sql']) {
      if (!sameIdentity(before[name].identity, after[name].identity)) {
        throw new Error(`${name} file identity changed during psql execution`);
      }
    }
    if (!sameIdentity(passfileBefore.identity, passfileAfter.identity)) {
      throw new Error('PostgreSQL passfile path identity changed during psql execution');
    }
  } catch (error) {
    operationError = error;
  }
  const closeErrors = [];
  for (const [label, handle] of [
    ['generated SQL descriptor', sqlFileHandle],
    ['PostgreSQL passfile descriptor', passfileHandle]
  ]) {
    if (!handle) continue;
    try {
      await handle.close();
    } catch (error) {
      closeErrors.push(`${label}: ${error.message}`);
    }
  }
  if (operationError || closeErrors.length > 0) {
    const combined = new Error([
      operationError?.message,
      ...closeErrors
    ].filter(Boolean).join('; '));
    if (spawnedResult) combined.psqlResult = spawnedResult;
    throw combined;
  }
  return spawnedResult;
}

async function gitText(args, label) {
  return requireSuccessful(runCommand(gitPath, args), label);
}

async function validateRepositorySource(expectedSourceRevision, profile) {
  if (!/^[0-9a-f]{40}$/.test(expectedSourceRevision)) {
    throw new Error('Expected source revision must be 40 lowercase hexadecimal');
  }
  const repositoryRoot = path.resolve(await gitText(
    ['rev-parse', '--show-toplevel'],
    'git repository discovery'
  ));
  if (repositoryRoot !== root) {
    throw new Error(`Runner root mismatch: expected ${root}, got ${repositoryRoot}`);
  }
  const head = await gitText(['rev-parse', 'HEAD'], 'git HEAD discovery');
  if (head !== expectedSourceRevision) {
    throw new Error(`Source revision mismatch: expected ${expectedSourceRevision}, got ${head}`);
  }
  const status = requireSuccessful(runCommand(gitPath, [
    'status', '--porcelain=v1', '--untracked-files=all'
  ]), 'git worktree status');
  if (status !== '') {
    throw new Error('ACL rehearsal requires a completely clean exact-source checkout');
  }
  const candidatePath = path.join(root, profile.candidateRelativePath);
  const [workingBytes, committedResult] = await Promise.all([
    fs.readFile(candidatePath),
    Promise.resolve(runCommand(gitPath, [
      'show', `${head}:${profile.candidateRelativePath}`
    ], { encoding: null }))
  ]);
  if (committedResult.status !== 0 || committedResult.error) {
    throw new Error('Exact source commit does not contain the ACL candidate');
  }
  const committedBytes = Buffer.isBuffer(committedResult.stdout)
    ? committedResult.stdout
    : Buffer.from(committedResult.stdout);
  if (!workingBytes.equals(committedBytes)) {
    throw new Error('Working ACL candidate differs from the exact source commit');
  }
  const candidateSha256 = sha256(workingBytes);
  if (candidateSha256 !== profile.candidateSha256) {
    throw new Error(
      `ACL candidate SHA-256 mismatch: expected ${profile.candidateSha256}, ` +
      `got ${candidateSha256}`
    );
  }
  return { head, candidatePath, candidateBytes: workingBytes };
}

function sanitizedLibpqEnvironment({ serviceFile, profile }) {
  return {
    LANG: 'C',
    LC_ALL: 'C',
    PATH: '/usr/bin:/bin',
    TZ: 'UTC',
    PGSERVICEFILE: serviceFile,
    PGSERVICE: profile.serviceName,
    PGAPPNAME: profile.applicationName,
    PGCONNECT_TIMEOUT: '10'
  };
}

async function validateDirectService({ serviceFile, passfile, profile }) {
  const [serviceInspection, passfileInspection] = await Promise.all([
    inspectRegularFile(serviceFile, {
      label: 'PostgreSQL service file',
      expectedMode: 0o600,
      expectedOwnerUid: profile.protectedFileOwnerUid,
      expectedSha256: profile.serviceFileSha256,
      readBytes: true
    }),
    inspectValidatedPassfile(passfile, profile)
  ]);
  const values = parseServiceFile(
    serviceInspection.bytes.toString('utf8'),
    profile.serviceName
  );
  const expected = new Map([
    ['host', profile.directHost],
    ['hostaddr', profile.directHostAddress],
    ['port', profile.directPort],
    ['dbname', profile.databaseName],
    ['user', profile.databaseUser],
    ['sslmode', 'verify-full'],
    ['sslrootcert', profile.sslRootCertificatePath],
    ['connect_timeout', '10'],
    ['application_name', profile.serviceApplicationName]
  ]);
  const observedKeys = [...values.keys()].sort();
  const expectedKeys = [...expected.keys()].sort();
  if (JSON.stringify(observedKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(
      `Direct service [${profile.serviceName}] keys must be exactly ` +
      expectedKeys.join(',')
    );
  }
  for (const [name, value] of expected) {
    if (values.get(name) !== value) {
      throw new Error(
        `Direct service [${profile.serviceName}] ${name} must be ${value}`
      );
    }
  }
  const sslRootCertificate = values.get('sslrootcert');
  const caInspection = await inspectRegularFile(sslRootCertificate, {
    label: 'PostgreSQL SSL root certificate',
    expectedMode: 0o600,
    expectedOwnerUid: profile.protectedFileOwnerUid,
    expectedSha256: profile.sslRootCertificateSha256,
    readBytes: true
  });
  return {
    sourceService: serviceInspection,
    sourceCa: caInspection,
    passfile: passfileInspection,
    values
  };
}

async function persistProcessEvidence(directory, prefix, result) {
  await Promise.all([
    writeProtected(path.join(directory, `${prefix}.stdout`), result.stdout),
    writeProtected(path.join(directory, `${prefix}.stderr`), result.stderr)
  ]);
}

async function validatePinnedPsqlVersion(psqlPath, profile) {
  const inspect = () => inspectRegularFile(psqlPath, {
    label: 'PostgreSQL 17 psql executable',
    expectedMode: 0o755,
    expectedOwnerUid: profile.protectedFileOwnerUid,
    expectedSha256: profile.psqlClientSha256
  });
  const before = await inspect();
  const result = runCommand(psqlPath, ['--version']);
  const after = await inspect();
  if (!sameIdentity(before.identity, after.identity)) {
    throw new Error('PostgreSQL 17 psql executable changed during version check');
  }
  const version = requireSuccessful(result, 'psql version check');
  if (!/\(PostgreSQL\) 17(?:\.|\s|$)/.test(version)) {
    throw new Error(`ACL rehearsal requires PostgreSQL 17 psql, got ${version}`);
  }
  return { version, inspection: after };
}

function buildPrivateRuntimeService(profile, runtimeCaPath) {
  assertSafePathText(runtimeCaPath, 'Private runtime CA');
  if (!/^\/[A-Za-z0-9._/-]+$/u.test(runtimeCaPath)) {
    throw new Error('Private runtime CA path must use the conservative safe-path alphabet');
  }
  const source = `[${profile.serviceName}]
host=${profile.directHost}
hostaddr=${profile.directHostAddress}
port=${profile.directPort}
dbname=${profile.databaseName}
user=${profile.databaseUser}
sslmode=verify-full
sslrootcert=${runtimeCaPath}
connect_timeout=10
application_name=${profile.serviceApplicationName}
`;
  const parsed = parseServiceFile(source, profile.serviceName);
  const expected = new Map([
    ['host', profile.directHost],
    ['hostaddr', profile.directHostAddress],
    ['port', profile.directPort],
    ['dbname', profile.databaseName],
    ['user', profile.databaseUser],
    ['sslmode', 'verify-full'],
    ['sslrootcert', runtimeCaPath],
    ['connect_timeout', '10'],
    ['application_name', profile.serviceApplicationName]
  ]);
  if (JSON.stringify([...parsed.entries()]) !== JSON.stringify([...expected.entries()])) {
    throw new Error('Generated private runtime service failed exact validation');
  }
  return source;
}

export async function runChananyaRollbackRehearsal(options) {
  const profile = CHANANYA_ACL_REHEARSAL_PROFILE;
  if (!ACL_REHEARSAL_FAILURE_MODES.includes(options.mode)) {
    throw new Error(`Unsupported --mode ${options.mode}`);
  }
  if (options.acknowledge !== profile.acknowledgement) {
    throw new Error('Rollback-only Chananya staging acknowledgement is invalid');
  }
  if (options.expectedCandidateSha256 !== profile.candidateSha256) {
    throw new Error('Expected candidate SHA-256 does not match the reviewed pin');
  }
  for (const [name, value] of [
    ['psql', options.psql],
    ['service-file', options.serviceFile],
    ['passfile', options.passfile],
    ['evidence-dir', options.evidenceDir]
  ]) {
    if (!value || !path.isAbsolute(value)) {
      throw new Error(`--${name} must be an absolute path`);
    }
    assertSafePathText(value, `--${name}`);
  }
  const psqlValidation = await validatePinnedPsqlVersion(options.psql, profile);
  const version = psqlValidation.version;
  const psqlClientSha256 = psqlValidation.inspection.sha256;
  const directService = await validateDirectService({
    serviceFile: options.serviceFile,
    passfile: options.passfile,
    profile
  });
  const source = await validateRepositorySource(options.expectedSourceRevision, profile);

  const evidenceParent = path.resolve(options.evidenceDir);
  if (isWithin(root, evidenceParent)) {
    throw new Error('Restricted ACL rehearsal evidence must be outside the repository');
  }
  await fs.mkdir(evidenceParent, { recursive: true, mode: 0o700 });
  const realEvidenceParent = await fs.realpath(evidenceParent);
  if (isWithin(root, realEvidenceParent)) {
    throw new Error('Resolved ACL rehearsal evidence directory is inside the repository');
  }
  await assertProtectedDirectory(
    realEvidenceParent,
    'ACL rehearsal evidence directory',
    profile.protectedFileOwnerUid
  );
  const runDirectory = path.join(
    realEvidenceParent,
    `acl-rollback-${options.mode}-${source.head.slice(0, 12)}-${randomUUID()}`
  );
  await fs.mkdir(runDirectory, { mode: 0o700 });
  await fs.chmod(runDirectory, 0o700);
  const startedAt = new Date().toISOString();

  // Pin TLS and service routing to private, immutable-for-this-run copies.
  // The password is never copied: each child receives an already-open fd.
  const runtimeCaPath = path.join(runDirectory, 'pinned-supabase-ca.crt');
  const runtimeServicePath = path.join(runDirectory, 'pinned-pg-service.conf');
  await writeProtected(runtimeCaPath, directService.sourceCa.bytes, 0o400);
  const runtimeServiceSource = buildPrivateRuntimeService(profile, runtimeCaPath);
  await writeProtected(runtimeServicePath, runtimeServiceSource, 0o400);
  const runtimeCaSha256 = sha256(directService.sourceCa.bytes);
  const runtimeServiceSha256 = sha256(Buffer.from(runtimeServiceSource, 'utf8'));

  const candidateSource = source.candidateBytes.toString('utf8');
  const rehearsalSql = buildPublicRoutineAclRollbackRehearsalSql({
    candidateSource,
    sourceRevision: source.head,
    failureMode: options.mode,
    profile
  });
  const snapshotSql = buildPublicRoutineAclStateSnapshotSql({ profile, requireSsl: true });
  const rehearsalSqlPath = path.join(runDirectory, 'rollback-rehearsal.sql');
  const snapshotSqlPath = path.join(runDirectory, 'state-snapshot-read-only.sql');
  const generatedSqlSha256 = sha256(Buffer.from(rehearsalSql, 'utf8'));
  const snapshotSqlSha256 = sha256(Buffer.from(snapshotSql, 'utf8'));
  await Promise.all([
    writeProtected(rehearsalSqlPath, rehearsalSql),
    writeProtected(snapshotSqlPath, snapshotSql)
  ]);

  const environment = sanitizedLibpqEnvironment({
    serviceFile: runtimeServicePath,
    profile
  });
  const connectionArguments = [
    '--dbname',
    `service=${profile.serviceName} ` +
      `application_name=${profile.applicationName} ` +
      `options='-c default_transaction_read_only=on'`
  ];
  const snapshotVariables = {};
  const runVariables = {
    cnyos_complete_acl_rehearsal_ack: profile.acknowledgement,
    cnyos_complete_acl_rehearsal_source_revision: source.head,
    cnyos_complete_acl_rehearsal_candidate_sha256: profile.candidateSha256,
    cnyos_complete_acl_rehearsal_project_ref: profile.projectRef,
    cnyos_complete_acl_rehearsal_failure_mode: options.mode
  };

  const pinnedExecutionOptions = {
    psqlPath: options.psql,
    connectionArguments,
    environment,
    passfilePath: options.passfile,
    runtimeCaPath,
    runtimeCaSha256,
    runtimeServicePath,
    runtimeServiceSha256,
    profile
  };
  const before = await executePinnedPsqlFile({
    ...pinnedExecutionOptions,
    sqlPath: snapshotSqlPath,
    sqlSha256: snapshotSqlSha256,
    variables: snapshotVariables
  });
  await persistProcessEvidence(runDirectory, 'before', before);
  if (before.status !== 0 || before.error || before.signal || before.stderr !== '') {
    const failed = {
      artifact_schema: 'cnyos-public-routine-acl-rollback-rehearsal/v1',
      status: 'CNYOS_COMPLETE_ACL_REHEARSAL_PRE_SNAPSHOT_FAILED',
      authorization: false,
      production_eligible: false,
      source_revision: source.head,
      candidate_sha256: profile.candidateSha256,
      generated_sql_sha256: generatedSqlSha256,
      snapshot_sql_sha256: snapshotSqlSha256,
      psql_client_version: version,
      psql_client_sha256: psqlClientSha256,
      ssl_root_certificate_sha256: runtimeCaSha256,
      source_service_file_sha256: directService.sourceService.sha256,
      runtime_service_file_sha256: runtimeServiceSha256,
      before: summarizeProcess(before)
    };
    await writeProtected(
      path.join(runDirectory, 'receipt.json'),
      `${JSON.stringify(failed, null, 2)}\n`
    );
    throw new Error(`Pre-rehearsal snapshot failed; evidence: ${runDirectory}`);
  }
  const beforeSnapshot = parseSingleJsonRow(before.stdout, 'pre-rehearsal snapshot');

  const harnessErrors = [];
  let execution;
  try {
    execution = await executePinnedPsqlFile({
      ...pinnedExecutionOptions,
      sqlPath: rehearsalSqlPath,
      sqlSha256: generatedSqlSha256,
      variables: runVariables
    });
  } catch (error) {
    recordHarnessError(harnessErrors, 'execution_integrity', error);
    execution = error?.psqlResult || unavailableProcess(error);
  }
  try {
    await persistProcessEvidence(runDirectory, 'execution', execution);
  } catch (error) {
    recordHarnessError(harnessErrors, 'execution_evidence', error);
  }

  // Once the mutation-capable execution is attempted, this fresh observer is
  // always attempted—even after execution-integrity or evidence-write errors.
  // Connection teardown aborts a failed transaction; the observer proves the
  // resulting durable ACL-catalog state rather than trusting that fact.
  let after;
  try {
    after = await executePinnedPsqlFile({
      ...pinnedExecutionOptions,
      sqlPath: snapshotSqlPath,
      sqlSha256: snapshotSqlSha256,
      variables: snapshotVariables
    });
  } catch (error) {
    recordHarnessError(harnessErrors, 'post_observer_integrity', error);
    after = error?.psqlResult || unavailableProcess(error);
  }
  try {
    await persistProcessEvidence(runDirectory, 'after', after);
  } catch (error) {
    recordHarnessError(harnessErrors, 'post_observer_evidence', error);
  }
  try {
    const sourceAfter = await validateRepositorySource(source.head, profile);
    if (sourceAfter.head !== source.head ||
        !sourceAfter.candidateBytes.equals(source.candidateBytes)) {
      throw new Error('Exact repository source changed during ACL rehearsal');
    }
  } catch (error) {
    recordHarnessError(harnessErrors, 'post_source_identity', error);
  }

  let afterSnapshot = null;
  let postRunAclCatalogStateEqual = false;
  if (after.status === 0 && !after.error && !after.signal && after.stderr === '') {
    try {
      afterSnapshot = parseSingleJsonRow(after.stdout, 'post-rehearsal snapshot');
      postRunAclCatalogStateEqual = JSON.stringify(beforeSnapshot.state) ===
        JSON.stringify(afterSnapshot.state);
    } catch (error) {
      recordHarnessError(harnessErrors, 'post_observer_parse', error);
    }
  }
  const executionLines = execution.stdout.split(/\r?\n/)
    .map(line => line.trim()).filter(Boolean);
  let parsedSuccessRow = null;
  if (executionLines.length === 1) {
    try { parsedSuccessRow = JSON.parse(executionLines[0]); } catch { /* invalid */ }
  }
  const successReceipt = parsedSuccessRow &&
    parsedSuccessRow.status === 'CNYOS_COMPLETE_ACL_REHEARSAL_ROLLED_BACK' &&
    parsedSuccessRow.candidate_sha256 === profile.candidateSha256 &&
    parsedSuccessRow.source_revision === source.head &&
    parsedSuccessRow.project_ref === profile.projectRef &&
    parsedSuccessRow.rollback_only === true &&
    parsedSuccessRow.commit_allowed === false
    ? parsedSuccessRow
    : null;
  const injectedFailureSeen = execution.stderr.includes(
    'CNYOS_COMPLETE_ACL_REHEARSAL_INJECTED_FAILURE_AFTER_MUTATION'
  );
  const injectedFailureDiagnosticValid = injectedFailureSeen &&
    (execution.stderr.match(/\bERROR:/gu) || []).length === 1 &&
    (execution.stderr.match(
      /CNYOS_COMPLETE_ACL_REHEARSAL_INJECTED_FAILURE_AFTER_MUTATION/gu
    ) || []).length === 1;
  const executionOutcomeValid = options.mode === 'none'
    ? execution.status === 0 && !execution.error && !execution.signal &&
      execution.stderr === '' && Boolean(successReceipt)
    : execution.status === 3 && !execution.error && !execution.signal &&
      execution.stdout === '' && injectedFailureDiagnosticValid && !successReceipt;
  const targetStateEqual = afterSnapshot !== null && [
    'project_label',
    'project_ref',
    'deployment_id',
    'environment',
    'system_identifier',
    'current_database',
    'session_user',
    'current_user',
    'server_version_num',
    'server_encoding',
    'server_address',
    'ssl'
  ].every(key => beforeSnapshot[key] === afterSnapshot[key]);
  const passed = harnessErrors.length === 0 && executionOutcomeValid &&
    after.status === 0 && !after.error &&
    !after.signal && after.stderr === '' && postRunAclCatalogStateEqual &&
    targetStateEqual;
  const receipt = {
    artifact_schema: 'cnyos-public-routine-acl-rollback-rehearsal/v1',
    status: passed
      ? options.mode === 'none'
        ? 'CNYOS_COMPLETE_ACL_REHEARSAL_ROLLBACK_VERIFIED'
        : 'CNYOS_COMPLETE_ACL_REHEARSAL_INJECTED_FAILURE_ACL_CATALOG_ROLLBACK_VERIFIED'
      : 'CNYOS_COMPLETE_ACL_REHEARSAL_FAILED',
    authorization: false,
    production_eligible: false,
    commit_allowed: false,
    target: {
      project_label: profile.projectLabel,
      project_ref: profile.projectRef,
      deployment_id: profile.deploymentId,
      environment: profile.environment,
      expected_system_identifier: profile.systemIdentifier,
      database: profile.databaseName,
      user: profile.databaseUser,
      service: profile.serviceName,
      direct_host: profile.directHost,
      direct_host_address: profile.directHostAddress,
      direct_port: profile.directPort
    },
    mode: options.mode,
    source_revision: source.head,
    evidence_source_revision: profile.evidenceSourceRevision,
    candidate_sha256: profile.candidateSha256,
    generated_sql_sha256: generatedSqlSha256,
    snapshot_sql_sha256: snapshotSqlSha256,
    psql_client_version: version,
    psql_client_sha256: psqlClientSha256,
    ssl_root_certificate_sha256: runtimeCaSha256,
    source_service_file_sha256: directService.sourceService.sha256,
    runtime_service_file_sha256: runtimeServiceSha256,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    observed_target: {
      system_identifier: beforeSnapshot.system_identifier,
      current_database: beforeSnapshot.current_database,
      session_user: beforeSnapshot.session_user,
      current_user: beforeSnapshot.current_user,
      server_version_num: beforeSnapshot.server_version_num,
      server_encoding: beforeSnapshot.server_encoding,
      server_address: beforeSnapshot.server_address,
      ssl: beforeSnapshot.ssl
    },
    before_acl_catalog_state_sha256: sha256(Buffer.from(
      JSON.stringify(beforeSnapshot.state), 'utf8'
    )),
    after_acl_catalog_state_sha256: afterSnapshot
      ? sha256(Buffer.from(JSON.stringify(afterSnapshot.state), 'utf8'))
      : null,
    post_run_acl_catalog_state_equal: postRunAclCatalogStateEqual,
    post_run_target_identity_equal: targetStateEqual,
    explicit_rollback_receipt_seen: Boolean(successReceipt),
    injected_failure_seen: injectedFailureSeen,
    harness_errors: harnessErrors,
    before: summarizeProcess(before),
    execution: summarizeProcess(execution),
    after: summarizeProcess(after)
  };
  await writeProtected(
    path.join(runDirectory, 'receipt.json'),
    `${JSON.stringify(receipt, null, 2)}\n`
  );
  if (!passed) {
    throw new Error(`Rollback rehearsal failed; evidence: ${runDirectory}`);
  }
  return { runDirectory, receipt };
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(usage());
    return;
  }
  const result = await runChananyaRollbackRehearsal({
    psql: path.resolve(parsed.psql),
    serviceFile: path.resolve(parsed['service-file']),
    passfile: path.resolve(parsed.passfile),
    evidenceDir: path.resolve(parsed['evidence-dir']),
    mode: parsed.mode,
    expectedSourceRevision: parsed['expected-source-revision'],
    expectedCandidateSha256: parsed['expected-candidate-sha256'],
    acknowledge: parsed.acknowledge
  });
  process.stdout.write(
    `${result.receipt.status}; restricted evidence: ${result.runDirectory}\n`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
