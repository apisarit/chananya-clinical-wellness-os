import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { assertSameOriginFramePolicy } from './netlify-frame-policy.mjs';
import { loadExactGitRootBlobs, selectRuntimeSourceFiles } from './build-netlify-publish.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha40 = /^[0-9a-f]{40}$/i;
const stagingIdentityMarker = /(?:^|[-_.])(staging|stage|stg|nonprod|test)(?:$|[-_.])/i;
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

export const publicDeploymentRequestPolicy = Object.freeze({
  maxAttempts: 3,
  timeoutMs: 45_000,
  initialDelayMs: 1_000
});

const retryableStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

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
  // URL normalizes the default HTTPS port to empty; another port is a different
  // origin even when its hostname matches the protected production hostname.
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash) {
    throw new Error('PRODUCTION_SITE_URL_INVALID');
  }
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('PRODUCTION_SITE_URL_MUST_BE_ORIGIN');
  const host = String(expectedHost || '').trim().toLowerCase();
  if (!host || url.hostname.toLowerCase() !== host) throw new Error('PRODUCTION_SITE_HOST_MISMATCH');
  if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) throw new Error('PRODUCTION_SITE_HOST_INVALID');
  return url.origin;
}

export function assertProductionManifestClassification(manifest) {
  assert.equal(
    manifest?.build?.deploymentClass,
    'production',
    'production deploy manifest must report deploymentClass=production'
  );
  assert.equal(
    manifest?.safety?.stagingDatabaseExplicitlyAcknowledged,
    false,
    'production deploy manifest must record stagingDatabaseExplicitlyAcknowledged=false'
  );
  for (const [label, value] of [
    ['deploymentId', manifest?.deploymentId],
    ['tenant.expectedClinicCode', manifest?.tenant?.expectedClinicCode],
    ['identity.qrIssuer', manifest?.identity?.qrIssuer]
  ]) {
    assert.equal(
      stagingIdentityMarker.test(String(value || '')),
      false,
      `production deploy manifest must not contain a staging identity in ${label}`
    );
  }
}

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

export async function requestPublicDeployment(origin, pathname, {
  expectedStatus,
  json = false,
  binary = false,
  fetchImpl = globalThis.fetch,
  sleepImpl = wait,
  logImpl = message => process.stderr.write(`${message}\n`),
  policy = publicDeploymentRequestPolicy
} = {}) {
  const target = new URL(pathname, `${origin}/`).toString();
  const maxAttempts = Number(policy?.maxAttempts);
  const timeoutMs = Number(policy?.timeoutMs);
  const initialDelayMs = Number(policy?.initialDelayMs);
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw new Error('PUBLIC_DEPLOYMENT_RETRY_POLICY_INVALID');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    throw new Error('PUBLIC_DEPLOYMENT_TIMEOUT_POLICY_INVALID');
  }
  if (!Number.isSafeInteger(initialDelayMs) || initialDelayMs < 0 || initialDelayMs > 10_000) {
    throw new Error('PUBLIC_DEPLOYMENT_DELAY_POLICY_INVALID');
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(target, {
        method: 'GET',
        redirect: 'error',
        headers: { Accept: json ? 'application/json' : 'text/html,application/json;q=0.9,*/*;q=0.8' },
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      if (attempt === maxAttempts) {
        throw new Error(
          `PUBLIC_DEPLOYMENT_REQUEST_FAILED ${pathname} after ${maxAttempts} attempts: ${error?.message || error}`
        );
      }
      logImpl(`PUBLIC_DEPLOYMENT_REQUEST_RETRY ${pathname} attempt ${attempt}/${maxAttempts}: ${error?.message || error}`);
      await sleepImpl(initialDelayMs * (2 ** (attempt - 1)));
      continue;
    }

    if (expectedStatus !== undefined && response.status !== expectedStatus) {
      if (retryableStatuses.has(response.status) && attempt < maxAttempts) {
        logImpl(
          `PUBLIC_DEPLOYMENT_STATUS_RETRY ${pathname} attempt ${attempt}/${maxAttempts}: received ${response.status}`
        );
        await response.body?.cancel().catch(() => {});
        await sleepImpl(initialDelayMs * (2 ** (attempt - 1)));
        continue;
      }
      throw new Error(
        `PUBLIC_DEPLOYMENT_STATUS_MISMATCH ${pathname}: expected ${expectedStatus}, received ${response.status}`
      );
    }

    try {
      const body = binary ? Buffer.from(await response.arrayBuffer()) : json ? await response.json() : await response.text();
      return { response, body };
    } catch (error) {
      if (attempt === maxAttempts) {
        throw new Error(
          `PUBLIC_DEPLOYMENT_RESPONSE_FAILED ${pathname} after ${maxAttempts} attempts: ${error?.message || error}`
        );
      }
      logImpl(`PUBLIC_DEPLOYMENT_RESPONSE_RETRY ${pathname} attempt ${attempt}/${maxAttempts}: ${error?.message || error}`);
      await sleepImpl(initialDelayMs * (2 ** (attempt - 1)));
    }
  }

  throw new Error(`PUBLIC_DEPLOYMENT_REQUEST_FAILED ${pathname}: retry policy exhausted`);
}

