import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const migration = read('supabase/migrations/20261008223000_enforce_assigned_prescription_authorization.sql');
const clinical = read('clinical-v3.js');
const behavioral = read('tests/postgres-behavioral-smoke.mjs');
const packageJson = JSON.parse(read('package.json'));

assert.match(migration, /^begin;/i, 'authorization replacement must be transactional');
assert.match(migration, /commit;\s*$/i, 'authorization replacement must commit transactionally');
assert.match(
  migration,
  /create or replace function public\.create_atomic_prescription_handoff\s*\(\s*p_request_key uuid,\s*p_encounter_id uuid,\s*p_clinical_notes text default null,\s*p_items jsonb default '\[\]'::jsonb\s*\)/i,
  'migration must replace the existing atomic prescription function signature'
);
assert.match(migration, /security definer\s+set search_path = pg_catalog, public, pg_temp/i);
assert.match(migration, /v_actor uuid := auth\.uid\(\)/i);
assert.match(migration, /v_is_super_admin boolean := public\.is_super_admin\(\)/i);
assert.match(
  migration,
  /if not v_is_super_admin and not public\.department_can\('clinical'\) then\s+raise exception 'PERMISSION_DENIED'/i,
  'ordinary callers must hold the clinical department capability'
);
assert.match(
  migration,
  /if not v_is_super_admin\s+and v_encounter\.practitioner_id is distinct from v_actor then\s+raise exception 'ENCOUNTER_PRACTITIONER_MISMATCH'/i,
  'ordinary callers must be the practitioner assigned to the encounter'
);
assert.match(
  migration,
  /from public\.encounters e\s+where e\.id = p_encounter_id\s+and e\.clinic_id = v_clinic_id\s+for update/i,
  'authorization must use the tenant-scoped locked encounter row'
);
assert.doesNotMatch(
  migration,
  /is_clinic_member\([^)]*array\[[^\]]*'(?:owner|admin)'/i,
  'owner/admin membership must not authorize prescribing'
);

const assignmentGuard = migration.indexOf('ENCOUNTER_PRACTITIONER_MISMATCH');
const idempotentRead = migration.indexOf('select rx.* into v_existing');
assert.ok(assignmentGuard > -1 && idempotentRead > assignmentGuard,
  'encounter assignment must be authorized before idempotent handoff details can be returned');

assert.match(
  migration,
  /revoke all on function public\.create_atomic_prescription_handoff\(uuid,uuid,text,jsonb\)\s+from public, anon, authenticated, service_role;/i,
  'all inherited execution grants must be removed explicitly'
);
assert.match(
  migration,
  /grant execute on function public\.create_atomic_prescription_handoff\(uuid,uuid,text,jsonb\)\s+to authenticated;/i,
  'only authenticated browser callers may execute the prescription handoff'
);
assert.doesNotMatch(
  migration,
  /grant execute on function public\.create_atomic_prescription_handoff\([^;]+\)\s+to [^;]*\b(?:anon|service_role|public)\b/i,
  'the replacement must not regrant prescription execution to public, anon or service_role'
);
assert.match(migration, /v_encounter\.id,\s*v_encounter\.patient_id,\s*v_actor,\s*'sent_to_pharmacy'/i,
  'the stored prescriber must be the authorized authenticated actor');
