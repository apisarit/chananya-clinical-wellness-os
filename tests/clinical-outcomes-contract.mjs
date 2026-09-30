import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const migration = read('supabase/migrations/202608270800_clinical_outcomes_analytics.sql');
const source = read('outcomes.js');
const html = read('outcomes.html');
const shell = read('app-shell.js');

assert.doesNotThrow(() => new vm.Script(source, { filename: 'outcomes.js' }), 'outcomes controller should parse');
assert.match(migration, /create or replace function public\.clinical_outcomes_summary\(/i, 'summary must be server-owned');
assert.match(migration, /create or replace function public\.search_clinical_outcomes\(/i, 'search must be server-owned');
assert.equal((migration.match(/security definer/gi) || []).length, 2, 'both outcome RPCs must own their authorization boundary');
assert.equal((migration.match(/public\.department_can\('clinical'\)/g) || []).length, 2, 'both outcome RPCs must require the clinical department');
assert.equal((migration.match(/encounter\.clinic_id = v_clinic_id/g) || []).length, 2, 'both outcome queries must be explicitly tenant-bound');
assert.match(migration, /v_to - v_from > interval '5 years'/, 'analytics must cap date ranges');
assert.match(migration, /least\(greatest\(coalesce\(p_limit, 100\), 1\), 200\)/, 'search must cap returned rows');
assert.match(migration, /encounter\.status not in \('cancelled','void'\)/, 'void and cancelled encounters must be excluded');
assert.match(migration, /clinical_followup_notes[\s\S]*?order by note\.followup_date desc/, 'search must expose the latest follow-up evidence');
assert.match(migration, /inventory_lots lot[\s\S]*?lot\.clinic_id = v_clinic_id/, 'herbal lot search must remain tenant-bound');
assert.match(migration, /array_to_string\(trace\.lot_numbers/, 'search must include dispensed herbal lots');
assert.match(migration, /revoke all on function public\.clinical_outcomes_summary/, 'public execution must be revoked');
assert.match(migration, /grant execute on function public\.search_clinical_outcomes[\s\S]*?to authenticated/, 'authenticated users may call the guarded RPC');

assert.match(source, /rpc\('clinical_outcomes_summary'/, 'UI must use the summary RPC');
assert.match(source, /rpc\('search_clinical_outcomes'/, 'UI must use the search RPC');
assert.doesNotMatch(source, /\.from\s*\(/, 'UI must not bypass the outcome RPC with direct patient table reads');
assert.doesNotMatch(source, /\.insert\s*\(|\.update\s*\(|\.delete\s*\(|localStorage|sessionStorage/, 'outcomes must remain read-only and database-backed');
assert.match(html, /Practitioner\/Doctor และ Super Admin/, 'page must disclose its clinical role boundary');
assert.match(shell, /href: '\/outcomes\.html'[\s\S]*?capability: 'clinical_read'/, 'shared shell must enforce clinical read capability');

console.log('Clinical outcomes contract passed: tenant-bound read-only RPCs and role boundary');
