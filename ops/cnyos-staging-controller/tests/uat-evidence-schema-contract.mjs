import assert from 'node:assert/strict';
import {
  EXPECTED_SCHEDULED_ROUTE_DENIAL_FUNCTIONS,
  EXPECTED_SCHEDULED_ROUTE_DENIAL_METHODS,
  EXPECTED_STAGING_UAT_ROLES,
  EXPECTED_STAGING_UAT_ROUTES,
  validateAuthenticatedUatEvidence,
  validateScheduledFunctionRouteDenialEvidence
} from '../scripts/finalize-evidence.mjs';
import { POLICY } from '../scripts/policy.mjs';

const commit = 'a'.repeat(40);
const tree = 'b'.repeat(40);
const deployId = '0123456789abcdef01234567';
const pointer = label => ({ sha256: 'c'.repeat(64), reference: `protected:${label}` });

function validUat() {
  return {
    schemaVersion: 1,
    evidenceType: 'cnyos_staging_controller_authenticated_uat',
    status: 'passed',
    controllerOwnedHarness: true,
    syntheticOnly: true,
    realPatientDataAuthorized: false,
    sourceCommit: commit,
    sourceTree: tree,
    netlifyDeployId: deployId,
    target: {
      netlifySiteId: POLICY.target.netlifySiteId,
      supabaseProjectRef: POLICY.target.supabaseProjectRef,
      clinicId: POLICY.target.clinicId
    },
    identityProvisioning: {
      status: 'passed',
      syntheticUserCount: 11,
      roleCount: 11,
      roles: [...EXPECTED_STAGING_UAT_ROLES],
      evidence: pointer('identity-provisioning')
    },
    accessControl: {
      status: 'passed',
      currentAccessContextRoleCount: 11,
      departmentCanRoleCount: 11,
      crossTenantDenialsVerified: true,
      evidence: pointer('access-control')
    },
    routeMatrix: {
      status: 'passed',
      browser: 'mobile_chromium',
      roleCount: 11,
      routeCount: 10,
      authorizationDecisionCount: 110,
      deniedRouteBehaviorVerified: true,
      routes: [...EXPECTED_STAGING_UAT_ROUTES],
      evidence: pointer('route-matrix')
    },
    syntheticJourneys: {
      status: 'passed',
      caseCount: 10,
      passed: 10,
      failed: 0,
      clinicalToPaymentVerified: true,
      evidence: pointer('synthetic-journeys')
    },
    migrationHealth: {
      status: 'passed',
      exactLedgerVerified: true,
      evidence: pointer('migration-health')
    },
    auditAndSegregation: {
      status: 'passed',
      producerApproverSeparationVerified: true,
      evidence: pointer('audit-segregation')
    },
    subscriptionRestoration: {
      status: 'passed',
      initialState: 'on',
      offStateVerified: true,
      onStateRestored: true,
      originalTenantBoundaryRestored: true,
      evidence: pointer('subscription-restoration')
    },
    unresolvedFailures: 0
  };
}

assert.equal(validateAuthenticatedUatEvidence(validUat(), { commit, tree, deployId }), true);

for (const [label, mutate, pattern] of [
  ['missing role', value => value.identityProvisioning.roles.pop(), /IDENTITY_PROVISIONING_INVALID/],
  ['same count with duplicate role', value => { value.identityProvisioning.roles[10] = 'viewer'; value.identityProvisioning.roles[9] = 'viewer'; }, /IDENTITY_PROVISIONING_INVALID/],
  ['incomplete access matrix', value => { value.accessControl.departmentCanRoleCount = 10; }, /ACCESS_CONTROL_INVALID/],
  ['missing denied-route proof', value => { value.routeMatrix.deniedRouteBehaviorVerified = false; }, /ROUTE_MATRIX_INVALID/],
  ['one failed journey', value => { value.syntheticJourneys.passed = 9; value.syntheticJourneys.failed = 1; }, /JOURNEYS_INVALID/],
  ['unverified migration ledger', value => { value.migrationHealth.exactLedgerVerified = false; }, /DATABASE_GATES_INVALID/],
  ['subscription not restored', value => { value.subscriptionRestoration.onStateRestored = false; }, /SUBSCRIPTION_RESTORATION_INVALID/],
  ['unresolved failure', value => { value.unresolvedFailures = 1; }, /UAT_EVIDENCE_INVALID/],
  ['missing gate hash', value => { delete value.routeMatrix.evidence.sha256; }, /ROUTE_MATRIX_INVALID/]
]) {
  const candidate = validUat();
  mutate(candidate);
  assert.throws(
    () => validateAuthenticatedUatEvidence(candidate, { commit, tree, deployId }),
    pattern,
    label
  );
}

