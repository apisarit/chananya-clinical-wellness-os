import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inspectPreflightInputs,
  verifyAuthenticatedStagingPreflight
} from '../scripts/verify-authenticated-staging-preflight.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const staging = readJson('config/tenant.staging.example.json');
const production = readJson('config/tenant.chananya.json');
const sourceCommit = 'a'.repeat(40);
const serviceRoleKey = `sb_secret_${'z'.repeat(32)}`;
const baseEnv = {
  CLINICAL_OS_STAGING_ACK: 'STAGING_ONLY',
  CLINICAL_OS_STAGING_CONFIG_JSON: JSON.stringify(staging),
  CLINICAL_OS_PRODUCTION_CONFIG_JSON: JSON.stringify(production),
  STAGING_SITE_URL: staging.auth.redirectOrigin,
  STAGING_SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
  STAGING_TEST_PASSWORD: 'synthetic-only-password-2026',
  STAGING_TEST_EMAIL_DOMAIN: 'staging.example.test',
  EXPECTED_STAGING_SOURCE_COMMIT: sourceCommit
};

function publicHeaders() {
  return {
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  };
}

function response(body, status = 200, headers = {}) {
  return new Response(body, { status, headers });
}

function tenantScript(config) {
  return `window.CLINICAL_OS_CONFIG = Object.freeze(${JSON.stringify(config)});\n`;
}

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    deploymentId: staging.deploymentId,
    tenant: staging.tenant,
    identity: staging.identity,
    source: { commit: sourceCommit, tree: null, verified: true },
    build: { context: 'production', timestamp: '2026-08-29T00:00:00.000Z' },
    safety: { previewLocked: false, databaseLocked: false },
    ...overrides
  };
}

function mockFetch({
  remoteConfig = { ...staging, safety: { previewLocked: false } },
  remoteManifest = manifest(),
  serviceStatus = 200
} = {}) {
  return async input => {
    const url = new URL(input);
    if (url.origin === staging.auth.redirectOrigin && url.pathname === '/tenant-config.js') {
      return response(tenantScript(remoteConfig), 200, publicHeaders());
    }
    if (url.origin === staging.auth.redirectOrigin && url.pathname === '/deploy-manifest.json') {
      return response(JSON.stringify(remoteManifest), 200, publicHeaders());
    }
    if (url.origin === new URL(staging.database.url).origin && url.pathname === '/auth/v1/admin/users') {
      return response(
        serviceStatus === 200 ? JSON.stringify({ users: [] }) : JSON.stringify({ message: 'unauthorized' }),
        serviceStatus,
        { 'Content-Type': 'application/json' }
      );
    }
    return response('not found', 404);
  };
}

const inputs = inspectPreflightInputs(baseEnv);
assert.equal(Object.keys(inputs).length, 7);
assert.ok(Object.values(inputs).every(Boolean));
assert.doesNotMatch(JSON.stringify(inputs), /sb_secret_|synthetic-only-password/);

const passed = await verifyAuthenticatedStagingPreflight({
  env: baseEnv,
  cwd: root,
  fetchImpl: mockFetch()
});
assert.equal(passed.status, 'passed');
assert.equal(passed.readOnly, true);
assert.equal(passed.remoteDeployment.databaseLocked, false);
assert.equal(passed.serviceRoleProbe.authenticated, true);
assert.equal(passed.databaseProjectRef, 'replace-with-staging-project');
assert.doesNotMatch(JSON.stringify(passed), /sb_secret_|synthetic-only-password|sb_publishable_/);

await assert.rejects(
  verifyAuthenticatedStagingPreflight({
    env: { ...baseEnv, STAGING_SUPABASE_SERVICE_ROLE_KEY: '' },
    cwd: root,
    fetchImpl: mockFetch()
  }),
  /stagingServiceRoleKey/
);

await assert.rejects(
  verifyAuthenticatedStagingPreflight({
    env: {
      ...baseEnv,
      CLINICAL_OS_STAGING_CONFIG_JSON: JSON.stringify({ ...staging, database: production.database })
    },
    cwd: root,
    fetchImpl: mockFetch()
  }),
  /Production Supabase project/
);

await assert.rejects(
  verifyAuthenticatedStagingPreflight({
    env: baseEnv,
    cwd: root,
    fetchImpl: mockFetch({
      remoteManifest: manifest({ safety: { previewLocked: true, databaseLocked: true } })
    })
  }),
  /previewLocked=true|databaseLocked=true/
);

await assert.rejects(
  verifyAuthenticatedStagingPreflight({
    env: baseEnv,
    cwd: root,
    fetchImpl: mockFetch({
      remoteManifest: manifest({ source: { commit: 'b'.repeat(40), tree: null, verified: true } })
    })
  }),
  /exact release candidate/
);

await assert.rejects(
  verifyAuthenticatedStagingPreflight({
    env: baseEnv,
    cwd: root,
    fetchImpl: mockFetch({
      remoteConfig: {
        ...staging,
        database: { ...staging.database, url: 'https://other-staging-project.supabase.co' },
        safety: { previewLocked: false }
      }
    })
  }),
  /Supabase origin mismatch/
);

await assert.rejects(
  verifyAuthenticatedStagingPreflight({
    env: baseEnv,
    cwd: root,
    fetchImpl: mockFetch({ serviceStatus: 401 })
  }),
  /service-role probe returned HTTP 401/
);

const workflow = fs.readFileSync(path.join(root, '.github/workflows/authenticated-staging-e2e.yml'), 'utf8');
assert.match(workflow, /npm run staging:preflight[\s\S]*npm run staging:provision/);

console.log('Authenticated staging preflight contracts passed: read-only isolation, exact deploy and credential binding');
