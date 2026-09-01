import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stagingMarker = /(?:^|[-_.])(staging|stage|nonprod|test)(?:$|[-_.])/i;
const stagingHostnameMarker = /(?:^|[-.])(staging|stage|nonprod)(?:$|[-.])/i;
const acknowledgedNetlifyHostname = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.netlify\.app$/;
const revision = /^[0-9a-f]{7,40}$/i;
const routes = Object.freeze([
  '/',
  '/ui-review.html',
  '/login.html',
  '/clinical-v3.html',
  '/pharmacy.html',
  '/production.html',
  '/quality.html',
  '/admin.html',
  '/appointments.html',
  '/outcomes.html',
  '/check-in.html'
]);

function stagingHostnameAllowlist(value = []) {
  const entries = Array.isArray(value)
    ? value
    : String(value || '').split(',').filter(entry => entry.trim());
  const hostnames = new Set();

  for (const value of entries) {
    assert.equal(typeof value, 'string', 'Staging hostname acknowledgements must be strings');
    const hostname = value.trim();
    assert.ok(hostname, 'Staging hostname acknowledgements must not be empty');
    assert.equal(
      hostname,
      hostname.toLowerCase(),
      'Staging hostname acknowledgements must be lowercase'
    );
    assert.match(
      hostname,
      acknowledgedNetlifyHostname,
      'Staging hostname acknowledgements must be exact lowercase netlify.app hostnames without wildcards'
    );
    hostnames.add(hostname);
  }

  return hostnames;
}

