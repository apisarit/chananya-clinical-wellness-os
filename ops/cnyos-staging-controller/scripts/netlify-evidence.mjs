import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  DEPLOY_ID,
  EXPECTED_FUNCTION_NAMES,
  FUNCTIONS_REQUIRING_NO_SCHEDULE_OR_CUSTOM_ROUTE,
  MAX_FILE_BYTES,
  POLICY,
  POLICY_SHA256,
  REQUIRED_SCHEDULES,
  assertExactKeys,
  assertControllerRuntime,
  assertPolicyTarget,
  canonicalIsoTimestamp,
  deploymentMarker,
  exactDeployId,
  exactSha40,
  exactSha256,
  fail,
  isPlainObject,
  minimumFutureTimestamp,
  readFileBounded,
  recentCanonicalTimestamp,
  required,
  safeOrigin,
  sha1,
  sha256,
  writeJsonExclusive
} from './policy.mjs';
import { verifyProducerBundle } from './verify-producer-bundle.mjs';

const API = 'https://api.netlify.com/api/v1';
const MAX_API_BYTES = 4 * 1024 * 1024;

async function responseBytes(response, maximum, code) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        await reader.cancel().catch(() => {});
        fail(code);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

async function netlifyRequest(fetchImpl, token, pathname, {
  method = 'GET',
  accept = 'application/json',
  maximum = MAX_API_BYTES
} = {}) {
  let response;
  try {
    response = await fetchImpl(`${API}${pathname}`, {
      method,
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: accept,
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {})
      },
      signal: AbortSignal.timeout(20_000)
    });
  } catch {
    fail('CNYOS_CONTROLLER_NETLIFY_REQUEST_FAILED');
  }
  const body = await responseBytes(response, maximum, 'CNYOS_CONTROLLER_NETLIFY_RESPONSE_TOO_LARGE');
  return Object.freeze({ response, body });
}

async function netlifyJson(fetchImpl, token, pathname) {
  const result = await netlifyRequest(fetchImpl, token, pathname);
  if (result.response.status !== 200) fail(`CNYOS_CONTROLLER_NETLIFY_STATUS_${result.response.status}`);
  let value;
  try { value = JSON.parse(result.body.toString('utf8')); }
  catch { fail('CNYOS_CONTROLLER_NETLIFY_JSON_INVALID'); }
  return Object.freeze({ ...result, value });
}

