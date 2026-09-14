import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { assertScheduledDeployMetadata } from './verify-netlify-scheduled-deploy-metadata.mjs';
import {
  assertPublishedNetlifyOrigin,
  verifyScheduledRouteDenial
} from './verify-netlify-scheduled-route-denial.mjs';

const NETLIFY_API_ORIGIN = 'https://api.netlify.com';
const sha40 = /^[0-9a-f]{40}$/;
const deployIdPattern = /^[0-9a-f]{24}$/;
const siteIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const siteNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const stagingMarker = /(?:^|[-_.])(staging|stage|nonprod|test)(?:$|[-_.])/i;
const MAX_API_BODY_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_BODY_BYTES = 64 * 1024;

function required(value, errorCode) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(errorCode);
  return normalized;
}

function exactSha(value, errorCode) {
  const normalized = required(value, errorCode).toLowerCase();
  if (!sha40.test(normalized)) throw new Error(errorCode);
  return normalized;
}

async function readBoundedText(response, maximum, errorCode) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) throw new Error(errorCode);
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJsonObject(raw, errorCode) {
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error(errorCode); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(errorCode);
  return parsed;
}

async function netlifyApiJson(fetchImpl, token, pathname) {
  let response;
  try {
    response = await fetchImpl(`${NETLIFY_API_ORIGIN}/api/v1${pathname}`, {
      method: 'GET',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(15_000)
    });
  } catch {
    throw new Error('NETLIFY_API_REQUEST_FAILED');
  }
  if (response.status !== 200) throw new Error(`NETLIFY_API_FAILED_${response.status}`);
  const raw = await readBoundedText(response, MAX_API_BODY_BYTES, 'NETLIFY_API_RESPONSE_TOO_LARGE');
  return parseJsonObject(raw, 'NETLIFY_API_RESPONSE_INVALID');
}

function assertSite(site, expectedSiteId, canonicalOrigin) {
  if (String(site?.id || '').trim().toLowerCase() !== expectedSiteId) {
    throw new Error('NETLIFY_SITE_ID_MISMATCH');
  }
  const name = String(site?.name || '').trim().toLowerCase();
  if (!siteNamePattern.test(name)) throw new Error('NETLIFY_SITE_NAME_INVALID');
  const observedOrigin = assertPublishedNetlifyOrigin(site.ssl_url || site.url || '');
  if (observedOrigin !== canonicalOrigin) throw new Error('NETLIFY_SITE_ORIGIN_MISMATCH');
  const deployId = String(site?.published_deploy?.id || '').trim().toLowerCase();
  if (!deployIdPattern.test(deployId)) throw new Error('NETLIFY_PUBLISHED_DEPLOY_INVALID');
  return Object.freeze({ name, deployId });
}

function exactDeployOrigin(deploy, deployId, siteName) {
  const origin = assertPublishedNetlifyOrigin(deploy?.deploy_ssl_url || '');
  const expectedHostname = `${deployId}--${siteName}.netlify.app`;
  if (new URL(origin).hostname !== expectedHostname) {
    throw new Error('NETLIFY_EXACT_DEPLOY_ORIGIN_MISMATCH');
  }
  return origin;
}

async function fetchManifest(fetchImpl, origin) {
  let response;
  try {
    response = await fetchImpl(`${origin}/deploy-manifest.json`, {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000)
    });
  } catch {
    throw new Error('NETLIFY_DEPLOY_MANIFEST_REQUEST_FAILED');
  }
  if (response.status !== 200) {
    throw new Error(`NETLIFY_DEPLOY_MANIFEST_STATUS_MISMATCH_${response.status}`);
  }
  const raw = await readBoundedText(
    response,
    MAX_MANIFEST_BODY_BYTES,
    'NETLIFY_DEPLOY_MANIFEST_TOO_LARGE'
  );
  return Object.freeze({
    raw,
    sha256: crypto.createHash('sha256').update(raw).digest('hex'),
    value: parseJsonObject(raw, 'NETLIFY_DEPLOY_MANIFEST_INVALID')
  });
}

function assertManifest(manifest, expectedCommit, expectedTree) {
  assert.equal(manifest?.source?.commit, expectedCommit, 'NETLIFY_DEPLOY_MANIFEST_COMMIT_MISMATCH');
  assert.equal(manifest?.source?.tree, expectedTree, 'NETLIFY_DEPLOY_MANIFEST_TREE_MISMATCH');
  assert.equal(manifest?.source?.verified, true, 'NETLIFY_DEPLOY_MANIFEST_SOURCE_UNVERIFIED');
  assert.equal(manifest?.build?.context, 'production', 'NETLIFY_DEPLOY_MANIFEST_CONTEXT_MISMATCH');
  assert.match(
    String(manifest?.deploymentId || ''),
    stagingMarker,
    'NETLIFY_DEPLOY_MANIFEST_STAGING_ID_REQUIRED'
  );
}

