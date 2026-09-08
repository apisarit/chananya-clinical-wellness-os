import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const sha40 = /^[0-9a-f]{40}$/i;
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

const expectedCommit = String(process.env.EXPECTED_RELEASE_COMMIT || process.env.GITHUB_SHA || '').trim();
if (!sha40.test(expectedCommit)) throw new Error('EXPECTED_RELEASE_COMMIT_INVALID');
const head = git('rev-parse', 'HEAD');
const tree = git('rev-parse', 'HEAD^{tree}');
assert.equal(head, expectedCommit, 'production artifact checkout must equal the expected release commit');
assert.match(tree, sha40, 'production artifact Git tree is invalid');

const deploy = JSON.parse(fs.readFileSync(path.join(dist, 'deploy-manifest.json'), 'utf8'));
const runtime = JSON.parse(fs.readFileSync(path.join(dist, 'runtime-publish-manifest.json'), 'utf8'));
assert.equal(deploy?.source?.commit, expectedCommit, 'production artifact manifest commit mismatch');
assert.equal(deploy?.source?.tree, tree, 'production artifact manifest tree mismatch');
assert.equal(deploy?.source?.verified, true, 'production artifact source must be verified');
assert.equal(deploy?.build?.context, 'production', 'production artifact must be built in production context');
assert.equal(deploy?.build?.deploymentClass, 'production', 'production artifact must have production deployment class');
assert.equal(deploy?.safety?.previewLocked, false, 'production artifact must not be preview locked');
assert.equal(deploy?.safety?.databaseLocked, false, 'production artifact must not contain a locked browser database config');
assert.equal(deploy?.safety?.stagingDatabaseExplicitlyAcknowledged, false, 'production artifact must not carry staging acknowledgement');
assert.equal(runtime?.schemaVersion, 2, 'runtime publish manifest schema mismatch');
assert.equal(runtime?.integrityAlgorithm, 'sha256', 'runtime publish manifest integrity algorithm mismatch');
assert.ok(Array.isArray(runtime?.files) && runtime.files.length > 0, 'runtime publish manifest is empty');
assert.equal(runtime.fileCount, runtime.files.length, 'runtime publish manifest file count mismatch');
assert.ok(Array.isArray(runtime.integrity), 'runtime publish manifest integrity is missing');
assert.equal(runtime.integrity.length, runtime.files.length, 'runtime publish manifest integrity count mismatch');
assert.deepEqual(
  fs.readdirSync(dist).sort(),
  [...runtime.files, 'runtime-publish-manifest.json'].sort(),
  'production dist must exactly match the runtime publish manifest'
);
for (const [index, item] of runtime.integrity.entries()) {
  assert.equal(item?.path, runtime.files[index], 'runtime publish manifest integrity order mismatch');
  const content = fs.readFileSync(path.join(dist, item.path));
  assert.equal(item.size, content.byteLength, `runtime publish size mismatch for ${item.path}`);
  assert.equal(
    item.sha256,
    crypto.createHash('sha256').update(content).digest('hex'),
    `runtime publish digest mismatch for ${item.path}`
  );
}

for (const required of [
  'index.html',
  'login.html',
  'auth-callback.html',
  'owner-control.html',
  'app.js',
  'app.css',
  'auth-config.js',
  'tenant-config.js',
  'brand-config.js',
  'deploy-manifest.json'
]) {
  assert.ok(runtime.files.includes(required), `production runtime manifest missing ${required}`);
}

for (const forbidden of [
  '.env.example',
  'package.json',
  'package-lock.json',
  'release-readiness.json',
  'netlify.toml',
  'Chananya_Clinical_Wellness_OS_MVP_singlefile.zip'
]) {
  assert.equal(runtime.files.includes(forbidden), false, `production runtime manifest exposes ${forbidden}`);
  assert.equal(fs.existsSync(path.join(dist, forbidden)), false, `production dist exposes ${forbidden}`);
}

process.stdout.write(`Production build artifact verified for ${expectedCommit} (${tree}); ${runtime.fileCount} runtime files.\n`);
