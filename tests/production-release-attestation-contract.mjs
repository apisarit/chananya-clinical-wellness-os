import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProductionAttestation, validateProductionAttestation } from '../scripts/verify-production-promotion.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readiness = JSON.parse(fs.readFileSync(path.join(root, 'release-readiness.json'), 'utf8'));
const commit = 'a'.repeat(40);
const verifiedAt = '2026-09-05T06:00:00.000Z';
const valid = {
  schemaVersion: 1,
  evidenceType: 'cnyos_production_release_attestation',
  approvedForProduction: true,
  releaseCommit: commit,
  approvalReference: 'release-review-2026-09-05',
  approvedAt: verifiedAt,
  approvedBy: 'release-approver',
  realPatientDataAdmission: 'blocked_pending_post_deploy_attestation',
  gates: readiness.requiredGates.map(gate => ({
    id: gate.id,
    status: 'passed',
    commit,
    artifact: `artifact:${gate.id}`,
    verifiedAt,
    verifiedBy: `verifier:${gate.id}`
  }))
};

assert.deepEqual(parseProductionAttestation(JSON.stringify(valid)), valid);
assert.throws(() => parseProductionAttestation(''), /PRODUCTION_RELEASE_ATTESTATION_JSON_REQUIRED/);
assert.throws(() => parseProductionAttestation('{broken'), /PRODUCTION_RELEASE_ATTESTATION_JSON_INVALID/);
assert.equal(validateProductionAttestation(readiness, valid, commit), true);

assert.throws(
  () => validateProductionAttestation(readiness, { ...valid, releaseCommit: 'b'.repeat(40) }, commit),
  /different commit/
);
assert.throws(
  () => validateProductionAttestation(readiness, { ...valid, approvedForProduction: false }, commit),
  /not approved/
);
assert.throws(
  () => validateProductionAttestation(readiness, { ...valid, realPatientDataAdmission: 'allowed' }, commit),
  /real patient data must remain blocked/
);
assert.throws(
  () => validateProductionAttestation(readiness, { ...valid, gates: valid.gates.slice(1) }, commit),
  /gate set\/order mismatch/
);
assert.throws(
  () => validateProductionAttestation(readiness, {
    ...valid,
    gates: valid.gates.map((gate, index) => index === 0 ? { ...gate, status: 'pending' } : gate)
  }, commit),
  /has not passed/
);
assert.throws(
  () => validateProductionAttestation(readiness, {
    ...valid,
    gates: valid.gates.map((gate, index) => index === 0 ? { ...gate, artifact: '' } : gate)
  }, commit),
  /evidence is missing artifact/
);
assert.throws(
  () => validateProductionAttestation(readiness, {
    ...valid,
    gates: valid.gates.map((gate, index) => index === 0 ? { ...gate, commit: 'c'.repeat(40) } : gate)
  }, commit),
  /evidence belongs to a different commit/
);

const promotionWorkflow = fs.readFileSync(path.join(root, '.github/workflows/production-promotion-gate.yml'), 'utf8');
const deployWorkflow = fs.readFileSync(path.join(root, '.github/workflows/production-netlify-deploy.yml'), 'utf8');
for (const [name, workflow] of [['promotion', promotionWorkflow], ['deploy', deployWorkflow]]) {
  assert.match(workflow, /environment:\s*production/, `${name} workflow must use protected production environment`);
  assert.match(workflow, /secrets\.PRODUCTION_RELEASE_ATTESTATION_JSON/, `${name} workflow must load protected external attestation`);
  assert.match(workflow, /RELEASE_GATE_EVIDENCE_DIR:/, `${name} workflow must retain gate diagnostics when attestation is absent`);
  assert.match(workflow, /npm run verify:production-promotion/, `${name} workflow must validate external exact-commit approval`);
}

console.log('Production release attestation contract passed: protected external exact-commit approval avoids Git self-reference and keeps real data blocked');
