import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

export function validateOrigin(raw) {
  let url;
  try { url = new URL(String(raw || '').trim()); }
  catch { throw new Error('LIVE_ORIGIN_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('LIVE_ORIGIN_INVALID');
  }
  return url.origin;
}

export function parseTenantConfig(source) {
  const text = String(source || '');
  const match = text.match(/window\.CLINICAL_OS_CONFIG\s*=\s*Object\.freeze\((\{[\s\S]*\})\);?\s*$/);
  if (!match) throw new Error('LIVE_TENANT_CONFIG_UNPARSEABLE');
  try { return JSON.parse(match[1]); }
  catch { throw new Error('LIVE_TENANT_CONFIG_INVALID'); }
}

export function validateLiveRuntime({ origin, expectedDeploymentId, expectedClinicCode, expectedRedirectOrigin, tenant, patientIdentity, lineWebhook }) {
  const actualOrigin = validateOrigin(origin);
  assert.equal(expectedRedirectOrigin, actualOrigin, 'LIVE_REDIRECT_ORIGIN_MISMATCH');
  assert.equal(tenant?.deploymentId, expectedDeploymentId, 'LIVE_DEPLOYMENT_ID_MISMATCH');
  assert.equal(tenant?.tenant?.expectedClinicCode, expectedClinicCode, 'LIVE_CLINIC_CODE_MISMATCH');
  assert.equal(tenant?.auth?.redirectOrigin, actualOrigin, 'LIVE_TENANT_REDIRECT_MISMATCH');
  assert.equal(patientIdentity?.enabled, true, 'LIVE_PATIENT_IDENTITY_DISABLED');
  assert.equal(lineWebhook?.enabled, true, 'LIVE_LINE_WEBHOOK_DISABLED');
  assert.equal(lineWebhook?.chatContainsClinicalData, false, 'LIVE_LINE_CHAT_PHI_FLAGGED');
  return Object.freeze({
    origin: actualOrigin,
    deploymentId: tenant.deploymentId,
    clinicCode: tenant.tenant.expectedClinicCode,
    patientIdentityEnabled: true,
    lineWebhookEnabled: true,
    chatContainsClinicalData: false
  });
}

async function getJson(origin, pathname) {
  const response = await fetch(new URL(pathname, `${origin}/`), {
    headers: { Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(15000)
  });
  if (response.status !== 200) throw new Error(`LIVE_ENDPOINT_STATUS_${pathname.replace(/[^A-Za-z0-9]+/g, '_')}_${response.status}`);
  return response.json();
}

export async function verifyLiveLineCapability({
  origin = validateOrigin(required('CNYOS_LIVE_ORIGIN')),
  expectedDeploymentId = required('CNYOS_LIVE_EXPECTED_DEPLOYMENT_ID'),
  expectedClinicCode = required('CNYOS_LIVE_EXPECTED_CLINIC_CODE'),
  expectedRedirectOrigin = validateOrigin(required('CNYOS_LIVE_EXPECTED_REDIRECT_ORIGIN'))
} = {}) {
  if (process.env.CNYOS_LIVE_CHECK_ACK !== 'READ_ONLY_RUNTIME_CHECK') {
    throw new Error('CNYOS_LIVE_CHECK_ACK_REQUIRED');
  }
  const actualOrigin = validateOrigin(origin);
  const [tenantSource, patientIdentity, lineWebhook] = await Promise.all([
    fetch(new URL('/tenant-config.js', `${actualOrigin}/`), {
      headers: { Accept: 'application/javascript' },
      redirect: 'error',
      signal: AbortSignal.timeout(15000)
    }).then(response => {
      if (response.status !== 200) throw new Error(`LIVE_TENANT_CONFIG_STATUS_${response.status}`);
      return response.text();
    }),
    getJson(actualOrigin, '/api/patient-identity'),
    getJson(actualOrigin, '/api/line-oa-webhook')
  ]);
  const tenant = parseTenantConfig(tenantSource);
  const evidence = validateLiveRuntime({
    origin: actualOrigin,
    expectedDeploymentId,
    expectedClinicCode,
    expectedRedirectOrigin,
    tenant,
    patientIdentity,
    lineWebhook
  });
  const destination = path.resolve(process.env.LIVE_RUNTIME_EVIDENCE_PATH || path.join(root, 'artifacts', 'live-line-capability.json'));
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fs.writeFile(destination, `${JSON.stringify({ schemaVersion: 1, evidenceType: 'live_line_runtime_capability', verifiedAt: new Date().toISOString(), ...evidence }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  process.stdout.write(`Live LINE runtime verified for ${evidence.origin} (${evidence.deploymentId})\n`);
  return evidence;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyLiveLineCapability().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
