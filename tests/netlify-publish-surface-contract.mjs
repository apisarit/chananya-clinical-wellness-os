import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertRuntimeWorktreeMatchesGit,
  buildNetlifyPublish,
  isPublicRuntimeRootFile
} from '../scripts/build-netlify-publish.mjs';
import { GENERATED_CONFIG_DIRECTORY } from '../scripts/generate-tenant-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const netlifyToml = fs.readFileSync(path.join(root, 'netlify.toml'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

assert.match(netlifyToml, /publish\s*=\s*"dist"/, 'Netlify must publish only the generated dist directory');
assert.doesNotMatch(netlifyToml, /publish\s*=\s*"\."/, 'repository root must never be the Netlify publish directory');
assert.match(packageJson.scripts.build, /build-netlify-publish\.mjs/, 'build must generate the restricted runtime publish surface');

for (const file of [
  'index.html',
  'login.html',
  'app.js',
  'app.css',
  'bodymap-figures.svg',
  'tenant-config.js',
  'brand-config.js',
  'deploy-manifest.json',
  '_headers',
  '_redirects'
]) {
  assert.equal(isPublicRuntimeRootFile(file), true, `${file} must be eligible for the runtime surface`);
}

for (const file of [
  '.env.example',
  'package.json',
  'package-lock.json',
  'netlify.toml',
  'release-readiness.json',
  'Chananya_Clinical_Wellness_OS_MVP_singlefile.zip',
  'scripts/tool.mjs',
  'docs/runbook.html',
  'tests/example.js',
  'config/tenant.json'
]) {
  assert.equal(isPublicRuntimeRootFile(file), false, `${file} must never be selected as a public root runtime file`);
}

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'cnyos-publish-'));
try {
  const required = [
    'index.html',
    'login.html',
    'auth-callback.html',
    'app.js',
    'app.css',
    'auth-config.js',
    'tenant-config.js',
    'brand-config.js',
    'deploy-manifest.json'
  ];
  const sourceFiles = new Map();
  const generated = path.join(fixture, GENERATED_CONFIG_DIRECTORY);
  fs.mkdirSync(generated);
  for (const name of required) {
    const destination = ['tenant-config.js', 'brand-config.js', 'deploy-manifest.json'].includes(name)
      ? path.join(generated, name)
      : path.join(fixture, name);
    fs.writeFileSync(destination, name === 'deploy-manifest.json' ? '{}' : `fixture:${name}`);
    if (!['tenant-config.js', 'brand-config.js', 'deploy-manifest.json'].includes(name)) {
      sourceFiles.set(name, Buffer.from(`fixture:${name}`));
    }
  }
  fs.writeFileSync(path.join(fixture, '_headers'), 'fixture headers');
  sourceFiles.set('_headers', Buffer.from('fixture headers'));
  fs.writeFileSync(path.join(fixture, '.env.example'), 'SHOULD_NOT_DEPLOY=true');
  fs.writeFileSync(path.join(fixture, 'npm-debug.log.js'), 'ignored backdoor candidate');
  fs.writeFileSync(path.join(fixture, 'release-readiness.json'), '{"commercialProductionReady":false}');
  fs.writeFileSync(path.join(fixture, 'package.json'), '{}');
  fs.mkdirSync(path.join(fixture, 'docs'));
  fs.writeFileSync(path.join(fixture, 'docs', 'internal.html'), 'internal-only');

  const manifest = await buildNetlifyPublish({ cwd: fixture, sourceFiles });
  const published = new Set(fs.readdirSync(path.join(fixture, 'dist')));
  for (const name of required) assert.equal(published.has(name), true, `${name} missing from dist fixture`);
  assert.equal(published.has('_headers'), true);
  assert.equal(published.has('.env.example'), false);
  assert.equal(published.has('npm-debug.log.js'), false, 'untracked or ignored runtime-shaped files must not deploy');
  assert.equal(published.has('release-readiness.json'), false);
  assert.equal(published.has('package.json'), false);
  assert.equal(published.has('docs'), false);
  assert.equal(published.has('runtime-publish-manifest.json'), true);
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.integrityAlgorithm, 'sha256');
  assert.deepEqual(manifest.integrity.map(item => item.path), manifest.files);
  assert.ok(manifest.integrity.every(item => Number.isSafeInteger(item.size) && item.size > 0));
  assert.ok(manifest.integrity.every(item => /^[0-9a-f]{64}$/.test(item.sha256)));
  assert.equal(fs.existsSync(generated), false, 'temporary generated config directory must be removed');
  assert.equal(manifest.files.includes('.env.example'), false);

  fs.writeFileSync(path.join(fixture, 'app.js'), 'generated-but-not-committed');
  await assert.rejects(
    assertRuntimeWorktreeMatchesGit(fixture, sourceFiles),
    /NETLIFY_PUBLISH_TRACKED_SOURCE_DRIFT: app\.js/
  );

  fs.rmSync(path.join(fixture, 'login.html'));
  await assert.rejects(
    assertRuntimeWorktreeMatchesGit(fixture, sourceFiles),
    /NETLIFY_PUBLISH_TRACKED_SOURCE_MISSING: login\.html/
  );
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}

console.log('Netlify publish surface contract passed: runtime allowlist only');
