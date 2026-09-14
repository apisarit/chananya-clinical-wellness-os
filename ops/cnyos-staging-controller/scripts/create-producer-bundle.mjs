import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  POLICY,
  POLICY_SHA256,
  EXPECTED_FUNCTION_NAMES,
  MAX_FILE_BYTES,
  REQUIRED_SCHEDULES,
  aggregateDigest,
  assertControllerRuntime,
  canonicalIsoTimestamp,
  decodeNonce,
  exactSha40,
  exactSha256,
  fail,
  isPlainObject,
  normalizedRelativePath,
  readFileBounded,
  readRegularFileStable,
  required,
  sha256,
  walkRegularFiles,
  writeJsonExclusive
} from './policy.mjs';

const requiredDistFiles = Object.freeze([
  '_headers',
  '_redirects',
  'brand-config.js',
  'deploy-manifest.json',
  'index.html',
  'runtime-publish-manifest.json',
  'tenant-config.js'
]);

function runGit(candidateDirectory, args, encoding = 'utf8') {
  const isolated = { ...process.env };
  for (const name of Object.keys(isolated)) {
    if (name.startsWith('GIT_')) delete isolated[name];
  }
  isolated.GIT_CONFIG_NOSYSTEM = '1';
  isolated.GIT_CONFIG_GLOBAL = '/dev/null';
  isolated.GIT_OPTIONAL_LOCKS = '0';
  isolated.LC_ALL = 'C';
  return execFileSync('git', ['--no-replace-objects', ...args], {
    cwd: candidateDirectory,
    encoding,
    env: isolated,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function assertCleanTrackedCheckout(candidateDirectory) {
  try {
    runGit(candidateDirectory, ['diff', '--quiet', '--exit-code', 'HEAD', '--']);
    runGit(candidateDirectory, ['diff', '--cached', '--quiet', '--exit-code', '--']);
  } catch {
    fail('CNYOS_PRODUCER_TRACKED_CHECKOUT_DIRTY');
  }
}

function parseGitTree(candidateDirectory) {
  const raw = runGit(
    candidateDirectory,
    ['ls-tree', '-r', '-z', '--full-tree', 'HEAD', '--', 'netlify/functions'],
    'buffer'
  );
  const result = new Map();
  for (const record of raw.toString('utf8').split('\0').filter(Boolean)) {
    const match = record.match(/^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/);
    if (!match) fail('CNYOS_PRODUCER_FUNCTION_GIT_ENTRY_INVALID');
    const relative = match[3].replace(/^netlify\/functions\//, '');
    if (relative === match[3]) fail('CNYOS_PRODUCER_FUNCTION_GIT_ENTRY_INVALID');
    normalizedRelativePath(relative, 'CNYOS_PRODUCER_FUNCTION_PATH_INVALID');
    if (result.has(relative)) fail('CNYOS_PRODUCER_FUNCTION_GIT_ENTRY_DUPLICATE');
    result.set(relative, Object.freeze({ mode: match[1], object: match[2] }));
  }
  if (!result.size) fail('CNYOS_PRODUCER_FUNCTION_TREE_EMPTY');
  return result;
}

async function fileEntry(file, { gitObject = null } = {}) {
  const bytes = await readRegularFileStable(
    file.absolutePath,
    MAX_FILE_BYTES,
    'CNYOS_PRODUCER_ARTIFACT_FILE_CHANGED'
  );
  return Object.freeze({
    path: file.manifestPath,
    size: bytes.byteLength,
    sha256: sha256(bytes),
    ...(gitObject ? { gitObject } : {}),
    bytes,
    sourcePath: file.absolutePath
  });
}

function assertStagingDeployManifest(bytes, candidateCommit, candidateTree) {
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); }
  catch { fail('CNYOS_PRODUCER_DEPLOY_MANIFEST_INVALID'); }
  if (!isPlainObject(manifest) || manifest.schemaVersion !== 1 ||
    manifest.deploymentId !== POLICY.target.deploymentId ||
    manifest.source?.verified !== true ||
    manifest.source?.commit !== candidateCommit ||
    manifest.source?.tree !== candidateTree ||
    manifest.tenant?.expectedClinicId !== POLICY.target.clinicId ||
    manifest.tenant?.expectedClinicCode !== POLICY.target.clinicCode ||
    manifest.identity?.qrIssuer !== POLICY.target.qrIssuer ||
    manifest.build?.context !== 'production' ||
    manifest.build?.deploymentClass !== 'dedicated-staging' ||
    !Number.isFinite(Date.parse(manifest.build?.timestamp || '')) ||
    manifest.safety?.previewLocked !== false ||
    manifest.safety?.databaseLocked !== false ||
    manifest.safety?.stagingDatabaseExplicitlyAcknowledged !== true) {
    fail('CNYOS_PRODUCER_DEPLOY_MANIFEST_INVALID');
  }
  return manifest;
}

function assertRuntimeManifest(bytes, distEntries) {
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); }
  catch { fail('CNYOS_PRODUCER_RUNTIME_MANIFEST_INVALID'); }
  if (!isPlainObject(manifest) || manifest.schemaVersion !== 2 ||
    manifest.integrityAlgorithm !== 'sha256' || !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.integrity) || manifest.fileCount !== manifest.files.length ||
    manifest.files.length !== manifest.integrity.length) {
    fail('CNYOS_PRODUCER_RUNTIME_MANIFEST_INVALID');
  }
  const expectedEntries = distEntries
    .filter(item => item.path.startsWith('payload/dist/') &&
      item.path !== 'payload/dist/runtime-publish-manifest.json')
    .map(item => Object.freeze({
      path: item.path.slice('payload/dist/'.length),
      size: item.size,
      sha256: item.sha256
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const expected = expectedEntries.map(item => item.path);
  if (!manifest.files.every(item => typeof item === 'string') ||
    !isDeepStrictEqual(manifest.files, expected)) {
    fail('CNYOS_PRODUCER_RUNTIME_FILESET_MISMATCH');
  }
  for (const [index, entry] of manifest.integrity.entries()) {
    const expectedEntry = expectedEntries[index];
    if (!isPlainObject(entry) || Object.keys(entry).sort().join(',') !== 'path,sha256,size' ||
      entry.path !== expectedEntry.path || entry.size !== expectedEntry.size ||
      entry.sha256 !== expectedEntry.sha256) {
      fail('CNYOS_PRODUCER_RUNTIME_INTEGRITY_MISMATCH');
    }
  }
}

function parseGeneratedConfig(bytes, label) {
  const text = bytes.toString('utf8');
  const match = text.match(/^\/\/ Generated[^\r\n]*\r?\nwindow\.CLINICAL_OS_CONFIG = Object\.freeze\((\{[\s\S]*\})\);\s*$/);
  if (!match) fail(`CNYOS_PRODUCER_${label}_CONFIG_INVALID`);
  let value;
  try { value = JSON.parse(match[1]); }
  catch { fail(`CNYOS_PRODUCER_${label}_CONFIG_INVALID`); }
  if (!isPlainObject(value)) fail(`CNYOS_PRODUCER_${label}_CONFIG_INVALID`);
  return value;
}

function assertBrowserTarget(tenantBytes, brandBytes, deployManifest) {
  const tenant = parseGeneratedConfig(tenantBytes, 'TENANT');
  const brand = parseGeneratedConfig(brandBytes, 'BRAND');
  const key = String(tenant.database?.publishableKey || '');
  if (tenant.schemaVersion !== 1 || tenant.deploymentId !== POLICY.target.deploymentId ||
    tenant.tenant?.expectedClinicId !== POLICY.target.clinicId ||
    tenant.tenant?.expectedClinicCode !== POLICY.target.clinicCode ||
    tenant.database?.provider !== 'supabase' || tenant.database?.url !== POLICY.target.supabaseOrigin ||
    !/^sb_publishable_[A-Za-z0-9_-]{20,}$/.test(key) ||
    /(?:replace|placeholder|example|change[-_]?me|test(?:_|-)?only)/i.test(key) ||
    tenant.auth?.redirectOrigin !== POLICY.target.authRedirectOrigin ||
    tenant.auth?.provider !== 'google' || tenant.identity?.qrIssuer !== POLICY.target.qrIssuer ||
    tenant.safety?.previewLocked !== false) {
    fail('CNYOS_PRODUCER_TENANT_TARGET_MISMATCH');
  }
  const denied = POLICY.productionDenylist;
  if (tenant.database.url === denied.supabaseOrigin ||
    tenant.tenant.expectedClinicId === denied.clinicId ||
    tenant.tenant.expectedClinicCode === denied.clinicCode ||
    tenant.identity.qrIssuer === denied.qrIssuer || tenant.auth.redirectOrigin === denied.netlifyOrigin) {
    fail('CNYOS_PRODUCER_PRODUCTION_TARGET_DENIED');
  }
  if (brand.schemaVersion !== 1 || brand.deploymentId !== tenant.deploymentId ||
    !isDeepStrictEqual(brand.brand, tenant.brand) ||
    brand.tenant?.expectedClinicCode !== tenant.tenant.expectedClinicCode ||
    brand.identity?.qrIssuer !== tenant.identity.qrIssuer || brand.safety?.previewLocked !== false ||
    !isDeepStrictEqual(deployManifest.tenant, tenant.tenant) ||
    deployManifest.identity?.qrIssuer !== tenant.identity.qrIssuer) {
    fail('CNYOS_PRODUCER_BRAND_MANIFEST_TARGET_MISMATCH');
  }
}

async function loadStaticReproducibilityEvidence({
  env,
  runtime,
  candidateDirectory,
  candidateCommit,
  candidateTree,
  candidateBuildArtifactDigest,
  distFiles,
  observedAt
}) {
  const filename = path.resolve(required(
    env.CNYOS_STATIC_REPRODUCIBILITY_EVIDENCE_PATH,
    'CNYOS_PRODUCER_STATIC_REPRODUCIBILITY_EVIDENCE_PATH_REQUIRED',
    4096
  ));
  if (filename === candidateDirectory || filename.startsWith(`${candidateDirectory}${path.sep}`)) {
    fail('CNYOS_PRODUCER_STATIC_REPRODUCIBILITY_EVIDENCE_UNTRUSTED');
  }
  const bytes = await readFileBounded(
    filename,
    4 * 1024 * 1024,
    'CNYOS_PRODUCER_STATIC_REPRODUCIBILITY_EVIDENCE_INVALID'
  );
  const digest = sha256(bytes);
  if (digest !== exactSha256(
    env.CNYOS_EXPECTED_STATIC_REPRODUCIBILITY_EVIDENCE_SHA256,
    'CNYOS_PRODUCER_STATIC_REPRODUCIBILITY_EVIDENCE_DIGEST_REQUIRED'
  )) {
    fail('CNYOS_PRODUCER_STATIC_REPRODUCIBILITY_EVIDENCE_DIGEST_MISMATCH');
  }
  let evidence;
  try { evidence = JSON.parse(bytes.toString('utf8')); }
  catch { fail('CNYOS_PRODUCER_STATIC_REPRODUCIBILITY_EVIDENCE_INVALID'); }
  const policy = POLICY.staticArtifactReproducibility;
  const builderImageDigest = String(policy?.hermeticBuilderImageDigest || '');
  const stagingConfigSha256 = exactSha256(
    policy?.stagingConfigSha256,
    'CNYOS_PRODUCER_STATIC_REPRODUCIBILITY_POLICY_INVALID'
  );
  const productionDenylistConfigSha256 = exactSha256(
    policy?.productionDenylistConfigSha256,
    'CNYOS_PRODUCER_STATIC_REPRODUCIBILITY_POLICY_INVALID'
  );
  if (!/^sha256:[0-9a-f]{64}$/.test(builderImageDigest) ||
    policy?.contractRequired !== true || policy?.networkDisabledDuringBuild !== true) {
    fail('CNYOS_PRODUCER_STATIC_REPRODUCIBILITY_POLICY_INVALID');
  }
  const staticFiles = distFiles
    .map(file => ({ path: file.relativePath, size: file.status.size }))
    .sort((left, right) => left.path.localeCompare(right.path));
  for (const entry of staticFiles) {
    const file = distFiles.find(candidate => candidate.relativePath === entry.path);
    entry.sha256 = sha256(await readRegularFileStable(
      file.absolutePath,
      MAX_FILE_BYTES,
      'CNYOS_PRODUCER_STATIC_ARTIFACT_CHANGED_DURING_READ'
    ));
  }
  const staticArtifactSha256 = sha256(JSON.stringify(staticFiles));
  const candidateDependencyLockSha256 = sha256(runGit(
    candidateDirectory,
    ['show', 'HEAD:package-lock.json'],
    'buffer'
  ));
  const verifiedAt = canonicalIsoTimestamp(
    evidence?.verifiedAt,
    'CNYOS_PRODUCER_STATIC_REPRODUCIBILITY_EVIDENCE_INVALID'
  );
  if (!isPlainObject(evidence) || evidence.schemaVersion !== 1 ||
    evidence.evidenceType !== 'cnyos_staging_controller_static_reproducibility' ||
    evidence.status !== 'passed' || evidence.authorization !== false ||
    evidence.credentialsAvailable !== false ||
    evidence.controllerRepository !== runtime.repository ||
    evidence.controllerRef !== runtime.ref || evidence.controllerCommit !== runtime.commit ||
    evidence.controllerRunId !== runtime.runId || evidence.controllerRunAttempt !== 1 ||
    evidence.policySha256 !== POLICY_SHA256 ||
    evidence.sourceRepository !== POLICY.sourceRepository ||
    evidence.candidateCommit !== candidateCommit || evidence.candidateTree !== candidateTree ||
    evidence.untrustedReferenceArtifactDigest !== candidateBuildArtifactDigest ||
    evidence.candidateDependencyLockSha256 !== candidateDependencyLockSha256 ||
    evidence.configInputs?.stagingConfigSha256 !== stagingConfigSha256 ||
    evidence.configInputs?.productionDenylistConfigSha256 !== productionDenylistConfigSha256 ||
    evidence.buildEnvironment?.containerImageDigest !== builderImageDigest ||
    evidence.buildEnvironment?.nodeVersion !== '24.20.0' ||
    evidence.buildEnvironment?.networkDisabled !== true ||
    evidence.buildEnvironment?.lifecycleScriptsDisabled !== true ||
    evidence.buildEnvironment?.sourceMountedReadOnly !== true ||
    evidence.buildEnvironment?.isolatedOutput !== true ||
    evidence.byteForByteMatchWithUntrustedReference !== true ||
    evidence.staticArtifactSha256 !== staticArtifactSha256 ||
    evidence.fileCount !== staticFiles.length ||
    !isDeepStrictEqual(evidence.files, staticFiles) ||
    verifiedAt > observedAt || observedAt.getTime() - verifiedAt.getTime() > 30 * 60 * 1000) {
    fail('CNYOS_PRODUCER_STATIC_REPRODUCIBILITY_EVIDENCE_INVALID');
  }
  return Object.freeze({
    bytes,
    sha256: digest,
    files: Object.freeze(staticFiles.map(entry => Object.freeze({ ...entry }))),
    staticArtifactSha256,
    candidateDependencyLockSha256,
    stagingConfigSha256,
    productionDenylistConfigSha256
  });
}

async function loadPrebundledFunctions({
  env,
  runtime,
  candidateCommit,
  candidateTree,
  functionSourceTree,
  sourceEntries
}) {
  const directory = path.resolve(required(
    env.CNYOS_PREBUNDLED_FUNCTIONS_DIRECTORY,
    'CNYOS_PRODUCER_PREBUNDLED_FUNCTIONS_DIRECTORY_REQUIRED',
    4096
  ));
  const manifestBytes = await readFileBounded(
    required(env.CNYOS_FUNCTION_BUNDLE_MANIFEST_PATH,
      'CNYOS_PRODUCER_FUNCTION_BUNDLE_MANIFEST_REQUIRED', 4096),
    4 * 1024 * 1024,
    'CNYOS_PRODUCER_FUNCTION_BUNDLE_MANIFEST_INVALID'
  );
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); }
  catch { fail('CNYOS_PRODUCER_FUNCTION_BUNDLE_MANIFEST_INVALID'); }
  const sourceFiles = sourceEntries.map(entry => Object.freeze({
    path: entry.path.slice('source/netlify/functions/'.length),
    size: entry.size,
    sha256: entry.sha256,
    gitObject: entry.gitObject
  }));
  const expectedSourceSha256 = sha256(JSON.stringify(sourceFiles));
  const expectedDependencyLockSha256 = exactSha256(
    env.CNYOS_EXPECTED_FUNCTION_DEPENDENCY_LOCK_SHA256,
    'CNYOS_PRODUCER_FUNCTION_DEPENDENCY_LOCK_DIGEST_REQUIRED'
  );
  if (!isPlainObject(manifest) || manifest.schemaVersion !== 1 ||
    manifest.evidenceType !== 'cnyos_staging_controller_prebundled_functions' ||
    manifest.authorization !== false || manifest.credentialsAvailable !== false ||
    manifest.controllerRepository !== runtime.repository || manifest.controllerRef !== runtime.ref ||
    manifest.controllerCommit !== runtime.commit || manifest.controllerRunId !== runtime.runId ||
    manifest.sourceRepository !== POLICY.sourceRepository ||
    manifest.candidateCommit !== candidateCommit || manifest.candidateTree !== candidateTree ||
    manifest.functionSourceTree !== functionSourceTree || manifest.policySha256 !== POLICY_SHA256 ||
    manifest.netlifyCliVersion !== POLICY.publishing.netlifyCliVersion ||
    manifest.importClosureComplete !== true || manifest.externalImportsResolvedFromLock !== true ||
    manifest.dependencyLockSha256 !== expectedDependencyLockSha256 ||
    manifest.sourceFilesSha256 !== expectedSourceSha256 ||
    !isDeepStrictEqual(manifest.functionNames, EXPECTED_FUNCTION_NAMES) ||
    !isDeepStrictEqual(manifest.schedules, REQUIRED_SCHEDULES) || !Array.isArray(manifest.files)) {
    fail('CNYOS_PRODUCER_FUNCTION_BUNDLE_MANIFEST_INVALID');
  }
  const files = await walkRegularFiles(directory);
  const expectedNames = EXPECTED_FUNCTION_NAMES.map(name => `${name}.zip`).sort();
  const actualNames = files.map(item => item.relativePath).sort();
  if (!isDeepStrictEqual(actualNames, expectedNames) || manifest.files.length !== expectedNames.length) {
    fail('CNYOS_PRODUCER_FUNCTION_BUNDLE_FILESET_MISMATCH');
  }
  const declared = new Map();
  let previous = '';
  for (const entry of manifest.files) {
    if (!isPlainObject(entry) || Object.keys(entry).sort().join(',') !== 'path,sha256,size' ||
      typeof entry.path !== 'string' || entry.path <= previous ||
      !expectedNames.includes(entry.path) || !Number.isSafeInteger(entry.size) || entry.size < 1 ||
      !/^[0-9a-f]{64}$/.test(String(entry.sha256 || ''))) {
      fail('CNYOS_PRODUCER_FUNCTION_BUNDLE_MANIFEST_INVALID');
    }
    previous = entry.path;
    declared.set(entry.path, entry);
  }
  const deployEntries = [];
  for (const file of files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    const bytes = await readRegularFileStable(
      file.absolutePath,
      MAX_FILE_BYTES,
      'CNYOS_PRODUCER_FUNCTION_BUNDLE_CHANGED_DURING_READ'
    );
    const expected = declared.get(file.relativePath);
    if (!expected || bytes.byteLength !== expected.size || sha256(bytes) !== expected.sha256) {
      fail('CNYOS_PRODUCER_FUNCTION_BUNDLE_DIGEST_MISMATCH');
    }
    deployEntries.push(Object.freeze({
      path: `payload/netlify/functions/${file.relativePath}`,
      size: bytes.byteLength,
      sha256: expected.sha256,
      bytes,
      sourcePath: file.absolutePath
    }));
  }
  return Object.freeze({
    deployEntries,
    sourceFiles,
    sourceFilesSha256: expectedSourceSha256,
    manifestBytes,
    manifestSha256: sha256(manifestBytes),
    dependencyLockSha256: manifest.dependencyLockSha256
  });
}

