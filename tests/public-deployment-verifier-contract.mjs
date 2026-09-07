import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSameOriginFramePolicy } from '../scripts/netlify-frame-policy.mjs';
import { forbiddenPublicPaths, validateProductionOrigin } from '../scripts/verify-public-deployment.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'scripts', 'verify-public-deployment.mjs'), 'utf8');
const framePolicySource = fs.readFileSync(path.join(root, 'scripts', 'netlify-frame-policy.mjs'), 'utf8');
const staticHeadersSource = fs.readFileSync(path.join(root, '_headers'), 'utf8');
const netlifyConfigSource = fs.readFileSync(path.join(root, 'netlify.toml'), 'utf8');

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
assert.match(source, /assertSameOriginFramePolicy/, 'attestation must enforce the shared frame policy');
assert.match(framePolicySource, /content-security-policy/, 'shared frame policy must verify CSP');
assert.match(source, /expectedStatus: 404/, 'attestation must prove internal paths are not public');
assert.doesNotMatch(staticHeadersSource, /X-Frame-Options:\s*DENY/, 'static headers must not conflict with the same-origin frame policy');
assert.equal(
  (staticHeadersSource.match(/X-Frame-Options:\s*SAMEORIGIN/g) || []).length,
  4,
  'all four route-specific frame declarations must align with the global same-origin policy'
);

const configuredFrameOptions = netlifyConfigSource.match(/X-Frame-Options = "([^"]+)"/);
const configuredContentSecurityPolicy = netlifyConfigSource.match(/Content-Security-Policy = "([^"]+)"/);
assert.ok(configuredFrameOptions, 'netlify.toml must declare X-Frame-Options');
assert.ok(configuredContentSecurityPolicy, 'netlify.toml must declare Content-Security-Policy');
const validFrameHeaders = {
  'X-Frame-Options': configuredFrameOptions[1],
  'Content-Security-Policy': configuredContentSecurityPolicy[1]
};
assert.doesNotThrow(() => assertSameOriginFramePolicy(new Headers(validFrameHeaders), '/'));
for (const [name, headers] of [
  ['missing X-Frame-Options', { 'Content-Security-Policy': "frame-ancestors 'self'" }],
  ['missing Content-Security-Policy', { 'X-Frame-Options': 'SAMEORIGIN' }],
  ['legacy ALLOW-FROM', { ...validFrameHeaders, 'X-Frame-Options': 'ALLOW-FROM https://attacker.example' }],
  ['wildcard ancestor', { ...validFrameHeaders, 'Content-Security-Policy': 'frame-ancestors *' }],
  ['extra cross-origin ancestor', {
    ...validFrameHeaders,
    'Content-Security-Policy': "frame-ancestors 'self' https://attacker.example"
  }]
]) {
  assert.throws(
    () => assertSameOriginFramePolicy(new Headers(headers), '/'),
    undefined,
    `${name} must fail the shared frame policy`
  );
}

console.log('Public deployment verifier contract passed: exact commit/tree, headers and forbidden paths required');
