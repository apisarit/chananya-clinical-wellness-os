import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildMigrationLedgerVerificationSql
} from '../scripts/generate-migration-ledger-verification-sql.mjs';
import {
  loadMigrationEntries
} from '../scripts/generate-migration-ledger-repair-sql.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entries = loadMigrationEntries(root);
const revision = '2ebadf8f029da9febcba24b8335fd1c0275be964';

assert.equal(entries.length, 45, 'verification must bind to the current 45-file migration chain');

for (const configFile of [
  'config/tenant.cnyos-staging.json',
  'config/tenant.jitarsa-staging.json'
]) {
  const config = JSON.parse(fs.readFileSync(path.join(root, configFile), 'utf8'));
  const sql = buildMigrationLedgerVerificationSql({
    config,
    entries,
    sourceRevision: revision
  });

  assert.match(sql, /^-- Generated one-time staging migration ledger recovery\./);
  assert.match(sql, /select pg_advisory_xact_lock\(202608302100::bigint\)/);
  assert.match(sql, /do \$ledger_guard\$/);
  assert.match(sql, /end\n\$ledger_guard\$;\nrollback;/);
  assert.match(sql, /CNYOS_STAGING_SCHEMA_FINGERPRINT_VERIFIED/);
  assert.match(sql, new RegExp(`'deployment_id','${config.deploymentId}'`));
  assert.match(sql, new RegExp(`'clinic_code','${config.tenant.expectedClinicCode}'`));
  assert.match(sql, /'migration_count',45/);
  assert.match(sql, new RegExp(`'source_revision','${revision}'`));
  assert.match(sql, /'database_mutation_committed',false/);

  assert.doesNotMatch(sql, /create schema if not exists supabase_migrations/i);
  assert.doesNotMatch(sql, /insert into supabase_migrations\.schema_migrations/i);
  assert.doesNotMatch(sql, /comment on table supabase_migrations\.schema_migrations/i);
  assert.doesNotMatch(sql, /\ncommit;\n/i);
}

console.log('Migration ledger verification contract passed: exact-chain schema guards terminate in rollback before ledger mutation');
