import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  isPublicRuntimeRootFile,
  loadExactGitRootBlobs,
  selectRuntimeSourceFiles
} from './build-netlify-publish.mjs';
import {
  buildDeployManifest,
  renderBrandConfig,
  renderDeployManifest,
  renderTenantConfig
} from './generate-tenant-config.mjs';
import { assertSameOriginFramePolicy } from './netlify-frame-policy.mjs';
import { verifyNetlifyScheduledReleaseGate } from './verify-netlify-scheduled-release-gate.mjs';
import { loadStagingTarget } from './staging-support.mjs';
import { parseTenantConfig } from './verify-locked-staging.mjs';
import { forbiddenPublicPaths } from './verify-public-deployment.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha40 = /^[0-9a-f]{40}$/;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_NETLIFY_API_BYTES = 4 * 1024 * 1024;
const MAX_RUNTIME_FILE_BYTES = 16 * 1024 * 1024;
const MIN_HSTS_MAX_AGE = 31_536_000n;
const sha1Pattern = /^[0-9a-f]{40}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;

const standardCsp = Object.freeze({
  'default-src': Object.freeze(["'self'"]),
  'script-src': Object.freeze(["'self'", 'https://cdn.jsdelivr.net', 'https://static.line-scdn.net']),
  'style-src': Object.freeze(["'self'", "'unsafe-inline'"]),
  'img-src': Object.freeze(["'self'", 'data:', 'blob:', 'https://*.line-scdn.net']),
  'connect-src': Object.freeze([
    "'self'",
    'https://*.supabase.co',
    'wss://*.supabase.co',
    'https://*.line.me',
    'https://*.line-scdn.net'
  ]),
  'frame-src': Object.freeze(["'self'", 'https://*.line.me']),
  'font-src': Object.freeze(["'self'", 'data:']),
  'object-src': Object.freeze(["'none'"]),
  'base-uri': Object.freeze(["'none'"]),
  'form-action': Object.freeze(["'self'"]),
  'frame-ancestors': Object.freeze(["'self'"]),
  'manifest-src': Object.freeze(["'self'"]),
  'worker-src': Object.freeze(["'self'", 'blob:']),
  'upgrade-insecure-requests': Object.freeze([])
});

const luopanCsp = Object.freeze({
  'default-src': Object.freeze(["'self'"]),
  'script-src': Object.freeze(["'self'"]),
  'style-src': Object.freeze(["'self'", "'unsafe-inline'"]),
  'img-src': Object.freeze(["'self'", 'data:', 'blob:']),
  'connect-src': Object.freeze(["'none'"]),
  'frame-src': Object.freeze(["'none'"]),
  'font-src': Object.freeze(["'self'", 'data:']),
  'object-src': Object.freeze(["'none'"]),
  'base-uri': Object.freeze(["'none'"]),
  'form-action': Object.freeze(["'none'"]),
  'frame-ancestors': Object.freeze(["'self'"]),
  'manifest-src': Object.freeze(["'none'"]),
  'worker-src': Object.freeze(["'none'"])
});

export const CNYOS_UNLOCKED_STAGING_IDENTITY = Object.freeze({
  origin: 'https://cnyos.netlify.app',
  hostname: 'cnyos.netlify.app',
  siteId: '7da5e39e-580d-44f1-8623-605313e2fb2b',
  deploymentId: 'chananya-clinical-staging',
  projectRef: 'hsmnjwxurlmsizndjlun',
  clinicId: '00000000-0000-4000-8000-00000000a001',
  clinicCode: 'CHANANYA-STG',
  qrIssuer: 'CHANANYA-STG'
});

export const CNYOS_PRODUCTION_DENYLIST_IDENTITY = Object.freeze({
  origin: 'https://chananya.netlify.app',
  projectRef: 'qptxnrldzzinlcabudjv',
  clinicId: '00000000-0000-0000-0000-000000000001',
  clinicCode: 'CHANANYA',
  qrIssuer: 'CHANANYA'
});

const requiredRuntimeFiles = Object.freeze([
  '_headers',
  '_redirects',
  'index.html',
  'login.html',
  'auth-callback.html',
  'owner-control.html',
  'app.js',
  'app.css',
  'auth-config.js',
  'chananya-runtime.js',
  'tenant-config.js',
  'brand-config.js',
  'deploy-manifest.json'
]);

export const unlockedStagingForbiddenPaths = Object.freeze(Array.from(new Set([
  ...forbiddenPublicPaths,
  '/.git/HEAD',
  '/.github/workflows/ci.yml',
  '/config/tenant.cnyos-staging.json',
  '/docs/AUTHENTICATED_STAGING_RUNBOOK.md',
  '/scripts/verify-unlocked-staging-deployment.mjs',
  '/tests/unlocked-staging-deployment-verifier-contract.mjs',
  '/supabase/manual/public_routine_acl_inventory_read_only.sql',
  '/artifacts/'
])));

