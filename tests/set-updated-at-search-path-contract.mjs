import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(
  path.join(root, 'supabase/migrations/202608010300_relational_clinical_pharmacy_billing.sql'),
  'utf8'
);
const remediation = fs.readFileSync(
  path.join(root, 'supabase/manual/20260917140000_harden_set_updated_at_search_path.sql'),
  'utf8'
);

assert.match(source, /create or replace function public\.set_updated_at\(\)[\s\S]{0,260}security invoker/i);
assert.match(remediation, /alter function public\.set_updated_at\(\)[\s\S]{0,160}set search_path\s*=\s*pg_catalog\s*,\s*public/i);
assert.doesNotMatch(remediation, /security definer/i);
assert.match(remediation, /begin;[\s\S]*commit;/i);

console.log('set_updated_at search-path contract passed: invoker trigger path pinned for staging remediation');
