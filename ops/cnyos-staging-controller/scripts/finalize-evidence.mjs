import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  POLICY,
  POLICY_SHA256,
  assertExactKeys,
  assertControllerRuntime,
  assertPolicyTarget,
  canonicalIsoTimestamp,
  exactSha256,
  fail,
  isPlainObject,
  readFileBounded,
  recentCanonicalTimestamp,
  required,
  sha256,
  writeJsonExclusive
} from './policy.mjs';
import { verifyProducerBundle } from './verify-producer-bundle.mjs';

export const EXPECTED_STAGING_UAT_ROLES = Object.freeze([
  'practitioner',
  'doctor',
  'reception',
  'pharmacy',
  'production',
  'inventory',
  'quality',
  'billing',
  'admin',
  'super_admin',
  'viewer'
]);

export const EXPECTED_STAGING_UAT_ROUTES = Object.freeze([
  'operations',
  'appointments',
  'checkin',
  'foundation',
  'clinical',
  'outcomes',
  'pharmacy',
  'production',
  'quality',
  'admin'
]);

export const EXPECTED_SCHEDULED_ROUTE_DENIAL_FUNCTIONS = Object.freeze([
  'database-backup',
  'database-backup-recovery'
]);

export const EXPECTED_SCHEDULED_ROUTE_DENIAL_METHODS = Object.freeze([
  'GET',
  'POST'
]);

const SCHEDULED_ROUTE_DENIAL_MAXIMUM_AGE_MS = 10 * 60 * 1000;
const SCHEDULED_ROUTE_DENIAL_PROBE_KEYS = Object.freeze([
  'originKind',
  'origin',
  'functionName',
  'method',
  'path',
  'requestBodyKind',
  'status',
  'responseApplicationShaped',
  'redirectFollowed',
  'credentialForwarded'
]);
const SCHEDULED_ROUTE_DENIAL_EVIDENCE_KEYS = Object.freeze([
  'schemaVersion',
  'evidenceType',
  'status',
  'scope',
  'productionAuthorization',
  'verifiedAt',
  'controllerRepository',
  'controllerRef',
  'controllerCommit',
  'controllerRunId',
  'source',
  'target',
  'netlifyDeployId',
  'immutableOrigin',
  'canonicalOrigin',
  'currentPublishedDeployIdBefore',
  'currentPublishedDeployIdAfter',
  'probes'
]);
const EXCLUSIVE_PUBLISHER_RELEASE_EVIDENCE_KEYS = Object.freeze([
  'schemaVersion',
  'evidenceType',
  'status',
  'scope',
  'productionAuthorization',
  'releasedAt',
  'controllerRepository',
  'controllerRef',
  'controllerCommit',
  'controllerRunId',
  'source',
  'netlifyDeployId',
  'lockLeaseId',
  'originalExclusivePublisherEvidenceSha256',
  'releaseAction',
  'leaseActiveAfterRelease',
  'brokerPolicyId',
  'brokerPolicySha256',
  'currentPublishedDeployIdBeforeRelease',
  'currentPublishedDeployIdAfterRelease'
]);

function exactStringArray(value, expected) {
  return Array.isArray(value) && value.length === expected.length &&
    value.every((item, index) => item === expected[index]) &&
    new Set(value).size === value.length;
}

function evidencePointer(value) {
  return isPlainObject(value) && /^[0-9a-f]{64}$/.test(String(value.sha256 || '')) &&
    typeof value.reference === 'string' && value.reference.trim().length >= 8 &&
    value.reference.length <= 500;
}

function passedGate(value) {
  return isPlainObject(value) && value.status === 'passed' && evidencePointer(value.evidence);
}

function exactImmutableDeployOrigin(deployId) {
  return `https://${deployId}--${POLICY.target.netlifySiteName}.netlify.app`;
}

function exactSource(value, { commit, tree }) {
  return isPlainObject(value) && value.repository === POLICY.sourceRepository &&
    value.commit === commit && value.tree === tree;
}

function exactControllerIdentity(value, runtime) {
  return value.controllerRepository === runtime.repository &&
    value.controllerRef === runtime.ref &&
    value.controllerCommit === runtime.commit &&
    value.controllerRunId === runtime.runId;
}

