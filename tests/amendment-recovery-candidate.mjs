// Local disposable verification only. Never receives a hosted database URL.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import { createPriceMasterFixture } from './helpers/price-master-fixture.mjs';

const {db,ids,asOwner,asUser,asAnon,asService}=await createPriceMasterFixture();
const encounterA='9c000000-0000-4000-8000-000000000001';
const encounterB='9c000000-0000-4000-8000-000000000002';
const requestA='9c000000-0000-4000-8000-000000000003';
const requestB='9c000000-0000-4000-8000-000000000004';
const freshRequest='9c000000-0000-4000-8000-000000000005';
const reason='Synthetic authorized amendment';
const source=await fs.readFile(new URL('../supabase/manual/clinical_amendment_recovery_candidate.sql',import.meta.url),'utf8');
const blocker="do $$ begin raise exception 'CLINICAL_AMENDMENT_RECOVERY_REVIEW_REQUIRED'; end $$;";
assert.equal(source.split(blocker).length,2);
const candidate=source.replace(blocker,'-- Removed in memory for this disposable test only.');
const signoff=async encounter=>(await asOwner(`select * from public.clinical_record_signoffs where encounter_id=$1`,[encounter])).rows[0];
// The fixture helper forwards query parameters, keeping runtime-shaped values out
// of SQL text; setup identities below are fixed synthetic constants.
const callSql='select public.unlock_clinical_record_for_amendment_v2($1,$2,$3,$4,$5) as receipt';
const readSql='select public.read_clinical_amendment_receipt($1) as receipt';
const invoke=(actor,key,encounter,row,note=reason)=>asUser(actor,callSql,[key,encounter,row.id,String(row.signature_generation),note]);
const auditCount=async () => Number((await asOwner(`select count(*) n from public.clinical_record_audit_events where event_type='UNLOCK_FOR_AMENDMENT' and encounter_id in ($1,$2)`,[encounterA,encounterB])).rows[0].n);
const signatureCatalog=async ()=>(await asOwner(`select pg_get_functiondef('public.unlock_clinical_record_for_amendment(uuid,text)'::regprocedure) body,
  (select proacl::text from pg_proc where oid='public.unlock_clinical_record_for_amendment(uuid,text)'::regprocedure) acl,
  (select relacl::text from pg_class where oid='public.clinical_record_signoffs'::regclass) table_acl`)).rows;
