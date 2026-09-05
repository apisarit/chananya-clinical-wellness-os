import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readiness = JSON.parse(fs.readFileSync(path.join(root, 'release-readiness.json'), 'utf8'));
const shaPattern = /^[0-9a-f]{40}$/i;
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const head = git('rev-parse', 'HEAD');
const exactCommit = String(process.env.GITHUB_SHA || head).trim();

assert.match(exactCommit, shaPattern, 'production promotion requires a full 40-character commit SHA');
assert.equal(head, exactCommit, 'checked-out commit must exactly match the promotion commit');
assert.ok(readiness.schemaVersion >= 2, 'production promotion requires release-readiness schema v2 or newer');
assert.equal(readiness.releaseChannel, 'production', 'releaseChannel must be production before promotion');
assert.equal(readiness.status, 'production_ready', 'status must be production_ready before promotion');
assert.equal(readiness.commercialProductionReady, true, 'commercialProductionReady must be true before promotion');
assert.equal(readiness.releaseCommit, exactCommit, 'releaseCommit must equal the exact checked-out commit');
assert.equal(readiness.promotionPolicy?.allRequiredGatesMustPass, true);
assert.equal(readiness.promotionPolicy?.evidenceMustMatchReleaseCommit, true);
assert.equal(
  readiness.promotionPolicy?.postDeployAttestationRequiredBeforeRealPatientData,
  true,
  'promotion policy must keep real patient data blocked until post-deploy attestation'
);
assert.equal(readiness.postDeploymentGate?.id, 'public_production_deployment_attestation');
assert.equal(readiness.postDeploymentGate?.status, 'pending', 'post-deploy attestation must be pending before production deployment');
assert.equal(readiness.postDeploymentGate?.evidence, null, 'post-deploy evidence cannot exist before production deployment');
assert.equal(readiness.postDeploymentGate?.blocksRealPatientData, true, 'post-deploy gate must block real patient data');

const expectedGateIds = [
  'owner_subscription_database_enforcement',
  'authenticated_staging_all_roles',
  'line_callback',
  'encrypted_backup_restore_drill',
  'privacy_security_legal_review',
  'isolated_staging_migrations',
  'independent_quality_segregation',
  'managed_database_backup_pitr',
  'release_provenance_ci_merge_protection'
];

assert.deepEqual(
  readiness.requiredGates?.map(gate => gate.id),
  expectedGateIds,
  'production promotion requires the complete ordered pre-deployment hard-gate set'
);

const requiredEvidenceFields = readiness.promotionPolicy?.requiredEvidenceFields || [];
assert.deepEqual(
  requiredEvidenceFields,
  ['commit', 'artifact', 'verifiedAt', 'verifiedBy'],
  'production promotion evidence policy is incomplete'
);

for (const gate of readiness.requiredGates) {
  assert.equal(gate.status, 'passed', `${gate.id} has not passed`);
  assert.ok(gate.evidence && typeof gate.evidence === 'object', `${gate.id} has no retained evidence`);
  for (const field of requiredEvidenceFields) {
    assert.ok(String(gate.evidence[field] || '').trim(), `${gate.id} evidence is missing ${field}`);
  }
  assert.equal(gate.evidence.commit, exactCommit, `${gate.id} evidence belongs to a different commit`);
  assert.match(gate.evidence.commit, shaPattern, `${gate.id} evidence commit is invalid`);
  assert.ok(Number.isFinite(Date.parse(gate.evidence.verifiedAt)), `${gate.id} verifiedAt is not an ISO-compatible timestamp`);
}

process.stdout.write(`Production promotion gate passed for ${exactCommit}: ${readiness.requiredGates.length}/${readiness.requiredGates.length} pre-deployment hard gates have exact-commit evidence; real patient data remains blocked pending post-deploy attestation.\n`);
