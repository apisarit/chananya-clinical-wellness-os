import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createPriceMasterFixture} from './helpers/price-master-fixture.mjs';
const {db,ids,asOwner,asUser,asAnon,asService}=await createPriceMasterFixture();
try{
  for(const [file,code] of [['purpose_consent_ledger_candidate.sql','PURPOSE_CONSENT_REVIEW_REQUIRED'],['purpose_consent_writer_candidate.sql','PURPOSE_CONSENT_WRITER_REVIEW_REQUIRED']]){
    const source=fs.readFileSync(new URL(`../supabase/manual/${file}`,import.meta.url),'utf8');
    const blocker=`do $$ begin raise exception '${code}'; end $$;`;
    assert.equal(source.split(blocker).length,2);
    await assert.rejects(db.exec(source),new RegExp(code));await db.exec('rollback');
    await db.exec(source.replace(blocker,'-- Explicit synthetic fixture only.'));
  }
  const patient=(await asOwner(`select id from public.patients where clinic_id='${ids.clinicA}' limit 1`)).rows[0].id;
  const version=(await asOwner(`insert into cnyos_consent_internal.purpose_versions(clinic_id,purpose_code,version,data_categories,notice_sha256,source_reference)
    values('${ids.clinicA}','synthetic',1,array['synthetic'],'${'a'.repeat(64)}','SYN-NOT-APPROVED') returning id`)).rows[0].id;
  const key=n=>`7e000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  const call=(n,position=0,decision='grant')=>`select * from cnyos_consent_internal.record_decision('${key(n)}','${patient}','${version}',${position},'${decision}','self','SYN-EVIDENCE','${'b'.repeat(64)}',null,'SYN-SOURCE','2026-09-27T00:00:00Z')`;
  for(const actor of [asAnon,asService,sql=>asUser(ids.userA,sql)]) await assert.rejects(actor(call(1)),e=>e.code==='42501');
  // Test-only exposure lets the harness exercise body authorization; source grants none.
  await asOwner('grant usage on schema cnyos_consent_internal to authenticated');
  await asOwner('grant execute on function cnyos_consent_internal.record_decision(uuid,uuid,uuid,bigint,text,text,text,text,text,text,timestamptz) to authenticated');
  await assert.rejects(asUser(ids.userA,call(1)),/CONSENT_RECORDING_NOT_AUTHORIZED/);
  await assert.rejects(asUser(ids.owner,call(1)),/CONSENT_RECORDING_NOT_AUTHORIZED/);
  await asOwner(`insert into cnyos_consent_internal.recording_permissions(clinic_id,recorder_id,purpose_version_id,policy_reference)
    values('${ids.clinicA}','${ids.userA}','${version}','SYN-NOT-APPROVED')`);
  await assert.rejects(asUser(ids.userA,call(1)),/CONSENT_RECORDING_NOT_AUTHORIZED/);
  await asOwner('update cnyos_consent_internal.recording_permissions set active=true');
  const audit=async()=> (await asOwner('select * from cnyos_consent_internal.recording_permission_events order by audit_position')).rows;
  const enabledAudit=await audit();assert.equal(enabledAudit.length,2);
  assert.equal(enabledAudit[0].operation,'INSERT');assert.equal(enabledAudit[0].before_state,null);
  assert.equal(enabledAudit[0].after_state.active,false);assert.equal(enabledAudit[0].actor_id,null,'bootstrap must not invent an approving actor');
  assert.equal(enabledAudit[1].operation,'UPDATE');assert.equal(enabledAudit[1].before_state.active,false);assert.equal(enabledAudit[1].after_state.active,true);
  assert.ok(enabledAudit.every(row=>row.database_session_user&&row.database_role));
  for(const role of ['anon','authenticated','service_role']) {
    const access=(await asOwner(`select
      has_table_privilege('${role}','cnyos_consent_internal.recording_permission_events','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as table_access,
      has_sequence_privilege('${role}','cnyos_consent_internal.recording_permission_events_audit_position_seq','USAGE,SELECT,UPDATE') as sequence_access,
      has_function_privilege('${role}','cnyos_consent_internal.audit_recording_permission_change()','EXECUTE') as routine_access`)).rows[0];
    assert.deepEqual(access,{table_access:false,sequence_access:false,routine_access:false});
  }
  for(const sql of [
    'update cnyos_consent_internal.recording_permission_events set actor_id=null',
    'delete from cnyos_consent_internal.recording_permission_events',
    'truncate cnyos_consent_internal.recording_permission_events',
    'truncate cnyos_consent_internal.recording_permissions',
  ]) await assert.rejects(asOwner(sql),/CONSENT_HISTORY_IMMUTABLE/);
  await assert.rejects(asOwner(`update cnyos_consent_internal.recording_permissions set recorder_id='${ids.owner}'`),/CONSENT_PERMISSION_IDENTITY_IMMUTABLE/);
  assert.deepEqual(await audit(),enabledAudit);
  for(const actor of [asAnon,asService,sql=>asUser(ids.userA,sql)])
    await assert.rejects(actor('select * from cnyos_consent_internal.recording_permission_events'),e=>e.code==='42501');
  // Inject a failure into audit storage only in this disposable fixture.
  await asOwner('select 1');
  await db.exec(`create function cnyos_consent_internal.synthetic_audit_failure() returns trigger language plpgsql as $$begin raise exception 'SYNTHETIC_AUDIT_UNAVAILABLE'; end$$;
    create trigger synthetic_audit_failure before insert on cnyos_consent_internal.recording_permission_events
    for each row execute function cnyos_consent_internal.synthetic_audit_failure();`);
  await assert.rejects(asOwner('update cnyos_consent_internal.recording_permissions set active=false'),/SYNTHETIC_AUDIT_UNAVAILABLE/);
  assert.equal((await asOwner('select active from cnyos_consent_internal.recording_permissions')).rows[0].active,true);
  assert.deepEqual(await audit(),enabledAudit,'failed audit must roll back permission and history');
  await asOwner('select 1');await db.exec('drop trigger synthetic_audit_failure on cnyos_consent_internal.recording_permission_events;drop function cnyos_consent_internal.synthetic_audit_failure();');
  const first=(await asUser(ids.userA,call(1))).rows[0];
  assert.equal(first.recorded_by,ids.userA);assert.equal(first.clinic_id,ids.clinicA);
  assert.deepEqual((await asUser(ids.userA,call(1))).rows[0],first);
  await assert.rejects(asUser(ids.userA,call(1,0,'withdraw')),/CONSENT_REQUEST_CONFLICT/);
  await assert.rejects(asUser(ids.userA,call(1,first.event_position)),/CONSENT_REQUEST_CONFLICT/);
  await assert.rejects(asUser(ids.userA,call(2)),/CONSENT_STATE_CHANGED/);
  const second=(await asUser(ids.userA,call(2,first.event_position,'withdraw'))).rows[0];
  assert.equal(second.decision,'withdraw');assert.notEqual(second.id,first.id);
  assert.deepEqual((await asUser(ids.userA,call(1))).rows[0],first,'replay cannot restore an older grant as a new event');
  await assert.rejects(asUser(ids.userB,call(3)),/CONSENT_RECORDING_NOT_AUTHORIZED/);
  await assert.rejects(asUser(ids.userA,'select * from cnyos_consent_internal.decision_events'),e=>e.code==='42501');
  await asOwner('update cnyos_consent_internal.recording_permissions set active=false');
  await assert.rejects(asUser(ids.userA,call(1)),/CONSENT_RECORDING_NOT_AUTHORIZED/);
  assert.equal((await asOwner('select count(*)::int n from cnyos_consent_internal.decision_events')).rows[0].n,2);
  const revokedAudit=await audit();assert.equal(revokedAudit.length,3);
  assert.equal(revokedAudit[2].before_state.active,true);assert.equal(revokedAudit[2].after_state.active,false);
  await asOwner('select 1');
  await db.exec(`set request.jwt.claim.sub='${ids.owner}';delete from cnyos_consent_internal.recording_permissions;`);
  const removedAudit=await audit();assert.equal(removedAudit.length,4);
  assert.equal(removedAudit[3].operation,'DELETE');assert.equal(removedAudit[3].actor_id,ids.owner);
  assert.equal(removedAudit[3].before_state.active,false);assert.equal(removedAudit[3].after_state,null);
  assert.equal((await asOwner('select count(*)::int n from cnyos_consent_internal.recording_permissions')).rows[0].n,0);
  console.log('Consent writer candidate passed: no source grants, inactive/unauthorized denial, derived actor/clinic, replay/conflict/withdrawal, immutable permission old/new audit, actor provenance and atomic audit-failure rollback. No policy approval or live activation.');
}finally{await db.close();}
