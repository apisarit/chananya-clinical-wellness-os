import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertProductionAdmissionUnlock
} from '../netlify/functions/_shared/owner-control.mjs';
import {
  parseAdmissionAttestation,
  parseProductionConfig,
  validateAdmissionAttestation
} from '../scripts/production-admission-support.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const readiness = JSON.parse(read('release-readiness.json'));
const commit = 'a'.repeat(40);
const tree = 'b'.repeat(40);
const clinicId = '11111111-1111-4111-8111-111111111111';
const clinicCode = 'CHANANYA';
const projectRef = 'abcdefghijklmnopqrst';
const origin = 'https://cnyos.netlify.app';
const config = parseProductionConfig(JSON.stringify({
  schemaVersion: 1,
  deploymentId: 'cnyos-production',
  tenant: { expectedClinicId: clinicId, expectedClinicCode: clinicCode },
  database: { provider: 'supabase', url: `https://${projectRef}.supabase.co`, publishableKey: 'publishable-test' }
}));
assert.equal(config.clinicId, clinicId);
assert.equal(config.clinicCode, clinicCode);
assert.equal(config.projectRef, projectRef);
assert.throws(() => parseProductionConfig('{broken'), /PRODUCTION_CONFIG_JSON_INVALID|CLINICAL_OS_PRODUCTION_CONFIG_JSON_INVALID/);
assert.throws(() => parseProductionConfig(JSON.stringify({
  schemaVersion: 1,
  tenant: { expectedClinicId: clinicId, expectedClinicCode: clinicCode },
  database: { provider: 'supabase', url: 'http://abcdefghijklmnopqrst.supabase.co' }
})), /PRODUCTION_SUPABASE_URL_INVALID/);

const inputOn = Object.freeze({ enabled: true, clinicCode, reason: 'Approved admission REL-2026-09-05' });
const inputOff = Object.freeze({ enabled: false, clinicCode, reason: 'Emergency suspension' });
await assertProductionAdmissionUnlock(inputOff, { environment: 'production' });
await assertProductionAdmissionUnlock(inputOn, { environment: 'staging' });
await assert.rejects(
  assertProductionAdmissionUnlock(inputOn, { environment: 'production', productionAdmissionEnabled: false }),
  /REAL_DATA_ADMISSION_LOCKED/
);
const admissionConfig = {
  environment: 'production',
  productionAdmissionEnabled: true,
  productionAdmissionReleaseCommit: commit,
  productionAdmissionApprovalReference: 'REL-2026-09-05',
  expectedSiteOrigin: origin,
  deploymentId: 'cnyos-production'
};
const validManifest = {
  source: { commit, verified: true },
  build: { context: 'production' },
  safety: { previewLocked: false, databaseLocked: false },
  deploymentId: 'cnyos-production',
  tenant: { expectedClinicCode: clinicCode }
};
assert.equal(await assertProductionAdmissionUnlock(inputOn, admissionConfig, async () => ({
  ok: true,
  json: async () => validManifest
})), true);
await assert.rejects(
  assertProductionAdmissionUnlock({ ...inputOn, reason: 'Approved without matching reference' }, admissionConfig, async () => ({ ok: true, json: async () => validManifest })),
  /ADMISSION_REFERENCE_REQUIRED/
);
await assert.rejects(
  assertProductionAdmissionUnlock(inputOn, admissionConfig, async () => ({
    ok: true,
    json: async () => ({ ...validManifest, source: { commit: 'c'.repeat(40), verified: true } })
  })),
  /ADMISSION_DEPLOYMENT_UNVERIFIED/
);

const attestation = {
  schemaVersion: 1,
  evidenceType: 'cnyos_real_patient_data_admission_attestation',
  admitRealPatientData: true,
  releaseCommit: commit,
  releaseTree: tree,
  netlifyDeployId: 'abcdefabcdefabcdefabcdef',
  clinicId,
  clinicCode,
  productionOrigin: origin,
  expectedSubscriptionVersion: 7,
  postDeployArtifact: 'artifact:postdeploy',
  postDeployVerifiedAt: '2026-09-05T06:00:00.000Z',
  monitoringArtifact: 'artifact:monitoring',
  monitoringVerifiedAt: '2026-09-05T06:05:00.000Z',
  approvalReference: 'REL-2026-09-05',
  approvedAt: '2026-09-05T06:10:00.000Z',
  approvedBy: 'release-owner'
};
assert.deepEqual(parseAdmissionAttestation(JSON.stringify(attestation)), attestation);
assert.throws(() => parseAdmissionAttestation(''), /ATTESTATION_JSON_REQUIRED/);
assert.equal(validateAdmissionAttestation(attestation, { source: { commit, tree }, target: config, origin }).expectedSubscriptionVersion, 7);
assert.throws(() => validateAdmissionAttestation({ ...attestation, releaseTree: 'd'.repeat(40) }, { source: { commit, tree }, target: config, origin }), /another Git tree/);
assert.throws(() => validateAdmissionAttestation({ ...attestation, approvedAt: '2026-09-05T05:00:00.000Z' }, { source: { commit, tree }, target: config, origin }), /predates post-deploy verification/);