try {
  await asOwner('select 1');
  await db.exec(`
    update public.profiles set role='admin' where id='${ids.userB}';
    update public.clinic_memberships set active=false where profile_id='${ids.userB}' and clinic_id='${ids.clinicA}';
    update public.clinic_memberships set clinic_role='admin' where profile_id='${ids.userB}' and clinic_id='${ids.clinicB}';
    insert into public.patients(hn,first_name,last_name,clinic_id,created_by)
      values('SYN-AMEND-PATIENT-B','Synthetic','Clinic B','${ids.clinicB}','${ids.userB}');
    insert into public.encounters(id,encounter_no,patient_id,clinic_id,status,practitioner_id)
      select '${encounterA}','SYN-AMEND-A',id,'${ids.clinicA}','draft','${ids.userA}' from public.patients where clinic_id='${ids.clinicA}' limit 1;
    insert into public.encounters(id,encounter_no,patient_id,clinic_id,status,practitioner_id)
      select '${encounterB}','SYN-AMEND-B',id,'${ids.clinicB}','draft','${ids.userB}' from public.patients where clinic_id='${ids.clinicB}' limit 1;
    insert into public.ttm_structured_diagnoses(encounter_id,analysis_summary,thai_diagnosis,diagnosed_by)
      values('${encounterA}','Synthetic analysis','Synthetic diagnosis','${ids.userA}');
    insert into public.clinical_treatment_plans(encounter_id,goal_1,planned_by)
      values('${encounterA}','Synthetic goal','${ids.userA}');
    insert into public.clinical_record_signoffs(encounter_id,record_section,signer_id,signer_name,lock_record)
      values('${encounterA}','complete_record','${ids.userA}','Synthetic A',true),
      ('${encounterB}','complete_record','${ids.userB}','Synthetic B',true);
  `);
  const oldA=await signoff(encounterA),oldB=await signoff(encounterB),oldCatalog=await signatureCatalog();
  assert.ok(oldA&&oldB,'both clinics need populated records for a meaningful isolation test');
  await asOwner('select 1');
  await assert.rejects(db.exec(source),/CLINICAL_AMENDMENT_RECOVERY_REVIEW_REQUIRED/);
  await db.exec('rollback');
  assert.equal((await asOwner("select to_regnamespace('cnyos_amendment_internal') value")).rows[0].value,null);
  assert.deepEqual(await signatureCatalog(),oldCatalog);
  await db.exec(candidate.replace(/commit;\s*$/i,'rollback;'));
  assert.deepEqual(await signatureCatalog(),oldCatalog,'rollback restores legacy definition and ACL');
  assert.deepEqual(await signoff(encounterA),oldA,'rollback preserves populated signoff');
  await db.exec(candidate);
  let rowA=await signoff(encounterA),rowB=await signoff(encounterB);
  const {signature_generation:genA,...preservedA}=rowA;
  const {signature_generation:genB,...preservedB}=rowB;
  assert.equal(String(genA),'1');assert.equal(String(genB),'1');
  assert.deepEqual(preservedA,oldA);assert.deepEqual(preservedB,oldB);

  for(const role of ['anon','authenticated','service_role']) {
    const acl=(await asOwner(`select has_function_privilege($1,'public.unlock_clinical_record_for_amendment(uuid,text)','EXECUTE') legacy,
      has_function_privilege($1,'public.unlock_clinical_record_for_amendment_v2(uuid,uuid,uuid,bigint,text)','EXECUTE') versioned`,[role])).rows[0];
    assert.equal(acl.legacy,false);assert.equal(acl.versioned,role==='authenticated');
  }
  await assert.rejects(asUser(ids.superAdmin,'select public.unlock_clinical_record_for_amendment($1,$2)',[encounterA,reason]),/permission denied/);
  await assert.rejects(asOwner('select public.unlock_clinical_record_for_amendment($1,$2)',[encounterA,reason]),/AMENDMENT_VERSIONED_REQUEST_REQUIRED/);
  await assert.rejects(asAnon(callSql,[requestA,encounterA,rowA.id,'1',reason]),/permission denied/);
  await assert.rejects(asService(callSql,[requestA,encounterA,rowA.id,'1',reason]),/permission denied/);
  await assert.rejects(asAnon(readSql,[requestA]),/permission denied/);
  await assert.rejects(asService(readSql,[requestA]),/permission denied/);
  await assert.rejects(asUser(ids.userA,readSql,[requestA]),/PERMISSION_DENIED/);
  assert.equal((await asUser(ids.superAdmin,readSql,[requestA])).rows[0].receipt,null);
  await assert.rejects(invoke(ids.userA,requestA,encounterA,rowA),/PERMISSION_DENIED/);
  await assert.rejects(asUser(ids.superAdmin,'delete from public.clinical_record_signoffs where id=$1',[rowA.id]),/permission denied/);
  for(const sql of ['select * from cnyos_amendment_internal.receipts',
    "update cnyos_amendment_internal.receipts set reason='tampered'",'delete from cnyos_amendment_internal.receipts',
    'truncate cnyos_amendment_internal.receipts']) await assert.rejects(asUser(ids.superAdmin,sql),/permission denied/);

  assert.deepEqual((await asUser(ids.userB,"select public.current_clinic_id() clinic,public.is_admin_or_super() admin")).rows[0],{clinic:ids.clinicB,admin:true});
  await assert.rejects(invoke(ids.superAdmin,requestA,encounterB,rowB),/SIGNED_RECORD_NOT_FOUND/);
  await assert.rejects(invoke(ids.userB,requestA,encounterA,rowA),/SIGNED_RECORD_NOT_FOUND/);
  for(const values of [[null,encounterA,rowA.id,'1',reason],[requestA,encounterA,rowA.id,'0',reason],
    [requestA,encounterA,rowA.id,'1','tiny'],[requestA,encounterA,rowA.id,'1','x'.repeat(2001)]]) {
    await assert.rejects(asUser(ids.superAdmin,callSql,values),/AMENDMENT_INPUT_INVALID/);
  }
  const receiptA=(await invoke(ids.superAdmin,requestA,encounterA,rowA)).rows[0].receipt;
  assert.equal(receiptA.signature_generation,'1');assert.equal(receiptA.unlocked,true);
  assert.equal(receiptA.actor_id,ids.superAdmin);assert.equal(receiptA.clinic_id,ids.clinicA);
  assert.equal(receiptA.reason_digest,createHash('sha256').update(reason).digest('hex'));
  assert.equal(JSON.stringify(receiptA).includes(reason),false,'readback must not return clinical reason text');
  assert.deepEqual((await asUser(ids.superAdmin,readSql,[requestA])).rows[0].receipt,receiptA);
  assert.equal((await asUser(ids.owner,readSql,[requestA])).rows[0].receipt,null,'another governance actor cannot read the receipt');
  assert.equal((await asUser(ids.userB,readSql,[requestA])).rows[0].receipt,null,'other clinic cannot read the receipt');
  assert.equal((await signoff(encounterA)).lock_record,false);
  assert.equal(await auditCount(),1);
  assert.deepEqual((await invoke(ids.superAdmin,requestA,encounterA,rowA)).rows[0].receipt,receiptA);
  assert.equal(await auditCount(),1);
  assert.equal((await asUser(ids.owner,'select public.is_admin_or_super() allowed')).rows[0].allowed,true);
  await assert.rejects(invoke(ids.owner,requestA,encounterA,rowA),/AMENDMENT_REQUEST_CONFLICT/,'another authorized actor cannot adopt an existing request');
  await assert.rejects(invoke(ids.superAdmin,requestA,encounterA,rowA,'Different synthetic reason'),/AMENDMENT_REQUEST_CONFLICT/);
  await assert.rejects(invoke(ids.superAdmin,freshRequest,encounterA,rowA),/AMENDMENT_ALREADY_UNLOCKED/);
  await assert.rejects(invoke(ids.userB,requestA,encounterB,rowB),/AMENDMENT_REQUEST_CONFLICT/);
  const receiptB=(await invoke(ids.userB,requestB,encounterB,rowB)).rows[0].receipt;
  assert.deepEqual((await invoke(ids.userB,requestB,encounterB,rowB)).rows[0].receipt,receiptB);

  // A receipt is not an authorization cache: revocation is checked on replay.
  await asOwner(`update public.profiles set role='practitioner' where id=$1`,[ids.userB]);
  await asOwner(`update public.clinic_memberships set clinic_role='practitioner' where profile_id=$1 and clinic_id=$2`,[ids.userB,ids.clinicB]);
  await assert.rejects(invoke(ids.userB,requestB,encounterB,rowB),/PERMISSION_DENIED/);
  await assert.rejects(asUser(ids.userB,readSql,[requestB]),/PERMISSION_DENIED/);
  await asOwner(`update public.profiles set role='admin' where id=$1`,[ids.userB]);
  await asOwner(`update public.clinic_memberships set clinic_role='admin',active=false where profile_id=$1 and clinic_id=$2`,[ids.userB,ids.clinicB]);
  await assert.rejects(invoke(ids.userB,requestB,encounterB,rowB),/CNYOS_SUBSCRIPTION_SUSPENDED/);
  await assert.rejects(asUser(ids.userB,readSql,[requestB]),/CNYOS_SUBSCRIPTION_SUSPENDED/);
  await asOwner(`update public.clinic_memberships set active=true where profile_id=$1 and clinic_id=$2`,[ids.userB,ids.clinicB]);

  const sign=()=>asUser(ids.userA,'select * from public.sign_clinical_record_complete($1,$2,null,$3)',[encounterA,'Synthetic A','Synthetic re-sign']);
  await db.exec('begin');
  const signed1=(await sign()).rows[0],signed2=(await sign()).rows[0];
  await db.exec('commit');
  assert.equal(signed1.id,signed2.id);assert.equal(String(signed1.signed_at),String(signed2.signed_at));
  assert.equal(Number(signed2.signature_generation),Number(signed1.signature_generation)+1);
  assert.deepEqual((await invoke(ids.superAdmin,requestA,encounterA,rowA)).rows[0].receipt,receiptA);
  assert.equal((await signoff(encounterA)).lock_record,true,'old receipt cannot unlock the new signature');
  await assert.rejects(invoke(ids.superAdmin,freshRequest,encounterA,rowA),/AMENDMENT_SIGNATURE_STALE/);

  // Force the final receipt insert to fail: audit and unlock must both roll back.
  await asOwner('select 1');
  await db.exec(`create function cnyos_amendment_internal.synthetic_fail() returns trigger language plpgsql as $$ begin raise exception 'SYNTHETIC_RECEIPT_FAILURE'; end $$;
    create trigger synthetic_receipt_failure before insert on cnyos_amendment_internal.receipts for each row execute function cnyos_amendment_internal.synthetic_fail();`);
  const beforeFailure=await auditCount();
  await assert.rejects(invoke(ids.superAdmin,freshRequest,encounterA,signed2),/SYNTHETIC_RECEIPT_FAILURE/);
  assert.equal((await signoff(encounterA)).lock_record,true);assert.equal(await auditCount(),beforeFailure);
  await asOwner('drop trigger synthetic_receipt_failure on cnyos_amendment_internal.receipts');
  assert.equal((await invoke(ids.superAdmin,freshRequest,encounterA,signed2)).rows[0].receipt.unlocked,true);
  for(const sql of ["update cnyos_amendment_internal.receipts set reason='tampered'",'delete from cnyos_amendment_internal.receipts','truncate cnyos_amendment_internal.receipts'])
    await assert.rejects(asOwner(sql),/AMENDMENT_RECEIPT_IMMUTABLE/);

  const state=(await asOwner('select subscription_version from public.clinics where id=$1',[ids.clinicA])).rows[0];
  await asOwner(`select public.set_clinic_subscription_state('9c000000-0000-4000-8000-000000000006',$1,'CHANANYA',false,$2,'Synthetic amendment OFF test',$3,'owner@example.test')`,[ids.clinicA,state.subscription_version,ids.owner]);
  await assert.rejects(invoke(ids.superAdmin,requestA,encounterA,rowA),/CNYOS_SUBSCRIPTION_SUSPENDED/);
  await assert.rejects(asUser(ids.superAdmin,readSql,[requestA]),/CNYOS_SUBSCRIPTION_SUSPENDED/);
  console.log('Amendment recovery candidate passed: guarded install/rollback, populated preservation, closed legacy/delete paths, scoped current authorization, replay/version safety, atomic rollback and immutable receipts. Disposable PGlite only; not activated.');
} finally {await db.close();}