assert.match(
  migration,
  /from public\.products p\s+where p\.id = v_product_id\s+and p\.clinic_id = v_clinic_id\s+and p\.active/i,
  'SECURITY DEFINER product lookup must stay inside the active clinic'
);
assert.match(
  migration,
  /'assigned_practitioner_id', v_encounter\.practitioner_id,\s*'super_admin_override', v_is_super_admin/i,
  'audit evidence must identify the assignment and any super-admin override'
);
assert.match(
  behavioral,
  /asUser\(USER_B,[\s\S]*create_atomic_prescription_handoff\([\s\S]*ENCOUNTER_PRACTITIONER_MISMATCH/,
  'native PostgreSQL behavior must deny practitioner B on practitioner A assigned encounter'
);
assert.match(
  behavioral,
  /assignmentAfter\.rows\[0\][\s\S]*assignmentBefore\.rows\[0\][\s\S]*wrong-practitioner denial must not mutate prescription, order, or audit state/,
  'native PostgreSQL behavior must prove the denied call made no durable mutations'
);
assert.match(
  packageJson.scripts.check,
  /node tests\/postgres-behavioral-smoke\.mjs/,
  'the native wrong-practitioner denial must remain in the package quality gate'
);

const helperStart = clinical.indexOf('  function canReadUnassignedEncounters()');
const helperEnd = clinical.indexOf('  async function loadReferences', helperStart);
assert.ok(helperStart > -1 && helperEnd > helperStart, 'clinical encounter authorization helpers must exist');
const helperSource = clinical.slice(helperStart, helperEnd);

const sandbox = { hooks: null };
vm.createContext(sandbox);
vm.runInContext(`
  let db;
  let session;
  let profile;
  ${helperSource}
  globalThis.hooks = {
    setContext(value) {
      db = value.db;
      session = value.session;
      profile = value.profile;
    },
    request: clinicalEncounterRequest,
    canReadUnassignedEncounters
  };
`, sandbox);

function recorder() {
  const calls = [];
  const query = {
    select(columns) { calls.push(['select', columns]); return this; },
    eq(column, value) { calls.push(['eq', column, value]); return this; },
    order(column, options) { calls.push(['order', column, options]); return this; },
    limit(value) { calls.push(['limit', value]); return this; }
  };
  return {
    calls,
    db: {
      from(table) { calls.push(['from', table]); return query; }
    }
  };
}

const practitioner = recorder();
sandbox.hooks.setContext({
  db: practitioner.db,
  session: { user: { id: 'practitioner-a' } },
  profile: { system_role: 'staff', role: 'practitioner' }
});
sandbox.hooks.request();
assert.deepEqual(
  practitioner.calls.find(call => call[0] === 'eq'),
  ['eq', 'practitioner_id', 'practitioner-a'],
  'ordinary clinical users must query only encounters assigned to their own account'
);
assert.match(
  practitioner.calls.find(call => call[0] === 'select')?.[1] || '',
  /\bpractitioner_id\b/,
  'the client worklist must retain assignment identity for bounded rendering'
);

const superAdmin = recorder();
sandbox.hooks.setContext({
  db: superAdmin.db,
  session: { user: { id: 'super-admin-a' } },
  profile: { system_role: 'super_admin', role: 'viewer' }
});
assert.equal(sandbox.hooks.canReadUnassignedEncounters(), true);
sandbox.hooks.request();
assert.equal(
  superAdmin.calls.some(call => call[0] === 'eq' && call[1] === 'practitioner_id'),
  false,
  'explicit super_admin may retain the cross-practitioner incident-support view'
);

const loadReferences = clinical.slice(
  clinical.indexOf('  async function loadReferences'),
  clinical.indexOf('  async function refreshClinicalWorklist')
);
const refreshWorklist = clinical.slice(
  clinical.indexOf('  async function refreshClinicalWorklist'),
  clinical.indexOf('  function mountClinicalWorklist')
);
assert.match(loadReferences, /clinicalEncounterRequest\(\)/,
  'encounter and prescription selectors must use the assignment-filtered request');
assert.match(refreshWorklist, /clinicalEncounterRequest\(\)/,
  'the visible clinical worklist must use the assignment-filtered request');
assert.doesNotMatch(loadReferences, /db\.from\('encounters'\)/,
  'reference loading must not bypass the shared assignment filter');
assert.doesNotMatch(refreshWorklist, /db\.from\('encounters'\)/,
  'worklist refresh must not bypass the shared assignment filter');

console.log('Prescription assignment authorization contracts passed: clinical department, assigned practitioner, super-admin override, narrow ACL and filtered UI');