function siteOrigin(value, hostnameAllowlist = []) {
  const parsed = new URL(String(value || '').trim());
  const acknowledgedHostnames = stagingHostnameAllowlist(hostnameAllowlist);
  assert.equal(parsed.protocol, 'https:', 'Locked staging must use HTTPS');
  assert.equal(parsed.pathname, '/', 'STAGING_SITE_URL must be an origin without a path');
  assert.equal(parsed.search, '', 'STAGING_SITE_URL must not contain a query');
  assert.equal(parsed.hash, '', 'STAGING_SITE_URL must not contain a fragment');
  assert.ok(
    stagingHostnameMarker.test(parsed.hostname) || acknowledgedHostnames.has(parsed.hostname),
    'Staging hostname must contain a non-production marker or be explicitly acknowledged'
  );
  return parsed.origin;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function parseTenantConfig(script) {
  const match = String(script).match(
    /window\.CLINICAL_OS_CONFIG\s*=\s*Object\.freeze\((\{[\s\S]*\})\);?\s*$/
  );
  assert.ok(match, 'Remote tenant-config.js is not a generated frozen JSON payload');
  return JSON.parse(match[1]);
}

function assertSecurityHeaders(response, pathName) {
  assert.equal(
    response.headers.get('x-content-type-options'),
    'nosniff',
    `${pathName} must set X-Content-Type-Options=nosniff`
  );
  assert.equal(
    response.headers.get('x-frame-options'),
    'DENY',
    `${pathName} must set X-Frame-Options=DENY`
  );
}

async function fetchText(fetchImpl, origin, pathName) {
  const response = await fetchImpl(`${origin}${pathName}`, {
    redirect: 'follow',
    cache: 'no-store',
    headers: { 'User-Agent': 'chananya-locked-staging-verifier/1.0' }
  });
  assert.equal(response.status, 200, `${pathName} must return HTTP 200`);
  return { response, text: await response.text() };
}

export async function verifyLockedStaging({
  siteUrl,
  fetchImpl = fetch,
  expectedSourceCommit = '',
  productionConfig = null,
  stagingHostnameAllowlist = []
}) {
  const origin = siteOrigin(siteUrl, stagingHostnameAllowlist);
  const tenantResult = await fetchText(fetchImpl, origin, '/tenant-config.js');
  assert.match(
    tenantResult.response.headers.get('cache-control') || '',
    /no-store/i,
    'tenant-config.js must be served with Cache-Control: no-store'
  );
  assertSecurityHeaders(tenantResult.response, '/tenant-config.js');
  const config = parseTenantConfig(tenantResult.text);
  assert.match(config.deploymentId, stagingMarker, 'Remote deploymentId must be marked staging/non-production');
  assert.equal(config.auth?.redirectOrigin, origin, 'Remote auth origin must equal the staging site');
  assert.equal(config.database?.url, '', 'Locked staging database URL must be empty');
  assert.equal(config.database?.publishableKey, '', 'Locked staging publishable key must be empty');
  assert.equal(config.safety?.previewLocked, true, 'Locked staging safety flag must be true');

  if (productionConfig) {
    assert.notEqual(
      config.tenant?.expectedClinicId,
      productionConfig.tenant?.expectedClinicId,
      'Staging clinic UUID must differ from Production'
    );
    assert.notEqual(
      config.tenant?.expectedClinicCode,
      productionConfig.tenant?.expectedClinicCode,
      'Staging clinic code must differ from Production'
    );
    assert.notEqual(
      config.identity?.qrIssuer,
      productionConfig.identity?.qrIssuer,
      'Staging QR issuer must differ from Production'
    );
  }

  const manifestResult = await fetchText(fetchImpl, origin, '/deploy-manifest.json');
  assert.match(
    manifestResult.response.headers.get('cache-control') || '',
    /no-store/i,
    'deploy-manifest.json must be served with Cache-Control: no-store'
  );
  assertSecurityHeaders(manifestResult.response, '/deploy-manifest.json');
  const manifest = JSON.parse(manifestResult.text);
  assert.equal(manifest.deploymentId, config.deploymentId, 'Manifest deploymentId must match tenant config');
  assert.equal(
    manifest.tenant?.expectedClinicId,
    config.tenant?.expectedClinicId,
    'Manifest clinic UUID must match tenant config'
  );
  assert.equal(
    manifest.tenant?.expectedClinicCode,
    config.tenant?.expectedClinicCode,
    'Manifest clinic code must match tenant config'
  );
  assert.equal(manifest.identity?.qrIssuer, config.identity?.qrIssuer, 'Manifest QR issuer must match tenant config');
  assert.equal(manifest.safety?.previewLocked, true, 'Manifest must record previewLocked=true');
  assert.equal(manifest.safety?.databaseLocked, true, 'Manifest must record databaseLocked=true');
  assert.equal(manifest.source?.verified, true, 'Manifest must contain verified source provenance');
  assert.match(manifest.source?.commit || '', revision, 'Manifest source commit must be a Git revision');
  if (expectedSourceCommit) {
    assert.equal(
      manifest.source.commit,
      String(expectedSourceCommit).trim().toLowerCase(),
      'Remote source commit must match EXPECTED_STAGING_SOURCE_COMMIT'
    );
  }

  const routeResults = await Promise.all(routes.map(async pathName => {
    const result = await fetchText(fetchImpl, origin, pathName);
    assertSecurityHeaders(result.response, pathName);
    if (pathName === '/ui-review.html') {
      assert.match(
        result.response.headers.get('x-robots-tag') || '',
        /noindex/i,
        'UI review must be excluded from search indexing'
      );
    }
    return { path: pathName, status: result.response.status };
  }));

  return {
    schemaVersion: 1,
    siteUrl: origin,
    deploymentId: config.deploymentId,
    clinicCode: config.tenant.expectedClinicCode,
    sourceCommit: manifest.source.commit,
    tenantConfigSha256: sha256(tenantResult.text),
    deployManifestSha256: sha256(manifestResult.text),
    databaseLocked: true,
    routes: routeResults
  };
}

async function main() {
  const productionConfig = JSON.parse(
    fs.readFileSync(path.join(root, 'config/tenant.chananya.json'), 'utf8')
  );
  const result = await verifyLockedStaging({
    siteUrl: process.env.STAGING_SITE_URL || 'https://chananya-clinical-staging.netlify.app',
    expectedSourceCommit: process.env.EXPECTED_STAGING_SOURCE_COMMIT || '',
    productionConfig,
    stagingHostnameAllowlist: process.env.STAGING_HOSTNAME_ALLOWLIST || []
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`Locked staging verification failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
