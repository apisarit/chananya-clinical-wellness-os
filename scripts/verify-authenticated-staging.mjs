import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  DATABASE_CAPABILITIES,
  EXPECTED_DATABASE_CAPABILITIES,
  EXPECTED_WORKSPACES,
  STAGING_ROLES,
  WORKSPACE_ROUTES,
  evidenceDirectory,
  loadStagingCredentials,
  loadStagingTarget,
  requestJson,
  rpc,
  signInStagingRole,
  sourceCommit,
  supabaseUrl,
  writeEvidence
} from './staging-support.mjs';

const target = loadStagingTarget();
const credentials = loadStagingCredentials();
const sessions = new Map();
const roleResults = [];

function rowOf(value) {
  return Array.isArray(value) ? value[0] : value;
}

for (const role of STAGING_ROLES) {
  const signedIn = await signInStagingRole(target, role);
  sessions.set(role, signedIn.session);
  const context = rowOf(await rpc(target, signedIn.session.access_token, 'current_access_context'));
  assert.ok(context, `${role}: current_access_context returned no row`);
  assert.equal(context.clinic_id, target.config.tenant.expectedClinicId, `${role}: clinic id mismatch`);
  assert.equal(context.clinic_code, target.config.tenant.expectedClinicCode, `${role}: clinic code mismatch`);
  assert.equal(context.clinic_role, signedIn.identity.clinicRole, `${role}: clinic role mismatch`);
  assert.equal(context.system_role, signedIn.identity.systemRole, `${role}: system role mismatch`);
  assert.equal(context.effective_role, signedIn.identity.effectiveRole, `${role}: effective role mismatch`);
  assert.equal(context.ready, true, `${role}: access context is not ready`);

  const expected = new Set(EXPECTED_DATABASE_CAPABILITIES[role]);
  const capabilities = {};
  for (const capability of DATABASE_CAPABILITIES) {
    const allowed = await rpc(target, signedIn.session.access_token, 'department_can', {
      p_capability: capability
    });
    capabilities[capability] = allowed === true;
    assert.equal(
      capabilities[capability],
      expected.has(capability),
      `${role}: unexpected ${capability}=${capabilities[capability]}`
    );
  }
  roleResults.push({
    role,
    userId: signedIn.session.user.id,
    email: signedIn.identity.email,
    clinicRole: context.clinic_role,
    systemRole: context.system_role,
    effectiveRole: context.effective_role,
    capabilities
  });
}

const superSession = sessions.get('super_admin');
const healthchecks = {};
for (const name of [
  'hybrid_patient_identity_healthcheck',
  'clinical_financial_handoffs_healthcheck',
  'prescription_dispensing_healthcheck',
  'production_execution_healthcheck',
  'quality_release_healthcheck',
  'backup_restore_contract_healthcheck'
]) {
  const result = rowOf(await rpc(target, superSession.access_token, name));
  assert.equal(result?.ready, true, `${name} is not ready on staging`);
  healthchecks[name] = result;
}

const disabledRole = 'practitioner';
const disabledSession = sessions.get(disabledRole);
const disabledRoleResult = roleResults.find(result => result.role === disabledRole);
const accountDisableEvidence = { role: disabledRole, existingTokenDenied: false, reactivated: false };
try {
  await rpc(target, superSession.access_token, 'admin_set_staff_membership_active', {
    p_user_id: disabledRoleResult.userId,
    p_active: false,
    p_reason: 'Authenticated staging account-disable verification'
  });
  const disabledContext = rowOf(await rpc(target, disabledSession.access_token, 'current_access_context'));
  const disabledClinical = await rpc(target, disabledSession.access_token, 'department_can', {
    p_capability: 'clinical'
  });
  assert.equal(disabledContext, undefined, 'disabled practitioner retained an active clinic context');
  assert.equal(disabledClinical, false, 'disabled practitioner retained its clinical capability');
  accountDisableEvidence.existingTokenDenied = true;
} finally {
  await rpc(target, superSession.access_token, 'admin_set_staff_membership_active', {
    p_user_id: disabledRoleResult.userId,
    p_active: true,
    p_reason: 'Restore synthetic viewer after staging verification'
  });
  const restoredContext = rowOf(await rpc(target, disabledSession.access_token, 'current_access_context'));
  assert.equal(restoredContext?.ready, true, 'synthetic practitioner was not restored after account-disable verification');
  accountDisableEvidence.reactivated = true;
}

