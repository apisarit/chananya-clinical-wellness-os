import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTenantConfig, validateLiveRuntime, validateOrigin } from '../scripts/verify-live-line-capability.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'scripts/verify-live-line-capability.mjs'), 'utf8');

assert.equal(validateOrigin('https://cnyos.cloud'), 'https://cnyos.cloud');
assert.throws(() => validateOrigin('http://cnyos.cloud'), /LIVE_ORIGIN_INVALID/);
assert.throws(() => validateOrigin('https://cnyos.cloud/path'), /LIVE_ORIGIN_INVALID/);

const config = {
  deploymentId: 'chananya-clinical-production',
  tenant: { expectedClinicCode: 'CHANANYA-PRD' },
  auth: { redirectOrigin: 'https://cnyos.cloud' }
};
const result = validateLiveRuntime({
  origin: 'https://cnyos.cloud',
  expectedDeploymentId: 'chananya-clinical-production',
  expectedClinicCode: 'CHANANYA-PRD',
  expectedRedirectOrigin: 'https://cnyos.cloud',
  tenant: config,
  patientIdentity: { enabled: true },
  lineWebhook: { enabled: true, chatContainsClinicalData: false }
});
assert.deepEqual(result, {
  origin: 'https://cnyos.cloud',
  deploymentId: 'chananya-clinical-production',
  clinicCode: 'CHANANYA-PRD',
  patientIdentityEnabled: true,
  lineWebhookEnabled: true,
  chatContainsClinicalData: false
});
assert.throws(() => validateLiveRuntime({
  origin: 'https://cnyos.cloud',
  expectedDeploymentId: 'chananya-clinical-production',
  expectedClinicCode: 'CHANANYA-PRD',
  expectedRedirectOrigin: 'https://cnyos.cloud',
  tenant: { ...config, deploymentId: 'chananya-clinical-staging' },
  patientIdentity: { enabled: true },
  lineWebhook: { enabled: true, chatContainsClinicalData: false }
}), /LIVE_DEPLOYMENT_ID_MISMATCH/);
assert.throws(() => validateLiveRuntime({
  origin: 'https://cnyos.cloud',
  expectedDeploymentId: 'chananya-clinical-production',
  expectedClinicCode: 'CHANANYA-PRD',
  expectedRedirectOrigin: 'https://cnyos.cloud',
  tenant: config,
  patientIdentity: { enabled: false },
  lineWebhook: { enabled: true, chatContainsClinicalData: false }
}), /LIVE_PATIENT_IDENTITY_DISABLED/);
assert.throws(() => validateLiveRuntime({
  origin: 'https://cnyos.cloud',
  expectedDeploymentId: 'chananya-clinical-production',
  expectedClinicCode: 'CHANANYA-PRD',
  expectedRedirectOrigin: 'https://cnyos.cloud',
  tenant: config,
  patientIdentity: { enabled: true },
  lineWebhook: { enabled: true, chatContainsClinicalData: true }
}), /LIVE_LINE_CHAT_PHI_FLAGGED/);

const parsed = parseTenantConfig(`window.CLINICAL_OS_CONFIG = Object.freeze(${JSON.stringify(config)});`);
assert.deepEqual(parsed, config);
assert.throws(() => parseTenantConfig('window.CLINICAL_OS_CONFIG = Object.freeze({not json});'), /LIVE_TENANT_CONFIG/);
assert.match(source, /CNYOS_LIVE_CHECK_ACK/);
assert.match(source, /LIVE_RUNTIME_EVIDENCE_PATH/);
assert.doesNotMatch(source, /SUPABASE_SERVICE_ROLE_KEY|LINE_MESSAGING_CHANNEL_SECRET|PATIENT_IDENTITY_HMAC_SECRET/);

console.log('Live LINE capability verifier contract passed: production identity, redirect, enablement, PHI boundary and redacted evidence');
