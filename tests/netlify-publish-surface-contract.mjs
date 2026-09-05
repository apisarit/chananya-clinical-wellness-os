import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNetlifyPublish, isPublicRuntimeRootFile } from '../scripts/build-netlify-publish.mjs';

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
  for (const name of required) fs.writeFileSync(path.join(fixture, name), `fixture:${name}`);
  fs.writeFileSync(path.join(fixture, '_headers'), 'fixture headers');
  fs.writeFileSync(path.join(fixture, '.env.example'), 'SHOULD_NOT_DEPLOY=true');
  fs.writeFileSync(path.join(fixture, 'release-readiness.json'), '{"commercialProductionReady":false}');
  fs.writeFileSync(path.join(fixture, 'package.json'), '{}');
  fs.mkdirSync(path.join(fixture, 'docs'));
  fs.writeFileSync(path.join(fixture, 'docs', 'internal.html'), 'internal-only');

  const manifest = await buildNetlifyPublish({ cwd: fixture });
  const published = new Set(fs.readdirSync(path.join(fixture, 'dist')));
  for (const name of required) assert.equal(published.has(name), true, `${name} missing from dist fixture`);
  assert.equal(published.has('_headers'), true);
  assert.equal(published.has('.env.example'), false);
  assert.equal(published.has('release-readiness.json'), false);
  assert.equal(published.has('package.json'), false);
  assert.equal(published.has('docs'), false);
  assert.equal(published.has('runtime-publish-manifest.json'), true);
  assert.equal(manifest.files.includes('.env.example'), false);
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}

console.log('Netlify publish surface contract passed: runtime allowlist only');
