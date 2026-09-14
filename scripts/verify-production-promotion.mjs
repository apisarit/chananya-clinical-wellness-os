import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shaPattern = /^[0-9a-f]{40}$/i;
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const placeholder = /^(?:REPLACE[_ -]WITH|TODO\b|TBD\b|<.*>|\{\{.*\}\})/i;
const evidenceText = value => typeof value === 'string' && value.trim().length > 0 && !placeholder.test(value.trim());
const timestamp = value => evidenceText(value) && Number.isFinite(Date.parse(value));

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

  const issues = inspectAttestation(readiness, attestation, exactCommit);
  // Never print assertion diffs containing values from the protected secret.
  if (issues.length) throw new Error(issues[0].message);
  return true;
}

export function resolveReleaseCommit({ head, env = {} }) {
  const expected = String(env.EXPECTED_RELEASE_COMMIT || '').trim();
  const workflowCommit = String(env.GITHUB_SHA || '').trim();
  const exactCommit = expected || workflowCommit || head;
  assert.match(exactCommit, shaPattern, 'production promotion requires a full 40-character commit SHA');
  if (head !== exactCommit) throw new Error('checked-out commit must exactly match the promotion commit');
  if (workflowCommit && workflowCommit !== exactCommit) throw new Error('GITHUB_SHA must match EXPECTED_RELEASE_COMMIT');
  return exactCommit;
}

export function inspectAttestation(readiness, attestation, exactCommit) {
  const issues = [];
  const check = (valid, code, message, gateId) => {
    if (!valid) issues.push({ code, message, ...(gateId ? { gateId } : {}) });
  };
  check(attestation?.schemaVersion === 1, 'ATTESTATION_SCHEMA_INVALID', 'production attestation schema mismatch');
  check(attestation?.evidenceType === 'cnyos_production_release_attestation', 'ATTESTATION_TYPE_INVALID', 'production attestation evidence type mismatch');
  check(attestation?.approvedForProduction === true, 'APPROVAL_REQUIRED', 'production attestation is not approved');
  check(shaPattern.test(exactCommit || '') && attestation?.releaseCommit === exactCommit,
    'APPROVAL_COMMIT_MISMATCH', 'production attestation belongs to a different commit');
  for (const field of ['approvalReference', 'approvedBy']) {
    check(evidenceText(attestation?.[field]), 'APPROVAL_EVIDENCE_MISSING', `production attestation ${field} missing or placeholder`);
  }
  check(timestamp(attestation?.approvedAt), 'APPROVAL_TIMESTAMP_INVALID', 'production attestation approvedAt invalid');
  check(attestation?.realPatientDataAdmission === 'blocked_pending_post_deploy_attestation',
    'PATIENT_DATA_ADMISSION_NOT_BLOCKED', 'real patient data must remain blocked before production deployment attestation');

  const gates = Array.isArray(attestation?.gates) ? attestation.gates : [];
  const ids = readiness.requiredGates.map(gate => gate.id);
  check(gates.length === ids.length && gates.every((gate, index) => gate?.id === ids[index]),
    'GATE_SET_MISMATCH', 'production attestation gate set/order mismatch');
  for (const id of ids) {
    const gate = gates.find(item => item?.id === id);
    check(gate?.status === 'passed', 'GATE_NOT_PASSED', `${id} has not passed`, id);
    for (const field of readiness.promotionPolicy.requiredEvidenceFields) {
      check(evidenceText(gate?.[field]), 'GATE_EVIDENCE_MISSING', `${id} evidence is missing ${field} or contains a placeholder`, id);
    }
    check(gate?.commit === exactCommit, 'GATE_COMMIT_MISMATCH', `${id} evidence belongs to a different commit`, id);
    check(timestamp(gate?.verifiedAt), 'GATE_TIMESTAMP_INVALID', `${id} verifiedAt invalid`, id);
  }
  return issues;
}

export function prepareProductionAttestation(readiness, exactCommit) {
  assert.match(exactCommit, shaPattern);
  return {
    schemaVersion: 1,
    evidenceType: 'cnyos_production_release_attestation',
    approvedForProduction: false,
    releaseCommit: exactCommit,
    approvalReference: null,
    approvedAt: null,
    approvedBy: null,
    realPatientDataAdmission: 'blocked_pending_post_deploy_attestation',
    gates: readiness.requiredGates.map(({ id }) => ({
      id, status: 'pending', commit: exactCommit, artifact: null, verifiedAt: null, verifiedBy: null
    }))
  };
}

