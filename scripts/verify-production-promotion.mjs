import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shaPattern = /^[0-9a-f]{40}$/i;
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

export function parseProductionAttestation(raw) {
  if (!String(raw || '').trim()) throw new Error('PRODUCTION_RELEASE_ATTESTATION_JSON_REQUIRED');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('PRODUCTION_RELEASE_ATTESTATION_JSON_INVALID');
  }
}

export function validateProductionAttestation(readiness, attestation, exactCommit) {
  assert.equal(readiness.schemaVersion, 3, 'production promotion requires release-readiness schema v3');
  assert.equal(readiness.productionApprovalSource, 'external_exact_commit_attestation');
  assert.equal(readiness.commercialProductionReady, false, 'source readiness baseline must remain fail closed');
  assert.equal(readiness.releaseCommit, null, 'source readiness must not self-reference a release commit');
  assert.equal(readiness.promotionPolicy?.sourceReadinessMustRemainFailClosed, true);
  assert.equal(readiness.promotionPolicy?.externalAttestationRequired, true);
  assert.equal(readiness.promotionPolicy?.externalAttestationEnvironment, 'production');
  assert.equal(readiness.promotionPolicy?.externalAttestationSecret, 'PRODUCTION_RELEASE_ATTESTATION_JSON');
  assert.equal(readiness.promotionPolicy?.postDeployAttestationRequiredBeforeRealPatientData, true);
  assert.equal(readiness.postDeploymentGate?.blocksRealPatientData, true);

  assert.equal(attestation?.schemaVersion, 1, 'production attestation schema mismatch');
  assert.equal(attestation?.evidenceType, 'cnyos_production_release_attestation');
  assert.equal(attestation?.approvedForProduction, true, 'production attestation is not approved');
  assert.equal(attestation?.releaseCommit, exactCommit, 'production attestation belongs to a different commit');
  assert.match(attestation.releaseCommit, shaPattern, 'production attestation release commit is invalid');
  assert.ok(String(attestation?.approvalReference || '').trim(), 'production attestation approvalReference missing');
  assert.ok(String(attestation?.approvedBy || '').trim(), 'production attestation approvedBy missing');
  assert.ok(Number.isFinite(Date.parse(attestation?.approvedAt)), 'production attestation approvedAt invalid');
  assert.equal(
    attestation?.realPatientDataAdmission,
    'blocked_pending_post_deploy_attestation',
    'real patient data must remain blocked before production deployment attestation'
  );

  const expectedGateIds = readiness.requiredGates.map(gate => gate.id);
  assert.deepEqual(attestation.gates?.map(gate => gate.id), expectedGateIds, 'production attestation gate set/order mismatch');
  const requiredEvidenceFields = readiness.promotionPolicy?.requiredEvidenceFields || [];
  for (const gate of attestation.gates) {
    assert.equal(gate.status, 'passed', `${gate.id} has not passed`);
    for (const field of requiredEvidenceFields) {
      assert.ok(String(gate[field] || '').trim(), `${gate.id} evidence is missing ${field}`);
    }
    assert.equal(gate.commit, exactCommit, `${gate.id} evidence belongs to a different commit`);
    assert.match(gate.commit, shaPattern, `${gate.id} evidence commit is invalid`);
    assert.ok(Number.isFinite(Date.parse(gate.verifiedAt)), `${gate.id} verifiedAt invalid`);
  }
  return true;
}

export function verifyProductionPromotion({ env = process.env } = {}) {
  const readiness = JSON.parse(fs.readFileSync(path.join(root, 'release-readiness.json'), 'utf8'));
  const head = git('rev-parse', 'HEAD');
  const exactCommit = String(env.GITHUB_SHA || head).trim();
  assert.match(exactCommit, shaPattern, 'production promotion requires a full 40-character commit SHA');
  assert.equal(head, exactCommit, 'checked-out commit must exactly match the promotion commit');
  const attestation = parseProductionAttestation(env.PRODUCTION_RELEASE_ATTESTATION_JSON);
  validateProductionAttestation(readiness, attestation, exactCommit);
  process.stdout.write(`Production promotion gate passed for ${exactCommit}: ${attestation.gates.length}/${attestation.gates.length} external exact-commit gates approved; real patient data remains blocked pending post-deploy attestation.\n`);
  return attestation;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    verifyProductionPromotion();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
