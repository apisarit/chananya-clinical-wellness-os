import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(
  'supabase/migrations/202609011000_owner_subscription_kill_switch_closure.sql',
  'utf8'
);
const remediation = fs.readFileSync(
  'supabase/manual/20260917130000_revoke_traceability_view_anon.sql',
  'utf8'
);

assert.match(source, /create or replace view public\.v_clinical_herbal_traceability/i);
assert.match(source, /security_invoker\s*=\s*true/i);
assert.match(source, /grant select on public\.v_clinical_herbal_traceability to authenticated/i);
assert.match(remediation, /revoke select on table public\.v_clinical_herbal_traceability from public, anon/i);
assert.match(remediation, /grant select on table public\.v_clinical_herbal_traceability to authenticated/i);
assert.doesNotMatch(remediation, /grant select[\s\S]*\bto\s+(?:public|anon)\b/i);

console.log('Traceability view privilege contract passed: invoker RLS, no PUBLIC/anon read, authenticated read retained');
