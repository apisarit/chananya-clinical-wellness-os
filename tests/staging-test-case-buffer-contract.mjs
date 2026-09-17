import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync('supabase/manual/20260917090000_staging_test_case_buffer.sql', 'utf8');
const buffer = JSON.parse(fs.readFileSync('tests/fixtures/ollama-synthetic-buffer.json', 'utf8'));

assert.equal(buffer.cases.length, 5);
assert.equal(buffer.stagingOnly, true);
assert.equal(buffer.productionImportable, false);
assert.match(migration, /create table if not exists public\.staging_test_case_buffer/i);
assert.match(migration, /alter table public\.staging_test_case_buffer enable row level security/i);
assert.match(migration, /alter table public\.staging_test_case_buffer force row level security/i);
assert.match(migration, /status in \('active', 'removed'\)/i);
assert.match(migration, /VERSION_CONFLICT/i);
assert.match(migration, /staging_test_case_buffer_events/i);
assert.match(migration, /STAGING_TEST_CASE_EVENT_APPEND_ONLY/i);
assert.match(migration, /cnyos_staging_internal\.record_buffer_event/i);
assert.match(migration, /cnyos_staging_internal\.edit_staging_test_case/i);
assert.match(migration, /cnyos_staging_internal\.remove_staging_test_case/i);
assert.match(migration, /cnyos_staging_internal\.restore_staging_test_case/i);
assert.match(migration, /security invoker/i);
assert.match(migration, /auth\.uid\(\)/i);
assert.match(migration, /public\.has_role\(array\['super_admin','admin'\]\)/i);
assert.doesNotMatch(migration, /insert into public\.(patients|encounters|ttm_structured_diagnoses|ttm_diagnostic_contexts|audit_logs)\b/i);
assert.doesNotMatch(migration, /create or replace function public\.[\s\S]*?security definer/i);
for (const item of buffer.cases) {
  assert.match(migration, new RegExp(`'${item.id}'`));
  assert.match(item.symptom, /staging-only not-for-clinical-use/i);
}

console.log('Staging test-case buffer contract passed: five isolated cases, RLS, role-checked edit, soft-delete and append-only events');
