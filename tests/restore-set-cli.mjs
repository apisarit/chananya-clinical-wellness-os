import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BACKUP_DOMAINS, backupSchemaContract, encryptBackup } from '../netlify/functions/_shared/database-backup.mjs';

for(const version of ['2026-09-26.2','2026-09-27.1','2026-09-27.2','2026-09-27.3']) {
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cnyos-restore-cli-synthetic-'));
const contract=backupSchemaContract(version);
const key=Buffer.alloc(32,37); // Synthetic fixture key, never a provider credential.
const cli=new URL('../scripts/verify-restore-set.mjs',import.meta.url);
const run=expected=>spawnSync(process.execPath,[cli.pathname,directory],{
  encoding:'utf8',env:{PATH:process.env.PATH,BACKUP_ENCRYPTION_KEY_BASE64:key.toString('base64'),
    ...(expected ? {RESTORE_EXPECTED_SCHEMA_VERSION:expected}:{})}
});
try {
  for(const domain of BACKUP_DOMAINS) {
    const data=Object.fromEntries(contract.required[domain].map(table=>[table,[]]));
    const payload={format:'chananya-domain-export/v1',schema_version:version,
      clinic_id:'10000000-0000-4000-a000-000000000001',domain,
      exported_at:'2026-09-26T00:00:00.000Z',data,included_tables:Object.keys(data),
      filtered_tables:{},excluded_tables:[],
      recovery_model:{full_database_restore:'managed database backup or PITR required'},
      table_sha256:Object.fromEntries(contract.hashed[domain].map(table=>[table,'a'.repeat(64)]))};
    const {envelope}=encryptBackup(payload,key,{environment:'restore-test',deploymentId:'synthetic-restore-test',
      sourceRevision:'a'.repeat(40),clinicId:payload.clinic_id,clinicCode:'SYNTHETIC',domain,
      slot:'2026-09-26T00:00:00.000Z'});
    await fs.writeFile(path.join(directory,`${domain}.cdb.json.enc`),JSON.stringify(envelope),{mode:0o600});
  }
  const accepted=run(version);
  assert.equal(accepted.status,0,accepted.stderr);
  const evidence=JSON.parse(accepted.stdout);
  assert.equal(evidence.schema_version,version);
  assert.equal(evidence.domains.transactions.row_counts['cnyos_clarification_internal.tickets'],0);
  for(const expected of [undefined,'unsupported']) {
    const rejected=run(expected);
    assert.equal(rejected.status,1);
    assert.equal(rejected.stdout,'');
    assert.equal(JSON.parse(rejected.stderr).code,'RESTORE_SET_SCHEMA_VERSION_INVALID');
  }
  if(version==='2026-09-27.1') {
    assert.equal(evidence.domains.transactions.row_counts['cnyos_clarification_internal.replacements'],0);
    assert.equal(run('2026-09-26.2').status,1);
  }
  if(version==='2026-09-27.2') {
    assert.equal(evidence.domains.transactions.row_counts['cnyos_amendment_internal.receipts'],0);
    assert.equal(run('2026-09-27.1').status,1);
  }
  if(version==='2026-09-27.3') {
    for(const table of ['permissions','permission_events','preparation_events'])
      assert.equal(evidence.domains.transactions.row_counts[`cnyos_export_internal.${table}`],0);
    assert.equal(run('2026-09-27.2').status,1);
  }
  console.log(`Restore CLI: explicit ${version} accepted; default downgrade and unknown version rejected; synthetic encrypted files only.`);
} finally {
  await fs.rm(directory,{recursive:true,force:true});
}
}
