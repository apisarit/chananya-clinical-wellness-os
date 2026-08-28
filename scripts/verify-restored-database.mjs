import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { validateTenantConfig } from './generate-tenant-config.mjs';

function required(name, { max = 8192 } = {}) {
  const value = String(process.env[name] || '').trim();
  if (!value || value.length > max) throw new Error(`${name}_REQUIRED`);
  return value;
}

function config(name) {
  return validateTenantConfig(JSON.parse(required(name, { max: 32768 })));
}

function projectOrigin(value) {
  return new URL(value).origin.toLowerCase();
}

function sourceCount(evidence, domain, table) {
  const count = evidence?.domains?.[domain]?.row_counts?.[table];
  assert.equal(Number.isInteger(count) && count >= 0, true, `${domain}.${table}: source count missing`);
  return count;
}

const countBindings = Object.freeze({
  patients: ['patients', 'patients'],
  patient_allergies: ['patients', 'patient_allergies'],
  encounters: ['patients', 'encounters'],
  clinical_record_signoffs: ['patients', 'clinical_record_signoffs'],
  products: ['products', 'products'],
  inventory_lots: ['products', 'inventory_lots'],
  prescriptions: ['pharmacy', 'prescriptions'],
  dispensing_orders: ['pharmacy', 'dispensing_orders'],
  dispensing_items: ['pharmacy', 'dispensing_items'],
  audit_logs: ['transactions', 'audit_logs'],
  invoices: ['transactions', 'invoices'],
  invoice_items: ['transactions', 'invoice_items'],
  payments: ['transactions', 'payments']
});

function safeCode(error) {
  const code = String(error?.message || 'RESTORED_DATABASE_VERIFICATION_FAILED')
    .toUpperCase().replace(/[^A-Z0-9_]+/g, '_').slice(0, 160);
  return code || 'RESTORED_DATABASE_VERIFICATION_FAILED';
}

try {
  if (process.env.RESTORE_DRILL_ACK !== 'ISOLATED_RESTORE_TEST_ONLY') throw new Error('RESTORE_DRILL_ACK_REQUIRED');
  const restore = config('CLINICAL_OS_RESTORE_TEST_CONFIG_JSON');
  const production = config('CLINICAL_OS_PRODUCTION_CONFIG_JSON');
  const marker = /(?:^|[-_.])(restore|test|nonprod)(?:$|[-_.])/i;
  assert.match(restore.deploymentId, marker, 'Restore deployment must be explicitly non-production');
  assert.notEqual(projectOrigin(restore.database.url), projectOrigin(production.database.url), 'Restore database equals Production');

  const evidencePath = path.resolve(required('RESTORE_SET_EVIDENCE_PATH', { max: 1024 }));
  const source = JSON.parse(await fs.readFile(evidencePath, 'utf8'));
  assert.equal(source.valid, true, 'Restore set evidence is not valid');
  assert.equal(source.requires_managed_database_restore, true, 'Recovery model must require a managed restore');
  assert.equal(source.clinic_id, restore.tenant.expectedClinicId, 'Restored clinic does not match the source backup');
  const expectedCommit = String(process.env.RESTORE_EXPECTED_SOURCE_COMMIT || process.env.GITHUB_SHA || '').trim();
  assert.match(expectedCommit, /^[0-9a-f]{40}$/i, 'Exact source commit is required');
  assert.equal(source.source_revision, expectedCommit, 'Backup source revision is not the exact release commit');

  const serviceRoleKey = required('RESTORE_TEST_SUPABASE_SERVICE_ROLE_KEY', { max: 4096 });
  const response = await fetch(`${restore.database.url.replace(/\/$/, '')}/rest/v1/rpc/verify_clinic_restore_trace`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({ p_clinic_id: restore.tenant.expectedClinicId })
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error('RESTORE_TRACE_RPC_FAILED');
  assert.equal(result?.ready, true, 'Restored database integrity check failed');
  assert.equal(result?.schema_version, source.schema_version, 'Restored database schema does not match backup schema');
  assert.equal(result?.clinic_id, source.clinic_id, 'Restored database clinic mismatch');
  assert.equal(result?.referential_integrity_anomalies, 0, 'Restored database contains referential anomalies');

  const comparisons = {};
  for (const [targetTable, [domain, sourceTable]] of Object.entries(countBindings)) {
    const expected = sourceCount(source, domain, sourceTable);
    const actual = Number(result?.counts?.[targetTable]);
    assert.equal(actual, expected, `${targetTable}: restored count ${actual} does not equal source ${expected}`);
    comparisons[targetTable] = { expected, actual };
  }
  if (process.env.RESTORE_EXPECT_COMPLETE_CHAIN === 'true') {
    assert.ok(Number(result.complete_clinical_financial_chains) > 0, 'No complete clinical-financial chain survived restore');
  }

  const restoreStartedAt = new Date(required('RESTORE_STARTED_AT', { max: 40 }));
  assert.equal(Number.isNaN(restoreStartedAt.getTime()), false, 'RESTORE_STARTED_AT is invalid');
  const verifiedAt = new Date();
  assert.ok(restoreStartedAt <= verifiedAt, 'RESTORE_STARTED_AT is in the future');
  const exportedAt = new Date(Math.max(...Object.values(source.domains).map(domain => Date.parse(domain.exported_at))));
  const latestActivityAt = result.latest_activity_at ? new Date(result.latest_activity_at) : null;
  const rpoSeconds = latestActivityAt ? Math.max(0, Math.round((exportedAt - latestActivityAt) / 1000)) : null;
  const rtoSeconds = Math.round((verifiedAt - restoreStartedAt) / 1000);
  const evidence = {
    valid: true,
    format: 'chananya-isolated-restore-drill-evidence/v1',
    source_commit: source.source_revision,
    restore_set_sha256: source.restore_set_sha256,
    source_environment: source.environment,
    restore_deployment_id: restore.deploymentId,
    restore_database_project: new URL(restore.database.url).hostname.split('.')[0],
    clinic_id: result.clinic_id,
    schema_version: result.schema_version,
    managed_restore_change_reference: required('RESTORE_CHANGE_REFERENCE', { max: 200 }),
    verified_at: verifiedAt.toISOString(),
    backup_exported_at: exportedAt.toISOString(),
    latest_restored_activity_at: latestActivityAt?.toISOString() || null,
    measured_rpo_seconds: rpoSeconds,
    measured_rto_seconds: rtoSeconds,
    complete_clinical_financial_chains: result.complete_clinical_financial_chains,
    referential_integrity_anomalies: result.referential_integrity_anomalies,
    count_comparisons: comparisons
  };
  const directory = path.resolve(process.env.RESTORE_EVIDENCE_DIR || 'artifacts/restore-drill');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = path.join(directory, 'isolated-restore-drill.json');
  await fs.writeFile(destination, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`Isolated managed restore drill verified; RPO ${rpoSeconds ?? 'n/a'}s, RTO ${rtoSeconds}s; evidence: ${destination}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ valid: false, code: safeCode(error) })}\n`);
  process.exitCode = 1;
}