function noNextPage(response) {
  const link = String(response.headers.get('link') || '');
  const next = String(response.headers.get('x-next-page') || '').trim();
  const pages = String(response.headers.get('x-page-count') || response.headers.get('x-total-pages') || '').trim();
  if (/\brel\s*=\s*["']?next["']?/i.test(link) || (next && next !== '0') ||
    (pages && (!/^\d+$/.test(pages) || Number(pages) > 1))) {
    fail('CNYOS_CONTROLLER_NETLIFY_SITE_INVENTORY_PAGINATED');
  }
}

function assertSiteIdentity(site) {
  if (!isPlainObject(site) || String(site.id || '').toLowerCase() !== POLICY.target.netlifySiteId ||
    String(site.name || '').toLowerCase() !== POLICY.target.netlifySiteName ||
    safeOrigin(site.ssl_url || site.url, 'CNYOS_CONTROLLER_NETLIFY_SITE_ORIGIN_INVALID') !==
      POLICY.target.netlifyOrigin) {
    fail('CNYOS_CONTROLLER_NETLIFY_SITE_MISMATCH');
  }
  return site;
}

function assertSite(site, expectedDeployId = null) {
  assertSiteIdentity(site);
  const deployId = String(site.published_deploy?.id || '').toLowerCase();
  if (!DEPLOY_ID.test(deployId) || (expectedDeployId && deployId !== expectedDeployId)) {
    fail('CNYOS_CONTROLLER_NETLIFY_PUBLISHED_DEPLOY_MISMATCH');
  }
  return deployId;
}

function exactDeployOrigin(deployId) {
  return `https://${deployId}--${POLICY.target.netlifySiteName}.netlify.app`;
}

function assertDeploy(deploy, deployId, {
  expectedCommit = null,
  expectedMarker = null,
  expectedPublished = null,
  expectedDraft = null
} = {}) {
  if (!isPlainObject(deploy) || String(deploy.id || '').toLowerCase() !== deployId ||
    String(deploy.site_id || '').toLowerCase() !== POLICY.target.netlifySiteId ||
    deploy.state !== 'ready' || deploy.context !== 'production' ||
    safeOrigin(deploy.deploy_ssl_url || deploy.deploy_url,
      'CNYOS_CONTROLLER_NETLIFY_DEPLOY_ORIGIN_INVALID') !== exactDeployOrigin(deployId)) {
    fail('CNYOS_CONTROLLER_NETLIFY_DEPLOY_MISMATCH');
  }
  if (expectedCommit && String(deploy.commit_ref || '').toLowerCase() !== expectedCommit) {
    fail('CNYOS_CONTROLLER_NETLIFY_DEPLOY_COMMIT_MISMATCH');
  }
  if (expectedMarker && deploy.title !== expectedMarker) {
    fail('CNYOS_CONTROLLER_NETLIFY_DEPLOY_MARKER_MISMATCH');
  }
  const isPublished = typeof deploy.published_at === 'string' &&
    Number.isFinite(Date.parse(deploy.published_at));
  if (expectedPublished !== null && isPublished !== expectedPublished) {
    fail('CNYOS_CONTROLLER_NETLIFY_DEPLOY_LIFECYCLE_MISMATCH');
  }
  if (expectedDraft !== null && deploy.draft !== expectedDraft) {
    fail('CNYOS_CONTROLLER_NETLIFY_DEPLOY_LIFECYCLE_MISMATCH');
  }
  return deploy;
}

function sanitizeDeploy(deploy) {
  return Object.freeze({
    id: deploy?.id || null,
    siteId: deploy?.site_id || null,
    state: deploy?.state || null,
    context: deploy?.context || null,
    commitRef: deploy?.commit_ref || null,
    title: deploy?.title || null,
    exactDeployOrigin: deploy?.deploy_ssl_url || deploy?.deploy_url || null,
    publishedAt: deploy?.published_at || null
  });
}

async function loadEvidence(filename, expectedDigest, code) {
  const bytes = await readFileBounded(filename, 4 * 1024 * 1024, code);
  if (sha256(bytes) !== exactSha256(expectedDigest, `${code}_DIGEST_INVALID`)) {
    fail(`${code}_DIGEST_MISMATCH`);
  }
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { fail(code); }
  if (!isPlainObject(value)) fail(code);
  return Object.freeze({ bytes, value, sha256: sha256(bytes) });
}

function assertAuthorization(evidence, runtime, env, now, { allowExpired = false } = {}) {
  if (evidence.schemaVersion !== 1 ||
    evidence.evidenceType !== 'cnyos_staging_controller_authorization_validation' ||
    evidence.status !== 'authorized' || evidence.scope !== 'cnyos_staging_only' ||
    evidence.productionAuthorization !== false || evidence.realPatientDataAuthorized !== false ||
    evidence.controllerRepository !== runtime.repository || evidence.controllerRef !== runtime.ref ||
    evidence.controllerCommit !== runtime.commit ||
    evidence.controllerRunId !== required(
      env.CNYOS_TARGET_CONTROLLER_RUN_ID || runtime.runId,
      'CNYOS_CONTROLLER_TARGET_RUN_ID_REQUIRED',
      32
    ) || evidence.controllerRunAttempt !== 1 ||
    evidence.target?.netlifySiteId !== POLICY.target.netlifySiteId ||
    evidence.target?.netlifyOrigin !== POLICY.target.netlifyOrigin) {
    fail('CNYOS_CONTROLLER_AUTHORIZATION_EVIDENCE_INVALID');
  }
  const authorizationExpiresAt = canonicalIsoTimestamp(
    evidence.authorizationExpiresAt,
    'CNYOS_CONTROLLER_AUTHORIZATION_EVIDENCE_EXPIRY_INVALID'
  );
  const deploymentBoundaryExpiresAt = canonicalIsoTimestamp(
    evidence.deploymentControlBoundaryExpiresAt,
    'CNYOS_CONTROLLER_AUTHORIZATION_EVIDENCE_EXPIRY_INVALID'
  );
  if (!allowExpired && (authorizationExpiresAt <= now || deploymentBoundaryExpiresAt <= now)) {
    fail('CNYOS_CONTROLLER_AUTHORIZATION_EVIDENCE_EXPIRED');
  }
}

async function exactSiteInventory(fetchImpl, token, expectedSubject) {
  const principal = await netlifyJson(fetchImpl, token, '/user');
  if (!isPlainObject(principal.value) ||
    String(principal.value.id || '') !== required(
      expectedSubject,
      'CNYOS_CONTROLLER_NETLIFY_PRINCIPAL_SUBJECT_REQUIRED',
      200
    )) {
    fail('CNYOS_CONTROLLER_NETLIFY_PRINCIPAL_SUBJECT_MISMATCH');
  }
  const result = await netlifyJson(fetchImpl, token, '/sites?per_page=100&page=1');
  noNextPage(result.response);
  if (!Array.isArray(result.value) || result.value.length !== 1) {
    fail('CNYOS_CONTROLLER_NETLIFY_PRINCIPAL_NOT_STAGING_ONLY');
  }
  assertSiteIdentity(result.value[0]);
  return Object.freeze({
    inventoryComplete: true,
    subject: String(principal.value.id),
    accessibleSiteCount: 1,
    accessibleSiteIds: Object.freeze([POLICY.target.netlifySiteId]),
    nonStagingSiteAccess: false
  });
}

function assertFreshPreflight(preflight, runtime, now) {
  if (!isPlainObject(preflight) || preflight.schemaVersion !== 1 ||
    preflight.evidenceType !== 'cnyos_staging_controller_preflight' ||
    preflight.productionAuthorization !== false ||
    preflight.controllerRepository !== runtime.repository ||
    preflight.controllerRef !== runtime.ref || preflight.controllerCommit !== runtime.commit ||
    preflight.controllerRunId !== runtime.runId ||
    preflight.target?.netlifySiteId !== POLICY.target.netlifySiteId ||
    !DEPLOY_ID.test(String(preflight.previousPublishedDeploy?.id || ''))) {
    fail('CNYOS_CONTROLLER_PREFLIGHT_EVIDENCE_INVALID');
  }
  const authorizationExpiresAt = canonicalIsoTimestamp(
    preflight.authorizationExpiresAt,
    'CNYOS_CONTROLLER_PREFLIGHT_AUTHORIZATION_EXPIRY_INVALID'
  );
  const principalProofExpiresAt = canonicalIsoTimestamp(
    preflight.principalProofExpiresAt,
    'CNYOS_CONTROLLER_PREFLIGHT_PRINCIPAL_EXPIRY_INVALID'
  );
  const liveAuthorityExpiresAt = canonicalIsoTimestamp(
    preflight.liveNetlifyAuthorityBoundaryExpiresAt,
    'CNYOS_CONTROLLER_PREFLIGHT_LIVE_AUTHORITY_EXPIRY_INVALID'
  );
  const deploymentBoundaryExpiresAt = canonicalIsoTimestamp(
    preflight.deploymentControlBoundaryExpiresAt,
    'CNYOS_CONTROLLER_PREFLIGHT_DEPLOYMENT_BOUNDARY_EXPIRY_INVALID'
  );
  if (authorizationExpiresAt <= now || principalProofExpiresAt <= now ||
    liveAuthorityExpiresAt <= now || deploymentBoundaryExpiresAt <= now) {
    fail('CNYOS_CONTROLLER_PREFLIGHT_AUTHORIZATION_EXPIRED');
  }
}

function rollbackReadinessMaximumAgeMilliseconds() {
  const minutes = POLICY.rollbackPrincipalMembershipBroker?.maximumEvidenceAgeMinutes;
  const authorizationMinutes = POLICY.authorization?.maximumLifetimeMinutes;
  if (!Number.isSafeInteger(minutes) || minutes <= 0 ||
    !Number.isSafeInteger(authorizationMinutes) || authorizationMinutes <= 0 ||
    minutes > authorizationMinutes) {
    fail('CNYOS_CONTROLLER_ROLLBACK_READINESS_POLICY_INVALID');
  }
  return minutes * 60 * 1000;
}

function validateRollbackReadinessEvidence(value, {
  runtime,
  preflight,
  preflightSha256,
  observedAt
}) {
  const code = 'CNYOS_CONTROLLER_ROLLBACK_READINESS_EVIDENCE_INVALID';
  const maximumAge = rollbackReadinessMaximumAgeMilliseconds();
  const rollbackBoundary = preflight.rollbackNetlifyPrincipalBoundary;
  const verifiedAt = recentCanonicalTimestamp(
    value?.verifiedAt,
    observedAt,
    maximumAge,
    'CNYOS_CONTROLLER_ROLLBACK_READINESS_EVIDENCE_STALE'
  );
  const expiresAt = canonicalIsoTimestamp(value?.expiresAt, code);
  const authorizationExpiresAt = canonicalIsoTimestamp(
    preflight.authorizationExpiresAt,
    code
  );
  if (!isPlainObject(value) || value.evidenceType !==
      'cnyos_staging_controller_rollback_readiness' ||
    value.status !== 'passed' || value.scope !== 'cnyos_staging_only' ||
    value.productionAuthorization !== false ||
    value.controllerRepository !== runtime.repository ||
    value.controllerRef !== runtime.ref || value.controllerCommit !== runtime.commit ||
    value.controllerRunId !== runtime.runId ||
    value.preflightEvidenceSha256 !== preflightSha256 ||
    value.target?.netlifySiteId !== POLICY.target.netlifySiteId ||
    value.principalSubject !== rollbackBoundary?.subject ||
    value.membershipRole !== rollbackBoundary?.membershipRole ||
    value.membershipEvidenceSha256 !== rollbackBoundary?.membershipEvidenceSha256 ||
    value.teamOwner !== false || value.teamAdministrator !== false ||
    value.siteAccessScope !== 'single_site' || value.liveTokenVerified !== true ||
    value.inventoryComplete !== true || value.accessibleSiteCount !== 1 ||
    !Array.isArray(value.allowedSiteIds) || value.allowedSiteIds.length !== 1 ||
    value.allowedSiteIds[0] !== POLICY.target.netlifySiteId ||
    value.restoreCapabilityVerified !== true || value.productionAccess !== false ||
    value.secretValuesSerialized !== false || expiresAt <= observedAt ||
    expiresAt <= verifiedAt || expiresAt.getTime() - verifiedAt.getTime() > maximumAge ||
    expiresAt > authorizationExpiresAt) {
    fail(code);
  }
  assertPolicyTarget(value.target, code);
  return Object.freeze({ verifiedAt, expiresAt });
}

function validatePromotionDraftGate(value, {
  runtime,
  preflight,
  preflightSha256,
  rollbackReadinessSha256,
  observedAt
}) {
  const code = 'CNYOS_CONTROLLER_DRAFT_GATE_EVIDENCE_INVALID';
  recentCanonicalTimestamp(
    value?.checkedAt,
    observedAt,
    rollbackReadinessMaximumAgeMilliseconds(),
    'CNYOS_CONTROLLER_DRAFT_GATE_EVIDENCE_STALE'
  );
  if (!isPlainObject(value) || value.evidenceType !== 'cnyos_staging_controller_draft_gate' ||
    value.authorization !== false || value.promotionAuthorization !== false ||
    value.productionAuthorization !== false || value.scope !== 'cnyos_staging_only' ||
    value.controllerRepository !== runtime.repository || value.controllerRef !== runtime.ref ||
    value.controllerCommit !== runtime.commit || value.controllerRunId !== runtime.runId ||
    value.dispatchNonce !== preflight.dispatchNonce ||
    value.source?.repository !== preflight.source?.repository ||
    value.source?.commit !== preflight.source?.commit ||
    value.source?.tree !== preflight.source?.tree ||
    value.artifact?.artifactSha256 !== preflight.artifact?.artifactSha256 ||
    value.previousDeployId !== preflight.previousPublishedDeploy?.id ||
    value.preflightEvidenceSha256 !== preflightSha256 ||
    value.rollbackReadinessEvidenceSha256 !== rollbackReadinessSha256 ||
    value.deployMessage !== deploymentMarker(
      runtime.runId,
      preflight.dispatchNonce,
      preflight.source?.commit
    )) {
    fail(code);
  }
  assertPolicyTarget(value.target, code);
}

async function loadAndValidatePromotionRecoveryChain(env, runtime, preflight, observedAt) {
  const rollbackReadiness = await loadEvidence(
    required(env.CNYOS_CONTROLLER_ROLLBACK_READINESS_EVIDENCE_PATH,
      'CNYOS_CONTROLLER_ROLLBACK_READINESS_EVIDENCE_PATH_REQUIRED', 4096),
    env.CNYOS_EXPECTED_ROLLBACK_READINESS_EVIDENCE_SHA256,
    'CNYOS_CONTROLLER_ROLLBACK_READINESS_EVIDENCE_INVALID'
  );
  const draftGate = await loadEvidence(
    required(env.CNYOS_CONTROLLER_DRAFT_GATE_EVIDENCE_PATH,
      'CNYOS_CONTROLLER_DRAFT_GATE_EVIDENCE_PATH_REQUIRED', 4096),
    env.CNYOS_EXPECTED_DRAFT_GATE_EVIDENCE_SHA256,
    'CNYOS_CONTROLLER_DRAFT_GATE_EVIDENCE_INVALID'
  );
  validateRollbackReadinessEvidence(rollbackReadiness.value, {
    runtime,
    preflight: preflight.value,
    preflightSha256: preflight.sha256,
    observedAt
  });
  validatePromotionDraftGate(draftGate.value, {
    runtime,
    preflight: preflight.value,
    preflightSha256: preflight.sha256,
    rollbackReadinessSha256: rollbackReadiness.sha256,
    observedAt
  });
  return Object.freeze({ rollbackReadiness, draftGate });
}

export function validateLiveNetlifyAuthorityBoundary(value, {
  runtime,
  authorization,
  now
}) {
  const code = 'CNYOS_CONTROLLER_LIVE_NETLIFY_AUTHORITY_BOUNDARY_INVALID';
  assertExactKeys(value, [
    'schemaVersion', 'evidenceType', 'status', 'scope', 'productionAuthorization',
    'observedAt', 'expiresAt', 'controllerRepository', 'controllerRef',
    'controllerCommit', 'controllerRunId', 'dispatchNonce', 'source', 'artifact',
    'target', 'publishPrincipal', 'deploymentBoundary', 'brokerAttestation',
    'secretValuesSerialized'
  ], code);
  assertExactKeys(value.source, ['repository', 'commit', 'tree'], code);
  assertExactKeys(value.artifact, ['artifactSha256'], code);
  assertExactKeys(value.target, Object.keys(POLICY.target), code);
  assertExactKeys(value.publishPrincipal, [
    'subject', 'membershipRole', 'teamOwner', 'teamAdministrator',
    'siteAccessScope', 'accountConfigurationCapabilityAbsent',
    'teamAdministrationCapabilityAbsent', 'deployCapabilityVerified',
    'inventoryComplete', 'accessibleSiteCount', 'allowedSiteIds',
    'productionAccess', 'membershipLiveVerified'
  ], code);
  assertExactKeys(value.deploymentBoundary, [
    'targetSiteClassifiedStagingOnly', 'realPatientDataAbsent',
    'legacyPublisherInventoryComplete', 'candidateRepositoryProductionWorkflowTargetDenied',
    'candidateRepositoryPreviewWorkflowTargetDenied',
    'allAlternatePublisherCredentialsTargetDenied',
    'currentCnyosProductionMappingConflictResolved', 'netlifyGitPublishingDisabled',
    'buildHooksDisabled', 'manualUiPublishingDenied', 'publisherInventoryLiveVerified'
  ], code);
  assertExactKeys(value.brokerAttestation, [
    'origin', 'policyId', 'policySha256', 'signingKeyId', 'signingKeySpkiSha256',
    'signatureAlgorithm', 'signatureVerified', 'statementSha256', 'evidenceReference'
  ], code);
  const brokerOrigin = safeOrigin(
    POLICY.netlifyAuthorityBoundary?.origin,
    'CNYOS_CONTROLLER_NETLIFY_AUTHORITY_POLICY_INVALID'
  );
  const policyId = required(
    POLICY.netlifyAuthorityBoundary?.policyId,
    'CNYOS_CONTROLLER_NETLIFY_AUTHORITY_POLICY_INVALID',
    200
  );
  if (/^__[A-Z0-9_]+__$/.test(policyId)) {
    fail('CNYOS_CONTROLLER_NETLIFY_AUTHORITY_POLICY_INVALID');
  }
  const policySha256 = exactSha256(
    POLICY.netlifyAuthorityBoundary?.policySha256,
    'CNYOS_CONTROLLER_NETLIFY_AUTHORITY_POLICY_INVALID'
  );
  const signingKeyId = required(
    POLICY.netlifyAuthorityBoundary?.signingKeyId,
    'CNYOS_CONTROLLER_NETLIFY_AUTHORITY_POLICY_INVALID',
    200
  );
  if (/^__[A-Z0-9_]+__$/.test(signingKeyId)) {
    fail('CNYOS_CONTROLLER_NETLIFY_AUTHORITY_POLICY_INVALID');
  }
  const signingKeySpkiSha256 = exactSha256(
    POLICY.netlifyAuthorityBoundary?.signingKeySpkiSha256,
    'CNYOS_CONTROLLER_NETLIFY_AUTHORITY_POLICY_INVALID'
  );
  const maximumAge = POLICY.netlifyAuthorityBoundary?.maximumAgeMinutes * 60 * 1000;
  if (!Number.isSafeInteger(maximumAge) || maximumAge <= 0 ||
    maximumAge > POLICY.authorization.maximumLifetimeMinutes * 60 * 1000) {
    fail('CNYOS_CONTROLLER_NETLIFY_AUTHORITY_POLICY_INVALID');
  }
  const observedAt = recentCanonicalTimestamp(value.observedAt, now, maximumAge, code);
  const expiresAt = canonicalIsoTimestamp(value.expiresAt, code);
  const authorizationExpiresAt = canonicalIsoTimestamp(
    authorization.authorizationExpiresAt,
    code
  );
  const principal = value.publishPrincipal;
  const boundary = value.deploymentBoundary;
  const signedStatement = Object.freeze({
    schemaVersion: value.schemaVersion,
    evidenceType: value.evidenceType,
    status: value.status,
    scope: value.scope,
    productionAuthorization: value.productionAuthorization,
    observedAt: value.observedAt,
    expiresAt: value.expiresAt,
    controllerRepository: value.controllerRepository,
    controllerRef: value.controllerRef,
    controllerCommit: value.controllerCommit,
    controllerRunId: value.controllerRunId,
    dispatchNonce: value.dispatchNonce,
    source: value.source,
    artifact: value.artifact,
    target: value.target,
    publishPrincipal: value.publishPrincipal,
    deploymentBoundary: value.deploymentBoundary,
    brokerOrigin,
    brokerPolicyId: policyId,
    brokerPolicySha256: policySha256,
    signingKeyId,
    signingKeySpkiSha256
  });
  const expectedStatementSha256 = sha256(JSON.stringify(signedStatement));
  if (value.schemaVersion !== 1 ||
    value.evidenceType !== 'cnyos_staging_controller_live_netlify_authority_boundary' ||
    value.status !== 'passed' || value.scope !== 'cnyos_staging_only' ||
    value.productionAuthorization !== false || value.secretValuesSerialized !== false ||
    value.controllerRepository !== runtime.repository || value.controllerRef !== runtime.ref ||
    value.controllerCommit !== runtime.commit || value.controllerRunId !== runtime.runId ||
    value.dispatchNonce !== authorization.dispatchNonce ||
    value.source.repository !== POLICY.sourceRepository ||
    value.source.commit !== authorization.source?.commit ||
    value.source.tree !== authorization.source?.tree ||
    value.artifact.artifactSha256 !== authorization.artifact?.artifactSha256 ||
    value.target.netlifySiteId !== POLICY.target.netlifySiteId ||
    value.target.netlifyOrigin !== POLICY.target.netlifyOrigin ||
    principal.subject !== authorization.netlifyPrincipalSubject ||
    principal.membershipRole !== authorization.netlifyPrincipalBoundary?.membershipRole ||
    principal.teamOwner !== false || principal.teamAdministrator !== false ||
    principal.siteAccessScope !== 'single_site' ||
    principal.accountConfigurationCapabilityAbsent !== true ||
    principal.teamAdministrationCapabilityAbsent !== true ||
    principal.deployCapabilityVerified !== true || principal.membershipLiveVerified !== true ||
    principal.inventoryComplete !== true || principal.accessibleSiteCount !== 1 ||
    !Array.isArray(principal.allowedSiteIds) || principal.allowedSiteIds.length !== 1 ||
    principal.allowedSiteIds[0] !== POLICY.target.netlifySiteId ||
    principal.productionAccess !== false ||
    boundary.targetSiteClassifiedStagingOnly !== true ||
    boundary.realPatientDataAbsent !== true ||
    boundary.legacyPublisherInventoryComplete !== true ||
    boundary.candidateRepositoryProductionWorkflowTargetDenied !== true ||
    boundary.candidateRepositoryPreviewWorkflowTargetDenied !== true ||
    boundary.allAlternatePublisherCredentialsTargetDenied !== true ||
    boundary.currentCnyosProductionMappingConflictResolved !== true ||
    boundary.netlifyGitPublishingDisabled !== true || boundary.buildHooksDisabled !== true ||
    boundary.manualUiPublishingDenied !== true ||
    boundary.publisherInventoryLiveVerified !== true ||
    safeOrigin(value.brokerAttestation.origin, code) !== brokerOrigin ||
    value.brokerAttestation.policyId !== policyId ||
    value.brokerAttestation.policySha256 !== policySha256 ||
    value.brokerAttestation.signingKeyId !== signingKeyId ||
    value.brokerAttestation.signingKeySpkiSha256 !== signingKeySpkiSha256 ||
    value.brokerAttestation.signatureAlgorithm !== 'ed25519' ||
    value.brokerAttestation.signatureVerified !== true ||
    value.brokerAttestation.statementSha256 !== expectedStatementSha256 ||
    typeof value.brokerAttestation.evidenceReference !== 'string' ||
    value.brokerAttestation.evidenceReference.trim().length < 8 ||
    value.brokerAttestation.evidenceReference.length > 500 ||
    expiresAt <= now || expiresAt <= observedAt ||
    expiresAt.getTime() - observedAt.getTime() > maximumAge ||
    expiresAt > authorizationExpiresAt) {
    fail(code);
  }
  assertPolicyTarget(value.target, code);
  return Object.freeze({ observedAt, expiresAt });
}

export function parseDeployReceipt(value) {
  if (!isPlainObject(value)) fail('CNYOS_CONTROLLER_NETLIFY_CLI_RECEIPT_INVALID');
  const ids = [value.deploy_id, value.deployId, value.id]
    .map(item => String(item || '').trim().toLowerCase())
    .filter(Boolean);
  const unique = [...new Set(ids)];
  if (unique.length !== 1 || !DEPLOY_ID.test(unique[0])) {
    fail('CNYOS_CONTROLLER_NETLIFY_CLI_RECEIPT_ID_INVALID');
  }
  if (value.site_id !== undefined && String(value.site_id).toLowerCase() !== POLICY.target.netlifySiteId) {
    fail('CNYOS_CONTROLLER_NETLIFY_CLI_RECEIPT_SITE_INVALID');
  }
  if (value.site_name !== undefined &&
    String(value.site_name).toLowerCase() !== POLICY.target.netlifySiteName) {
    fail('CNYOS_CONTROLLER_NETLIFY_CLI_RECEIPT_SITE_INVALID');
  }
  const origin = safeOrigin(
    value.deploy_ssl_url || value.deploy_url,
    'CNYOS_CONTROLLER_NETLIFY_CLI_RECEIPT_ORIGIN_INVALID'
  );
  if (origin !== exactDeployOrigin(unique[0])) {
    fail('CNYOS_CONTROLLER_NETLIFY_CLI_RECEIPT_ORIGIN_INVALID');
  }
  return Object.freeze({ deployId: unique[0], exactDeployOrigin: origin });
}

export async function captureNetlifyPreflight({
  env = process.env,
  fetchImpl = fetch,
  now = () => new Date()
} = {}) {
  const runtime = assertControllerRuntime(env);
  const observedAt = now();
  if (!(observedAt instanceof Date) || Number.isNaN(observedAt.getTime())) fail('CNYOS_CONTROLLER_TIME_INVALID');
  const authorization = await loadEvidence(
    required(env.CNYOS_CONTROLLER_AUTHORIZATION_EVIDENCE_PATH,
      'CNYOS_CONTROLLER_AUTHORIZATION_EVIDENCE_PATH_REQUIRED', 4096),
    env.CNYOS_EXPECTED_AUTHORIZATION_EVIDENCE_SHA256,
    'CNYOS_CONTROLLER_AUTHORIZATION_EVIDENCE_INVALID'
  );
  assertAuthorization(authorization.value, runtime, env, observedAt);
  const rollbackAttestationDeposit = await loadEvidence(
    required(env.CNYOS_CONTROLLER_ROLLBACK_ATTESTATION_DEPOSIT_EVIDENCE_PATH,
      'CNYOS_CONTROLLER_ROLLBACK_ATTESTATION_DEPOSIT_EVIDENCE_PATH_REQUIRED', 4096),
    env.CNYOS_EXPECTED_ROLLBACK_ATTESTATION_DEPOSIT_EVIDENCE_SHA256,
    'CNYOS_CONTROLLER_ROLLBACK_ATTESTATION_DEPOSIT_EVIDENCE_INVALID'
  );
  const depositMaximumAge = POLICY.rollbackAttestationBroker?.maximumReceiptAgeMinutes *
    60 * 1000;
  if (!Number.isSafeInteger(depositMaximumAge) || depositMaximumAge <= 0) {
    fail('CNYOS_CONTROLLER_ROLLBACK_ATTESTATION_DEPOSIT_EVIDENCE_INVALID');
  }
  recentCanonicalTimestamp(
    rollbackAttestationDeposit.value.verifiedAt,
    observedAt,
    depositMaximumAge,
    'CNYOS_CONTROLLER_ROLLBACK_ATTESTATION_DEPOSIT_EVIDENCE_STALE'
  );
  minimumFutureTimestamp(
    rollbackAttestationDeposit.value.retentionUntil,
    observedAt,
    POLICY.rollbackAttestationBroker.minimumRetentionDays * 24 * 60 * 60 * 1000,
    'CNYOS_CONTROLLER_ROLLBACK_ATTESTATION_RETENTION_INSUFFICIENT'
  );
  if (rollbackAttestationDeposit.value.evidenceType !==
      'cnyos_staging_rollback_attestation_deposit_validation' ||
    rollbackAttestationDeposit.value.status !== 'passed' ||
    rollbackAttestationDeposit.value.scope !== 'cnyos_staging_only' ||
    rollbackAttestationDeposit.value.productionAuthorization !== false ||
    rollbackAttestationDeposit.value.realPatientDataAuthorized !== false ||
    rollbackAttestationDeposit.value.secretValuesSerialized !== false ||
    rollbackAttestationDeposit.value.rawPayloadArtifactExposure !== false ||
    rollbackAttestationDeposit.value.controllerRepository !== runtime.repository ||
    rollbackAttestationDeposit.value.controllerRef !== runtime.ref ||
    rollbackAttestationDeposit.value.controllerCommit !== runtime.commit ||
    rollbackAttestationDeposit.value.controllerWorkflowPath !== runtime.workflowPath ||
    rollbackAttestationDeposit.value.controllerRunId !== runtime.runId ||
    rollbackAttestationDeposit.value.controllerRunAttempt !== 1 ||
    rollbackAttestationDeposit.value.dispatchNonce !== authorization.value.dispatchNonce ||
    rollbackAttestationDeposit.value.policySha256 !== POLICY_SHA256 ||
    rollbackAttestationDeposit.value.source?.commit !== authorization.value.source?.commit ||
    rollbackAttestationDeposit.value.source?.tree !== authorization.value.source?.tree ||
    rollbackAttestationDeposit.value.source?.functionSourceTree !==
      authorization.value.source?.functionSourceTree ||
    rollbackAttestationDeposit.value.artifact?.producerManifestSha256 !==
      authorization.value.artifact?.producerManifestSha256 ||
    rollbackAttestationDeposit.value.artifact?.artifactSha256 !==
      authorization.value.artifact?.artifactSha256 ||
    rollbackAttestationDeposit.value.authorizationPacketSha256 !==
      authorization.value.authorizationPacketSha256 ||
    rollbackAttestationDeposit.value.approverRegistrySha256 !==
      authorization.value.approverRegistrySha256 ||
    rollbackAttestationDeposit.value.independentSecurityReviewerSignatureSha256 !==
      authorization.value.signatureSha256?.independentSecurityReviewer ||
    rollbackAttestationDeposit.value.managedPlatformRiskOwnerSignatureSha256 !==
      authorization.value.signatureSha256?.managedPlatformRiskOwner ||
    rollbackAttestationDeposit.value.knownGoodEvidenceSha256 !==
      authorization.value.knownGoodRollbackEvidenceSha256 ||
    rollbackAttestationDeposit.value.previousDeployId !== authorization.value.previousDeployId ||
    rollbackAttestationDeposit.value.target?.netlifySiteId !== POLICY.target.netlifySiteId ||
    rollbackAttestationDeposit.value.target?.netlifyOrigin !== POLICY.target.netlifyOrigin ||
    rollbackAttestationDeposit.value.target?.supabaseProjectRef !== POLICY.target.supabaseProjectRef ||
    rollbackAttestationDeposit.value.target?.databaseSystemIdentifier !==
      POLICY.target.databaseSystemIdentifier ||
    rollbackAttestationDeposit.value.immutableAppendOnlyDepositVerified !== true ||
    rollbackAttestationDeposit.value.exactRunNonceRetrievalBoundaryVerified !== true ||
    !/^[0-9a-f]{64}$/.test(String(
      rollbackAttestationDeposit.value.depositReceiptSha256 || ''
    ))) {
    fail('CNYOS_CONTROLLER_ROLLBACK_ATTESTATION_DEPOSIT_EVIDENCE_INVALID');
  }
  const liveNetlifyAuthorityBoundary = await loadEvidence(
    required(env.CNYOS_CONTROLLER_LIVE_NETLIFY_AUTHORITY_EVIDENCE_PATH,
      'CNYOS_CONTROLLER_LIVE_NETLIFY_AUTHORITY_EVIDENCE_PATH_REQUIRED', 4096),
    env.CNYOS_EXPECTED_LIVE_NETLIFY_AUTHORITY_EVIDENCE_SHA256,
    'CNYOS_CONTROLLER_LIVE_NETLIFY_AUTHORITY_BOUNDARY_INVALID'
  );
  const liveAuthorityWindow = validateLiveNetlifyAuthorityBoundary(
    liveNetlifyAuthorityBoundary.value,
    { runtime, authorization: authorization.value, now: observedAt }
  );
  const functionEnvironment = await loadEvidence(
    required(env.CNYOS_CONTROLLER_FUNCTION_ENV_EVIDENCE_PATH,
      'CNYOS_CONTROLLER_FUNCTION_ENV_EVIDENCE_PATH_REQUIRED', 4096),
    env.CNYOS_EXPECTED_FUNCTION_ENV_EVIDENCE_SHA256,
    'CNYOS_CONTROLLER_FUNCTION_ENV_EVIDENCE_INVALID'
  );
  const expectedVariableNames = Object.keys(POLICY.functionEnvironment).sort();
  const expectedValuesSha256 = sha256(JSON.stringify(
    Object.entries(POLICY.functionEnvironment).sort(([left], [right]) => left.localeCompare(right))
  ));
  if (functionEnvironment.value.evidenceType !==
      'cnyos_staging_controller_function_environment_validation' ||
    functionEnvironment.value.status !== 'passed' ||
    functionEnvironment.value.controllerRunId !== runtime.runId ||
    functionEnvironment.value.controllerCommit !== runtime.commit ||
    functionEnvironment.value.policySha256 !== POLICY_SHA256 ||
    JSON.stringify(functionEnvironment.value.validatedVariableNames) !== JSON.stringify(expectedVariableNames) ||
    functionEnvironment.value.exactValuesSha256 !== expectedValuesSha256 ||
    functionEnvironment.value.productionDenylistConfirmed !== true ||
    functionEnvironment.value.valuesSerialized !== false) {
    fail('CNYOS_CONTROLLER_FUNCTION_ENV_EVIDENCE_INVALID');
  }
  const runtimeCapability = await loadEvidence(
    required(env.CNYOS_CONTROLLER_RUNTIME_CAPABILITY_EVIDENCE_PATH,
      'CNYOS_CONTROLLER_RUNTIME_CAPABILITY_EVIDENCE_PATH_REQUIRED', 4096),
    env.CNYOS_EXPECTED_RUNTIME_CAPABILITY_EVIDENCE_SHA256,
    'CNYOS_CONTROLLER_RUNTIME_CAPABILITY_EVIDENCE_INVALID'
  );
  if (runtimeCapability.value.evidenceType !==
      'cnyos_staging_controller_runtime_capability_boundary' ||
    runtimeCapability.value.status !== 'passed' ||
    runtimeCapability.value.controllerRunId !== runtime.runId ||
    runtimeCapability.value.controllerCommit !== runtime.commit ||
    runtimeCapability.value.policySha256 !== POLICY_SHA256 ||
    runtimeCapability.value.source?.commit !== authorization.value.source?.commit ||
    runtimeCapability.value.artifact?.artifactSha256 !== authorization.value.artifact?.artifactSha256 ||
    runtimeCapability.value.projectRef !== POLICY.target.supabaseProjectRef ||
    runtimeCapability.value.netlifySiteId !== POLICY.target.netlifySiteId ||
    runtimeCapability.value.platformControlEnabled !== false ||
    runtimeCapability.value.ownerDriveEnabled !== false ||
    runtimeCapability.value.restoreSourceApiEnabled !== false ||
    runtimeCapability.value.pubmedEnabled !== false ||
    runtimeCapability.value.directJsonRestoreTestEnabled !== false ||
    runtimeCapability.value.ownerControlEnabled !== false ||
    runtimeCapability.value.ownerControlScope !== 'disabled' ||
    runtimeCapability.value.githubProductionDispatchReachable !== false ||
    runtimeCapability.value.driveOrBlobProductionReachable !== false ||
    runtimeCapability.value.lineProductionReachable !== false ||
    runtimeCapability.value.protectedSecretPresenceVerified !== true ||
    runtimeCapability.value.functionEnvironmentAllowlistComplete !== true ||
    runtimeCapability.value.functionSecretInventoryClosedWorld !== true ||
    runtimeCapability.value.browserProcessEnvironmentSanitized !== true ||
    runtimeCapability.value.candidateFunctionEgressPolicyEnforced !== true ||
    runtimeCapability.value.productionCredentialAbsenceVerified !== true ||
    runtimeCapability.value.stagingOnlyCredentialScopeVerified !== true ||
    runtimeCapability.value.serviceRoleNotInheritedByBrowserProcess !== true ||
    runtimeCapability.value.candidateFunctionsReceiveOnlyReviewedStagingSecrets !== true ||
    runtimeCapability.value.secretValuesSerialized !== false ||
    runtimeCapability.value.realPatientDataAuthorized !== false) {
    fail('CNYOS_CONTROLLER_RUNTIME_CAPABILITY_EVIDENCE_INVALID');
  }
  const backupDisable = await loadEvidence(
    required(env.CNYOS_CONTROLLER_BACKUP_DISABLE_EVIDENCE_PATH,
      'CNYOS_CONTROLLER_BACKUP_DISABLE_EVIDENCE_PATH_REQUIRED', 4096),
    env.CNYOS_EXPECTED_BACKUP_DISABLE_EVIDENCE_SHA256,
    'CNYOS_CONTROLLER_BACKUP_DISABLE_EVIDENCE_INVALID'
  );
  const token = required(env.CNYOS_STAGING_NETLIFY_AUTH_TOKEN,
    'CNYOS_CONTROLLER_NETLIFY_TOKEN_REQUIRED', 4096);
  const principalProof = await exactSiteInventory(
    fetchImpl,
    token,
    authorization.value.netlifyPrincipalSubject
  );
  if (principalProof.subject !== liveNetlifyAuthorityBoundary.value.publishPrincipal.subject ||
    principalProof.accessibleSiteCount !==
      liveNetlifyAuthorityBoundary.value.publishPrincipal.accessibleSiteCount ||
    JSON.stringify(principalProof.accessibleSiteIds) !== JSON.stringify(
      liveNetlifyAuthorityBoundary.value.publishPrincipal.allowedSiteIds
    )) {
    fail('CNYOS_CONTROLLER_LIVE_NETLIFY_AUTHORITY_BOUNDARY_MISMATCH');
  }
  const siteResponse = await netlifyJson(
    fetchImpl,
    token,
    `/sites/${encodeURIComponent(POLICY.target.netlifySiteId)}`
  );
  const previousDeployId = assertSite(siteResponse.value);
  if (previousDeployId !== authorization.value.previousDeployId) {
    fail('CNYOS_CONTROLLER_SIGNED_ROLLBACK_TARGET_CHANGED');
  }
  const deployResponse = await netlifyJson(
    fetchImpl,
    token,
    `/deploys/${encodeURIComponent(previousDeployId)}`
  );
  assertDeploy(deployResponse.value, previousDeployId, { expectedPublished: true, expectedDraft: false });
  const maximumEvidenceAge = POLICY.databaseEvidence.maximumAgeMinutes * 60 * 1000;
  const deployCreatedAt = canonicalIsoTimestamp(
    deployResponse.value.created_at,
    'CNYOS_CONTROLLER_BACKUP_DISABLE_DEPLOY_TIMESTAMP_INVALID'
  );
  const configuredAt = canonicalIsoTimestamp(
    backupDisable.value.backupDisabledConfiguredAt,
    'CNYOS_CONTROLLER_BACKUP_DISABLE_EVIDENCE_INVALID'
  );
  const backupValidatedAt = recentCanonicalTimestamp(
    backupDisable.value.validatedAt,
    observedAt,
    maximumEvidenceAge,
    'CNYOS_CONTROLLER_BACKUP_DISABLE_EVIDENCE_STALE'
  );
  const handlerVerifiedAt = recentCanonicalTimestamp(
    backupDisable.value.handlerFailClosed?.verifiedAt,
    observedAt,
    maximumEvidenceAge,
    'CNYOS_CONTROLLER_BACKUP_DISABLE_EVIDENCE_STALE'
  );
  if (backupDisable.value.evidenceType !==
      'cnyos_staging_controller_backup_disable_runtime_boundary' ||
    backupDisable.value.status !== 'passed' ||
    backupDisable.value.controllerRunId !== runtime.runId ||
    backupDisable.value.controllerCommit !== runtime.commit ||
    backupDisable.value.policySha256 !== POLICY_SHA256 ||
    backupDisable.value.source?.commit !== authorization.value.source?.commit ||
    backupDisable.value.artifact?.artifactSha256 !== authorization.value.artifact?.artifactSha256 ||
    backupDisable.value.target?.netlifySiteId !== POLICY.target.netlifySiteId ||
    backupDisable.value.target?.supabaseProjectRef !== POLICY.target.supabaseProjectRef ||
    backupDisable.value.currentDeployId !== previousDeployId ||
    backupDisable.value.currentDeployCreatedAt !== deployResponse.value.created_at ||
    backupDisable.value.backupEnabled !== false ||
    backupDisable.value.configuredBeforeDeploy !== true || configuredAt >= deployCreatedAt ||
    backupValidatedAt < deployCreatedAt || handlerVerifiedAt > backupValidatedAt ||
    backupDisable.value.handlerFailClosed?.dailyBeforeConfigurationOrSupabase !== true ||
    backupDisable.value.handlerFailClosed?.recoveryBeforeConfigurationOrSupabase !== true ||
    backupDisable.value.handlerFailClosed?.backgroundBeforeConfigurationOrSupabase !== true ||
    !/^[0-9a-f]{64}$/.test(String(
      backupDisable.value.handlerFailClosed?.evidenceSha256 || ''
    )) || typeof backupDisable.value.handlerFailClosed?.evidenceReference !== 'string' ||
    backupDisable.value.handlerFailClosed.evidenceReference.trim().length < 8 ||
    backupDisable.value.secretValuesSerialized !== false) {
    fail('CNYOS_CONTROLLER_BACKUP_DISABLE_EVIDENCE_INVALID');
  }
  const evidence = Object.freeze({
    schemaVersion: 1,
    evidenceType: 'cnyos_staging_controller_preflight',
    authorization: false,
    scope: 'cnyos_staging_only',
    productionAuthorization: false,
    capturedAt: observedAt.toISOString(),
    controllerRepository: runtime.repository,
    controllerRef: runtime.ref,
    controllerCommit: runtime.commit,
    controllerRunId: authorization.value.controllerRunId,
    dispatchNonce: authorization.value.dispatchNonce,
    source: authorization.value.source,
    artifact: authorization.value.artifact,
    target: POLICY.target,
    authorizationEvidenceSha256: authorization.sha256,
    rollbackAttestationDepositEvidenceSha256: rollbackAttestationDeposit.sha256,
    rollbackAttestationDepositReceiptSha256:
      rollbackAttestationDeposit.value.depositReceiptSha256,
    rollbackAttestationDepositId: rollbackAttestationDeposit.value.depositId,
    rollbackAttestationRetentionUntil: rollbackAttestationDeposit.value.retentionUntil,
    authorizationExpiresAt: authorization.value.authorizationExpiresAt,
    deploymentControlBoundaryExpiresAt:
      authorization.value.deploymentControlBoundaryExpiresAt,
    principalProofExpiresAt: authorization.value.principalProofExpiresAt,
    liveNetlifyAuthorityBoundaryEvidenceSha256: liveNetlifyAuthorityBoundary.sha256,
    liveNetlifyAuthorityBoundaryExpiresAt: liveAuthorityWindow.expiresAt.toISOString(),
    principalProof,
    netlifyPrincipalBoundary: authorization.value.netlifyPrincipalBoundary,
    rollbackNetlifyPrincipalSubject: authorization.value.rollbackNetlifyPrincipalSubject,
    rollbackNetlifyPrincipalBoundary: authorization.value.rollbackNetlifyPrincipalBoundary,
    targetSiteAndPublisherExclusion: authorization.value.targetSiteAndPublisherExclusion,
    functionEnvironmentEvidenceSha256: functionEnvironment.sha256,
    functionEnvironmentExactValuesSha256: expectedValuesSha256,
    runtimeCapabilityEvidenceSha256: runtimeCapability.sha256,
    backupDisableEvidenceSha256: backupDisable.sha256,
    protectedFunctionSecretPresenceVerified: true,
    backupEnabled: false,
    previousPublishedDeploy: sanitizeDeploy(deployResponse.value),
    knownGoodRollbackEvidenceSha256: authorization.value.knownGoodRollbackEvidenceSha256
  });
  const evidencePath = await writeJsonExclusive(
    required(env.CNYOS_CONTROLLER_PREFLIGHT_EVIDENCE_PATH,
      'CNYOS_CONTROLLER_PREFLIGHT_EVIDENCE_PATH_REQUIRED', 4096),
    evidence
  );
  return Object.freeze({ evidence, evidencePath });
}

export async function recordDraftGate({
  env = process.env,
  fetchImpl = fetch,
  now = () => new Date()
} = {}) {
  const runtime = assertControllerRuntime(env);
  const observedAt = now();
  if (!(observedAt instanceof Date) || Number.isNaN(observedAt.getTime())) fail('CNYOS_CONTROLLER_TIME_INVALID');
  const preflight = await loadEvidence(
    required(env.CNYOS_CONTROLLER_PREFLIGHT_EVIDENCE_PATH,
      'CNYOS_CONTROLLER_PREFLIGHT_EVIDENCE_PATH_REQUIRED', 4096),
    env.CNYOS_EXPECTED_PREFLIGHT_EVIDENCE_SHA256,
    'CNYOS_CONTROLLER_PREFLIGHT_EVIDENCE_INVALID'
  );
  assertFreshPreflight(preflight.value, runtime, observedAt);
  const rollbackReadiness = await loadEvidence(
    required(env.CNYOS_CONTROLLER_ROLLBACK_READINESS_EVIDENCE_PATH,
      'CNYOS_CONTROLLER_ROLLBACK_READINESS_EVIDENCE_PATH_REQUIRED', 4096),
    env.CNYOS_EXPECTED_ROLLBACK_READINESS_EVIDENCE_SHA256,
    'CNYOS_CONTROLLER_ROLLBACK_READINESS_EVIDENCE_INVALID'
  );
  validateRollbackReadinessEvidence(rollbackReadiness.value, {
    runtime,
    preflight: preflight.value,
    preflightSha256: preflight.sha256,
    observedAt
  });
  const exclusion = preflight.value.targetSiteAndPublisherExclusion;
  if (exclusion?.targetSiteClassifiedStagingOnly !== true ||
    exclusion?.realPatientDataAbsent !== true ||
    exclusion?.legacyPublisherInventoryComplete !== true ||
    exclusion?.candidateRepositoryProductionWorkflowTargetDenied !== true ||
    exclusion?.candidateRepositoryPreviewWorkflowTargetDenied !== true ||
    exclusion?.allAlternatePublisherCredentialsTargetDenied !== true ||
    exclusion?.currentCnyosProductionMappingConflictResolved !== true) {
    fail('CNYOS_CONTROLLER_ROLLBACK_READINESS_EVIDENCE_INVALID');
  }
  const token = required(env.CNYOS_STAGING_NETLIFY_AUTH_TOKEN,
    'CNYOS_CONTROLLER_NETLIFY_TOKEN_REQUIRED', 4096);
  await exactSiteInventory(fetchImpl, token, preflight.value.principalProof?.subject);
  const site = await netlifyJson(fetchImpl, token,
    `/sites/${encodeURIComponent(POLICY.target.netlifySiteId)}`);
  const previousDeployId = preflight.value.previousPublishedDeploy.id;
  assertSite(site.value, previousDeployId);
  const evidence = Object.freeze({
    schemaVersion: 1,
    evidenceType: 'cnyos_staging_controller_draft_gate',
    authorization: false,
    promotionAuthorization: false,
    productionAuthorization: false,
    scope: 'cnyos_staging_only',
    checkedAt: observedAt.toISOString(),
    controllerRepository: runtime.repository,
    controllerRef: runtime.ref,
    controllerCommit: runtime.commit,
    controllerRunId: runtime.runId,
    dispatchNonce: preflight.value.dispatchNonce,
    source: preflight.value.source,
    artifact: preflight.value.artifact,
    target: POLICY.target,
    previousDeployId,
    preflightEvidenceSha256: preflight.sha256,
    rollbackReadinessEvidenceSha256: rollbackReadiness.sha256,
    deployMessage: deploymentMarker(
      runtime.runId,
      preflight.value.dispatchNonce,
      preflight.value.source.commit
    )
  });
  const evidencePath = await writeJsonExclusive(
    required(env.CNYOS_CONTROLLER_DRAFT_GATE_EVIDENCE_PATH,
      'CNYOS_CONTROLLER_DRAFT_GATE_EVIDENCE_PATH_REQUIRED', 4096),
    evidence
  );
  return Object.freeze({ evidence, evidencePath });
}

export async function recordPromotionAttempt({ env = process.env, now = () => new Date() } = {}) {
  const runtime = assertControllerRuntime(env);
  const preflight = await loadEvidence(
    required(env.CNYOS_CONTROLLER_PREFLIGHT_EVIDENCE_PATH,
      'CNYOS_CONTROLLER_PREFLIGHT_EVIDENCE_PATH_REQUIRED', 4096),
    env.CNYOS_EXPECTED_PREFLIGHT_EVIDENCE_SHA256,
    'CNYOS_CONTROLLER_PREFLIGHT_EVIDENCE_INVALID'
  );
  const verification = await loadEvidence(
    required(env.CNYOS_CONTROLLER_DRAFT_VERIFICATION_EVIDENCE_PATH,
      'CNYOS_CONTROLLER_DRAFT_VERIFICATION_EVIDENCE_PATH_REQUIRED', 4096),
    env.CNYOS_EXPECTED_DRAFT_VERIFICATION_EVIDENCE_SHA256,
    'CNYOS_CONTROLLER_DRAFT_VERIFICATION_EVIDENCE_INVALID'
  );
  const controlBehavior = await loadEvidence(
    required(env.CNYOS_CONTROLLER_CONTROL_BEHAVIOR_EVIDENCE_PATH,
      'CNYOS_CONTROLLER_CONTROL_BEHAVIOR_EVIDENCE_PATH_REQUIRED', 4096),
    env.CNYOS_EXPECTED_CONTROL_BEHAVIOR_EVIDENCE_SHA256,
    'CNYOS_CONTROLLER_CONTROL_BEHAVIOR_EVIDENCE_INVALID'
  );
  const privateDraft = await loadEvidence(
    required(env.CNYOS_CONTROLLER_PRIVATE_DRAFT_EVIDENCE_PATH,
      'CNYOS_CONTROLLER_PRIVATE_DRAFT_EVIDENCE_PATH_REQUIRED', 4096),
    env.CNYOS_EXPECTED_PRIVATE_DRAFT_EVIDENCE_SHA256,
    'CNYOS_CONTROLLER_PRIVATE_DRAFT_EVIDENCE_INVALID'
  );
  const publisherLock = await loadEvidence(
    required(env.CNYOS_CONTROLLER_EXCLUSIVE_PUBLISHER_EVIDENCE_PATH,
      'CNYOS_CONTROLLER_EXCLUSIVE_PUBLISHER_EVIDENCE_PATH_REQUIRED', 4096),
    env.CNYOS_EXPECTED_EXCLUSIVE_PUBLISHER_EVIDENCE_SHA256,
    'CNYOS_CONTROLLER_EXCLUSIVE_PUBLISHER_EVIDENCE_INVALID'
  );
  const marker = deploymentMarker(
    runtime.runId,
    preflight.value.dispatchNonce,
    preflight.value.source.commit
  );
  const observedAt = now();
  if (!(observedAt instanceof Date) || Number.isNaN(observedAt.getTime())) fail('CNYOS_CONTROLLER_TIME_INVALID');
  assertFreshPreflight(preflight.value, runtime, observedAt);
  const recoveryChain = await loadAndValidatePromotionRecoveryChain(
    env,
    runtime,
    preflight,
    observedAt
  );
  if (verification.value.evidenceType !== 'cnyos_staging_controller_draft_verification' ||
    verification.value.status !== 'passed' || verification.value.promotionAuthorization !== false ||
    verification.value.controllerRunId !== runtime.runId ||
    verification.value.source?.commit !== preflight.value.source?.commit ||
    verification.value.artifact?.artifactSha256 !== preflight.value.artifact?.artifactSha256 ||
    verification.value.previousDeployId !== preflight.value.previousPublishedDeploy?.id ||
    verification.value.currentPublishedDeployId !== preflight.value.previousPublishedDeploy?.id ||
    verification.value.authenticatedDraftContentAccessVerified !== true ||
    verification.value.draftAccessCredentialConsumedOnlyAtBoundary !== true ||
    verification.value.draftAccessCredentialForwardedToCandidateOrigin !== false ||
    !/^[0-9a-f]{64}$/.test(String(
      verification.value.privateDraftAccessBoundaryEvidenceSha256 || '')) ||
    verification.value.artifact?.candidateOriginReceivedBoundaryCredential !== false ||
    verification.value.artifact?.candidateOriginReceivedBoundaryCookies !== false ||
    verification.value.artifact?.boundaryRedirectFollowed !== false ||
    verification.value.draftContentAccessTokenSeparatedFromNetlifyPrincipalToken !== true ||
    verification.value.draftAccessTokenSerialized !== false ||
    verification.value.netlifyControlBehaviorVerified !== false ||
    !DEPLOY_ID.test(String(verification.value.draftDeployId || ''))) {
    fail('CNYOS_CONTROLLER_DRAFT_VERIFICATION_EVIDENCE_INVALID');
  }
  if (controlBehavior.value.evidenceType !==
      'cnyos_staging_controller_netlify_control_behavior_verification' ||
    controlBehavior.value.status !== 'passed' || controlBehavior.value.authorization !== false ||
    controlBehavior.value.promotionAuthorization !== false ||
    controlBehavior.value.productionAuthorization !== false ||
    controlBehavior.value.controllerRunId !== runtime.runId ||
    controlBehavior.value.controllerCommit !== runtime.commit ||
    controlBehavior.value.source?.commit !== preflight.value.source?.commit ||
    controlBehavior.value.artifact?.artifactSha256 !== preflight.value.artifact?.artifactSha256 ||
    controlBehavior.value.draftDeployId !== verification.value.draftDeployId ||
    controlBehavior.value.exactDeployOrigin !== verification.value.exactDraftDeployOrigin ||
    controlBehavior.value.headersBehaviorVerified !== true ||
    controlBehavior.value.redirectsBehaviorVerified !== true ||
    controlBehavior.value.currentPublishedDeployId !== preflight.value.previousPublishedDeploy?.id ||
    controlBehavior.value.draftVerificationEvidenceSha256 !== verification.sha256) {
    fail('CNYOS_CONTROLLER_CONTROL_BEHAVIOR_EVIDENCE_INVALID');
  }
  if (privateDraft.value.evidenceType !== 'cnyos_staging_controller_private_draft_lifecycle' ||
    privateDraft.value.status !== 'passed' || privateDraft.value.controllerRunId !== runtime.runId ||
    privateDraft.value.controllerCommit !== runtime.commit ||
    privateDraft.value.source?.commit !== preflight.value.source?.commit ||
    privateDraft.value.artifact?.artifactSha256 !== preflight.value.artifact?.artifactSha256 ||
    privateDraft.value.draftDeployId !== verification.value.draftDeployId ||
    privateDraft.value.accessRestrictedToController !== true ||
    privateDraft.value.anonymousDraftAccessDenied !== true ||
    privateDraft.value.publicAnonymousFunctionAccessDenied !== true ||
    privateDraft.value.cleanupOnPrePromotionFailureArmed !== true ||
    privateDraft.value.currentPublishedDeployId !== preflight.value.previousPublishedDeploy?.id) {
    fail('CNYOS_CONTROLLER_PRIVATE_DRAFT_EVIDENCE_INVALID');
  }
  minimumFutureTimestamp(
    publisherLock.value.expiresAt,
    observedAt,
    POLICY.publishing.minimumExclusiveLeaseMinutes * 60 * 1000,
    'CNYOS_CONTROLLER_EXCLUSIVE_PUBLISHER_EVIDENCE_INVALID'
  );
  if (publisherLock.value.evidenceType !== 'cnyos_staging_controller_exclusive_publisher_lease' ||
    publisherLock.value.status !== 'passed' || publisherLock.value.controllerRunId !== runtime.runId ||
    publisherLock.value.controllerCommit !== runtime.commit ||
    publisherLock.value.scope !== 'cnyos_staging_only' ||
    publisherLock.value.productionAuthorization !== false ||
    publisherLock.value.netlifySiteId !== POLICY.target.netlifySiteId ||
    publisherLock.value.enforcementAuthority !== 'independent_netlify_publish_broker' ||
    publisherLock.value.brokerPolicyId !== POLICY.externalReconciliationBroker.policyId ||
    publisherLock.value.brokerPolicySha256 !== exactSha256(
      POLICY.externalReconciliationBroker.policySha256,
      'CNYOS_CONTROLLER_EXCLUSIVE_PUBLISHER_EVIDENCE_INVALID'
    ) ||
    publisherLock.value.netlifyGitPublishingDisabled !== true ||
    publisherLock.value.buildHooksDisabled !== true ||
    publisherLock.value.manualUiPublishingDenied !== true ||
    publisherLock.value.lockLeaseActive !== true ||
    publisherLock.value.renewalSupported !== true ||
    publisherLock.value.releaseRequired !== true ||
    typeof publisherLock.value.lockLeaseId !== 'string' ||
    publisherLock.value.lockLeaseId.trim().length < 16) {
    fail('CNYOS_CONTROLLER_EXCLUSIVE_PUBLISHER_EVIDENCE_INVALID');
  }
  const evidence = Object.freeze({
    schemaVersion: 1,
    evidenceType: 'cnyos_staging_controller_promotion_attempt',
    authorization: false,
    promotionAuthorization: true,
    productionAuthorization: false,
    scope: 'cnyos_staging_only',
    attemptedAt: observedAt.toISOString(),
    controllerRepository: runtime.repository,
    controllerRef: runtime.ref,
    controllerCommit: runtime.commit,
    controllerRunId: runtime.runId,
    dispatchNonce: preflight.value.dispatchNonce,
    source: preflight.value.source,
    artifact: preflight.value.artifact,
    target: POLICY.target,
    previousDeployId: preflight.value.previousPublishedDeploy.id,
    draftDeployId: verification.value.draftDeployId,
    preflightEvidenceSha256: preflight.sha256,
    rollbackReadinessEvidenceSha256: recoveryChain.rollbackReadiness.sha256,
    draftGateEvidenceSha256: recoveryChain.draftGate.sha256,
    draftVerificationEvidenceSha256: verification.sha256,
    controlBehaviorEvidenceSha256: controlBehavior.sha256,
    privateDraftEvidenceSha256: privateDraft.sha256,
    exclusivePublisherEvidenceSha256: publisherLock.sha256,
    exclusivePublisherLeaseId: publisherLock.value.lockLeaseId,
    exclusivePublisherLeaseExpiresAt: publisherLock.value.expiresAt,
    deployMessage: marker
  });
  const evidencePath = await writeJsonExclusive(
    required(env.CNYOS_CONTROLLER_PUBLISH_ATTEMPT_EVIDENCE_PATH,
      'CNYOS_CONTROLLER_PROMOTION_ATTEMPT_EVIDENCE_PATH_REQUIRED', 4096),
    evidence
  );
  return Object.freeze({ evidence, evidencePath });
}

async function loadPreflightAndAttempt(env, runtime) {
  const preflight = await loadEvidence(
    required(env.CNYOS_CONTROLLER_PREFLIGHT_EVIDENCE_PATH,
      'CNYOS_CONTROLLER_PREFLIGHT_EVIDENCE_PATH_REQUIRED', 4096),
    env.CNYOS_EXPECTED_PREFLIGHT_EVIDENCE_SHA256,
    'CNYOS_CONTROLLER_PREFLIGHT_EVIDENCE_INVALID'
  );
  const attempt = await loadEvidence(
    required(env.CNYOS_CONTROLLER_PUBLISH_ATTEMPT_EVIDENCE_PATH,
      'CNYOS_CONTROLLER_PUBLISH_ATTEMPT_EVIDENCE_PATH_REQUIRED', 4096),
    env.CNYOS_EXPECTED_PUBLISH_ATTEMPT_EVIDENCE_SHA256,
    'CNYOS_CONTROLLER_PUBLISH_ATTEMPT_EVIDENCE_INVALID'
  );
  const targetRun = required(env.CNYOS_TARGET_CONTROLLER_RUN_ID || runtime.runId,
    'CNYOS_CONTROLLER_TARGET_RUN_ID_REQUIRED', 32);
  const targetCommit = exactSha40(env.CNYOS_TARGET_CONTROLLER_COMMIT || runtime.commit,
    'CNYOS_CONTROLLER_TARGET_COMMIT_INVALID');
  if (preflight.value.controllerRepository !== runtime.repository ||
    attempt.value.controllerRepository !== runtime.repository ||
    preflight.value.controllerCommit !== targetCommit || attempt.value.controllerCommit !== targetCommit ||
    preflight.value.controllerRunId !== targetRun || attempt.value.controllerRunId !== targetRun ||
    attempt.value.evidenceType !== 'cnyos_staging_controller_promotion_attempt' ||
    attempt.value.promotionAuthorization !== true ||
    attempt.value.preflightEvidenceSha256 !== preflight.sha256 ||
    !/^[0-9a-f]{64}$/.test(String(attempt.value.rollbackReadinessEvidenceSha256 || '')) ||
    !/^[0-9a-f]{64}$/.test(String(attempt.value.draftGateEvidenceSha256 || '')) ||
    attempt.value.previousDeployId !== preflight.value.previousPublishedDeploy?.id ||
    !DEPLOY_ID.test(String(attempt.value.draftDeployId || '')) ||
    attempt.value.deployMessage !== deploymentMarker(
      targetRun,
      attempt.value.dispatchNonce,
      attempt.value.source?.commit
    )) fail('CNYOS_CONTROLLER_PUBLISH_CHAIN_INVALID');
  return Object.freeze({ preflight, attempt, targetRun, targetCommit });
}

export async function recordNetlifyDeployReceipt({
  env = process.env,
  fetchImpl = fetch,
  now = () => new Date()
} = {}) {
  const runtime = assertControllerRuntime(env);
  const preflight = await loadEvidence(
    required(env.CNYOS_CONTROLLER_PREFLIGHT_EVIDENCE_PATH,
      'CNYOS_CONTROLLER_PREFLIGHT_EVIDENCE_PATH_REQUIRED', 4096),
    env.CNYOS_EXPECTED_PREFLIGHT_EVIDENCE_SHA256,
    'CNYOS_CONTROLLER_PREFLIGHT_EVIDENCE_INVALID'
  );
  const gate = await loadEvidence(
    required(env.CNYOS_CONTROLLER_DRAFT_GATE_EVIDENCE_PATH,
      'CNYOS_CONTROLLER_DRAFT_GATE_EVIDENCE_PATH_REQUIRED', 4096),
    env.CNYOS_EXPECTED_DRAFT_GATE_EVIDENCE_SHA256,
    'CNYOS_CONTROLLER_DRAFT_GATE_EVIDENCE_INVALID'
  );
  if (gate.value.evidenceType !== 'cnyos_staging_controller_draft_gate' ||
    gate.value.controllerRunId !== runtime.runId ||
    gate.value.preflightEvidenceSha256 !== preflight.sha256 ||
    gate.value.previousDeployId !== preflight.value.previousPublishedDeploy?.id ||
    gate.value.deployMessage !== deploymentMarker(
      runtime.runId,
      gate.value.dispatchNonce,
      gate.value.source?.commit
    )) fail('CNYOS_CONTROLLER_DRAFT_GATE_EVIDENCE_INVALID');
  if (required(env.CNYOS_NETLIFY_CLI_VERSION, 'CNYOS_NETLIFY_CLI_VERSION_REQUIRED', 100) !==
    POLICY.publishing.netlifyCliVersion) fail('CNYOS_NETLIFY_CLI_VERSION_MISMATCH');
  const raw = await readFileBounded(
    required(env.CNYOS_NETLIFY_CLI_RECEIPT_PATH,
      'CNYOS_NETLIFY_CLI_RECEIPT_PATH_REQUIRED', 4096),
    2 * 1024 * 1024,
    'CNYOS_CONTROLLER_NETLIFY_CLI_RECEIPT_INVALID'
  );
  let parsed;
  try { parsed = JSON.parse(raw.toString('utf8')); }
  catch { fail('CNYOS_CONTROLLER_NETLIFY_CLI_RECEIPT_INVALID'); }
  const receipt = parseDeployReceipt(parsed);
  if (receipt.deployId === preflight.value.previousPublishedDeploy.id) {
    fail('CNYOS_CONTROLLER_NETLIFY_FRESH_DEPLOY_REQUIRED');
  }
  const token = required(env.CNYOS_STAGING_NETLIFY_AUTH_TOKEN,
    'CNYOS_CONTROLLER_NETLIFY_TOKEN_REQUIRED', 4096);
  const site = await netlifyJson(fetchImpl, token,
    `/sites/${encodeURIComponent(POLICY.target.netlifySiteId)}`);
  const previousDeployId = preflight.value.previousPublishedDeploy.id;
  assertSite(site.value, previousDeployId);
  const deploy = await netlifyJson(fetchImpl, token, `/deploys/${encodeURIComponent(receipt.deployId)}`);
  assertDeploy(deploy.value, receipt.deployId, {
    expectedMarker: gate.value.deployMessage,
    expectedPublished: false,
    expectedDraft: true
  });
  const observedAt = now();
  if (!(observedAt instanceof Date) || Number.isNaN(observedAt.getTime())) fail('CNYOS_CONTROLLER_TIME_INVALID');
  const evidence = Object.freeze({
    schemaVersion: 1,
    evidenceType: 'cnyos_staging_controller_draft_deploy_receipt',
    authorization: false,
    promotionAuthorization: false,
    scope: 'cnyos_staging_only',
    productionAuthorization: false,
    recordedAt: observedAt.toISOString(),
    controllerRepository: runtime.repository,
    controllerRef: runtime.ref,
    controllerCommit: runtime.commit,
    controllerRunId: runtime.runId,
    dispatchNonce: gate.value.dispatchNonce,
    source: gate.value.source,
    artifact: gate.value.artifact,
    target: POLICY.target,
    previousDeployId,
    currentPublishedDeployId: previousDeployId,
    draftDeployId: receipt.deployId,
    exactDeployOrigin: receipt.exactDeployOrigin,
    deploy: sanitizeDeploy(deploy.value),
    netlifyCliVersion: POLICY.publishing.netlifyCliVersion,
    cliReceiptSha256: sha256(raw),
    sanitizedCliReceipt: Object.freeze({
      deployId: receipt.deployId,
      exactDeployOrigin: receipt.exactDeployOrigin,
      siteId: POLICY.target.netlifySiteId,
      siteName: POLICY.target.netlifySiteName
    }),
    preflightEvidenceSha256: preflight.sha256,
    draftGateEvidenceSha256: gate.sha256
  });
  const evidencePath = await writeJsonExclusive(
    required(env.CNYOS_CONTROLLER_DEPLOY_RECEIPT_EVIDENCE_PATH,
      'CNYOS_CONTROLLER_DEPLOY_RECEIPT_EVIDENCE_PATH_REQUIRED', 4096),
    evidence
  );
  return Object.freeze({ evidence, evidencePath });
}

export function assertFunctionMetadata(deploy) {
  if (!Array.isArray(deploy.available_functions) || !Array.isArray(deploy.function_schedules)) {
    fail('CNYOS_CONTROLLER_FUNCTION_METADATA_INVALID');
  }
  const names = deploy.available_functions.map(item => String(item?.n || ''));
  if (names.length !== EXPECTED_FUNCTION_NAMES.length || new Set(names).size !== names.length ||
    !EXPECTED_FUNCTION_NAMES.every(name => names.includes(name))) {
    fail('CNYOS_CONTROLLER_FUNCTION_FILESET_MISMATCH');
  }
  const schedules = deploy.function_schedules;
  if (schedules.length !== Object.keys(REQUIRED_SCHEDULES).length) {
    fail('CNYOS_CONTROLLER_FUNCTION_SCHEDULE_MISMATCH');
  }
  for (const [name, cron] of Object.entries(REQUIRED_SCHEDULES)) {
    const matchingSchedules = schedules.filter(item => item?.name === name && item?.cron === cron);
    const matchingFunctions = deploy.available_functions.filter(item => item?.n === name);
    if (matchingSchedules.length !== 1 || matchingFunctions.length !== 1 ||
      Object.hasOwn(matchingFunctions[0], 'ro')) {
      fail('CNYOS_CONTROLLER_FUNCTION_SCHEDULE_MISMATCH');
    }
    const config = deploy.functions_config?.[name];
    if (config !== undefined && config !== null &&
      (!isPlainObject(config) || ['routes', 'excluded_routes'].some(field =>
        Object.hasOwn(config, field) && (!Array.isArray(config[field]) || config[field].length)))) {
      fail('CNYOS_CONTROLLER_SCHEDULED_FUNCTION_ROUTE_PRESENT');
    }
  }
  for (const name of FUNCTIONS_REQUIRING_NO_SCHEDULE_OR_CUSTOM_ROUTE) {
    const matchingSchedules = schedules.filter(item => item?.name === name);
    const matchingFunctions = deploy.available_functions.filter(item => item?.n === name);
    const config = deploy.functions_config?.[name];
    if (matchingSchedules.length || matchingFunctions.length !== 1 ||
      Object.hasOwn(matchingFunctions[0], 'ro') ||
      (config !== undefined && config !== null &&
        (!isPlainObject(config) || ['routes', 'excluded_routes'].some(field =>
          Object.hasOwn(config, field) && (!Array.isArray(config[field]) || config[field].length))))) {
      fail('CNYOS_CONTROLLER_BACKGROUND_FUNCTION_ROUTE_OR_SCHEDULE_PRESENT');
    }
  }
  return Object.freeze(schedules.map(item => Object.freeze({ name: item.name, cron: item.cron })));
}

export function strictDraftAccessToken(value) {
  if (typeof value !== 'string' || value.length < 32 || value.length > 2048 ||
    !/^[A-Za-z0-9\-._~+/]+={0,2}$/.test(value)) {
    fail('CNYOS_CONTROLLER_DRAFT_ACCESS_TOKEN_INVALID');
  }
  return value;
}

const DRAFT_ACCESS_BOUNDARY_PATH = '/v1/read-netlify-draft-file';
const DRAFT_ACCESS_BOUNDARY_MAXIMUM_AGE_MS = 10 * 60 * 1000;

function reviewedDraftAccessBoundary() {
  const boundary = POLICY.privateDraftAccessBoundary;
  if (!isPlainObject(boundary)) fail('CNYOS_CONTROLLER_DRAFT_ACCESS_BOUNDARY_POLICY_INVALID');
  assertExactKeys(boundary, ['origin', 'policyId', 'policySha256'],
    'CNYOS_CONTROLLER_DRAFT_ACCESS_BOUNDARY_POLICY_INVALID');
  const origin = safeOrigin(boundary.origin,
    'CNYOS_CONTROLLER_DRAFT_ACCESS_BOUNDARY_POLICY_INVALID');
  const policyId = required(boundary.policyId,
    'CNYOS_CONTROLLER_DRAFT_ACCESS_BOUNDARY_POLICY_INVALID', 200);
  const policySha256 = exactSha256(boundary.policySha256,
    'CNYOS_CONTROLLER_DRAFT_ACCESS_BOUNDARY_POLICY_INVALID');
  if (origin === POLICY.target.netlifyOrigin || /__|BLOCKED_UNTIL/.test(policyId)) {
    fail('CNYOS_CONTROLLER_DRAFT_ACCESS_BOUNDARY_POLICY_INVALID');
  }
  return Object.freeze({ origin, policyId, policySha256 });
}

function assertDraftAccessBoundaryEvidence(value, {
  runtime,
  bundle,
  receipt,
  deployId,
  previousDeployId,
  observedAt,
  reviewedBoundary
}) {
  const code = 'CNYOS_CONTROLLER_DRAFT_ACCESS_BOUNDARY_EVIDENCE_INVALID';
  assertExactKeys(value, [
    'schemaVersion', 'evidenceType', 'status', 'scope', 'productionAuthorization',
    'verifiedAt', 'controllerRepository', 'controllerRef', 'controllerCommit',
    'controllerRunId', 'source', 'artifact', 'target', 'currentPublishedDeployId',
    'draftDeployId', 'exactDraftDeployOrigin', 'boundary', 'canary'
  ], code);
  assertExactKeys(value.source, ['repository', 'commit', 'tree'], code);
  assertExactKeys(value.artifact, ['artifactSha256'], code);
  assertExactKeys(value.target, ['netlifySiteId', 'netlifyOrigin'], code);
  assertExactKeys(value.boundary, [
    'origin', 'policyId', 'policySha256', 'endpointPath', 'requestMethod',
    'authorizationHeaderConsumedAtBoundary', 'authorizationHeaderForwardedUpstream',
    'cookiesForwardedUpstream', 'redirectsFollowed', 'fixedTargetSiteId',
    'fixedTargetDeployId', 'exactDeployOriginRequired',
    'candidateRoutingCanChangeUpstreamTarget', 'responseBodyOnly',
    'secretSerializationPrevented'
  ], code);
  assertExactKeys(value.canary, [
    'verifiedAt', 'candidateFunctionReached', 'boundaryCredentialObserved',
    'authorizationHeaderObserved', 'cookiesObserved', 'responseReflectedCredential'
  ], code);
  const verifiedAt = recentCanonicalTimestamp(
    value.verifiedAt,
    observedAt,
    DRAFT_ACCESS_BOUNDARY_MAXIMUM_AGE_MS,
    code
  );
  const canaryVerifiedAt = recentCanonicalTimestamp(
    value.canary.verifiedAt,
    observedAt,
    DRAFT_ACCESS_BOUNDARY_MAXIMUM_AGE_MS,
    code
  );
  if (canaryVerifiedAt > verifiedAt ||
    value.schemaVersion !== 1 ||
    value.evidenceType !== 'cnyos_staging_controller_private_draft_access_boundary' ||
    value.status !== 'passed' || value.scope !== 'cnyos_staging_only' ||
    value.productionAuthorization !== false ||
    value.controllerRepository !== runtime.repository || value.controllerRef !== runtime.ref ||
    value.controllerCommit !== runtime.commit || value.controllerRunId !== runtime.runId ||
    value.source.repository !== bundle.manifest.sourceRepository ||
    value.source.commit !== bundle.manifest.candidateCommit ||
    value.source.tree !== bundle.manifest.candidateTree ||
    value.artifact.artifactSha256 !== bundle.manifest.artifactSha256 ||
    value.target.netlifySiteId !== POLICY.target.netlifySiteId ||
    value.target.netlifyOrigin !== POLICY.target.netlifyOrigin ||
    value.currentPublishedDeployId !== previousDeployId ||
    value.draftDeployId !== deployId ||
    value.exactDraftDeployOrigin !== exactDeployOrigin(deployId) ||
    value.boundary.origin !== reviewedBoundary.origin ||
    value.boundary.policyId !== reviewedBoundary.policyId ||
    value.boundary.policySha256 !== reviewedBoundary.policySha256 ||
    value.boundary.endpointPath !== DRAFT_ACCESS_BOUNDARY_PATH ||
    value.boundary.requestMethod !== 'POST' ||
    value.boundary.authorizationHeaderConsumedAtBoundary !== true ||
    value.boundary.authorizationHeaderForwardedUpstream !== false ||
    value.boundary.cookiesForwardedUpstream !== false ||
    value.boundary.redirectsFollowed !== false ||
    value.boundary.fixedTargetSiteId !== true ||
    value.boundary.fixedTargetDeployId !== true ||
    value.boundary.exactDeployOriginRequired !== true ||
    value.boundary.candidateRoutingCanChangeUpstreamTarget !== false ||
    value.boundary.responseBodyOnly !== true ||
    value.boundary.secretSerializationPrevented !== true ||
    value.canary.candidateFunctionReached !== true ||
    value.canary.boundaryCredentialObserved !== false ||
    value.canary.authorizationHeaderObserved !== false ||
    value.canary.cookiesObserved !== false ||
    value.canary.responseReflectedCredential !== false ||
    receipt.value.draftDeployId !== deployId) {
    fail(code);
  }
  return Object.freeze({ verifiedAt, canaryVerifiedAt });
}

export async function verifyDraftStaticFiles(
  fetchImpl,
  boundaryOrigin,
  deployOrigin,
  expectedDeployId,
  bundle,
  draftAccessToken,
  {
    controllerRunId,
    boundaryPolicyId,
    boundaryPolicySha256
  }
) {
  const deployId = exactDeployId(
    expectedDeployId,
    'CNYOS_CONTROLLER_DRAFT_ORIGIN_INVALID'
  );
  const validatedOrigin = safeOrigin(
    deployOrigin,
    'CNYOS_CONTROLLER_DRAFT_ORIGIN_INVALID'
  );
  if (validatedOrigin !== exactDeployOrigin(deployId)) {
    fail('CNYOS_CONTROLLER_DRAFT_ORIGIN_INVALID');
  }
  const validatedBoundaryOrigin = safeOrigin(
    boundaryOrigin,
    'CNYOS_CONTROLLER_DRAFT_ACCESS_BOUNDARY_ORIGIN_INVALID'
  );
  if (validatedBoundaryOrigin === validatedOrigin ||
    validatedBoundaryOrigin === POLICY.target.netlifyOrigin) {
    fail('CNYOS_CONTROLLER_DRAFT_ACCESS_BOUNDARY_ORIGIN_INVALID');
  }
  const accessToken = strictDraftAccessToken(draftAccessToken);
  const runId = required(controllerRunId, 'CNYOS_CONTROLLER_RUN_ID_REQUIRED', 128);
  const policyId = required(boundaryPolicyId,
    'CNYOS_CONTROLLER_DRAFT_ACCESS_BOUNDARY_POLICY_INVALID', 200);
  const policySha256 = exactSha256(boundaryPolicySha256,
    'CNYOS_CONTROLLER_DRAFT_ACCESS_BOUNDARY_POLICY_INVALID');
  const expected = bundle.manifest.files
    .filter(item => item.path.startsWith('payload/dist/') &&
      !['payload/dist/_headers', 'payload/dist/_redirects'].includes(item.path))
    .map(item => Object.freeze({ ...item, remotePath: `/${item.path.slice('payload/dist/'.length)}` }));
  if (!expected.length) fail('CNYOS_CONTROLLER_DRAFT_STATIC_FILESET_EMPTY');
  for (const item of expected) {
    const encodedPath = item.remotePath.slice(1).split('/').map(encodeURIComponent).join('/');
    let response;
    try {
      const requestBody = JSON.stringify({
        schemaVersion: 1,
        operation: 'read_exact_netlify_draft_file',
        controllerRunId: runId,
        netlifySiteId: POLICY.target.netlifySiteId,
        netlifyDeployId: deployId,
        exactDraftDeployOrigin: validatedOrigin,
        path: `/${encodedPath}`,
        expectedSize: item.size,
        expectedSha256: item.sha256
      });
      response = await fetchImpl(`${validatedBoundaryOrigin}${DRAFT_ACCESS_BOUNDARY_PATH}`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/octet-stream',
          'Accept-Encoding': 'identity',
          'Content-Type': 'application/json',
          'X-CNYOS-Boundary-Policy-Id': policyId,
          'X-CNYOS-Boundary-Policy-SHA256': policySha256
        },
        body: requestBody,
        signal: AbortSignal.timeout(20_000)
      });
    } catch {
      fail('CNYOS_CONTROLLER_DRAFT_FILE_REQUEST_FAILED');
    }
    const body = await responseBytes(
      response,
      Math.min(MAX_FILE_BYTES, Math.max(1, item.size)),
      'CNYOS_CONTROLLER_DRAFT_FILE_TOO_LARGE'
    );
    if (response.status !== 200 ||
      response.headers.get('x-cnyos-boundary-policy-id') !== policyId ||
      response.headers.get('x-cnyos-boundary-policy-sha256') !== policySha256 ||
      response.headers.get('x-cnyos-upstream-authorization-forwarded') !== 'false' ||
      response.headers.get('x-cnyos-upstream-cookies-forwarded') !== 'false' ||
      response.headers.get('x-cnyos-upstream-redirect-followed') !== 'false' ||
      body.byteLength !== item.size || sha256(body) !== item.sha256) {
      fail('CNYOS_CONTROLLER_STATIC_BYTES_MISMATCH');
    }
  }
  return Object.freeze({
    fileCount: expected.length,
    remotelyVerifiedByteCount: expected.reduce((total, item) => total + item.size, 0),
    privateDraftAccessBoundaryOrigin: validatedBoundaryOrigin,
    privateDraftAccessBoundaryPolicyId: policyId,
    privateDraftAccessBoundaryPolicySha256: policySha256,
    privateDraftAccessBoundaryEndpointPath: DRAFT_ACCESS_BOUNDARY_PATH,
    candidateOriginReceivedBoundaryCredential: false,
    candidateOriginReceivedBoundaryCookies: false,
    boundaryRedirectFollowed: false,
    expectedFileManifestSha256: sha256(JSON.stringify(
      expected.map(item => ({ path: item.remotePath, size: item.size, sha256: item.sha256 }))
    )),
    remoteClosedWorldInventoryAvailable: false,
    netlifyControlInputs: Object.freeze(Object.fromEntries(
      bundle.manifest.files
        .filter(item => ['payload/dist/_headers', 'payload/dist/_redirects'].includes(item.path))
        .map(item => [path.posix.basename(item.path), Object.freeze({ size: item.size, sha256: item.sha256 })])
    )),
    netlifyControlBehaviorVerificationRequiredBeforePromotion: true
  });
}

