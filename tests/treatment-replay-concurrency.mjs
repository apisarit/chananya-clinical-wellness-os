// Disposable synthetic native test; no host ports, mounts or remote credentials.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createPriceMasterFixture, PRICE_FIXTURE_IDS as ids } from './helpers/price-master-fixture.mjs';
const container=`cnyos-replay-${process.pid}-${Date.now()}`;
const docker=args=>execFileSync('docker',args,{encoding:'utf8',timeout:30000,stdio:['pipe','pipe','pipe']}).trim();
const image=docker(['image','inspect','postgres:17-alpine','--format','{{.Id}}']);
assert.match(image,/^sha256:[a-f0-9]{64}$/);
const encounter='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const key=n=>`aaaaaaaa-0000-4000-a000-${String(n).padStart(12,'0')}`;
const active=new Set();
function connection(name){
  assert.match(name,/^[a-z0-9_-]+$/);
  const child=spawn('docker',['exec','-i',container,'psql','-XqAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres'],{stdio:['pipe','pipe','pipe']});
  active.add(child);let out='',err='';
  const done=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill();reject(new Error('Disposable SQL timeout'));},25000);
    child.on('error',reject);child.stdout.on('data',b=>{out+=b;});child.stderr.on('data',b=>{err+=b;});
    child.on('close',code=>{clearTimeout(timer);active.delete(child);resolve({code,out:out.trim(),err:err.trim()});});
  });done.catch(()=>{});child.stdin.on('error',()=>{});
  child.stdin.write(`set application_name='${name}'; set statement_timeout='20s'; set idle_in_transaction_session_timeout='20s';\n`);
  return {child,done};
}
const auth=`set request.jwt.claim.sub='${ids.userA}'; set request.jwt.claim.role='authenticated'; set role authenticated;`;
async function query(sql,{actor=false,name='observer',allowError=false}={}){
  const c=connection(name);c.child.stdin.end((actor?auth:'')+sql);const result=await c.done;
  if(result.code!==0&&!allowError)throw new Error(result.err);return result;
}
function holder(sql,name){const c=connection(name);c.child.stdin.write(`begin; ${sql}\n`);return {done:c.done,release(){c.child.stdin.end('commit;\n');}};}
async function waitFor(sql,message){
  const deadline=Date.now()+8000;
  while(Date.now()<deadline){if((await query(sql)).out==='t')return;await new Promise(r=>setTimeout(r,30));}throw new Error(message);
}
const idle=name=>`select exists(select 1 from pg_stat_activity where application_name='${name}' and state='idle in transaction');`;
const waiting=name=>`select exists(select 1 from pg_stat_activity where application_name='${name}' and wait_event_type='Lock');`;
const call=n=>`select (public.create_clinical_treatment_session_idempotent('${key(n)}','${encounter}',array['manual'],'Synthetic treatment',false,null,null,4::smallint,2::smallint,'Synthetic outcome','Synthetic advice',60)).id;`;
const sign=`insert into public.clinical_record_signoffs(encounter_id,record_section,signer_id,lock_record) values('${encounter}','complete_record','${ids.userA}',true);`;
let owned=false;
try{
  docker(['run','--pull=never','--detach','--rm','--network','none','--name',container,'-e','POSTGRES_HOST_AUTH_METHOD=trust',image]);owned=true;
  let ready=false;
  for(let i=0;i<100;i++){try{if(docker(['exec',container,'cat','/proc/1/comm'])==='postgres'){docker(['exec',container,'pg_isready','-U','postgres']);ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
  assert.ok(ready,'Database startup timeout');
  // Wait for entrypoint to replace its temporary initdb server with postgres.
  await waitFor("select pg_postmaster_start_time() is not null;",'Database unavailable');
  // Fixture query calls seed asOwner data. Keep that explicit setup context in
  // each connection; runtime RPCs below separately SET ROLE authenticated.
  const adapter={exec:async sql=>query(sql),query:async sql=>{await query("set request.jwt.claim.role='service_role';"+sql);return {rows:[]};}};
  await createPriceMasterFixture({database:adapter,nativePostgres:true});
  await query(`insert into public.encounters(id,encounter_no,patient_id,clinic_id,status,practitioner_id) select '${encounter}','NATIVE-REPLAY',id,'${ids.clinicA}','draft','${ids.userA}' from public.patients where clinic_id='${ids.clinicA}' limit 1;`);
  let h=holder(`select pg_advisory_xact_lock(hashtextextended('cnyos-treatment-request:${key(1)}',0));`,'same_holder');
  await waitFor(idle('same_holder'),'Request holder not ready');
  const a=query(call(1),{actor:true,name:'same_a'}),b=query(call(1),{actor:true,name:'same_b'});a.catch(()=>{});b.catch(()=>{});
  await waitFor(waiting('same_a'),'First RPC did not wait');await waitFor(waiting('same_b'),'Second RPC did not wait');
  h.release();assert.equal((await h.done).code,0);const same=await Promise.all([a,b]);assert.equal(same[0].out,same[1].out);
  assert.equal((await query(`select count(*) from public.clinical_treatment_sessions where encounter_id='${encounter}';`)).out,'1');
  assert.equal((await query("select count(*) from public.audit_logs where action='create_clinical_treatment_session_idempotent';")).out,'1');
  h=holder(`select id from public.encounters where id='${encounter}' for update;`,'different_holder');await waitFor(idle('different_holder'),'Encounter holder not ready');
  const c=query(call(2),{actor:true,name:'different_a'}),d=query(call(3),{actor:true,name:'different_b'});c.catch(()=>{});d.catch(()=>{});
  await waitFor(waiting('different_a'),'Different key A did not wait');await waitFor(waiting('different_b'),'Different key B did not wait');h.release();assert.equal((await h.done).code,0);
  const different=await Promise.all([c,d]);assert.notEqual(different[0].out,different[1].out);
  assert.equal((await query(`select string_agg(session_no::text,',' order by session_no) from public.clinical_treatment_sessions where encounter_id='${encounter}';`)).out,'1,2,3');
  h=holder(sign,'sign_holder');await waitFor(idle('sign_holder'),'Signoff holder not ready');
  const blocked=query(call(4),{actor:true,name:'after_sign',allowError:true});await waitFor(waiting('after_sign'),'Treatment did not wait for signoff');h.release();assert.equal((await h.done).code,0);
  assert.match((await blocked).err,/CLINICAL_RECORD_LOCKED/);
  assert.equal((await query(call(1),{actor:true})).out,same[0].out,'Committed replay after signoff');
  await query(`update public.clinical_record_signoffs set lock_record=false where encounter_id='${encounter}';`);
  h=holder(auth+call(5),'treatment_holder');await waitFor(idle('treatment_holder'),'Treatment holder not ready');
  const signing=query(`update public.clinical_record_signoffs set lock_record=true where encounter_id='${encounter}';`,{name:'sign_after_treatment'});signing.catch(()=>{});
  await waitFor(waiting('sign_after_treatment'),'Signoff did not wait for treatment');h.release();assert.equal((await h.done).code,0);await signing;
  assert.equal((await query(`select count(*) from public.clinical_treatment_sessions where encounter_id='${encounter}';`)).out,'4');
  // Real billing RPC wins the encounter lock; an amendment cannot silently add
  // an unbilled fifth session after that invoice commits.
  h=holder(`set request.jwt.claim.sub='${ids.owner}'; set request.jwt.claim.role='authenticated'; set role authenticated;
    select * from public.setup_price_master_default();
    select * from public.issue_atomic_treatment_invoice('${key(90)}','${encounter}',2600,'Synthetic treatment charges');
    reset role; update public.clinical_record_signoffs set lock_record=false where encounter_id='${encounter}';`,'invoice_holder');
  await waitFor(idle('invoice_holder'),'Invoice holder not ready');
  const late=query(call(6),{actor:true,name:'late_treatment',allowError:true});
  await waitFor(waiting('late_treatment'),'Treatment did not wait for invoice');h.release();assert.equal((await h.done).code,0);
  assert.match((await late).err,/TREATMENT_SESSION_ALREADY_BILLED/);
  assert.equal((await query(`select count(*) from public.clinical_treatment_sessions where encounter_id='${encounter}';`)).out,'4');
  assert.equal((await query(`select grand_total::text from public.invoices where encounter_id='${encounter}';`)).out,'2600.00');
  console.log(`Native replay concurrency passed: full migrations, runtime role, observed lock waits, signoff insert/update trigger orderings. Image ${image}`);
}finally{for(const child of active)child.kill();if(owned)docker(['rm','--force',container]);}
