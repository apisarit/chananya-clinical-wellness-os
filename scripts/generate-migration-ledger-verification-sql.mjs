import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildMigrationLedgerRepairSql,
  loadMigrationEntries
} from './generate-migration-ledger-repair-sql.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ledgerGuardTerminator = 'end\n$ledger_guard$;\n';

export function buildMigrationLedgerVerificationSql({
  config,
  entries = loadMigrationEntries(root),
  sourceRevision = ''
}) {
  const repairSql = buildMigrationLedgerRepairSql({
    config,
    entries,
    sourceRevision
  });
  const guardEnd = repairSql.indexOf(ledgerGuardTerminator);
  if (guardEnd < 0) {
    throw new Error('Generated ledger repair SQL does not contain the expected guard terminator');
  }

  const guardedPrefix = repairSql.slice(0, guardEnd + ledgerGuardTerminator.length);
  const revision = String(sourceRevision || '').trim().toLowerCase() || 'not-supplied';
  const deploymentId = String(config?.deploymentId || '').trim();
  const clinicCode = String(config?.tenant?.expectedClinicCode || '').trim();

  return guardedPrefix +
    `rollback;\n\n` +
    `select jsonb_build_object(\n` +
    `  'status','CNYOS_STAGING_SCHEMA_FINGERPRINT_VERIFIED',\n` +
    `  'deployment_id',${quote(deploymentId)},\n` +
    `  'clinic_code',${quote(clinicCode)},\n` +
    `  'migration_count',${entries.length},\n` +
    `  'source_revision',${quote(revision)},\n` +
    `  'database_mutation_committed',false\n` +
    `) as migration_ledger_verification_evidence;\n`;
}

function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function main() {
  const source = process.argv[2] || process.env.CLINICAL_OS_TENANT_CONFIG_PATH;
  if (!source) {
    throw new Error('Pass an explicit staging tenant config path');
  }
  const configPath = path.resolve(root, source);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  process.stdout.write(buildMigrationLedgerVerificationSql({
    config,
    entries: loadMigrationEntries(root),
    sourceRevision: process.env.CLINICAL_OS_SOURCE_COMMIT || ''
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
