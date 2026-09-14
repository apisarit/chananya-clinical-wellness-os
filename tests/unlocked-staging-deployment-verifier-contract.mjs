import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDeployManifest,
  renderBrandConfig,
  renderTenantConfig,
  validateTenantConfig
} from '../scripts/generate-tenant-config.mjs';
import {
  CNYOS_UNLOCKED_STAGING_IDENTITY,
  unlockedStagingForbiddenPaths,
  verifyUnlockedStagingDeployment
} from '../scripts/verify-unlocked-staging-deployment.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceCommit = 'a'.repeat(40);
const sourceTree = 'b'.repeat(40);
const netlifyDeployId = 'c'.repeat(24);
const exactDeployOrigin = `https://${netlifyDeployId}--cnyos.netlify.app`;
const publishableKey = `sb_publishable_${'k'.repeat(40)}`;
const production = JSON.parse(fs.readFileSync(path.join(root, 'config/tenant.chananya.json'), 'utf8'));
const stagingSource = {
  ...JSON.parse(fs.readFileSync(path.join(root, 'config/tenant.cnyos-staging.json'), 'utf8')),
  database: {
    provider: 'supabase',
    url: `https://${CNYOS_UNLOCKED_STAGING_IDENTITY.projectRef}.supabase.co`,
    publishableKey
  },
  safety: { previewLocked: true }
};

const runtimeFiles = Object.freeze([
  '_headers',
  '_redirects',
  'app.css',
  'app.js',
  'auth-callback.html',
  'auth-config.js',
  'brand-config.js',
  'chananya-runtime.js',
  'deploy-manifest.json',
  'index.html',
  'login.html',
  'owner-control.html',
  'quality.html',
  'tenant-config.js'
].sort());

