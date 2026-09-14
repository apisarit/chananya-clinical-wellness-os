import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { readFunctionInputsFromGit } from './materialize-staging-functions.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha40 = /^[0-9a-f]{40}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const netlifyDeployId = /^[0-9a-f]{24}$/;
const githubRunId = /^[1-9][0-9]{0,19}$/;
const placeholder = /^(?:replace|placeholder|todo\b|tbd\b|<.*>|\{\{.*\}\})/i;
const githubLogin = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const safeIdentifier = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/;
const promotionPr = /^https:\/\/github\.com\/apisarit\/chananya-clinical-wellness-os\/pull\/(\d+)$/;
const actionsRun = /^https:\/\/github\.com\/apisarit\/chananya-clinical-wellness-os\/actions\/runs\/(\d+)$/;
const approverRoles = new Set([
  'independent_security_reviewer',
  'managed_platform_risk_owner'
]);

const CONTROLLER_NONCE_PREFIX = 'cnyos-staging-v1.';
export const CNYOS_STAGING_RELEASE_AUTHORIZATION_MAX_AGE_MS = 30 * 60 * 1000;
export const CNYOS_STAGING_DATABASE_EVIDENCE_MAX_AGE_MS = 30 * 60 * 1000;

export const CNYOS_STAGING_RELEASE_CONTROLLER = Object.freeze({
  repository: 'apisarit/cnyos-staging-deployment-control',
  workflowPath: '.github/workflows/cnyos-staging-release.yml',
  workflowRef: 'refs/heads/main',
  eventName: 'workflow_dispatch'
});

export const CNYOS_STAGING_RELEASE_TARGET = Object.freeze({
  supabaseProjectRef: 'hsmnjwxurlmsizndjlun',
  databaseSystemIdentifier: '7666007964130682852',
  netlifySiteId: '7da5e39e-580d-44f1-8623-605313e2fb2b',
  netlifyOrigin: 'https://cnyos.netlify.app',
  deploymentId: 'chananya-clinical-staging',
  clinicId: '00000000-0000-4000-8000-00000000a001',
  clinicCode: 'CHANANYA-STG'
});

export const CNYOS_ACL_CANDIDATE_SHA256 =
  '2f374ca556a1f98f46ec179b2e8143d56c7f900d7d1812e2dc7f5e23439e4acf';

export const REQUIRED_SECURITY_REVIEW_AREAS = Object.freeze([
  'trigger_function_and_browser_rpc_acl_revocation',
  'verification_sql_enforced_read_only_transaction',
  'atomic_failure_and_rollback_behavior'
]);

function fail(code) {
  throw new Error(code);
}

function assertExactKeys(value, expected, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length ||
    actual.some((item, index) => item !== wanted[index])) fail(code);
}

function text(value) {
  return typeof value === 'string' && value.trim().length > 0 &&
    value.trim().length <= 500 && !placeholder.test(value.trim());
}

function exactText(value, expected) {
  return typeof value === 'string' && value === expected;
}

function sha256(value) {
  return typeof value === 'string' && sha256Pattern.test(value);
}

function timestamp(value) {
  return text(value) && Number.isFinite(Date.parse(value));
}

function requireTimestamp(value, code) {
  if (!timestamp(value)) fail(code);
  return new Date(value);
}

function requireCanonicalTimestamp(value, code) {
  const parsed = requireTimestamp(value, code);
  if (parsed.toISOString() !== value) fail(code);
  return parsed;
}

function requireRecentCanonicalTimestamp(value, now, code) {
  const parsed = requireCanonicalTimestamp(value, code);
  const age = now.getTime() - parsed.getTime();
  if (age < 0 || age > CNYOS_STAGING_DATABASE_EVIDENCE_MAX_AGE_MS) fail(code);
  return parsed;
}

function requireEvidenceHash(value, code) {
  if (!sha256(value)) fail(code);
}

function digestSha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function validateControllerNonce(value) {
  const nonce = String(value || '');
  if (!nonce.startsWith(CONTROLLER_NONCE_PREFIX)) {
    fail('CNYOS_STAGING_RELEASE_CONTROLLER_NONCE_INVALID');
  }
  const encoded = nonce.slice(CONTROLLER_NONCE_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) {
    fail('CNYOS_STAGING_RELEASE_CONTROLLER_NONCE_INVALID');
  }
  let bytes;
  try { bytes = Buffer.from(encoded, 'base64url'); }
  catch { fail('CNYOS_STAGING_RELEASE_CONTROLLER_NONCE_INVALID'); }
  if (bytes.length !== 32 || bytes.toString('base64url') !== encoded ||
    bytes.every(byte => byte === 0)) {
    fail('CNYOS_STAGING_RELEASE_CONTROLLER_NONCE_INVALID');
  }
  return nonce;
}

