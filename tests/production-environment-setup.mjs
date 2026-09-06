import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { prepareSetup, publicPlan, applySetup, verifySetupProtection, parseArgs, target, requiredReleaseCheck } from '../scripts/setup-production-environment.mjs';
import { prepareProductionAttestation } from '../scripts/verify-production-promotion.mjs';

const read = file => JSON.parse(fs.readFileSync(new URL(`../${file}`, import.meta.url)));
const readiness = read('release-readiness.json');
const stagingConfig = read('config/tenant.cnyos-staging.json');
const commit = 'a'.repeat(40);
const token = 'TEST_ONLY_NETLIFY_TOKEN_NEVER_USE';
const config = read('config/tenant.example.json');
config.deploymentId = 'cnyos-production';
config.tenant = { expectedClinicId: '12345678-1234-4123-8123-123456789012', expectedClinicCode: 'CNYOS' };
config.identity.qrIssuer = 'CNYOS';
config.auth.redirectOrigin = target.origin;
config.database = { provider: 'supabase', url: 'https://production-fixture.supabase.co', publishableKey: 'sb_publishable_TEST_ONLY_NO_REAL_ACCESS' };
const attestation = prepareProductionAttestation(readiness, commit);
Object.assign(attestation, { approvedForProduction: true, approvalReference: 'TEST ONLY', approvedBy: 'TEST ONLY', approvedAt: '2026-09-05T12:00:00Z' });
for (const gate of attestation.gates) Object.assign(gate, { status: 'passed', artifact: 'TEST ONLY', verifiedBy: 'TEST ONLY', verifiedAt: '2026-09-05T12:00:00Z' });
// Synthetic records remain in test memory and are never written to a file or API.
const input = { commit, token, config, attestation, readiness, stagingConfig };
const good = prepareSetup(input);
assert.deepEqual(good.blockers, []);
const missing = prepareSetup({ ...input, token: '', config: null, attestation: null });
assert.equal(missing.blockers.length, 3);
assert.throws(() => applySetup(missing, () => assert.fail('No call allowed')), /SETUP_INPUTS_BLOCKED/);
assert(!JSON.stringify(publicPlan(good)).includes(token));
assert(!JSON.stringify(publicPlan(good)).includes(config.database.publishableKey));
assert(!JSON.stringify(publicPlan(good)).includes(attestation.approvalReference));
for (const value of [stagingConfig, { ...config, deploymentId: 'cnyos-staging' }, { ...config, database: stagingConfig.database }, { ...config, auth: { ...config.auth, redirectOrigin: 'https://wrong.example' } }]) {
  assert(prepareSetup({ ...input, config: value }).blockers.includes('PRODUCTION_TENANT_CONFIG_INVALID_OR_STAGING'));
}
assert(prepareSetup({ ...input, attestation: prepareProductionAttestation(readiness, commit) }).blockers.includes('PRODUCTION_ATTESTATION_NOT_ACCEPTED'));
assert(prepareSetup({ ...input, attestation: { ...attestation, releaseCommit: 'b'.repeat(40) } }).blockers.includes('PRODUCTION_ATTESTATION_NOT_ACCEPTED'));
assert(prepareSetup({ ...input, config: { ...config, database: { ...config.database, publishableKey: 'sb_publishable_REPLACE_WITH_CUSTOMER_KEY' } } }).blockers.includes('PRODUCTION_TENANT_CONFIG_INVALID_OR_STAGING'));
assert.throws(() => parseArgs(['--config']), /INPUT_FILE_ARGUMENT_REQUIRED/);
assert.throws(() => parseArgs(['--token', token]), /UNKNOWN_SETUP_ARGUMENT/);
assert.equal(parseArgs(['--verify-protection']).verifyProtection, true);
for (const args of [['--verify-protection', '--apply'], ['--verify-protection', '--config', 'unused.json'], ['--verify-protection', '--attestation', 'unused.json']]) {
  assert.throws(() => parseArgs(args), /PROTECTION_CHECK_ARGUMENT_CONFLICT/);
}

