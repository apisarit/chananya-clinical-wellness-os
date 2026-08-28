import assert from 'node:assert/strict';
import path from 'node:path';
import {
  DATABASE_CAPABILITIES,
  EXPECTED_DATABASE_CAPABILITIES,
  EXPECTED_WORKSPACES,
  STAGING_ROLES,
  WORKSPACE_ROUTES,
  evidenceDirectory,
  loadStagingTarget,
  rpc,
  signInStagingRole,
  sourceCommit,
  writeEvidence
} from './staging-support.mjs';

const target = loadStagingTarget();
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
  'quality_release_healthcheck'
]) {
  const result = rowOf(await rpc(target, superSession.access_token, name));
  assert.equal(result?.ready, true, `${name} is not ready on staging`);
  healthchecks[name] = result;
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
  browserExecuted: browserEnabled,
  browserRoleCount: browserResults?.length || 0,
  browserMatrix: browserResults
};

const evidencePath = writeEvidence('authenticated-staging-matrix.json', evidence);
process.stdout.write(`Authenticated staging matrix passed for ${roleResults.length} roles${browserEnabled ? ' in API and browser' : ' at the API boundary'}; evidence: ${evidencePath}\n`);