function validateController(controller, now) {
  if (!controller || typeof controller !== 'object' || Array.isArray(controller) ||
    controller.repository !== CNYOS_STAGING_RELEASE_CONTROLLER.repository ||
    controller.workflowPath !== CNYOS_STAGING_RELEASE_CONTROLLER.workflowPath ||
    controller.workflowRef !== CNYOS_STAGING_RELEASE_CONTROLLER.workflowRef ||
    controller.eventName !== CNYOS_STAGING_RELEASE_CONTROLLER.eventName ||
    !sha40.test(String(controller.workflowCommit || '')) ||
    !githubRunId.test(String(controller.runId || '')) ||
    controller.runAttempt !== 1 ||
    !netlifyDeployId.test(String(controller.rollbackBaselineDeployId || '')) ||
    !sha256(controller.staticArtifactSha256) ||
    !sha256(controller.runtimeManifestSha256) ||
    !sha256(controller.functionInputManifestSha256) ||
    !sha256(controller.functionInputTreeSha256)) {
    fail('CNYOS_STAGING_RELEASE_CONTROLLER_INVALID');
  }
  const nonce = validateControllerNonce(controller.nonce);
  const issuedAt = requireCanonicalTimestamp(
    controller.issuedAt,
    'CNYOS_STAGING_RELEASE_CONTROLLER_DATE_INVALID'
  );
  const expiresAt = requireCanonicalTimestamp(
    controller.expiresAt,
    'CNYOS_STAGING_RELEASE_CONTROLLER_DATE_INVALID'
  );
  const lifetime = expiresAt.getTime() - issuedAt.getTime();
  const age = now.getTime() - issuedAt.getTime();
  if (issuedAt > now || expiresAt <= now || lifetime <= 0 ||
    lifetime > CNYOS_STAGING_RELEASE_AUTHORIZATION_MAX_AGE_MS ||
    age > CNYOS_STAGING_RELEASE_AUTHORIZATION_MAX_AGE_MS) {
    fail('CNYOS_STAGING_RELEASE_CONTROLLER_EXPIRED');
  }
  return Object.freeze({ nonce, issuedAt, expiresAt });
}

function parseObject(raw) {
  if (!String(raw || '').trim()) fail('CNYOS_STAGING_RELEASE_ATTESTATION_JSON_REQUIRED');
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { fail('CNYOS_STAGING_RELEASE_ATTESTATION_JSON_INVALID'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('CNYOS_STAGING_RELEASE_ATTESTATION_JSON_INVALID');
  }
  return parsed;
}

export function parseStagingReleaseAttestation(raw) {
  return parseObject(raw);
}

function decodeSignature(value) {
  const encoded = String(value || '').trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) fail('CNYOS_STAGING_RELEASE_SIGNATURE_INVALID');
  const signature = Buffer.from(encoded, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== encoded) {
    fail('CNYOS_STAGING_RELEASE_SIGNATURE_INVALID');
  }
  return signature;
}

function validatePinnedKeyRecord(record) {
  assertExactKeys(record, [
    'id', 'role', 'githubLogin', 'ownerName', 'publicKeyPem', 'spkiSha256'
  ], 'CNYOS_STAGING_RELEASE_APPROVER_REGISTRY_INVALID');
  if (!safeIdentifier.test(String(record.id || '')) ||
    !approverRoles.has(record.role) ||
    !githubLogin.test(String(record.githubLogin || '')) ||
    !text(record.ownerName) ||
    !sha256(record.spkiSha256) ||
    typeof record.publicKeyPem !== 'string' || record.publicKeyPem.length > 1024 ||
    !record.publicKeyPem.startsWith('-----BEGIN PUBLIC KEY-----\n') ||
    !record.publicKeyPem.endsWith('-----END PUBLIC KEY-----\n')) {
    fail('CNYOS_STAGING_RELEASE_APPROVER_REGISTRY_INVALID');
  }
  let publicKey;
  try { publicKey = crypto.createPublicKey(record.publicKeyPem); }
  catch { fail('CNYOS_STAGING_RELEASE_APPROVER_REGISTRY_INVALID'); }
  if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') {
    fail('CNYOS_STAGING_RELEASE_APPROVER_REGISTRY_INVALID');
  }
  const canonicalPublicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  if (typeof canonicalPublicKeyPem !== 'string' || record.publicKeyPem !== canonicalPublicKeyPem) {
    fail('CNYOS_STAGING_RELEASE_APPROVER_REGISTRY_INVALID');
  }
  const fingerprint = crypto.createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex');
  if (fingerprint !== record.spkiSha256) {
    fail('CNYOS_STAGING_RELEASE_APPROVER_KEY_FINGERPRINT_MISMATCH');
  }
  return Object.freeze({ record, publicKey });
}

function loadPinnedKey(registry, keyId, role, githubAccount) {
  assertExactKeys(
    registry,
    ['schemaVersion', 'environment', 'keys'],
    'CNYOS_STAGING_RELEASE_APPROVER_REGISTRY_INVALID'
  );
  if (registry.schemaVersion !== 1 || registry.environment !== 'cnyos-staging' ||
    !Array.isArray(registry.keys)) {
    fail('CNYOS_STAGING_RELEASE_APPROVER_REGISTRY_INVALID');
  }
  const validatedRecords = registry.keys.map(validatePinnedKeyRecord);
  const ids = validatedRecords.map(item => item.record.id);
  if (new Set(ids).size !== ids.length) fail('CNYOS_STAGING_RELEASE_APPROVER_REGISTRY_INVALID');
  const fingerprints = validatedRecords.map(item => item.record.spkiSha256);
  if (new Set(fingerprints).size !== fingerprints.length) {
    fail('CNYOS_STAGING_RELEASE_APPROVER_REGISTRY_INVALID');
  }
  const selected = validatedRecords.find(item => item.record.id === keyId);
  const record = selected?.record;
  if (!record || record.role !== role ||
    record.githubLogin.toLowerCase() !== String(githubAccount || '').toLowerCase()) {
    fail('CNYOS_STAGING_RELEASE_APPROVER_KEY_NOT_PINNED');
  }
  return selected;
}

