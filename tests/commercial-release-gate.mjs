import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const readiness = JSON.parse(read('release-readiness.json'));
const preview = read('ui-review.html');
const coverage = read('docs/PLATFORM_COVERAGE_AND_RELEASE_GATES.md');

assert.equal(readiness.schemaVersion, 2, 'release readiness schema must include promotion evidence policy');
assert.equal(readiness.releaseChannel, 'preview', 'unverified release must remain on the preview channel');
assert.equal(readiness.commercialProductionReady, false, 'commercial production claim must fail closed');
assert.equal(readiness.status, 'production_candidate_under_verification');
assert.equal(readiness.releaseCommit, null, 'unverified release must not carry a production release commit');
assert.equal(readiness.promotionPolicy?.allRequiredGatesMustPass, true);
assert.equal(readiness.promotionPolicy?.evidenceMustMatchReleaseCommit, true);
assert.equal(readiness.promotionPolicy?.postDeployAttestationRequiredBeforeRealPatientData, true);
assert.deepEqual(
  readiness.promotionPolicy?.requiredEvidenceFields,
  ['commit', 'artifact', 'verifiedAt', 'verifiedBy'],
  'promotion evidence must identify exact commit, retained artifact, verification time and reviewer'
);
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
  ],
  'all hard pre-deployment commercial release gates must remain explicit and ordered'
);
for (const gate of readiness.requiredGates) {
  assert.equal(gate.status, 'pending', `${gate.id} must remain pending until evidence exists`);
  assert.equal(gate.evidence, null, `${gate.id} must not carry invented evidence`);
}
assert.equal(readiness.postDeploymentGate?.id, 'public_production_deployment_attestation');
assert.equal(readiness.postDeploymentGate?.status, 'pending', 'post-deploy attestation must remain pending before deployment');
assert.equal(readiness.postDeploymentGate?.evidence, null, 'post-deploy evidence must not be invented before deployment');
assert.equal(readiness.postDeploymentGate?.blocksRealPatientData, true, 'real patient data must remain blocked until post-deploy attestation');
assert.match(preview, /ไม่ใช่ Commercial Production 100%/, 'Preview must show the release limitation on every workspace');
assert.match(coverage, /Preview \/ production candidate under verification/, 'coverage document must use the guarded release label');

console.log(`Commercial release gate passed: ${readiness.requiredGates.length} pre-deployment gates plus post-deploy admission gate fail closed`);