function secureHeaders(contentType = 'application/octet-stream') {
  return {
    'Cache-Control': 'private, no-store, max-age=0',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net https://static.line-scdn.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.line-scdn.net; connect-src 'self' https://*.supabase.co wss://*.supabase.co https://*.line.me https://*.line-scdn.net; frame-src 'self' https://*.line.me; font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'; manifest-src 'self'; worker-src 'self' blob:; upgrade-insecure-requests",
    'Content-Type': contentType,
    'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=31536000',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'X-Robots-Tag': 'noindex, nofollow, noarchive'
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const digest = (algorithm, value) => crypto.createHash(algorithm).update(value).digest('hex');

function makeFixture({
  staging = stagingSource,
  tenantTransform = value => value,
  deployTransform = value => value,
  runtimeTransform = value => value,
  fileTransform = () => {},
  omittedArtifactFiles = []
} = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cnyos-unlocked-staging-verifier-'));
  const dist = path.join(cwd, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  const validated = validateTenantConfig(staging);
  const unlocked = tenantTransform({ ...validated, safety: { previewLocked: false } });
  const deploy = deployTransform(buildDeployManifest(unlocked, {
    CONTEXT: 'production',
    CLINICAL_OS_STAGING_DEPLOYMENT: 'true',
    CLINICAL_OS_ALLOW_STAGING_DATABASE: 'true',
    CLINICAL_OS_STAGING_DATABASE_ACK: 'STAGING_ONLY',
    CLINICAL_OS_SOURCE_COMMIT: sourceCommit,
    CLINICAL_OS_SOURCE_TREE: sourceTree,
    CLINICAL_OS_REQUIRE_SOURCE_COMMIT: 'true'
  }, new Date('2026-09-08T00:00:00.000Z')));
  const tenantBytes = Buffer.from(renderTenantConfig(unlocked));
  const brandBytes = Buffer.from(renderBrandConfig(unlocked));
  const deployBytes = Buffer.from(`${JSON.stringify(deploy, null, 2)}\n`);
  const fileBytes = new Map(runtimeFiles.map(name => [name, Buffer.from(
    name === 'tenant-config.js'
      ? tenantBytes
      : name === 'brand-config.js'
        ? brandBytes
      : name === 'deploy-manifest.json'
        ? deployBytes
        : name.endsWith('.html')
          ? '<!doctype html><html><title>staging</title></html>'
          : `fixture:${name}`
  )]));
  const sourceFiles = new Map([...fileBytes].filter(([name]) =>
    !['tenant-config.js', 'brand-config.js', 'deploy-manifest.json'].includes(name)
  ));
  fileTransform(fileBytes);
  for (const name of omittedArtifactFiles) fileBytes.delete(name);
  const artifactRuntimeFiles = runtimeFiles.filter(name => fileBytes.has(name));
  const runtime = runtimeTransform({
    schemaVersion: 2,
    generatedAt: '2026-09-08T00:00:00.000Z',
    fileCount: artifactRuntimeFiles.length,
    files: [...artifactRuntimeFiles],
    integrityAlgorithm: 'sha256',
    integrity: artifactRuntimeFiles.map(name => ({
      path: name,
      size: fileBytes.get(name).byteLength,
      sha256: digest('sha256', fileBytes.get(name))
    }))
  });
  const runtimeBytes = Buffer.from(`${JSON.stringify(runtime, null, 2)}\n`);
  for (const [name, content] of fileBytes) fs.writeFileSync(path.join(dist, name), content);
  fs.writeFileSync(path.join(dist, 'runtime-publish-manifest.json'), runtimeBytes);
  fileBytes.set('runtime-publish-manifest.json', runtimeBytes);
  return {
    cwd,
    dist,
    staging,
    unlocked,
    deploy,
    runtime,
    tenantBytes,
    deployBytes,
    runtimeBytes,
    fileBytes,
    sourceFiles,
    env: {
      CNYOS_UNLOCKED_STAGING_VERIFY_ACK: 'VERIFY_UNLOCKED_CNYOS_STAGING_ONLY',
      EXPECTED_STAGING_SOURCE_COMMIT: sourceCommit,
      CONTEXT: 'production',
      CLINICAL_OS_STAGING_DEPLOYMENT: 'true',
      CLINICAL_OS_ALLOW_STAGING_DATABASE: 'true',
      CLINICAL_OS_STAGING_DATABASE_ACK: 'STAGING_ONLY',
      CLINICAL_OS_REQUIRE_SOURCE_COMMIT: 'true',
      CLINICAL_OS_SOURCE_COMMIT: sourceCommit,
      CLINICAL_OS_SOURCE_TREE: sourceTree,
      CLINICAL_OS_BUILD_TIMESTAMP: '2026-09-08T00:00:00.000Z',
      STAGING_NETLIFY_SITE_ID: CNYOS_UNLOCKED_STAGING_IDENTITY.siteId,
      EXPECTED_STAGING_NETLIFY_DEPLOY_ID: netlifyDeployId,
      NETLIFY_AUTH_TOKEN: 'netlify-test-token-never-log',
      CLINICAL_OS_STAGING_ACK: 'STAGING_ONLY',
      CLINICAL_OS_STAGING_CONFIG_JSON: JSON.stringify(staging),
      CLINICAL_OS_PRODUCTION_CONFIG_JSON: JSON.stringify(production),
      STAGING_SITE_URL: CNYOS_UNLOCKED_STAGING_IDENTITY.origin,
      UNLOCKED_STAGING_EVIDENCE_PATH: 'artifacts/staging-e2e/unlocked-staging-deployment.json'
    }
  };
}

function fakeGit({ commit = sourceCommit, tree = sourceTree, status = '' } = {}) {
  return args => {
    const command = args.join(' ');
    if (command === 'rev-parse HEAD') return commit;
    if (command === 'rev-parse HEAD^{tree}') return tree;
    if (command === 'status --porcelain=v1 --untracked-files=all') return status;
    throw new Error(`Unexpected git command: ${command}`);
  };
}

function mockFetch(fixture, options = {}) {
  const calls = [];
  let siteReadCount = 0;
  let inventoryReadCount = 0;
  const htmlNames = new Set(fixture.runtime.files.filter(name => typeof name === 'string' && name.endsWith('.html')));
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.origin === 'https://api.netlify.com') {
      const sitePath = `/api/v1/sites/${CNYOS_UNLOCKED_STAGING_IDENTITY.siteId}`;
      if (url.pathname === sitePath) {
        siteReadCount += 1;
        const publishedId = options.siteDeployIds?.[siteReadCount - 1] || netlifyDeployId;
        return new Response(JSON.stringify({
          id: CNYOS_UNLOCKED_STAGING_IDENTITY.siteId,
          ssl_url: CNYOS_UNLOCKED_STAGING_IDENTITY.origin,
          published_deploy: { id: publishedId }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.pathname === `${sitePath}/files`) {
        inventoryReadCount += 1;
        const inventory = [...fixture.fileBytes.entries()]
          .filter(([name]) => name !== options.omitInventoryFile &&
            !(inventoryReadCount === 2 && name === options.secondInventoryOmitFile))
          .map(([name, content]) => ({
            id: `/${name}`,
            path: `/${name}`,
            sha: digest('sha1', content),
            size: content.byteLength,
            mime_type: 'application/octet-stream'
          }));
        if (options.extraInventoryFile) {
          const content = Buffer.from('unreviewed debug payload');
          inventory.push({
            id: `/${options.extraInventoryFile}`,
            path: `/${options.extraInventoryFile}`,
            sha: digest('sha1', content),
            size: content.byteLength,
            mime_type: 'text/html'
          });
        }
        if (inventoryReadCount === 2 && options.secondInventoryExtraFile) {
          const content = Buffer.from('late unreviewed payload');
          inventory.push({
            id: `/${options.secondInventoryExtraFile}`,
            path: `/${options.secondInventoryExtraFile}`,
            sha: digest('sha1', content),
            size: content.byteLength,
            mime_type: 'text/html'
          });
        }
        return new Response(JSON.stringify(inventory), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            ...(options.inventoryPaginationHeader && inventoryReadCount === 1
              ? { Link: options.inventoryPaginationHeader }
              : {})
          }
        });
      }
      const rawPrefix = `${sitePath}/files/`;
      if (url.pathname.startsWith(rawPrefix)) {
        const name = decodeURIComponent(url.pathname.slice(rawPrefix.length));
        const content = options.rawFileOverrides?.[name] ?? fixture.fileBytes.get(name);
        return new Response(content, { status: content === undefined ? 404 : 200 });
      }
      throw new Error(`Unexpected Netlify API request: ${url}`);
    }
    if (url.hostname === `${CNYOS_UNLOCKED_STAGING_IDENTITY.projectRef}.supabase.co`) {
      const status = options.healthStatus ?? 200;
      const body = options.healthBody ?? JSON.stringify({ name: 'GoTrue', version: 'v2.test' });
      return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
    }
    assert.ok(
      [CNYOS_UNLOCKED_STAGING_IDENTITY.origin, exactDeployOrigin].includes(url.origin),
      `unexpected staging origin ${url.origin}`
    );
    const status = options.statuses?.[url.pathname];
    const headerChanges = options.headerChanges?.[url.pathname] || {};
    if (url.pathname === '/tenant-config.js') {
      return new Response(options.remoteTenantBytes ?? fixture.tenantBytes, {
        status: status ?? 200,
        headers: { ...secureHeaders('application/javascript'), ...headerChanges }
      });
    }
    if (url.pathname === '/deploy-manifest.json') {
      return new Response(options.remoteDeployBytes ?? fixture.deployBytes, {
        status: status ?? 200,
        headers: { ...secureHeaders('application/json'), ...headerChanges }
      });
    }
    if (url.pathname === '/runtime-publish-manifest.json') {
      return new Response(options.remoteRuntimeBytes ?? fixture.runtimeBytes, {
        status: status ?? 200,
        headers: { ...secureHeaders('application/json'), ...headerChanges }
      });
    }
    if (url.pathname === '/' || htmlNames.has(url.pathname.slice(1))) {
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      return new Response(fixture.fileBytes.get(name), {
        status: status ?? 200,
        headers: { ...secureHeaders('text/html; charset=utf-8'), ...headerChanges }
      });
    }
    if (unlockedStagingForbiddenPaths.includes(url.pathname)) {
      return new Response('not found', { status: status ?? 404, headers: { 'Content-Type': 'text/plain' } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  return { calls, fetchImpl };
}

function fakeReleaseGate(overrides = {}) {
  return async () => ({
    siteId: CNYOS_UNLOCKED_STAGING_IDENTITY.siteId,
    canonicalOrigin: CNYOS_UNLOCKED_STAGING_IDENTITY.origin,
    netlifyDeployId,
    exactDeployOrigin,
    schedules: [{ name: 'database-backup', cron: '0 20 * * *' }],
    routeDenials: [{ origin: 'canonical', method: 'GET', path: '/.netlify/functions/database-backup', status: 404 }],
    ...overrides
  });
}

async function run(fixture, { env = {}, git = {}, fetch = {}, releaseGate = {} } = {}) {
  const mocked = mockFetch(fixture, fetch);
  const result = await verifyUnlockedStagingDeployment({
    env: { ...fixture.env, ...env },
    cwd: fixture.cwd,
    fetchImpl: mocked.fetchImpl,
    gitImpl: typeof git === 'function' ? git : fakeGit(git),
    releaseGateImpl: typeof releaseGate === 'function' ? releaseGate : fakeReleaseGate(releaseGate),
    sourceFilesImpl: () => fixture.sourceFiles,
    now: () => new Date('2026-09-08T00:05:00.000Z')
  });
  return { ...result, calls: mocked.calls };
}

async function rejectsWith(promise, pattern) {
  try {
    await promise;
  } catch (error) {
    assert.match(String(error?.message || error), pattern);
    assert.doesNotMatch(String(error?.message || error), new RegExp(publishableKey));
    return error;
  }
  assert.fail(`Expected rejection matching ${pattern}`);
}

const fixtures = [];
try {
  const fixture = makeFixture();
  fixtures.push(fixture);
  const passed = await run(fixture);
  assert.equal(passed.evidence.evidenceType, 'unlocked_staging_deployment_observation');
  assert.equal(passed.evidence.environment, 'staging');
  assert.equal(passed.evidence.syntheticOnly, true);
  assert.equal(passed.evidence.authorization, false);
  assert.equal(passed.evidence.productionEligible, false);
  assert.equal(passed.evidence.productionAuthorization, false);
  assert.equal(passed.evidence.realPatientDataAuthorized, false);
  assert.equal(passed.evidence.databaseMutationPerformed, false);
  assert.equal(passed.evidence.authenticatedDatabaseBehaviorVerified, false);
  assert.equal(passed.evidence.deploymentClass, 'dedicated-staging');
  assert.equal(passed.evidence.databaseLocked, false);
  assert.equal(passed.evidence.stagingDatabaseExplicitlyAcknowledged, true);
  assert.equal(
    passed.evidence.routes.length,
    2 * (1 + fixture.runtime.files.filter(name => name.endsWith('.html')).length)
  );
  assert.deepEqual(
    passed.evidence.routes.filter(item => item.origin === 'canonical').map(item => item.path),
    ['/', ...runtimeFiles.filter(name => name.endsWith('.html')).map(name => `/${name}`)].sort()
  );
  assert.equal(passed.evidence.netlifySiteId, CNYOS_UNLOCKED_STAGING_IDENTITY.siteId);
  assert.equal(passed.evidence.netlifyDeployId, netlifyDeployId);
  assert.equal(passed.evidence.exactDeployOrigin, exactDeployOrigin);
  assert.equal(passed.evidence.artifactFileCount, fixture.fileBytes.size);
  assert.match(passed.evidence.artifactSha256, /^[0-9a-f]{64}$/);
  assert.equal(passed.evidence.forbiddenPaths.length, unlockedStagingForbiddenPaths.length);
  assert.equal(fs.statSync(passed.evidencePath).mode & 0o777, 0o600);
  const evidenceText = fs.readFileSync(passed.evidencePath, 'utf8');
  assert.doesNotMatch(evidenceText, new RegExp(publishableKey));
  assert.doesNotMatch(evidenceText, /service[_-]?role|sb_secret_/i);

  const healthCall = passed.calls.find(call => call.url.pathname === '/auth/v1/health');
  assert.ok(healthCall, 'the protected staging Supabase Auth health endpoint must be checked');
  assert.equal(healthCall.url.origin, `https://${CNYOS_UNLOCKED_STAGING_IDENTITY.projectRef}.supabase.co`);
  assert.equal(healthCall.init.method, 'GET');
  assert.equal(healthCall.init.headers.apikey, publishableKey);
  assert.equal(Object.hasOwn(healthCall.init.headers, 'Authorization'), false);
  assert.ok(passed.calls.every(call => call.init.redirect === 'error'));

  await rejectsWith(run(fixture, {
    env: { CNYOS_UNLOCKED_STAGING_VERIFY_ACK: '' }
  }), /CNYOS_UNLOCKED_STAGING_VERIFY_ACK_REQUIRED/);
  await rejectsWith(run(fixture, {
    env: { EXPECTED_STAGING_SOURCE_COMMIT: 'a'.repeat(39) }
  }), /EXPECTED_STAGING_SOURCE_COMMIT_INVALID/);
  await rejectsWith(run(fixture, {
    env: { STAGING_NETLIFY_SITE_ID: '00000000-0000-4000-8000-000000000000' }
  }), /UNLOCKED_STAGING_NETLIFY_SITE_ID_MISMATCH/);
  await rejectsWith(run(fixture, {
    env: { NETLIFY_AUTH_TOKEN: '' }
  }), /NETLIFY_AUTH_TOKEN_REQUIRED/);
  await rejectsWith(run(fixture, {
    env: { EXPECTED_STAGING_NETLIFY_DEPLOY_ID: '' }
  }), /EXPECTED_STAGING_NETLIFY_DEPLOY_ID_REQUIRED/);
  await rejectsWith(run(fixture, {
    env: { EXPECTED_STAGING_NETLIFY_DEPLOY_ID: 'c'.repeat(23) }
  }), /EXPECTED_STAGING_NETLIFY_DEPLOY_ID_INVALID/);
  await rejectsWith(run(fixture, {
    git: { commit: 'c'.repeat(40) }
  }), /UNLOCKED_STAGING_CHECKOUT_IDENTITY_MISMATCH/);
  await rejectsWith(run(fixture, {
    git: { status: ' M app.js' }
  }), /UNLOCKED_STAGING_CHECKOUT_NOT_CLEAN/);
  await rejectsWith(run(fixture, {
    env: { STAGING_SITE_URL: 'https://other-staging.netlify.app' }
  }), /exactly match|SITE_MISMATCH/);
  await rejectsWith(run(fixture, {
    env: {
      CLINICAL_OS_STAGING_CONFIG_JSON: JSON.stringify({
        ...stagingSource,
        database: { ...stagingSource.database, url: 'https://other-staging-ref.supabase.co' }
      })
    }
  }), /UNLOCKED_STAGING_PROJECT_MISMATCH/);
  await rejectsWith(run(fixture, {
    env: {
      CLINICAL_OS_STAGING_CONFIG_JSON: JSON.stringify({
        ...stagingSource,
        database: { ...stagingSource.database, publishableKey: 'sb_publishable_REPLACE_AFTER_BOOTSTRAP' }
      })
    }
  }), /UNLOCKED_STAGING_PUBLISHABLE_KEY_PLACEHOLDER/);
  await rejectsWith(run(fixture, {
    env: { CLINICAL_OS_STAGING_CONFIG_JSON: JSON.stringify(production) }
  }), /staging deploymentId|Production Supabase project|Production site/);
  await rejectsWith(run(fixture, {
    env: {
      CLINICAL_OS_PRODUCTION_CONFIG_JSON: JSON.stringify({
        ...production,
        deploymentId: 'other-clinic-production',
        tenant: {
          expectedClinicId: '20000000-0000-4000-8000-000000000002',
          expectedClinicCode: 'OTHER'
        },
        database: {
          ...production.database,
          url: 'https://other-production-ref.supabase.co'
        },
        auth: { ...production.auth, redirectOrigin: 'https://other-clinic.netlify.app' },
        identity: { qrIssuer: 'OTHER' }
      })
    }
  }), /UNLOCKED_STAGING_PRODUCTION_DENYLIST_IDENTITY_MISMATCH/);

  await rejectsWith(run(fixture, {
    fetch: { remoteTenantBytes: Buffer.concat([fixture.tenantBytes, Buffer.from(' ')]) }
  }), /UNLOCKED_STAGING_TENANT_CONFIG_HASH_MISMATCH/);
  await rejectsWith(run(fixture, {
    fetch: { remoteDeployBytes: Buffer.concat([fixture.deployBytes, Buffer.from(' ')]) }
  }), /UNLOCKED_STAGING_DEPLOY_MANIFEST_HASH_MISMATCH/);
  await rejectsWith(run(fixture, {
    fetch: { remoteRuntimeBytes: Buffer.concat([fixture.runtimeBytes, Buffer.from(' ')]) }
  }), /UNLOCKED_STAGING_RUNTIME_MANIFEST_HASH_MISMATCH/);
  await rejectsWith(run(fixture, {
    fetch: { rawFileOverrides: { 'app.js': Buffer.from('tampered application') } }
  }), /UNLOCKED_STAGING_NETLIFY_RAW_FILE_MISMATCH/);
  await rejectsWith(run(fixture, {
    fetch: { omitInventoryFile: 'app.js' }
  }), /UNLOCKED_STAGING_NETLIFY_FILESET_MISMATCH/);
  await rejectsWith(run(fixture, {
    fetch: { extraInventoryFile: 'debug.html' }
  }), /UNLOCKED_STAGING_NETLIFY_FILESET_MISMATCH/);
  await rejectsWith(run(fixture, {
    fetch: { secondInventoryExtraFile: 'late-debug.html' }
  }), /UNLOCKED_STAGING_NETLIFY_FILESET_MISMATCH/);
  await rejectsWith(run(fixture, {
    fetch: { inventoryPaginationHeader: '<https://api.netlify.com/api/v1/sites/example/files?page=2>; rel="next"' }
  }), /UNLOCKED_STAGING_NETLIFY_FILE_INVENTORY_PAGINATED/);
  await rejectsWith(run(fixture, {
    releaseGate: { netlifyDeployId: 'd'.repeat(24) }
  }), /UNLOCKED_STAGING_SCHEDULED_GATE_BINDING_MISMATCH/);
  await rejectsWith(run(fixture, {
    fetch: { siteDeployIds: [netlifyDeployId, 'd'.repeat(24)] }
  }), /UNLOCKED_STAGING_NETLIFY_SITE_BINDING_MISMATCH/);
  await rejectsWith(run(fixture, {
    fetch: { healthStatus: 401 }
  }), /UNLOCKED_STAGING_SUPABASE_HEALTH_STATUS_MISMATCH/);
  await rejectsWith(run(fixture, {
    fetch: { healthBody: JSON.stringify({ name: 'unexpected', version: 'v2.test' }) }
  }), /UNLOCKED_STAGING_SUPABASE_HEALTH_INVALID/);
  await rejectsWith(run(fixture, {
    fetch: { statuses: { '/login.html': 500 } }
  }), /UNLOCKED_STAGING_HTML_STATUS_MISMATCH/);
  await rejectsWith(run(fixture, {
    fetch: { statuses: { '/login.html': 302 } }
  }), /UNLOCKED_STAGING_HTML_STATUS_MISMATCH/);
  await rejectsWith(run(fixture, {
    fetch: { headerChanges: { '/login.html': { 'X-Robots-Tag': '' } } }
  }), /UNLOCKED_STAGING_ROBOTS_POLICY_INVALID/);
  await rejectsWith(run(fixture, {
    fetch: { headerChanges: { '/login.html': { 'Strict-Transport-Security': 'max-age=60' } } }
  }), /UNLOCKED_STAGING_HSTS_INVALID/);
  await rejectsWith(run(fixture, {
    fetch: { headerChanges: { '/login.html': { 'X-Frame-Options': 'DENY' } } }
  }), /X-Frame-Options=SAMEORIGIN/);
  await rejectsWith(run(fixture, {
    fetch: { headerChanges: { '/login.html': { 'Content-Security-Policy': 'frame-ancestors *' } } }
  }), /frame-ancestors must allow only 'self'/);
  await rejectsWith(run(fixture, {
    fetch: {
      headerChanges: {
        '/login.html': {
          'Content-Security-Policy': "default-src *; script-src * 'unsafe-inline' 'unsafe-eval'; connect-src *; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'"
        }
      }
    }
  }), /UNLOCKED_STAGING_CSP_INVALID/);
  await rejectsWith(run(fixture, {
    fetch: {
      headerChanges: {
        '/login.html': {
          'Content-Security-Policy': `${secureHeaders()['Content-Security-Policy']}; default-src *`
        }
      }
    }
  }), /UNLOCKED_STAGING_CSP_INVALID/);
  await rejectsWith(run(fixture, {
    fetch: {
      headerChanges: {
        '/login.html': {
          'Content-Security-Policy': secureHeaders()['Content-Security-Policy'].replace(
            "connect-src 'self'",
            "connect-src 'self' https://evil.example"
          )
        }
      }
    }
  }), /UNLOCKED_STAGING_CSP_INVALID/);
  await rejectsWith(run(fixture, {
    fetch: { headerChanges: { '/login.html': { 'Cache-Control': 'public, max-age=3600' } } }
  }), /UNLOCKED_STAGING_CACHE_POLICY_INVALID/);
  await rejectsWith(run(fixture, {
    fetch: { headerChanges: { '/login.html': { 'X-Content-Type-Options': '' } } }
  }), /UNLOCKED_STAGING_NOSNIFF_MISSING/);
  await rejectsWith(run(fixture, {
    fetch: { headerChanges: { '/login.html': { 'Referrer-Policy': 'origin' } } }
  }), /UNLOCKED_STAGING_REFERRER_POLICY_INVALID/);
  await rejectsWith(run(fixture, {
    fetch: { headerChanges: { '/login.html': { 'Content-Type': 'application/json' } } }
  }), /UNLOCKED_STAGING_HTML_CONTENT_TYPE_INVALID/);
  await rejectsWith(run(fixture, {
    fetch: { statuses: { '/package.json': 200 } }
  }), /UNLOCKED_STAGING_FORBIDDEN_PATH_PRESENT/);
  await rejectsWith(run(fixture, {
    env: { UNLOCKED_STAGING_EVIDENCE_PATH: 'dist/evidence.json' }
  }), /UNLOCKED_STAGING_EVIDENCE_PATH_PUBLIC/);

  const wrongClass = makeFixture({
    deployTransform: value => ({ ...value, build: { ...value.build, deploymentClass: 'production' } })
  });
  fixtures.push(wrongClass);
  await rejectsWith(run(wrongClass), /UNLOCKED_STAGING_DEPLOY_MANIFEST_CLASS_MISMATCH/);

  const tamperedLocalApp = makeFixture();
  fixtures.push(tamperedLocalApp);
  fs.appendFileSync(path.join(tamperedLocalApp.dist, 'app.js'), '\n// tampered\n');
  await rejectsWith(run(tamperedLocalApp), /UNLOCKED_STAGING_LOCAL_FILE_INTEGRITY_MISMATCH/);

  const selfConsistentTamperedApp = makeFixture({
    fileTransform: files => files.set('app.js', Buffer.from('self-consistent but not from Git'))
  });
  fixtures.push(selfConsistentTamperedApp);
  await rejectsWith(
    run(selfConsistentTamperedApp),
    /UNLOCKED_STAGING_SOURCE_DERIVED_FILE_MISMATCH/
  );

  const selfConsistentTamperedBrand = makeFixture({
    fileTransform: files => files.set('brand-config.js', Buffer.from('forged brand config'))
  });
  fixtures.push(selfConsistentTamperedBrand);
  await rejectsWith(
    run(selfConsistentTamperedBrand),
    /UNLOCKED_STAGING_SOURCE_DERIVED_FILE_MISMATCH/
  );

  const omittedOptionalSourceFile = makeFixture({ omittedArtifactFiles: ['quality.html'] });
  fixtures.push(omittedOptionalSourceFile);
  await rejectsWith(
    run(omittedOptionalSourceFile),
    /UNLOCKED_STAGING_SOURCE_DERIVED_FILESET_MISMATCH/
  );

  const extraLocalFile = makeFixture();
  fixtures.push(extraLocalFile);
  fs.writeFileSync(path.join(extraLocalFile.dist, 'debug.html'), '<!doctype html><html>debug</html>');
  await rejectsWith(run(extraLocalFile), /UNLOCKED_STAGING_DIST_FILESET_MISMATCH/);

  const missingAck = makeFixture({
    deployTransform: value => ({
      ...value,
      safety: { ...value.safety, stagingDatabaseExplicitlyAcknowledged: false }
    })
  });
  fixtures.push(missingAck);
  await rejectsWith(run(missingAck), /UNLOCKED_STAGING_DEPLOY_MANIFEST_UNLOCK_STATE_INVALID/);

  const wrongTree = makeFixture({
    deployTransform: value => ({ ...value, source: { ...value.source, tree: 'c'.repeat(40) } })
  });
  fixtures.push(wrongTree);
  await rejectsWith(run(wrongTree), /UNLOCKED_STAGING_DEPLOY_MANIFEST_SOURCE_MISMATCH/);

  const wrongManifestTenant = makeFixture({
    deployTransform: value => ({
      ...value,
      tenant: { ...value.tenant, expectedClinicCode: 'OTHER-STG' }
    })
  });
  fixtures.push(wrongManifestTenant);
  await rejectsWith(run(wrongManifestTenant), /UNLOCKED_STAGING_DEPLOY_MANIFEST_TENANT_MISMATCH/);

  const invalidRuntimeName = makeFixture({
    runtimeTransform: value => ({
      ...value,
      fileCount: value.fileCount + 1,
      files: [...value.files, '../private.html'].sort(),
      integrity: [...value.integrity, {
        path: '../private.html',
        size: 1,
        sha256: 'f'.repeat(64)
      }].sort((left, right) => left.path.localeCompare(right.path))
    })
  });
  fixtures.push(invalidRuntimeName);
  await rejectsWith(run(invalidRuntimeName), /UNLOCKED_STAGING_RUNTIME_FILENAME_INVALID/);

  const missingRequiredRuntime = makeFixture({
    runtimeTransform: value => ({
      ...value,
      fileCount: value.fileCount - 1,
      files: value.files.filter(name => name !== 'owner-control.html'),
      integrity: value.integrity.filter(entry => entry.path !== 'owner-control.html')
    })
  });
  fixtures.push(missingRequiredRuntime);
  await rejectsWith(run(missingRequiredRuntime), /UNLOCKED_STAGING_RUNTIME_REQUIRED_FILE_MISSING/);

  const unsortedRuntime = makeFixture({
    runtimeTransform: value => ({ ...value, files: [...value.files].reverse() })
  });
  fixtures.push(unsortedRuntime);
  await rejectsWith(run(unsortedRuntime), /UNLOCKED_STAGING_RUNTIME_FILESET_INVALID/);

  const lockedTenant = makeFixture({
    tenantTransform: value => ({
      ...value,
      database: { provider: 'supabase', url: '', publishableKey: '' },
      safety: { previewLocked: true }
    })
  });
  fixtures.push(lockedTenant);
  await rejectsWith(run(lockedTenant), /UNLOCKED_STAGING_LOCAL_TENANT_CONFIG_MISMATCH/);
} finally {
  for (const fixture of fixtures) fs.rmSync(fixture.cwd, { recursive: true, force: true });
}

console.log('Unlocked CNYOS staging deployment verifier contracts passed: exact artifact, identity, headers, health and non-authorization');