export function validateStagingReleaseSignatures(raw, attestation, signatures, registry) {
  if (!String(raw || '').trim()) fail('CNYOS_STAGING_RELEASE_SIGNATURE_REQUIRED');
  const reviewerKeyId = attestation?.signatureKeyIds?.independentSecurityReviewer;
  const riskOwnerKeyId = attestation?.signatureKeyIds?.managedPlatformRiskOwner;
  if (!safeIdentifier.test(String(reviewerKeyId || '')) ||
    !safeIdentifier.test(String(riskOwnerKeyId || '')) || reviewerKeyId === riskOwnerKeyId) {
    fail('CNYOS_STAGING_RELEASE_SIGNATURE_KEY_IDS_INVALID');
  }
  const reviewer = loadPinnedKey(
    registry,
    reviewerKeyId,
    'independent_security_reviewer',
    attestation?.independentSecurityReview?.reviewerGitHubLogin
  );
  const riskOwner = loadPinnedKey(
    registry,
    riskOwnerKeyId,
    'managed_platform_risk_owner',
    attestation?.managedPlatformException?.ownerGitHubLogin
  );
  if (reviewer.record.spkiSha256 === riskOwner.record.spkiSha256) {
    fail('CNYOS_STAGING_RELEASE_SIGNATURE_KEYS_NOT_INDEPENDENT');
  }
  const reviewerSignature = decodeSignature(signatures?.independentSecurityReviewer);
  const riskOwnerSignature = decodeSignature(signatures?.managedPlatformRiskOwner);
  if (!crypto.verify(null, Buffer.from(raw), reviewer.publicKey, reviewerSignature) ||
    !crypto.verify(null, Buffer.from(raw), riskOwner.publicKey, riskOwnerSignature)) {
    fail('CNYOS_STAGING_RELEASE_SIGNATURE_INVALID');
  }
  return Object.freeze({
    reviewerKeyId,
    riskOwnerKeyId,
    reviewerSignature,
    riskOwnerSignature
  });
}

function validateSource(attestation, expectedCommit, expectedTree) {
  if (!sha40.test(expectedCommit) || !sha40.test(expectedTree) ||
    attestation?.source?.commit !== expectedCommit || attestation?.source?.tree !== expectedTree) {
    fail('CNYOS_STAGING_RELEASE_SOURCE_MISMATCH');
  }
  if (attestation?.aclCandidateSha256 !== CNYOS_ACL_CANDIDATE_SHA256) {
    fail('CNYOS_STAGING_ACL_CANDIDATE_MISMATCH');
  }
}

function validateExactHeadCi(ci, expectedCommit, expectedTree, now) {
  const completedAt = requireTimestamp(ci?.completedAt, 'CNYOS_STAGING_EXACT_HEAD_CI_INVALID');
  if (ci?.status !== 'passed' || ci?.conclusion !== 'success' ||
    ci?.sourceCommit !== expectedCommit || ci?.sourceTree !== expectedTree ||
    ci?.postgresMajor !== 17 || ci?.unresolvedBlockers !== 0 ||
    !text(ci?.workflowName) || !actionsRun.test(String(ci?.runUrl || '')) ||
    completedAt > now || !text(ci?.evidenceReference)) {
    fail('CNYOS_STAGING_EXACT_HEAD_CI_INVALID');
  }
  requireEvidenceHash(ci.evidenceSha256, 'CNYOS_STAGING_EXACT_HEAD_CI_INVALID');
}

function validateTarget(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    fail('CNYOS_STAGING_RELEASE_TARGET_MISMATCH');
  }
  for (const [key, expected] of Object.entries(CNYOS_STAGING_RELEASE_TARGET)) {
    if (!exactText(target[key], expected)) fail('CNYOS_STAGING_RELEASE_TARGET_MISMATCH');
  }
}

function validateSecurityReview(review, expectedCommit, expectedTree, now) {
  if (review?.status !== 'passed' || review?.verdict !== 'approved' ||
    review?.sourceCommit !== expectedCommit || review?.sourceTree !== expectedTree ||
    review?.candidateSha256 !== CNYOS_ACL_CANDIDATE_SHA256 ||
    !text(review?.reviewerName) || !text(review?.reviewerRole) ||
    !githubLogin.test(String(review?.reviewerGitHubLogin || ''))) {
    fail('CNYOS_STAGING_INDEPENDENT_SECURITY_REVIEW_INVALID');
  }
  const reviewedAt = requireTimestamp(
    review.reviewedAt,
    'CNYOS_STAGING_INDEPENDENT_SECURITY_REVIEW_INVALID'
  );
  if (reviewedAt > now || !text(review.evidenceReference)) {
    fail('CNYOS_STAGING_INDEPENDENT_SECURITY_REVIEW_INVALID');
  }
  requireEvidenceHash(review.evidenceSha256, 'CNYOS_STAGING_INDEPENDENT_SECURITY_REVIEW_INVALID');
  const areas = review.areas;
  if (!Array.isArray(areas) || areas.length !== REQUIRED_SECURITY_REVIEW_AREAS.length ||
    !areas.every((area, index) => area?.id === REQUIRED_SECURITY_REVIEW_AREAS[index] &&
      area?.verdict === 'passed' && text(area?.findingDisposition))) {
    fail('CNYOS_STAGING_INDEPENDENT_SECURITY_REVIEW_AREAS_INCOMPLETE');
  }
}

