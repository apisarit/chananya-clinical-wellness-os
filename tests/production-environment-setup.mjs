import assert from 'node:assert/strict';
import fs from 'node:fs';
import { prepareSetup, publicPlan, applySetup, parseArgs, target } from '../scripts/setup-production-environment.mjs';
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
assert.throws(() => parseArgs(['--config']), /INPUT_FILE_ARGUMENT_REQUIRED/);
assert.throws(() => parseArgs(['--token', token]), /UNKNOWN_SETUP_ARGUMENT/);

const base = `repos/${target.repository}`;
const responses = {
  [base]: { default_branch: 'main', permissions: { admin: true } },
  [`${base}/branches/main`]: { commit: { sha: commit }, protected: true },
  [`${base}/environments/production`]: { name: 'production', protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { id: 1 } }] }], deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } }
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
const partial = stub({}, 'PRODUCTION_SITE_URL');
try { applySetup(good, partial.run); assert.fail('Expected write failure'); }
catch (error) {
  assert.equal(error.message, 'GITHUB_SETUP_WRITE_FAILED');
  assert.deepEqual(error.completedKeys, ['PRODUCTION_NETLIFY_SITE_ID']);
  assert.equal(error.failedKey, 'PRODUCTION_SITE_URL');
  assert(!JSON.stringify(error).includes(token));
}
console.log('Production environment setup contracts passed: staging rejection, exact approval, protected admin preflight, redacted stdin writes, and partial-write reporting');
