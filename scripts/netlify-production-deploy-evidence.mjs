import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const API = 'https://api.netlify.com/api/v1';
const deployIdPattern = /^[0-9a-f]{24}$/i;

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function safeOrigin(value, expectedHost) {
  const url = new URL(value);
  assert.equal(url.protocol, 'https:', 'production site must use HTTPS');
  assert.equal(url.hostname.toLowerCase(), expectedHost.toLowerCase(), 'production host mismatch');
  return url.origin;
}

async function netlify(pathname) {
  const token = required('NETLIFY_AUTH_TOKEN');
  const response = await fetch(`${API}${pathname}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json'
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    throw new Error(`NETLIFY_API_FAILED ${response.status} ${pathname}`);
  }
  return response.json();
}

function sanitizeDeploy(deploy) {
  if (!deploy) return null;
  return {
    id: deploy.id || null,
    state: deploy.state || null,
    context: deploy.context || null,
    title: deploy.title || null,
    publishedAt: deploy.published_at || null,
    deployUrl: deploy.deploy_ssl_url || deploy.deploy_url || null,
    commitRef: deploy.commit_ref || null
  };
}

async function writeJson(file, value) {
  const destination = path.resolve(file);
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fs.writeFile(destination, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function snapshot() {
  const siteId = required('NETLIFY_SITE_ID');
  const expectedHost = required('EXPECTED_PRODUCTION_HOST');
  const site = await netlify(`/sites/${encodeURIComponent(siteId)}`);
  assert.equal(site.id, siteId, 'Netlify site ID mismatch');
  const origin = safeOrigin(site.ssl_url || site.url, expectedHost);
  const evidence = {
    schemaVersion: 1,
    evidenceType: 'netlify_pre_deploy_snapshot',
    capturedAt: new Date().toISOString(),
    siteId,
    siteName: site.name || null,
    origin,
    previousPublishedDeploy: sanitizeDeploy(site.published_deploy)
  };
  await writeJson(required('NETLIFY_PRE_DEPLOY_EVIDENCE_PATH'), evidence);
  process.stdout.write(`Previous Netlify production deploy captured: ${evidence.previousPublishedDeploy?.id || 'none'}\n`);
}

function extractDeployId(value) {
  const candidates = [value?.deploy_id, value?.deployId, value?.id];
  const id = candidates.map(item => String(item || '').trim()).find(item => deployIdPattern.test(item));
  if (!id) throw new Error('NETLIFY_DEPLOY_OUTPUT_ID_MISSING');
  return id;
}

async function verify() {
  const siteId = required('NETLIFY_SITE_ID');
  const expectedHost = required('EXPECTED_PRODUCTION_HOST');
  const expectedCommit = required('EXPECTED_RELEASE_COMMIT');
  const deployOutput = JSON.parse(await fs.readFile(path.resolve(required('NETLIFY_DEPLOY_OUTPUT_PATH')), 'utf8'));
  const deployId = extractDeployId(deployOutput);
  const site = await netlify(`/sites/${encodeURIComponent(siteId)}`);
  assert.equal(site.id, siteId, 'Netlify site ID mismatch');
  const origin = safeOrigin(site.ssl_url || site.url, expectedHost);
  const published = site.published_deploy;
  assert.ok(published, 'Netlify site has no published deploy');
  assert.equal(published.id, deployId, 'CLI deployment is not the currently published production deploy');
  assert.equal(published.site_id, siteId, 'published deploy belongs to a different site');
  assert.equal(published.state, 'ready', 'published deploy is not ready');
  assert.equal(published.context, 'production', 'published deploy is not production context');
  assert.match(String(published.title || ''), new RegExp(expectedCommit.slice(0, 12), 'i'), 'published deploy title does not identify the expected release commit');

  const evidence = {
    schemaVersion: 1,
    evidenceType: 'netlify_published_production_deploy',
    verifiedAt: new Date().toISOString(),
    siteId,
    siteName: site.name || null,
    origin,
    releaseCommit: expectedCommit,
    netlifyDeployId: deployId,
    publishedDeploy: sanitizeDeploy(published)
  };
  await writeJson(required('NETLIFY_POST_DEPLOY_EVIDENCE_PATH'), evidence);
  process.stdout.write(`Netlify production deploy verified: ${deployId} for ${expectedCommit} at ${origin}\n`);
}

const command = process.argv[2];
if (command === 'snapshot') {
  snapshot().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
} else if (command === 'verify') {
  verify().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
} else {
  process.stderr.write('Usage: node scripts/netlify-production-deploy-evidence.mjs <snapshot|verify>\n');
  process.exitCode = 2;
}