function validateManagedException(exception, now) {
  if (exception?.status !== 'accepted' ||
    !text(exception?.ownerName) || !text(exception?.ownerRole) ||
    !githubLogin.test(String(exception?.ownerGitHubLogin || '')) ||
    exception?.projectRef !== CNYOS_STAGING_RELEASE_TARGET.supabaseProjectRef ||
    exception?.databaseSystemIdentifier !== CNYOS_STAGING_RELEASE_TARGET.databaseSystemIdentifier ||
    exception?.scope !== 'supabase_admin function defaults for public only' ||
    exception?.blockOnAnyReviewedDrift !== true ||
    !text(exception?.rationale) || !text(exception?.driftCheckOwner) ||
    !text(exception?.providerEscalationReference)) {
    fail('CNYOS_STAGING_MANAGED_PLATFORM_EXCEPTION_INVALID');
  }
  const ownership = exception.currentPublicOwnership;
  if (ownership?.routines !== 0 || ownership?.relations !== 0 || ownership?.types !== 0) {
    fail('CNYOS_STAGING_MANAGED_PLATFORM_OWNERSHIP_NOT_ZERO');
  }
  requireEvidenceHash(ownership?.evidenceSha256, 'CNYOS_STAGING_MANAGED_PLATFORM_EXCEPTION_INVALID');
  if (!text(ownership?.evidenceReference)) {
    fail('CNYOS_STAGING_MANAGED_PLATFORM_EXCEPTION_INVALID');
  }
  if (exception.runtimeSetRole?.runtimeAndUntrustedCannotSetRoleToReviewedCreators !== true) {
    fail('CNYOS_STAGING_MANAGED_PLATFORM_SET_ROLE_NOT_PROVED');
  }
  requireEvidenceHash(
    exception.runtimeSetRole?.evidenceSha256,
    'CNYOS_STAGING_MANAGED_PLATFORM_EXCEPTION_INVALID'
  );
  if (!text(exception.runtimeSetRole?.evidenceReference)) {
    fail('CNYOS_STAGING_MANAGED_PLATFORM_EXCEPTION_INVALID');
  }
  const acceptedAt = requireTimestamp(
    exception.acceptedAt,
    'CNYOS_STAGING_MANAGED_PLATFORM_EXCEPTION_DATE_INVALID'
  );
  const nextReviewAt = requireTimestamp(
    exception.nextReviewAt,
    'CNYOS_STAGING_MANAGED_PLATFORM_EXCEPTION_DATE_INVALID'
  );
  const expiresAt = requireTimestamp(
    exception.expiresAt,
    'CNYOS_STAGING_MANAGED_PLATFORM_EXCEPTION_DATE_INVALID'
  );
  if (acceptedAt > now || acceptedAt > nextReviewAt || nextReviewAt > expiresAt ||
    now > nextReviewAt || now > expiresAt) {
    fail('CNYOS_STAGING_MANAGED_PLATFORM_EXCEPTION_EXPIRED');
  }
}

function validateRollbackEvidence(rehearsal, expectedCommit, now) {
  const completedAt = requireRecentCanonicalTimestamp(
    rehearsal?.completedAt,
    now,
    'CNYOS_STAGING_ROLLBACK_REHEARSAL_STALE'
  );
  const observerAt = requireRecentCanonicalTimestamp(
    rehearsal?.freshPostObserver?.observedAt,
    now,
    'CNYOS_STAGING_ROLLBACK_REHEARSAL_STALE'
  );
  if (rehearsal?.status !== 'passed' || rehearsal?.sourceCommit !== expectedCommit ||
    rehearsal?.maintenanceWindowStatus !== 'completed' ||
    !text(rehearsal?.maintenanceWindowReference) ||
    rehearsal?.quiescenceVerified !== true ||
    rehearsal?.normalRollback?.status !== 'passed' ||
    rehearsal?.normalRollback?.receipt !== 'ACL_CATALOG_ROLLBACK_VERIFIED' ||
    rehearsal?.injectedFailure?.status !== 'passed' ||
    rehearsal?.injectedFailure?.exitWasNonzero !== true ||
    rehearsal?.injectedFailure?.postStateEqual !== true ||
    rehearsal?.freshPostObserver?.status !== 'passed' ||
    rehearsal?.freshPostObserver?.datasetCount !== 25 ||
    rehearsal?.freshPostObserver?.publicRoutineCount !== 147 ||
    rehearsal?.freshPostObserver?.securityDefinerCount !== 141 ||
    rehearsal?.freshPostObserver?.triggerCount !== 173 ||
    rehearsal?.freshPostObserver?.eventTriggerCount !== 7 || observerAt < completedAt) {
    fail('CNYOS_STAGING_ROLLBACK_REHEARSAL_INVALID');
  }
  for (const value of [
    rehearsal.quiescenceEvidenceSha256,
    rehearsal.normalRollback?.evidenceSha256,
    rehearsal.injectedFailure?.evidenceSha256,
    rehearsal.freshPostObserver?.evidenceSha256
  ]) requireEvidenceHash(value, 'CNYOS_STAGING_ROLLBACK_REHEARSAL_INVALID');
  for (const value of [
    rehearsal.quiescenceEvidenceReference,
    rehearsal.normalRollback?.evidenceReference,
    rehearsal.injectedFailure?.evidenceReference,
    rehearsal.freshPostObserver?.evidenceReference
  ]) if (!text(value)) fail('CNYOS_STAGING_ROLLBACK_REHEARSAL_INVALID');
}

