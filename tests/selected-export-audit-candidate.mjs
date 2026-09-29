import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createPriceMasterFixture} from './helpers/price-master-fixture.mjs';
import {selectedExportHeaders} from '../netlify/functions/_shared/selected-export.mjs';

const {db,ids,asOwner,asUser,asAnon,asService}=await createPriceMasterFixture();
try {
  const source=await fs.readFile(new URL('../supabase/manual/selected_patient_export_audit_candidate.sql',import.meta.url),'utf8');
  const blocker="do $$ begin raise exception 'SELECTED_EXPORT_AUDIT_REVIEW_REQUIRED'; end $$;";
  assert.equal(source.split(blocker).length,2);
  await assert.rejects(db.exec(source),/SELECTED_EXPORT_AUDIT_REVIEW_REQUIRED/);
  await db.exec('rollback');
  assert.equal((await asOwner("select to_regnamespace('cnyos_export_internal') is null absent")).rows[0].absent,true);
  await db.exec(source.replace(blocker,'-- Test-only installation in disposable fixture.'));
  const patient=(await asOwner(`select id from public.patients where clinic_id='${ids.clinicA}' limit 1`)).rows[0].id;
  const foreign=(await asOwner(`insert into public.patients(hn,first_name,last_name,clinic_id)
    values('SYN-B-EXPORT','Synthetic','Foreign','${ids.clinicB}') returning id`)).rows[0].id;
  const call=(selection=`array['${patient}']::uuid[]`,format="'json'")=>`select cnyos_export_internal.prepare_patients(${selection},${format}) result`;
  for(const role of ['anon','authenticated','service_role']) {
    assert.equal((await asOwner(`select has_function_privilege('${role}','cnyos_export_internal.prepare_patients(uuid[],text)','EXECUTE') allowed`)).rows[0].allowed,false);
    for(const table of ['permissions','permission_events','preparation_events'])
      assert.equal((await asOwner(`select has_table_privilege('${role}','cnyos_export_internal.${table}','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') allowed`)).rows[0].allowed,false);
  }
  for(const actor of [asAnon,asService,sql=>asUser(ids.userA,sql)])
    await assert.rejects(actor(call()),e=>e.code==='42501');
  // Test-only execution grants expose the private body, never emitted by source.
  await asOwner('grant usage on schema cnyos_export_internal to authenticated');
  await asOwner('grant execute on function cnyos_export_internal.prepare_patients(uuid[],text) to authenticated');
  for(const user of [ids.userA,ids.owner,ids.superAdmin])
    await assert.rejects(asUser(user,call()),/EXPORT_NOT_AUTHORIZED/);
  await asOwner(`insert into cnyos_export_internal.permissions(clinic_id,actor_id,policy_reference)
    values('${ids.clinicA}','${ids.userA}','SYN-TEST-NOT-APPROVED')`);
  await assert.rejects(asUser(ids.userA,call()),/EXPORT_NOT_AUTHORIZED/);
  await asOwner('update cnyos_export_internal.permissions set active=true');
  const events=async()=>(await asOwner('select * from cnyos_export_internal.preparation_events order by recorded_at,id')).rows;
  for(const selection of ['null','array[]::uuid[]',`array['${patient}','${patient}']::uuid[]`,
    `array['${patient}',null]::uuid[]`,`array_fill('${patient}'::uuid,array[101])`,
    `array[array['${patient}']]::uuid[]`])
    await assert.rejects(asUser(ids.userA,call(selection)),/EXPORT_REQUEST_INVALID/);
  for(const format of ['null',"'pdf'","'JSON'"])
    await assert.rejects(asUser(ids.userA,call(undefined,format)),/EXPORT_REQUEST_INVALID/);
  for(const unavailable of [foreign,'aaaaaaaa-0000-4000-8000-000000000000'])
    await assert.rejects(asUser(ids.userA,call(`array['${patient}','${unavailable}']::uuid[]`)),/EXPORT_SELECTION_UNAVAILABLE/);
  assert.equal((await events()).length,0,'invalid/partial selections must not create preparation evidence');
  const first=(await asUser(ids.userA,call())).rows[0].result;
  assert.equal(first.operation,'patient_export_prepared');
  assert.equal(first.rows.length,1);
  assert.deepEqual(Object.keys(first.rows[0]).sort(),selectedExportHeaders('patients').sort());
  assert.equal(first.rows[0].id,patient);
  const saved=(await events())[0];
  assert.equal(saved.id,first.receipt_id);
  assert.equal(saved.actor_id,ids.userA);assert.equal(saved.clinic_id,ids.clinicA);
  assert.deepEqual(saved.patient_ids,[patient]);
  assert.equal('rows' in saved,false,'audit must not duplicate exported patient bodies');
  await asOwner(`update public.patients set first_name='Fresh synthetic value' where id='${patient}'`);
  const second=(await asUser(ids.userA,call(undefined,"'csv'"))).rows[0].result;
  assert.notEqual(second.receipt_id,first.receipt_id,'every new preparation is a distinct audit event');
  assert.equal(second.rows[0].first_name,'Fresh synthetic value','read current database, not browser cache');
  await assert.rejects(asUser(ids.userB,call()),/EXPORT_NOT_AUTHORIZED/);
  for(const table of ['permissions','permission_events','preparation_events'])
    await assert.rejects(asUser(ids.userA,`select * from cnyos_export_internal.${table}`),e=>e.code==='42501');
  for(const sql of ['update cnyos_export_internal.preparation_events set requested_format=\'csv\'',
    'delete from cnyos_export_internal.preparation_events','truncate cnyos_export_internal.preparation_events',
    'truncate cnyos_export_internal.permission_events','truncate cnyos_export_internal.permissions'])
    await assert.rejects(asOwner(sql),/EXPORT_HISTORY_IMMUTABLE/);
  const before=await events();
  await asOwner(`create function cnyos_export_internal.synthetic_failure() returns trigger language plpgsql as $$begin raise exception 'SYN_AUDIT_UNAVAILABLE'; end$$`);
  await asOwner('create trigger synthetic_failure before insert on cnyos_export_internal.preparation_events for each row execute function cnyos_export_internal.synthetic_failure()');
  await assert.rejects(asUser(ids.userA,call()),/SYN_AUDIT_UNAVAILABLE/);
  assert.deepEqual(await events(),before);
  await asOwner('drop trigger synthetic_failure on cnyos_export_internal.preparation_events');
  await asOwner('create trigger synthetic_permission_failure before insert on cnyos_export_internal.permission_events for each row execute function cnyos_export_internal.synthetic_failure()');
  await assert.rejects(asOwner('update cnyos_export_internal.permissions set active=false'),/SYN_AUDIT_UNAVAILABLE/);
  assert.equal((await asOwner('select active from cnyos_export_internal.permissions')).rows[0].active,true);
  await asOwner('drop trigger synthetic_permission_failure on cnyos_export_internal.permission_events');
  await asOwner(`update public.clinic_memberships set active=false where profile_id='${ids.userA}'`);
  await assert.rejects(asUser(ids.userA,call()),/CLINIC_ACCESS_REQUIRED/);
  await asOwner(`update public.clinic_memberships set active=true where profile_id='${ids.userA}'`);
  const state=(await asOwner(`select subscription_version from public.clinics where id='${ids.clinicA}'`)).rows[0];
  await asOwner(`select public.set_clinic_subscription_state('ef000000-0000-4000-8000-000000000001',
    '${ids.clinicA}','CHANANYA',false,${state.subscription_version},'Synthetic export OFF','${ids.owner}','owner@example.test')`);
  await assert.rejects(asUser(ids.userA,call()),/CLINIC_ACCESS_REQUIRED|SUBSCRIPTION/);
  await asOwner(`select public.set_clinic_subscription_state('ef000000-0000-4000-8000-000000000002',
    '${ids.clinicA}','CHANANYA',true,${Number(state.subscription_version)+1},'Synthetic export ON','${ids.owner}','owner@example.test')`);
  await asOwner('update cnyos_export_internal.permissions set active=false');
  await assert.rejects(asUser(ids.userA,call()),/EXPORT_NOT_AUTHORIZED/);
  const changes=(await asOwner('select * from cnyos_export_internal.permission_events order by recorded_at')).rows;
  assert.equal(changes.length,3);assert.equal(changes[0].after_state.active,false);
  assert.equal(changes[1].before_state.active,false);assert.equal(changes[1].after_state.active,true);
  assert.equal(changes[2].after_state.active,false);
  assert.ok(changes.every(row=>row.actor_id===null&&row.database_session_user&&row.database_role),'bootstrap history cannot invent a human approver');
  assert.deepEqual(await events(),before);
  await asOwner(`insert into cnyos_export_internal.permissions(clinic_id,actor_id,active,policy_reference)
    values('${ids.clinicB}','${ids.userB}',true,'SYN-B-NOT-APPROVED')`);
  await assert.rejects(asUser(ids.userB,call()),/EXPORT_SELECTION_UNAVAILABLE/);
  const b=(await asUser(ids.userB,call(`array['${foreign}']::uuid[]`))).rows[0].result;
  assert.equal(b.rows[0].clinic_id,ids.clinicB);
  assert.equal((await events()).length,3,'only successful preparations create events across both tenants');
  console.log('Selected export audit candidate passed: inert installation, no runtime grants, explicit permission, fresh bounded projection, tenant/partial denial, immutable metadata and atomic audit-failure refusal. Not a download receipt or live activation.');
} finally {await db.close();}
