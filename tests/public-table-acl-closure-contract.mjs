import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'supabase/manual/20260917150000_revoke_public_table_acl_staging.sql');
const source = fs.readFileSync(file, 'utf8');

assert.match(source, /staging-only ACL closure/i);
assert.match(source, /revoke all on table[\s\S]+from public, anon;/i);
assert.doesNotMatch(source, /grant\s+(?:select|insert|update|delete|all)/i);
for (const table of [
  'clinical_record_audit_events', 'clinical_treatment_plans', 'patient_user_links',
  'ttm_opd_histories', 'ttm_structured_diagnoses'
]) {
  assert.match(source, new RegExp(`public\\.${table}\\b`), `missing ${table} from staging closure`);
}

console.log('public table ACL closure contract passed: staging-only PUBLIC/anon revoke preserves existing authenticated grants');
