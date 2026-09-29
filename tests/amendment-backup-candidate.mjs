// Isolated SQL/encrypted-contract verification; no hosted target or credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createPriceMasterFixture} from './helpers/price-master-fixture.mjs';
import {BACKUP_DOMAINS,backupSchemaContract,encryptBackup,verifyBackupSet} from '../netlify/functions/_shared/database-backup.mjs';
import {compareRestoreHashes} from '../scripts/restore-count-comparison.mjs';
const {db,ids,asOwner,asUser,asService,asAnon}=await createPriceMasterFixture();
const encounter='9d000000-0000-4000-8000-000000000001';
const request='9d000000-0000-4000-8000-000000000002';
const reason='Synthetic backup amendment';
const version='2026-09-27.2';
const load=async name=>fs.readFile(new URL(`../supabase/manual/${name}`,import.meta.url),'utf8');
const unblock=(source,code)=>{
  const blocker=`do $$ begin raise exception '${code}'; end $$;`;
  assert.equal(source.split(blocker).length,2);
  return source.replace(blocker,'-- Test-only in-memory disposable activation');
};
const trace=async clinic=>(await asService('select public.verify_clinic_restore_trace($1) value',[clinic])).rows[0].value;
const exporter=async (clinic,domain)=>(await asService('select public.export_clinic_backup_domain($1,$2) value',[clinic,domain])).rows[0].value;
try {
  await asOwner('select 1');
  await db.exec(unblock(await load('clinical_amendment_recovery_candidate.sql'),'CLINICAL_AMENDMENT_RECOVERY_REVIEW_REQUIRED'));
  const source=await load('clinical_amendment_backup_candidate.sql');
  await assert.rejects(db.exec(source),/CLINICAL_AMENDMENT_BACKUP_REVIEW_REQUIRED/);
  await db.exec('rollback');
  assert.equal((await trace(ids.clinicA)).schema_version,'2026-09-27.1');
  const candidate=unblock(source,'CLINICAL_AMENDMENT_BACKUP_REVIEW_REQUIRED');
  await db.exec(candidate.replace(/commit;\s*$/i,'rollback;'));
  assert.equal((await trace(ids.clinicA)).schema_version,'2026-09-27.1');
  await db.exec(candidate);
  await asOwner(`insert into public.encounters(id,encounter_no,patient_id,clinic_id,status,practitioner_id)
    select $1,'SYN-AMEND-BACKUP',id,$2,'draft',$3 from public.patients where clinic_id=$2 limit 1`,[encounter,ids.clinicA,ids.userA]);
  await asOwner('insert into public.ttm_structured_diagnoses(encounter_id,analysis_summary,thai_diagnosis,diagnosed_by) values($1,$2,$2,$3)',[encounter,'Synthetic diagnosis',ids.userA]);
  await asOwner('insert into public.clinical_treatment_plans(encounter_id,goal_1,planned_by) values($1,$2,$3)',[encounter,'Synthetic goal',ids.userA]);
  const sign=async ()=>(await asUser(ids.userA,'select * from public.sign_clinical_record_complete($1,$2,null,$3)',[encounter,'Synthetic practitioner','Synthetic signature'])).rows[0];
  const row=await sign();
  const call='select public.unlock_clinical_record_for_amendment_v2($1,$2,$3,$4,$5) value';
  const args=[request,encounter,row.id,String(row.signature_generation),reason];
  const receipt=(await asUser(ids.superAdmin,call,args)).rows[0].value;
  const latest=await sign();
  assert.ok(Number(latest.signature_generation)>Number(row.signature_generation));
  const exported={};
  for(const domain of BACKUP_DOMAINS) exported[domain]=await exporter(ids.clinicA,domain);
  assert.equal(exported.transactions.data['cnyos_amendment_internal.receipts'].length,1);
  assert.equal(exported.patients.data.clinical_record_signoffs[0].signature_generation,String(latest.signature_generation));
  assert.equal(exported.transactions.data['cnyos_amendment_internal.receipts'][0].generation,String(row.signature_generation));
  assert.deepEqual((await exporter(ids.clinicB,'transactions')).data['cnyos_amendment_internal.receipts'],[]);
  const key=Buffer.alloc(32,19);
  const envelopes=BACKUP_DOMAINS.map(domain=>encryptBackup(exported[domain],key,{
    environment:'restore-test',deploymentId:'amendment-synthetic-restore',sourceRevision:'b'.repeat(40),
    clinicId:ids.clinicA,clinicCode:'SYNTHETIC',domain,slot:'2026-09-27T00:00:00Z'
  }).envelope);
  assert.throws(()=>verifyBackupSet(envelopes,key),/SCHEMA_VERSION_INVALID/,'version must be explicitly configured');
  const evidence=verifyBackupSet(envelopes,key,{schemaVersion:version});
  const before=await trace(ids.clinicA);
  assert.equal(Object.keys(compareRestoreHashes(evidence,before.table_sha256,backupSchemaContract(version).hashed)).length,14);
  await db.exec("set timezone='America/Los_Angeles'; set datestyle='SQL, DMY'");
  assert.deepEqual((await trace(ids.clinicA)).table_sha256,before.table_sha256);
  assert.deepEqual((await asUser(ids.superAdmin,call,args)).rows[0].value,receipt);
  assert.deepEqual((await trace(ids.clinicA)).table_sha256,before.table_sha256,'replay does not change protected signature/audit');
  for(const runner of [asAnon,sql=>asUser(ids.superAdmin,sql)])
    await assert.rejects(runner(`select public.export_clinic_backup_domain('${ids.clinicA}','transactions')`),/permission denied/);
  for(const sql of [`select cnyos_amendment_internal.backup_projection('${ids.clinicA}')`,
    `select public.export_clinic_backup_domain_pre_amendment('${ids.clinicA}','transactions')`,
    `select public.verify_clinic_restore_trace_pre_amendment('${ids.clinicA}')`]) await assert.rejects(asService(sql),/permission denied/);

  // Same-count reason/result corruption, erased receipt, wrong-tenant and audit
  // damage must never be exported as a valid new recovery point.
  const corruptions=[
    "update cnyos_amendment_internal.receipts set result=result-'actor_id'",
    `update cnyos_amendment_internal.receipts set clinic_id='${ids.clinicB}'`,
    'delete from cnyos_amendment_internal.receipts',
    `delete from public.clinical_record_audit_events where details->>'request_id'='${request}'`
  ];
  for(const mutation of corruptions) {
    await asOwner('select 1');
    await db.exec('begin; alter table cnyos_amendment_internal.receipts disable trigger user;');
    await db.exec(mutation);
    // Direct owner call sets service JWT without SET ROLE/reset obscuring error.
    await db.exec("set local request.jwt.claim.role='service_role'");
    await assert.rejects(db.query('select public.verify_clinic_restore_trace($1)',[ids.clinicA]),/BACKUP_AMENDMENT_INTEGRITY_ANOMALY/);
    await db.exec('rollback');
    assert.deepEqual((await trace(ids.clinicA)).table_sha256,before.table_sha256);
  }
  await asOwner('select 1');
  await db.exec('begin; alter table public.clinical_record_signoffs disable trigger user;');
  await db.query('update public.clinical_record_signoffs set signature_generation=signature_generation+1 where id=$1',[row.id]);
  const altered=(await db.query("select set_config('request.jwt.claim.role','service_role',true)")).rows;
  assert.ok(altered);
  const damaged=(await db.query('select public.verify_clinic_restore_trace($1) value',[ids.clinicA])).rows[0].value;
  assert.throws(()=>compareRestoreHashes(evidence,damaged.table_sha256,backupSchemaContract(version).hashed),/content hash mismatch/);
  await db.exec('rollback');
  await asOwner('select 1');
  await db.exec('begin; alter table public.clinical_record_signoffs disable trigger user;');
  await db.query("update public.clinical_record_signoffs set signature_generation=9007199254740993 where id=$1",[row.id]);
  await db.exec("set local request.jwt.claim.role='service_role'");
  const large=(await db.query("select public.export_clinic_backup_domain($1,'patients') value",[ids.clinicA])).rows[0].value;
  assert.equal(large.data.clinical_record_signoffs[0].signature_generation,'9007199254740993');
  await db.exec('rollback');
  console.log('Amendment backup candidate passed: guarded install/rollback, private receipt export, generation/audit hashes, encrypted v4 contract, explicit version, role/tenant denial, stable replay/timezone and corruption rejection. Disposable SQL only.');
} finally {await db.close();}