async function verifyPublishedStaticFiles(fetchImpl, token, bundle) {
  const inventoryResult = await netlifyJson(
    fetchImpl,
    token,
    `/sites/${encodeURIComponent(POLICY.target.netlifySiteId)}/files`
  );
  noNextPage(inventoryResult.response);
  if (!Array.isArray(inventoryResult.value)) fail('CNYOS_CONTROLLER_STATIC_INVENTORY_INVALID');
  const actual = new Map();
  for (const item of inventoryResult.value) {
    const filePath = String(item?.path || item?.id || '');
    if (!filePath.startsWith('/') || actual.has(filePath)) fail('CNYOS_CONTROLLER_STATIC_INVENTORY_INVALID');
    actual.set(filePath, item);
  }
  const expected = bundle.manifest.files
    .filter(item => item.path.startsWith('payload/dist/') &&
      !['payload/dist/_headers', 'payload/dist/_redirects'].includes(item.path))
    .map(item => Object.freeze({ ...item, remotePath: `/${item.path.slice('payload/dist/'.length)}` }));
  if (actual.size !== expected.length || expected.some(item => !actual.has(item.remotePath))) {
    fail('CNYOS_CONTROLLER_STATIC_FILESET_MISMATCH');
  }
  for (const item of expected) {
    const observed = actual.get(item.remotePath);
    const local = await fs.readFile(path.join(bundle.bundleDirectory, item.path));
    if (Number(observed.size) !== item.size || String(observed.sha || '').toLowerCase() !== sha1(local)) {
      fail('CNYOS_CONTROLLER_STATIC_METADATA_MISMATCH');
    }
    const encodedPath = item.remotePath.slice(1).split('/').map(encodeURIComponent).join('/');
    const raw = await netlifyRequest(
      fetchImpl,
      token,
      `/sites/${encodeURIComponent(POLICY.target.netlifySiteId)}/files/${encodedPath}`,
      { accept: 'application/vnd.bitballoon.v1.raw', maximum: Math.min(MAX_FILE_BYTES, Math.max(1, item.size)) }
    );
    if (raw.response.status !== 200 || raw.body.byteLength !== item.size || sha256(raw.body) !== item.sha256) {
      fail('CNYOS_CONTROLLER_STATIC_BYTES_MISMATCH');
    }
  }
  return Object.freeze({
    fileCount: expected.length,
    closedWorldInventoryVerified: true,
    inventorySha256: sha256(JSON.stringify(
      expected.map(item => ({ path: item.remotePath, size: item.size, sha256: item.sha256 }))
    ))
  });
}