export function assertRuntimeCodeInventory(manifest, sourceFiles) {
  const expected = [...sourceFiles.keys(), 'tenant-config.js', 'brand-config.js']
    .filter(name => /\.(?:m?js|css)$/.test(name)).sort();
  const observed = manifest.files.filter(name => /\.(?:m?js|css)$/.test(name)).sort();
  assert.deepEqual(observed, expected, 'runtime code inventory differs from selected committed package');
}

export async function verifyServedCode(origin, manifest, {
  request = requestPublicDeployment,
  readCommitted = name => execFileSync('git', ['show', `HEAD:${name}`], { cwd: root })
} = {}) {
  assert.ok(Array.isArray(manifest?.files) && Array.isArray(manifest?.integrity), 'runtime asset inventory missing');
  assert.ok(manifest.files.length > 0 && manifest.files.length <= 1000, 'runtime asset inventory bounds');
  assert.equal(manifest.fileCount, manifest.files.length, 'runtime file count mismatch');
  assert.equal(manifest.integrity.length, manifest.files.length, 'runtime integrity count mismatch');
  assert.equal(new Set(manifest.files).size, manifest.files.length, 'duplicate runtime path');
  // The publisher copies root files only. Validate the entire inventory before
  // any request; never follow a manifest-supplied host, query or traversal.
  for (const [i, name] of manifest.files.entries()) {
    assert.ok(typeof name === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name) && !name.includes('..'), 'unsafe runtime path');
    const entry = manifest.integrity[i];
    assert.equal(entry?.path, name, 'runtime integrity order mismatch');
    assert.match(entry?.sha256 || '', /^[a-f0-9]{64}$/, 'invalid runtime digest');
    assert.ok(Number.isSafeInteger(entry?.size) && entry.size >= 0, 'invalid runtime size');
  }
  const evidence = [];
  for (const entry of manifest.integrity.filter(item => /\.(?:m?js|css)$/.test(item.path))) {
    const { body } = await request(origin, `/${entry.path}`, { expectedStatus: 200, binary: true });
    const digest = createHash('sha256').update(body).digest('hex');
    assert.equal(body.byteLength, entry.size, `served asset size mismatch: ${entry.path}`);
    assert.equal(digest, entry.sha256, `served asset digest mismatch: ${entry.path}`);
    // Both configs are generated and separately runtime-bound, not Git blobs.
    const sourceBound = !['tenant-config.js', 'brand-config.js'].includes(entry.path);
    if (sourceBound) {
      const expected = createHash('sha256').update(readCommitted(entry.path)).digest('hex');
      assert.equal(digest, expected, `served asset source mismatch: ${entry.path}`);
    }
    evidence.push({ path: entry.path, size: body.byteLength, sha256: digest, sourceBound });
  }
  assert.ok(evidence.some(item => item.path === 'app.js'), 'served app.js evidence missing');
  assert.ok(evidence.some(item => item.path === 'app.css'), 'served app.css evidence missing');
  return evidence;
}

