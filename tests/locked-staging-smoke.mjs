import assert from 'node:assert/strict';
import {
  parseTenantConfig,
  verifyLockedStaging
} from '../scripts/verify-locked-staging.mjs';

const siteUrl = 'https://clinic-staging.example.test';
const sourceCommit = 'a'.repeat(40);
const config = {
  schemaVersion: 1,
  deploymentId: 'clinic-staging',
  tenant: {
    expectedClinicId: '10000000-0000-4000-8000-000000000002',
    expectedClinicCode: 'CLINIC-STG'
  },
  database: { provider: 'supabase', url: '', publishableKey: '' },
  auth: { redirectOrigin: siteUrl },
  identity: { qrIssuer: 'CLINIC-STG' },
  safety: { previewLocked: true }
};
const manifest = {
  schemaVersion: 1,
  deploymentId: config.deploymentId,
  tenant: config.tenant,
  identity: config.identity,
  source: { commit: sourceCommit, tree: null, verified: true },
  build: {
    context: 'production',
    deploymentClass: 'dedicated-staging',
    timestamp: '2026-08-28T00:00:00.000Z'
  },
  safety: {
    previewLocked: true,
    databaseLocked: true,
    stagingDatabaseExplicitlyAcknowledged: false
  }
};
const tenantScript = `window.CLINICAL_OS_CONFIG = Object.freeze(${JSON.stringify(config)});\n`;
const routePaths = new Set([
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

function response(body, extraHeaders = {}, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Content-Security-Policy': "default-src 'self'; frame-ancestors 'self'; object-src 'none'",
      ...extraHeaders
    }
  });
}

function mockFetch({
  tenant = config,
  deployManifest = manifest,
  failedRoute = ''
} = {}) {
  return async input => {
    const pathName = new URL(input).pathname;
    if (pathName === '/tenant-config.js') {
      return response(
        `window.CLINICAL_OS_CONFIG = Object.freeze(${JSON.stringify(tenant)});\n`,
        { 'Cache-Control': 'no-store, max-age=0' }
      );
    }
    if (pathName === '/deploy-manifest.json') {
      return response(
        JSON.stringify(deployManifest),
        { 'Cache-Control': 'no-store, max-age=0' }
      );
    }
    if (routePaths.has(pathName)) {
      return response(
        '<!doctype html><title>staging</title>',
        pathName === '/ui-review.html' ? { 'X-Robots-Tag': 'noindex, nofollow' } : {},
        pathName === failedRoute ? 500 : 200
      );
    }
    return response('not found', {}, 404);
  };
}

assert.equal(parseTenantConfig(tenantScript).deploymentId, 'clinic-staging');
const passed = await verifyLockedStaging({
  siteUrl,
  fetchImpl: mockFetch(),
  expectedSourceCommit: sourceCommit,
  productionConfig: {
    tenant: {
      expectedClinicId: '00000000-0000-0000-0000-000000000001',
      expectedClinicCode: 'CLINIC'
    },
    identity: { qrIssuer: 'CLINIC' }
  }
});
assert.equal(passed.databaseLocked, true);
assert.equal(passed.routes.length, 11);
assert.equal(passed.sourceCommit, sourceCommit);

let redirectRequestOptions;
await assert.rejects(
  verifyLockedStaging({
    siteUrl,
    fetchImpl: async (_input, options) => {
      redirectRequestOptions = options;
      return response('', { Location: 'https://attacker.example/tenant-config.js' }, 302);
    }
  }),
  /tenant-config\.js must return HTTP 200/
);
assert.equal(
  redirectRequestOptions.redirect,
  'error',
  'locked staging verification must not follow a cross-origin redirect'
);

await assert.rejects(
  verifyLockedStaging({
    siteUrl,
    fetchImpl: mockFetch({
      tenant: {
        ...config,
        database: {
          provider: 'supabase',
          url: 'https://forbidden-staging.supabase.co',
          publishableKey: 'sb_publishable_forbidden'
        }
      }
    })
  }),
  /database URL must be empty/
);
await assert.rejects(
  verifyLockedStaging({
    siteUrl,
    fetchImpl: mockFetch(),
    expectedSourceCommit: 'b'.repeat(40)
  }),
  /source commit must match/
);
for (const [label, deployManifest, expectedError] of [
  [
    'missing deployment class',
    { ...manifest, build: { context: manifest.build.context, timestamp: manifest.build.timestamp } },
    /deploymentClass must be dedicated-staging/
  ],
  [
    'production deployment class',
    { ...manifest, build: { ...manifest.build, deploymentClass: 'production' } },
    /deploymentClass must be dedicated-staging/
  ],
  [
    'missing staging acknowledgement marker',
    {
      ...manifest,
      safety: { previewLocked: manifest.safety.previewLocked, databaseLocked: manifest.safety.databaseLocked }
    },
    /stagingDatabaseExplicitlyAcknowledged=false/
  ],
  [
    'staging acknowledgement enabled',
    { ...manifest, safety: { ...manifest.safety, stagingDatabaseExplicitlyAcknowledged: true } },
    /stagingDatabaseExplicitlyAcknowledged=false/
  ]
]) {
  await assert.rejects(
    verifyLockedStaging({ siteUrl, fetchImpl: mockFetch({ deployManifest }) }),
    expectedError,
    `${label} must fail closed`
  );
}
await assert.rejects(
  verifyLockedStaging({
    siteUrl,
    fetchImpl: mockFetch({ failedRoute: '/pharmacy.html' })
  }),
  /pharmacy\.html must return HTTP 200/
);
await assert.rejects(
  verifyLockedStaging({
    siteUrl: 'https://clinic.example.test',
    fetchImpl: mockFetch()
  }),
  /non-production marker or be explicitly acknowledged/
);

const cnyosSiteUrl = 'https://cnyos.netlify.app';
const cnyosConfig = {
  ...config,
  auth: { redirectOrigin: cnyosSiteUrl }
};

await assert.rejects(
  verifyLockedStaging({
    siteUrl: cnyosSiteUrl,
    fetchImpl: mockFetch({ tenant: cnyosConfig })
  }),
  /non-production marker or be explicitly acknowledged/
);

const acknowledgedCnyos = await verifyLockedStaging({
  siteUrl: cnyosSiteUrl,
  fetchImpl: mockFetch({ tenant: cnyosConfig }),
  stagingHostnameAllowlist: ['cnyos.netlify.app']
});
assert.equal(acknowledgedCnyos.siteUrl, cnyosSiteUrl);

await assert.rejects(
  verifyLockedStaging({
    siteUrl: cnyosSiteUrl,
    fetchImpl: mockFetch({ tenant: cnyosConfig }),
    stagingHostnameAllowlist: ['other.netlify.app']
  }),
  /non-production marker or be explicitly acknowledged/
);

await assert.rejects(
  verifyLockedStaging({
    siteUrl: cnyosSiteUrl,
    fetchImpl: mockFetch({ tenant: cnyosConfig }),
    stagingHostnameAllowlist: ['*.netlify.app']
  }),
  /exact lowercase netlify\.app hostnames without wildcards/
);

await assert.rejects(
  verifyLockedStaging({
    siteUrl: cnyosSiteUrl,
    fetchImpl: mockFetch({ tenant: cnyosConfig }),
    stagingHostnameAllowlist: ['CNYOS.netlify.app']
  }),
  /must be lowercase/
);

console.log('Locked staging smoke contracts passed: provenance, database lock, security headers and 11 routes');