export async function verifyDraftDeployment({
  env = process.env,
  fetchImpl = fetch,
  now = () => new Date()
} = {}) {
  const runtime = assertControllerRuntime(env);
  const bundle = await verifyProducerBundle({ env });
  const observedAt = now();
  if (!(observedAt instanceof Date) || Number.isNaN(observedAt.getTime())) {
    fail('CNYOS_CONTROLLER_TIME_INVALID');
  }
  const receipt = await loadEvidence(
    required(env.CNYOS_CONTROLLER_DRAFT_RECEIPT_EVIDENCE_PATH,
      'CNYOS_CONTROLLER_DRAFT_RECEIPT_EVIDENCE_PATH_REQUIRED', 4096),
    env.CNYOS_EXPECTED_DRAFT_RECEIPT_EVIDENCE_SHA256,
    'CNYOS_CONTROLLER_DRAFT_RECEIPT_EVIDENCE_INVALID'
  );
  if (receipt.value.evidenceType !== 'cnyos_staging_controller_draft_deploy_receipt' ||
    receipt.value.promotionAuthorization !== false ||
    receipt.value.controllerRunId !== runtime.runId ||
    receipt.value.artifact?.artifactSha256 !== bundle.manifest.artifactSha256 ||
    receipt.value.source?.commit !== bundle.manifest.candidateCommit) {
    fail('CNYOS_CONTROLLER_DRAFT_RECEIPT_EVIDENCE_INVALID');
  }
  const deployId = exactDeployId(receipt.value.draftDeployId,
    'CNYOS_CONTROLLER_NETLIFY_DEPLOY_ID_INVALID');
  const previousDeployId = exactDeployId(receipt.value.previousDeployId,
    'CNYOS_CONTROLLER_ROLLBACK_DEPLOY_ID_INVALID');
  const reviewedBoundary = reviewedDraftAccessBoundary();
  const configuredBoundaryOrigin = safeOrigin(
    env.CNYOS_PRIVATE_DRAFT_ACCESS_BOUNDARY_URL,
    'CNYOS_CONTROLLER_DRAFT_ACCESS_BOUNDARY_ORIGIN_INVALID'
  );
  if (configuredBoundaryOrigin !== reviewedBoundary.origin) {
    fail('CNYOS_CONTROLLER_DRAFT_ACCESS_BOUNDARY_ORIGIN_INVALID');
  }
  const boundaryEvidence = await loadEvidence(
    required(env.CNYOS_CONTROLLER_DRAFT_ACCESS_BOUNDARY_EVIDENCE_PATH,
      'CNYOS_CONTROLLER_DRAFT_ACCESS_BOUNDARY_EVIDENCE_PATH_REQUIRED', 4096),
    env.CNYOS_EXPECTED_DRAFT_ACCESS_BOUNDARY_EVIDENCE_SHA256,
    'CNYOS_CONTROLLER_DRAFT_ACCESS_BOUNDARY_EVIDENCE_INVALID'
  );
  assertDraftAccessBoundaryEvidence(boundaryEvidence.value, {
    runtime,
    bundle,
    receipt,
    deployId,
    previousDeployId,
    observedAt,
    reviewedBoundary
  });
  const token = required(env.CNYOS_STAGING_NETLIFY_AUTH_TOKEN,
    'CNYOS_CONTROLLER_NETLIFY_TOKEN_REQUIRED', 4096);
  const draftAccessToken = strictDraftAccessToken(
    env.CNYOS_STAGING_DRAFT_ACCESS_BOUNDARY_TOKEN
  );
  if (draftAccessToken === token) {
    fail('CNYOS_CONTROLLER_DRAFT_ACCESS_TOKEN_NOT_SEPARATE');
  }
  const siteBefore = await netlifyJson(fetchImpl, token,
    `/sites/${encodeURIComponent(POLICY.target.netlifySiteId)}`);
  assertSite(siteBefore.value, previousDeployId);
  const deploy = await netlifyJson(fetchImpl, token, `/deploys/${encodeURIComponent(deployId)}`);
  assertDeploy(deploy.value, deployId, {
    expectedMarker: deploymentMarker(runtime.runId, bundle.manifest.dispatchNonce,
      bundle.manifest.candidateCommit),
    expectedPublished: false,
    expectedDraft: true
  });
  const schedules = assertFunctionMetadata(deploy.value);
  const deployOrigin = exactDeployOrigin(deployId);
  const staticEvidence = await verifyDraftStaticFiles(
    fetchImpl,
    reviewedBoundary.origin,
    deployOrigin,
    deployId,
    bundle,
    draftAccessToken,
    {
      controllerRunId: runtime.runId,
      boundaryPolicyId: reviewedBoundary.policyId,
      boundaryPolicySha256: reviewedBoundary.policySha256
    }
  );
  const siteAfter = await netlifyJson(fetchImpl, token,
    `/sites/${encodeURIComponent(POLICY.target.netlifySiteId)}`);
  assertSite(siteAfter.value, previousDeployId);
  const evidence = Object.freeze({
    schemaVersion: 1,
    evidenceType: 'cnyos_staging_controller_draft_verification',
    status: 'passed',
    authorization: false,
    promotionAuthorization: false,
    scope: 'cnyos_staging_only',
    productionAuthorization: false,
    verifiedAt: observedAt.toISOString(),
    controllerRepository: runtime.repository,
    controllerRef: runtime.ref,
    controllerCommit: runtime.commit,
    controllerRunId: runtime.runId,
    dispatchNonce: bundle.manifest.dispatchNonce,
    source: Object.freeze({
      repository: bundle.manifest.sourceRepository,
      commit: bundle.manifest.candidateCommit,
      tree: bundle.manifest.candidateTree,
      functionSourceTree: bundle.manifest.functionSourceTree
    }),
    artifact: Object.freeze({
      producerManifestSha256: bundle.manifestSha256,
      artifactSha256: bundle.manifest.artifactSha256,
      ...staticEvidence
    }),
    target: POLICY.target,
    previousDeployId,
    currentPublishedDeployId: previousDeployId,
    draftDeployId: deployId,
    exactDraftDeployOrigin: deployOrigin,
    schedules,
    functionNames: EXPECTED_FUNCTION_NAMES,
    functionProcessProvenance: Object.freeze({
      netlifyCliVersion: receipt.value.netlifyCliVersion,
      functionSourceTree: bundle.manifest.functionSourceTree,
      skipFunctionsCacheRequired: true
    }),
    functionByteAttestationAvailable: false,
    authenticatedDraftContentAccessVerified: true,
    privateDraftAccessBoundaryEvidenceSha256: boundaryEvidence.sha256,
    draftAccessCredentialConsumedOnlyAtBoundary: true,
    draftAccessCredentialForwardedToCandidateOrigin: false,
    draftContentAccessTokenSeparatedFromNetlifyPrincipalToken: true,
    draftAccessTokenSerialized: false,
    netlifyControlBehaviorVerified: false,
    draftReceiptEvidenceSha256: receipt.sha256
  });
  const evidencePath = await writeJsonExclusive(
    required(env.CNYOS_CONTROLLER_DRAFT_VERIFICATION_EVIDENCE_PATH,
      'CNYOS_CONTROLLER_DRAFT_VERIFICATION_EVIDENCE_PATH_REQUIRED', 4096),
    evidence
  );
  return Object.freeze({ evidence, evidencePath });
}

