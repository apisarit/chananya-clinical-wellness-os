import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const readiness = JSON.parse(read('release-readiness.json'));
const preview = read('ui-review.html');
const coverage = read('docs/PLATFORM_COVERAGE_AND_RELEASE_GATES.md');

assert.equal(readiness.schemaVersion, 3, 'release readiness schema must separate source policy from external approval');
assert.equal(readiness.releaseChannel, 'preview', 'source readiness baseline must remain preview');
assert.equal(readiness.commercialProductionReady, false, 'source-controlled production claim must remain fail closed');
assert.equal(readiness.status, 'production_candidate_under_verification');
assert.equal(readiness.releaseCommit, null, 'source readiness must never self-reference its own commit');
assert.equal(readiness.productionApprovalSource, 'external_exact_commit_attestation');
assert.equal(readiness.promotionPolicy?.allRequiredGatesMustPass, true);
assert.equal(readiness.promotionPolicy?.evidenceMustMatchReleaseCommit, true);
assert.equal(readiness.promotionPolicy?.sourceReadinessMustRemainFailClosed, true);
assert.equal(readiness.promotionPolicy?.externalAttestationRequired, true);
assert.equal(readiness.promotionPolicy?.externalAttestationEnvironment, 'production');
assert.equal(readiness.promotionPolicy?.externalAttestationSecret, 'PRODUCTION_RELEASE_ATTESTATION_JSON');
assert.equal(readiness.promotionPolicy?.postDeployAttestationRequiredBeforeRealPatientData, true);
assert.deepEqual(readiness.promotionPolicy?.requiredEvidenceFields, ['commit', 'artifact', 'verifiedAt', 'verifiedBy']);
assert.deepEqual(readiness.promotionPolicy?.requiredApprovalFields, ['releaseCommit', 'approvalReference', 'approvedAt', 'approvedBy']);
assert.deepEqual(
  readiness.requiredGates.map(gate => gate.id),
  [
    'owner_subscription_database_enforcement',
    'authenticated_staging_all_roles',
    'line_callback',
    'encrypted_backup_restore_drill',
    'privacy_security_legal_review',
    'isolated_staging_migrations',
    'independent_quality_segregation',
    'managed_database_backup_pitr',
    'operational_monitoring_incident_response',
    'release_provenance_ci_merge_protection'
  ]
);
for (const gate of readiness.requiredGates) {
  assert.equal(gate.status, 'pending', `${gate.id} source default must remain pending`);
  assert.equal(gate.evidence, null, `${gate.id} evidence must live outside the release commit`);
}
assert.equal(readiness.postDeploymentGate?.id, 'public_production_deployment_attestation');
assert.equal(readiness.postDeploymentGate?.status, 'pending');
assert.equal(readiness.postDeploymentGate?.evidence, null);
assert.equal(readiness.postDeploymentGate?.blocksRealPatientData, true);
assert.match(readiness.claimPolicy, /must not be mutated to approve its own Git commit/i, 'self-referential source approval must be forbidden');
assert.match(preview, /ไม่ใช่ Commercial Production 100%/, 'Preview must show the release limitation on every workspace');
assert.match(coverage, /Preview \/ production candidate under verification/, 'coverage document must use the guarded release label');

console.log(`Commercial release policy passed: ${readiness.requiredGates.length} gates require protected external exact-commit evidence; source remains fail closed`);