const controllerRuntime = Object.freeze({
  repository: POLICY.controller.repository,
  ref: POLICY.controller.protectedRef,
  commit: 'd'.repeat(40),
  runId: '123456'
});
const postPromotionVerifiedAt = new Date('2026-09-08T12:00:00.000Z');
const routeDeniedAt = new Date('2026-09-08T12:01:00.000Z');
const uatCompletedAt = new Date('2026-09-08T12:02:00.000Z');
const routeObservedAt = new Date('2026-09-08T12:03:00.000Z');
const immutableOrigin = `https://${deployId}--${POLICY.target.netlifySiteName}.netlify.app`;

function validScheduledRouteDenial() {
  const probes = [];
  for (const [originKind, origin] of [
    ['immutable', immutableOrigin],
    ['canonical', POLICY.target.netlifyOrigin]
  ]) {
    for (const functionName of EXPECTED_SCHEDULED_ROUTE_DENIAL_FUNCTIONS) {
      for (const method of EXPECTED_SCHEDULED_ROUTE_DENIAL_METHODS) {
        probes.push({
          originKind,
          origin,
          functionName,
          method,
          path: `/.netlify/functions/${functionName}`,
          requestBodyKind: method === 'GET' ? 'none' : 'deliberately_malformed_json',
          status: 404,
          responseApplicationShaped: false,
          redirectFollowed: false,
          credentialForwarded: false
        });
      }
    }
  }
  return {
    schemaVersion: 1,
    evidenceType: 'cnyos_staging_controller_scheduled_function_route_denial',
    status: 'passed',
    scope: 'cnyos_staging_only',
    productionAuthorization: false,
    verifiedAt: routeDeniedAt.toISOString(),
    controllerRepository: controllerRuntime.repository,
    controllerRef: controllerRuntime.ref,
    controllerCommit: controllerRuntime.commit,
    controllerRunId: controllerRuntime.runId,
    source: { repository: POLICY.sourceRepository, commit, tree },
    target: { ...POLICY.target },
    netlifyDeployId: deployId,
    immutableOrigin,
    canonicalOrigin: POLICY.target.netlifyOrigin,
    currentPublishedDeployIdBefore: deployId,
    currentPublishedDeployIdAfter: deployId,
    probes
  };
}

const routeValidationOptions = Object.freeze({
  runtime: controllerRuntime,
  commit,
  tree,
  deployId,
  observedAt: routeObservedAt,
  notBefore: postPromotionVerifiedAt,
  notAfter: uatCompletedAt
});
assert.equal(
  validateScheduledFunctionRouteDenialEvidence(
    validScheduledRouteDenial(),
    routeValidationOptions
  ).toISOString(),
  routeDeniedAt.toISOString()
);
for (const [label, mutate] of [
  ['successful public response', value => { value.probes[0].status = 200; }],
  ['application-shaped denial', value => { value.probes[1].responseApplicationShaped = true; }],
  ['credential forwarding', value => { value.probes[2].credentialForwarded = true; }],
  ['redirect following', value => { value.probes[3].redirectFollowed = true; }],
  ['duplicate probe', value => { value.probes[7] = { ...value.probes[0] }; }],
  ['wrong malformed body', value => { value.probes[1].requestBodyKind = 'none'; }],
  ['extra unreviewed field', value => { value.probes[0].body = 'ignored'; }],
  ['stale evidence', value => { value.verifiedAt = '2026-09-08T11:52:59.999Z'; }],
  ['publish race', value => { value.currentPublishedDeployIdAfter = 'f'.repeat(24); }]
]) {
  const candidate = validScheduledRouteDenial();
  mutate(candidate);
  assert.throws(
    () => validateScheduledFunctionRouteDenialEvidence(candidate, routeValidationOptions),
    /CNYOS_FINAL_SCHEDULED_ROUTE_DENIAL/,
    label
  );
}

process.stdout.write('CNYOS authenticated-UAT evidence schema contract: passed\n');
