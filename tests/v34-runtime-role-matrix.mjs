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
    label: 'practitioner can inspect the Thai medicine foundation',
    profile: { role: 'practitioner', system_role: 'staff', access_context_ready: true },
    effective: 'practitioner',
    capability: 'knowledge_read',
    allowed: true
  },
  {
    label: 'pharmacy operational role is not masked by system staff',
    profile: { role: 'pharmacy', system_role: 'staff', access_context_ready: true },
    effective: 'pharmacy',
    capability: 'pharmacy_operate',
    allowed: true
  },
  {
    label: 'practitioner operational role is not masked by system staff',
    profile: { role: 'practitioner', system_role: 'staff', access_context_ready: true },
    effective: 'practitioner',
    capability: 'clinical_write',
    allowed: true
  },
  {
    label: 'reception keeps appointment operation capability',
    profile: { role: 'reception', system_role: 'staff', access_context_ready: true },
    effective: 'reception',
    capability: 'appointments_operate',
    allowed: true
  },
  {
    label: 'reception may perform hybrid patient check-in',
    profile: { role: 'reception', system_role: 'staff', access_context_ready: true },
    effective: 'reception',
    capability: 'patient_checkin',
    allowed: true
  },
  {
    label: 'pharmacy may not perform patient identity check-in',
    profile: { role: 'pharmacy', system_role: 'staff', access_context_ready: true },
    effective: 'pharmacy',
    capability: 'patient_checkin',
    allowed: false
  },
  {
    label: 'system admin remains governance-only',
    profile: { role: 'viewer', system_role: 'admin', access_context_ready: true },
    effective: 'admin',
    capability: 'clinical_write',
    allowed: false
  },
  {
    label: 'super admin retains production override',
    profile: { role: 'viewer', system_role: 'super_admin', access_context_ready: true },
    effective: 'super_admin',
    capability: 'production_operate',
    allowed: true
  },
  {
    label: 'quality role owns independent release only',
    profile: { role: 'quality', system_role: 'staff', access_context_ready: true },
    effective: 'quality',
    capability: 'quality_operate',
    allowed: true
  }
];

for (const testCase of cases) {
  assert.equal(runtime.roleOf(testCase.profile), testCase.effective, testCase.label);
  assert.equal(runtime.can(testCase.profile, testCase.capability), testCase.allowed, testCase.label);
}

const superAdmin = { role: 'viewer', system_role: 'super_admin', access_context_ready: true };
assert.equal(runtime.can(superAdmin, 'appointments_view'), true, 'super admin may inspect appointments');
assert.equal(runtime.can(superAdmin, 'clinical_read'), true, 'super admin may inspect tenant-scoped clinical outcomes');
assert.equal(runtime.can(superAdmin, 'appointments_operate'), true, 'super admin receives the explicit cross-workspace override');
assert.equal(runtime.can({ role: 'practitioner', system_role: 'staff', access_context_ready: true }, 'clinical_read'), true, 'practitioner may inspect outcomes');
assert.equal(runtime.can({ role: 'pharmacy', system_role: 'staff', access_context_ready: true }, 'clinical_read'), false, 'pharmacy must not inspect patient-linked outcomes');
assert.equal(runtime.can({ role: 'viewer', system_role: 'admin', access_context_ready: true }, 'clinical_read'), false, 'governance admin must not inherit clinical outcome access');
assert.equal(
  runtime.can({ role: 'viewer', system_role: 'admin', access_context_ready: true }, 'admin_center'),
  true,
  'system admin may use governance tools'
);
assert.equal(
  runtime.can({ role: 'pharmacy', system_role: 'staff', access_context_ready: false }, 'pharmacy_operate'),
  false,
  'frontend role data must fail closed until the database confirms tenant and department context'
);
assert.deepEqual(
  [...runtime.rolesOf({ role: 'pharmacy', system_role: 'staff', access_context_ready: true }).grantedRoles],
  ['pharmacy'],
  'staff must not become an operational grant'
);

const departmentCapabilities = [
  'clinical_write',
  'patient_registry',
  'appointments_operate',
  'pharmacy_operate',
  'product_master_write',
  'production_operate',
  'quality_operate',
  'billing_operate',
  'admin_center'
];
const exactDepartmentGrants = {
  practitioner: ['clinical_write', 'patient_registry'],
  doctor: ['clinical_write', 'patient_registry'],
  reception: ['patient_registry', 'appointments_operate'],
  pharmacy: ['pharmacy_operate', 'product_master_write'],
  production: ['product_master_write', 'production_operate'],
  inventory: ['product_master_write', 'production_operate'],
  quality: ['quality_operate'],
  billing: ['billing_operate'],
  admin: ['admin_center'],
  viewer: []
};
for (const [role, expected] of Object.entries(exactDepartmentGrants)) {
  const profile = {
    role: role === 'admin' ? 'viewer' : role,
    system_role: role === 'admin' ? 'admin' : 'staff',
    access_context_ready: true
  };
  assert.deepEqual(
    departmentCapabilities.filter(capability => runtime.can(profile, capability)),
    expected,
    `${role} must receive only its declared department capabilities`
  );
}
assert.deepEqual(
  departmentCapabilities.filter(capability => runtime.can(superAdmin, capability)),
  departmentCapabilities,
  'super admin alone receives every department capability'
);

const scriptsToParse = [
  'tenant-config.js',
  'brand-config.js',
  'tenant-brand.js',
  'auth-config.js',
  'app-shell.js',
  'app.js',
  'admin.js',
  'admin-clinical-audit.js',
  'appointments.js',
  'check-in.js',
  'foundation.js',
  'outcomes.js',
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
  'production.js',
  'quality.js',
  'patient-card.js',
  'searchable-select.js'
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

for (const page of ['index.html', 'appointments.html', 'check-in.html', 'foundation.html', 'clinical-v3.html', 'outcomes.html', 'pharmacy.html', 'production.html', 'quality.html', 'admin.html']) {
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
assert.match(read('app-shell.js'), /href: '\/foundation\.html'[\s\S]*?capability: 'knowledge_read'/, 'shared shell must expose the foundation as a canonical route');
assert.match(read('app-shell.js'), /href: '\/check-in\.html'[\s\S]*?capability: 'patient_checkin'/, 'shared shell must expose hybrid patient check-in as a canonical route');
assert.match(read('app-shell.js'), /href: '\/quality\.html'[\s\S]*?capability: 'quality_operate'/, 'shared shell must expose Quality as an independent department route');
assert.match(read('app-shell.js'), /href: '\/outcomes\.html'[\s\S]*?capability: 'clinical_read'/, 'shared shell must expose Outcomes only through the clinical read boundary');

console.log(`IA release checks passed: ${cases.length} role cases + ${scriptsToParse.length} syntax checks + shared shell/order assertions`);