function requireSecurityHeaders(response, pathname, { html = false } = {}) {
  const headers = response.headers;
  assert.equal(headers.get('x-content-type-options'), 'nosniff', `${pathname} missing nosniff`);
  assertSameOriginFramePolicy(headers, pathname);
  assert.equal(headers.get('referrer-policy'), 'no-referrer', `${pathname} missing no-referrer`);
  assert.match(headers.get('strict-transport-security') || '', /max-age=\d+/, `${pathname} missing HSTS`);
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

  const checkoutCommit = git('rev-parse', 'HEAD');
  const checkoutTree = git('rev-parse', 'HEAD^{tree}');
  assert.equal(checkoutCommit, expectedCommit, 'selected workflow checkout does not match the expected release commit');
  assert.match(checkoutTree, sha40, 'selected workflow checkout tree is invalid');

  const deploy = await requestPublicDeployment(origin, '/deploy-manifest.json', { expectedStatus: 200, json: true });
  assert.equal(deploy.body?.source?.commit, expectedCommit, 'deployed source commit does not match exact release commit');
  assert.equal(deploy.body?.source?.tree, checkoutTree, 'deployed source tree does not match exact checked-out release tree');
  assert.equal(deploy.body?.source?.verified, true, 'deploy manifest source must be verified');
  assert.equal(deploy.body?.build?.context, 'production', 'production deploy manifest must report production context');
  assertProductionManifestClassification(deploy.body);
  assert.equal(deploy.body?.safety?.previewLocked, false, 'production release must not be preview-locked');

  const runtime = await requestPublicDeployment(origin, '/runtime-publish-manifest.json', { expectedStatus: 200, json: true });
  assert.equal(runtime.body?.schemaVersion, 2, 'runtime publish manifest schema mismatch');
  assert.equal(runtime.body?.integrityAlgorithm, 'sha256', 'runtime publish manifest integrity algorithm mismatch');
  assert.ok(Number.isSafeInteger(runtime.body?.fileCount) && runtime.body.fileCount > 0, 'runtime publish manifest has no files');
  assert.ok(Array.isArray(runtime.body?.files), 'runtime publish manifest files missing');
  assert.ok(Array.isArray(runtime.body?.integrity), 'runtime publish manifest integrity missing');
  assert.equal(runtime.body.integrity.length, runtime.body.files.length, 'runtime publish manifest integrity count mismatch');
  for (const requiredFile of ['index.html', 'login.html', 'app.js', 'app.css', 'tenant-config.js', 'deploy-manifest.json']) {
    assert.ok(runtime.body.files.includes(requiredFile), `runtime publish manifest missing ${requiredFile}`);
  }

  const routes = ['/', '/login.html', '/auth-callback.html', '/owner-control.html'];
  assertRuntimeCodeInventory(runtime.body, selectRuntimeSourceFiles(loadExactGitRootBlobs(root), deploy.body));
  const codeAssets = await verifyServedCode(origin, runtime.body);
  const routeEvidence = [];
  for (const route of routes) {
    const result = await requestPublicDeployment(origin, route, { expectedStatus: 200 });
    requireSecurityHeaders(result.response, route, { html: true });
    routeEvidence.push({ route, status: result.response.status });
  }

  const forbiddenEvidence = [];
  for (const pathname of forbiddenPublicPaths) {
    const result = await requestPublicDeployment(origin, pathname, { expectedStatus: 404 });
    forbiddenEvidence.push({ path: pathname, status: result.response.status });
  }

  const evidence = {
    schemaVersion: 1,
    evidenceType: 'public_production_deployment_attestation',
    verifiedAt: new Date().toISOString(),
    origin,
    releaseCommit: expectedCommit,
    releaseTree: checkoutTree,
    deploymentId: deploy.body.deploymentId,
    tenantCode: deploy.body?.tenant?.expectedClinicCode || null,
    runtimeFileCount: runtime.body.fileCount,
    codeAssets,
    routes: routeEvidence,
    forbiddenPaths: forbiddenEvidence
  };

  const destination = path.resolve(process.env.PUBLIC_DEPLOYMENT_EVIDENCE_PATH || path.join(root, 'artifacts', 'public-deployment.json'));
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fs.writeFile(destination, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  process.stdout.write(`Public production deployment attested for ${expectedCommit} (${checkoutTree}) at ${origin}\n`);
  return evidence;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyPublicDeployment().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
