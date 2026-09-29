import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createPriceMasterFixture} from './helpers/price-master-fixture.mjs';
const {db,ids,asOwner,asUser,asAnon,asService}=await createPriceMasterFixture();
try{
  await asOwner('select 1');
  await db.exec(`alter default privileges grant all on tables to anon,authenticated,service_role;
    alter default privileges grant all on sequences to anon,authenticated,service_role;
    alter default privileges grant execute on functions to anon,authenticated,service_role;
    alter default privileges grant usage on schemas to anon,authenticated,service_role;`);
  const source=fs.readFileSync(new URL('../supabase/manual/purpose_consent_ledger_candidate.sql',import.meta.url),'utf8');
  const blocker="do $$ begin raise exception 'PURPOSE_CONSENT_REVIEW_REQUIRED'; end $$;";
  assert.equal(source.split(blocker).length,2);
  await assert.rejects(db.exec(source),/PURPOSE_CONSENT_REVIEW_REQUIRED/);await db.exec('rollback');
  assert.equal((await asOwner("select to_regnamespace('cnyos_consent_internal') n")).rows[0].n,null);
  await db.exec(source.replace(blocker,'-- Explicit disposable storage test only.'));
  for(const role of ['anon','authenticated','service_role']){
    assert.equal((await asOwner(`select has_schema_privilege('${role}','cnyos_consent_internal','USAGE') allowed`)).rows[0].allowed,false);
    const tables=(await asOwner(`select c.relname,c.relrowsecurity,
      has_table_privilege('${role}',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') allowed
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='cnyos_consent_internal' and c.relkind='r'`)).rows;
    assert.equal(tables.length,2);assert.ok(tables.every(row=>row.relrowsecurity&&!row.allowed));
    const routines=(await asOwner(`select has_function_privilege('${role}',p.oid,'EXECUTE') allowed
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='cnyos_consent_internal'`)).rows;
    assert.equal(routines.length,2);assert.ok(routines.every(row=>!row.allowed));
    const sequences=(await asOwner(`select has_sequence_privilege('${role}',c.oid,'USAGE,SELECT,UPDATE') allowed
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='cnyos_consent_internal' and c.relkind='S'`)).rows;
    assert.equal(sequences.length,1);assert.ok(sequences.every(row=>!row.allowed));
  }
  const patient=(await asOwner(`select id from public.patients where clinic_id='${ids.clinicA}' limit 1`)).rows[0].id;
  const purposeInsert=(clinic,categories)=>`insert into cnyos_consent_internal.purpose_versions(clinic_id,purpose_code,version,data_categories,notice_sha256,source_reference)
    values('${clinic}','synthetic_only',1,${categories},'${'a'.repeat(64)}','SYNTHETIC-NOT-APPROVED') returning id`;
  for(const categories of ['null','array[]::text[]',"array['']","array['synthetic',null]","array['Invalid Category']","array['synthetic,other']","array['synthetic','synthetic']"]){
    await assert.rejects(asOwner(purposeInsert(ids.clinicA,categories)),e=>['23502','23514'].includes(e.code));
  }
  const purpose=(await asOwner(purposeInsert(ids.clinicA,"array['synthetic_identifier','synthetic_contact']"))).rows[0].id;
  const purposeB=(await asOwner(purposeInsert(ids.clinicB,"array['synthetic_identifier']"))).rows[0].id;
  const insert=(clinic,decision,key,kind='self',authority='null',evidence="'SYN-SUBJECT'",digest=`'${'b'.repeat(64)}'`)=>`insert into cnyos_consent_internal.decision_events(clinic_id,patient_id,purpose_version_id,request_id,recorded_by,decision,effective_at,source_reference,subject_kind,representative_authority_reference,subject_evidence_reference,subject_evidence_sha256)
    values('${clinic}','${patient}','${purpose}','${key}','${ids.userA}','${decision}',now(),'SYNTHETIC','${kind}',${authority},${evidence},${digest})`;
  const key='7d000000-0000-4000-8000-000000000001';
  for(const time of ['infinity','-infinity']){
    await assert.rejects(asOwner(insert(ids.clinicA,'grant',key).replace('now()',`'${time}'::timestamptz`)),e=>e.code==='23514');
  }
  for(const sql of [insert(ids.clinicA,'grant',key,'representative'),
    insert(ids.clinicA,'grant',key,'representative',"' '"),
    insert(ids.clinicA,'grant',key,'self',"'SYN-AUTHORITY'"),
    insert(ids.clinicA,'grant',key,'self','null',"''"),
    insert(ids.clinicA,'grant',key,'self','null',"'SYN'","'bad-digest'")]){
    await assert.rejects(asOwner(sql),e=>e.code==='23514');
  }
  // now() is identical within this transaction; ordering must not use random UUIDs.
  await db.exec('begin');
  await asOwner(insert(ids.clinicA,'grant',key));
  await asOwner(insert(ids.clinicA,'withdraw','7d000000-0000-4000-8000-000000000004','representative',"'SYN-AUTHORITY-NOT-VERIFIED'"));
  await db.exec('commit');
  const history=(await asOwner('select decision,subject_kind,representative_authority_reference,event_position,recorded_at from cnyos_consent_internal.decision_events order by event_position')).rows;
  assert.equal(history.length,2);
  assert.ok(BigInt(history[1].event_position)>BigInt(history[0].event_position));
  assert.deepEqual(history.map(row=>row.decision),['grant','withdraw']);
  assert.deepEqual(history[0].recorded_at,history[1].recorded_at);
  assert.ok(history.some(row=>row.decision==='grant'&&row.subject_kind==='self'));
  assert.ok(history.some(row=>row.decision==='withdraw'&&row.subject_kind==='representative'&&row.representative_authority_reference==='SYN-AUTHORITY-NOT-VERIFIED'));
  const snapshot=async()=>({
    purposes:(await asOwner('select * from cnyos_consent_internal.purpose_versions order by id')).rows,
    events:(await asOwner('select * from cnyos_consent_internal.decision_events order by id')).rows,
  });
  const beforeDenials=await snapshot();
  await assert.rejects(asOwner(insert(ids.clinicA,'withdraw',key)),e=>e.code==='23505');
  await assert.rejects(asOwner(insert(ids.clinicB,'grant','7d000000-0000-4000-8000-000000000002')),e=>e.code==='23503');
  await assert.rejects(asOwner(insert(ids.clinicA,'grant','7d000000-0000-4000-8000-000000000002').replace(purpose,purposeB)),
    e=>e.code==='23503'&&e.constraint.includes('purpose_version_id'), 'same-clinic patient cannot reference another clinic purpose');
  await assert.rejects(asOwner(insert(ids.clinicB,'grant','7d000000-0000-4000-8000-000000000002').replace(purpose,purposeB)),
    e=>e.code==='23503'&&e.constraint.includes('patient_id'), 'same-clinic purpose cannot reference another clinic patient');
  for(const sql of ["update cnyos_consent_internal.decision_events set decision='withdraw'",'delete from cnyos_consent_internal.decision_events','truncate cnyos_consent_internal.decision_events',"update cnyos_consent_internal.purpose_versions set version=2"]){
    await assert.rejects(asOwner(sql),/CONSENT_HISTORY_IMMUTABLE/);
  }
  for(const actor of [asAnon,asService,sql=>asUser(ids.userA,sql),sql=>asUser(ids.owner,sql)]){
    await assert.rejects(actor('select * from cnyos_consent_internal.decision_events'),e=>e.code==='42501');
    await assert.rejects(actor(insert(ids.clinicA,'grant','7d000000-0000-4000-8000-000000000003')),e=>e.code==='42501');
  }
  assert.equal((await asOwner('select count(*)::int n from cnyos_consent_internal.decision_events')).rows[0].n,2);
  assert.deepEqual(await snapshot(),beforeDenials,'all rejected requests preserve every purpose and event field');
  console.log('Consent storage proposal passed: guarded install, tenant FKs, request uniqueness, immutable history and no client/service access. No activated purpose, RPC, UI or legal approval.');
}finally{await db.close();}