export function assessProductionGate({ readiness, head, env = {} }) {
  const blockers = [];
  let exactCommit = null;
  let attestation = null;
  try { exactCommit = resolveReleaseCommit({ head, env }); }
  catch { blockers.push({ code: 'RELEASE_COMMIT_MISMATCH', message: 'HEAD, EXPECTED_RELEASE_COMMIT and GITHUB_SHA must identify the same full commit.' }); }
  try { attestation = parseProductionAttestation(env.PRODUCTION_RELEASE_ATTESTATION_JSON); }
  catch (error) {
    blockers.push({ code: error.message, message: error.message.endsWith('_REQUIRED')
      ? 'Supply the completed exact-commit approval as PRODUCTION_RELEASE_ATTESTATION_JSON in the protected production environment.'
      : 'The production approval must be valid JSON; its contents have not been logged.' });
  }
  if (attestation !== null && exactCommit) {
    blockers.push(...inspectAttestation(readiness, attestation, exactCommit));
    try { validateProductionAttestation(readiness, attestation, exactCommit); }
    catch {
      if (!blockers.length) blockers.push({ code: 'SOURCE_POLICY_INVALID', message: 'The source release policy must remain fail closed.' });
    }
  } else if (attestation === null && String(env.PRODUCTION_RELEASE_ATTESTATION_JSON || '').trim() === 'null') {
    blockers.push({ code: 'ATTESTATION_SCHEMA_INVALID', message: 'The production approval must be a JSON object.' });
  }
  if (env.RELEASE_GATE_REQUIRE_DEPLOY_CONFIG === 'true') {
    for (const name of ['NETLIFY_SITE_ID', 'NETLIFY_AUTH_TOKEN', 'PRODUCTION_SITE_URL', 'EXPECTED_PRODUCTION_HOST', 'CLINICAL_OS_PRODUCTION_CONFIG_JSON']) {
      if (!String(env[name] || '').trim()) blockers.push({ code: 'DEPLOY_CONFIGURATION_MISSING', message: `Configure ${name} in the protected production environment.` });
    }
    if (env.PRODUCTION_SITE_URL && env.EXPECTED_PRODUCTION_HOST) {
      let validOrigin = false;
      try {
        const url = new URL(env.PRODUCTION_SITE_URL);
        validOrigin = url.protocol === 'https:' && url.hostname === env.EXPECTED_PRODUCTION_HOST && !url.username && !url.password && !url.port && url.pathname === '/' && !url.search && !url.hash;
      } catch { /* Report only a constant message, never the configured value. */ }
      if (!validOrigin) blockers.push({ code: 'PRODUCTION_ORIGIN_INVALID', message: 'PRODUCTION_SITE_URL must be the HTTPS origin of EXPECTED_PRODUCTION_HOST.' });
    }
  }
  return {
    schemaVersion: 1,
    evidenceType: 'production_release_gate_report',
    releaseCommit: exactCommit,
    status: blockers.length ? 'blocked' : 'approval_validated',
    realPatientDataAdmission: 'blocked_pending_post_deploy_attestation',
    blockers,
    requiredGates: readiness.requiredGates.map(({ id }) => ({ id,
      status: !attestation || !exactCommit ? 'not_evaluated' : blockers.some(issue => !issue.gateId || issue.gateId === id) ? 'evidence_not_accepted' : 'evidence_accepted'
    })),
    note: 'This report validates supplied approval records. It does not perform the live operational reviews or admit real patient data.'
  };
}

function writeGateReport(report, env) {
  const directory = path.resolve(env.RELEASE_GATE_EVIDENCE_DIR || path.join(root, 'artifacts/production-gate'));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, 'gate-report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  const summary = [
    `Production release gate: ${report.status}`,
    `Commit: ${report.releaseCommit || 'not resolved'}`,
    '',
    ...report.blockers.map(issue => `- ${issue.code}: ${issue.message}`),
    '', report.note, ''
  ].join('\n');
  fs.writeFileSync(path.join(directory, 'gate-report.txt'), summary, { mode: 0o600 });
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  process.stdout.write(summary);
  return directory;
}

export function verifyProductionPromotion({ env = process.env } = {}) {
  const readiness = JSON.parse(fs.readFileSync(path.join(root, 'release-readiness.json'), 'utf8'));
  const report = assessProductionGate({ readiness, head: git('rev-parse', 'HEAD'), env });
  writeGateReport(report, env);
  if (report.status !== 'approval_validated') throw new Error('PRODUCTION_RELEASE_BLOCKED: see the gate report for required actions.');
  return parseProductionAttestation(env.PRODUCTION_RELEASE_ATTESTATION_JSON);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--prepare') {
      const readiness = JSON.parse(fs.readFileSync(path.join(root, 'release-readiness.json'), 'utf8'));
      const head = git('rev-parse', 'HEAD');
      const exactCommit = resolveReleaseCommit({ head, env: process.env });
      const report = assessProductionGate({ readiness, head, env: process.env });
      const directory = writeGateReport(report, process.env);
      fs.writeFileSync(path.join(directory, 'attestation-draft.json'), `${JSON.stringify(prepareProductionAttestation(readiness, exactCommit), null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      process.stdout.write('Created an unapproved draft. Preparation does not pass the gate or authorize deployment.\n');
    } else if (process.argv.length === 2) {
      verifyProductionPromotion();
    } else {
      throw new Error('Usage: node scripts/verify-production-promotion.mjs [--prepare]');
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