const base = `repos/${target.repository}`;
const protectionEndpoint = `${base}/branches/main/protection`;
const environmentEndpoint = `${base}/environments/production`;
const branchPolicyEndpoint = `${environmentEndpoint}/deployment-branch-policies?per_page=100`;
const responses = {
  [base]: { default_branch: 'main', permissions: { admin: true } },
  [`${base}/branches/main`]: { commit: { sha: commit }, protected: true },
  [protectionEndpoint]: {
    required_status_checks: { strict: true, checks: [{ context: requiredReleaseCheck.context, app_id: requiredReleaseCheck.appId }] },
    required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true, bypass_pull_request_allowances: { users: [], teams: [], apps: [] } },
    enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false }
  },
  [environmentEndpoint]: { name: 'production', protection_rules: [{ type: 'required_reviewers', prevent_self_review: true, reviewers: [{ type: 'User', reviewer: { id: 1 } }] }], deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } }
};
function stub(overrides = {}, failAt = null) {
  const writes = [];
  return { writes, run(args, body) {
    if (args[0] === 'auth') return '';
    if (args[0] === 'api') return JSON.stringify((Object.hasOwn(overrides, args[3]) ? overrides : responses)[args[3]]);
    assert(['variable', 'secret'].includes(args[0]));
    assert.deepEqual(args.slice(3), ['--repo', target.repository, '--env', target.environment]);
    assert(!args.join(' ').includes(token));
    if (args[2] === failAt) throw new Error(`Failure containing ${token}`);
    writes.push({ args, body }); return '';
  } };
}
const success = stub();
assert.equal(applySetup(good, success.run).deploymentStarted, false);
assert.equal(success.writes.length, 6);
assert.equal(success.writes.at(-1).args[2], 'PRODUCTION_RELEASE_ATTESTATION_JSON');
assert.equal(success.writes.find(w => w.args[2] === 'NETLIFY_AUTH_TOKEN').body, token);
const readOnly = stub();
const snapshot = verifySetupProtection({ commit }, readOnly.run);
assert.equal(snapshot.status, 'observable_controls_verified');
assert.equal(snapshot.releaseCommit, commit);
assert.equal(snapshot.productionGatePassed, false);
assert.equal(snapshot.configurationWritten, false);
assert.equal(readOnly.writes.length, 0, 'read-only verification must never write a variable or secret');
assert.ok(!JSON.stringify(snapshot).includes(token));
for (const overrides of [
  { [base]: { default_branch: 'main', permissions: { admin: false } } },
  { [`${base}/branches/main`]: { commit: { sha: 'b'.repeat(40) }, protected: true } },
  { [`${base}/branches/main`]: { commit: { sha: commit }, protected: false } },
  { [`${base}/environments/production`]: { name: 'production', protection_rules: [], deployment_branch_policy: null } }
]) {
  const blocked = stub(overrides);
  assert.throws(() => applySetup(good, blocked.run));
  assert.equal(blocked.writes.length, 0);
}
for (const mutate of [
  p => { p.required_status_checks = null; },
  p => { p.required_status_checks.strict = false; },
  p => { p.required_status_checks.checks = []; },
  p => { p.required_status_checks.checks[0].context = 'Unrelated passing test'; },
  p => { p.required_status_checks.checks[0].app_id = -1; },
  p => { p.required_status_checks.checks[0].app_id = 13473; },
  p => { delete p.required_status_checks.checks[0].app_id; },
  p => { p.required_pull_request_reviews = null; },
  p => { p.required_pull_request_reviews.required_approving_review_count = 0; },
  p => { p.required_pull_request_reviews.dismiss_stale_reviews = false; },
  p => { p.required_pull_request_reviews.require_last_push_approval = false; },
  ...['users', 'teams', 'apps'].map(kind => p => { p.required_pull_request_reviews.bypass_pull_request_allowances[kind] = [{ id: 1 }]; }),
  p => { p.enforce_admins.enabled = false; },
  p => { p.allow_force_pushes.enabled = true; },
  p => { p.allow_deletions.enabled = true; }
]) {
  const protection = structuredClone(responses[protectionEndpoint]);
  mutate(protection);
  const blocked = stub({ [protectionEndpoint]: protection });
  assert.throws(() => applySetup(good, blocked.run));
  assert.equal(blocked.writes.length, 0, 'a weak protected=true branch must not receive deployment credentials');
}
for (const mutate of [
  e => { e.protection_rules[0].prevent_self_review = false; },
  e => { delete e.protection_rules[0].prevent_self_review; },
  e => { e.deployment_branch_policy = { protected_branches: true, custom_branch_policies: true }; },
  e => { e.deployment_branch_policy = { protected_branches: false, custom_branch_policies: false }; }
]) {
  const environment = structuredClone(responses[environmentEndpoint]);
  mutate(environment);
  const blocked = stub({ [environmentEndpoint]: environment });
  assert.throws(() => applySetup(good, blocked.run));
  assert.equal(blocked.writes.length, 0);
}
const customEnvironment = { ...responses[environmentEndpoint], deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } };
const mainRule = { name: 'main', type: 'branch' };
const custom = stub({ [environmentEndpoint]: customEnvironment, [branchPolicyEndpoint]: { total_count: 1, branch_policies: [mainRule] } });
assert.equal(verifySetupProtection({ commit }, custom.run).deploymentBranchPolicy, 'main_branch_only');
assert.equal(custom.writes.length, 0);
for (const policy of [
  { total_count: 0, branch_policies: [] },
  { total_count: 1, branch_policies: [{ name: '*', type: 'branch' }] },
  { total_count: 1, branch_policies: [{ name: 'main', type: 'tag' }] },
  { total_count: 1, branch_policies: [{ name: 'main' }] },
  { total_count: 2, branch_policies: [mainRule, { name: '*', type: 'branch' }] },
  { total_count: 2, branch_policies: [mainRule] }
]) {
  const blocked = stub({ [environmentEndpoint]: customEnvironment, [branchPolicyEndpoint]: policy });
  assert.throws(() => applySetup(good, blocked.run), /PRODUCTION_MAIN_BRANCH_RULE_REQUIRED/);
  assert.equal(blocked.writes.length, 0);
}
const raced = stub();
let branchReads = 0;
assert.throws(() => applySetup(good, (args, body) => {
  if (args[0] === 'api' && args[3] === `${base}/branches/main` && ++branchReads === 2) {
    return JSON.stringify({ commit: { sha: 'b'.repeat(40) }, protected: true });
  }
  return raced.run(args, body);
}), /REMOTE_MAIN_COMMIT_MISMATCH/);
assert.equal(raced.writes.length, 0, 'main changing during preflight must prevent the first write');
const deniedRead = stub();
assert.throws(() => applySetup(good, (args, body) => {
  if (args[0] === 'api' && args[3] === protectionEndpoint) throw new Error(token);
  return deniedRead.run(args, body);
}), /^Error: GITHUB_PREFLIGHT_READ_FAILED$/);
assert.equal(deniedRead.writes.length, 0);