export function validateScheduledFunctionRouteDenialEvidence(value, {
  runtime,
  commit,
  tree,
  deployId,
  observedAt,
  notBefore,
  notAfter
}) {
  const immutableOrigin = exactImmutableDeployOrigin(deployId);
  assertExactKeys(
    value,
    SCHEDULED_ROUTE_DENIAL_EVIDENCE_KEYS,
    'CNYOS_FINAL_SCHEDULED_ROUTE_DENIAL_EVIDENCE_INVALID'
  );
  assertExactKeys(
    value.source,
    ['repository', 'commit', 'tree'],
    'CNYOS_FINAL_SCHEDULED_ROUTE_DENIAL_EVIDENCE_INVALID'
  );
  assertExactKeys(
    value.target,
    Object.keys(POLICY.target),
    'CNYOS_FINAL_SCHEDULED_ROUTE_DENIAL_EVIDENCE_INVALID'
  );
  if (!isPlainObject(value) || value.schemaVersion !== 1 ||
    value.evidenceType !== 'cnyos_staging_controller_scheduled_function_route_denial' ||
    value.status !== 'passed' || value.scope !== 'cnyos_staging_only' ||
    value.productionAuthorization !== false || !exactControllerIdentity(value, runtime) ||
    !exactSource(value.source, { commit, tree }) || value.netlifyDeployId !== deployId ||
    value.immutableOrigin !== immutableOrigin ||
    value.canonicalOrigin !== POLICY.target.netlifyOrigin ||
    value.currentPublishedDeployIdBefore !== deployId ||
    value.currentPublishedDeployIdAfter !== deployId) {
    fail('CNYOS_FINAL_SCHEDULED_ROUTE_DENIAL_EVIDENCE_INVALID');
  }
  assertPolicyTarget(value.target, 'CNYOS_FINAL_SCHEDULED_ROUTE_DENIAL_EVIDENCE_INVALID');
  const verifiedAt = recentCanonicalTimestamp(
    value.verifiedAt,
    observedAt,
    SCHEDULED_ROUTE_DENIAL_MAXIMUM_AGE_MS,
    'CNYOS_FINAL_SCHEDULED_ROUTE_DENIAL_TIMESTAMP_INVALID'
  );
  if (verifiedAt < notBefore || verifiedAt > notAfter) {
    fail('CNYOS_FINAL_SCHEDULED_ROUTE_DENIAL_TIMESTAMP_INVALID');
  }
  if (!Array.isArray(value.probes) || value.probes.length !== 8) {
    fail('CNYOS_FINAL_SCHEDULED_ROUTE_DENIAL_PROBES_INVALID');
  }
  const expectedKeys = new Set();
  for (const originKind of ['immutable', 'canonical']) {
    for (const functionName of EXPECTED_SCHEDULED_ROUTE_DENIAL_FUNCTIONS) {
      for (const method of EXPECTED_SCHEDULED_ROUTE_DENIAL_METHODS) {
        expectedKeys.add(`${originKind}\u0000${functionName}\u0000${method}`);
      }
    }
  }
  const observedKeys = new Set();
  for (const probe of value.probes) {
    assertExactKeys(
      probe,
      SCHEDULED_ROUTE_DENIAL_PROBE_KEYS,
      'CNYOS_FINAL_SCHEDULED_ROUTE_DENIAL_PROBES_INVALID'
    );
    const expectedOrigin = probe.originKind === 'immutable' ? immutableOrigin :
      probe.originKind === 'canonical' ? POLICY.target.netlifyOrigin : null;
    const expectedRequestBodyKind = probe.method === 'GET' ? 'none' :
      probe.method === 'POST' ? 'deliberately_malformed_json' : null;
    const key = `${probe.originKind}\u0000${probe.functionName}\u0000${probe.method}`;
    if (expectedOrigin === null ||
      !EXPECTED_SCHEDULED_ROUTE_DENIAL_FUNCTIONS.includes(probe.functionName) ||
      !EXPECTED_SCHEDULED_ROUTE_DENIAL_METHODS.includes(probe.method) ||
      probe.origin !== expectedOrigin ||
      probe.path !== `/.netlify/functions/${probe.functionName}` ||
      probe.requestBodyKind !== expectedRequestBodyKind ||
      ![403, 404].includes(probe.status) ||
      probe.responseApplicationShaped !== false ||
      probe.redirectFollowed !== false ||
      probe.credentialForwarded !== false ||
      observedKeys.has(key)) {
      fail('CNYOS_FINAL_SCHEDULED_ROUTE_DENIAL_PROBES_INVALID');
    }
    observedKeys.add(key);
  }
  if (observedKeys.size !== expectedKeys.size ||
    [...expectedKeys].some(key => !observedKeys.has(key))) {
    fail('CNYOS_FINAL_SCHEDULED_ROUTE_DENIAL_PROBES_INVALID');
  }
  return verifiedAt;
}