if (process.env.STAGING_OWNER_CONTROL_ACK !== 'TOGGLE_STAGING_SUBSCRIPTION') {
  throw new Error('STAGING_OWNER_CONTROL_ACK=TOGGLE_STAGING_SUBSCRIPTION is required');
}
const ownerActor = roleResults.find(result => result.role === 'super_admin');
const subscriptionSession = sessions.get('practitioner');
const subscriptionControlEvidence = {
  clinicCode: target.config.tenant.expectedClinicCode,
  offRequestId: randomUUID(),
  onRequestId: randomUUID(),
  initialVersion: null,
  suspendedVersion: null,
  restoredVersion: null,
  offRetryIdempotent: false,
  existingTokenDenied: false,
  restoredOriginalBoundary: false,
  databaseEnforced: false
};
async function serviceRpc(name, body) {
  return requestJson(supabaseUrl(target, `/rest/v1/rpc/${name}`), {
    key: credentials.serviceRoleKey,
    bearer: credentials.serviceRoleKey,
    method: 'POST',
    body
  });
}
const initialSubscriptionRows = await serviceRpc('list_owner_subscription_clinics', {});
const initialSubscription = initialSubscriptionRows.find(row => row.clinic_id === target.config.tenant.expectedClinicId);
assert.equal(initialSubscription?.enabled, true, 'staging subscription must start ON before the reversible enforcement proof');
const initialVersion = Number(initialSubscription?.subscription_version);
assert.ok(Number.isSafeInteger(initialVersion) && initialVersion > 0, 'staging subscription version is invalid');
subscriptionControlEvidence.initialVersion = initialVersion;
let subscriptionChangeAttempted = false;
let suspendedVersion = initialVersion + 1;
try {
  subscriptionChangeAttempted = true;
  const offResult = await serviceRpc('set_clinic_subscription_state', {
    p_request_id: subscriptionControlEvidence.offRequestId,
    p_clinic_id: target.config.tenant.expectedClinicId,
    p_expected_clinic_code: target.config.tenant.expectedClinicCode,
    p_enabled: false,
    p_expected_version: initialVersion,
    p_reason: 'Authenticated staging database suspension proof',
    p_actor_user_id: ownerActor.userId,
    p_actor_email: ownerActor.email
  });
  assert.equal(offResult?.enabled, false, 'staging subscription OFF RPC did not disable the tenant');
  assert.equal(offResult?.state, 'suspended', 'staging subscription OFF RPC state mismatch');
  assert.equal(Number(offResult?.version), suspendedVersion, 'staging subscription OFF did not advance version exactly once');
  subscriptionControlEvidence.suspendedVersion = suspendedVersion;

  const offRetry = await serviceRpc('set_clinic_subscription_state', {
    p_request_id: subscriptionControlEvidence.offRequestId,
    p_clinic_id: target.config.tenant.expectedClinicId,
    p_expected_clinic_code: target.config.tenant.expectedClinicCode,
    p_enabled: false,
    p_expected_version: initialVersion,
    p_reason: 'Authenticated staging database suspension proof',
    p_actor_user_id: ownerActor.userId,
    p_actor_email: ownerActor.email
  });
  assert.equal(offRetry?.idempotent, true, 'staging subscription OFF retry was not idempotent');
  assert.equal(Number(offRetry?.version), suspendedVersion, 'staging subscription OFF retry changed version');
  subscriptionControlEvidence.offRetryIdempotent = true;

  const suspendedRows = await serviceRpc('list_owner_subscription_clinics', {});
  const suspendedSubscription = suspendedRows.find(row => row.clinic_id === target.config.tenant.expectedClinicId);
  assert.equal(suspendedSubscription?.enabled, false, 'staging subscription list did not report OFF');
  assert.equal(suspendedSubscription?.subscription_state, 'suspended', 'staging subscription list state mismatch while OFF');
  assert.equal(Number(suspendedSubscription?.subscription_version), suspendedVersion, 'staging subscription list version mismatch while OFF');

  const suspendedContext = rowOf(await rpc(target, subscriptionSession.access_token, 'current_access_context'));
  const suspendedClinical = await rpc(target, subscriptionSession.access_token, 'department_can', {
    p_capability: 'clinical'
  });
  assert.equal(suspendedContext, undefined, 'existing practitioner token retained tenant context while subscription was OFF');
  assert.equal(suspendedClinical, false, 'existing practitioner token retained Clinical capability while subscription was OFF');
  subscriptionControlEvidence.existingTokenDenied = true;
  subscriptionControlEvidence.databaseEnforced = true;
} finally {
  if (subscriptionChangeAttempted) {
    const onResult = await serviceRpc('set_clinic_subscription_state', {
      p_request_id: subscriptionControlEvidence.onRequestId,
      p_clinic_id: target.config.tenant.expectedClinicId,
      p_expected_clinic_code: target.config.tenant.expectedClinicCode,
      p_enabled: true,
      p_expected_version: suspendedVersion,
      p_reason: 'Restore staging subscription after enforcement proof',
      p_actor_user_id: ownerActor.userId,
      p_actor_email: ownerActor.email
    });
    const restoredVersion = suspendedVersion + 1;
    assert.equal(onResult?.enabled, true, 'staging subscription ON RPC did not reactivate the tenant');
    assert.equal(onResult?.state, 'active', 'staging subscription ON RPC state mismatch');
    assert.equal(Number(onResult?.version), restoredVersion, 'staging subscription ON did not advance version exactly once');
    subscriptionControlEvidence.restoredVersion = restoredVersion;

    const restoredRows = await serviceRpc('list_owner_subscription_clinics', {});
    const restoredSubscription = restoredRows.find(row => row.clinic_id === target.config.tenant.expectedClinicId);
    assert.equal(restoredSubscription?.enabled, true, 'staging subscription list did not report restored ON state');
    assert.equal(restoredSubscription?.subscription_state, 'active', 'staging subscription list state mismatch after restore');
    assert.equal(Number(restoredSubscription?.subscription_version), restoredVersion, 'staging subscription list version mismatch after restore');

    const restoredContext = rowOf(await rpc(target, subscriptionSession.access_token, 'current_access_context'));
    assert.equal(restoredContext?.clinic_id, target.config.tenant.expectedClinicId, 'subscription ON did not restore the original clinic boundary');
    assert.equal(restoredContext?.clinic_role, 'practitioner', 'subscription ON widened or changed the original department role');
    subscriptionControlEvidence.restoredOriginalBoundary = true;
  }
}