async function copyEntry(bundleDirectory, entry) {
  const destination = path.resolve(bundleDirectory, entry.path);
  const root = `${path.resolve(bundleDirectory)}${path.sep}`;
  if (!destination.startsWith(root)) fail('CNYOS_PRODUCER_BUNDLE_PATH_ESCAPE');
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const handle = await fs.open(destination, 'wx', 0o600);
  try { await handle.writeFile(entry.bytes); }
  finally { await handle.close(); }
}

export async function createProducerBundle({
  env = process.env,
  now = () => new Date()
} = {}) {
  const runtime = assertControllerRuntime(env);
  const candidateDirectory = path.resolve(required(
    env.CNYOS_CANDIDATE_DIRECTORY,
    'CNYOS_PRODUCER_CANDIDATE_DIRECTORY_REQUIRED',
    4096
  ));
  const bundleDirectory = path.resolve(required(
    env.CNYOS_PRODUCER_BUNDLE_DIRECTORY,
    'CNYOS_PRODUCER_BUNDLE_DIRECTORY_REQUIRED',
    4096
  ));
  if (bundleDirectory === candidateDirectory || bundleDirectory.startsWith(`${candidateDirectory}${path.sep}`)) {
    fail('CNYOS_PRODUCER_BUNDLE_INSIDE_CANDIDATE');
  }
  const distDirectory = path.resolve(required(
    env.CNYOS_REPRODUCED_STATIC_DIRECTORY,
    'CNYOS_PRODUCER_REPRODUCED_STATIC_DIRECTORY_REQUIRED',
    4096
  ));
  if (distDirectory === candidateDirectory ||
    distDirectory.startsWith(`${candidateDirectory}${path.sep}`) ||
    distDirectory === bundleDirectory ||
    distDirectory.startsWith(`${bundleDirectory}${path.sep}`)) {
    fail('CNYOS_PRODUCER_REPRODUCED_STATIC_DIRECTORY_NOT_ISOLATED');
  }
  try {
    await fs.lstat(bundleDirectory);
    fail('CNYOS_PRODUCER_BUNDLE_ALREADY_EXISTS');
  } catch (error) {
    if (error?.message === 'CNYOS_PRODUCER_BUNDLE_ALREADY_EXISTS') throw error;
    if (error?.code !== 'ENOENT') throw error;
  }

  const candidateCommit = exactSha40(
    env.CNYOS_CANDIDATE_SHA,
    'CNYOS_PRODUCER_CANDIDATE_SHA_INVALID'
  );
  const head = String(runGit(candidateDirectory, ['rev-parse', 'HEAD'])).trim().toLowerCase();
  const candidateTree = String(runGit(candidateDirectory, ['rev-parse', 'HEAD^{tree}']))
    .trim()
    .toLowerCase();
  const functionSourceTree = String(runGit(
    candidateDirectory,
    ['rev-parse', 'HEAD:netlify/functions']
  )).trim().toLowerCase();
  if (head !== candidateCommit || !/^[0-9a-f]{40}$/.test(candidateTree) ||
    !/^[0-9a-f]{40}$/.test(functionSourceTree)) {
    fail('CNYOS_PRODUCER_CANDIDATE_CHECKOUT_MISMATCH');
  }
  assertCleanTrackedCheckout(candidateDirectory);
  const nonce = decodeNonce(env.CNYOS_DISPATCH_NONCE).value;
  const candidateBuildArtifactDigest = exactSha256(
    env.CNYOS_EXPECTED_CANDIDATE_BUILD_ARTIFACT_DIGEST,
    'CNYOS_PRODUCER_BUILD_ARTIFACT_DIGEST_REQUIRED'
  );
  const generatedAt = now();
  if (!(generatedAt instanceof Date) || Number.isNaN(generatedAt.getTime())) {
    fail('CNYOS_PRODUCER_TIME_INVALID');
  }

  const functionsDirectory = path.join(candidateDirectory, 'netlify/functions');
  const [distFiles, functionFiles] = await Promise.all([
    walkRegularFiles(distDirectory, 'payload/dist'),
    walkRegularFiles(functionsDirectory, 'payload/netlify/functions')
  ]);
  if (!distFiles.length) fail('CNYOS_PRODUCER_DIST_EMPTY');
  const staticReproducibility = await loadStaticReproducibilityEvidence({
    env,
    runtime,
    candidateDirectory,
    candidateCommit,
    candidateTree,
    candidateBuildArtifactDigest,
    distFiles,
    observedAt: generatedAt
  });
  const distPaths = new Set(distFiles.map(item => item.relativePath));
  for (const requiredFile of requiredDistFiles) {
    if (!distPaths.has(requiredFile)) fail('CNYOS_PRODUCER_REQUIRED_DIST_FILE_MISSING');
  }
  for (const item of distPaths) {
    if (/(?:^|\/)(?:\.env(?:\.|$)|\.git(?:\/|$)|artifacts(?:\/|$))|\.(?:sql|pem|key)$/i.test(item) ||
      item.split('/').some(part => part.startsWith('.'))) {
      fail('CNYOS_PRODUCER_FORBIDDEN_PUBLIC_FILE');
    }
  }

  const gitFunctions = parseGitTree(candidateDirectory);
  const functionPaths = new Set(functionFiles.map(item => item.relativePath));
  if (functionPaths.size !== gitFunctions.size ||
    [...functionPaths].some(item => !gitFunctions.has(item))) {
    fail('CNYOS_PRODUCER_FUNCTION_WORKTREE_MISMATCH');
  }

  const entries = [];
  for (const file of distFiles) entries.push(await fileEntry(file));
  const packagedStaticFiles = entries
    .map(entry => ({
      path: entry.path.slice('payload/dist/'.length),
      size: entry.size,
      sha256: entry.sha256
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (!isDeepStrictEqual(packagedStaticFiles, staticReproducibility.files)) {
    fail('CNYOS_PRODUCER_STATIC_ARTIFACT_CHANGED_AFTER_REPRODUCTION');
  }
  const sourceEntries = [];
  for (const file of functionFiles) {
    const tracked = gitFunctions.get(file.relativePath);
    const sourceFile = Object.freeze({ ...file, manifestPath: `source/netlify/functions/${file.relativePath}` });
    const entry = await fileEntry(sourceFile, { gitObject: tracked.object });
    const gitBytes = runGit(candidateDirectory, ['cat-file', 'blob', tracked.object], 'buffer');
    if (entry.size !== gitBytes.byteLength || entry.sha256 !== sha256(gitBytes)) {
      fail('CNYOS_PRODUCER_FUNCTION_WORKTREE_MISMATCH');
    }
    sourceEntries.push(entry);
  }
  sourceEntries.sort((left, right) => left.path.localeCompare(right.path));
  const functionBundle = await loadPrebundledFunctions({
    env,
    runtime,
    candidateCommit,
    candidateTree,
    functionSourceTree,
    sourceEntries
  });
  entries.push(...functionBundle.deployEntries);
  entries.sort((left, right) => left.path.localeCompare(right.path));

  const deployEntry = entries.find(item => item.path === 'payload/dist/deploy-manifest.json');
  const runtimeEntry = entries.find(item => item.path === 'payload/dist/runtime-publish-manifest.json');
  const tenantEntry = entries.find(item => item.path === 'payload/dist/tenant-config.js');
  const brandEntry = entries.find(item => item.path === 'payload/dist/brand-config.js');
  const deployManifest = assertStagingDeployManifest(deployEntry.bytes, candidateCommit, candidateTree);
  assertBrowserTarget(tenantEntry.bytes, brandEntry.bytes, deployManifest);
  assertRuntimeManifest(runtimeEntry.bytes, entries);
  const deniedMarkers = [
    POLICY.productionDenylist.netlifyOrigin,
    POLICY.productionDenylist.supabaseProjectRef,
    POLICY.productionDenylist.supabaseOrigin,
    POLICY.productionDenylist.clinicId
  ];
  for (const entry of entries.filter(item => item.path.startsWith('payload/dist/'))) {
    const text = entry.bytes.toString('utf8');
    if (deniedMarkers.some(marker => marker && text.includes(marker))) {
      fail('CNYOS_PRODUCER_PRODUCTION_TARGET_MARKER_PRESENT');
    }
  }

  const identity = Object.freeze({
    schemaVersion: 1,
    evidenceType: 'cnyos_staging_unprivileged_producer_bundle',
    authorization: false,
    credentialsAvailable: false,
    controllerRepository: runtime.repository,
    controllerRef: runtime.ref,
    controllerCommit: runtime.commit,
    controllerRunId: runtime.runId,
    controllerRunAttempt: 1,
    dispatchNonce: nonce,
    sourceRepository: POLICY.sourceRepository,
    candidateCommit,
    candidateTree,
    functionSourceTree,
    candidateBuildArtifactDigest,
    staticReproducibilityEvidenceSha256: staticReproducibility.sha256,
    staticArtifactSha256: staticReproducibility.staticArtifactSha256,
    candidateDependencyLockSha256: staticReproducibility.candidateDependencyLockSha256,
    stagingConfigSha256: staticReproducibility.stagingConfigSha256,
    productionDenylistConfigSha256: staticReproducibility.productionDenylistConfigSha256,
    functionBundleManifestSha256: functionBundle.manifestSha256,
    functionBundleDependencyLockSha256: functionBundle.dependencyLockSha256,
    functionSourcesSha256: functionBundle.sourceFilesSha256,
    policySha256: POLICY_SHA256
  });
  const publicEntries = entries.map(({ bytes, sourcePath, ...entry }) => Object.freeze(entry));
  const artifactSha256 = aggregateDigest(identity, publicEntries);
  const manifest = Object.freeze({
    ...identity,
    generatedAt: generatedAt.toISOString(),
    artifactSha256,
    fileCount: publicEntries.length,
    files: publicEntries,
    functionSources: functionBundle.sourceFiles
  });

  await fs.mkdir(bundleDirectory, { recursive: false, mode: 0o700 });
  for (const entry of entries) await copyEntry(bundleDirectory, entry);
  const functionManifestHandle = await fs.open(
    path.join(bundleDirectory, 'function-bundle-manifest.json'),
    'wx',
    0o600
  );
  try { await functionManifestHandle.writeFile(functionBundle.manifestBytes); }
  finally { await functionManifestHandle.close(); }
  const staticEvidenceHandle = await fs.open(
    path.join(bundleDirectory, 'static-reproducibility.json'),
    'wx',
    0o600
  );
  try { await staticEvidenceHandle.writeFile(staticReproducibility.bytes); }
  finally { await staticEvidenceHandle.close(); }
  const manifestPath = await writeJsonExclusive(
    path.join(bundleDirectory, 'producer-manifest.json'),
    manifest
  );
  return Object.freeze({ bundleDirectory, manifestPath, manifest });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  createProducerBundle().then(result => {
    process.stdout.write(`${JSON.stringify({
      manifestPath: result.manifestPath,
      artifactSha256: result.manifest.artifactSha256,
      candidateTree: result.manifest.candidateTree,
      functionSourceTree: result.manifest.functionSourceTree
    })}\n`);
  }).catch(error => {
    process.stderr.write(`${String(error?.message || 'CNYOS_PRODUCER_BUNDLE_FAILED')}\n`);
    process.exitCode = 1;
  });
}
