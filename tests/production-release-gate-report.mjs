import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assessProductionGate, prepareProductionAttestation, resolveReleaseCommit,
  validateProductionAttestation
} from '../scripts/verify-production-promotion.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readiness = JSON.parse(fs.readFileSync(path.join(root, 'release-readiness.json'), 'utf8'));
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const other = head === 'a'.repeat(40) ? 'b'.repeat(40) : 'a'.repeat(40);
const draft = prepareProductionAttestation(readiness, head);
const fixtureApproval = {
  ...draft, approvedForProduction: true,
  approvalReference: 'test-fixture-only:review', approvedBy: 'test-fixture-only:approver',
  approvedAt: '2026-09-05T06:00:00.000Z',
  gates: draft.gates.map(gate => ({ ...gate, status: 'passed',
    artifact: `test-fixture-only:${gate.id}`, verifiedBy: 'test-fixture-only:verifier',
    verifiedAt: '2026-09-05T05:00:00.000Z'
  }))
};
const evaluate = (approval, overrides = {}) => assessProductionGate({ readiness, head, env: {
  EXPECTED_RELEASE_COMMIT: head, GITHUB_SHA: head,
  PRODUCTION_RELEASE_ATTESTATION_JSON: approval === undefined ? '' : JSON.stringify(approval),
  ...overrides
} });

assert.equal(resolveReleaseCommit({ head }), head);
assert.throws(() => resolveReleaseCommit({ head, env: { EXPECTED_RELEASE_COMMIT: other } }), /exactly match/);
assert.throws(() => resolveReleaseCommit({ head, env: { EXPECTED_RELEASE_COMMIT: head, GITHUB_SHA: other } }), /GITHUB_SHA/);
assert.throws(() => resolveReleaseCommit({ head, env: { EXPECTED_RELEASE_COMMIT: 'main' } }), /full 40-character/);
assert.equal(evaluate(fixtureApproval).status, 'approval_validated');
assert.equal(evaluate(fixtureApproval, { EXPECTED_RELEASE_COMMIT: other }).status, 'blocked');
assert.equal(evaluate({ ...fixtureApproval, releaseCommit: other }).status, 'blocked');

const missing = evaluate(undefined);
assert.equal(missing.status, 'blocked');
assert.equal(missing.blockers[0].code, 'PRODUCTION_RELEASE_ATTESTATION_JSON_REQUIRED');
assert.ok(missing.requiredGates.every(gate => gate.status === 'not_evaluated'));
for (const invalid of [null, false, 0, [], {}, 'not an approval']) assert.equal(evaluate(invalid).status, 'blocked');
const malformed = evaluate(undefined, { PRODUCTION_RELEASE_ATTESTATION_JSON: '{sensitive-invalid-content' });
assert.equal(malformed.blockers[0].code, 'PRODUCTION_RELEASE_ATTESTATION_JSON_INVALID');
assert.ok(!JSON.stringify(malformed).includes('sensitive-invalid-content'));

assert.equal(draft.approvedForProduction, false);
assert.ok(draft.gates.every(gate => gate.status === 'pending' && gate.commit === head && gate.artifact === null));
assert.equal(evaluate(draft).status, 'blocked');
assert.throws(() => validateProductionAttestation(readiness, draft, head), /not approved/);
const sourceTemplate = JSON.parse(fs.readFileSync(path.join(root, 'docs/PRODUCTION_RELEASE_ATTESTATION_TEMPLATE.json'), 'utf8'));
assert.equal(sourceTemplate.approvedForProduction, false);
assert.ok(sourceTemplate.gates.every(gate => gate.status === 'pending'));
assert.deepEqual(sourceTemplate.gates.map(gate => gate.id), readiness.requiredGates.map(gate => gate.id));

for (const placeholder of ['REPLACE_WITH_APPROVER', 'TODO', 'TBD', '<reviewer>', '{{reviewer}}', 123, {}]) {
  assert.equal(evaluate({ ...fixtureApproval, approvedBy: placeholder }).status, 'blocked');
  assert.equal(evaluate({ ...fixtureApproval, approvalReference: placeholder }).status, 'blocked');
  for (const field of ['artifact', 'verifiedBy']) {
    const candidate = structuredClone(fixtureApproval);
    candidate.gates[0][field] = placeholder;
    assert.equal(evaluate(candidate).status, 'blocked');
  }
}
for (const mutation of [
  candidate => { candidate.gates.reverse(); },
  candidate => { candidate.gates[1] = candidate.gates[0]; },
  candidate => { candidate.gates.pop(); },
  candidate => { candidate.gates[0].commit = other; },
  candidate => { candidate.gates[0].verifiedAt = 'invalid'; },
  candidate => { candidate.realPatientDataAdmission = 'allowed'; }
]) {
  const candidate = structuredClone(fixtureApproval);
  mutation(candidate);
  assert.equal(evaluate(candidate).status, 'blocked');
}

const brokenPolicy = structuredClone(readiness);
brokenPolicy.commercialProductionReady = true;
assert.equal(assessProductionGate({ readiness: brokenPolicy, head,
  env: { PRODUCTION_RELEASE_ATTESTATION_JSON: JSON.stringify(fixtureApproval) }
}).status, 'blocked');

