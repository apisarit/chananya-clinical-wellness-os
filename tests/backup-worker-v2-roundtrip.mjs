// Synthetic export and Drive adapters; real worker encryption and restore-set verifier.
// No network, provider credentials, patient data or database import.
import assert from 'node:assert/strict';
import { BACKUP_DOMAINS, backupSchemaContract, decryptBackup, verifyBackupSet } from '../netlify/functions/_shared/database-backup.mjs';
import { runBackupClinicJob } from '../netlify/functions/_shared/database-backup-runtime.mjs';

for (const schemaVersion of ['2026-09-26.2','2026-09-27.1','2026-09-27.2','2026-09-27.3']) {
const contract = backupSchemaContract(schemaVersion);
const clinic = { clinic_id: '10000000-0000-4000-8000-000000000001', clinic_code: 'SYNTHETIC' };
const slot = '2026-09-26T00:00:00.000Z';
const encryptionKey = Buffer.alloc(32, 47);
const folderIds = Object.fromEntries([...BACKUP_DOMAINS, 'manifests'].map(domain => [domain, `synthetic-folder-${domain}`]));
const config = { environment: 'restore-test', deploymentId: 'synthetic-worker-test',
  sourceRevision: 'a'.repeat(40), schemaVersion, hasCompleteEnvFolderIds: true,
  folderIds, expectedDriveRootFolderId: 'synthetic-root-folder' };
const tickets = [{ id: 'synthetic-ticket', status: 'resolved', question: 'Synthetic question only',
  answer: 'Synthetic answer only', snapshot: { items: [{ dose: 'synthetic' }] } }];
const clearances = [{ order_id: 'synthetic-order', ticket_id: 'synthetic-ticket' }];
const replacements = [{ request_id: 'synthetic-replacement', ticket_id: 'synthetic-ticket',
  old_rx_id: 'synthetic-old', new_rx_id: 'synthetic-new', acknowledged_by: 'synthetic-pharmacy',
  old_snapshot: { notes: 'Synthetic original prescription' }, new_snapshot: { notes: 'Synthetic replacement prescription' } }];
const payloads = Object.fromEntries(BACKUP_DOMAINS.map(domain => {
  const data = Object.fromEntries(contract.required[domain].map(table => [table, []]));
  if (domain === 'transactions') {
    data['cnyos_clarification_internal.tickets'] = tickets;
    data['cnyos_clarification_internal.clearances'] = clearances;
    if (schemaVersion !== '2026-09-26.2') data['cnyos_clarification_internal.replacements'] = replacements;
    if (['2026-09-27.2','2026-09-27.3'].includes(schemaVersion)) data['cnyos_amendment_internal.receipts'] = [{request_id:'synthetic-amendment',generation:3,reason:'Synthetic amendment reason'}];
    if (schemaVersion === '2026-09-27.3') for(const table of ['permissions','permission_events','preparation_events'])
      data[`cnyos_export_internal.${table}`]=[{id:`synthetic-${table}`,policy_reference:'Synthetic export policy reference'}];
  }
  return [domain, { format: 'chananya-domain-export/v1', schema_version: schemaVersion,
    clinic_id: clinic.clinic_id, domain, exported_at: slot, data, included_tables: Object.keys(data),
    filtered_tables: {}, excluded_tables: [],
    recovery_model: { full_database_restore: 'managed database backup or PITR required' },
    // SQL canonical hashes are tested separately in the native restore harness.
    table_sha256: Object.fromEntries(contract.hashed[domain].map(table => [table, 'a'.repeat(64)])) }];
}));

async function run({ omitTicket = false, omitReplacement = false, omitAmendment = false, omitExport = null, version = schemaVersion } = {}) {
  const uploaded = [];
  let completion;
  const result = await runBackupClinicJob({ config: { ...config, schemaVersion: version }, clinic, slot,
    requestId: 'synthetic-worker-roundtrip', credentials: { encryptionKey, serviceAccount: {} }, deps: {
      nowMs: () => Date.parse(slot),
      fetchImpl: async () => { throw new Error('TEST_NETWORK_FORBIDDEN'); },
      fetchGoogleAccessToken: async () => 'synthetic-token',
      inspectDriveFolder: async ({ folderId }) => assert.ok(Object.values(folderIds).includes(folderId)),
      rpc: async (_config, name, body) => {
        if (name === 'begin_backup_export_run') return { acquired: true, run_id: '10000000-0000-4000-8000-000000000002' };
        if (name === 'complete_backup_export_run') { completion = body; return {}; }
        assert.equal(name, 'export_clinic_backup_domain');
        assert.equal(body.p_clinic_id, clinic.clinic_id);
        const payload = structuredClone(payloads[body.p_domain]);
        if (omitTicket && body.p_domain === 'transactions') delete payload.data['cnyos_clarification_internal.tickets'];
        if (omitReplacement && body.p_domain === 'transactions') delete payload.data['cnyos_clarification_internal.replacements'];
        if (omitAmendment && body.p_domain === 'transactions') delete payload.data['cnyos_amendment_internal.receipts'];
        if (omitExport && body.p_domain === 'transactions') delete payload.data[`cnyos_export_internal.${omitExport}`];
        return payload;
      },
      upsertDriveFile: async input => {
        uploaded.push({ ...input, bytes: Buffer.from(input.bytes) });
        return { id: `synthetic-file-${uploaded.length}`, operation: 'created' };
      }
    } });
  return { result, completion, uploaded };
}

const ok = await run();
assert.equal(ok.result.status, 'completed');
assert.equal(ok.completion.p_status, 'completed');
assert.equal(ok.uploaded.length, 5);
const encrypted = ok.uploaded.filter(file => file.mimeType !== 'application/json');
const envelopes = encrypted.map(file => JSON.parse(file.bytes.toString()));
const evidence = verifyBackupSet(envelopes, encryptionKey, { schemaVersion });
assert.equal(evidence.domains.transactions.row_counts['cnyos_clarification_internal.tickets'], 1);
assert.equal(evidence.domains.transactions.row_counts['cnyos_clarification_internal.clearances'], 1);
const transactions = envelopes.find(envelope => envelope.metadata.domain === 'transactions');
const restored = decryptBackup(transactions, encryptionKey);
assert.deepEqual(restored.data['cnyos_clarification_internal.tickets'], tickets);
assert.deepEqual(restored.data['cnyos_clarification_internal.clearances'], clearances);
if (schemaVersion !== '2026-09-26.2') {
  assert.deepEqual(restored.data['cnyos_clarification_internal.replacements'], replacements);
  assert.equal(evidence.domains.transactions.row_counts['cnyos_clarification_internal.replacements'],1);
  const missingReplacement = await run({ omitReplacement: true });
  assert.equal(missingReplacement.result.status,'partial');
  assert.equal(missingReplacement.result.failures[0].code,'BACKUP_EXPORT_REQUIRED_TABLE_MISSING');
  assert.ok(!missingReplacement.uploaded.some(file => file.folderId === folderIds.transactions));
  assert.throws(()=>verifyBackupSet(envelopes,encryptionKey,{schemaVersion:'2026-09-26.2'}));
}
if (['2026-09-27.2','2026-09-27.3'].includes(schemaVersion)) {
  assert.deepEqual(restored.data['cnyos_amendment_internal.receipts'],payloads.transactions.data['cnyos_amendment_internal.receipts']);
  const missing = await run({omitAmendment:true});
  assert.equal(missing.result.status,'partial');
  assert.equal(missing.result.failures[0].code,'BACKUP_EXPORT_REQUIRED_TABLE_MISSING');
  assert.ok(!missing.uploaded.some(file=>file.folderId===folderIds.transactions));
  assert.ok(encrypted.every(file=>!file.bytes.includes(Buffer.from('Synthetic amendment reason'))));
  assert.throws(()=>verifyBackupSet(envelopes,encryptionKey,{schemaVersion:'2026-09-27.1'}));
}
if (schemaVersion === '2026-09-27.3') {
  for(const table of ['permissions','permission_events','preparation_events']){
    assert.deepEqual(restored.data[`cnyos_export_internal.${table}`],payloads.transactions.data[`cnyos_export_internal.${table}`]);
    const missing=await run({omitExport:table});
    assert.equal(missing.result.status,'partial');
    assert.equal(missing.result.failures[0].code,'BACKUP_EXPORT_REQUIRED_TABLE_MISSING');
    assert.ok(!missing.uploaded.some(file=>file.folderId===folderIds.transactions));
  }
  assert.ok(encrypted.every(file=>!file.bytes.includes(Buffer.from('Synthetic export policy reference'))));
  assert.throws(()=>verifyBackupSet(envelopes,encryptionKey,{schemaVersion:'2026-09-27.2'}));
}
assert.ok(encrypted.every(file => !file.bytes.includes(Buffer.from('Synthetic question only'))));
const manifest = JSON.parse(ok.uploaded.find(file => file.mimeType === 'application/json').bytes);
assert.equal(manifest.domains.length, 4);
assert.deepEqual(manifest.failures, []);
for (const envelope of envelopes) {
  const record = manifest.domains.find(item => item.domain === envelope.metadata.domain);
  assert.equal(record.plaintext_sha256, envelope.plaintext_sha256);
  assert.equal(record.ciphertext_sha256, envelope.ciphertext_sha256);
}
const missing = await run({ omitTicket: true });
assert.equal(missing.result.status, 'partial');
assert.equal(missing.completion.p_status, 'partial');
assert.equal(missing.result.backedUpDomains, 3);
assert.equal(missing.result.failures[0].code, 'BACKUP_EXPORT_REQUIRED_TABLE_MISSING');
assert.ok(!missing.uploaded.some(file => file.folderId === folderIds.transactions));
const wrongVersion = await run({ version: '2026-09-26.1' });
assert.equal(wrongVersion.result.status, 'failed');
assert.equal(wrongVersion.result.backedUpDomains, 0);
assert.equal(wrongVersion.completion.p_status, 'failed');
console.log(`Backup worker ${schemaVersion}: encrypted bytes roundtrip; clinical history and manifest hashes preserved; incomplete and mismatched exports never completed.`);
}
