// Synthetic native PostgreSQL only: no remote target, mounts or network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync,spawn} from 'node:child_process';
import {createPriceMasterFixture,PRICE_FIXTURE_IDS as ids} from './helpers/price-master-fixture.mjs';
const container=`cnyos-signoff-${process.pid}-${Date.now()}`;
const docker=args=>execFileSync('docker',args,{encoding:'utf8',timeout:30000,stdio:['pipe','pipe','pipe']}).trim();
const image=docker(['image','inspect','postgres:17-alpine','--format','{{.Id}}']);
assert.match(image,/^sha256:[a-f0-9]{64}$/);
const encounter='7c000000-0000-4000-8000-000000000001';
const active=new Set();
function connection(name){
  assert.match(name,/^[a-z0-9_]+$/);
  const child=spawn('docker',['exec','-i',container,'psql','-XqAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres']);
  active.add(child);let out='',err='';
  const done=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill();reject(new Error('Synthetic SQL timeout'));},25000);
    child.on('error',reject);child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
    child.on('close',code=>{clearTimeout(timer);active.delete(child);resolve({code,out:out.trim(),err:err.trim()});});
  });done.catch(()=>{});child.stdin.on('error',()=>{});
  child.stdin.write(`set application_name='${name}';set statement_timeout='20s';set idle_in_transaction_session_timeout='20s';\n`);
  return {child,done};
}
const auth=`set request.jwt.claim.sub='${ids.userA}';set request.jwt.claim.role='authenticated';set role authenticated;`;
async function query(sql,{actor=false,name='observer',allowError=false}={}){
  const c=connection(name);c.child.stdin.end((actor?auth:'')+sql);const r=await c.done;
  if(r.code!==0&&!allowError)throw new Error(r.err);return r;
}
function holder(sql,name){const c=connection(name);c.child.stdin.write(`begin;${sql}\n`);return {done:c.done,release(){c.child.stdin.end('commit;\n');}};}
async function waitFor(sql,message){
  const deadline=Date.now()+8000;
  while(Date.now()<deadline){if((await query(sql)).out==='t')return;await new Promise(r=>setTimeout(r,30));}
  throw new Error(message);
}
const state=(name,condition)=>`select exists(select 1 from pg_stat_activity where application_name='${name}' and ${condition});`;
const sign=`select (public.sign_clinical_record_complete('${encounter}','Synthetic signer','SYN','Synthetic concurrency')).id;`;
const count=()=>query(`select count(*) from public.clinical_record_signoffs where encounter_id='${encounter}';`);
let owned=false;
try{
  docker(['run','--pull=never','--detach','--rm','--network','none','--name',container,'-e','POSTGRES_HOST_AUTH_METHOD=trust',image]);owned=true;
  let ready=false;
  for(let i=0;i<100;i++){try{if(docker(['exec',container,'cat','/proc/1/comm'])==='postgres'){docker(['exec',container,'pg_isready','-U','postgres']);ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
  assert.ok(ready,'Synthetic database startup timeout');
  const adapter={exec:sql=>query(sql),query:async sql=>{await query("set request.jwt.claim.role='service_role';"+sql);return {rows:[]};}};
  const migrationName='20260927003831_clinical_signoff_assignment.sql';
  await createPriceMasterFixture({database:adapter,nativePostgres:true,stopBeforeMigration:migrationName});
  // Existing synthetic signed record is independent of the race fixture below.
  const existing='7c000000-0000-4000-8000-000000000002';
  await query(`insert into public.encounters(id,encounter_no,patient_id,clinic_id,status,practitioner_id)
    select '${existing}','SYN-PRE-UPGRADE',id,'${ids.clinicA}','draft','${ids.userA}' from public.patients where clinic_id='${ids.clinicA}' limit 1;`);
  await query(`select public.save_ttm_diagnosis_atomic(p_encounter_id=>'${existing}',p_analysis_summary=>'Synthetic',p_thai_diagnosis=>'Synthetic',p_practitioner_confirmed=>true,p_knowledge_version=>'SYN');
    select public.create_clinical_treatment_session('${existing}',array['manual'],'Synthetic',false,null,null,2::smallint,1::smallint,'Synthetic','Synthetic',60);
    select public.sign_clinical_record_complete('${existing}','Existing signer','SYN-OLD','Before candidate');`,{actor:true});
  const records=async()=> (await query(`select jsonb_build_object(
    'signoffs',(select jsonb_agg(to_jsonb(s) order by s.id) from public.clinical_record_signoffs s),
    'audit',(select jsonb_agg(to_jsonb(a) order by a.id) from public.clinical_record_audit_events a));`)).out;
  const catalog=async()=> (await query(`select jsonb_build_object(
    'definition',pg_get_functiondef(p.oid),'owner',p.proowner,'acl',p.proacl,
    'table_acl',(select relacl from pg_class where oid='public.clinical_record_signoffs'::regclass))
    from pg_proc p where p.oid='public.sign_clinical_record_complete(uuid,text,text,text)'::regprocedure;`)).out;
  const oldRecords=await records(),oldCatalog=await catalog();
  const source=fs.readFileSync(new URL('../supabase/manual/clinical_signoff_assignment_candidate.sql',import.meta.url),'utf8');
  const blocker="do $$ begin raise exception 'CLINICAL_SIGNOFF_ASSIGNMENT_REVIEW_REQUIRED'; end $$;";
  assert.equal(source.split(blocker).length,2);
  const refusal=await query(source,{allowError:true});assert.notEqual(refusal.code,0);assert.match(refusal.err,/CLINICAL_SIGNOFF_ASSIGNMENT_REVIEW_REQUIRED/);
  assert.equal(await records(),oldRecords);assert.equal(await catalog(),oldCatalog);
  const candidate=fs.readFileSync(new URL(`../supabase/migrations/${migrationName}`,import.meta.url),'utf8');
  assert.equal(candidate.slice(candidate.indexOf('create or replace function')),
    source.slice(source.indexOf('create or replace function')),
    'packaged function and ACL must match the rehearsed proposal');
  assert.match(candidate,/commit;\s*$/i);
  await query(candidate.replace(/commit;\s*$/i,'rollback;'));
  assert.equal(await catalog(),oldCatalog,'transaction rollback restores exact function owner/ACL/body and table ACL');
  assert.equal(await records(),oldRecords,'rollback preserves pre-existing signatures/audit');
  await query(candidate);
  assert.equal(await records(),oldRecords,'committed candidate preserves every pre-existing signature/audit field');
  assert.notEqual(await catalog(),oldCatalog,'candidate was actually installed');
  await query(`insert into public.encounters(id,encounter_no,patient_id,clinic_id,status,practitioner_id)
    select '${encounter}','SYN-SIGNOFF-RACE',id,'${ids.clinicA}','draft','${ids.userA}' from public.patients where clinic_id='${ids.clinicA}' limit 1;`);
  await query(`select public.save_ttm_diagnosis_atomic(p_encounter_id=>'${encounter}',p_analysis_summary=>'Synthetic',p_thai_diagnosis=>'Synthetic',p_practitioner_confirmed=>true,p_knowledge_version=>'SYN');
    select public.create_clinical_treatment_session('${encounter}',array['manual'],'Synthetic',false,null,null,2::smallint,1::smallint,'Synthetic','Synthetic',60);`,{actor:true});
  // A reassignment commits while signoff is waiting: old practitioner must fail.
  let h=holder(`update public.encounters set practitioner_id='${ids.superAdmin}' where id='${encounter}';`,'assignment_holder');
  await waitFor(state('assignment_holder',"state='idle in transaction'"),'Reassignment holder not ready');
  const stale=query(sign,{actor:true,name:'stale_signer',allowError:true});
  await waitFor(state('stale_signer',"wait_event_type='Lock'"),'Signoff did not wait on reassignment');
  h.release();assert.equal((await h.done).code,0);
  const denied=await stale;assert.notEqual(denied.code,0);assert.match(denied.err,/ENCOUNTER_PRACTITIONER_MISMATCH/);
  assert.equal((await count()).out,'0');
  assert.equal((await query(`select count(*) from public.clinical_record_audit_events where encounter_id='${encounter}' and event_type='SIGN_AND_LOCK';`)).out,'0');
  await query(`update public.encounters set practitioner_id='${ids.userA}' where id='${encounter}';`);
  // Actual signoff RPC holds the row; treatment must wait, then reject the lock.
  h=holder(auth+sign,'signoff_holder');
  await waitFor(state('signoff_holder',"state='idle in transaction'"),'Signoff holder not ready');
  const late=query(`select public.create_clinical_treatment_session('${encounter}',array['manual'],'Late synthetic',false,null,null,2::smallint,1::smallint,'Synthetic','Synthetic',60);`,{actor:true,name:'late_treatment',allowError:true});
  await waitFor(state('late_treatment',"wait_event_type='Lock'"),'Treatment did not wait on actual signoff RPC');
  h.release();assert.equal((await h.done).code,0);
  const rejected=await late;assert.notEqual(rejected.code,0);assert.match(rejected.err,/CLINICAL_RECORD_LOCKED/);
  assert.equal((await count()).out,'1');
  assert.equal((await query(`select count(*) from public.clinical_treatment_sessions where encounter_id='${encounter}';`)).out,'1');
  console.log(`Native packaged signoff migration passed: populated signature/audit preservation, transactional rollback restores exact routine/table ACL, observed reassignment/signoff and signoff/treatment lock waits. Image ${image}. No hosted proof or post-commit downgrade proof.`);
}finally{for(const child of active)child.kill();if(owned)docker(['rm','--force',container]);}
