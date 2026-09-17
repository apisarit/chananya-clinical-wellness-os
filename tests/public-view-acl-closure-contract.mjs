import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(
  'supabase/manual/20260917170000_revoke_public_view_acl_staging.sql',
  'utf8',
);

assert.match(migration, /staging-only view ACL closure/i);
assert.match(migration, /revoke all on table[\s\S]+from public, anon;/i);
assert.match(migration, /grant select on table[\s\S]+to authenticated;/i);
for (const view of [
  'admin_task_summary',
  'available_practitioner_schedules',
  'user_access_summary',
  'v_clinical_herbal_traceability',
  'v_ttm_dkr_v1_review_coverage',
  'v_ttm_foundation_coverage',
  'v_ttm_foundation_graph',
]) {
  assert.match(migration, new RegExp(`public\\.${view}\\b`), `missing ${view}`);
}
assert.doesNotMatch(migration, /grant\s+(?:select|insert|update|delete|all)[\s\S]+to\s+(?:public|anon)/i);

console.log('public view ACL closure contract passed: staging-only PUBLIC/anon revoke preserves authenticated reads');