function fail(code) {
  throw new Error(code);
}

function required(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) fail(`${name}_REQUIRED`);
  return value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha1(value) {
  return crypto.createHash('sha1').update(value).digest('hex');
}

function bytes(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function parseJson(value, code) {
  try {
    const parsed = JSON.parse(bytes(value).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(code);
    return parsed;
  } catch {
    fail(code);
  }
}

async function readResponseBytes(response, maximum, code) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        await reader.cancel().catch(() => {});
        fail(code);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error?.message === code) throw error;
    fail(`${code}_READ_FAILED`);
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

async function request(fetchImpl, url, {
  method = 'GET',
  headers = undefined,
  maximum = MAX_CONFIG_BYTES,
  label
} = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000)
    });
  } catch {
    fail(`${label}_REQUEST_FAILED`);
  }
  const body = await readResponseBytes(response, maximum, `${label}_BODY_TOO_LARGE`);
  return { response, body };
}

function requireStatus(response, status, code) {
  if (response.status !== status) fail(code);
}

function requireStaticSecurityHeaders(response, pathname, { html = false } = {}) {
  const headers = response.headers;
  if (headers.get('x-content-type-options') !== 'nosniff') fail('UNLOCKED_STAGING_NOSNIFF_MISSING');
  if (headers.get('referrer-policy') !== 'no-referrer') fail('UNLOCKED_STAGING_REFERRER_POLICY_INVALID');
  assertSameOriginFramePolicy(headers, pathname);

  const hsts = headers.get('strict-transport-security') || '';
  const maxAge = hsts.match(/(?:^|;)\s*max-age=(\d+)(?:;|$)/i)?.[1];
  if (!maxAge || BigInt(maxAge) < MIN_HSTS_MAX_AGE) fail('UNLOCKED_STAGING_HSTS_INVALID');
  if (!/(?:^|,)\s*no-store\s*(?:,|$)/i.test(headers.get('cache-control') || '')) {
    fail('UNLOCKED_STAGING_CACHE_POLICY_INVALID');
  }
  if (!/(?:^|,)\s*noindex\s*(?:,|$)/i.test(headers.get('x-robots-tag') || '')) {
    fail('UNLOCKED_STAGING_ROBOTS_POLICY_INVALID');
  }
  const directives = new Map();
  for (const rawDirective of String(headers.get('content-security-policy') || '')
    .split(';')
    .map(value => value.trim())
    .filter(Boolean)) {
    const [rawName, ...rawTokens] = rawDirective.split(/\s+/);
    const name = String(rawName || '').toLowerCase();
    const tokens = rawTokens.map(token => token.toLowerCase());
    if (!/^[a-z][a-z0-9-]*$/.test(name) || directives.has(name) ||
      new Set(tokens).size !== tokens.length) {
      fail('UNLOCKED_STAGING_CSP_INVALID');
    }
    directives.set(name, tokens);
  }
  const expectedCsp = pathname === '/luopan-wheel.html' ? luopanCsp : standardCsp;
  if (directives.size !== Object.keys(expectedCsp).length) {
    fail('UNLOCKED_STAGING_CSP_INVALID');
  }
  for (const [name, expected] of Object.entries(expectedCsp)) {
    const actual = directives.get(name);
    if (!actual || actual.length !== expected.length ||
      !isDeepStrictEqual(new Set(actual), new Set(expected))) {
      fail('UNLOCKED_STAGING_CSP_INVALID');
    }
  }
  if (html && !/^text\/html(?:;|$)/i.test(headers.get('content-type') || '')) {
    fail('UNLOCKED_STAGING_HTML_CONTENT_TYPE_INVALID');
  }
}

function assertExpectedTarget(target) {
  const expected = CNYOS_UNLOCKED_STAGING_IDENTITY;
  const production = CNYOS_PRODUCTION_DENYLIST_IDENTITY;
  if (target.siteUrl !== expected.origin || new URL(target.siteUrl).hostname !== expected.hostname) {
    fail('UNLOCKED_STAGING_SITE_MISMATCH');
  }
  if (target.projectRef !== expected.projectRef) fail('UNLOCKED_STAGING_PROJECT_MISMATCH');
  if (target.config.deploymentId !== expected.deploymentId) fail('UNLOCKED_STAGING_DEPLOYMENT_ID_MISMATCH');
  if (target.config.tenant.expectedClinicId !== expected.clinicId) fail('UNLOCKED_STAGING_CLINIC_ID_MISMATCH');
  if (target.config.tenant.expectedClinicCode !== expected.clinicCode) fail('UNLOCKED_STAGING_CLINIC_CODE_MISMATCH');
  if (target.config.identity.qrIssuer !== expected.qrIssuer) fail('UNLOCKED_STAGING_QR_ISSUER_MISMATCH');
  if (new URL(target.config.database.url).hostname !== `${expected.projectRef}.supabase.co`) {
    fail('UNLOCKED_STAGING_DATABASE_ORIGIN_MISMATCH');
  }
  if (/(?:replace|placeholder|example|change[-_]?me)/i.test(target.config.database.publishableKey)) {
    fail('UNLOCKED_STAGING_PUBLISHABLE_KEY_PLACEHOLDER');
  }
  if (target.production.auth.redirectOrigin !== production.origin ||
    new URL(target.production.database.url).hostname !== `${production.projectRef}.supabase.co` ||
    target.production.tenant.expectedClinicId !== production.clinicId ||
    target.production.tenant.expectedClinicCode !== production.clinicCode ||
    target.production.identity.qrIssuer !== production.qrIssuer) {
    fail('UNLOCKED_STAGING_PRODUCTION_DENYLIST_IDENTITY_MISMATCH');
  }
}

