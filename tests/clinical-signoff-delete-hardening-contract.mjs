import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = fs.readFileSync(
  path.join(root, 'supabase/migrations/202609010400_clinical_signoff_delete_hardening.sql'),
  'utf8'
);

assert.match(migration, /^begin;/i, 'hardening must be applied transactionally');
assert.match(
  migration,
  /revoke delete on table public\.clinical_record_signoffs from authenticated;/i,
  'authenticated users must not directly delete clinical sign-offs'
);
assert.match(
  migration,
  /drop policy if exists clinical_record_signoffs_write[\s\S]*create policy clinical_record_signoffs_insert[\s\S]*for insert to authenticated[\s\S]*create policy clinical_record_signoffs_update[\s\S]*for update to authenticated/i,
  'the legacy FOR ALL policy must be replaced with insert/update-only policies'
);
assert.doesNotMatch(
  migration,
  /create policy clinical_record_signoffs_(?:write|insert|update)[\s\S]{0,160}\bfor all\b/i,
  'sign-off write policies must not authorize DELETE'
);

assert.match(
  migration,
  /create or replace function public\.prevent_encounter_clinical_evidence_delete\(\)[\s\S]*returns trigger[\s\S]*security definer[\s\S]*set search_path = pg_catalog/i,
  'the parent-delete guard must be a SECURITY DEFINER trigger with a pinned safe search_path'
);
assert.match(
  migration,
  /from public\.clinical_record_signoffs[\s\S]*where s\.encounter_id = old\.id/i,
  'the guard must detect sign-off evidence'
);
assert.match(
  migration,
  /from public\.clinical_record_audit_events[\s\S]*where a\.encounter_id = old\.id/i,
  'the guard must detect clinical audit evidence even if a sign-off was previously removed'
);
assert.match(
  migration,
  /raise exception 'ENCOUNTER_CLINICAL_EVIDENCE_DELETE_DENIED'[\s\S]*errcode = '55000'/i,
  'evidence-bearing encounter deletion must fail closed'
);
assert.match(
  migration,
  /revoke all on function public\.prevent_encounter_clinical_evidence_delete\(\)[\s\S]*from public, anon, authenticated, service_role;/i,
  'the trigger function must not be directly executable by API roles'
);
assert.doesNotMatch(
  migration,
  /grant execute on function public\.prevent_encounter_clinical_evidence_delete\(\)/i,
  'the trigger boundary must not be exposed as an RPC'
);
assert.match(
  migration,
  /create trigger trg_prevent_encounter_clinical_evidence_delete[\s\S]*before delete on public\.encounters[\s\S]*execute function public\.prevent_encounter_clinical_evidence_delete\(\);/i,
  'Encounter DELETE must be stopped before child cascades run'
);
assert.match(
  migration,
  /commit;\s*\n\s*select 'CLINICAL_SIGNOFF_DELETE_HARDENING_READY'/i,
  'verification output must run only after commit'
);

console.log(
  'Clinical sign-off deletion hardening contract passed: no authenticated DELETE and no Encounter cascade over sign-off/audit evidence'
);
