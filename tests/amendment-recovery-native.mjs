// Real PostgreSQL races, synthetic local fixture only. No mounts or network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync,spawn} from 'node:child_process';
import {createPriceMasterFixture,PRICE_FIXTURE_IDS as ids} from './helpers/price-master-fixture.mjs';
const container=`cnyos-amendment-${process.pid}-${Date.now()}`;
const docker=args=>execFileSync('docker',args,{encoding:'utf8',timeout:30000,stdio:['pipe','pipe','pipe']}).trim();
const image=docker(['image','inspect','postgres:17-alpine','--format','{{.Id}}']);
assert.match(image,/^sha256:[a-f0-9]{64}$/);
const encounter='9d000000-0000-4000-8000-000000000001';
const request='9d000000-0000-4000-8000-000000000002';
const request2='9d000000-0000-4000-8000-000000000003';
const active=new Set();
const heldSessions=new Map();
function connection(name) {
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
const auth=actor=>`set request.jwt.claim.sub='${actor}';set request.jwt.claim.role='authenticated';set role authenticated;`;
async function query(sql,{name='observer',allowError=false}={}) {
  const c=connection(name);c.child.stdin.end(sql);const r=await c.done;
  if(r.code!==0&&!allowError)throw new Error(r.err);return r;
}
function holder(sql,name) {
  const c=connection(name);c.child.stdin.write(`begin;${sql}\n`);
  heldSessions.set(name,c.done);
  return {done:c.done,release(){c.child.stdin.end('commit;\n');}};
}
async function waitFor(name,condition) {
  const deadline=Date.now()+8000;
  while(Date.now()<deadline) {
    const observation=query(`select exists(select 1 from pg_stat_activity where application_name='${name}' and ${condition});`);
    const terminal=heldSessions.get(name)?.then(result=>{throw new Error(`Holder ${name} ended before readiness: ${result.err || result.code}`);});
    const r=await (terminal?Promise.race([observation,terminal]):observation);
    if(r.out==='t')return;
    await new Promise(resolve=>setTimeout(resolve,30));
  }
  throw new Error(`No observed ${condition} for ${name}`);
}
const info=async()=>JSON.parse((await query(`select row_to_json(s) from public.clinical_record_signoffs s where encounter_id='${encounter}';`)).out);
const unlock=(key,row)=>auth(ids.superAdmin)+`select public.unlock_clinical_record_for_amendment_v2('${key}','${encounter}','${row.id}',${row.signature_generation},'Synthetic native amendment');`;
const readReceipt=auth(ids.superAdmin)+`select public.read_clinical_amendment_receipt('${request}');`;
const sign=auth(ids.userA)+`select (public.sign_clinical_record_complete('${encounter}','Synthetic signer',null,'Synthetic re-sign')).id;`;
const auditCount=async()=>Number((await query(`select count(*) from public.clinical_record_audit_events where encounter_id='${encounter}' and event_type='UNLOCK_FOR_AMENDMENT';`)).out);
let owned=false;
try {
  docker(['run','--pull=never','--detach','--rm','--network','none','--name',container,'-e','POSTGRES_HOST_AUTH_METHOD=trust',image]);owned=true;
  let ready=false;
  for(let i=0;i<100;i++) {
    try {if(docker(['exec',container,'cat','/proc/1/comm'])==='postgres'){docker(['exec',container,'pg_isready','-U','postgres']);ready=true;break;}}catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(ready,'Synthetic database startup timeout');
  const adapter={exec:sql=>query(sql),query:async sql=>{await query("set request.jwt.claim.role='service_role';"+sql);return {rows:[]};}};
  await createPriceMasterFixture({database:adapter,nativePostgres:true});
  await query(`set request.jwt.claim.role='service_role';
    -- The default fixture also gives this account clinic Owner membership.
    -- Isolate system-role authorization so revoking it actually removes access.
    update public.clinic_memberships set clinic_role='viewer' where profile_id='${ids.superAdmin}' and clinic_id='${ids.clinicA}';
    insert into public.encounters(id,encounter_no,patient_id,clinic_id,status,practitioner_id)
      select '${encounter}','SYN-AMEND-NATIVE',id,'${ids.clinicA}','draft','${ids.userA}' from public.patients where clinic_id='${ids.clinicA}' limit 1;
    insert into public.ttm_structured_diagnoses(encounter_id,analysis_summary,thai_diagnosis,diagnosed_by)
      values('${encounter}','Synthetic analysis','Synthetic diagnosis','${ids.userA}');
    insert into public.clinical_treatment_plans(encounter_id,goal_1,planned_by)
      values('${encounter}','Synthetic goal','${ids.userA}');`);
  await query(sign);
  const source=fs.readFileSync(new URL('../supabase/manual/clinical_amendment_recovery_candidate.sql',import.meta.url),'utf8');
  const blocker="do $$ begin raise exception 'CLINICAL_AMENDMENT_RECOVERY_REVIEW_REQUIRED'; end $$;";
  assert.equal(source.split(blocker).length,2);
  const before=await info();
  const refused=await query(source,{allowError:true});assert.notEqual(refused.code,0);assert.match(refused.err,/CLINICAL_AMENDMENT_RECOVERY_REVIEW_REQUIRED/);
  assert.deepEqual(await info(),before);
  await query(source.replace(blocker,'-- Disposable in-memory derivative only.'));
  const initial=await info();

  // Two identical requests serialize through the advisory lock and return one receipt.
  let h=holder(unlock(request,initial),'first_unlock');
  await waitFor('first_unlock',"state='idle in transaction'");
  assert.equal((await query(readReceipt)).out,'','uncommitted receipt remains absent, not a reason to issue again');
  let pending=query(unlock(request,initial),{name:'duplicate_unlock',allowError:true});
  await waitFor('duplicate_unlock',"wait_event_type='Lock'");
  h.release();const first=await h.done;assert.equal(first.code,0);
  let result=await pending;assert.equal(result.code,0,result.err);assert.equal(result.out,first.out);
  assert.equal((await query(readReceipt)).out,first.out);
  assert.equal(await auditCount(),1);

  // Real signing holds the Encounter lock; a waiting stale unlock must not affect it.
  await query(sign);const signed=await info();
  h=holder(sign,'new_signature');
  await waitFor('new_signature',"state='idle in transaction'");
  pending=query(unlock(request2,signed),{name:'stale_unlock',allowError:true});
  await waitFor('stale_unlock',"wait_event_type='Lock'");
  h.release();assert.equal((await h.done).code,0);
  result=await pending;assert.notEqual(result.code,0);assert.match(result.err,/AMENDMENT_SIGNATURE_STALE/);
  assert.equal((await info()).lock_record,true);assert.equal(await auditCount(),1);
  result=await query(unlock(request,initial));assert.equal(result.out,first.out);
  assert.equal((await info()).lock_record,true,'historical receipt leaves current signature locked');

  // Distinct request IDs for one signature cannot create two unlock events.
  const current=await info();
  h=holder(unlock(request2,current),'new_unlock');
  await waitFor('new_unlock',"state='idle in transaction'");
  pending=query(unlock('9d000000-0000-4000-8000-000000000004',current),{name:'competing_unlock',allowError:true});
  await waitFor('competing_unlock',"wait_event_type='Lock'");
  h.release();assert.equal((await h.done).code,0);
  result=await pending;assert.notEqual(result.code,0);assert.match(result.err,/AMENDMENT_ALREADY_UNLOCKED/);
  assert.equal(await auditCount(),2);

  // Revocation commits while replay is waiting on authorization rows.
  h=holder(`update public.profiles set system_role='staff' where id='${ids.superAdmin}';`,'role_revoker');
  await waitFor('role_revoker',"state='idle in transaction'");
  pending=query(unlock(request,initial),{name:'revoked_replay',allowError:true});
  let pendingRead=query(readReceipt,{name:'revoked_read',allowError:true});
  await waitFor('revoked_replay',"wait_event_type='Lock'");
  await waitFor('revoked_read',"wait_event_type='Lock'");
  h.release();assert.equal((await h.done).code,0);
  result=await pending;assert.notEqual(result.code,0);assert.match(result.err,/PERMISSION_DENIED/);
  result=await pendingRead;assert.notEqual(result.code,0);assert.match(result.err,/PERMISSION_DENIED/);
  await query(`update public.profiles set system_role='super_admin' where id='${ids.superAdmin}';`);
  h=holder(`set request.jwt.claim.role='service_role';update public.clinic_memberships set active=false where profile_id='${ids.superAdmin}' and clinic_id='${ids.clinicA}';`,'membership_revoker');
  await waitFor('membership_revoker',"state='idle in transaction'");
  pending=query(unlock(request,initial),{name:'membership_replay',allowError:true});
  pendingRead=query(readReceipt,{name:'membership_read',allowError:true});
  await waitFor('membership_replay',"wait_event_type='Lock'");
  await waitFor('membership_read',"wait_event_type='Lock'");
  h.release();assert.equal((await h.done).code,0);
  result=await pending;assert.notEqual(result.code,0);assert.match(result.err,/PERMISSION_DENIED/);
  result=await pendingRead;assert.notEqual(result.code,0);assert.match(result.err,/PERMISSION_DENIED/);
  await query(`set request.jwt.claim.role='service_role';update public.clinic_memberships set active=true where profile_id='${ids.superAdmin}' and clinic_id='${ids.clinicA}';`);

  // The Owner OFF RPC locks the clinic; replay cannot return a receipt after OFF.
  h=holder(`set request.jwt.claim.role='service_role';
    select public.set_clinic_subscription_state('9d000000-0000-4000-8000-000000000005','${ids.clinicA}','CHANANYA',false,
      (select subscription_version from public.clinics where id='${ids.clinicA}'),'Synthetic native OFF','${ids.owner}','owner@example.test');`,'clinic_suspender');
  await waitFor('clinic_suspender',"state='idle in transaction'");
  pending=query(unlock(request,initial),{name:'suspended_replay',allowError:true});
  pendingRead=query(readReceipt,{name:'suspended_read',allowError:true});
  await waitFor('suspended_replay',"wait_event_type='Lock'");
  await waitFor('suspended_read',"wait_event_type='Lock'");
  h.release();assert.equal((await h.done).code,0);
  result=await pending;assert.notEqual(result.code,0);assert.match(result.err,/CNYOS_SUBSCRIPTION_SUSPENDED/);
  result=await pendingRead;assert.notEqual(result.code,0);assert.match(result.err,/CNYOS_SUBSCRIPTION_SUSPENDED/);
  assert.equal(await auditCount(),2);
  console.log(`Native amendment candidate passed: observed duplicate/signing/distinct-request and role/membership/subscription lock races, no duplicate audit or stale unlock. Image ${image}. Local synthetic evidence only.`);
} finally {for(const child of active)child.kill();if(owned)docker(['rm','--force',container]);}