// Exercise the real CLI path with a read-only fake gh and no release inputs.
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cnyos-protection-test-'));
try {
  const cliResponses = structuredClone(responses);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  cliResponses[`${base}/branches/main`].commit.sha = head;
  const fakeGh = `#!${process.execPath}\nconst args = process.argv.slice(2);\nconst responses = ${JSON.stringify(cliResponses)};\nif (args[0] === 'auth') process.exit(0);\nif (args[0] !== 'api' || !Object.hasOwn(responses, args[3])) process.exit(99);\nprocess.stdout.write(JSON.stringify(responses[args[3]]));\n`;
  fs.writeFileSync(path.join(temporary, 'gh'), fakeGh, { mode: 0o700 });
  const result = spawnSync(process.execPath, [new URL('../scripts/setup-production-environment.mjs', import.meta.url).pathname, '--verify-protection'], {
    encoding: 'utf8', env: { ...process.env, PATH: `${temporary}${path.delimiter}${process.env.PATH}`, NETLIFY_AUTH_TOKEN: '', PRODUCTION_RELEASE_ATTESTATION_JSON: '' }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).releaseCommit, head);
  assert.equal(JSON.parse(result.stdout).productionGatePassed, false);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
const partial = stub({}, 'PRODUCTION_SITE_URL');
try { applySetup(good, partial.run); assert.fail('Expected write failure'); }
catch (error) {
  assert.equal(error.message, 'GITHUB_SETUP_WRITE_FAILED');
  assert.deepEqual(error.completedKeys, ['PRODUCTION_NETLIFY_SITE_ID']);
  assert.equal(error.failedKey, 'PRODUCTION_SITE_URL');
  assert(!JSON.stringify(error).includes(token));
}
console.log('Production environment setup contracts passed: read-only CLI, required CI publisher and reviews, no bypass/self-review, restrictive custom branch policy, main-race denial, zero writes on preflight failure, and redacted credential handling');
