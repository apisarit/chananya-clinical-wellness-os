import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
const packageJson = JSON.parse(read('package.json'));
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
  /clinic UUID|version 4 UUID/
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
const lineWorkflow = read('.github/workflows/line-staging-e2e.yml');
assert.match(workflow, /workflow_dispatch:/);
assert.doesNotMatch(
  workflow,
  /pull_request:|push:/,
  'candidate evidence remains a fresh, deliberate manual run'
);
assert.doesNotMatch(
  workflow,
  /environment:|\$\{\{\s*secrets\.|NETLIFY_AUTH_TOKEN|STAGING_SUPABASE_SERVICE_ROLE_KEY|STAGING_TEST_PASSWORD|CLINICAL_OS_(?:STAGING|PRODUCTION)_CONFIG_JSON/,
  'a candidate-controlled workflow must never receive protected credentials or an Environment'
);
for (const [filename, source] of [
  ['.github/workflows/authenticated-staging-e2e.yml', workflow],
  ['.github/workflows/line-staging-e2e.yml', lineWorkflow]
]) {
  assert.doesNotMatch(
    source,
    /environment:|\$\{\{\s*secrets\.|NETLIFY_AUTH_TOKEN|STAGING_SUPABASE_SERVICE_ROLE_KEY|STAGING_TEST_PASSWORD|STAGING_LINE_ID_TOKEN|CLINICAL_OS_(?:STAGING|PRODUCTION)_CONFIG_JSON/,
    `${filename} must not expose a protected Environment or credential to candidate-controlled code`
  );
  assert.doesNotMatch(
    source,
    /netlify\s+deploy|--prod|staging:(?:provision|verify|uat|line)|DEPLOY_CNYOS_STAGING/,
    `${filename} must not publish or mutate staging`
  );
}
assert.doesNotMatch(
  workflow,
  /netlify\s+deploy|--prod|staging:(?:provision|verify|uat)|DEPLOY_CNYOS_STAGING/,
  'a candidate-controlled workflow must never publish or mutate staging'
);
assert.match(workflow, /persist-credentials: false/);
assert.match(workflow, /group: cnyos-staging-candidate-/);
assert.match(workflow, /GITHUB_RUN_ATTEMPT" = "1"/);
assert.match(workflow, /GITHUB_TRIGGERING_ACTOR" = "\$GITHUB_ACTOR"/);
assert.match(workflow, /npm run build:staging-artifact/);
assert.match(workflow, /CLINICAL_OS_TENANT_CONFIG_PATH: config\/tenant\.cnyos-staging\.json/);
assert.doesNotMatch(workflow, /CLINICAL_OS_ALLOW_STAGING_DATABASE|CLINICAL_OS_STAGING_DATABASE_ACK/);
assert.match(workflow, /CLINICAL_OS_SOURCE_TREE=.*HEAD\^\{tree\}/);
assert.match(workflow, /CLINICAL_OS_BUILD_TIMESTAMP=.*git show -s --format=%cI HEAD/);
assert.match(workflow, /CNYOS_STAGING_FUNCTION_SOURCE_TREE=.*HEAD:netlify\/functions/);
assert.match(workflow, /materialize-staging-functions\.mjs/);
assert.match(workflow, /git diff --exit-code/);
assert.match(workflow, /uses: actions\/upload-artifact@v6/);
assert.match(workflow, /if-no-files-found: error/);
assert.match(workflow, /artifact-digest/);
assert.match(lineWorkflow, /protected-controller handoff/);
assert.match(lineWorkflow, /disabled in this candidate-controlled repository/);
assert.match(lineWorkflow, /exit 1/);
assert.doesNotMatch(lineWorkflow, /actions\/checkout|npm\s+(?:ci|run)/);
const unlockedVerifier = read('scripts/verify-unlocked-staging-deployment.mjs');
assert.match(unlockedVerifier, /verifyNetlifyScheduledReleaseGate/);
assert.match(unlockedVerifier, /\/files`/);
assert.match(unlockedVerifier, /EXPECTED_STAGING_NETLIFY_DEPLOY_ID/);
assert.match(unlockedVerifier, /FILE_INVENTORY_CHANGED_DURING_VERIFICATION/);

for (const [scriptName, filename] of [
  ['staging:smoke:unlocked', 'scripts/verify-unlocked-staging-deployment.mjs'],
  ['verify:backup-release-gate', 'scripts/verify-netlify-scheduled-release-gate.mjs'],
  ['staging:authorize-release', 'scripts/verify-staging-release-authorization.mjs']
]) {
  assert.equal(
    packageJson.scripts[scriptName],
    undefined,
    `${scriptName} must not expose a candidate-owned credentialed command`
  );
  const directRun = spawnSync(process.execPath, [path.join(root, filename)], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH || '',
      NETLIFY_AUTH_TOKEN: 'synthetic-token-that-must-not-be-read',
      CNYOS_STAGING_NETLIFY_AUTH_TOKEN: 'synthetic-token-that-must-not-be-read'
    }
  });
  assert.equal(directRun.status, 1, `${filename} must fail closed when invoked directly`);
  assert.equal(directRun.stdout, '', `${filename} must not emit evidence when invoked directly`);
  assert.match(directRun.stderr, /CANDIDATE_SPEC_ONLY/);
  assert.match(directRun.stderr, /no credential was read/);
  assert.doesNotMatch(directRun.stderr, /synthetic-token/);
}

assert.equal(
  fs.existsSync(path.join(root, 'scripts/netlify-staging-deploy-evidence.mjs')),
  false,
  'candidate-owned code must not contain a credentialed Netlify publisher or rollback helper'
);

const releaseAuthorization = read('scripts/verify-staging-release-authorization.mjs');
assert.match(releaseAuthorization, /CNYOS_STAGING_RELEASE_APPROVER_KEY_REGISTRY_JSON/);
assert.doesNotMatch(releaseAuthorization, /config\/cnyos-staging-release-approver-keys\.json/);
assert.match(releaseAuthorization, /CNYOS_STAGING_RELEASE_ACTOR_NOT_NAMED_RISK_OWNER/);

console.log('Staging safety contracts passed: Production rejection, offline candidate isolation, 11 roles and 10 synthetic flow definitions');
