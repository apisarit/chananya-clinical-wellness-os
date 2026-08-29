import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadStagingCredentials,
  loadStagingTarget,
  sourceCommit,
  supabaseUrl,
  writeEvidence
} from './staging-support.mjs';
import { parseTenantConfig } from './verify-locked-staging.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const revision = /^[0-9a-f]{40}$/i;

const INPUT_CHECKS = Object.freeze({
  stagingAcknowledgement: env => env.CLINICAL_OS_STAGING_ACK === 'STAGING_ONLY',
  stagingConfig: env => Boolean(env.CLINICAL_OS_STAGING_CONFIG_JSON || env.CLINICAL_OS_STAGING_CONFIG_PATH),
  productionConfigDenylist: env => Boolean(env.CLINICAL_OS_PRODUCTION_CONFIG_JSON || env.CLINICAL_OS_PRODUCTION_CONFIG_PATH),
  stagingSiteUrl: env => Boolean(String(env.STAGING_SITE_URL || '').trim()),
  stagingServiceRoleKey: env => Boolean(String(env.STAGING_SUPABASE_SERVICE_ROLE_KEY || '').trim()),
  stagingTestPassword: env => Boolean(String(env.STAGING_TEST_PASSWORD || '').trim()),
  stagingTestEmailDomain: env => Boolean(String(env.STAGING_TEST_EMAIL_DOMAIN || '').trim())
});

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeErrorMessage(error) {
  return String(error?.message || error || 'Unknown preflight error')
    .replace(/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/gi, '[REDACTED_SUPABASE_KEY]')
    .replace(/\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){1,2}\b/g, '[REDACTED_JWT]')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .slice(0, 600);
}

export function inspectPreflightInputs(env = process.env) {
  return Object.freeze(Object.fromEntries(
    Object.entries(INPUT_CHECKS).map(([name, check]) => [name, check(env)])
  ));
}

function requirePreflightInputs(env) {
  const inputs = inspectPreflightInputs(env);
  const missing = Object.entries(inputs)
    .filter(([, present]) => !present)
    .map(([name]) => name);
  if (missing.length) {
    throw new Error(`Authenticated staging preflight is missing required controls: ${missing.join(', ')}`);
  }
  return inputs;
}