export async function promoteExactDraft({
  env = process.env,
  fetchImpl = fetch,
  now = () => new Date()
} = {}) {
  const runtime = assertControllerRuntime(env);
  const observedAt = now();
  if (!(observedAt instanceof Date) || Number.isNaN(observedAt.getTime())) fail('CNYOS_CONTROLLER_TIME_INVALID');
  const { preflight, attempt } = await loadPreflightAndAttempt(env, runtime);
  assertFreshPreflight(preflight.value, runtime, observedAt);
  const recoveryChain = await loadAndValidatePromotionRecoveryChain(
    env,
    runtime,
    preflight,
    observedAt
  );
  const verification = await loadEvidence(
    required(env.CNYOS_CONTROLLER_DRAFT_VERIFICATION_EVIDENCE_PATH,
      'CNYOS_CONTROLLER_DRAFT_VERIFICATION_EVIDENCE_PATH_REQUIRED', 4096),
    env.CNYOS_EXPECTED_DRAFT_VERIFICATION_EVIDENCE_SHA256,
    'CNYOS_CONTROLLER_DRAFT_VERIFICATION_EVIDENCE_INVALID'
  );
  const controlBehavior = await loadEvidence(
    required(env.CNYOS_CONTROLLER_CONTROL_BEHAVIOR_EVIDENCE_PATH,
      'CNYOS_CONTROLLER_CONTROL_BEHAVIOR_EVIDENCE_PATH_REQUIRED', 4096),
    env.CNYOS_EXPECTED_CONTROL_BEHAVIOR_EVIDENCE_SHA256,
    'CNYOS_CONTROLLER_CONTROL_BEHAVIOR_EVIDENCE_INVALID'
  );
  const privateDraft = await loadEvidence(
    required(env.CNYOS_CONTROLLER_PRIVATE_DRAFT_EVIDENCE_PATH,
      'CNYOS_CONTROLLER_PRIVATE_DRAFT_EVIDENCE_PATH_REQUIRED', 4096),
    env.CNYOS_EXPECTED_PRIVATE_DRAFT_EVIDENCE_SHA256,
    'CNYOS_CONTROLLER_PRIVATE_DRAFT_EVIDENCE_INVALID'
  );
  const publisherLock = await loadEvidence(
    required(env.CNYOS_CONTROLLER_EXCLUSIVE_PUBLISHER_EVIDENCE_PATH,
      'CNYOS_CONTROLLER_EXCLUSIVE_PUBLISHER_EVIDENCE_PATH_REQUIRED', 4096),
    env.CNYOS_EXPECTED_EXCLUSIVE_PUBLISHER_EVIDENCE_SHA256,
    'CNYOS_CONTROLLER_EXCLUSIVE_PUBLISHER_EVIDENCE_INVALID'
  );
  const leaseExpiresAt = canonicalIsoTimestamp(
    attempt.value.exclusivePublisherLeaseExpiresAt,
    'CNYOS_CONTROLLER_EXCLUSIVE_PUBLISHER_EVIDENCE_INVALID'
  );
  if (attempt.value.rollbackReadinessEvidenceSha256 !==
      recoveryChain.rollbackReadiness.sha256 ||
    attempt.value.draftGateEvidenceSha256 !== recoveryChain.draftGate.sha256 ||
    attempt.value.draftVerificationEvidenceSha256 !== verification.sha256 ||
    attempt.value.controlBehaviorEvidenceSha256 !== controlBehavior.sha256 ||
    attempt.value.privateDraftEvidenceSha256 !== privateDraft.sha256 ||
    attempt.value.exclusivePublisherEvidenceSha256 !== publisherLock.sha256 ||
    attempt.value.exclusivePublisherLeaseId !== publisherLock.value.lockLeaseId ||
    leaseExpiresAt <= observedAt ||
    publisherLock.value.lockLeaseActive !== true ||
    publisherLock.value.enforcementAuthority !== 'independent_netlify_publish_broker' ||
    publisherLock.value.brokerPolicyId !== POLICY.externalReconciliationBroker.policyId ||
    publisherLock.value.brokerPolicySha256 !== exactSha256(
      POLICY.externalReconciliationBroker.policySha256,
      'CNYOS_CONTROLLER_PROMOTION_CHAIN_INVALID'
    ) ||
    privateDraft.value.accessRestrictedToController !== true ||
    privateDraft.value.anonymousDraftAccessDenied !== true ||
    privateDraft.value.publicAnonymousFunctionAccessDenied !== true ||
    privateDraft.value.cleanupOnPrePromotionFailureArmed !== true ||
    verification.value.evidenceType !== 'cnyos_staging_controller_draft_verification' ||
    verification.value.status !== 'passed' ||
    verification.value.draftDeployId !== attempt.value.draftDeployId ||
    verification.value.currentPublishedDeployId !== attempt.value.previousDeployId ||
    verification.value.artifact?.artifactSha256 !== attempt.value.artifact?.artifactSha256 ||
    verification.value.authenticatedDraftContentAccessVerified !== true ||
    verification.value.draftAccessCredentialConsumedOnlyAtBoundary !== true ||
    verification.value.draftAccessCredentialForwardedToCandidateOrigin !== false ||
    !/^[0-9a-f]{64}$/.test(String(
      verification.value.privateDraftAccessBoundaryEvidenceSha256 || '')) ||
    verification.value.artifact?.candidateOriginReceivedBoundaryCredential !== false ||
    verification.value.artifact?.candidateOriginReceivedBoundaryCookies !== false ||
    verification.value.artifact?.boundaryRedirectFollowed !== false ||
    verification.value.draftContentAccessTokenSeparatedFromNetlifyPrincipalToken !== true ||
    verification.value.draftAccessTokenSerialized !== false ||
    controlBehavior.value.evidenceType !==
      'cnyos_staging_controller_netlify_control_behavior_verification' ||
    controlBehavior.value.status !== 'passed' ||
    controlBehavior.value.draftDeployId !== attempt.value.draftDeployId ||
    controlBehavior.value.headersBehaviorVerified !== true ||
    controlBehavior.value.redirectsBehaviorVerified !== true ||
    controlBehavior.value.draftVerificationEvidenceSha256 !== verification.sha256) {
    fail('CNYOS_CONTROLLER_PROMOTION_CHAIN_INVALID');
  }
  const token = required(env.CNYOS_STAGING_NETLIFY_AUTH_TOKEN,
    'CNYOS_CONTROLLER_NETLIFY_TOKEN_REQUIRED', 4096);
  await exactSiteInventory(fetchImpl, token, preflight.value.principalProof?.subject);
  const previousDeployId = exactDeployId(attempt.value.previousDeployId,
    'CNYOS_CONTROLLER_ROLLBACK_DEPLOY_ID_INVALID');
  const draftDeployId = exactDeployId(attempt.value.draftDeployId,
    'CNYOS_CONTROLLER_NETLIFY_DEPLOY_ID_INVALID');
  const siteBefore = await netlifyJson(fetchImpl, token,
    `/sites/${encodeURIComponent(POLICY.target.netlifySiteId)}`);
  assertSite(siteBefore.value, previousDeployId);
  const draft = await netlifyJson(fetchImpl, token, `/deploys/${encodeURIComponent(draftDeployId)}`);
  assertDeploy(draft.value, draftDeployId, {
    expectedMarker: attempt.value.deployMessage,
    expectedPublished: false,
    expectedDraft: true
  });
  const mutationAt = now();
  if (!(mutationAt instanceof Date) || Number.isNaN(mutationAt.getTime())) {
    fail('CNYOS_CONTROLLER_TIME_INVALID');
  }
  assertFreshPreflight(preflight.value, runtime, mutationAt);
  validateRollbackReadinessEvidence(recoveryChain.rollbackReadiness.value, {
    runtime,
    preflight: preflight.value,
    preflightSha256: preflight.sha256,
    observedAt: mutationAt
  });
  validatePromotionDraftGate(recoveryChain.draftGate.value, {
    runtime,
    preflight: preflight.value,
    preflightSha256: preflight.sha256,
    rollbackReadinessSha256: recoveryChain.rollbackReadiness.sha256,
    observedAt: mutationAt
  });
  const promotion = await netlifyRequest(
    fetchImpl,
    token,
    `/sites/${encodeURIComponent(POLICY.target.netlifySiteId)}/deploys/${encodeURIComponent(draftDeployId)}/restore`,
    { method: 'POST' }
  );
  if (![200, 201].includes(promotion.response.status)) {
    fail(`CNYOS_CONTROLLER_NETLIFY_PROMOTION_STATUS_${promotion.response.status}`);
  }
  const siteAfter = await netlifyJson(fetchImpl, token,
    `/sites/${encodeURIComponent(POLICY.target.netlifySiteId)}`);
  assertSite(siteAfter.value, draftDeployId);
  const promoted = await netlifyJson(fetchImpl, token, `/deploys/${encodeURIComponent(draftDeployId)}`);
  assertDeploy(promoted.value, draftDeployId, {
    expectedMarker: attempt.value.deployMessage,
    expectedPublished: true,
    expectedDraft: false
  });
  const evidence = Object.freeze({
    schemaVersion: 1,
    evidenceType: 'cnyos_staging_controller_exact_deploy_promotion',
    status: 'passed',
    authorization: false,
    scope: 'cnyos_staging_only',
    productionAuthorization: false,
    promotedAt: observedAt.toISOString(),
    controllerRepository: runtime.repository,
    controllerRef: runtime.ref,
    controllerCommit: runtime.commit,
    controllerRunId: runtime.runId,
    dispatchNonce: attempt.value.dispatchNonce,
    source: attempt.value.source,
    artifact: attempt.value.artifact,
    target: POLICY.target,
    previousDeployId,
    promotedDeployId: draftDeployId,
    exactDeployOrigin: exactDeployOrigin(draftDeployId),
    currentPublishedDeployId: draftDeployId,
    deploy: sanitizeDeploy(promoted.value),
    preflightEvidenceSha256: preflight.sha256,
    promotionAttemptEvidenceSha256: attempt.sha256,
    draftVerificationEvidenceSha256: verification.sha256,
    controlBehaviorEvidenceSha256: controlBehavior.sha256,
    privateDraftEvidenceSha256: privateDraft.sha256,
    exclusivePublisherEvidenceSha256: publisherLock.sha256,
    exclusivePublisherLeaseId: publisherLock.value.lockLeaseId
  });
  const evidencePath = await writeJsonExclusive(
    required(env.CNYOS_CONTROLLER_PROMOTION_EVIDENCE_PATH,
      'CNYOS_CONTROLLER_PROMOTION_EVIDENCE_PATH_REQUIRED', 4096),
    evidence
  );
  return Object.freeze({ evidence, evidencePath });
}