export async function verifyNetlifyScheduledReleaseGate({
  siteUrl,
  siteId,
  expectedCommit,
  expectedTree,
  expectedDeployId,
  netlifyToken,
  fetchImpl = fetch,
  now = () => new Date()
}) {
  const canonicalOrigin = assertPublishedNetlifyOrigin(siteUrl);
  const normalizedSiteId = required(siteId, 'STAGING_NETLIFY_SITE_ID_REQUIRED').toLowerCase();
  if (!siteIdPattern.test(normalizedSiteId)) throw new Error('STAGING_NETLIFY_SITE_ID_INVALID');
  const commit = exactSha(expectedCommit, 'EXPECTED_STAGING_SOURCE_COMMIT_INVALID');
  const tree = exactSha(expectedTree, 'EXPECTED_STAGING_SOURCE_TREE_INVALID');
  const receiptDeployId = required(
    expectedDeployId,
    'EXPECTED_STAGING_NETLIFY_DEPLOY_ID_REQUIRED'
  ).toLowerCase();
  if (!deployIdPattern.test(receiptDeployId)) {
    throw new Error('EXPECTED_STAGING_NETLIFY_DEPLOY_ID_INVALID');
  }
  const token = required(netlifyToken, 'NETLIFY_AUTH_TOKEN_REQUIRED');

  const siteBefore = await netlifyApiJson(
    fetchImpl,
    token,
    `/sites/${encodeURIComponent(normalizedSiteId)}`
  );
  const published = assertSite(siteBefore, normalizedSiteId, canonicalOrigin);
  if (published.deployId !== receiptDeployId) {
    throw new Error('NETLIFY_PUBLISHED_DEPLOY_RECEIPT_MISMATCH');
  }
  const deploy = await netlifyApiJson(
    fetchImpl,
    token,
    `/deploys/${encodeURIComponent(published.deployId)}`
  );
  const schedules = assertScheduledDeployMetadata(deploy, {
    expectedSiteId: normalizedSiteId,
    expectedDeployId: published.deployId,
    expectedCommit: commit,
    expectedContext: 'production'
  });
  const deployOrigin = exactDeployOrigin(deploy, published.deployId, published.name);

  const exactManifest = await fetchManifest(fetchImpl, deployOrigin);
  assertManifest(exactManifest.value, commit, tree);
  const canonicalManifest = await fetchManifest(fetchImpl, canonicalOrigin);
  assertManifest(canonicalManifest.value, commit, tree);
  if (canonicalManifest.sha256 !== exactManifest.sha256) {
    throw new Error('NETLIFY_CANONICAL_DEPLOY_MANIFEST_MISMATCH');
  }

  const exactRouteEvidence = await verifyScheduledRouteDenial(deployOrigin, fetchImpl);
  const canonicalRouteEvidence = await verifyScheduledRouteDenial(canonicalOrigin, fetchImpl);

  const siteAfter = await netlifyApiJson(
    fetchImpl,
    token,
    `/sites/${encodeURIComponent(normalizedSiteId)}`
  );
  const publishedAfter = assertSite(siteAfter, normalizedSiteId, canonicalOrigin);
  if (publishedAfter.deployId !== published.deployId) {
    throw new Error('NETLIFY_PUBLISHED_DEPLOY_CHANGED_DURING_VERIFICATION');
  }

  const verifiedAt = now();
  if (!(verifiedAt instanceof Date) || Number.isNaN(verifiedAt.getTime())) {
    throw new Error('NETLIFY_SCHEDULED_GATE_TIME_INVALID');
  }
  return Object.freeze({
    schemaVersion: 1,
    evidenceType: 'netlify_scheduled_release_gate',
    verifiedAt: verifiedAt.toISOString(),
    siteId: normalizedSiteId,
    canonicalOrigin,
    netlifyDeployId: published.deployId,
    exactDeployOrigin: deployOrigin,
    releaseCommit: commit,
    releaseTree: tree,
    deploymentId: exactManifest.value.deploymentId,
    deployManifestSha256: exactManifest.sha256,
    schedules,
    routeDenials: Object.freeze([
      ...exactRouteEvidence.map(item => Object.freeze({ origin: 'exact-deploy', ...item })),
      ...canonicalRouteEvidence.map(item => Object.freeze({ origin: 'canonical', ...item }))
    ])
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stderr.write(
    'CANDIDATE_SPEC_ONLY: run an independently committed controller-owned implementation; no credential was read.\n'
  );
  process.exitCode = 1;
}
