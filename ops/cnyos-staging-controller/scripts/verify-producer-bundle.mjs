import path from 'node:path';
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  POLICY,
  POLICY_SHA256,
  EXPECTED_FUNCTION_NAMES,
  MAX_FILE_BYTES,
  aggregateDigest,
  assertControllerRuntime,
  decodeNonce,
  exactSha256,
  fail,
  isPlainObject,
  normalizedRelativePath,
  readFileBounded,
  readRegularFileStable,
  required,
  sha256,
  walkRegularFiles
} from './policy.mjs';

function identityFromManifest(manifest) {
  return Object.freeze({
    schemaVersion: manifest.schemaVersion,
    evidenceType: manifest.evidenceType,
    authorization: manifest.authorization,
    credentialsAvailable: manifest.credentialsAvailable,
    controllerRepository: manifest.controllerRepository,
    controllerRef: manifest.controllerRef,
    controllerCommit: manifest.controllerCommit,
    controllerRunId: manifest.controllerRunId,
    controllerRunAttempt: manifest.controllerRunAttempt,
    dispatchNonce: manifest.dispatchNonce,
    sourceRepository: manifest.sourceRepository,
    candidateCommit: manifest.candidateCommit,
    candidateTree: manifest.candidateTree,
    functionSourceTree: manifest.functionSourceTree,
    candidateBuildArtifactDigest: manifest.candidateBuildArtifactDigest,
    staticReproducibilityEvidenceSha256: manifest.staticReproducibilityEvidenceSha256,
    staticArtifactSha256: manifest.staticArtifactSha256,
    candidateDependencyLockSha256: manifest.candidateDependencyLockSha256,
    stagingConfigSha256: manifest.stagingConfigSha256,
    productionDenylistConfigSha256: manifest.productionDenylistConfigSha256,
    functionBundleManifestSha256: manifest.functionBundleManifestSha256,
    functionBundleDependencyLockSha256: manifest.functionBundleDependencyLockSha256,
    functionSourcesSha256: manifest.functionSourcesSha256,
    policySha256: manifest.policySha256
  });
}