export async function verifyPromotedDeployment({
  env = process.env,
  fetchImpl = fetch,
  now = () => new Date(),
  finalCheck = false
} = {}) {
  const runtime = assertControllerRuntime(env);
  const bundle = await verifyProducerBundle({ env });
  const promotion = await loadEvidence(
    required(env.CNYOS_CONTROLLER_PROMOTION_EVIDENCE_PATH,
      'CNYOS_CONTROLLER_PROMOTION_EVIDENCE_PATH_REQUIRED', 4096),
    env.CNYOS_EXPECTED_PROMOTION_EVIDENCE_SHA256,
    'CNYOS_CONTROLLER_PROMOTION_EVIDENCE_INVALID'
  );
  if (promotion.value.evidenceType !== 'cnyos_staging_controller_exact_deploy_promotion' ||
    promotion.value.status !== 'passed' || promotion.value.controllerRunId !== runtime.runId ||
    promotion.value.controllerCommit !== runtime.commit ||
    promotion.value.source?.commit !== bundle.manifest.candidateCommit ||
    promotion.value.artifact?.artifactSha256 !== bundle.manifest.artifactSha256) {
    fail('CNYOS_CONTROLLER_PROMOTION_EVIDENCE_INVALID');
  }
  const deployId = exactDeployId(promotion.value.promotedDeployId,
    'CNYOS_CONTROLLER_NETLIFY_DEPLOY_ID_INVALID');
  const token = required(env.CNYOS_STAGING_NETLIFY_AUTH_TOKEN,
    'CNYOS_CONTROLLER_NETLIFY_TOKEN_REQUIRED', 4096);
  const siteBefore = await netlifyJson(fetchImpl, token,
    `/sites/${encodeURIComponent(POLICY.target.netlifySiteId)}`);
  assertSite(siteBefore.value, deployId);
  const deploy = await netlifyJson(fetchImpl, token, `/deploys/${encodeURIComponent(deployId)}`);
  assertDeploy(deploy.value, deployId, {
    expectedMarker: deploymentMarker(
      runtime.runId,
      bundle.manifest.dispatchNonce,
      bundle.manifest.candidateCommit
    ),
    expectedPublished: true,
    expectedDraft: false
  });
  const schedules = assertFunctionMetadata(deploy.value);
  const staticEvidence = await verifyPublishedStaticFiles(fetchImpl, token, bundle);
  const siteAfter = await netlifyJson(fetchImpl, token,
    `/sites/${encodeURIComponent(POLICY.target.netlifySiteId)}`);
  assertSite(siteAfter.value, deployId);
  const observedAt = now();
  if (!(observedAt instanceof Date) || Number.isNaN(observedAt.getTime())) fail('CNYOS_CONTROLLER_TIME_INVALID');
  const evidence = Object.freeze({
    schemaVersion: 1,
    evidenceType: finalCheck ? 'cnyos_staging_controller_final_current_verification' :
      'cnyos_staging_controller_post_promotion_verification',
    status: 'passed',
    authorization: false,
    scope: 'cnyos_staging_only',
    productionAuthorization: false,
    verifiedAt: observedAt.toISOString(),
    controllerRepository: runtime.repository,
    controllerRef: runtime.ref,
    controllerCommit: runtime.commit,
    controllerRunId: runtime.runId,
    dispatchNonce: bundle.manifest.dispatchNonce,
    source: Object.freeze({
      repository: bundle.manifest.sourceRepository,
      commit: bundle.manifest.candidateCommit,
      tree: bundle.manifest.candidateTree,
      functionSourceTree: bundle.manifest.functionSourceTree
    }),
    artifact: Object.freeze({
      producerManifestSha256: bundle.manifestSha256,
      artifactSha256: bundle.manifest.artifactSha256,
      ...staticEvidence
    }),
    target: POLICY.target,
    netlifyDeployId: deployId,
    exactDeployOrigin: exactDeployOrigin(deployId),
    currentPublishedDeployId: deployId,
    schedules,
    functionNames: EXPECTED_FUNCTION_NAMES,
    functionByteAttestationAvailable: false,
    verificationPhase: finalCheck ? 'after_authenticated_uat' : 'before_authenticated_uat',
    promotionEvidenceSha256: promotion.sha256
  });
  const evidencePath = await writeJsonExclusive(
    required(
      finalCheck ? env.CNYOS_CONTROLLER_FINAL_CURRENT_EVIDENCE_PATH :
        env.CNYOS_CONTROLLER_POST_PROMOTION_EVIDENCE_PATH,
      finalCheck ? 'CNYOS_CONTROLLER_FINAL_CURRENT_EVIDENCE_PATH_REQUIRED' :
        'CNYOS_CONTROLLER_POST_PROMOTION_EVIDENCE_PATH_REQUIRED',
      4096
    ),
    evidence
  );
  return Object.freeze({ evidence, evidencePath });
}