assert.equal(readiness.realDataAdmissionGate?.id, 'production_real_patient_data_admission');
assert.equal(readiness.realDataAdmissionGate?.status, 'pending');
assert.equal(readiness.realDataAdmissionGate?.evidence, null);
assert.equal(readiness.realDataAdmissionGate?.requiresDatabaseSuspensionBeforeDeploy, true);
assert.equal(readiness.realDataAdmissionGate?.requiresAuditedOwnerActivation, true);

const deployWorkflow = read('.github/workflows/production-netlify-deploy.yml');
const approvalWorkflow = read('.github/workflows/production-real-data-admission-approval.yml');
const verifyWorkflow = read('.github/workflows/production-real-data-admission-verify.yml');
for (const [name, workflow] of [['approval', approvalWorkflow], ['verification', verifyWorkflow]]) {
  assert.match(workflow, /on:\s*\n\s*workflow_dispatch:/, `${name} must be manual only`);
  assert.doesNotMatch(workflow, /\n\s*(?:push|pull_request|schedule|issue_comment):/, `${name} must not have automatic triggers`);
  assert.match(workflow, /environment:\s*production/, `${name} must use the production environment`);
  assert.match(workflow, /secrets\.PRODUCTION_ADMISSION_ATTESTATION_JSON/, `${name} must use protected admission attestation`);
  assert.match(workflow, /secrets\.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY/, `${name} must use protected database credential`);
  assert.match(workflow, /retention-days:\s*365/, `${name} must retain evidence`);
}
const lockIndex = deployWorkflow.indexOf('npm run verify:production-admission-lock');
const buildIndex = deployWorkflow.indexOf('npm run build');
const deployIndex = deployWorkflow.indexOf('netlify deploy');
assert.ok(lockIndex >= 0 && lockIndex < buildIndex && lockIndex < deployIndex, 'database suspension must be proven before production build/upload');
assert.match(deployWorkflow, /CNYOS_PRODUCTION_ADMISSION_LOCK_ACK:\s*VERIFY_SUSPENDED_TENANT/);

const approvalPromotion = approvalWorkflow.indexOf('npm run verify:production-promotion');
const approvalPublic = approvalWorkflow.indexOf('npm run verify:public-deployment');
const approvalCheck = approvalWorkflow.indexOf('npm run verify:production-admission-approval');
assert.ok(approvalPromotion >= 0 && approvalPromotion < approvalPublic && approvalPublic < approvalCheck, 'admission approval ordering invalid');
const verifyPromotion = verifyWorkflow.indexOf('npm run verify:production-promotion');
const verifyPublic = verifyWorkflow.indexOf('npm run verify:public-deployment');
const verifyActive = verifyWorkflow.indexOf('npm run verify:production-admission-active');
assert.ok(verifyPromotion >= 0 && verifyPromotion < verifyPublic && verifyPublic < verifyActive, 'final admission verification ordering invalid');

const support = read('scripts/production-admission-support.mjs');
const approvalScript = read('scripts/verify-production-admission-approval.mjs');
const activeScript = read('scripts/verify-production-admission-active.mjs');
assert.doesNotMatch(support, /set_clinic_subscription_state/, 'admission support must remain read-only');
assert.doesNotMatch(approvalScript, /set_clinic_subscription_state/, 'admission approval verifier must remain read-only');
assert.doesNotMatch(activeScript, /set_clinic_subscription_state/, 'final admission verifier must remain read-only');

const ownerFunction = read('netlify/functions/owner-subscription.mts');
const guardIndex = ownerFunction.indexOf('assertProductionAdmissionUnlock(input, config');
const writeIndex = ownerFunction.indexOf("resource: '/rest/v1/rpc/set_clinic_subscription_state'");
assert.ok(guardIndex >= 0 && guardIndex < writeIndex, 'production Owner admission guard must run before subscription mutation');
assert.match(ownerFunction, /CNYOS_REAL_DATA_ADMISSION_ENABLED/);
assert.match(ownerFunction, /CNYOS_REAL_DATA_ADMISSION_RELEASE_COMMIT/);
assert.match(ownerFunction, /CNYOS_REAL_DATA_ADMISSION_APPROVAL_REFERENCE/);

const stagingHarness = read('scripts/verify-authenticated-staging.mjs');
assert.match(stagingHarness, /p_expected_version:\s*initialVersion/, 'staging OFF proof must use optimistic concurrency version');
assert.match(stagingHarness, /p_expected_version:\s*suspendedVersion/, 'staging ON restore must use suspended version');
assert.match(stagingHarness, /offRetryIdempotent/, 'staging proof must retain idempotent retry evidence');
assert.match(stagingHarness, /restoredVersion/, 'staging proof must retain restored version evidence');

console.log('Production admission lock contract passed: DB OFF before deploy, exact-release Owner guard, human activation and read-only final verification');
