import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DATABASE_CAPABILITIES,
  EXPECTED_DATABASE_CAPABILITIES,
  EXPECTED_WORKSPACES,
  STAGING_ROLES,
  WORKSPACE_ROUTES,
  loadStagingTarget
} from '../scripts/staging-support.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const staging = JSON.parse(read('config/tenant.staging.example.json'));
const production = JSON.parse(read('config/tenant.chananya.json'));
const baseEnv = {
  CLINICAL_OS_STAGING_ACK: 'STAGING_ONLY',
  CLINICAL_OS_STAGING_CONFIG_JSON: JSON.stringify(staging),
  CLINICAL_OS_PRODUCTION_CONFIG_JSON: JSON.stringify(production),
  STAGING_SITE_URL: staging.auth.redirectOrigin
};

const target = loadStagingTarget({ env: baseEnv, cwd: root });
assert.equal(target.config.deploymentId, 'chananya-clinical-staging');
assert.notEqual(target.config.database.url, production.database.url);
assert.notEqual(target.config.tenant.expectedClinicCode, production.tenant.expectedClinicCode);
assert.notEqual(target.config.tenant.expectedClinicId, production.tenant.expectedClinicId);
assert.notEqual(target.config.identity.qrIssuer, production.identity.qrIssuer);

assert.throws(
  () => loadStagingTarget({
    env: {
      ...baseEnv,
      CLINICAL_OS_STAGING_CONFIG_JSON: JSON.stringify({
        ...staging,
        tenant: { ...staging.tenant, expectedClinicId: production.tenant.expectedClinicId }
      })
    },
    cwd: root
  }),
  /clinic UUID/
);
assert.throws(
  () => loadStagingTarget({ env: { ...baseEnv, CLINICAL_OS_STAGING_ACK: '' }, cwd: root }),
  /STAGING_ONLY/
);
assert.throws(
  () => loadStagingTarget({
    env: {
      CLINICAL_OS_STAGING_ACK: 'STAGING_ONLY',
      CLINICAL_OS_STAGING_CONFIG_JSON: JSON.stringify(staging),
      STAGING_SITE_URL: staging.auth.redirectOrigin
    },
    cwd: root
  }),
  /Production config denylist/
);
assert.throws(
  () => loadStagingTarget({
    env: {
      ...baseEnv,
      CLINICAL_OS_STAGING_CONFIG_JSON: JSON.stringify({
        ...staging,
        database: production.database
      })
    },
    cwd: root
  }),
  /Production Supabase project/
);
assert.throws(
  () => loadStagingTarget({ env: { ...baseEnv, STAGING_SITE_URL: production.auth.redirectOrigin }, cwd: root }),
  /Production site|exactly match/
);
assert.throws(
  () => loadStagingTarget({
    env: {
      ...baseEnv,
      CLINICAL_OS_STAGING_CONFIG_JSON: JSON.stringify({ ...staging, deploymentId: 'chananya-clinical-production' })
    },
    cwd: root
  }),
  /deploymentId/
);

assert.deepEqual(Object.keys(EXPECTED_DATABASE_CAPABILITIES), STAGING_ROLES);
assert.deepEqual(Object.keys(EXPECTED_WORKSPACES), STAGING_ROLES);
assert.ok(DATABASE_CAPABILITIES.includes('quality'));
assert.ok(DATABASE_CAPABILITIES.includes('billing'));
assert.equal(EXPECTED_WORKSPACES.super_admin.length, Object.keys(WORKSPACE_ROUTES).length);
for (const role of STAGING_ROLES.filter(role => role !== 'super_admin')) {
  assert.ok(EXPECTED_WORKSPACES[role].length < Object.keys(WORKSPACE_ROUTES).length, `${role} must not receive every workspace`);
}

for (const file of [
  'scripts/staging-support.mjs',
  'scripts/provision-staging-users.mjs',
  'scripts/verify-authenticated-staging.mjs',
  'scripts/run-staging-synthetic-uat.mjs'
]) {
  const source = read(file);
  assert.doesNotMatch(source, /qptxnrldzzinlcabudjv|sb_secret_[A-Za-z0-9_-]{10,}|service_role\s*[:=]\s*['"][A-Za-z0-9_.-]{10,}/i, `${file} must not contain Production or secret literals`);
}

const verifier = read('scripts/verify-authenticated-staging.mjs');
assert.match(verifier, /current_access_context/);
assert.match(verifier, /department_can/);
assert.match(verifier, /STAGING_BROWSER_E2E/);
assert.match(verifier, /ไม่มีสิทธิ์/);
const uat = read('scripts/run-staging-synthetic-uat.mjs');
assert.match(uat, /Exactly ten synthetic staging flows must pass/);
assert.match(uat, /PHARMACY_DEPARTMENT_REQUIRED/);
assert.match(uat, /record_atomic_invoice_payment/);
assert.match(uat, /FEFO/);
const workflow = read('.github/workflows/authenticated-staging-e2e.yml');
assert.match(workflow, /workflow_dispatch:/);
assert.doesNotMatch(workflow, /pull_request:|push:/, 'credentialed staging must run manually, never on an untrusted PR or push');
assert.match(workflow, /environment: staging/);
assert.match(workflow, /CLINICAL_OS_PRODUCTION_CONFIG_JSON/);
assert.match(workflow, /STAGING_SYNTHETIC_UAT_ACK: CREATE_SYNTHETIC_RECORDS/);

console.log('Staging safety contracts passed: Production rejection, 11 roles, browser matrix and 10 synthetic audited flows');
