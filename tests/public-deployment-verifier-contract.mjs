import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { forbiddenPublicPaths, validateProductionOrigin } from '../scripts/verify-public-deployment.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'scripts', 'verify-public-deployment.mjs'), 'utf8');

assert.equal(validateProductionOrigin('https://cnyos.netlify.app', 'cnyos.netlify.app'), 'https://cnyos.netlify.app');
assert.throws(() => validateProductionOrigin('http://cnyos.netlify.app', 'cnyos.netlify.app'), /PRODUCTION_SITE_URL_INVALID/);
assert.throws(() => validateProductionOrigin('https://cnyos.netlify.app/path', 'cnyos.netlify.app'), /PRODUCTION_SITE_URL_MUST_BE_ORIGIN/);
assert.throws(() => validateProductionOrigin('https://evil.example', 'cnyos.netlify.app'), /PRODUCTION_SITE_HOST_MISMATCH/);
assert.throws(() => validateProductionOrigin('https://localhost', 'localhost'), /PRODUCTION_SITE_HOST_INVALID/);

for (const requiredForbidden of [
  '/.env.example',
  '/package.json',
  '/release-readiness.json',
  '/config/tenant.chananya.json',
  '/scripts/generate-tenant-config.mjs',
  '/tests/commercial-release-gate.mjs',
  '/supabase/migrations/'
]) {
  assert.ok(forbiddenPublicPaths.includes(requiredForbidden), `missing forbidden-path assertion ${requiredForbidden}`);
}

assert.match(source, /rev-parse', 'HEAD'/, 'attestation must bind to the exact checked-out commit');
assert.match(source, /rev-parse', 'HEAD\^\{tree\}'/, 'attestation must derive the exact checked-out Git tree');
assert.match(source, /source\?\.commit, expectedCommit/, 'attestation must compare the deployed source commit');
assert.match(source, /source\?\.tree, checkoutTree/, 'attestation must compare the deployed source tree');
assert.match(source, /build\?\.context, 'production'/, 'attestation must require production context');
assert.match(source, /previewLocked, false/, 'attestation must reject preview-locked deployments');
assert.match(source, /runtime-publish-manifest\.json/, 'attestation must verify the runtime publish manifest');
assert.match(source, /strict-transport-security/, 'attestation must verify HSTS');
assert.match(source, /content-security-policy/, 'attestation must verify CSP');
assert.match(source, /expectedStatus: 404/, 'attestation must prove internal paths are not public');

console.log('Public deployment verifier contract passed: exact commit/tree, headers and forbidden paths required');