async function fetchText(fetchImpl, url, { headers = {}, label } = {}) {
  const response = await fetchImpl(url, {
    redirect: 'follow',
    cache: 'no-store',
    headers: {
      Accept: 'application/json, text/javascript;q=0.9, */*;q=0.1',
      'User-Agent': 'clinical-os-authenticated-staging-preflight/1.0',
      ...headers
    }
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${label || 'Authenticated staging endpoint'} returned HTTP ${response.status}`);
  }
  return { response, body };
}

function requirePublicHeaders(response, label) {
  assert.match(
    response.headers.get('cache-control') || '',
    /no-store/i,
    `${label} must be served with Cache-Control: no-store`
  );
  assert.equal(
    response.headers.get('x-content-type-options'),
    'nosniff',
    `${label} must set X-Content-Type-Options=nosniff`
  );
  assert.equal(
    response.headers.get('x-frame-options'),
    'DENY',
    `${label} must set X-Frame-Options=DENY`
  );
}

function expectedRevision(env) {
  const value = String(env.EXPECTED_STAGING_SOURCE_COMMIT || sourceCommit(env)).trim().toLowerCase();
  assert.match(value, revision, 'An exact 40-character staging source commit is required');
  return value;
}

export async function verifyAuthenticatedStagingPreflight({
  env = process.env,
  cwd = root,
  fetchImpl = fetch
} = {}) {
  const inputs = requirePreflightInputs(env);
  const target = loadStagingTarget({ env, cwd });
  const credentials = loadStagingCredentials(env);
  const expectedCommit = expectedRevision(env);

  assert.equal(
    target.config.safety.previewLocked,
    false,
    'Authenticated staging config must set previewLocked=false'
  );

  const tenantResult = await fetchText(fetchImpl, `${target.siteUrl}/tenant-config.js`, {
    label: 'Remote tenant-config.js'
  });
  requirePublicHeaders(tenantResult.response, 'tenant-config.js');
  const remoteConfig = parseTenantConfig(tenantResult.body);

  assert.equal(remoteConfig.deploymentId, target.config.deploymentId, 'Remote deploymentId does not match the protected staging config');
  assert.equal(remoteConfig.tenant?.expectedClinicId, target.config.tenant.expectedClinicId, 'Remote staging clinic UUID mismatch');
  assert.equal(remoteConfig.tenant?.expectedClinicCode, target.config.tenant.expectedClinicCode, 'Remote staging clinic code mismatch');
  assert.equal(remoteConfig.identity?.qrIssuer, target.config.identity.qrIssuer, 'Remote staging QR issuer mismatch');
  assert.equal(remoteConfig.auth?.redirectOrigin, target.siteUrl, 'Remote staging redirect origin mismatch');
  assert.equal(remoteConfig.database?.url, target.config.database.url, 'Remote staging Supabase origin mismatch');
  assert.equal(remoteConfig.database?.publishableKey, target.config.database.publishableKey, 'Remote staging publishable key mismatch');
  assert.equal(remoteConfig.safety?.previewLocked, false, 'Remote staging remains preview-locked');

  const manifestResult = await fetchText(fetchImpl, `${target.siteUrl}/deploy-manifest.json`, {
    label: 'Remote deploy-manifest.json'
  });
  requirePublicHeaders(manifestResult.response, 'deploy-manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(manifestResult.body);
  } catch {
    throw new Error('Remote deploy-manifest.json is not valid JSON');
  }

  assert.equal(manifest.deploymentId, target.config.deploymentId, 'Deploy manifest deploymentId mismatch');
  assert.equal(manifest.tenant?.expectedClinicId, target.config.tenant.expectedClinicId, 'Deploy manifest clinic UUID mismatch');
  assert.equal(manifest.tenant?.expectedClinicCode, target.config.tenant.expectedClinicCode, 'Deploy manifest clinic code mismatch');
  assert.equal(manifest.identity?.qrIssuer, target.config.identity.qrIssuer, 'Deploy manifest QR issuer mismatch');
  assert.equal(manifest.safety?.previewLocked, false, 'Deploy manifest still records previewLocked=true');
  assert.equal(manifest.safety?.databaseLocked, false, 'Deploy manifest still records databaseLocked=true');
  assert.equal(manifest.source?.verified, true, 'Deploy manifest source provenance is not verified');
  assert.match(manifest.source?.commit || '', revision, 'Deploy manifest must contain an exact 40-character source commit');
  assert.equal(manifest.source.commit, expectedCommit, 'Remote staging source commit does not match the exact release candidate');

  const serviceProbe = await fetchText(
    fetchImpl,
    supabaseUrl(target, '/auth/v1/admin/users?page=1&per_page=1'),
    {
      label: 'Staging Supabase service-role probe',
      headers: {
        apikey: credentials.serviceRoleKey,
        Authorization: `Bearer ${credentials.serviceRoleKey}`,
        'X-Client-Info': 'clinical-os-authenticated-staging-preflight/1.0'
      }
    }
  );
  let servicePayload;
  try {
    servicePayload = JSON.parse(serviceProbe.body);
  } catch {
    throw new Error('Staging Supabase service-role probe returned invalid JSON');
  }
  const users = Array.isArray(servicePayload) ? servicePayload : servicePayload?.users;
  assert.ok(Array.isArray(users), 'Staging Supabase service-role probe did not return an Auth user collection');

  return Object.freeze({
    schemaVersion: 1,
    evidenceType: 'authenticated_staging_preflight',
    status: 'passed',
    readOnly: true,
    sourceCommit: expectedCommit,
    generatedAt: new Date().toISOString(),
    deploymentId: target.config.deploymentId,
    siteOrigin: target.siteUrl,
    databaseProjectRef: target.projectRef,
    clinicId: target.config.tenant.expectedClinicId,
    clinicCode: target.config.tenant.expectedClinicCode,
    inputs,
    isolation: {
      productionDatabaseRejected: true,
      productionSiteRejected: true,
      productionClinicRejected: true,
      productionIssuerRejected: true
    },
    remoteDeployment: {
      sourceCommit: manifest.source.commit,
      sourceVerified: true,
      previewLocked: false,
      databaseLocked: false,
      tenantConfigSha256: sha256(tenantResult.body),
      deployManifestSha256: sha256(manifestResult.body)
    },
    serviceRoleProbe: {
      authenticated: true,
      projectRef: target.projectRef,
      recordsReturned: users.length
    }
  });
}

async function main() {
  const generatedAt = new Date().toISOString();
  try {
    const evidence = await verifyAuthenticatedStagingPreflight();
    const evidencePath = writeEvidence('authenticated-staging-preflight.json', evidence);
    process.stdout.write(`Authenticated staging preflight passed without writes; evidence: ${evidencePath}\n`);
  } catch (error) {
    const evidence = {
      schemaVersion: 1,
      evidenceType: 'authenticated_staging_preflight',
      status: 'blocked',
      readOnly: true,
      sourceCommit: sourceCommit(),
      generatedAt,
      inputs: inspectPreflightInputs(),
      blocker: safeErrorMessage(error)
    };
    const evidencePath = writeEvidence('authenticated-staging-preflight.json', evidence);
    process.stderr.write(`Authenticated staging preflight blocked: ${evidence.blocker}; evidence: ${evidencePath}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