function validateDeployManifest(manifest, target, commit, tree) {
  if (manifest.schemaVersion !== 1) fail('UNLOCKED_STAGING_DEPLOY_MANIFEST_SCHEMA_MISMATCH');
  if (manifest.deploymentId !== CNYOS_UNLOCKED_STAGING_IDENTITY.deploymentId) {
    fail('UNLOCKED_STAGING_DEPLOY_MANIFEST_IDENTITY_MISMATCH');
  }
  if (manifest.tenant?.expectedClinicId !== target.config.tenant.expectedClinicId ||
    manifest.tenant?.expectedClinicCode !== target.config.tenant.expectedClinicCode ||
    manifest.identity?.qrIssuer !== target.config.identity.qrIssuer) {
    fail('UNLOCKED_STAGING_DEPLOY_MANIFEST_TENANT_MISMATCH');
  }
  if (manifest.source?.verified !== true || manifest.source?.commit !== commit || manifest.source?.tree !== tree) {
    fail('UNLOCKED_STAGING_DEPLOY_MANIFEST_SOURCE_MISMATCH');
  }
  if (manifest.build?.context !== 'production' || manifest.build?.deploymentClass !== 'dedicated-staging') {
    fail('UNLOCKED_STAGING_DEPLOY_MANIFEST_CLASS_MISMATCH');
  }
  if (!Number.isFinite(Date.parse(manifest.build?.timestamp || ''))) {
    fail('UNLOCKED_STAGING_DEPLOY_MANIFEST_TIMESTAMP_INVALID');
  }
  if (manifest.safety?.previewLocked !== false || manifest.safety?.databaseLocked !== false ||
    manifest.safety?.stagingDatabaseExplicitlyAcknowledged !== true) {
    fail('UNLOCKED_STAGING_DEPLOY_MANIFEST_UNLOCK_STATE_INVALID');
  }
  const expectedFeatures = target.config.features;
  const actualFeatures = manifest.package?.features;
  if (expectedFeatures === undefined ? actualFeatures !== undefined : !isDeepStrictEqual(actualFeatures, expectedFeatures)) {
    fail('UNLOCKED_STAGING_DEPLOY_MANIFEST_FEATURES_MISMATCH');
  }
}

function validateRuntimeManifest(manifest) {
  if (manifest.schemaVersion !== 2 || manifest.integrityAlgorithm !== 'sha256' ||
    !Array.isArray(manifest.files) || !Array.isArray(manifest.integrity) ||
    !Number.isSafeInteger(manifest.fileCount) || manifest.fileCount !== manifest.files.length ||
    manifest.fileCount < 1 || manifest.integrity.length !== manifest.files.length) {
    fail('UNLOCKED_STAGING_RUNTIME_MANIFEST_INVALID');
  }
  const files = manifest.files;
  if (!files.every(name => typeof name === 'string' &&
    (/^_[a-z]+$/.test(name) || /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) &&
    isPublicRuntimeRootFile(name))) {
    fail('UNLOCKED_STAGING_RUNTIME_FILENAME_INVALID');
  }
  if (new Set(files).size !== files.length || !isDeepStrictEqual(files, [...files].sort())) {
    fail('UNLOCKED_STAGING_RUNTIME_FILESET_INVALID');
  }
  for (const name of requiredRuntimeFiles) {
    if (!files.includes(name)) fail('UNLOCKED_STAGING_RUNTIME_REQUIRED_FILE_MISSING');
  }
  const integrity = new Map();
  for (const [index, entry] of manifest.integrity.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      entry.path !== files[index] || !Number.isSafeInteger(entry.size) || entry.size < 0 ||
      !sha256Pattern.test(entry.sha256 || '') || integrity.has(entry.path)) {
      fail('UNLOCKED_STAGING_RUNTIME_INTEGRITY_INVALID');
    }
    integrity.set(entry.path, Object.freeze({ size: entry.size, sha256: entry.sha256 }));
  }
  return Object.freeze({ files, integrity });
}

