import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testDir, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const runtimeSource = read('chananya-runtime.js');
const sandbox = { window: {} };
vm.runInNewContext(runtimeSource, sandbox, { filename: 'chananya-runtime.js' });
const runtime = sandbox.window.ChananyaRuntime;

assert.ok(runtime, 'runtime should register window.ChananyaRuntime');
assert.equal(typeof runtime.rolesOf, 'function', 'runtime should expose rolesOf');

const cases = [
  {
    label: 'pharmacy operational role is not masked by system staff',
    profile: { role: 'pharmacy', system_role: 'staff' },
    effective: 'pharmacy',
    capability: 'pharmacy_operate',
    allowed: true
  },
  {
    label: 'practitioner operational role is not masked by system staff',
    profile: { role: 'practitioner', system_role: 'staff' },
    effective: 'practitioner',
    capability: 'clinical_write',
    allowed: true
  },
  {
    label: 'reception keeps appointment operation capability',
    profile: { role: 'reception', system_role: 'staff' },
    effective: 'reception',
    capability: 'appointments_operate',
    allowed: true
  },
  {
    label: 'system admin overrides a viewer operational role',
    profile: { role: 'viewer', system_role: 'admin' },
    effective: 'admin',
    capability: 'clinical_write',
    allowed: true
  },
  {
    label: 'super admin retains production override',
    profile: { role: 'viewer', system_role: 'super_admin' },
    effective: 'super_admin',
    capability: 'production_operate',
    allowed: true
  }
];

for (const testCase of cases) {
  assert.equal(runtime.roleOf(testCase.profile), testCase.effective, testCase.label);
  assert.equal(runtime.can(testCase.profile, testCase.capability), testCase.allowed, testCase.label);
}

const superAdmin = { role: 'viewer', system_role: 'super_admin' };
assert.equal(runtime.can(superAdmin, 'appointments_view'), true, 'super admin may inspect appointments');
assert.equal(runtime.can(superAdmin, 'appointments_operate'), false, 'super admin appointment mode remains read-only');
assert.deepEqual(
  [...runtime.rolesOf({ role: 'pharmacy', system_role: 'staff' }).grantedRoles],
  ['pharmacy'],
  'staff must not become an operational grant'
);

const scriptsToParse = [
  'auth-config.js',
  'app-shell.js',
  'app.js',
  'admin.js',
  'admin-clinical-audit.js',
  'appointments.js',
  'chananya-runtime.js',
  'clinical-v3.js',
  'clinical-context-guard.js',
  'body-pain-map.js',
  'ttm-diagnosis-assistant.js',
  'diagnosis-atomic-bridge.js',
  'opd-workflow.js',
  'clinical-signoff.js',
  'pharmacy.js',
  'pharmacy-sale-selector-fix.js',
  'pharmacy-labels.js',
  'pharmacy-v33-tools.js',
  'production.js'
];
for (const file of scriptsToParse) {
  assert.doesNotThrow(() => new vm.Script(read(file), { filename: file }), `${file} should parse`);
}

const authConfig = read('auth-config.js');
assert.doesNotMatch(authConfig, /createElement|appendChild|setInterval|MutationObserver/, 'auth config must remain configuration-only');

const clinicalHtml = read('clinical-v3.html');
const contextIndex = clinicalHtml.indexOf('clinical-context-guard.js');
const bodyMapIndex = clinicalHtml.indexOf('body-pain-map.js');
const diagnosisIndex = clinicalHtml.indexOf('diagnosis-atomic-bridge.js');
const signoffIndex = clinicalHtml.indexOf('clinical-signoff.js');
assert.ok(contextIndex > -1, 'Clinical Context Guard should be loaded explicitly');
assert.ok(contextIndex < bodyMapIndex && bodyMapIndex < signoffIndex, 'Clinical extensions should load in safe sequence');
assert.ok(bodyMapIndex < diagnosisIndex && diagnosisIndex < signoffIndex, 'Diagnosis and sign-off sequence should be deterministic');
assert.match(clinicalHtml, /data-stage="intake"/, 'Clinical page should expose the staged workflow');
assert.match(clinicalHtml, /data-stage="signoff"/, 'Clinical workflow should end with sign-off');
assert.match(read('clinical-signoff.js'), /fields\.inert=locked/, 'sign-off lock should disable the owned record boundary');

for (const page of ['index.html', 'appointments.html', 'clinical-v3.html', 'pharmacy.html', 'production.html', 'admin.html']) {
  const html = read(page);
  const runtimeIndex = html.indexOf('chananya-runtime.js');
  const shellIndex = html.indexOf('app-shell.js');
  assert.ok(runtimeIndex > -1 && shellIndex > runtimeIndex, `${page} should load the shared shell after the runtime`);
}

assert.doesNotMatch(read('admin-clinical-audit.js'), /createElement|appendChild/, 'Admin audit should bind to owned static markup');
assert.match(read('admin.html'), /id="clinical-audit"/, 'Admin audit section should exist in HTML');
assert.doesNotMatch(read('pharmacy-labels.js'), /MutationObserver/, 'Pharmacy labels should use the render event contract');
assert.doesNotMatch(read('pharmacy-v33-tools.js'), /MutationObserver/, 'Pharmacy print tools should use the render event contract');
assert.match(read('_redirects'), /^\/app\.html\s+\/\s+301!/m, 'Legacy localStorage prototype should redirect to the canonical operations route');

console.log(`IA release checks passed: ${cases.length} role cases + ${scriptsToParse.length} syntax checks + shared shell/order assertions`);
