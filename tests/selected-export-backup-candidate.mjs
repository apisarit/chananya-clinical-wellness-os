// Actual SQL projection plus encrypted contract. No provider/database credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createPriceMasterFixture} from './helpers/price-master-fixture.mjs';
import {BACKUP_DOMAINS,backupSchemaContract,encryptBackup,verifyBackupSet} from '../netlify/functions/_shared/database-backup.mjs';
import {compareRestoreHashes} from '../scripts/restore-count-comparison.mjs';
const {db,ids,asOwner,asUser,asService,asAnon}=await createPriceMasterFixture();
const version='2026-09-27.3';
const trace=async clinic=>(await asService('select public.verify_clinic_restore_trace($1) value',[clinic])).rows[0].value;
const exporter=async (clinic,domain)=>(await asService('select public.export_clinic_backup_domain($1,$2) value',[clinic,domain])).rows[0].value;
try {
  for(const [file,code] of [
    ['clinical_amendment_recovery_candidate.sql','CLINICAL_AMENDMENT_RECOVERY_REVIEW_REQUIRED'],
    ['clinical_amendment_backup_candidate.sql','CLINICAL_AMENDMENT_BACKUP_REVIEW_REQUIRED'],
    ['selected_patient_export_audit_candidate.sql','SELECTED_EXPORT_AUDIT_REVIEW_REQUIRED'],
    ['selected_export_backup_candidate.sql','SELECTED_EXPORT_BACKUP_REVIEW_REQUIRED']
  ]){
    const source=await fs.readFile(new URL(`../supabase/manual/${file}`,import.meta.url),'utf8');
    const blocker=`do $$ begin raise exception '${code}'; end $$;`;
    assert.equal(source.split(blocker).length,2);
    await asOwner('select 1');await assert.rejects(db.exec(source),new RegExp(code));await db.exec('rollback');
    const candidate=source.replace(blocker,'-- Disposable test-only installation.');
    if(file==='selected_export_backup_candidate.sql'){
      assert.equal((await trace(ids.clinicA)).schema_version,'2026-09-27.2');
      await asOwner('select 1');await db.exec(candidate.replace(/commit;\s*$/i,'rollback;'));
      assert.equal((await trace(ids.clinicA)).schema_version,'2026-09-27.2');
    }
    await asOwner('select 1');await db.exec(candidate);
  }
  const patient=(await asOwner(`select id from public.patients where clinic_id='${ids.clinicA}' limit 1`)).rows[0].id;
  await asOwner(`insert into cnyos_export_internal.permissions(clinic_id,actor_id,active,policy_reference)
    values('${ids.clinicA}','${ids.userA}',true,'SYN-A-EXPORT'),('${ids.clinicB}','${ids.userB}',true,'SYN-B-EXPORT')`);
  await asOwner('grant usage on schema cnyos_export_internal to authenticated');
  await asOwner('grant execute on function cnyos_export_internal.prepare_patients(uuid[],text) to authenticated');
  await asUser(ids.userA,'select cnyos_export_internal.prepare_patients($1,$2)',[[patient],'json']);
  await asOwner(`update cnyos_export_internal.permissions set active=false where clinic_id='${ids.clinicA}'`);
  const exported={};for(const domain of BACKUP_DOMAINS)exported[domain]=await exporter(ids.clinicA,domain);
  const audit=exported.transactions.data;
  assert.equal(audit['cnyos_export_internal.permissions'].length,1);
  assert.equal(audit['cnyos_export_internal.permissions'][0].active,false);
  assert.equal(audit['cnyos_export_internal.permission_events'].length,2);
  assert.equal(audit['cnyos_export_internal.preparation_events'].length,1);
  assert.ok(!JSON.stringify(audit).includes('SYN-B-EXPORT'));
  const b=(await exporter(ids.clinicB,'transactions')).data;
  assert.equal(b['cnyos_export_internal.permission_events'].length,1);
  assert.equal(b['cnyos_export_internal.preparation_events'].length,0);
  assert.ok(!JSON.stringify(b).includes('SYN-A-EXPORT'));
  const health=(await asService('select * from public.backup_restore_contract_healthcheck()')).rows[0];
  assert.equal(health.schema_version,version);assert.equal(health.transaction_table_count,Object.keys(audit).length);
  const key=Buffer.alloc(32,51);
  const envelopes=BACKUP_DOMAINS.map(domain=>encryptBackup(exported[domain],key,{
    environment:'restore-test',deploymentId:'synthetic-export-backup',sourceRevision:'c'.repeat(40),
    clinicId:ids.clinicA,clinicCode:'SYNTHETIC',domain,slot:'2026-09-27T00:00:00Z'
  }).envelope);
  assert.throws(()=>verifyBackupSet(envelopes,key),/SCHEMA_VERSION_INVALID/);
  assert.throws(()=>verifyBackupSet(envelopes,key,{schemaVersion:'2026-09-27.2'}),/SCHEMA_VERSION_INVALID/);
  const evidence=verifyBackupSet(envelopes,key,{schemaVersion:version});
  const before=await trace(ids.clinicA);
  assert.equal(Object.keys(compareRestoreHashes(evidence,before.table_sha256,backupSchemaContract(version).hashed)).length,17);
  await db.exec("set timezone='America/Los_Angeles';set datestyle='SQL, DMY'");
  assert.deepEqual((await trace(ids.clinicA)).table_sha256,before.table_sha256);
  for(const runner of [asAnon,sql=>asUser(ids.superAdmin,sql)])
    await assert.rejects(runner(`select public.export_clinic_backup_domain('${ids.clinicA}','transactions')`),/permission denied/);
  for(const statement of [`select cnyos_export_internal.backup_projection('${ids.clinicA}')`,
    `select public.export_clinic_backup_domain_pre_export_audit('${ids.clinicA}','transactions')`,
    `select public.verify_clinic_restore_trace_pre_export_audit('${ids.clinicA}')`])
    await assert.rejects(asService(statement),/permission denied/);
  for(const mutation of [
    `update cnyos_export_internal.permission_events set after_state=jsonb_set(after_state,'{clinic_id}',to_jsonb('${ids.clinicB}'::text)) where clinic_id='${ids.clinicA}'`,
    `update cnyos_export_internal.permission_events set after_state=after_state-'actor_id' where clinic_id='${ids.clinicA}'`,
    `update cnyos_export_internal.preparation_events set clinic_id='${ids.clinicB}'`
  ]){
    await asOwner('select 1');await db.exec('begin;alter table cnyos_export_internal.permission_events disable trigger user;alter table cnyos_export_internal.preparation_events disable trigger user;');
    await db.exec(mutation);await db.exec("set local request.jwt.claim.role='service_role'");
    await assert.rejects(db.query('select public.verify_clinic_restore_trace($1)',[ids.clinicA]),/BACKUP_EXPORT_AUDIT_INTEGRITY_ANOMALY/);
    await db.exec('rollback');assert.deepEqual((await trace(ids.clinicA)).table_sha256,before.table_sha256);
  }
  await asOwner('select 1');await db.exec('begin;alter table cnyos_export_internal.preparation_events disable trigger user;');
  await db.exec("update cnyos_export_internal.preparation_events set requested_format='csv';set local request.jwt.claim.role='service_role'");
  const damaged=(await db.query('select public.verify_clinic_restore_trace($1) value',[ids.clinicA])).rows[0].value;
  assert.throws(()=>compareRestoreHashes(evidence,damaged.table_sha256,backupSchemaContract(version).hashed),/content hash mismatch/);
  await db.exec('rollback');
  console.log('Selected-export backup candidate passed: guarded additive version, rollback, populated tenant-scoped permission/preparation history, 17 content hashes, explicit encryption version, private ACL, timezone stability and corruption refusal. Isolated SQL/encryption only.');
}finally{await db.close();}
