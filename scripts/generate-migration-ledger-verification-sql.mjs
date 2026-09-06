import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildMigrationLedgerSchemaGuardSql,
  loadMigrationEntries
} from './generate-migration-ledger-repair-sql.mjs';
import { validateTenantConfig } from './generate-tenant-config.mjs';

export const verificationNoticePrefix = 'CNYOS_STAGING_SCHEMA_GUARD_PASSED ';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ledgerGuardTerminator = 'end\n$ledger_guard$;\n';

export function buildMigrationLedgerVerificationSql({
  config,
  entries = loadMigrationEntries(root),
  sourceRevision = ''
}) {
  const target = validateTenantConfig(config);
  const guardSql = buildMigrationLedgerSchemaGuardSql({
    config: target,
    entries,
    sourceRevision
  });
  const guardEnd = guardSql.indexOf(ledgerGuardTerminator);
  if (guardEnd < 0) {
    throw new Error('Generated schema SQL does not contain the expected guard terminator');
  }

  const evidence = {
    status: 'CNYOS_STAGING_SCHEMA_GUARD_PASSED',
    deployment_id: target.deploymentId,
    clinic_code: target.tenant.expectedClinicCode,
    clinic_id: target.tenant.expectedClinicId,
    project_ref: new URL(target.database.url).hostname.split('.')[0],
    migration_count: entries.length,
    source_revision: String(sourceRevision).trim().toLowerCase(),
    rollback_required: true
  };

  // Emit only inside the successful guard. A caller must also observe ROLLBACK
  // before accepting verification evidence; the notice alone is provisional.
  return guardSql.slice(0, guardEnd) +
    `  raise notice '%', ${quote(verificationNoticePrefix + JSON.stringify(evidence))};\n` +
    ledgerGuardTerminator +
    `rollback;\n`;
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