export async function rollbackPublishedDeployment({
  env = process.env,
  fetchImpl = fetch,
  now = () => new Date()
} = {}) {
  if (env.CNYOS_CONTROLLER_ROLLBACK_ACK !== 'RESTORE_EXACT_CNYOS_STAGING_PREVIOUS_DEPLOY') {
    fail('CNYOS_CONTROLLER_ROLLBACK_ACK_REQUIRED');
  }
  const runtime = assertControllerRuntime(env, { requireActor: false });
  const { preflight, attempt, targetRun } = await loadPreflightAndAttempt(env, runtime);
  const rollbackChain = await loadEvidence(
    required(env.CNYOS_CONTROLLER_ROLLBACK_CHAIN_EVIDENCE_PATH,
      'CNYOS_CONTROLLER_ROLLBACK_CHAIN_EVIDENCE_PATH_REQUIRED', 4096),
    env.CNYOS_EXPECTED_ROLLBACK_CHAIN_EVIDENCE_SHA256,
    'CNYOS_CONTROLLER_ROLLBACK_CHAIN_EVIDENCE_INVALID'
  );
  if (rollbackChain.value.evidenceType !==
      'cnyos_staging_controller_rollback_authorization_chain' ||
    rollbackChain.value.status !== 'passed' ||
    rollbackChain.value.productionAuthorization !== false ||
    rollbackChain.value.artifactProvenanceAuthenticated !== true ||
    rollbackChain.value.authorizationSignaturesVerified !== true ||
    rollbackChain.value.protectedApproverRegistryVerified !== true ||
    rollbackChain.value.knownGoodEvidenceVerified !== true ||
    rollbackChain.value.targetControllerRepository !== POLICY.controller.repository ||
    rollbackChain.value.targetControllerRunId !== targetRun ||
    rollbackChain.value.targetControllerCommit !== attempt.value.controllerCommit ||
    rollbackChain.value.preflightEvidenceSha256 !== preflight.sha256 ||
    rollbackChain.value.promotionAttemptEvidenceSha256 !== attempt.sha256 ||
    rollbackChain.value.previousDeployId !== preflight.value.previousPublishedDeploy?.id ||
    rollbackChain.value.draftDeployId !== attempt.value.draftDeployId ||
    rollbackChain.value.rollbackNetlifyPrincipalSubject !==
      preflight.value.rollbackNetlifyPrincipalSubject) {
    fail('CNYOS_CONTROLLER_ROLLBACK_CHAIN_EVIDENCE_INVALID');
  }
  const token = required(env.CNYOS_STAGING_NETLIFY_AUTH_TOKEN,
    'CNYOS_CONTROLLER_NETLIFY_TOKEN_REQUIRED', 4096);
  await exactSiteInventory(fetchImpl, token, preflight.value.rollbackNetlifyPrincipalSubject);
  const previousDeployId = exactDeployId(preflight.value.previousPublishedDeploy?.id,
    'CNYOS_CONTROLLER_ROLLBACK_DEPLOY_ID_INVALID');
  const siteBefore = await netlifyJson(fetchImpl, token,
    `/sites/${encodeURIComponent(POLICY.target.netlifySiteId)}`);
  const currentDeployId = assertSite(siteBefore.value);
  let action = 'already_restored';
  let restoredFromDeployId = currentDeployId;
  if (currentDeployId !== previousDeployId) {
    const current = await netlifyJson(fetchImpl, token, `/deploys/${encodeURIComponent(currentDeployId)}`);
    assertDeploy(current.value, currentDeployId, { expectedPublished: true, expectedDraft: false });
    const receiptOwnership = attempt.value.draftDeployId === currentDeployId;
    const markerOwnership = current.value?.title === attempt.value.deployMessage;
    if (!receiptOwnership || !markerOwnership) {
      fail('CNYOS_CONTROLLER_ROLLBACK_CURRENT_DEPLOY_NOT_OWNED');
    }
    const restore = await netlifyRequest(
      fetchImpl,
      token,
      `/sites/${encodeURIComponent(POLICY.target.netlifySiteId)}/deploys/${encodeURIComponent(previousDeployId)}/restore`,
      { method: 'POST' }
    );
    if (![200, 201].includes(restore.response.status)) {
      fail(`CNYOS_CONTROLLER_NETLIFY_RESTORE_STATUS_${restore.response.status}`);
    }
    action = 'restored_previous_deploy';
  }
  const siteAfter = await netlifyJson(fetchImpl, token,
    `/sites/${encodeURIComponent(POLICY.target.netlifySiteId)}`);
  assertSite(siteAfter.value, previousDeployId);
  const previous = await netlifyJson(fetchImpl, token, `/deploys/${encodeURIComponent(previousDeployId)}`);
  assertDeploy(previous.value, previousDeployId, { expectedPublished: true, expectedDraft: false });
  const observedAt = now();
  if (!(observedAt instanceof Date) || Number.isNaN(observedAt.getTime())) fail('CNYOS_CONTROLLER_TIME_INVALID');
  const evidence = Object.freeze({
    schemaVersion: 1,
    evidenceType: 'cnyos_staging_controller_rollback',
    status: 'passed',
    authorization: false,
    scope: 'cnyos_staging_only',
    productionAuthorization: false,
    rolledBackAt: observedAt.toISOString(),
    watchdogRepository: runtime.repository,
    watchdogRef: runtime.ref,
    watchdogCommit: runtime.commit,
    watchdogRunId: runtime.runId,
    targetControllerRunId: targetRun,
    dispatchNonce: attempt.value.dispatchNonce,
    target: POLICY.target,
    action,
    restoredFromDeployId,
    restoredToDeployId: previousDeployId,
    restoredDeploy: sanitizeDeploy(previous.value),
    preflightEvidenceSha256: preflight.sha256,
    publishAttemptEvidenceSha256: attempt.sha256,
    rollbackAuthorizationChainEvidenceSha256: rollbackChain.sha256
  });
  const evidencePath = await writeJsonExclusive(
    required(env.CNYOS_CONTROLLER_ROLLBACK_EVIDENCE_PATH,
      'CNYOS_CONTROLLER_ROLLBACK_EVIDENCE_PATH_REQUIRED', 4096),
    evidence
  );
  return Object.freeze({ evidence, evidencePath });
}

