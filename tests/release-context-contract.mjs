import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { STAGES, validateCandidate, validateFinalPush } from '../scripts/release-context.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'release-context-fixture-'));
try {
const fixtureScripts = path.join(fixture, 'scripts');
fs.mkdirSync(fixtureScripts, { recursive: true });
fs.mkdirSync(path.join(fixture, 'artifacts'), { recursive: true });
for (const name of ['release-context.mjs', 'verify-production-promotion.mjs']) fs.copyFileSync(path.join(sourceRoot, 'scripts', name), path.join(fixtureScripts, name));
fs.copyFileSync(path.join(sourceRoot, 'release-readiness.json'), path.join(fixture, 'release-readiness.json'));

const git = (...args) => execFileSync('git', args, { cwd: fixture, encoding: 'utf8' }).trim();
git('init', '-q');
git('config', 'user.email', 'contract@example.invalid');
git('config', 'user.name', 'Release Contract');
git('add', '.');
git('commit', '-qm', 'fixture');
const candidate = git('rev-parse', 'HEAD');
git('commit', '--allow-empty', '-qm', 'merge commit with identical tree');
const finalCommit = git('rev-parse', 'HEAD');
const tree = git('rev-parse', `${finalCommit}^{tree}`);
assert.notEqual(candidate, finalCommit);
assert.equal(git('rev-parse', `${candidate}^{tree}`), tree);

const base = { DEFAULT_BRANCH: 'main', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: finalCommit, REQUESTED_RELEASE_COMMIT: finalCommit };
assert.equal(validateCandidate(base, finalCommit).commit, finalCommit);
for (const env of [
  { ...base, REQUESTED_RELEASE_COMMIT: candidate },
  { ...base, GITHUB_SHA: candidate },
  { ...base, GITHUB_SHA: finalCommit.toUpperCase() },
  { ...base, REQUESTED_RELEASE_COMMIT: '' },
  { ...base, GITHUB_REF: 'refs/pull/7/merge' },
  { ...base, DEFAULT_BRANCH: undefined }
]) assert.throws(() => validateCandidate(env, finalCommit));
assert.throws(() => validateCandidate({ ...base, DEFAULT_BRANCH: '../main' }, finalCommit));

const final = { ...base, GITHUB_EVENT_NAME: 'push' };
for (const env of [
  { ...final, GITHUB_EVENT_NAME: 'pull_request' },
  { ...final, GITHUB_REF: 'refs/heads/codex/feature' },
  { ...final, GITHUB_SHA: candidate }
]) assert.throws(() => validateFinalPush(env, finalCommit));
assert.deepEqual(STAGES.map(stage => stage.confirmation), ['PROMOTE_PRODUCTION', 'DEPLOY_CNYOS_PRODUCTION', 'VERIFY_DEPLOYED_PRODUCTION']);

const cleanEnv = { PATH: process.env.PATH, ...final, GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '42', PRODUCTION_RELEASE_ATTESTATION_JSON: 'super-secret-must-never-be-printed' };
const handoffDir = path.join(fixture, 'artifacts', 'release-handoff');
const run = (args, env = cleanEnv) => spawnSync(process.execPath, [path.join(fixtureScripts, 'release-context.mjs'), ...args], { cwd: fixture, env, encoding: 'utf8' });
const prepared = run(['prepare']);
assert.equal(prepared.status, 0, `${prepared.stderr} stdout=${prepared.stdout}`);
assert.ok(fs.existsSync(handoffDir), `${prepared.stdout} ${prepared.stderr}`);
assert.doesNotMatch(`${prepared.stdout}\n${prepared.stderr}`, /super-secret/);
const handoff = JSON.parse(fs.readFileSync(path.join(handoffDir, 'release-context.json')));
const draft = JSON.parse(fs.readFileSync(path.join(handoffDir, 'attestation-draft.json')));
assert.equal(handoff.artifactClassification, 'final-main-handoff');
assert.equal(handoff.finalReleaseCommit, finalCommit);
assert.equal(handoff.tree, tree);
assert.equal(handoff.approvedForProduction, false);
assert.equal(draft.approvedForProduction, false);
assert.ok(draft.gates.every(gate => gate.status === 'pending'));
assert.deepEqual(handoff.dispatchInputs.map(item => item.ref), ['main', 'main', 'main']);
assert.deepEqual(handoff.dispatchInputs.map(item => item.inputs.release_commit), [finalCommit, finalCommit, finalCommit]);
assert.deepEqual(handoff.dispatchInputs.map(item => item.inputs.confirmation), STAGES.map(stage => stage.confirmation));
assert.equal(handoff.ciEvidenceRef, 'https://github.com/owner/repo/actions/runs/42');
const readiness = JSON.parse(fs.readFileSync(path.join(fixture, 'release-readiness.json'), 'utf8'));
const { validateProductionAttestation } = await import('../scripts/verify-production-promotion.mjs');
assert.throws(() => validateProductionAttestation(readiness, draft, finalCommit), /not approved/);

const importOnly = path.join(fixture, 'import-only.mjs');
fs.writeFileSync(importOnly, "import './scripts/release-context.mjs'; console.log('import only');\n");
const imported = spawnSync(process.execPath, [importOnly, 'prepare'], { cwd: fixture, env: cleanEnv, encoding: 'utf8' });
assert.equal(imported.status, 0, imported.stderr);
assert.equal(imported.stdout.trim(), 'import only', 'import must not run a release command from another program’s argv');

for (const metadata of [
  { GITHUB_SERVER_URL: 'https://secret@github.com' },
  { GITHUB_SERVER_URL: 'https://github.com?token=secret' },
  { GITHUB_RUN_ID: 'not-a-run' },
  { GITHUB_REPOSITORY: '' }
]) {
  const invalid = run(['prepare'], { ...cleanEnv, ...metadata });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /RELEASE_CONTEXT_CI_METADATA_INVALID/);
  assert.doesNotMatch(`${invalid.stdout}\n${invalid.stderr}`, /secret/);
}