function defaultGit(cwd) {
  return args => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function dependencySet(io = {}) {
  return {
    readFile: io.readFile || fs.readFile,
    readdir: io.readdir || fs.readdir,
    mkdir: io.mkdir || fs.mkdir,
    writeFile: io.writeFile || fs.writeFile,
    chmod: io.chmod || fs.chmod,
    stat: io.stat || fs.stat
  };
}

async function loadLocalArtifact(cwd, io) {
  const dist = path.join(cwd, 'dist');
  let runtimeBytes;
  let entries;
  try {
    [runtimeBytes, entries] = await Promise.all([
      io.readFile(path.join(dist, 'runtime-publish-manifest.json')),
      io.readdir(dist, { withFileTypes: true })
    ]);
  } catch {
    fail('UNLOCKED_STAGING_LOCAL_ARTIFACT_MISSING');
  }
  if (!entries.every(entry => entry.isFile())) fail('UNLOCKED_STAGING_DIST_NOT_FLAT');
  const distFiles = entries.map(entry => entry.name).sort();
  if (new Set(distFiles).size !== distFiles.length ||
    !distFiles.every(name => name === 'runtime-publish-manifest.json' || isPublicRuntimeRootFile(name))) {
    fail('UNLOCKED_STAGING_DIST_FILESET_INVALID');
  }

  const runtimeManifest = parseJson(runtimeBytes, 'UNLOCKED_STAGING_LOCAL_RUNTIME_MANIFEST_INVALID');
  const validated = validateRuntimeManifest(runtimeManifest);
  const expectedDistFiles = [...validated.files, 'runtime-publish-manifest.json'].sort();
  if (!isDeepStrictEqual(distFiles, expectedDistFiles)) fail('UNLOCKED_STAGING_DIST_FILESET_MISMATCH');

  const files = new Map();
  for (const name of distFiles) {
    let content;
    try { content = bytes(await io.readFile(path.join(dist, name))); }
    catch { fail('UNLOCKED_STAGING_LOCAL_ARTIFACT_MISSING'); }
    if (name !== 'runtime-publish-manifest.json') {
      const declared = validated.integrity.get(name);
      if (!declared || declared.size !== content.byteLength || declared.sha256 !== sha256(content)) {
        fail('UNLOCKED_STAGING_LOCAL_FILE_INTEGRITY_MISMATCH');
      }
    }
    files.set(name, content);
  }
  const aggregate = [...files.entries()].map(([name, content]) => ({
    path: name,
    size: content.byteLength,
    sha256: sha256(content)
  }));
  return Object.freeze({
    files,
    runtimeBytes: bytes(runtimeBytes),
    runtimeManifest,
    runtimeFiles: validated.files,
    artifactSha256: sha256(JSON.stringify(aggregate))
  });
}

async function netlifyApiBytes(fetchImpl, token, pathname, maximum = MAX_NETLIFY_API_BYTES) {
  const result = await request(fetchImpl, `https://api.netlify.com/api/v1${pathname}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json'
    },
    maximum,
    label: 'UNLOCKED_STAGING_NETLIFY_API'
  });
  requireStatus(result.response, 200, 'UNLOCKED_STAGING_NETLIFY_API_STATUS_MISMATCH');
  return result;
}

async function netlifyApiJson(fetchImpl, token, pathname) {
  const { body } = await netlifyApiBytes(fetchImpl, token, pathname);
  try { return JSON.parse(body.toString('utf8')); }
  catch { fail('UNLOCKED_STAGING_NETLIFY_API_RESPONSE_INVALID'); }
}

function assertPublishedSite(site, expectedDeployId) {
  if (!site || typeof site !== 'object' || Array.isArray(site) ||
    String(site.id || '').toLowerCase() !== CNYOS_UNLOCKED_STAGING_IDENTITY.siteId ||
    String(site.ssl_url || site.url || '').replace(/\/$/, '') !== CNYOS_UNLOCKED_STAGING_IDENTITY.origin ||
    String(site.published_deploy?.id || '').toLowerCase() !== expectedDeployId) {
    fail('UNLOCKED_STAGING_NETLIFY_SITE_BINDING_MISMATCH');
  }
}

function assertNoInventoryPagination(response) {
  const link = String(response.headers.get('link') || '');
  const nextPage = String(response.headers.get('x-next-page') || '').trim();
  const pageCount = String(response.headers.get('x-page-count') || response.headers.get('x-total-pages') || '').trim();
  if (/(?:^|,)\s*<[^>]+>\s*;[^,]*\brel\s*=\s*['"]?next['"]?/i.test(link) ||
    (nextPage && nextPage !== '0') ||
    (pageCount && (!/^\d+$/.test(pageCount) || Number(pageCount) > 1))) {
    fail('UNLOCKED_STAGING_NETLIFY_FILE_INVENTORY_PAGINATED');
  }
}

async function readNetlifyFileInventory(fetchImpl, token) {
  const siteId = CNYOS_UNLOCKED_STAGING_IDENTITY.siteId;
  const result = await netlifyApiBytes(
    fetchImpl,
    token,
    `/sites/${encodeURIComponent(siteId)}/files`
  );
  assertNoInventoryPagination(result.response);
  let inventory;
  try { inventory = JSON.parse(result.body.toString('utf8')); }
  catch { fail('UNLOCKED_STAGING_NETLIFY_API_RESPONSE_INVALID'); }
  if (!Array.isArray(inventory)) fail('UNLOCKED_STAGING_NETLIFY_FILE_INVENTORY_INVALID');
  const byPath = new Map();
  for (const entry of inventory) {
    const deployedPath = String(entry?.path || entry?.id || '');
    if (!/^\/[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(deployedPath) || byPath.has(deployedPath)) {
      fail('UNLOCKED_STAGING_NETLIFY_FILE_INVENTORY_INVALID');
    }
    byPath.set(deployedPath, entry);
  }
  const normalized = [...byPath.entries()]
    .map(([deployedPath, entry]) => Object.freeze({
      path: deployedPath,
      sha1: String(entry.sha || '').toLowerCase(),
      size: Number(entry.size)
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return Object.freeze({ byPath, normalized });
}

function assertInventoryMatchesArtifact(inventory, artifact) {
  const { byPath } = inventory;
  const expectedPaths = [...artifact.files.keys()].map(name => `/${name}`).sort();
  if (!isDeepStrictEqual([...byPath.keys()].sort(), expectedPaths)) {
    fail('UNLOCKED_STAGING_NETLIFY_FILESET_MISMATCH');
  }

  for (const [name, content] of artifact.files) {
    const entry = byPath.get(`/${name}`);
    if (!entry || Number(entry.size) !== content.byteLength ||
      !sha1Pattern.test(String(entry.sha || '').toLowerCase()) ||
      String(entry.sha || '').toLowerCase() !== sha1(content)) {
      fail('UNLOCKED_STAGING_NETLIFY_FILE_METADATA_MISMATCH');
    }
  }
  return expectedPaths.length;
}

async function verifyNetlifyFileInventory(fetchImpl, token, artifact) {
  const siteId = CNYOS_UNLOCKED_STAGING_IDENTITY.siteId;
  const inventory = await readNetlifyFileInventory(fetchImpl, token);
  const expectedCount = assertInventoryMatchesArtifact(inventory, artifact);

  for (const [name, content] of artifact.files) {
    const rawResult = await request(
      fetchImpl,
      `https://api.netlify.com/api/v1/sites/${encodeURIComponent(siteId)}/files/${encodeURIComponent(name)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.bitballoon.v1.raw',
          'Content-Type': 'application/vnd.bitballoon.v1.raw'
        },
        maximum: Math.min(MAX_RUNTIME_FILE_BYTES, Math.max(content.byteLength + 1, 1024)),
        label: 'UNLOCKED_STAGING_NETLIFY_RAW_FILE'
      }
    );
    requireStatus(rawResult.response, 200, 'UNLOCKED_STAGING_NETLIFY_RAW_FILE_STATUS_MISMATCH');
    if (rawResult.body.byteLength !== content.byteLength || sha256(rawResult.body) !== sha256(content)) {
      fail('UNLOCKED_STAGING_NETLIFY_RAW_FILE_MISMATCH');
    }
  }
  return Object.freeze({ fileCount: expectedCount, normalized: inventory.normalized });
}