export function validateExclusivePublisherReleaseEvidence(value, {
  runtime,
  commit,
  tree,
  deployId,
  exclusivePublisher,
  exclusivePublisherSha256,
  observedAt,
  uatCompletedAt,
  finalCurrentVerifiedAt
}) {
  assertExactKeys(
    value,
    EXCLUSIVE_PUBLISHER_RELEASE_EVIDENCE_KEYS,
    'CNYOS_FINAL_PUBLISHER_RELEASE_EVIDENCE_INVALID'
  );
  assertExactKeys(
    value.source,
    ['repository', 'commit', 'tree'],
    'CNYOS_FINAL_PUBLISHER_RELEASE_EVIDENCE_INVALID'
  );
  const brokerPolicyId = required(
    exclusivePublisher.brokerPolicyId,
    'CNYOS_FINAL_PUBLISHER_RELEASE_EVIDENCE_INVALID',
    300
  );
  const brokerPolicySha256 = exactSha256(
    exclusivePublisher.brokerPolicySha256,
    'CNYOS_FINAL_PUBLISHER_RELEASE_EVIDENCE_INVALID'
  );
  if (brokerPolicyId !== POLICY.externalReconciliationBroker.policyId ||
    brokerPolicySha256 !== exactSha256(
      POLICY.externalReconciliationBroker.policySha256,
      'CNYOS_FINAL_PUBLISHER_RELEASE_EVIDENCE_INVALID'
    ) ||
    !isPlainObject(value) || value.schemaVersion !== 1 ||
    value.evidenceType !== 'cnyos_staging_controller_exclusive_publisher_release' ||
    value.status !== 'passed' || value.scope !== 'cnyos_staging_only' ||
    value.productionAuthorization !== false || !exactControllerIdentity(value, runtime) ||
    !exactSource(value.source, { commit, tree }) || value.netlifyDeployId !== deployId ||
    value.lockLeaseId !== exclusivePublisher.lockLeaseId ||
    value.originalExclusivePublisherEvidenceSha256 !== exclusivePublisherSha256 ||
    value.releaseAction !== 'released' || value.leaseActiveAfterRelease !== false ||
    value.currentPublishedDeployIdBeforeRelease !== deployId ||
    value.currentPublishedDeployIdAfterRelease !== deployId ||
    value.brokerPolicyId !== brokerPolicyId ||
    value.brokerPolicySha256 !== brokerPolicySha256) {
    fail('CNYOS_FINAL_PUBLISHER_RELEASE_EVIDENCE_INVALID');
  }
  const releasedAt = canonicalIsoTimestamp(
    value.releasedAt,
    'CNYOS_FINAL_PUBLISHER_RELEASE_TIMESTAMP_INVALID'
  );
  if (releasedAt <= uatCompletedAt || releasedAt <= finalCurrentVerifiedAt ||
    releasedAt > observedAt) {
    fail('CNYOS_FINAL_PUBLISHER_RELEASE_TIMESTAMP_INVALID');
  }
  return releasedAt;
}

export function validateAuthenticatedUatEvidence(uat, { commit, tree, deployId }) {
  if (!isPlainObject(uat) || uat.schemaVersion !== 1 ||
    uat.evidenceType !== 'cnyos_staging_controller_authenticated_uat' ||
    uat.status !== 'passed' || uat.controllerOwnedHarness !== true ||
    uat.syntheticOnly !== true || uat.realPatientDataAuthorized !== false ||
    uat.sourceCommit !== commit || uat.sourceTree !== tree ||
    uat.netlifyDeployId !== deployId ||
    uat.target?.netlifySiteId !== POLICY.target.netlifySiteId ||
    uat.target?.supabaseProjectRef !== POLICY.target.supabaseProjectRef ||
    uat.target?.clinicId !== POLICY.target.clinicId ||
    uat.unresolvedFailures !== 0) {
    fail('CNYOS_FINAL_UAT_EVIDENCE_INVALID');
  }
  const provisioning = uat.identityProvisioning;
  if (!passedGate(provisioning) || provisioning.syntheticUserCount !== 11 ||
    provisioning.roleCount !== 11 ||
    !exactStringArray(provisioning.roles, EXPECTED_STAGING_UAT_ROLES)) {
    fail('CNYOS_FINAL_UAT_IDENTITY_PROVISIONING_INVALID');
  }
  const access = uat.accessControl;
  if (!passedGate(access) || access.currentAccessContextRoleCount !== 11 ||
    access.departmentCanRoleCount !== 11 || access.crossTenantDenialsVerified !== true) {
    fail('CNYOS_FINAL_UAT_ACCESS_CONTROL_INVALID');
  }
  const routes = uat.routeMatrix;
  if (!passedGate(routes) || routes.browser !== 'mobile_chromium' ||
    routes.roleCount !== 11 || routes.routeCount !== 10 ||
    routes.authorizationDecisionCount !== 110 ||
    routes.deniedRouteBehaviorVerified !== true ||
    !exactStringArray(routes.routes, EXPECTED_STAGING_UAT_ROUTES)) {
    fail('CNYOS_FINAL_UAT_ROUTE_MATRIX_INVALID');
  }
  const journeys = uat.syntheticJourneys;
  if (!passedGate(journeys) || journeys.caseCount !== 10 || journeys.passed !== 10 ||
    journeys.failed !== 0 || journeys.clinicalToPaymentVerified !== true) {
    fail('CNYOS_FINAL_UAT_JOURNEYS_INVALID');
  }
  if (!passedGate(uat.migrationHealth) || uat.migrationHealth.exactLedgerVerified !== true ||
    !passedGate(uat.auditAndSegregation) ||
    uat.auditAndSegregation.producerApproverSeparationVerified !== true) {
    fail('CNYOS_FINAL_UAT_DATABASE_GATES_INVALID');
  }
  const subscription = uat.subscriptionRestoration;
  if (!passedGate(subscription) || subscription.initialState !== 'on' ||
    subscription.offStateVerified !== true || subscription.onStateRestored !== true ||
    subscription.originalTenantBoundaryRestored !== true) {
    fail('CNYOS_FINAL_UAT_SUBSCRIPTION_RESTORATION_INVALID');
  }
  return true;
}

async function evidence(env, pathName, digestName, type, code) {
  const filename = required(env[pathName], `${code}_PATH_REQUIRED`, 4096);
  const bytes = await readFileBounded(filename, 4 * 1024 * 1024, code);
  const digest = sha256(bytes);
  if (digest !== exactSha256(env[digestName], `${code}_DIGEST_REQUIRED`)) {
    fail(`${code}_DIGEST_MISMATCH`);
  }
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { fail(code); }
  if (!isPlainObject(value) || value.evidenceType !== type) fail(code);
  return Object.freeze({ filename: path.resolve(filename), bytes, sha256: digest, value });
}

