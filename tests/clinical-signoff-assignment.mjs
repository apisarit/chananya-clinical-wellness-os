// Assignment acceptance probe; disposable migrated SQL only, never a live target.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createPriceMasterFixture } from './helpers/price-master-fixture.mjs';
const {db,ids,asOwner,asUser,asAnon,asService}=await createPriceMasterFixture();
const other='7b000000-0000-4000-8000-000000000001';
const encounter='7b000000-0000-4000-8000-000000000002';
try {
  if (process.argv.includes('--candidate')) {
    const source=fs.readFileSync(new URL('../supabase/manual/clinical_signoff_assignment_candidate.sql',import.meta.url),'utf8');
    const blocker="do $$ begin raise exception 'CLINICAL_SIGNOFF_ASSIGNMENT_REVIEW_REQUIRED'; end $$;";
    const definition=async()=> (await asOwner("select pg_get_functiondef('public.sign_clinical_record_complete(uuid,text,text,text)'::regprocedure) d")).rows[0].d;
    const before=await definition();
    await assert.rejects(db.exec(source),/CLINICAL_SIGNOFF_ASSIGNMENT_REVIEW_REQUIRED/);
    await db.exec('rollback');
    assert.equal(await definition(),before,'blocked candidate cannot alter the routine');
    assert.equal(source.split(blocker).length,2);
    await db.exec(source.replace(blocker,'-- Disposable fixture only: explicit candidate test.'));
  }
  await asOwner('select 1');
  await db.exec(`insert into auth.users(id,email,raw_user_meta_data)
    values('${other}','signoff-peer@example.test','{"full_name":"Synthetic peer"}');
    update public.profiles set role='practitioner',system_role='staff' where id='${other}';
    insert into public.clinic_memberships(clinic_id,profile_id,clinic_role,is_primary,active)
    values('${ids.clinicA}','${other}','practitioner',true,true)
    on conflict(clinic_id,profile_id) do update set clinic_role='practitioner',is_primary=true,active=true;
    insert into public.encounters(id,encounter_no,patient_id,clinic_id,status,practitioner_id)
    select '${encounter}','SYN-SIGNOFF-ASSIGNMENT',id,'${ids.clinicA}','draft','${ids.userA}'
    from public.patients where clinic_id='${ids.clinicA}' limit 1`);
  await asUser(ids.userA,`select public.save_ttm_diagnosis_atomic(
    p_encounter_id=>'${encounter}',p_analysis_summary=>'Synthetic',
    p_thai_diagnosis=>'Synthetic',p_practitioner_confirmed=>true,p_knowledge_version=>'SYN-v1')`);
  await asUser(ids.userA,`select public.create_clinical_treatment_session(
    '${encounter}',array['massage'],'Synthetic',false,null,null,2::smallint,1::smallint,'Synthetic','Synthetic',60)`);
  const signature=`select * from public.sign_clinical_record_complete(
    '${encounter}','Synthetic signer','SYN-LICENSE','Synthetic assignment test')`;
  const authorized=(await asUser(ids.userA,signature)).rows[0];
  assert.equal(authorized.signer_id,ids.userA);
  const auditCount=async()=>Number((await asOwner(`select count(*) n from public.clinical_record_audit_events where encounter_id='${encounter}'`)).rows[0].n);
  const beforeDenied=await auditCount();
  const durableState=async()=>({
    signoffs:(await asOwner(`select * from public.clinical_record_signoffs where encounter_id='${encounter}' order by id`)).rows,
    audit:(await asOwner(`select * from public.clinical_record_audit_events where encounter_id='${encounter}' order by id`)).rows,
  });
  const signedState=await durableState();
  await assert.rejects(asUser(other,signature),/ENCOUNTER_PRACTITIONER_MISMATCH/,
    'another practitioner in the same clinic must not replace the assigned clinician signoff');
  const retained=(await asOwner(`select signer_id from public.clinical_record_signoffs
    where encounter_id='${encounter}' and record_section='complete_record'`)).rows[0];
  assert.equal(retained.signer_id,ids.userA);
  assert.equal(await auditCount(),beforeDenied,'denied peer must not append a successful-signoff audit');
  await assert.rejects(asUser(ids.userB,signature),/ENCOUNTER_NOT_FOUND/);
  assert.equal(await auditCount(),beforeDenied);
  await assert.rejects(asAnon(signature),error=>error.code==='42501');
  await assert.rejects(asService(signature),error=>error.code==='42501');
  await asOwner(`update public.clinic_memberships set active=false
    where profile_id='${ids.userA}' and clinic_id='${ids.clinicA}'`);
  await assert.rejects(asUser(ids.userA,signature),/CNYOS_SUBSCRIPTION_SUSPENDED/);
  assert.equal(await auditCount(),beforeDenied,'disabled assigned actor cannot create a signoff audit');
  assert.deepEqual(await durableState(),signedState,'all denied calls preserve every signoff and audit field');
  await asOwner(`update public.clinic_memberships set active=true,clinic_role='practitioner'
    where profile_id='${ids.userA}' and clinic_id='${ids.clinicA}'`);
  await asOwner(`update public.profiles set system_role='admin' where id='${ids.userA}'`);
  const dual=(await asUser(ids.userA,signature)).rows[0];
  assert.equal(dual.signer_id,ids.userA,'assigned practitioner with system Admin can sign');
  assert.equal(dual.id,authorized.id,'repeat signing must not create another signoff row');
  assert.equal(await auditCount(),beforeDenied+1,'repeat signing retains the existing explicit re-sign audit behavior');
  const resignedState=await durableState();
  await asOwner(`update public.profiles set system_role='admin' where id='${other}'`);
  await assert.rejects(asUser(other,signature),/ENCOUNTER_PRACTITIONER_MISMATCH/);
  await asOwner(`update public.clinic_memberships set clinic_role='admin'
    where profile_id='${ids.userA}' and clinic_id='${ids.clinicA}'`);
  await assert.rejects(asUser(ids.userA,signature),/PERMISSION_DENIED/,
    'assignment and governance Admin alone must not grant clinical signing');
  await asOwner(`update public.clinic_memberships set clinic_role='practitioner'
    where profile_id='${ids.userA}' and clinic_id='${ids.clinicA}'`);
  for (const actor of [ids.userA,other]) {
    await assert.rejects(asUser(actor,`update public.clinical_record_signoffs set signer_id='${other}'
      where encounter_id='${encounter}'`),error=>error.code==='42501');
    await assert.rejects(asUser(actor,`insert into public.clinical_record_signoffs(encounter_id,record_section,signer_id)
      values('${encounter}','complete_record','${other}')`),error=>error.code==='42501');
  }
  assert.equal(await auditCount(),beforeDenied+1);
  assert.deepEqual(await durableState(),resignedState,'peer, governance and direct-write denials cannot alter existing signature or audit rows');
  console.log(`Clinical signoff assignment ${process.argv.includes('--candidate') ? 'manual candidate' : 'migration chain'} passed: assigned/dual-role signing, peer/tenant/disabled/anon/service/governance-only denial, direct-write denial and re-sign audit. Disposable SQL only.`);
} finally { await db.close(); }