async function main() {
  const command = process.argv[2];
  let result;
  if (command === 'preflight') result = await captureNetlifyPreflight();
  else if (command === 'draft-gate') result = await recordDraftGate();
  else if (command === 'promotion-attempt') result = await recordPromotionAttempt();
  else if (command === 'draft-receipt') result = await recordNetlifyDeployReceipt();
  else if (command === 'verify-draft') result = await verifyDraftDeployment();
  else if (command === 'promote') result = await promoteExactDraft();
  else if (command === 'verify-promoted') result = await verifyPromotedDeployment();
  else if (command === 'verify-final-current') result = await verifyPromotedDeployment({ finalCheck: true });
  else if (command === 'rollback') result = await rollbackPublishedDeployment();
  else fail('Usage: node netlify-evidence.mjs <preflight|draft-gate|draft-receipt|verify-draft|promotion-attempt|promote|verify-promoted|verify-final-current|rollback>');
  const bytes = await fs.readFile(result.evidencePath);
  process.stdout.write(`${JSON.stringify({
    evidencePath: result.evidencePath,
    evidenceSha256: sha256(bytes),
    netlifyDeployId: result.evidence.netlifyDeployId || result.evidence.draftDeployId ||
      result.evidence.promotedDeployId || null,
    previousDeployId: result.evidence.previousPublishedDeploy?.id ||
      result.evidence.restoredToDeployId || null,
    deployMessage: result.evidence.deployMessage || null
  })}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(error => {
    process.stderr.write(`${String(error?.message || 'CNYOS_CONTROLLER_NETLIFY_EVIDENCE_FAILED')}\n`);
    process.exitCode = 1;
  });
}