export async function finalizeControllerEvidence({
  env = process.env,
  now = () => new Date()
} = {}) {
  const runtime = assertControllerRuntime(env);
  const bundle = await verifyProducerBundle({ env });
  const [preReleaseReconciliation, authorization, authorizationBundle,
    rollbackAttestationReceipt, rollbackAttestationValidation, liveNetlifyAuthority,
    functionEnvironment, backupDisableRuntimeBoundary, runtimeCapabilityBoundary, preflight,
    rollbackReadiness, draftGate, draftIntent, draftReceipt, privateDraftAccessBoundary,
    draftVerification, controlBehavior, privateDraft, exclusivePublisher, promotionAttempt,
    promotion, postPromotion, scheduledRouteDenial, uat, finalCurrent, publisherRelease] =
    await Promise.all([
    evidence(env, 'CNYOS_CONTROLLER_RECONCILIATION_EVIDENCE_PATH',
      'CNYOS_EXPECTED_RECONCILIATION_EVIDENCE_SHA256',
      'cnyos_staging_controller_pre_release_reconciliation',
      'CNYOS_FINAL_RECONCILIATION_EVIDENCE_INVALID'),
    evidence(env, 'CNYOS_CONTROLLER_AUTHORIZATION_EVIDENCE_PATH',
      'CNYOS_EXPECTED_AUTHORIZATION_EVIDENCE_SHA256',
      'cnyos_staging_controller_authorization_validation',
      'CNYOS_FINAL_AUTHORIZATION_EVIDENCE_INVALID'),
    evidence(env, 'CNYOS_CONTROLLER_AUTHORIZATION_BUNDLE_PATH',
      'CNYOS_EXPECTED_AUTHORIZATION_BUNDLE_SHA256',
      'cnyos_staging_controller_authorization_verification_bundle',
      'CNYOS_FINAL_AUTHORIZATION_BUNDLE_INVALID'),
    evidence(env, 'CNYOS_CONTROLLER_ROLLBACK_ATTESTATION_DEPOSIT_RECEIPT_PATH',
      'CNYOS_EXPECTED_ROLLBACK_ATTESTATION_DEPOSIT_RECEIPT_SHA256',
      'cnyos_staging_rollback_attestation_deposit_envelope',
      'CNYOS_FINAL_ROLLBACK_ATTESTATION_RECEIPT_INVALID'),
    evidence(env, 'CNYOS_CONTROLLER_ROLLBACK_ATTESTATION_DEPOSIT_EVIDENCE_PATH',
      'CNYOS_EXPECTED_ROLLBACK_ATTESTATION_DEPOSIT_EVIDENCE_SHA256',
      'cnyos_staging_rollback_attestation_deposit_validation',
      'CNYOS_FINAL_ROLLBACK_ATTESTATION_VALIDATION_INVALID'),
    evidence(env, 'CNYOS_CONTROLLER_LIVE_NETLIFY_AUTHORITY_EVIDENCE_PATH',
      'CNYOS_EXPECTED_LIVE_NETLIFY_AUTHORITY_EVIDENCE_SHA256',
      'cnyos_staging_controller_live_netlify_authority_boundary',
      'CNYOS_FINAL_LIVE_NETLIFY_AUTHORITY_EVIDENCE_INVALID'),
    evidence(env, 'CNYOS_CONTROLLER_FUNCTION_ENV_EVIDENCE_PATH',
      'CNYOS_EXPECTED_FUNCTION_ENV_EVIDENCE_SHA256',
      'cnyos_staging_controller_function_environment_validation',
      'CNYOS_FINAL_FUNCTION_ENV_EVIDENCE_INVALID'),
    evidence(env, 'CNYOS_CONTROLLER_BACKUP_DISABLE_EVIDENCE_PATH',
      'CNYOS_EXPECTED_BACKUP_DISABLE_EVIDENCE_SHA256',
      'cnyos_staging_controller_backup_disable_runtime_boundary',
      'CNYOS_FINAL_BACKUP_DISABLE_EVIDENCE_INVALID'),
    evidence(env, 'CNYOS_CONTROLLER_RUNTIME_CAPABILITY_EVIDENCE_PATH',
      'CNYOS_EXPECTED_RUNTIME_CAPABILITY_EVIDENCE_SHA256',
      'cnyos_staging_controller_runtime_capability_boundary',
      'CNYOS_FINAL_RUNTIME_CAPABILITY_EVIDENCE_INVALID'),
    evidence(env, 'CNYOS_CONTROLLER_PREFLIGHT_EVIDENCE_PATH',
      'CNYOS_EXPECTED_PREFLIGHT_EVIDENCE_SHA256',
      'cnyos_staging_controller_preflight',
      'CNYOS_FINAL_PREFLIGHT_EVIDENCE_INVALID'),
    evidence(env, 'CNYOS_CONTROLLER_ROLLBACK_READINESS_EVIDENCE_PATH',
      'CNYOS_EXPECTED_ROLLBACK_READINESS_EVIDENCE_SHA256',
      'cnyos_staging_controller_rollback_readiness',
      'CNYOS_FINAL_ROLLBACK_READINESS_EVIDENCE_INVALID'),
    evidence(env, 'CNYOS_CONTROLLER_DRAFT_GATE_EVIDENCE_PATH',
      'CNYOS_EXPECTED_DRAFT_GATE_EVIDENCE_SHA256',
      'cnyos_staging_controller_draft_gate',
      'CNYOS_FINAL_DRAFT_GATE_EVIDENCE_INVALID'),
    evidence(env, 'CNYOS_CONTROLLER_DRAFT_INTENT_EVIDENCE_PATH',
      'CNYOS_EXPECTED_DRAFT_INTENT_EVIDENCE_SHA256',
      'cnyos_staging_controller_draft_intent',
      'CNYOS_FINAL_DRAFT_INTENT_EVIDENCE_INVALID'),
    evidence(env, 'CNYOS_CONTROLLER_DRAFT_RECEIPT_EVIDENCE_PATH',
      'CNYOS_EXPECTED_DRAFT_RECEIPT_EVIDENCE_SHA256',
      'cnyos_staging_controller_draft_deploy_receipt',
      'CNYOS_FINAL_DRAFT_RECEIPT_EVIDENCE_INVALID'),
    evidence(env, 'CNYOS_CONTROLLER_DRAFT_ACCESS_BOUNDARY_EVIDENCE_PATH',
      'CNYOS_EXPECTED_DRAFT_ACCESS_BOUNDARY_EVIDENCE_SHA256',
      'cnyos_staging_controller_private_draft_access_boundary',
      'CNYOS_FINAL_DRAFT_ACCESS_BOUNDARY_EVIDENCE_INVALID'),
    evidence(env, 'CNYOS_CONTROLLER_DRAFT_VERIFICATION_EVIDENCE_PATH',
      'CNYOS_EXPECTED_DRAFT_VERIFICATION_EVIDENCE_SHA256',
      'cnyos_staging_controller_draft_verification',
      'CNYOS_FINAL_DRAFT_VERIFICATION_EVIDENCE_INVALID'),
    evidence(env, 'CNYOS_CONTROLLER_CONTROL_BEHAVIOR_EVIDENCE_PATH',
      'CNYOS_EXPECTED_CONTROL_BEHAVIOR_EVIDENCE_SHA256',
      'cnyos_staging_controller_netlify_control_behavior_verification',
      'CNYOS_FINAL_CONTROL_BEHAVIOR_EVIDENCE_INVALID'),
    evidence(env, 'CNYOS_CONTROLLER_PRIVATE_DRAFT_EVIDENCE_PATH',
      'CNYOS_EXPECTED_PRIVATE_DRAFT_EVIDENCE_SHA256',
      'cnyos_staging_controller_private_draft_lifecycle',
      'CNYOS_FINAL_PRIVATE_DRAFT_EVIDENCE_INVALID'),
    evidence(env, 'CNYOS_CONTROLLER_EXCLUSIVE_PUBLISHER_EVIDENCE_PATH',
      'CNYOS_EXPECTED_EXCLUSIVE_PUBLISHER_EVIDENCE_SHA256',
      'cnyos_staging_controller_exclusive_publisher_lease',
      'CNYOS_FINAL_EXCLUSIVE_PUBLISHER_EVIDENCE_INVALID'),
    evidence(env, 'CNYOS_CONTROLLER_PUBLISH_ATTEMPT_EVIDENCE_PATH',
      'CNYOS_EXPECTED_PUBLISH_ATTEMPT_EVIDENCE_SHA256',
      'cnyos_staging_controller_promotion_attempt',
      'CNYOS_FINAL_PROMOTION_ATTEMPT_EVIDENCE_INVALID'),
    evidence(env, 'CNYOS_CONTROLLER_PROMOTION_EVIDENCE_PATH',
      'CNYOS_EXPECTED_PROMOTION_EVIDENCE_SHA256',
      'cnyos_staging_controller_exact_deploy_promotion',
      'CNYOS_FINAL_PROMOTION_EVIDENCE_INVALID'),
    evidence(env, 'CNYOS_CONTROLLER_POST_PROMOTION_EVIDENCE_PATH',
      'CNYOS_EXPECTED_POST_PROMOTION_EVIDENCE_SHA256',
      'cnyos_staging_controller_post_promotion_verification',
      'CNYOS_FINAL_POST_PROMOTION_EVIDENCE_INVALID'),
    evidence(env, 'CNYOS_CONTROLLER_SCHEDULED_ROUTE_DENIAL_EVIDENCE_PATH',
      'CNYOS_EXPECTED_SCHEDULED_ROUTE_DENIAL_EVIDENCE_SHA256',
      'cnyos_staging_controller_scheduled_function_route_denial',
      'CNYOS_FINAL_SCHEDULED_ROUTE_DENIAL_EVIDENCE_INVALID'),
    evidence(env, 'CNYOS_CONTROLLER_UAT_EVIDENCE_PATH',
      'CNYOS_EXPECTED_UAT_EVIDENCE_SHA256',
      'cnyos_staging_controller_authenticated_uat',
      'CNYOS_FINAL_UAT_EVIDENCE_INVALID'),
    evidence(env, 'CNYOS_CONTROLLER_FINAL_CURRENT_EVIDENCE_PATH',
      'CNYOS_EXPECTED_FINAL_CURRENT_EVIDENCE_SHA256',
      'cnyos_staging_controller_final_current_verification',
      'CNYOS_FINAL_CURRENT_EVIDENCE_INVALID'),
    evidence(env, 'CNYOS_CONTROLLER_PUBLISHER_RELEASE_EVIDENCE_PATH',
      'CNYOS_EXPECTED_PUBLISHER_RELEASE_EVIDENCE_SHA256',
      'cnyos_staging_controller_exclusive_publisher_release',
      'CNYOS_FINAL_PUBLISHER_RELEASE_EVIDENCE_INVALID')
  ]);

  const runId = runtime.runId;
  const commit = bundle.manifest.candidateCommit;
  const tree = bundle.manifest.candidateTree;
  const artifactSha = bundle.manifest.artifactSha256;
  const deployId = promotion.value.promotedDeployId;
  const observedAt = now();
  if (!(observedAt instanceof Date) || Number.isNaN(observedAt.getTime())) fail('CNYOS_FINAL_TIME_INVALID');
  const uatCompletedAt = canonicalIsoTimestamp(
    uat.value.completedAt,
    'CNYOS_FINAL_UAT_TIMESTAMP_INVALID'
  );
  const finalCurrentVerifiedAt = canonicalIsoTimestamp(
    finalCurrent.value.verifiedAt,
    'CNYOS_FINAL_CURRENT_TIMESTAMP_INVALID'
  );
  const postPromotionVerifiedAt = canonicalIsoTimestamp(
    postPromotion.value.verifiedAt,
    'CNYOS_FINAL_POST_PROMOTION_TIMESTAMP_INVALID'
  );
  const authorizationExpiresAt = canonicalIsoTimestamp(
    authorization.value.authorizationExpiresAt,
    'CNYOS_FINAL_AUTHORIZATION_EXPIRY_INVALID'
  );
  const exclusivePublisherExpiresAt = canonicalIsoTimestamp(
    exclusivePublisher.value.expiresAt,
    'CNYOS_FINAL_PUBLISHER_LEASE_EXPIRY_INVALID'
  );
  validateAuthenticatedUatEvidence(uat.value, { commit, tree, deployId });
  for (const item of [preReleaseReconciliation, authorization,
    rollbackAttestationValidation, liveNetlifyAuthority, functionEnvironment,
    backupDisableRuntimeBoundary, runtimeCapabilityBoundary, preflight, rollbackReadiness,
    draftGate, draftIntent, draftReceipt, privateDraftAccessBoundary, draftVerification,
    controlBehavior, privateDraft, exclusivePublisher, promotionAttempt, promotion,
    postPromotion, scheduledRouteDenial, uat, finalCurrent, publisherRelease]) {
    if (item.value.controllerRunId !== runId || item.value.productionAuthorization !== false) {
      fail('CNYOS_FINAL_EVIDENCE_RUN_MISMATCH');
    }
  }
  if (authorizationBundle.value.scope !== 'cnyos_staging_only' ||
    authorizationBundle.value.productionAuthorization !== false ||
    authorizationBundle.value.secretValuesSerialized !== false ||
    authorizationBundle.value.validationEvidence?.controllerRunId !== runId ||
    authorizationBundle.value.validationEvidence?.source?.commit !== commit ||
    authorizationBundle.value.validationEvidence?.source?.tree !== tree ||
    authorizationBundle.value.validationEvidence?.artifact?.artifactSha256 !== artifactSha ||
    rollbackAttestationReceipt.value.receipt?.controller?.runId !== runId ||
    rollbackAttestationReceipt.value.receipt?.controller?.dispatchNonce !==
      bundle.manifest.dispatchNonce ||
    rollbackAttestationReceipt.value.receipt?.productionAuthorization !== false ||
    rollbackAttestationReceipt.value.receipt?.source?.commit !== commit ||
    rollbackAttestationReceipt.value.receipt?.source?.tree !== tree ||
    rollbackAttestationReceipt.value.receipt?.artifact?.artifactSha256 !== artifactSha ||
    rollbackAttestationValidation.value.authorizationBundleSha256 !== authorizationBundle.sha256 ||
    rollbackAttestationValidation.value.depositReceiptSha256 !==
      rollbackAttestationReceipt.sha256 ||
    preflight.value.rollbackAttestationDepositEvidenceSha256 !==
      rollbackAttestationValidation.sha256 ||
    preflight.value.rollbackAttestationDepositReceiptSha256 !==
      rollbackAttestationReceipt.sha256 ||
    preflight.value.liveNetlifyAuthorityBoundaryEvidenceSha256 !==
      liveNetlifyAuthority.sha256 ||
    preflight.value.functionEnvironmentEvidenceSha256 !== functionEnvironment.sha256 ||
    preflight.value.backupDisableEvidenceSha256 !== backupDisableRuntimeBoundary.sha256 ||
    preflight.value.runtimeCapabilityEvidenceSha256 !== runtimeCapabilityBoundary.sha256 ||
    rollbackReadiness.value.preflightEvidenceSha256 !== preflight.sha256 ||
    draftGate.value.preflightEvidenceSha256 !== preflight.sha256 ||
    draftGate.value.rollbackReadinessEvidenceSha256 !== rollbackReadiness.sha256 ||
    draftIntent.value.preflightEvidenceSha256 !== preflight.sha256 ||
    draftIntent.value.draftGateEvidenceSha256 !== draftGate.sha256 ||
    draftIntent.value.source?.commit !== commit ||
    draftIntent.value.source?.tree !== tree ||
    draftIntent.value.artifact?.artifactSha256 !== artifactSha ||
    promotionAttempt.value.preflightEvidenceSha256 !== preflight.sha256 ||
    promotionAttempt.value.rollbackReadinessEvidenceSha256 !== rollbackReadiness.sha256 ||
    promotionAttempt.value.draftGateEvidenceSha256 !== draftGate.sha256 ||
    promotionAttempt.value.draftVerificationEvidenceSha256 !== draftVerification.sha256 ||
    promotionAttempt.value.controlBehaviorEvidenceSha256 !== controlBehavior.sha256 ||
    promotionAttempt.value.privateDraftEvidenceSha256 !== privateDraft.sha256 ||
    promotionAttempt.value.exclusivePublisherEvidenceSha256 !== exclusivePublisher.sha256 ||
    promotion.value.promotionAttemptEvidenceSha256 !== promotionAttempt.sha256 ||
    authorization.value.source?.commit !== commit || authorization.value.source?.tree !== tree ||
    authorization.value.artifact?.artifactSha256 !== artifactSha ||
    preflight.value.source?.commit !== commit || preflight.value.artifact?.artifactSha256 !== artifactSha ||
    draftReceipt.value.source?.commit !== commit ||
    draftReceipt.value.artifact?.artifactSha256 !== artifactSha ||
    draftReceipt.value.draftDeployId !== deployId ||
    draftVerification.value.source?.commit !== commit ||
    draftVerification.value.source?.tree !== tree ||
    draftVerification.value.artifact?.artifactSha256 !== artifactSha ||
    draftVerification.value.draftDeployId !== deployId ||
    draftVerification.value.draftReceiptEvidenceSha256 !== draftReceipt.sha256 ||
    draftVerification.value.privateDraftAccessBoundaryEvidenceSha256 !==
      privateDraftAccessBoundary.sha256 ||
    controlBehavior.value.draftDeployId !== deployId ||
    controlBehavior.value.draftVerificationEvidenceSha256 !== draftVerification.sha256 ||
    privateDraft.value.draftDeployId !== deployId ||
    exclusivePublisher.value.lockLeaseId !== promotion.value.exclusivePublisherLeaseId ||
    promotion.value.source?.commit !== commit || promotion.value.artifact?.artifactSha256 !== artifactSha ||
    promotion.value.currentPublishedDeployId !== deployId ||
    promotion.value.draftVerificationEvidenceSha256 !== draftVerification.sha256 ||
    promotion.value.controlBehaviorEvidenceSha256 !== controlBehavior.sha256 ||
    promotion.value.privateDraftEvidenceSha256 !== privateDraft.sha256 ||
    promotion.value.exclusivePublisherEvidenceSha256 !== exclusivePublisher.sha256 ||
    postPromotion.value.source?.commit !== commit || postPromotion.value.source?.tree !== tree ||
    postPromotion.value.artifact?.artifactSha256 !== artifactSha ||
    postPromotion.value.netlifyDeployId !== deployId ||
    postPromotion.value.currentPublishedDeployId !== deployId ||
    postPromotion.value.promotionEvidenceSha256 !== promotion.sha256 ||
    finalCurrent.value.source?.commit !== commit || finalCurrent.value.source?.tree !== tree ||
    finalCurrent.value.artifact?.artifactSha256 !== artifactSha ||
    finalCurrent.value.netlifyDeployId !== deployId ||
    finalCurrent.value.currentPublishedDeployId !== deployId ||
    finalCurrent.value.promotionEvidenceSha256 !== promotion.sha256) {
    fail('CNYOS_FINAL_EVIDENCE_PROVENANCE_MISMATCH');
  }
  validateScheduledFunctionRouteDenialEvidence(scheduledRouteDenial.value, {
    runtime,
    commit,
    tree,
    deployId,
    observedAt,
    notBefore: postPromotionVerifiedAt,
    notAfter: uatCompletedAt
  });
  validateExclusivePublisherReleaseEvidence(publisherRelease.value, {
    runtime,
    commit,
    tree,
    deployId,
    exclusivePublisher: exclusivePublisher.value,
    exclusivePublisherSha256: exclusivePublisher.sha256,
    observedAt,
    uatCompletedAt,
    finalCurrentVerifiedAt
  });
  if (draftVerification.value.status !== 'passed' ||
    draftVerification.value.functionByteAttestationAvailable !== false ||
    draftVerification.value.authenticatedDraftContentAccessVerified !== true ||
    draftVerification.value.draftAccessCredentialConsumedOnlyAtBoundary !== true ||
    draftVerification.value.draftAccessCredentialForwardedToCandidateOrigin !== false ||
    draftVerification.value.artifact?.candidateOriginReceivedBoundaryCredential !== false ||
    draftVerification.value.artifact?.candidateOriginReceivedBoundaryCookies !== false ||
    draftVerification.value.artifact?.boundaryRedirectFollowed !== false ||
    draftVerification.value.netlifyControlBehaviorVerified !== false ||
    controlBehavior.value.status !== 'passed' ||
    controlBehavior.value.headersBehaviorVerified !== true ||
    controlBehavior.value.redirectsBehaviorVerified !== true ||
    privateDraft.value.status !== 'passed' ||
    privateDraft.value.accessRestrictedToController !== true ||
    privateDraft.value.anonymousDraftAccessDenied !== true ||
    privateDraft.value.publicAnonymousFunctionAccessDenied !== true ||
    exclusivePublisher.value.status !== 'passed' ||
    exclusivePublisher.value.enforcementAuthority !== 'independent_netlify_publish_broker' ||
    postPromotion.value.status !== 'passed' ||
    postPromotion.value.functionByteAttestationAvailable !== false ||
    postPromotion.value.artifact?.closedWorldInventoryVerified !== true ||
    finalCurrent.value.status !== 'passed' ||
    finalCurrent.value.verificationPhase !== 'after_authenticated_uat' ||
    finalCurrent.value.artifact?.closedWorldInventoryVerified !== true ||
    postPromotionVerifiedAt > observedAt ||
    uatCompletedAt > observedAt || finalCurrentVerifiedAt > observedAt ||
    uatCompletedAt < postPromotionVerifiedAt ||
    finalCurrentVerifiedAt < uatCompletedAt) {
    fail('CNYOS_FINAL_UAT_EVIDENCE_INVALID');
  }
  if (authorizationExpiresAt <= observedAt || exclusivePublisherExpiresAt <= observedAt) {
    fail('CNYOS_FINAL_AUTHORIZATION_OR_PUBLISHER_LEASE_EXPIRED');
  }
  const retained = Object.freeze({
    producerManifest: bundle.manifestSha256,
    preReleaseReconciliation: preReleaseReconciliation.sha256,
    authorization: authorization.sha256,
    authorizationVerificationBundle: authorizationBundle.sha256,
    rollbackAttestationDepositReceipt: rollbackAttestationReceipt.sha256,
    rollbackAttestationDepositValidation: rollbackAttestationValidation.sha256,
    liveNetlifyAuthorityBoundary: liveNetlifyAuthority.sha256,
    functionEnvironment: functionEnvironment.sha256,
    backupDisableRuntimeBoundary: backupDisableRuntimeBoundary.sha256,
    runtimeCapabilityBoundary: runtimeCapabilityBoundary.sha256,
    preflight: preflight.sha256,
    rollbackReadiness: rollbackReadiness.sha256,
    draftGate: draftGate.sha256,
    durableDraftIntent: draftIntent.sha256,
    draftReceipt: draftReceipt.sha256,
    draftVerification: draftVerification.sha256,
    controlBehavior: controlBehavior.sha256,
    privateDraftAccessBoundary: privateDraftAccessBoundary.sha256,
    privateDraftLifecycle: privateDraft.sha256,
    exclusivePublisherLease: exclusivePublisher.sha256,
    promotionAttempt: promotionAttempt.sha256,
    exactPromotion: promotion.sha256,
    postPromotionVerification: postPromotion.sha256,
    scheduledFunctionRouteDenial: scheduledRouteDenial.sha256,
    authenticatedUat: uat.sha256,
    finalCurrentVerification: finalCurrent.sha256,
    exclusivePublisherRelease: publisherRelease.sha256
  });
  const result = Object.freeze({
    schemaVersion: 1,
    evidenceType: 'cnyos_staging_controller_final_release',
    status: 'passed',
    scope: 'cnyos_staging_only',
    productionAuthorization: false,
    realPatientDataAuthorized: false,
    finalizedAt: observedAt.toISOString(),
    controllerRepository: runtime.repository,
    controllerRef: runtime.ref,
    controllerCommit: runtime.commit,
    controllerRunId: runId,
    controllerRunAttempt: 1,
    dispatchNonce: bundle.manifest.dispatchNonce,
    policySha256: POLICY_SHA256,
    source: Object.freeze({
      repository: POLICY.sourceRepository,
      commit,
      tree,
      functionSourceTree: bundle.manifest.functionSourceTree
    }),
    artifact: Object.freeze({
      sha256: artifactSha,
      fileCount: bundle.manifest.fileCount
    }),
    target: POLICY.target,
    netlifyDeployId: deployId,
    previousDeployId: preflight.value.previousPublishedDeploy.id,
    functionByteAttestationAvailable: false,
    authenticatedUatPassed: true,
    retainedEvidenceSha256: retained,
    evidenceSetSha256: sha256(JSON.stringify(retained))
  });
  const evidencePath = await writeJsonExclusive(
    required(env.CNYOS_CONTROLLER_FINAL_EVIDENCE_PATH,
      'CNYOS_CONTROLLER_FINAL_EVIDENCE_PATH_REQUIRED', 4096),
    result
  );
  return Object.freeze({ evidence: result, evidencePath });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  finalizeControllerEvidence().then(async result => {
    const bytes = await fs.readFile(result.evidencePath);
    process.stdout.write(`${JSON.stringify({
      evidencePath: result.evidencePath,
      evidenceSha256: sha256(bytes),
      netlifyDeployId: result.evidence.netlifyDeployId
    })}\n`);
  }).catch(error => {
    process.stderr.write(`${String(error?.message || 'CNYOS_CONTROLLER_FINAL_EVIDENCE_FAILED')}\n`);
    process.exitCode = 1;
  });
}
