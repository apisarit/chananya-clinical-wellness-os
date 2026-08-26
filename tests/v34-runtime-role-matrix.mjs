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
  'app.js',
  'appointments-permissions.js',
  'chananya-runtime.js',
  'clinical-context-guard.js',
  'clinical-enhancements.js',
  'clinical-signoff.js',
  'pharmacy.js',
  'production.js'
];
for (const file of scriptsToParse) {
  assert.doesNotThrow(() => new vm.Script(read(file), { filename: file }), `${file} should parse`);
}

const authConfig = read('auth-config.js');
const contextIndex = authConfig.indexOf('/clinical-context-guard.js');
const bodyMapIndex = authConfig.indexOf('/body-pain-map.js');
const signoffIndex = authConfig.indexOf('/clinical-signoff.js');
assert.ok(contextIndex > -1, 'Clinical Context Guard should be loaded');
assert.ok(contextIndex < bodyMapIndex && bodyMapIndex < signoffIndex, 'Clinical extensions should load in safe sequence');

const clinicalHtml = read('clinical-v3.html');
assert.match(clinicalHtml, /Clinical Record v3\.4/, 'Clinical page should expose v3.4');
assert.match(read('clinical-signoff.js'), /data-signoff-disabled/, 'sign-off lock should track controls it disabled');

console.log(`v3.4 release checks passed: ${cases.length} role cases + ${scriptsToParse.length} syntax checks`);