function validateMigrationPromotion(promotion, expectedCommit) {
  const prMatch = String(promotion?.promotionPullRequest || '').match(promotionPr);
  if (promotion?.status !== 'passed' || !prMatch || Number(prMatch[1]) === 36 ||
    promotion?.pr36RemainsDraftAndUnapproved !== true ||
    promotion?.orderedMigrationChainAppliedToChananyaStaging !== true ||
    promotion?.preDeploymentAuthenticatedRegressionStatus !== 'passed' ||
    promotion?.releaseCandidateCommit !== expectedCommit ||
    promotion?.chananyaLedger?.status !== 'reconciled' ||
    promotion?.jitarsaLedger?.status !== 'independently_reconciled') {
    fail('CNYOS_STAGING_MIGRATION_PROMOTION_INVALID');
  }
  for (const value of [
    promotion.chananyaLedger?.evidenceSha256,
    promotion.jitarsaLedger?.evidenceSha256,
    promotion.migrationApplyEvidenceSha256,
    promotion.preDeploymentAuthenticatedRegressionEvidenceSha256
  ]) requireEvidenceHash(value, 'CNYOS_STAGING_MIGRATION_PROMOTION_INVALID');
  for (const value of [
    promotion.chananyaLedger?.evidenceReference,
    promotion.jitarsaLedger?.evidenceReference,
    promotion.migrationApplyEvidenceReference,
    promotion.preDeploymentAuthenticatedRegressionEvidenceReference
  ]) if (!text(value)) fail('CNYOS_STAGING_MIGRATION_PROMOTION_INVALID');
}

function validateStrictPostRemediation(strict, expectedCommit, expectedTree, now) {
  const verifiedAt = requireRecentCanonicalTimestamp(
    strict?.verifiedAt,
    now,
    'CNYOS_STAGING_STRICT_POST_REMEDIATION_INVALID'
  );
  if (strict?.status !== 'passed' || strict?.sourceCommit !== expectedCommit ||
    strict?.sourceTree !== expectedTree ||
    strict?.projectRef !== CNYOS_STAGING_RELEASE_TARGET.supabaseProjectRef ||
    strict?.databaseSystemIdentifier !== CNYOS_STAGING_RELEASE_TARGET.databaseSystemIdentifier ||
    strict?.durableAclRemediationApplied !== true ||
    strict?.verificationSql?.status !== 'passed' ||
    strict?.verificationSql?.readOnlyEnforced !== true ||
    strict?.securityAdvisor?.status !== 'passed' ||
    strict?.securityAdvisor?.unresolvedErrors !== 0 ||
    strict?.negativeBrowserRpcChecks?.status !== 'passed' ||
    strict?.crossTenantChecks?.status !== 'passed' ||
    strict?.unresolvedBlockers !== 0 || verifiedAt > now) {
    fail('CNYOS_STAGING_STRICT_POST_REMEDIATION_INVALID');
  }
  for (const item of [
    strict.verificationSql,
    strict.securityAdvisor,
    strict.negativeBrowserRpcChecks,
    strict.crossTenantChecks
  ]) {
    requireEvidenceHash(item?.evidenceSha256, 'CNYOS_STAGING_STRICT_POST_REMEDIATION_INVALID');
    if (!text(item?.evidenceReference)) fail('CNYOS_STAGING_STRICT_POST_REMEDIATION_INVALID');
  }
}

export function validateStagingReleaseAttestation(
  attestation,
  expectedCommit,
  expectedTree,
  { now = new Date() } = {}
) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) fail('CNYOS_STAGING_RELEASE_TIME_INVALID');
  if (attestation?.schemaVersion !== 2 ||
    attestation?.evidenceType !== 'cnyos_staging_release_authorization' ||
    attestation?.authorizedForStagingDeployment !== true ||
    attestation?.productionAuthorization !== false ||
    attestation?.realPatientDataAuthorized !== false ||
    !safeIdentifier.test(String(attestation?.signatureKeyIds?.independentSecurityReviewer || '')) ||
    !safeIdentifier.test(String(attestation?.signatureKeyIds?.managedPlatformRiskOwner || ''))) {
    fail('CNYOS_STAGING_RELEASE_ATTESTATION_INVALID');
  }
  const controller = validateController(attestation.controller, now);
  validateSource(attestation, expectedCommit, expectedTree);
  validateTarget(attestation.target);
  validateExactHeadCi(attestation.exactHeadCi, expectedCommit, expectedTree, now);
  validateSecurityReview(attestation.independentSecurityReview, expectedCommit, expectedTree, now);
  validateManagedException(attestation.managedPlatformException, now);
  validateRollbackEvidence(attestation.rollbackRehearsal, expectedCommit, now);
  validateMigrationPromotion(attestation.migrationPromotion, expectedCommit);
  validateStrictPostRemediation(
    attestation.strictPostRemediation,
    expectedCommit,
    expectedTree,
    now
  );

  const authorization = attestation.authorization;
  if (authorization?.decision !== 'authorize_cnyos_staging_deployment' ||
    !text(authorization?.reference) || !text(authorization?.authorizedByName) ||
    !text(authorization?.authorizedByRole) ||
    !githubLogin.test(String(authorization?.authorizedByGitHubLogin || ''))) {
    fail('CNYOS_STAGING_RELEASE_AUTHORIZATION_INVALID');
  }
  const authorizedAt = requireCanonicalTimestamp(
    authorization.authorizedAt,
    'CNYOS_STAGING_RELEASE_AUTHORIZATION_DATE_INVALID'
  );
  const expiresAt = requireCanonicalTimestamp(
    authorization.expiresAt,
    'CNYOS_STAGING_RELEASE_AUTHORIZATION_DATE_INVALID'
  );
  if (authorizedAt.getTime() !== controller.issuedAt.getTime() ||
    expiresAt.getTime() !== controller.expiresAt.getTime() ||
    authorizedAt > now || authorizedAt >= expiresAt || now >= expiresAt ||
    expiresAt.getTime() - authorizedAt.getTime() >
      CNYOS_STAGING_RELEASE_AUTHORIZATION_MAX_AGE_MS ||
    now.getTime() - authorizedAt.getTime() >
      CNYOS_STAGING_RELEASE_AUTHORIZATION_MAX_AGE_MS) {
    fail('CNYOS_STAGING_RELEASE_AUTHORIZATION_EXPIRED');
  }
  if (attestation.independentSecurityReview.reviewerGitHubLogin.toLowerCase() ===
      attestation.managedPlatformException.ownerGitHubLogin.toLowerCase()) {
    fail('CNYOS_STAGING_INDEPENDENT_REVIEWER_CONFLICT');
  }
  if (authorization.authorizedByGitHubLogin.toLowerCase() !==
      attestation.managedPlatformException.ownerGitHubLogin.toLowerCase()) {
    fail('CNYOS_STAGING_RISK_OWNER_AUTHORIZATION_MISMATCH');
  }
  return true;
}