async function writeEvidenceFile(cwd, destinationValue, evidence, io) {
  const destination = path.resolve(cwd, destinationValue);
  const dist = path.resolve(cwd, 'dist');
  if (destination === dist || destination.startsWith(`${dist}${path.sep}`)) {
    fail('UNLOCKED_STAGING_EVIDENCE_PATH_PUBLIC');
  }
  await io.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await io.writeFile(destination, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  await io.chmod(destination, 0o600);
  const status = await io.stat(destination);
  if ((status.mode & 0o777) !== 0o600) fail('UNLOCKED_STAGING_EVIDENCE_MODE_INVALID');
  return destination;
}

export async function verifyUnlockedStagingDeployment({
  env = process.env,
  cwd = root,
  fetchImpl = fetch,
  gitImpl = null,
  releaseGateImpl = verifyNetlifyScheduledReleaseGate,
  sourceFilesImpl = loadExactGitRootBlobs,
  io: ioInput = {},
  now = () => new Date()
} = {}) {
  if (env.CNYOS_UNLOCKED_STAGING_VERIFY_ACK !== 'VERIFY_UNLOCKED_CNYOS_STAGING_ONLY') {
    fail('CNYOS_UNLOCKED_STAGING_VERIFY_ACK_REQUIRED');
  }
  const expectedCommit = required(env, 'EXPECTED_STAGING_SOURCE_COMMIT').toLowerCase();
  if (!sha40.test(expectedCommit)) fail('EXPECTED_STAGING_SOURCE_COMMIT_INVALID');
  const expectedSiteId = required(env, 'STAGING_NETLIFY_SITE_ID').toLowerCase();
  if (expectedSiteId !== CNYOS_UNLOCKED_STAGING_IDENTITY.siteId) {
    fail('UNLOCKED_STAGING_NETLIFY_SITE_ID_MISMATCH');
  }
  const expectedDeployId = required(env, 'EXPECTED_STAGING_NETLIFY_DEPLOY_ID').toLowerCase();
  if (!/^[0-9a-f]{24}$/.test(expectedDeployId)) {
    fail('EXPECTED_STAGING_NETLIFY_DEPLOY_ID_INVALID');
  }
  const netlifyToken = required(env, 'NETLIFY_AUTH_TOKEN');

  const git = gitImpl || defaultGit(cwd);
  const checkoutCommit = String(git(['rev-parse', 'HEAD']) || '').trim().toLowerCase();
  const checkoutTree = String(git(['rev-parse', 'HEAD^{tree}']) || '').trim().toLowerCase();
  const checkoutStatus = String(git(['status', '--porcelain=v1', '--untracked-files=all']) || '').trim();
  if (checkoutCommit !== expectedCommit || !sha40.test(checkoutTree)) {
    fail('UNLOCKED_STAGING_CHECKOUT_IDENTITY_MISMATCH');
  }
  if (checkoutStatus) fail('UNLOCKED_STAGING_CHECKOUT_NOT_CLEAN');

  const target = loadStagingTarget({ env, cwd });
  assertExpectedTarget(target);
  const expectedUnlockedConfig = {
    ...target.config,
    safety: { previewLocked: false }
  };
  const buildTimestamp = required(env, 'CLINICAL_OS_BUILD_TIMESTAMP');
  if (env.CONTEXT !== 'production' || env.CLINICAL_OS_STAGING_DEPLOYMENT !== 'true' ||
    env.CLINICAL_OS_ALLOW_STAGING_DATABASE !== 'true' ||
    env.CLINICAL_OS_STAGING_DATABASE_ACK !== 'STAGING_ONLY' ||
    env.CLINICAL_OS_REQUIRE_SOURCE_COMMIT !== 'true' ||
    String(env.CLINICAL_OS_SOURCE_COMMIT || '').toLowerCase() !== checkoutCommit ||
    String(env.CLINICAL_OS_SOURCE_TREE || '').toLowerCase() !== checkoutTree) {
    fail('UNLOCKED_STAGING_BUILD_BINDING_INVALID');
  }
  const expectedDeployManifest = buildDeployManifest(
    expectedUnlockedConfig,
    env,
    new Date(buildTimestamp)
  );
  const expectedGeneratedFiles = new Map([
    ['tenant-config.js', Buffer.from(renderTenantConfig(expectedUnlockedConfig))],
    ['brand-config.js', Buffer.from(renderBrandConfig(expectedUnlockedConfig))],
    ['deploy-manifest.json', Buffer.from(renderDeployManifest(expectedDeployManifest))]
  ]);

  const io = dependencySet(ioInput);
  const artifact = await loadLocalArtifact(cwd, io);
  const localTenantBytes = artifact.files.get('tenant-config.js');
  const localDeployBytes = artifact.files.get('deploy-manifest.json');
  const localRuntimeBytes = artifact.runtimeBytes;
  let localTenantConfig;
  try { localTenantConfig = parseTenantConfig(localTenantBytes.toString('utf8')); }
  catch { fail('UNLOCKED_STAGING_LOCAL_TENANT_CONFIG_INVALID'); }
  if (!isDeepStrictEqual(localTenantConfig, expectedUnlockedConfig)) {
    fail('UNLOCKED_STAGING_LOCAL_TENANT_CONFIG_MISMATCH');
  }
  const localDeployManifest = parseJson(localDeployBytes, 'UNLOCKED_STAGING_LOCAL_DEPLOY_MANIFEST_INVALID');
  const localRuntimeManifest = artifact.runtimeManifest;
  validateDeployManifest(localDeployManifest, target, checkoutCommit, checkoutTree);
  const runtimeFiles = artifact.runtimeFiles;

  let trackedSources;
  try { trackedSources = selectRuntimeSourceFiles(await sourceFilesImpl(cwd), expectedDeployManifest); }
  catch { fail('UNLOCKED_STAGING_SOURCE_TREE_READ_FAILED'); }
  const expectedRuntimeFiles = [...trackedSources.keys(), ...expectedGeneratedFiles.keys()].sort();
  if (!isDeepStrictEqual(artifact.runtimeFiles, expectedRuntimeFiles)) {
    fail('UNLOCKED_STAGING_SOURCE_DERIVED_FILESET_MISMATCH');
  }
  for (const [name, expected] of [...trackedSources, ...expectedGeneratedFiles]) {
    const actual = artifact.files.get(name);
    if (!actual || actual.byteLength !== expected.byteLength || sha256(actual) !== sha256(expected)) {
      fail('UNLOCKED_STAGING_SOURCE_DERIVED_FILE_MISMATCH');
    }
  }
  if (artifact.runtimeManifest.generatedAt !== expectedDeployManifest.build.timestamp) {
    fail('UNLOCKED_STAGING_RUNTIME_TIMESTAMP_MISMATCH');
  }

  const origin = CNYOS_UNLOCKED_STAGING_IDENTITY.origin;
  const releaseGate = await releaseGateImpl({
    siteUrl: origin,
    siteId: expectedSiteId,
    expectedCommit: checkoutCommit,
    expectedTree: checkoutTree,
    expectedDeployId,
    netlifyToken,
    fetchImpl,
    now
  });
  if (releaseGate.siteId !== expectedSiteId || releaseGate.canonicalOrigin !== origin ||
    releaseGate.netlifyDeployId !== expectedDeployId || !releaseGate.exactDeployOrigin) {
    fail('UNLOCKED_STAGING_SCHEDULED_GATE_BINDING_MISMATCH');
  }
  const siteBefore = await netlifyApiJson(
    fetchImpl,
    netlifyToken,
    `/sites/${encodeURIComponent(expectedSiteId)}`
  );
  assertPublishedSite(siteBefore, releaseGate.netlifyDeployId);
  const initialInventory = await verifyNetlifyFileInventory(fetchImpl, netlifyToken, artifact);

  const controls = new Map();
  for (const [originKind, boundOrigin] of [
    ['canonical', origin],
    ['exact-deploy', releaseGate.exactDeployOrigin]
  ]) {
    const [tenantResult, deployResult, runtimeResult] = await Promise.all([
      request(fetchImpl, `${boundOrigin}/tenant-config.js`, { label: 'UNLOCKED_STAGING_TENANT_CONFIG' }),
      request(fetchImpl, `${boundOrigin}/deploy-manifest.json`, { label: 'UNLOCKED_STAGING_DEPLOY_MANIFEST' }),
      request(fetchImpl, `${boundOrigin}/runtime-publish-manifest.json`, { label: 'UNLOCKED_STAGING_RUNTIME_MANIFEST' })
    ]);
    for (const [pathname, result] of [
      ['/tenant-config.js', tenantResult],
      ['/deploy-manifest.json', deployResult],
      ['/runtime-publish-manifest.json', runtimeResult]
    ]) {
      requireStatus(result.response, 200, 'UNLOCKED_STAGING_METADATA_STATUS_MISMATCH');
      requireStaticSecurityHeaders(result.response, pathname);
    }
    if (sha256(tenantResult.body) !== sha256(localTenantBytes)) {
      fail('UNLOCKED_STAGING_TENANT_CONFIG_HASH_MISMATCH');
    }
    if (sha256(deployResult.body) !== sha256(localDeployBytes)) {
      fail('UNLOCKED_STAGING_DEPLOY_MANIFEST_HASH_MISMATCH');
    }
    if (sha256(runtimeResult.body) !== sha256(localRuntimeBytes)) {
      fail('UNLOCKED_STAGING_RUNTIME_MANIFEST_HASH_MISMATCH');
    }
    controls.set(originKind, { tenantResult, deployResult, runtimeResult });
  }

  const { tenantResult, deployResult, runtimeResult } = controls.get('canonical');

  let remoteTenantConfig;
  try { remoteTenantConfig = parseTenantConfig(tenantResult.body.toString('utf8')); }
  catch { fail('UNLOCKED_STAGING_REMOTE_TENANT_CONFIG_INVALID'); }
  if (!isDeepStrictEqual(remoteTenantConfig, expectedUnlockedConfig)) {
    fail('UNLOCKED_STAGING_REMOTE_TENANT_CONFIG_MISMATCH');
  }
  const remoteDeployManifest = parseJson(deployResult.body, 'UNLOCKED_STAGING_REMOTE_DEPLOY_MANIFEST_INVALID');
  const remoteRuntimeManifest = parseJson(runtimeResult.body, 'UNLOCKED_STAGING_REMOTE_RUNTIME_MANIFEST_INVALID');
  validateDeployManifest(remoteDeployManifest, target, checkoutCommit, checkoutTree);
  if (!isDeepStrictEqual(remoteRuntimeManifest, localRuntimeManifest)) {
    fail('UNLOCKED_STAGING_REMOTE_RUNTIME_MANIFEST_MISMATCH');
  }

  const healthUrl = `${target.config.database.url.replace(/\/$/, '')}/auth/v1/health`;
  const healthResult = await request(fetchImpl, healthUrl, {
    headers: {
      Accept: 'application/json',
      apikey: target.config.database.publishableKey
    },
    maximum: MAX_ERROR_BODY_BYTES,
    label: 'UNLOCKED_STAGING_SUPABASE_HEALTH'
  });
  requireStatus(healthResult.response, 200, 'UNLOCKED_STAGING_SUPABASE_HEALTH_STATUS_MISMATCH');
  const health = parseJson(healthResult.body, 'UNLOCKED_STAGING_SUPABASE_HEALTH_INVALID');
  if (health.name !== 'GoTrue' || typeof health.version !== 'string' || !health.version.trim()) {
    fail('UNLOCKED_STAGING_SUPABASE_HEALTH_INVALID');
  }

  const htmlPaths = Array.from(new Set([
    '/',
    ...runtimeFiles.filter(name => name.endsWith('.html')).map(name => `/${name}`)
  ])).sort();
  const routes = [];
  for (const [originKind, boundOrigin] of [
    ['canonical', origin],
    ['exact-deploy', releaseGate.exactDeployOrigin]
  ]) {
    for (const pathname of htmlPaths) {
      const result = await request(fetchImpl, `${boundOrigin}${pathname}`, {
        maximum: MAX_HTML_BYTES,
        label: 'UNLOCKED_STAGING_HTML'
      });
      requireStatus(result.response, 200, 'UNLOCKED_STAGING_HTML_STATUS_MISMATCH');
      requireStaticSecurityHeaders(result.response, pathname, { html: true });
      if (!/<(?:!doctype\s+html|html)\b/i.test(result.body.toString('utf8'))) {
        fail('UNLOCKED_STAGING_HTML_DOCUMENT_INVALID');
      }
      routes.push(Object.freeze({ origin: originKind, path: pathname, status: 200 }));
    }
  }

  const forbiddenPaths = [];
  for (const pathname of unlockedStagingForbiddenPaths) {
    const result = await request(fetchImpl, `${origin}${pathname}`, {
      maximum: MAX_ERROR_BODY_BYTES,
      label: 'UNLOCKED_STAGING_FORBIDDEN_PATH'
    });
    requireStatus(result.response, 404, 'UNLOCKED_STAGING_FORBIDDEN_PATH_PRESENT');
    forbiddenPaths.push(Object.freeze({ path: pathname, status: 404 }));
  }

  const finalInventory = await readNetlifyFileInventory(fetchImpl, netlifyToken);
  assertInventoryMatchesArtifact(finalInventory, artifact);
  if (!isDeepStrictEqual(finalInventory.normalized, initialInventory.normalized)) {
    fail('UNLOCKED_STAGING_NETLIFY_FILE_INVENTORY_CHANGED_DURING_VERIFICATION');
  }
  const siteAfter = await netlifyApiJson(
    fetchImpl,
    netlifyToken,
    `/sites/${encodeURIComponent(expectedSiteId)}`
  );
  assertPublishedSite(siteAfter, releaseGate.netlifyDeployId);

  const observedAt = now();
  if (!(observedAt instanceof Date) || Number.isNaN(observedAt.getTime())) {
    fail('UNLOCKED_STAGING_EVIDENCE_TIME_INVALID');
  }
  const evidence = Object.freeze({
    schemaVersion: 1,
    evidenceType: 'unlocked_staging_deployment_observation',
    environment: 'staging',
    syntheticOnly: true,
    authorization: false,
    productionEligible: false,
    productionAuthorization: false,
    realPatientDataAuthorized: false,
    databaseMutationPerformed: false,
    authenticatedDatabaseBehaviorVerified: false,
    observedAt: observedAt.toISOString(),
    siteOrigin: origin,
    netlifySiteId: expectedSiteId,
    netlifyDeployId: releaseGate.netlifyDeployId,
    exactDeployOrigin: releaseGate.exactDeployOrigin,
    deploymentId: target.config.deploymentId,
    databaseProjectRef: target.projectRef,
    clinicId: target.config.tenant.expectedClinicId,
    clinicCode: target.config.tenant.expectedClinicCode,
    sourceCommit: checkoutCommit,
    sourceTree: checkoutTree,
    tenantConfigSha256: sha256(localTenantBytes),
    deployManifestSha256: sha256(localDeployBytes),
    runtimePublishManifestSha256: sha256(localRuntimeBytes),
    artifactSha256: artifact.artifactSha256,
    artifactFileCount: initialInventory.fileCount,
    deploymentClass: remoteDeployManifest.build.deploymentClass,
    previewLocked: false,
    databaseLocked: false,
    stagingDatabaseExplicitlyAcknowledged: true,
    browserDatabaseConfigured: true,
    authHealth: Object.freeze({ reachable: true, service: 'GoTrue' }),
    schedules: releaseGate.schedules,
    scheduledRouteDenials: releaseGate.routeDenials,
    routes,
    forbiddenPaths
  });

  const evidencePath = await writeEvidenceFile(
    cwd,
    env.UNLOCKED_STAGING_EVIDENCE_PATH || 'artifacts/staging-e2e/unlocked-staging-deployment.json',
    evidence,
    io
  );
  return Object.freeze({ evidence, evidencePath });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stderr.write(
    'CANDIDATE_SPEC_ONLY: run an independently committed controller-owned implementation; no credential was read.\n'
  );
  process.exitCode = 1;
}