export async function verifyProducerBundle({ env = process.env } = {}) {
  const runtime = assertControllerRuntime(env);
  const bundleDirectory = path.resolve(required(
    env.CNYOS_PRODUCER_BUNDLE_DIRECTORY,
    'CNYOS_BUNDLE_DIRECTORY_REQUIRED',
    4096
  ));
  const manifestPath = path.join(bundleDirectory, 'producer-manifest.json');
  const manifestBytes = await readFileBounded(
    manifestPath,
    4 * 1024 * 1024,
    'CNYOS_PRODUCER_MANIFEST_INVALID'
  );
  const manifestSha256 = sha256(manifestBytes);
  if (env.CNYOS_EXPECTED_PRODUCER_MANIFEST_SHA256) {
    const expected = exactSha256(
      env.CNYOS_EXPECTED_PRODUCER_MANIFEST_SHA256,
      'CNYOS_EXPECTED_PRODUCER_MANIFEST_SHA256_INVALID'
    );
    if (manifestSha256 !== expected) fail('CNYOS_PRODUCER_MANIFEST_DIGEST_MISMATCH');
  }
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); }
  catch { fail('CNYOS_PRODUCER_MANIFEST_INVALID'); }
  if (!isPlainObject(manifest) || manifest.schemaVersion !== 1 ||
    manifest.evidenceType !== 'cnyos_staging_unprivileged_producer_bundle' ||
    manifest.authorization !== false || manifest.credentialsAvailable !== false ||
    manifest.controllerRepository !== runtime.repository ||
    manifest.controllerRef !== runtime.ref || manifest.controllerCommit !== runtime.commit ||
    manifest.controllerRunId !== runtime.runId ||
    manifest.controllerRunAttempt !== 1 || manifest.sourceRepository !== POLICY.sourceRepository ||
    manifest.policySha256 !== POLICY_SHA256 || !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.functionSources) ||
    manifest.fileCount !== manifest.files.length || manifest.fileCount < 1) {
    fail('CNYOS_PRODUCER_MANIFEST_INVALID');
  }
  const nonce = decodeNonce(env.CNYOS_DISPATCH_NONCE).value;
  if (manifest.dispatchNonce !== nonce) fail('CNYOS_PRODUCER_NONCE_MISMATCH');
  if (env.CNYOS_CANDIDATE_SHA && manifest.candidateCommit !== String(env.CNYOS_CANDIDATE_SHA).toLowerCase()) {
    fail('CNYOS_PRODUCER_CANDIDATE_COMMIT_MISMATCH');
  }
  for (const field of ['candidateCommit', 'candidateTree', 'functionSourceTree']) {
    if (!/^[0-9a-f]{40}$/.test(String(manifest[field] || ''))) fail('CNYOS_PRODUCER_MANIFEST_INVALID');
  }
  if (!/^[0-9a-f]{64}$/.test(String(manifest.candidateBuildArtifactDigest || '')) ||
    (env.CNYOS_EXPECTED_CANDIDATE_BUILD_ARTIFACT_DIGEST &&
      manifest.candidateBuildArtifactDigest !== exactSha256(
        env.CNYOS_EXPECTED_CANDIDATE_BUILD_ARTIFACT_DIGEST,
        'CNYOS_EXPECTED_CANDIDATE_BUILD_ARTIFACT_DIGEST_INVALID'
      )) ||
    !['staticReproducibilityEvidenceSha256', 'staticArtifactSha256',
      'candidateDependencyLockSha256', 'stagingConfigSha256',
      'productionDenylistConfigSha256', 'functionBundleManifestSha256',
      'functionBundleDependencyLockSha256', 'functionSourcesSha256']
      .every(field => /^[0-9a-f]{64}$/.test(String(manifest[field] || ''))) ||
    !/^[0-9a-f]{64}$/.test(String(manifest.artifactSha256 || '')) ||
    typeof manifest.generatedAt !== 'string' || !Number.isFinite(Date.parse(manifest.generatedAt))) {
    fail('CNYOS_PRODUCER_MANIFEST_INVALID');
  }
  if (manifest.stagingConfigSha256 !== exactSha256(
    POLICY.staticArtifactReproducibility?.stagingConfigSha256,
    'CNYOS_PRODUCER_STATIC_REPRODUCIBILITY_POLICY_INVALID'
  ) || manifest.productionDenylistConfigSha256 !== exactSha256(
    POLICY.staticArtifactReproducibility?.productionDenylistConfigSha256,
    'CNYOS_PRODUCER_STATIC_REPRODUCIBILITY_POLICY_INVALID'
  )) {
    fail('CNYOS_PRODUCER_STATIC_REPRODUCIBILITY_POLICY_MISMATCH');
  }
  const staticEvidenceBytes = await readFileBounded(
    path.join(bundleDirectory, 'static-reproducibility.json'),
    4 * 1024 * 1024,
    'CNYOS_PRODUCER_STATIC_REPRODUCIBILITY_EVIDENCE_INVALID'
  );
  if (sha256(staticEvidenceBytes) !== manifest.staticReproducibilityEvidenceSha256) {
    fail('CNYOS_PRODUCER_STATIC_REPRODUCIBILITY_EVIDENCE_DIGEST_MISMATCH');
  }
  let staticEvidence;
  try { staticEvidence = JSON.parse(staticEvidenceBytes.toString('utf8')); }
  catch { fail('CNYOS_PRODUCER_STATIC_REPRODUCIBILITY_EVIDENCE_INVALID'); }
  if (!isPlainObject(staticEvidence) ||
    staticEvidence.evidenceType !== 'cnyos_staging_controller_static_reproducibility' ||
    staticEvidence.status !== 'passed' ||
    staticEvidence.controllerRunId !== manifest.controllerRunId ||
    staticEvidence.controllerCommit !== manifest.controllerCommit ||
    staticEvidence.candidateCommit !== manifest.candidateCommit ||
    staticEvidence.candidateTree !== manifest.candidateTree ||
    staticEvidence.untrustedReferenceArtifactDigest !== manifest.candidateBuildArtifactDigest ||
    staticEvidence.candidateDependencyLockSha256 !== manifest.candidateDependencyLockSha256 ||
    staticEvidence.configInputs?.stagingConfigSha256 !== manifest.stagingConfigSha256 ||
    staticEvidence.configInputs?.productionDenylistConfigSha256 !==
      manifest.productionDenylistConfigSha256 ||
    staticEvidence.staticArtifactSha256 !== manifest.staticArtifactSha256 ||
    staticEvidence.byteForByteMatchWithUntrustedReference !== true ||
    !Array.isArray(staticEvidence.files)) {
    fail('CNYOS_PRODUCER_STATIC_REPRODUCIBILITY_EVIDENCE_INVALID');
  }
  const functionBundleManifestBytes = await readFileBounded(
    path.join(bundleDirectory, 'function-bundle-manifest.json'),
    4 * 1024 * 1024,
    'CNYOS_PRODUCER_FUNCTION_BUNDLE_MANIFEST_INVALID'
  );
  if (sha256(functionBundleManifestBytes) !== manifest.functionBundleManifestSha256) {
    fail('CNYOS_PRODUCER_FUNCTION_BUNDLE_MANIFEST_DIGEST_MISMATCH');
  }

  const declared = new Map();
  let previous = '';
  for (const entry of manifest.files) {
    if (!isPlainObject(entry) || Object.keys(entry).some(key =>
      !['path', 'size', 'sha256', 'gitObject'].includes(key))) {
      fail('CNYOS_PRODUCER_MANIFEST_FILE_INVALID');
    }
    const manifestFilePath = normalizedRelativePath(entry.path, 'CNYOS_PRODUCER_MANIFEST_PATH_INVALID');
    if (!manifestFilePath.startsWith('payload/dist/') &&
      !manifestFilePath.startsWith('payload/netlify/functions/')) {
      fail('CNYOS_PRODUCER_MANIFEST_PATH_INVALID');
    }
    if (manifestFilePath <= previous || declared.has(manifestFilePath) ||
      !Number.isSafeInteger(entry.size) || entry.size < 0 ||
      !/^[0-9a-f]{64}$/.test(String(entry.sha256 || ''))) {
      fail('CNYOS_PRODUCER_MANIFEST_FILE_INVALID');
    }
    if (manifestFilePath.startsWith('payload/netlify/functions/')) {
      if (entry.gitObject !== undefined || !/^payload\/netlify\/functions\/[A-Za-z0-9_-]+\.zip$/.test(
        manifestFilePath
      )) fail('CNYOS_PRODUCER_FUNCTION_BUNDLE_FILE_INVALID');
    } else if (entry.gitObject !== undefined) {
      fail('CNYOS_PRODUCER_MANIFEST_FILE_INVALID');
    }
    previous = manifestFilePath;
    declared.set(manifestFilePath, entry);
  }
  const declaredStaticFiles = manifest.files
    .filter(entry => entry.path.startsWith('payload/dist/'))
    .map(entry => ({
      path: entry.path.slice('payload/dist/'.length),
      size: entry.size,
      sha256: entry.sha256
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (!isDeepStrictEqual(staticEvidence.files, declaredStaticFiles) ||
    staticEvidence.fileCount !== declaredStaticFiles.length ||
    sha256(JSON.stringify(declaredStaticFiles)) !== manifest.staticArtifactSha256) {
    fail('CNYOS_PRODUCER_STATIC_REPRODUCIBILITY_FILESET_MISMATCH');
  }

  const sourceNames = new Set();
  let previousSource = '';
  for (const entry of manifest.functionSources) {
    if (!isPlainObject(entry) || Object.keys(entry).sort().join(',') !== 'gitObject,path,sha256,size' ||
      typeof entry.path !== 'string' || entry.path <= previousSource || sourceNames.has(entry.path) ||
      !Number.isSafeInteger(entry.size) || entry.size < 0 ||
      !/^[0-9a-f]{64}$/.test(String(entry.sha256 || '')) ||
      !/^[0-9a-f]{40}$/.test(String(entry.gitObject || ''))) {
      fail('CNYOS_PRODUCER_FUNCTION_SOURCE_MANIFEST_INVALID');
    }
    normalizedRelativePath(entry.path, 'CNYOS_PRODUCER_FUNCTION_SOURCE_PATH_INVALID');
    previousSource = entry.path;
    sourceNames.add(entry.path);
  }
  if (!manifest.functionSources.length || sha256(JSON.stringify(manifest.functionSources)) !==
    manifest.functionSourcesSha256) fail('CNYOS_PRODUCER_FUNCTION_SOURCE_MANIFEST_INVALID');
  const bundleNames = manifest.files.filter(entry =>
    entry.path.startsWith('payload/netlify/functions/'))
    .map(entry => path.posix.basename(entry.path, '.zip')).sort();
  if (bundleNames.length !== EXPECTED_FUNCTION_NAMES.length ||
    EXPECTED_FUNCTION_NAMES.some((name, index) => name !== bundleNames[index])) {
    fail('CNYOS_PRODUCER_FUNCTION_BUNDLE_FILESET_MISMATCH');
  }

  const payloadFiles = await walkRegularFiles(path.join(bundleDirectory, 'payload'), 'payload');
  if (payloadFiles.length !== declared.size) fail('CNYOS_PRODUCER_BUNDLE_FILESET_MISMATCH');
  for (const file of payloadFiles) {
    const expected = declared.get(file.manifestPath);
    if (!expected) fail('CNYOS_PRODUCER_BUNDLE_FILESET_MISMATCH');
    const bytes = await readRegularFileStable(
      file.absolutePath,
      MAX_FILE_BYTES,
      'CNYOS_PRODUCER_BUNDLE_FILE_CHANGED_DURING_READ'
    );
    if (bytes.byteLength !== expected.size || sha256(bytes) !== expected.sha256) {
      fail('CNYOS_PRODUCER_BUNDLE_DIGEST_MISMATCH');
    }
  }

  const identity = identityFromManifest(manifest);
  if (aggregateDigest(identity, manifest.files) !== manifest.artifactSha256) {
    fail('CNYOS_PRODUCER_ARTIFACT_DIGEST_MISMATCH');
  }
  return Object.freeze({ bundleDirectory, manifestPath, manifestBytes, manifestSha256, manifest });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  verifyProducerBundle().then(result => {
    process.stdout.write(`${JSON.stringify({
      manifestSha256: result.manifestSha256,
      artifactSha256: result.manifest.artifactSha256,
      candidateCommit: result.manifest.candidateCommit,
      candidateTree: result.manifest.candidateTree,
      functionSourceTree: result.manifest.functionSourceTree
    })}\n`);
  }).catch(error => {
    process.stderr.write(`${String(error?.message || 'CNYOS_PRODUCER_BUNDLE_VERIFICATION_FAILED')}\n`);
    process.exitCode = 1;
  });
}