function requiredEnv(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) fail(`${name}_REQUIRED`);
  return value;
}

function gitRunner(cwd) {
  const isolated = { ...process.env };
  for (const name of Object.keys(isolated)) {
    if (name.startsWith('GIT_')) delete isolated[name];
  }
  isolated.GIT_CONFIG_NOSYSTEM = '1';
  isolated.GIT_CONFIG_GLOBAL = '/dev/null';
  isolated.GIT_OPTIONAL_LOCKS = '0';
  isolated.LC_ALL = 'C';
  return (args, { encoding = 'utf8' } = {}) => {
    const output = execFileSync('git', ['--no-replace-objects', ...args], {
      cwd,
      encoding,
      env: isolated,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return encoding === 'buffer' ? output : output.trim();
  };
}

function utf8PathOrder(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

export function computeStaticArtifactDigests(cwd = root) {
  const dist = path.join(cwd, 'dist');
  let entries;
  try { entries = fs.readdirSync(dist, { withFileTypes: true }); }
  catch { fail('CNYOS_STAGING_RELEASE_STATIC_ARTIFACT_MISSING'); }
  if (entries.length < 1 || entries.length > 1024 ||
    !entries.every(entry => entry.isFile() &&
      /^(?:_[a-z]+|[A-Za-z0-9][A-Za-z0-9._-]*)$/.test(entry.name))) {
    fail('CNYOS_STAGING_RELEASE_STATIC_ARTIFACT_INVALID');
  }
  const names = entries.map(entry => entry.name).sort(utf8PathOrder);
  if (new Set(names).size !== names.length || !names.includes('runtime-publish-manifest.json')) {
    fail('CNYOS_STAGING_RELEASE_STATIC_ARTIFACT_INVALID');
  }
  const files = new Map();
  let totalBytes = 0;
  for (const name of names) {
    let content;
    try { content = fs.readFileSync(path.join(dist, name)); }
    catch { fail('CNYOS_STAGING_RELEASE_STATIC_ARTIFACT_INVALID'); }
    totalBytes += content.byteLength;
    if (content.byteLength > 64 * 1024 * 1024 || totalBytes > 512 * 1024 * 1024) {
      fail('CNYOS_STAGING_RELEASE_STATIC_ARTIFACT_INVALID');
    }
    files.set(name, content);
  }
  const runtimeBytes = files.get('runtime-publish-manifest.json');
  let runtime;
  try { runtime = JSON.parse(runtimeBytes.toString('utf8')); }
  catch { fail('CNYOS_STAGING_RELEASE_RUNTIME_MANIFEST_INVALID'); }
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime) ||
    runtime.schemaVersion !== 2 || runtime.integrityAlgorithm !== 'sha256' ||
    !Number.isSafeInteger(runtime.fileCount) || runtime.fileCount < 1 ||
    !Array.isArray(runtime.files) || !Array.isArray(runtime.integrity) ||
    runtime.fileCount !== runtime.files.length || runtime.integrity.length !== runtime.files.length ||
    !runtime.files.every(name => typeof name === 'string' &&
      /^(?:_[a-z]+|[A-Za-z0-9][A-Za-z0-9._-]*)$/.test(name))) {
    fail('CNYOS_STAGING_RELEASE_RUNTIME_MANIFEST_INVALID');
  }
  const sortedRuntimeFiles = [...runtime.files].sort(utf8PathOrder);
  const expectedNames = [...runtime.files, 'runtime-publish-manifest.json'].sort(utf8PathOrder);
  if (new Set(runtime.files).size !== runtime.files.length ||
    !runtime.files.every((name, index) => name === sortedRuntimeFiles[index]) ||
    expectedNames.length !== names.length ||
    !expectedNames.every((name, index) => name === names[index])) {
    fail('CNYOS_STAGING_RELEASE_RUNTIME_MANIFEST_INVALID');
  }
  for (const [index, name] of runtime.files.entries()) {
    const content = files.get(name);
    const declared = runtime.integrity[index];
    if (!content || !declared || typeof declared !== 'object' || Array.isArray(declared) ||
      declared.path !== name || declared.size !== content.byteLength ||
      declared.sha256 !== digestSha256(content)) {
      fail('CNYOS_STAGING_RELEASE_RUNTIME_MANIFEST_INVALID');
    }
  }
  const aggregate = names.map(name => {
    const content = files.get(name);
    return { path: name, size: content.byteLength, sha256: digestSha256(content) };
  });
  return Object.freeze({
    staticArtifactSha256: digestSha256(JSON.stringify(aggregate)),
    runtimeManifestSha256: digestSha256(runtimeBytes)
  });
}

export function computeFunctionInputDigests(cwd = root) {
  const inputs = readFunctionInputsFromGit({
    cwd,
    ref: 'HEAD',
    sourcePath: 'netlify/functions'
  });
  return Object.freeze({
    functionInputManifestSha256: inputs.manifestSha256,
    functionInputTreeSha256: inputs.treeSha256
  });
}

function validateGitHubController(env, controller) {
  const expected = CNYOS_STAGING_RELEASE_CONTROLLER;
  const workflowRef = `${expected.repository}/${expected.workflowPath}@${expected.workflowRef}`;
  if (requiredEnv(env, 'GITHUB_REPOSITORY') !== expected.repository ||
    requiredEnv(env, 'GITHUB_EVENT_NAME') !== expected.eventName ||
    requiredEnv(env, 'GITHUB_WORKFLOW_REF') !== workflowRef ||
    requiredEnv(env, 'GITHUB_REF') !== expected.workflowRef ||
    requiredEnv(env, 'GITHUB_REF_TYPE') !== 'branch' ||
    requiredEnv(env, 'GITHUB_REF_PROTECTED') !== 'true' ||
    requiredEnv(env, 'GITHUB_WORKFLOW_SHA').toLowerCase() !== controller.workflowCommit ||
    requiredEnv(env, 'GITHUB_SHA').toLowerCase() !== controller.workflowCommit ||
    requiredEnv(env, 'GITHUB_RUN_ID') !== controller.runId ||
    requiredEnv(env, 'GITHUB_RUN_ATTEMPT') !== String(controller.runAttempt)) {
    fail('CNYOS_STAGING_RELEASE_CONTROLLER_MISMATCH');
  }
}

function writeEvidence(destination, value) {
  const output = path.resolve(destination);
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  fs.writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(output, 0o600);
  return output;
}

export function verifyStagingReleaseAuthorization({
  env = process.env,
  cwd = root,
  gitImpl = null,
  candidateBytesImpl = null,
  staticArtifactDigestsImpl = null,
  functionInputDigestsImpl = null,
  approverRegistryImpl = null,
  now = () => new Date()
} = {}) {
  const git = gitImpl || gitRunner(cwd);
  const head = String(git(['rev-parse', 'HEAD']) || '').trim().toLowerCase();
  const tree = String(git(['rev-parse', 'HEAD^{tree}']) || '').trim().toLowerCase();
  const status = String(git(['status', '--porcelain=v1', '--untracked-files=all']) || '').trim();
  const expectedCommit = requiredEnv(env, 'EXPECTED_STAGING_SOURCE_COMMIT').toLowerCase();
  const expectedTree = requiredEnv(env, 'CLINICAL_OS_SOURCE_TREE').toLowerCase();
  if (!sha40.test(head) || !sha40.test(tree) || head !== expectedCommit || tree !== expectedTree) {
    fail('CNYOS_STAGING_RELEASE_CHECKOUT_MISMATCH');
  }
  if (status) fail('CNYOS_STAGING_RELEASE_CHECKOUT_NOT_CLEAN');
  if (String(env.GITHUB_RUN_ATTEMPT || '') !== '1' ||
    requiredEnv(env, 'GITHUB_ACTOR').toLowerCase() !==
      requiredEnv(env, 'GITHUB_TRIGGERING_ACTOR').toLowerCase()) {
    fail('CNYOS_STAGING_RELEASE_REPLAY_NOT_ALLOWED');
  }
  const raw = requiredEnv(env, 'CNYOS_STAGING_RELEASE_ATTESTATION_JSON');
  const attestation = parseStagingReleaseAttestation(raw);
  let approverRegistry;
  let approverRegistryRaw;
  try {
    const suppliedRegistry = approverRegistryImpl
      ? approverRegistryImpl()
      : requiredEnv(env, 'CNYOS_STAGING_RELEASE_APPROVER_KEY_REGISTRY_JSON');
    approverRegistryRaw = typeof suppliedRegistry === 'string'
      ? suppliedRegistry
      : JSON.stringify(suppliedRegistry);
    approverRegistry = typeof suppliedRegistry === 'string'
      ? JSON.parse(suppliedRegistry)
      : suppliedRegistry;
  } catch {
    fail('CNYOS_STAGING_RELEASE_APPROVER_REGISTRY_INVALID');
  }
  const verifiedSignatures = validateStagingReleaseSignatures(
    raw,
    attestation,
    {
      independentSecurityReviewer: requiredEnv(
        env,
        'CNYOS_STAGING_SECURITY_REVIEW_SIGNATURE_BASE64'
      ),
      managedPlatformRiskOwner: requiredEnv(
        env,
        'CNYOS_STAGING_RISK_OWNER_SIGNATURE_BASE64'
      )
    },
    approverRegistry
  );
  const verifiedAt = now();
  validateStagingReleaseAttestation(attestation, expectedCommit, expectedTree, { now: verifiedAt });
  validateGitHubController(env, attestation.controller);
  const actor = requiredEnv(env, 'GITHUB_ACTOR');
  if (actor.toLowerCase() !== attestation.managedPlatformException.ownerGitHubLogin.toLowerCase() ||
    actor.toLowerCase() !== attestation.authorization.authorizedByGitHubLogin.toLowerCase()) {
    fail('CNYOS_STAGING_RELEASE_ACTOR_NOT_NAMED_RISK_OWNER');
  }
  let candidateBytes;
  try {
    candidateBytes = candidateBytesImpl
      ? candidateBytesImpl()
      : fs.readFileSync(path.join(
        cwd,
        'supabase/manual/202609080900_close_complete_public_routine_acl_candidate.sql'
      ));
  } catch {
    fail('CNYOS_STAGING_ACL_CANDIDATE_MISSING');
  }
  if (crypto.createHash('sha256').update(candidateBytes).digest('hex') !== CNYOS_ACL_CANDIDATE_SHA256) {
    fail('CNYOS_STAGING_ACL_CANDIDATE_MISMATCH');
  }
  const staticDigests = staticArtifactDigestsImpl
    ? staticArtifactDigestsImpl()
    : computeStaticArtifactDigests(cwd);
  if (staticDigests?.staticArtifactSha256 !== attestation.controller.staticArtifactSha256 ||
    staticDigests?.runtimeManifestSha256 !== attestation.controller.runtimeManifestSha256) {
    fail('CNYOS_STAGING_RELEASE_STATIC_ARTIFACT_DIGEST_MISMATCH');
  }
  const functionDigests = functionInputDigestsImpl
    ? functionInputDigestsImpl()
    : computeFunctionInputDigests(cwd);
  if (functionDigests?.functionInputManifestSha256 !==
      attestation.controller.functionInputManifestSha256 ||
    functionDigests?.functionInputTreeSha256 !== attestation.controller.functionInputTreeSha256) {
    fail('CNYOS_STAGING_RELEASE_FUNCTION_INPUT_DIGEST_MISMATCH');
  }
  const exactHeadCiRunId = attestation.exactHeadCi.runUrl.match(actionsRun)[1];
  const promotionPullRequestNumber = attestation.migrationPromotion.promotionPullRequest
    .match(promotionPr)[1];
  const evidence = Object.freeze({
    schemaVersion: 2,
    evidenceType: 'cnyos_staging_release_authorization_validation',
    status: 'authorized',
    authorization: 'staging_only',
    productionAuthorization: false,
    realPatientDataAuthorized: false,
    verifiedAt: verifiedAt.toISOString(),
    githubActor: actor,
    sourceCommit: expectedCommit,
    sourceTree: expectedTree,
    controllerRepository: attestation.controller.repository,
    controllerWorkflowPath: attestation.controller.workflowPath,
    controllerWorkflowRef: attestation.controller.workflowRef,
    controllerWorkflowCommit: attestation.controller.workflowCommit,
    controllerRunId: attestation.controller.runId,
    controllerRunAttempt: attestation.controller.runAttempt,
    controllerNonceSha256: digestSha256(attestation.controller.nonce),
    controllerIssuedAt: attestation.controller.issuedAt,
    controllerExpiresAt: attestation.controller.expiresAt,
    rollbackBaselineDeployId: attestation.controller.rollbackBaselineDeployId,
    staticArtifactSha256: attestation.controller.staticArtifactSha256,
    runtimeManifestSha256: attestation.controller.runtimeManifestSha256,
    functionInputManifestSha256: attestation.controller.functionInputManifestSha256,
    functionInputTreeSha256: attestation.controller.functionInputTreeSha256,
    target: Object.freeze({
      supabaseProjectRef: CNYOS_STAGING_RELEASE_TARGET.supabaseProjectRef,
      databaseSystemIdentifier: CNYOS_STAGING_RELEASE_TARGET.databaseSystemIdentifier,
      netlifySiteId: CNYOS_STAGING_RELEASE_TARGET.netlifySiteId,
      netlifyOrigin: CNYOS_STAGING_RELEASE_TARGET.netlifyOrigin,
      deploymentId: CNYOS_STAGING_RELEASE_TARGET.deploymentId,
      clinicId: CNYOS_STAGING_RELEASE_TARGET.clinicId,
      clinicCode: CNYOS_STAGING_RELEASE_TARGET.clinicCode
    }),
    authorizationReferenceSha256: digestSha256(attestation.authorization.reference),
    authorizationExpiresAt: attestation.authorization.expiresAt,
    namedRiskOwnerGitHubLogin: attestation.managedPlatformException.ownerGitHubLogin,
    riskAcceptanceExpiresAt: attestation.managedPlatformException.expiresAt,
    independentReviewerGitHubLogin: attestation.independentSecurityReview.reviewerGitHubLogin,
    independentReviewEvidenceSha256: attestation.independentSecurityReview.evidenceSha256,
    exactHeadCiRunId,
    exactHeadCiEvidenceSha256: attestation.exactHeadCi.evidenceSha256,
    rollbackEvidenceSha256: attestation.rollbackRehearsal.normalRollback.evidenceSha256,
    postObserverEvidenceSha256: attestation.rollbackRehearsal.freshPostObserver.evidenceSha256,
    promotionPullRequestNumber,
    preDeploymentRegressionEvidenceSha256:
      attestation.migrationPromotion.preDeploymentAuthenticatedRegressionEvidenceSha256,
    strictPostRemediationEvidenceSha256:
      attestation.strictPostRemediation.verificationSql.evidenceSha256,
    signatureKeyIds: Object.freeze({
      independentSecurityReviewer: verifiedSignatures.reviewerKeyId,
      managedPlatformRiskOwner: verifiedSignatures.riskOwnerKeyId
    }),
    signatureSha256: Object.freeze({
      independentSecurityReviewer: crypto.createHash('sha256')
        .update(verifiedSignatures.reviewerSignature)
        .digest('hex'),
      managedPlatformRiskOwner: crypto.createHash('sha256')
        .update(verifiedSignatures.riskOwnerSignature)
        .digest('hex')
    }),
    approverRegistrySha256: crypto.createHash('sha256')
      .update(approverRegistryRaw)
      .digest('hex'),
    attestationSha256: crypto.createHash('sha256').update(raw).digest('hex')
  });
  const evidencePath = writeEvidence(
    requiredEnv(env, 'STAGING_RELEASE_AUTHORIZATION_EVIDENCE_PATH'),
    evidence
  );
  return Object.freeze({ evidence, evidencePath });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stderr.write(
    'CANDIDATE_SPEC_ONLY: run an independently committed controller-owned implementation; no credential was read.\n'
  );
  process.exitCode = 1;
}
