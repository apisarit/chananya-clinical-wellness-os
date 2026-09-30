import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflows = path.join(root, '.github', 'workflows');
const releaseContext = path.join(root, 'scripts', 'release-context.mjs');

function read(name) {
  return fs.readFileSync(path.join(workflows, name), 'utf8');
}

function jobBlock(source, name) {
  const start = source.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `workflow is missing jobs.${name}`);
  const rest = source.slice(start + 1);
  const nextJob = rest.search(/^  [A-Za-z0-9_-]+:/m);
  return nextJob < 0 ? rest : rest.slice(0, nextJob);
}

const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const mismatch = spawnSync(process.execPath, [releaseContext, 'verify'], {
  cwd: root,
  encoding: 'utf8',
  env: {
    PATH: process.env.PATH || '',
    DEFAULT_BRANCH: 'main',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: head,
    REQUESTED_RELEASE_COMMIT: 'e'.repeat(40)
  }
});
assert.notEqual(mismatch.status, 0, 'mismatched release input must refuse preflight');
assert.match(mismatch.stderr, /RELEASE_CONTEXT_(?:COMMIT_MISMATCH|STALE_INPUT)/);

const ci = read('ci.yml');
assert.match(
  ci,
  /if:\s*success\(\)\s*&&\s*github\.event_name\s*==\s*'push'\s*&&\s*github\.ref\s*==\s*format\('refs\/heads\/\{0\}',\s*github\.event\.repository\.default_branch\)/,
  'CI handoff must only run after successful default-branch push'
);
assert.doesNotMatch(ci, /pull_request[^\n]*release_handoff|release_handoff[^\n]*pull_request/);
const upload = jobBlock(ci, 'source-and-database-contracts');
const handoffUpload = upload.slice(upload.indexOf('name: Retain final-main release handoff'));
const handoffPathStart = handoffUpload.indexOf('path: |');
assert.notEqual(handoffPathStart, -1, 'handoff upload must use an explicit path block');
const handoffPaths = [];
for (const line of handoffUpload.slice(handoffPathStart).split('\n').slice(1)) {
  if (!/^\s{12}\S/.test(line)) break;
  handoffPaths.push(line.trim());
}
assert.deepEqual(handoffPaths, [
  'artifacts/release-handoff/release-context.json',
  'artifacts/release-handoff/attestation-draft.json'
]);
assert.match(handoffUpload, /if-no-files-found:\s*error/);

const productionWorkflows = [
  ['production-promotion-gate.yml', 'verify-production-release', 'PROMOTE_PRODUCTION', 'production promotion'],
  ['production-netlify-deploy.yml', 'deploy-exact-production', 'DEPLOY_CNYOS_PRODUCTION', 'production deployment'],
  ['production-post-deploy-smoke.yml', 'attest-public-production', 'VERIFY_DEPLOYED_PRODUCTION', 'post-deploy attestation']
];

for (const [name, protectedJobName, confirmation, label] of productionWorkflows) {
  const source = read(name);
  assert.match(source, /workflow_dispatch:\n(?:.*\n)*?\s+release_commit:\n\s+description:/, `${label} must be manually dispatched with release_commit`);
  const input = source.slice(source.indexOf('release_commit:'), source.indexOf('release_commit:') + 420);
  assert.match(input, /required:\s*true/);
  assert.match(input, /type:\s*string/);

  const context = jobBlock(source, 'release-context');
  const permissions = context.match(/\n    permissions:\n((?:      [^\n]+\n)+)/);
  assert.ok(permissions, `${label} preflight must declare job permissions`);
  assert.equal(permissions[1].trim(), 'contents: read');
  assert.doesNotMatch(context, /environment:|secrets\.|\bwrite-all\b|:\s*write\b|:\s*admin\b/);
  assert.match(context, /REQUESTED_RELEASE_COMMIT:\s*\$\{\{\s*inputs\.release_commit\s*\}\}/);
  assert.match(context, /node scripts\/release-context\.mjs verify/);

  const protectedJob = jobBlock(source, protectedJobName);
  assert.match(protectedJob, /needs:\s*release-context/);
  const protectedHeader = protectedJob.slice(0, protectedJob.indexOf('    steps:'));
  assert.doesNotMatch(protectedHeader, /\n    if:/, `${label} protected job must not bypass preflight with a job condition`);
  assert.match(protectedJob, /environment:\s*production/);
  assert.match(protectedJob, /EXPECTED_RELEASE_COMMIT:\s*\$\{\{\s*github\.sha\s*\}\}/);
  assert.match(protectedJob, /test "\$GITHUB_REF" = "refs\/heads\/\$DEFAULT_BRANCH"/);
  assert.match(protectedJob, /git rev-parse HEAD\)\" = "\$GITHUB_SHA"/);
  assert.match(protectedJob, new RegExp(`RELEASE_CONFIRMATION.*\\$\\{\\{ inputs\\.${'confirmation'} \\}\\}`));
  assert.match(protectedJob, new RegExp(`\\$RELEASE_CONFIRMATION" = "${confirmation}`));
  assert.doesNotMatch(context, /\$\{\{\s*secrets\./);
}

const promotion = read('production-promotion-gate.yml');
assert.match(jobBlock(promotion, 'verify-production-release'), /PRODUCTION_RELEASE_ATTESTATION_JSON:\s*\$\{\{\s*secrets\./);
assert.match(jobBlock(promotion, 'verify-production-release'), /verify:production-promotion/);

const deploy = read('production-netlify-deploy.yml');
const deployJob = jobBlock(deploy, 'deploy-exact-production');
assert.match(deployJob, /NETLIFY_AUTH_TOKEN:\s*\$\{\{\s*secrets\./);
assert.match(deployJob, /npm run verify:public-deployment/);
assert.match(deployJob, /Generate exact source evidence/);

const smoke = read('production-post-deploy-smoke.yml');
const smokeJob = jobBlock(smoke, 'attest-public-production');
assert.match(smokeJob, /production-promotion-gate\.yml/);
assert.match(smokeJob, /production-netlify-deploy\.yml/);
assert.match(smokeJob, /run\.head_sha === sha/);
assert.match(smokeJob, /npm run verify:public-deployment/);
assert.match(smokeJob, /Notify owner and close the production-gate tracker/);

console.log('Release-context workflow contract passed: strict handoff, secretless preflight, exact protected jobs, and attestation chain');
