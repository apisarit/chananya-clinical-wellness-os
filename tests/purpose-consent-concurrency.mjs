// Synthetic native PostgreSQL only: no remote targets, mounts or network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {createPriceMasterFixture,PRICE_FIXTURE_IDS as ids} from './helpers/price-master-fixture.mjs';
const container=`cnyos-consent-${process.pid}-${Date.now()}`;
const docker=args=>execFileSync('docker',args,{encoding:'utf8',timeout:30000,stdio:['pipe','pipe','pipe']}).trim();
const image=docker(['image','inspect','postgres:17-alpine','--format','{{.Id}}']);
assert.match(image,/^sha256:[a-f0-9]{64}$/);
const active=new Set();
const completedHolders=new Map();
function connection(name,database='postgres'){
  assert.match(name,/^[a-z0-9_]+$/);
  assert.match(database,/^[a-z0-9_]+$/);
  const child=spawn('docker',['exec','-i',container,'psql','-XqAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',database]);
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
async function query(sql,{actor=false,name='observer',allowError=false,database='postgres'}={}){
  const c=connection(name,database);c.child.stdin.end((actor?auth:'')+sql);const r=await c.done;
  if(r.code!==0&&!allowError)throw new Error(r.err);return r;
}
function holder(sql,name){const c=connection(name);c.done.then(r=>completedHolders.set(name,r),()=>{});c.child.stdin.write(`begin;${sql}\n`);return {done:c.done,release(){c.child.stdin.end('commit;\n');}};}
async function waitFor(sql,message,holderName=null){
  const deadline=Date.now()+8000;
  while(Date.now()<deadline){
    if(holderName&&completedHolders.has(holderName))throw new Error(`${message}: ${completedHolders.get(holderName).err}`);
    if((await query(sql)).out==='t')return;await new Promise(r=>setTimeout(r,30));
  }
  throw new Error(message);
}
const state=(name,condition)=>`select exists(select 1 from pg_stat_activity where application_name='${name}' and ${condition});`;
const idle=name=>waitFor(state(name,"state='idle in transaction'"),'Holder not ready: '+name,name);
const locked=name=>waitFor(state(name,"wait_event_type='Lock'"),'No observed lock wait: '+name);
const key=n=>`7f000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const snapshot=async()=>JSON.parse((await query('select coalesce(jsonb_agg(to_jsonb(e) order by event_position),\'[]\'::jsonb) from cnyos_consent_internal.decision_events e;')).out);
const denied=(r,code)=>{assert.notEqual(r.code,0);assert.match(r.err,new RegExp(code));};
const writerSignature='cnyos_consent_internal.record_decision(uuid,uuid,uuid,bigint,text,text,text,text,text,text,timestamptz)';
async function restoreState(database='postgres'){
  const data=JSON.parse((await query(`select jsonb_build_object(
    'purposes',(select jsonb_agg(to_jsonb(p) order by id) from cnyos_consent_internal.purpose_versions p),
    'events',(select jsonb_agg(to_jsonb(e) order by event_position) from cnyos_consent_internal.decision_events e),
    'permissions',(select jsonb_agg(to_jsonb(r) order by clinic_id,recorder_id,purpose_version_id) from cnyos_consent_internal.recording_permissions r),
    'permission_events',(select jsonb_agg(to_jsonb(a) order by audit_position) from cnyos_consent_internal.recording_permission_events a),
    'permission_sequence',(select jsonb_build_object('last_value',last_value,'is_called',is_called)
      from cnyos_consent_internal.recording_permission_events_audit_position_seq),
    'sequence',(select jsonb_build_object('last_value',last_value,'is_called',is_called)
      from cnyos_consent_internal.decision_events_event_position_seq));`,{database})).out);
  const access=JSON.parse((await query(`select jsonb_agg(jsonb_build_object(
    'role',r,'schema',has_schema_privilege(r,'cnyos_consent_internal','USAGE'),
    'writer',has_function_privilege(r,'${writerSignature}','EXECUTE'),
    'tables',(select jsonb_agg(jsonb_build_object('name',c.relname,'rls',c.relrowsecurity,
      'select',has_table_privilege(r,c.oid,'SELECT'),'insert',has_table_privilege(r,c.oid,'INSERT'),
      'update',has_table_privilege(r,c.oid,'UPDATE'),'delete',has_table_privilege(r,c.oid,'DELETE')) order by c.relname)
      from pg_class c where c.relnamespace='cnyos_consent_internal'::regnamespace and c.relkind='r'),
    'permission_sequence_usage',has_sequence_privilege(r,'cnyos_consent_internal.recording_permission_events_audit_position_seq','USAGE'),
    'permission_audit_execute',has_function_privilege(r,'cnyos_consent_internal.audit_recording_permission_change()','EXECUTE'),
    'sequence_usage',has_sequence_privilege(r,'cnyos_consent_internal.decision_events_event_position_seq','USAGE')) order by r)
    from unnest(array['anon','authenticated','service_role']) r;`,{database})).out);
  const routines=JSON.parse((await query(`select jsonb_agg(jsonb_build_object('name',p.proname,
    'identity',pg_get_function_identity_arguments(p.oid),'definition',pg_get_functiondef(p.oid),
    'owner',pg_get_userbyid(p.proowner)) order by p.proname)
    from pg_proc p where p.pronamespace='cnyos_consent_internal'::regnamespace;`,{database})).out);
  const triggers=JSON.parse((await query(`select jsonb_agg(jsonb_build_object('name',t.tgname,
    'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid)) order by t.tgname)
    from pg_trigger t join pg_class c on c.oid=t.tgrelid
    where c.relnamespace='cnyos_consent_internal'::regnamespace and not t.tgisinternal;`,{database})).out);
  return {data,access,routines,triggers};
}
let owned=false;
try{
  docker(['run','--pull=never','--detach','--rm','--network','none','--name',container,'-e','POSTGRES_HOST_AUTH_METHOD=trust',image]);owned=true;
  let ready=false;
  for(let i=0;i<100;i++){try{if(docker(['exec',container,'cat','/proc/1/comm'])==='postgres'){docker(['exec',container,'pg_isready','-U','postgres']);ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
  assert.ok(ready,'Synthetic database startup timeout');
  const adapter={exec:sql=>query(sql),query:async sql=>{await query("set request.jwt.claim.role='service_role';"+sql);return {rows:[]};}};
  await createPriceMasterFixture({database:adapter,nativePostgres:true});
  for(const [file,code] of [['purpose_consent_ledger_candidate.sql','PURPOSE_CONSENT_REVIEW_REQUIRED'],['purpose_consent_writer_candidate.sql','PURPOSE_CONSENT_WRITER_REVIEW_REQUIRED']]){
    const source=fs.readFileSync(new URL(`../supabase/manual/${file}`,import.meta.url),'utf8');
    const blocker=`do $$ begin raise exception '${code}'; end $$;`;
    assert.equal(source.split(blocker).length,2);
    denied(await query(source,{allowError:true}),code);
    if(file.includes('ledger')) assert.equal((await query("select to_regnamespace('cnyos_consent_internal') is null;")).out,'t');
    else assert.equal((await query("select to_regclass('cnyos_consent_internal.recording_permissions') is null;")).out,'t');
    await query(source.replace(blocker,'-- Explicit disposable synthetic fixture only.'));
  }
  const patient=(await query(`select id from public.patients where clinic_id='${ids.clinicA}' limit 1;`)).out;
  const versions=[key(101),key(102)];
  for(const [i,version] of versions.entries()) await query(`insert into cnyos_consent_internal.purpose_versions(id,clinic_id,purpose_code,version,data_categories,notice_sha256,source_reference)
    values('${version}','${ids.clinicA}','synthetic',${i+1},array['synthetic'],'${'a'.repeat(64)}','SYN-NOT-APPROVED');
    insert into cnyos_consent_internal.recording_permissions(clinic_id,recorder_id,purpose_version_id,active,policy_reference)
    values('${ids.clinicA}','${ids.userA}','${version}',true,'SYN-NOT-APPROVED');`);
  const call=(n,position=0,decision='grant',version=versions[0])=>`select row_to_json(r) from cnyos_consent_internal.record_decision('${key(n)}','${patient}','${version}',${position},'${decision}','self','SYN-EVIDENCE','${'b'.repeat(64)}',null,'SYN-SOURCE','2026-09-27T00:00:00Z') r;`;
  denied(await query(call(1),{actor:true,allowError:true}),'permission denied');
  assert.deepEqual(await snapshot(),[]);
  // Test-only exposure to exercise private body; source grants remain absent.
  await query('grant usage on schema cnyos_consent_internal to authenticated; grant execute on function cnyos_consent_internal.record_decision(uuid,uuid,uuid,bigint,text,text,text,text,text,text,timestamptz) to authenticated;');

  let h=holder(auth+call(1),'same_request_holder');await idle('same_request_holder');
  const replay=query(call(1),{actor:true,name:'same_request_waiter',allowError:true});
  await locked('same_request_waiter');h.release();const first=await h.done,duplicate=await replay;
  assert.equal(first.code,0,first.err);assert.equal(duplicate.code,0,duplicate.err);
  assert.deepEqual(JSON.parse(duplicate.out),JSON.parse(first.out));
  let rows=await snapshot();assert.equal(rows.length,1);

  h=holder(auth+call(2,rows[0].event_position,'withdraw'),'withdraw_holder');await idle('withdraw_holder');
  const stale=query(call(3,rows[0].event_position),{actor:true,name:'stale_grant',allowError:true});
  await locked('stale_grant');h.release();assert.equal((await h.done).code,0);
  denied(await stale,'CONSENT_STATE_CHANGED');
  rows=await snapshot();assert.equal(rows.length,2);assert.equal(rows[1].decision,'withdraw');
  assert.deepEqual(JSON.parse((await query(call(1),{actor:true})).out),rows[0]);
  assert.deepEqual(await snapshot(),rows,'old replay must not append or overwrite withdrawal');

  const permissionUpdate=value=>`update cnyos_consent_internal.recording_permissions set active=${value} where purpose_version_id='${versions[0]}';`;
  h=holder(permissionUpdate(false),'revoke_holder');await idle('revoke_holder');
  const waitingRecord=query(call(4,rows[1].event_position),{actor:true,name:'revoked_recorder',allowError:true});
  await locked('revoked_recorder');h.release();assert.equal((await h.done).code,0);
  denied(await waitingRecord,'CONSENT_RECORDING_NOT_AUTHORIZED');assert.deepEqual(await snapshot(),rows);

  await query(permissionUpdate(true));
  h=holder(auth+call(4,rows[1].event_position),'record_holder');await idle('record_holder');
  const revoke=query(permissionUpdate(false),{name:'revoke_waiter',allowError:true});
  await locked('revoke_waiter');h.release();assert.equal((await h.done).code,0);
  assert.equal((await revoke).code,0);rows=await snapshot();assert.equal(rows.length,3);
  denied(await query(call(4,rows[1].event_position),{actor:true,allowError:true}),'CONSENT_RECORDING_NOT_AUTHORIZED');
  denied(await query(call(5,rows[2].event_position),{actor:true,allowError:true}),'CONSENT_RECORDING_NOT_AUTHORIZED');
  assert.deepEqual(await snapshot(),rows);

  // A new notice version must not escape the same patient/purpose lock.
  await query(permissionUpdate(true));
  h=holder(auth+call(6,rows[2].event_position,'withdraw'),'version_one_holder');await idle('version_one_holder');
  const newer=query(call(7,rows[2].event_position,'grant',versions[1]),{actor:true,name:'version_two_waiter',allowError:true});
  await locked('version_two_waiter');h.release();assert.equal((await h.done).code,0);
  denied(await newer,'CONSENT_STATE_CHANGED');const final=await snapshot();
  assert.equal(final.length,4);assert.deepEqual(final.slice(0,3),rows);assert.equal(final[3].decision,'withdraw');
  // Match fixture.asOwner bootstrap context; this is not a membership API test.
  const membershipUpdate=value=>`set request.jwt.claim.role='service_role';update public.clinic_memberships set active=${value} where clinic_id='${ids.clinicA}' and profile_id='${ids.userA}';`;
  h=holder(membershipUpdate(false),'disable_holder');await idle('disable_holder');
  const disabled=query(call(8,final[3].event_position),{actor:true,name:'disabled_recorder',allowError:true});
  await locked('disabled_recorder');h.release();assert.equal((await h.done).code,0);
  denied(await disabled,'CLINIC_ACCESS_REQUIRED');assert.deepEqual(await snapshot(),final);

  await query(membershipUpdate(true));
  h=holder(auth+call(8,final[3].event_position),'member_record_holder');await idle('member_record_holder');
  const disable=query(membershipUpdate(false),{name:'disable_waiter',allowError:true});
  await locked('disable_waiter');h.release();assert.equal((await h.done).code,0);
  assert.equal((await disable).code,0);rows=await snapshot();assert.equal(rows.length,5);
  assert.deepEqual(rows.slice(0,4),final);
  denied(await query(call(9,rows[4].event_position),{actor:true,allowError:true}),'CLINIC_ACCESS_REQUIRED');
  assert.deepEqual(await snapshot(),rows);
  console.log(`Native consent candidate passed: observed replay, stale grant/withdrawal, both permission-revocation and membership-disable orders, and cross-version stream locks; immutable history preserved. Image ${image}. Synthetic fixture only, no approved purposes or activation.`);
  if(process.argv.includes('--restore')){
    await query(membershipUpdate(true));
    await query(call(10,rows[4].event_position,'withdraw'),{actor:true});
    // Dump source ACL, not the temporary harness exposure.
    await query(`revoke usage on schema cnyos_consent_internal from authenticated;
      revoke execute on function ${writerSignature} from authenticated;`);
    const before=await restoreState();
    assert.ok(before.data.permission_events.length>=2,'permission history must be populated before restore');
    assert.ok(before.data.permission_events.some(event=>event.operation==='UPDATE'
      &&event.before_state.active===true&&event.after_state.active===false),'restore fixture must include an actual permission revocation');
    for(const role of before.access){
      assert.equal(role.schema,false);assert.equal(role.writer,false);assert.equal(role.sequence_usage,false);
      assert.equal(role.permission_sequence_usage,false);assert.equal(role.permission_audit_execute,false);
      for(const table of role.tables){assert.equal(table.rls,true);for(const privilege of ['select','insert','update','delete'])assert.equal(table[privilege],false);}
    }
    const dump=execFileSync('docker',['exec','-i',container,'pg_dump','-U','postgres','--format=custom','--dbname','postgres'],
      {timeout:30000,maxBuffer:64*1024*1024,stdio:['pipe','pipe','pipe']});
    assert.ok(Buffer.isBuffer(dump)&&dump.length>1000,'Empty native backup');
    const database='cnyos_consent_restore';
    docker(['exec',container,'createdb','-U','postgres',database]);
    execFileSync('docker',['exec','-i',container,'pg_restore','-U','postgres','--exit-on-error','--dbname',database],
      {input:dump,timeout:30000,maxBuffer:64*1024*1024,stdio:['pipe','pipe','pipe']});
    assert.deepEqual(await restoreState(database),before,'restore must preserve all rows, sequence state, effective private ACL, routine definitions and immutable triggers');
    denied(await query(call(1),{database,actor:true,allowError:true}),'permission denied');
    // Temporary target-only exposure, never an application/source grant.
    await query(`grant usage on schema cnyos_consent_internal to authenticated;
      grant execute on function ${writerSignature} to authenticated;`,{database});
    const historical=JSON.parse((await query(call(1),{database,actor:true})).out);
    assert.deepEqual(historical,before.data.events[0]);
    assert.deepEqual((await restoreState(database)).data,before.data,'replay must preserve restored withdrawal and sequence');
    const foreignAuth=auth.replace(ids.userA,ids.userB);
    denied(await query(foreignAuth+call(11,0),{database,allowError:true}),'CONSENT_RECORDING_NOT_AUTHORIZED');
    denied(await query("update cnyos_consent_internal.decision_events set decision='grant';",{database,allowError:true}),'CONSENT_HISTORY_IMMUTABLE');
    assert.deepEqual((await restoreState(database)).data,before.data);
    const latest=before.data.events.at(-1);assert.equal(latest.decision,'withdraw');
    const appended=JSON.parse((await query(call(11,latest.event_position,'decline'),{database,actor:true})).out);
    assert.ok(appended.event_position>latest.event_position,'restored identity sequence must advance');
    const after=(await restoreState(database)).data;
    assert.deepEqual(after.permission_events,before.data.permission_events,'recording a decision must not rewrite permission history');
    assert.deepEqual(after.events.slice(0,-1),before.data.events);assert.equal(after.events.length,before.data.events.length+1);
    assert.deepEqual(await restoreState(),before,'target verification cannot mutate the source database');
    console.log(`Native consent restore passed: rows/sequence/ACL/routines/triggers preserved; old replay, tenant denial, immutability and new event after restore verified. Synthetic dump SHA-256 ${createHash('sha256').update(dump).digest('hex')}. Not encrypted Drive/NAS backup or production RPO/RTO evidence.`);
  }
}finally{for(const child of active)child.kill();if(owned)docker(['rm','--force',container]);}