async function runBrowserMatrix() {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error('STAGING_BROWSER_E2E=true requires playwright@1.55.0; use the protected staging workflow');
  }

  const browser = await chromium.launch({ headless: true });
  const browserResults = [];
  const screenshotDirectory = evidenceDirectory();
  try {
    const storageKey = `sb-${target.projectRef}-auth-token`;
    for (const role of STAGING_ROLES) {
      const session = sessions.get(role);
      const context = await browser.newContext({
        baseURL: target.siteUrl,
        locale: 'th-TH',
        timezoneId: 'Asia/Bangkok',
        viewport: { width: 390, height: 844 }
      });
      await context.addInitScript(({ key, value }) => {
        localStorage.setItem(key, JSON.stringify(value));
      }, { key: storageKey, value: session });
      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      const expected = new Set(EXPECTED_WORKSPACES[role]);
      const routes = [];

      try {
        for (const [workspace, route] of Object.entries(WORKSPACE_ROUTES)) {
          const allowed = expected.has(workspace);
          await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 45000 });
          if (allowed) {
            await page.waitForFunction(() => {
              const boot = document.querySelector('#boot');
              const app = document.querySelector('#app');
              return boot?.classList.contains('hidden') && app && !app.classList.contains('hidden');
            }, null, { timeout: 45000 });
          } else {
            await page.waitForFunction(() => {
              const app = document.querySelector('#app');
              const error = document.querySelector('#boot-error')?.textContent || '';
              return app?.classList.contains('hidden') && error.includes('ไม่มีสิทธิ์');
            }, null, { timeout: 30000 });
          }
          routes.push({ workspace, route, expected: allowed ? 'allow' : 'deny', result: 'pass' });

          if (workspace === 'operations') {
            const visiblePaths = await page.$$eval('#global-nav a', links => links.map(link => new URL(link.href).pathname));
            const expectedPaths = EXPECTED_WORKSPACES[role].map(key => WORKSPACE_ROUTES[key]);
            assert.deepEqual(visiblePaths, expectedPaths, `${role}: shared navigation does not match its department`);
            const roleLabel = await page.locator('#role').textContent();
            assert.equal(roleLabel?.trim(), role, `${role}: shell role label mismatch`);
          }
        }
        assert.deepEqual(pageErrors, [], `${role}: browser page errors detected`);
        browserResults.push({ role, result: 'pass', routes });
      } catch (error) {
        const screenshot = path.join(screenshotDirectory, `failure-${role}.png`);
        await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
        browserResults.push({ role, result: 'fail', error: error.message, routes, screenshot: path.basename(screenshot) });
        throw error;
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return browserResults;
}

const browserEnabled = process.env.STAGING_BROWSER_E2E === 'true';
const browserResults = browserEnabled ? await runBrowserMatrix() : null;
const evidence = {
  schemaVersion: 1,
  evidenceType: 'authenticated_staging_role_and_workspace_matrix',
  syntheticOnly: true,
  sourceCommit: sourceCommit(),
  generatedAt: new Date().toISOString(),
  deploymentId: target.config.deploymentId,
  siteOrigin: target.siteUrl,
  databaseProjectRef: target.projectRef,
  clinicId: target.config.tenant.expectedClinicId,
  clinicCode: target.config.tenant.expectedClinicCode,
  apiRoleCount: roleResults.length,
  apiMatrix: roleResults,
  healthchecks,
  accountDisableEvidence,
  subscriptionControlEvidence,
  browserExecuted: browserEnabled,
  browserRoleCount: browserResults?.length || 0,
  browserMatrix: browserResults
};

const evidencePath = writeEvidence('authenticated-staging-matrix.json', evidence);
process.stdout.write(`Authenticated staging matrix passed for ${roleResults.length} roles${browserEnabled ? ' in API and browser' : ' at the API boundary'}; evidence: ${evidencePath}\n`);
