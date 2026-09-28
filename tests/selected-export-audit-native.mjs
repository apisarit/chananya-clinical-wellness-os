// Native PostgreSQL 17; synthetic fixtures only, no remote target/ports/mounts.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {createPriceMasterFixture,PRICE_FIXTURE_IDS as ids} from './helpers/price-master-fixture.mjs';
import {BACKUP_DOMAINS,backupSchemaContract,encryptBackup,verifyBackupSet} from '../netlify/functions/_shared/database-backup.mjs';
import {compareRestoreCounts,compareRestoreHashes} from '../scripts/restore-count-comparison.mjs';

const container=`cnyos-export-audit-${process.pid}-${Date.now()}`;
const expectedImage='sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24';
const docker=args=>execFileSync('docker',args,{encoding:'utf8',timeout:30000,stdio:['pipe','pipe','pipe']}).trim();
const image=docker(['image','inspect','postgres:17-alpine','--format','{{.Id}}']);
assert.equal(image,expectedImage,'Unexpected local PostgreSQL image');
const active=new Set(),finished=new Map();
function connection(name,database='postgres'){
  assert.match(name,/^[a-z0-9_]+$/);
  assert.match(database,/^[a-z0-9_]+$/);
  const child=spawn('docker',['exec','-i',container,'psql','-XqAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',database]);
  active.add(child);let out='',err='';
  const done=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill();reject(new Error(`Synthetic SQL timeout: ${name}`));},25000);
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
    child.on('close',code=>{clearTimeout(timer);active.delete(child);const result={code,out:out.trim(),err:err.trim()};finished.set(name,result);resolve(result);});
  });
  done.catch(()=>{});child.stdin.on('error',()=>{});
  child.stdin.write(`set application_name='${name}';set statement_timeout='20s';set idle_in_transaction_session_timeout='20s';\n`);
  return {child,done};
}
const auth=`set request.jwt.claim.sub='${ids.userA}';set request.jwt.claim.role='authenticated';set role authenticated;`;
async function query(sql,{actor=false,name='observer',allowError=false,database='postgres'}={}){
  const c=connection(name,database);c.child.stdin.end((actor?auth:'')+sql);const r=await c.done;
  if(r.code!==0&&!allowError)throw new Error(r.err||r.out);return r;
}
function holder(sql,name){
  const c=connection(name);c.child.stdin.write(`begin;${sql}\n`);
  return {done:c.done,release(commit=true){c.child.stdin.end(commit?'commit;\n':'rollback;\n');}};
}
async function waitState(name,condition){
  const deadline=Date.now()+8000;
  while(Date.now()<deadline){
    if(finished.has(name))throw new Error(`Connection ended before observed ${condition}: ${name}: ${finished.get(name).err}`);
    if((await query(`select exists(select 1 from pg_stat_activity where application_name='${name}' and ${condition});`)).out==='t')return;
    await new Promise(r=>setTimeout(r,30));
  }
  throw new Error(`No observed ${condition}: ${name}`);
}
const idle=name=>waitState(name,"state='idle in transaction'");
const locked=name=>waitState(name,"wait_event_type='Lock'");
const denied=(r,code)=>{assert.notEqual(r.code,0);assert.match(r.err,new RegExp(code));assert.equal(r.out,'','denied export must return no result rows');};
const snapshot=async()=>JSON.parse((await query("select coalesce(jsonb_agg(to_jsonb(e) order by recorded_at,id),'[]'::jsonb) from cnyos_export_internal.preparation_events e;")).out);
async function restoreState(database='postgres'){
  const json=async sql=>JSON.parse((await query(sql,{database})).out);
  const data=await json(`select jsonb_build_object(
    'permissions',(select jsonb_agg(to_jsonb(p) order by clinic_id,actor_id) from cnyos_export_internal.permissions p),
    'permission_events',(select jsonb_agg(to_jsonb(p) order by recorded_at,id) from cnyos_export_internal.permission_events p),
    'preparation_events',(select jsonb_agg(to_jsonb(p) order by recorded_at,id) from cnyos_export_internal.preparation_events p));`);
  const access=await json(`select jsonb_agg(jsonb_build_object(
    'role',r,'schema',has_schema_privilege(r,'cnyos_export_internal','USAGE'),
    'functions',(select jsonb_agg(jsonb_build_object('name',p.proname,
      'execute',has_function_privilege(r,p.oid,'EXECUTE')) order by p.proname)
      from pg_proc p where p.pronamespace='cnyos_export_internal'::regnamespace),
    'tables',(select jsonb_agg(jsonb_build_object('name',c.relname,'rls',c.relrowsecurity,
      'owner',pg_get_userbyid(c.relowner),
      'any_access',has_table_privilege(r,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) order by c.relname)
      from pg_class c where c.relnamespace='cnyos_export_internal'::regnamespace and c.relkind='r')) order by r)
    from unnest(array['anon','authenticated','service_role']) r;`);
  const routines=await json(`select jsonb_agg(jsonb_build_object('name',p.proname,
    'definition',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner)) order by p.proname)
    from pg_proc p where p.pronamespace='cnyos_export_internal'::regnamespace;`);
  const triggers=await json(`select jsonb_agg(jsonb_build_object('table',c.relname,'name',t.tgname,
    'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid)) order by c.relname,t.tgname)
    from pg_trigger t join pg_class c on c.oid=t.tgrelid
    where c.relnamespace='cnyos_export_internal'::regnamespace and not t.tgisinternal;`);
  const constraints=await json(`select jsonb_agg(jsonb_build_object('table',c.relname,'name',k.conname,
    'validated',k.convalidated,'definition',pg_get_constraintdef(k.oid)) order by c.relname,k.conname)
    from pg_constraint k join pg_class c on c.oid=k.conrelid
    where c.relnamespace='cnyos_export_internal'::regnamespace;`);
  return {data,access,routines,triggers,constraints};
}
let owned=false;
try {
  docker(['run','--pull=never','--detach','--rm','--network','none','--name',container,'-e','POSTGRES_HOST_AUTH_METHOD=trust',image]);owned=true;
  let ready=false;
  for(let i=0;i<100;i++){
    try {docker(['exec',container,'pg_isready','-h','127.0.0.1','-U','postgres']);ready=true;break;}
    catch {await new Promise(r=>setTimeout(r,100));}
  }
  assert.ok(ready,'Synthetic PostgreSQL startup timeout');
  const adapter={exec:sql=>query(sql),query:async sql=>{await query("set request.jwt.claim.role='service_role';"+sql);return {rows:[]};}};
  await createPriceMasterFixture({database:adapter,nativePostgres:true});
  const source=await fs.readFile(new URL('../supabase/manual/selected_patient_export_audit_candidate.sql',import.meta.url),'utf8');
  const blocker="do $$ begin raise exception 'SELECTED_EXPORT_AUDIT_REVIEW_REQUIRED'; end $$;";
  assert.equal(source.split(blocker).length,2);
  denied(await query(source,{allowError:true}),'SELECTED_EXPORT_AUDIT_REVIEW_REQUIRED');
  assert.equal((await query("select to_regnamespace('cnyos_export_internal') is null;")).out,'t');
  await query(source.replace(blocker,'-- Test-only installation; source remains inert.'));
  const patient=(await query(`select id from public.patients where clinic_id='${ids.clinicA}' limit 1;`)).out;
  assert.match(patient,/^[a-f0-9-]{36}$/);
  const call=`select cnyos_export_internal.prepare_patients(array['${patient}']::uuid[],'json');`;
  denied(await query(call,{actor:true,allowError:true}),'permission denied');
  assert.deepEqual(await snapshot(),[]);
  // Only this disposable harness exposes the internal routine and grants permission.
  await query(`grant usage on schema cnyos_export_internal to authenticated;
    grant execute on function cnyos_export_internal.prepare_patients(uuid[],text) to authenticated;
    insert into cnyos_export_internal.permissions(clinic_id,actor_id,active,policy_reference)
    values('${ids.clinicA}','${ids.userA}',true,'SYN-NATIVE-NOT-APPROVED');`);
  const permission=value=>`update cnyos_export_internal.permissions set active=${value};`;
  const membership=value=>`set request.jwt.claim.role='service_role';update public.clinic_memberships set active=${value}
    where clinic_id='${ids.clinicA}' and profile_id='${ids.userA}';`;
  let subscriptionRequest=0;
  async function subscription(value){
    const version=(await query(`select subscription_version from public.clinics where id='${ids.clinicA}';`)).out;
    return `set request.jwt.claim.role='service_role';select public.set_clinic_subscription_state(
      'ee000000-0000-4000-8000-${String(++subscriptionRequest).padStart(12,'0')}',
      '${ids.clinicA}','CHANANYA',${value},${version},'Synthetic export concurrency','${ids.owner}','owner@example.test');`;
  }
  for(const [boundary,mutation,error] of [
    ['permission',permission,'EXPORT_NOT_AUTHORIZED'],
    ['membership',membership,'CLINIC_ACCESS_REQUIRED'],
    ['subscription',subscription,'CNYOS_SUBSCRIPTION_SUSPENDED|CLINIC_ACCESS_REQUIRED']
  ]) {
    const before=await snapshot();
    // Revoke first: observe the export waiting on the actual row lock.
    let h=holder(await mutation(false),`${boundary}_off_holder`);await idle(`${boundary}_off_holder`);
    const pending=query(call,{actor:true,name:`${boundary}_export_waiter`,allowError:true});
    await locked(`${boundary}_export_waiter`);h.release();
    const off=await h.done;assert.equal(off.code,0,off.err);
    denied(await pending,error);assert.deepEqual(await snapshot(),before);
    await query(await mutation(true));
    // Export first: revoke cannot commit until preparation's transaction finishes.
    h=holder(auth+call,`${boundary}_export_holder`);await idle(`${boundary}_export_holder`);
    const revoking=query(await mutation(false),{name:`${boundary}_off_waiter`,allowError:true});
    await locked(`${boundary}_off_waiter`);
    assert.deepEqual(await snapshot(),before,'uncommitted preparation must not be visible to fresh observer');
    h.release();const exported=await h.done;assert.equal(exported.code,0,exported.err);
    const receipt=JSON.parse(exported.out);assert.equal(receipt.rows[0].id,patient);
    const revoked=await revoking;assert.equal(revoked.code,0,revoked.err);
    const after=await snapshot();assert.equal(after.length,before.length+1);
    assert.deepEqual(after.slice(0,-1),before);assert.equal(after.at(-1).id,receipt.receipt_id);
    denied(await query(call,{actor:true,allowError:true}),error);
    assert.deepEqual(await snapshot(),after);
    await query(await mutation(true));
  }
  const beforeRollback=await snapshot();
  const rolled=holder(auth+call,'rollback_export');await idle('rollback_export');
  assert.deepEqual(await snapshot(),beforeRollback);rolled.release(false);
  assert.equal((await rolled.done).code,0);
  assert.deepEqual(await snapshot(),beforeRollback,'SQL return before rollback is not durable evidence');
  // Ordinary data reads are still possible; this proposal must not claim universal auditing.
  const direct=(await query(`select count(*) from public.patients where id='${patient}';`,{actor:true})).out;
  assert.equal(direct,'1');assert.deepEqual(await snapshot(),beforeRollback);
  console.log(`Native selected-export candidate passed: observed both permission revoke, membership disable and subscription OFF lock orders; fresh post-commit receipts; denial has no data/evidence; rollback leaves no receipt. Image ${image}. No hosted API, download-delivery, universal read audit or activation claim.`);
  if(process.argv.includes('--restore')){
    // Install only in this disposable database; retain every source activation guard.
    for(const [file,code] of [
      ['clinical_amendment_recovery_candidate.sql','CLINICAL_AMENDMENT_RECOVERY_REVIEW_REQUIRED'],
      ['clinical_amendment_backup_candidate.sql','CLINICAL_AMENDMENT_BACKUP_REVIEW_REQUIRED'],
      ['selected_export_backup_candidate.sql','SELECTED_EXPORT_BACKUP_REVIEW_REQUIRED']
    ]){
      const sql=await fs.readFile(new URL(`../supabase/manual/${file}`,import.meta.url),'utf8');
      const guard=`do $$ begin raise exception '${code}'; end $$;`;
      assert.equal(sql.split(guard).length,2);
      denied(await query(sql,{allowError:true}),code);
      await query(sql.replace(guard,'-- Synthetic native restore harness only.'));
    }
    // Persist a revoked permission and remove all harness-only API grants before dump.
    await query(permission(false));
    await query(`revoke usage on schema cnyos_export_internal from authenticated;
      revoke execute on function cnyos_export_internal.prepare_patients(uuid[],text) from authenticated;`);
    const before=await restoreState();
    const version='2026-09-27.3';
    const trace=async(database='postgres')=>JSON.parse((await query(
      `set request.jwt.claim.role='service_role';set role service_role;select public.verify_clinic_restore_trace('${ids.clinicA}');`,{database})).out);
    const key=Buffer.alloc(32,73); // Synthetic key; no provider credentials.
    const envelopes=[];
    for(const domain of BACKUP_DOMAINS){
      const payload=JSON.parse((await query(`set request.jwt.claim.role='service_role';set role service_role;
        select public.export_clinic_backup_domain('${ids.clinicA}','${domain}');`)).out);
      envelopes.push(encryptBackup(payload,key,{environment:'restore-test',deploymentId:'synthetic-native-export',
        sourceRevision:'d'.repeat(40),clinicId:ids.clinicA,clinicCode:'SYNTHETIC',domain,
        slot:'2026-09-27T00:00:00Z'}).envelope);
    }
    const evidence=verifyBackupSet(envelopes,key,{schemaVersion:version});
    const hashed=backupSchemaContract(version).hashed;
    const countBindings=Object.fromEntries(Object.entries(hashed).flatMap(([domain,tables])=>
      tables.map(table=>[table,[domain,table]])));
    const compare=restored=>{
      assert.equal(Object.keys(compareRestoreCounts(evidence,restored.counts,countBindings)).length,17);
      return compareRestoreHashes(evidence,restored.table_sha256,hashed);
    };
    assert.equal(Object.keys(compare(await trace())).length,17);
    assert.equal(before.data.permissions.length,1);
    assert.equal(before.data.permissions[0].active,false);
    assert.equal(before.data.preparation_events.length,3);
    assert.ok(before.data.permission_events.some(e=>e.operation==='UPDATE'&&e.before_state.active&&!e.after_state.active));
    for(const role of before.access){
      assert.equal(role.schema,false);
      for(const routine of role.functions)assert.equal(routine.execute,false);
      for(const table of role.tables){assert.equal(table.rls,true);assert.equal(table.any_access,false);}
    }
    const dump=execFileSync('docker',['exec','-i',container,'pg_dump','-U','postgres','--format=custom','--dbname','postgres'],
      {timeout:30000,maxBuffer:64*1024*1024,stdio:['pipe','pipe','pipe']});
    assert.ok(Buffer.isBuffer(dump)&&dump.length>1000,'Empty synthetic backup');
    const database='cnyos_export_restore';
    docker(['exec',container,'createdb','-U','postgres',database]);
    execFileSync('docker',['exec','-i',container,'pg_restore','-U','postgres','--exit-on-error','--dbname',database],
      {input:dump,timeout:30000,maxBuffer:64*1024*1024,stdio:['pipe','pipe','pipe']});
    assert.deepEqual(await restoreState(database),before,'restore must preserve data and access/immutability enforcement');
    assert.equal(Object.keys(compare(await trace(database))).length,17,
      'Restored native database must match all encrypted-set content hashes');
    const restoredTrace=await trace(database);
    for(const table of Object.keys(countBindings)){
      const missing=structuredClone(restoredTrace);delete missing.counts[table];
      assert.throws(()=>compare(missing),/restored count missing or invalid/);
      for(const invalid of [null,String(restoredTrace.counts[table]),-1]){
        const malformed=structuredClone(restoredTrace);malformed.counts[table]=invalid;
        assert.throws(()=>compare(malformed),/restored count missing or invalid/);
      }
      const mismatch=structuredClone(restoredTrace);mismatch.counts[table]++;
      assert.throws(()=>compare(mismatch),/does not equal source/);
    }
    // Equal row counts must not conceal a changed audit payload after restoration.
    const damaged=JSON.parse((await query(`begin;
      alter table cnyos_export_internal.preparation_events disable trigger user;
      update cnyos_export_internal.preparation_events set requested_format='csv';
      set local request.jwt.claim.role='service_role';
      select public.verify_clinic_restore_trace('${ids.clinicA}');rollback;`,{database})).out);
    assert.throws(()=>compare(damaged),/content hash mismatch/);
    assert.equal(Object.keys(compare(await trace(database))).length,17);
    denied(await query(call,{database,actor:true,allowError:true}),'permission denied');
    // Temporary target-only exposure tests that the stored revoked permission still denies.
    await query(`grant usage on schema cnyos_export_internal to authenticated;
      grant execute on function cnyos_export_internal.prepare_patients(uuid[],text) to authenticated;`,{database});
    denied(await query(call,{database,actor:true,allowError:true}),'EXPORT_NOT_AUTHORIZED');
    denied(await query(auth.replace(ids.userA,ids.userB)+call,{database,allowError:true}),'EXPORT_NOT_AUTHORIZED');
    for(const statement of ['update cnyos_export_internal.preparation_events set requested_format=\'csv\';',
      'delete from cnyos_export_internal.preparation_events;',
      'truncate cnyos_export_internal.preparation_events;',
      'delete from cnyos_export_internal.permission_events;'])
      denied(await query(statement,{database,allowError:true}),'EXPORT_HISTORY_IMMUTABLE');
    assert.deepEqual((await restoreState(database)).data,before.data);
    // An explicit synthetic target regrant can create a new event, never overwrite restored history.
    await query(permission(true),{database});
    const prepared=JSON.parse((await query(call,{database,actor:true})).out);
    const after=(await restoreState(database)).data;
    assert.deepEqual(after.preparation_events.slice(0,-1),before.data.preparation_events);
    assert.equal(after.preparation_events.length,4);
    assert.equal(after.preparation_events.at(-1).id,prepared.receipt_id);
    assert.deepEqual(after.permission_events.slice(0,-1),before.data.permission_events);
    assert.equal(after.permission_events.at(-1).before_state.active,false);
    assert.equal(after.permission_events.at(-1).after_state.active,true);
    assert.deepEqual(await restoreState(),before,'target checks must not alter the source');
    console.log('Native encrypted export reconciliation passed: four domains, 17 source/restored hashes, populated revoked-permission history, and same-count corruption rejection. Database restored from pg_dump, not imported from JSON; no Drive/NAS or hosted restore claim.');
    console.log(`Native selected-export restore passed: metadata, revoked permission, effective ACL/RLS, definitions, constraints and immutable triggers preserved; target regrant appends history; source unchanged. Synthetic dump SHA256 ${createHash('sha256').update(dump).digest('hex')}; candidate SHA256 ${createHash('sha256').update(source).digest('hex')}. Not encrypted Drive/NAS or managed PITR evidence.`);
  }
} finally {
  for(const child of active)child.kill();
  if(owned)docker(['rm','--force',container]);
}