const configuration = {
  RELEASE_GATE_REQUIRE_DEPLOY_CONFIG: 'true', NETLIFY_SITE_ID: 'test-site',
  NETLIFY_AUTH_TOKEN: 'private-token-sentinel', CLINICAL_OS_PRODUCTION_CONFIG_JSON: 'private-config-sentinel',
  PRODUCTION_SITE_URL: 'https://example.netlify.app', EXPECTED_PRODUCTION_HOST: 'example.netlify.app'
};
assert.equal(evaluate(fixtureApproval, configuration).status, 'approval_validated');
const missingConfig = evaluate(undefined, { RELEASE_GATE_REQUIRE_DEPLOY_CONFIG: 'true' });
assert.equal(missingConfig.blockers.filter(issue => issue.code === 'DEPLOY_CONFIGURATION_MISSING').length, 5);
for (const url of ['http://example.netlify.app', 'https://wrong.netlify.app', 'https://example.netlify.app/path', 'https://user:private@example.netlify.app']) {
  const report = evaluate(fixtureApproval, { ...configuration, PRODUCTION_SITE_URL: url });
  assert.equal(report.status, 'blocked');
  assert.ok(!JSON.stringify(report).includes('private'));
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cnyos-gate-test-'));
try {
  const script = path.join(root, 'scripts/verify-production-promotion.mjs');
  const run = (args = [], env = {}) => spawnSync(process.execPath, [script, ...args], {
    cwd: root, encoding: 'utf8', env: {
      ...process.env, GITHUB_SHA: head, EXPECTED_RELEASE_COMMIT: head,
      PRODUCTION_RELEASE_ATTESTATION_JSON: '', RELEASE_GATE_REQUIRE_DEPLOY_CONFIG: 'false',
      RELEASE_GATE_EVIDENCE_DIR: temporary, GITHUB_STEP_SUMMARY: path.join(temporary, 'summary.md'), ...env
    }
  });
  assert.equal(run().status, 1, 'missing approval must fail the actual gate command');
  assert.equal(JSON.parse(fs.readFileSync(path.join(temporary, 'gate-report.json'))).status, 'blocked');
  assert.equal(run(['--prepare']).status, 0, 'preparation is a separate non-promotion operation');
  const originalDraft = fs.readFileSync(path.join(temporary, 'attestation-draft.json'), 'utf8');
  assert.deepEqual(JSON.parse(originalDraft), draft);
  assert.equal(run(['--prepare']).status, 1, 'preparation must not overwrite an existing review draft');
  assert.equal(fs.readFileSync(path.join(temporary, 'attestation-draft.json'), 'utf8'), originalDraft);
  assert.equal(run(['--skip']).status, 1, 'unknown switches must not disable the gate');
  assert.equal(run([], { PRODUCTION_RELEASE_ATTESTATION_JSON: originalDraft }).status, 1);
  assert.equal(run([], { PRODUCTION_RELEASE_ATTESTATION_JSON: JSON.stringify(fixtureApproval) }).status, 0);

  const secret = structuredClone(fixtureApproval);
  secret.releaseCommit = 'private-commit-sentinel';
  secret.gates[0].id = 'private-id-sentinel';
  const result = run([], { ...configuration, PRODUCTION_RELEASE_ATTESTATION_JSON: JSON.stringify(secret) });
  assert.equal(result.status, 1);
  const retained = ['gate-report.json', 'gate-report.txt', 'summary.md'].map(name => fs.readFileSync(path.join(temporary, name), 'utf8')).join('\n');
  assert.doesNotMatch(result.stdout + result.stderr + retained, /private-[a-z-]+-sentinel|test-fixture-only/);

  // Exercise the actual shell confirmation fragment with a command-substitution payload.
  for (const filename of ['production-promotion-gate.yml', 'production-netlify-deploy.yml', 'production-post-deploy-smoke.yml']) {
    const workflow = fs.readFileSync(path.join(root, '.github/workflows', filename), 'utf8');
    const shell = workflow.match(/run: \|\n([\s\S]*?)\n\n/)?.[1].replace(/^          /gm, '');
    assert.ok(shell);
    assert.doesNotMatch(shell, /\$\{\{/, 'workflow inputs must not be interpolated into shell code');
    assert.match(workflow, /RELEASE_CONFIRMATION: \$\{\{ inputs.confirmation \}\}/);
    const confirmation = shell.match(/= "([A-Z_]+)"/)?.[1];
    assert.ok(confirmation);
    assert.equal(spawnSync('bash', ['-eu', '-c', shell], {
      env: { ...process.env, RELEASE_CONFIRMATION: confirmation }
    }).status, 0, 'the intended confirmation must still work');
    const marker = path.join(temporary, 'unexpected-execution');
    const attempted = spawnSync('bash', ['-eu', '-c', shell], { encoding: 'utf8',
      env: { ...process.env, RELEASE_CONFIRMATION: `$(touch ${marker})` }
    });
    assert.equal(attempted.status, 1);
    assert.equal(fs.existsSync(marker), false);
    if (filename !== 'production-post-deploy-smoke.yml') {
      assert.ok(workflow.indexOf('npm run verify:production-promotion') < workflow.indexOf('run: npm ci'), 'approval diagnostics must run before dependency installation');
      assert.doesNotMatch(workflow, /continue-on-error:/, 'failed approval must stop the release');
      assert.match(workflow, /Retain production[\s\S]*?if: always\(\)/, 'failure reports must be retained');
    }
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log('Production gate regression tests passed: exact commit, incomplete evidence, safe drafts, redacted reports and shell confirmations');