const overwrite = run(['prepare']);
assert.notEqual(overwrite.status, 0);
assert.match(overwrite.stderr, /RELEASE_CONTEXT_OUTPUT_EXISTS/);
fs.rmSync(path.join(handoffDir, 'release-context.json'));
fs.writeFileSync(path.join(handoffDir, 'attestation-draft.json'), '{"approvedForProduction":true}\n');
const partial = run(['prepare']);
assert.notEqual(partial.status, 0);
assert.match(partial.stderr, /RELEASE_CONTEXT_OUTPUT_EXISTS/);
assert.equal(fs.existsSync(path.join(handoffDir, 'release-context.json')), false);

const unsafe = run(['prepare'], { ...cleanEnv, RELEASE_HANDOFF_DIR: path.join(fixture, 'outside') });
assert.notEqual(unsafe.status, 0);
assert.match(unsafe.stderr, /RELEASE_CONTEXT_OUTPUT_INVALID/);
for (const directory of [fixture, path.join(fixture, 'artifacts')]) {
  const escape = run(['prepare'], { ...cleanEnv, RELEASE_HANDOFF_DIR: directory });
  assert.notEqual(escape.status, 0);
  assert.match(escape.stderr, /RELEASE_CONTEXT_OUTPUT_INVALID/);
}
fs.mkdirSync(path.join(fixture, 'outside'));
fs.symlinkSync(path.join(fixture, 'outside'), path.join(fixture, 'artifacts', 'linked'));
const linked = run(['prepare'], { ...cleanEnv, RELEASE_HANDOFF_DIR: path.join(fixture, 'artifacts', 'linked', 'output') });
assert.notEqual(linked.status, 0);
assert.match(linked.stderr, /RELEASE_CONTEXT_OUTPUT_INVALID/);
assert.deepEqual(fs.readdirSync(path.join(fixture, 'outside')), []);

fs.writeFileSync(path.join(fixture, 'release-readiness.json'), '\n');
const dirty = run(['prepare']);
assert.notEqual(dirty.status, 0);
assert.match(dirty.stderr, /RELEASE_CONTEXT_TRACKED_STATE_DIRTY/);
const wrongEvent = run(['prepare'], { ...cleanEnv, GITHUB_EVENT_NAME: 'pull_request' });
assert.notEqual(wrongEvent.status, 0);
assert.match(wrongEvent.stderr, /RELEASE_CONTEXT_EVENT_INVALID/);

const stale = run(['verify'], { ...cleanEnv, REQUESTED_RELEASE_COMMIT: candidate });
assert.notEqual(stale.status, 0);
assert.match(stale.stderr, new RegExp(`RELEASE_CONTEXT_STALE_INPUT current=${finalCommit}`));
assert.doesNotMatch(`${stale.stdout}\n${stale.stderr}`, /super-secret/);
console.log('Release context contract passed: isolated exact-commit identity, same-tree rejection, final-push gating, immutable pending artifacts, and sanitized diagnostics');
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
