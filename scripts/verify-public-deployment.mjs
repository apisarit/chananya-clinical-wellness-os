import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha40 = /^[0-9a-f]{40}$/i;

export const forbiddenPublicPaths = Object.freeze([
  '/.env.example',
  '/package.json',
  '/package-lock.json',
  '/release-readiness.json',
  '/netlify.toml',
  '/config/tenant.chananya.json',
  '/docs/PRODUCTION_MILESTONE_STACK.md',
  '/scripts/generate-tenant-config.mjs',
  '/tests/commercial-release-gate.mjs',
  '/supabase/migrations/'
]);

export function validateProductionOrigin(raw, expectedHost) {
  let url;
  try { url = new URL(String(raw || '').trim()); }
  catch { throw new Error('PRODUCTION_SITE_URL_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('PRODUCTION_SITE_URL_INVALID');
  }
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('PRODUCTION_SITE_URL_MUST_BE_ORIGIN');
  const host = String(expectedHost || '').trim().toLowerCase();
  if (!host || url.hostname.toLowerCase() !== host) throw new Error('PRODUCTION_SITE_HOST_MISMATCH');
  if (['localhost', '127.0.0.1', '::1'].includes(host)) throw new Error('PRODUCTION_SITE_HOST_INVALID');
  return url.origin;
}

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

async function request(origin, pathname, { expectedStatus, json = false } = {}) {
  const target = new URL(pathname, `${origin}/`).toString();
  let response;
  try {
    response = await fetch(target, {
      method: 'GET',
      redirect: 'error',
      headers: { Accept: json ? 'application/json' : 'text/html,application/json;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(15000)
    });
  } catch (error) {
    throw new Error(`PUBLIC_DEPLOYMENT_REQUEST_FAILED ${pathname}: ${error?.message || error}`);
  }
  if (expectedStatus !== undefined && response.status !== expectedStatus) {
    throw new Error(`PUBLIC_DEPLOYMENT_STATUS_MISMATCH ${pathname}: expected ${expectedStatus}, received ${response.status}`);
  }
  const body = json ? await response.json() : await response.text();
  return { response, body };
}

function requireSecurityHeaders(response, pathname, { html = false } = {}) {
  const headers = response.headers;
  assert.equal(headers.get('x-content-type-options'), 'nosniff', `${pathname} missing nosniff`);
  assert.equal(headers.get('x-frame-options'), 'DENY', `${pathname} missing frame denial`);
  assert.equal(headers.get('referrer-policy'), 'no-referrer', `${pathname} missing no-referrer`);
  assert.match(headers.get('strict-transport-security') || '', /max-age=\d+/, `${pathname} missing HSTS`);
  assert.match(headers.get('content-security-policy') || '', /frame-ancestors 'none'/, `${pathname} missing CSP frame-ancestors`);
  if (html) assert.match(headers.get('cache-control') || '', /no-store/i, `${pathname} HTML must be no-store`);
}

export async function verifyPublicDeployment({
  origin = validateProductionOrigin(process.env.PRODUCTION_SITE_URL, process.env.EXPECTED_PRODUCTION_HOST),
  expectedCommit = required('EXPECTED_RELEASE_COMMIT')
} = {}) {
  if (process.env.CNYOS_PRODUCTION_SMOKE_ACK !== 'VERIFY_PUBLIC_RELEASE') {
    throw new Error('CNYOS_PRODUCTION_SMOKE_ACK_REQUIRED');
  }
  if (!sha40.test(expectedCommit)) throw new Error('EXPECTED_RELEASE_COMMIT_INVALID');

  const deploy = await request(origin, '/deploy-manifest.json', { expectedStatus: 200, json: true });
  assert.equal(deploy.body?.source?.commit, expectedCommit, 'deployed source commit does not match exact release commit');
  assert.equal(deploy.body?.source?.verified, true, 'deploy manifest source must be verified');
  assert.equal(deploy.body?.build?.context, 'production', 'production deploy manifest must report production context');
  assert.equal(deploy.body?.safety?.previewLocked, false, 'production release must not be preview-locked');

  const runtime = await request(origin, '/runtime-publish-manifest.json', { expectedStatus: 200, json: true });
  assert.equal(runtime.body?.schemaVersion, 1, 'runtime publish manifest schema mismatch');
  assert.ok(Number.isSafeInteger(runtime.body?.fileCount) && runtime.body.fileCount > 0, 'runtime publish manifest has no files');
  assert.ok(Array.isArray(runtime.body?.files), 'runtime publish manifest files missing');
  for (const requiredFile of ['index.html', 'login.html', 'app.js', 'app.css', 'tenant-config.js', 'deploy-manifest.json']) {
    assert.ok(runtime.body.files.includes(requiredFile), `runtime publish manifest missing ${requiredFile}`);
  }

  const routes = ['/', '/login.html', '/auth-callback.html', '/owner-control.html'];
  const routeEvidence = [];
  for (const route of routes) {
    const result = await request(origin, route, { expectedStatus: 200 });
    requireSecurityHeaders(result.response, route, { html: true });
    routeEvidence.push({ route, status: result.response.status });
  }

  const forbiddenEvidence = [];
  for (const pathname of forbiddenPublicPaths) {
    const result = await request(origin, pathname, { expectedStatus: 404 });
    forbiddenEvidence.push({ path: pathname, status: result.response.status });
  }

  const evidence = {
    schemaVersion: 1,
    evidenceType: 'public_production_deployment_attestation',
    verifiedAt: new Date().toISOString(),
    origin,
    releaseCommit: expectedCommit,
    deploymentId: deploy.body.deploymentId,
    tenantCode: deploy.body?.tenant?.expectedClinicCode || null,
    runtimeFileCount: runtime.body.fileCount,
    routes: routeEvidence,
    forbiddenPaths: forbiddenEvidence
  };

  const destination = path.resolve(process.env.PUBLIC_DEPLOYMENT_EVIDENCE_PATH || path.join(root, 'artifacts', 'public-deployment.json'));
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fs.writeFile(destination, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  process.stdout.write(`Public production deployment attested for ${expectedCommit} at ${origin}\n`);
  return evidence;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyPublicDeployment().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
