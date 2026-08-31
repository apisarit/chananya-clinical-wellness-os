import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  buildDeployManifest,
  loadTenantConfig,
  renderBrandConfig,
  renderDeployManifest,
  renderTenantConfig,
  validateTenantConfig
} from '../scripts/generate-tenant-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const example = JSON.parse(read('config/tenant.example.json'));
const chananya = JSON.parse(read('config/tenant.chananya.json'));

const customer = validateTenantConfig(example);
assert.equal(customer.tenant.expectedClinicCode, 'CUSTOMER');
assert.equal(customer.brand.shortName, 'CUSTOMER CLINIC');
assert.equal(customer.brand.browserTitle, 'CUSTOMER CLINIC OS');
assert.match(customer.database.url, /^https:\/\//);
assert.match(renderTenantConfig(customer), /window\.CLINICAL_OS_CONFIG = Object\.freeze/);
assert.doesNotMatch(renderBrandConfig(customer), /"database"|publishableKey|supabase\.co/i);

assert.throws(
  () => validateTenantConfig({ ...example, database: { ...example.database, publishableKey: 'sb_secret_forbidden' } }),
  /must never contain a service-role or secret key/
);
const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const serviceJwt = `${encoded({ alg: 'HS256', typ: 'JWT' })}.${encoded({ role: 'service_role' })}.signature`;
assert.throws(
  () => validateTenantConfig({ ...example, database: { ...example.database, publishableKey: serviceJwt } }),
  /role=anon/
);
assert.throws(
  () => validateTenantConfig({ ...example, database: { ...example.database, url: 'http://customer.invalid' } }),
  /must use HTTPS/
);
assert.throws(
  () => validateTenantConfig({ ...example, auth: { redirectOrigin: 'https://customer.example.com/callback' } }),
  /must be an HTTPS origin/
);
assert.throws(
  () => validateTenantConfig({ ...example, tenant: { ...example.tenant, expectedClinicCode: 'bad code' } }),
  /expectedClinicCode/
);
assert.throws(
  () => validateTenantConfig({ ...example, brand: { ...example.brand, browserTitle: 'x'.repeat(81) } }),
  /brand\.browserTitle/
);

const generated = read('tenant-config.js');
const validatedDefault = validateTenantConfig(chananya);
assert.equal(generated, renderTenantConfig(validatedDefault), 'checked-in browser config must match the validated customer source');
assert.doesNotMatch(generated, /service[_-]?role|sb_secret_/i, 'public tenant config must not contain server secrets');
const lockedPreview = loadTenantConfig({ env: { CONTEXT: 'deploy-preview', DEPLOY_PRIME_URL: 'https://deploy-preview-7.example.net' }, cwd: root });
assert.equal(lockedPreview.safety.previewLocked, true);
assert.equal(lockedPreview.database.url, '');
assert.equal(lockedPreview.database.publishableKey, '');
assert.throws(
  () => loadTenantConfig({ env: { CONTEXT: 'deploy-preview', CLINICAL_OS_ALLOW_PREVIEW_DATABASE: 'true' }, cwd: root }),
  /explicit staging config/
);
const stagingExample = {
  ...example,
  deploymentId: 'customer-clinic-staging',
  tenant: {
    ...example.tenant,
    expectedClinicId: '10000000-0000-0000-0000-000000000002',
    expectedClinicCode: 'CUSTOMER-STG'
  },
  database: { ...example.database, url: 'https://customer-staging-project.supabase.co' },
  auth: { redirectOrigin: 'https://deploy-preview-7.example.net' },
  identity: { qrIssuer: 'CUSTOMER-STG' }
};
const stagingPreview = loadTenantConfig({
  env: {
    CONTEXT: 'deploy-preview',
    DEPLOY_PRIME_URL: 'https://deploy-preview-7.example.net',
    CLINICAL_OS_ALLOW_PREVIEW_DATABASE: 'true',
    CLINICAL_OS_PREVIEW_DATABASE_ACK: 'STAGING_ONLY',
    CLINICAL_OS_PRODUCTION_CONFIG_JSON: JSON.stringify(chananya),
    CLINICAL_OS_TENANT_CONFIG_JSON: JSON.stringify(stagingExample)
  },
  cwd: root
});
assert.equal(stagingPreview.safety.previewLocked, false);
assert.match(stagingPreview.database.url, /^https:/);
assert.equal(stagingPreview.auth.redirectOrigin, 'https://deploy-preview-7.example.net');
const lockedDedicatedStaging = loadTenantConfig({
  env: {
    CONTEXT: 'production',
    URL: 'https://customer-clinical-staging.example.net',
    CLINICAL_OS_STAGING_DEPLOYMENT: 'true',
    CLINICAL_OS_TENANT_CONFIG_JSON: JSON.stringify({
      ...stagingExample,
      auth: { redirectOrigin: 'https://customer-clinical-staging.example.net' }
    })
  },
  cwd: root
});
assert.equal(lockedDedicatedStaging.safety.previewLocked, true);
assert.equal(lockedDedicatedStaging.database.url, '');
const enabledDedicatedStaging = loadTenantConfig({
  env: {
    CONTEXT: 'production',
    URL: 'https://customer-clinical-staging.example.net',
    CLINICAL_OS_STAGING_DEPLOYMENT: 'true',
    CLINICAL_OS_ALLOW_STAGING_DATABASE: 'true',
    CLINICAL_OS_STAGING_DATABASE_ACK: 'STAGING_ONLY',
    CLINICAL_OS_PRODUCTION_CONFIG_JSON: JSON.stringify(chananya),
    CLINICAL_OS_TENANT_CONFIG_JSON: JSON.stringify({
      ...stagingExample,
      auth: { redirectOrigin: 'https://customer-clinical-staging.example.net' }
    })
  },
  cwd: root
});
assert.equal(enabledDedicatedStaging.safety.previewLocked, false);
assert.equal(enabledDedicatedStaging.auth.redirectOrigin, 'https://customer-clinical-staging.example.net');
const deployManifest = buildDeployManifest(
  lockedDedicatedStaging,
  {
    CONTEXT: 'production',
    CLINICAL_OS_SOURCE_COMMIT: 'a'.repeat(40),
    CLINICAL_OS_SOURCE_TREE: 'b'.repeat(40),
    CLINICAL_OS_REQUIRE_SOURCE_COMMIT: 'true'
  },
  new Date('2026-08-28T00:00:00.000Z')
);
assert.equal(deployManifest.source.verified, true);
assert.equal(deployManifest.source.commit, 'a'.repeat(40));
assert.equal(deployManifest.safety.databaseLocked, true);
assert.match(renderDeployManifest(deployManifest), /"databaseLocked": true/);
assert.throws(
  () => buildDeployManifest(lockedDedicatedStaging, { CLINICAL_OS_REQUIRE_SOURCE_COMMIT: 'true' }),
  /requires an explicit source commit/
);
assert.throws(
  () => loadTenantConfig({
    env: {
      CONTEXT: 'production',
      URL: 'https://customer-clinical-staging.example.net',
      CLINICAL_OS_STAGING_DEPLOYMENT: 'true',
      CLINICAL_OS_ALLOW_STAGING_DATABASE: 'true',
      CLINICAL_OS_STAGING_DATABASE_ACK: 'STAGING_ONLY',
      CLINICAL_OS_PRODUCTION_CONFIG_JSON: JSON.stringify(chananya),
      CLINICAL_OS_TENANT_CONFIG_JSON: JSON.stringify({
        ...stagingExample,
        tenant: { ...stagingExample.tenant, expectedClinicId: chananya.tenant.expectedClinicId },
        auth: { redirectOrigin: 'https://customer-clinical-staging.example.net' }
      })
    },
    cwd: root
  }),
  /clinic UUID/
);
assert.throws(
  () => loadTenantConfig({
    env: {
      CONTEXT: 'deploy-preview',
      CLINICAL_OS_ALLOW_PREVIEW_DATABASE: 'true',
      CLINICAL_OS_PREVIEW_DATABASE_ACK: 'STAGING_ONLY',
      CLINICAL_OS_PRODUCTION_CONFIG_JSON: JSON.stringify(chananya),
      CLINICAL_OS_TENANT_CONFIG_PATH: 'config/tenant.chananya.json'
    },
    cwd: root
  }),
  /staging\/non-production deploymentId|Production Supabase project/
);

const staffPages = [
  'index.html','appointments.html','check-in.html','clinical-v3.html','foundation.html',
  'pharmacy.html','production.html','quality.html','admin.html','login.html','auth-callback.html','auth.html','login-v3.html'
];
for (const page of staffPages) {
  const html = read(page);
  const configIndex = html.indexOf('tenant-config.js');
  assert.ok(configIndex >= 0, `${page} must load the tenant config`);
  const authIndex = html.indexOf('auth-config.js');
  const runtimeIndex = html.indexOf('chananya-runtime.js');
  if (authIndex >= 0) assert.ok(configIndex < authIndex, `${page} must load tenant config before auth config`);
  if (runtimeIndex >= 0) assert.ok(configIndex < runtimeIndex, `${page} must load tenant config before runtime`);
}
for (const page of ['patient-card.html','identity-review.html','ui-review.html']) {
  const html = read(page);
  assert.match(html, /brand-config\.js/, `${page} must load the credential-free public brand config`);
  assert.doesNotMatch(html, /tenant-config\.js|auth-config\.js|(?:src|href)=["'][^"']*supabase/i, `${page} must not load staff database configuration`);
}
assert.doesNotMatch(read('brand-config.js'), /"database"|publishableKey|supabase\.co/i, 'public/read-only brand config must contain no database metadata');

const auth = read('auth-config.js');
const runtime = read('chananya-runtime.js');
assert.doesNotMatch(auth, /https:\/\/[^'"\s]+\.supabase\.co|sb_publishable_[A-Za-z0-9_-]+/, 'auth compatibility layer must not hard-code one customer database');
assert.match(runtime, /expectedClinicId/);
assert.match(runtime, /expectedClinicCode/);
assert.match(runtime, /tenant_mismatch: true/);
assert.match(runtime, /access_context_ready: false/);

const brand = read('tenant-brand.js');
assert.match(brand, /brand\.logoUrl/);
assert.match(brand, /brand\.browserTitle/);
assert.match(brand, /--forest-950/);
assert.match(brand, /brandWatermark/);
assert.match(brand, /data-brand-demo-hn/);
assert.match(read('identity-review.html'), /data-brand-demo-hn/);
assert.match(read('ui-review.html'), /data-brand-demo-request/);
assert.match(read('pharmacy-labels.js'), /CLINICAL_OS_CONFIG\?\.brand/);
assert.match(read('pharmacy-v33-tools.js'), /clinicBrand/);
assert.doesNotMatch(read('auth.html'), /qptxnrldzzinlcabudjv|sb_publishable_/);
assert.doesNotMatch(read('login-v3.html'), /qptxnrldzzinlcabudjv|sb_publishable_/);

const titleDocument = {
  title: 'เข้าสู่ระบบ — Chananya Clinical OS',
  readyState: 'complete',
  documentElement: { style: { setProperty() {} }, dataset: {} },
  querySelectorAll() { return []; },
  createElement() { return {}; }
};
const titleWindow = {
  CLINICAL_OS_CONFIG: {
    deploymentId: 'chananya-clinical-staging',
    brand: { browserTitle: 'CNYOS' },
    tenant: { expectedClinicCode: 'CHANANYA-STG' }
  },
  dispatchEvent() {}
};
vm.runInNewContext(brand, {
  window: titleWindow,
  document: titleDocument,
  CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
  Object,
  String
});
assert.equal(titleDocument.title, 'CNYOS', 'an explicit browser title must override the legacy page title');

const netlify = read('netlify.toml');
assert.match(netlify, /command = "npm run build"/);
assert.match(netlify, /for = "\/tenant-config\.js"[\s\S]*Cache-Control = "no-store/);
assert.match(netlify, /for = "\/brand-config\.js"[\s\S]*Cache-Control = "no-store/);
assert.match(netlify, /for = "\/deploy-manifest\.json"[\s\S]*Cache-Control = "no-store/);
assert.doesNotMatch(netlify, /SERVICE_ROLE|ENCRYPTION_KEY|SERVICE_ACCOUNT/);

const docs = read('docs/WHITE_LABEL_DEPLOYMENT.md');
assert.match(docs, /one Netlify site \+ one Supabase project/i);
assert.match(docs, /fails closed/i);
assert.match(docs, /service-role key/i);

console.log('White-label contracts passed: validated branding, per-customer DB endpoint, tenant fail-close, print identity and deploy safety');
