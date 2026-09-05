import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { handleAccountAccess } from '../netlify/functions/account-access.mts';

const uid='11111111-1111-4111-8111-111111111111';
const other='22222222-2222-4222-8222-222222222222';
const clinic='00000000-0000-4000-8000-00000000a001';
const origin='https://cnyos-account-test.netlify.app';
const token='signed-user-session-token-1234567890';
const context={site:{id:'7da5e39e-580d-44f1-8623-605313e2fb2b',url:origin},deploy:{id:'deploy-123456',context:'production',published:true}};
const env={SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'server-only-key',CNYOS_OWNER_EXPECTED_PROJECT_REF:'abcdefghijklmnopqrst',CNYOS_OWNER_EXPECTED_NETLIFY_SITE_ID:context.site.id,CNYOS_OWNER_EXPECTED_SITE_ORIGIN:origin,CNYOS_ACCOUNT_CLINIC_ID:clinic,CNYOS_ACCOUNT_CLINIC_CODE:'CLINIC-STG'};
const verified={id:uid,email:'new@example.test',aud:'authenticated',email_confirmed_at:'2026-09-05T10:00:00Z',user_metadata:{full_name:'New user',role:'super_admin',system_role:'super_admin'}};
const governance={clinic_id:clinic,clinic_code:'CLINIC-STG',clinic_role:'owner',system_role:'super_admin',ready:true};
const profile={id:uid,full_name:'New user',email:'new@example.test',role:'viewer',system_role:'staff',clinic_memberships:[]};
const req=(body={action:'status'},headers={})=>new Request(origin+'/api/account-access',{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+token,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
const json=(data,status=200)=>new Response(JSON.stringify(data),{status});

async function run({body,headers,ctx=context,user=verified,missing=false,memberships=[],access=governance,afterAccess=access,memberRows=[],pendingRows=[profile],authStatus=200}={}){
  const calls=[];let ownReads=0,accessReads=0;
  const response=await handleAccountAccess(req(body,headers),ctx,{getEnv:key=>env[key]||'',fetchImpl:async(url,options)=>{
    const path=new URL(url).pathname+new URL(url).search;calls.push({path,...options});
    if(path==='/auth/v1/user')return json(user,authStatus);
    if(path==='/rest/v1/rpc/current_access_context')return json(++accessReads===1?access:afterAccess);
    if(path.startsWith('/rest/v1/profiles?on_conflict'))return new Response(null,{status:201});
    if(path.startsWith('/rest/v1/profiles?select=id,full_name,email&id='))return json(missing&&++ownReads===1?[]:[profile]);
    if(path.startsWith('/rest/v1/clinic_memberships?'))return json(memberships);
    if(path.includes('clinic_memberships!inner'))return json(memberRows);
    if(path.includes('clinic_memberships=is.null'))return json(pendingRows);
    throw new Error('Unexpected database resource: '+path);
  }});
  return {response,body:await response.json(),calls};
}

const fresh=await run({missing:true});
assert.equal(fresh.response.status,200);assert.equal(fresh.body.status,'pending_approval');
const insert=fresh.calls.find(c=>c.path.includes('on_conflict'));
assert.deepEqual(JSON.parse(insert.body),{id:uid,email:verified.email,full_name:'New user',role:'viewer',system_role:'staff'});
assert.equal(insert.headers.Prefer,'resolution=ignore-duplicates,return=minimal');
assert.equal(fresh.body.profile.role,undefined);assert.equal(fresh.body.profile.system_role,undefined);
assert.equal(fresh.calls[0].headers.Authorization,'Bearer '+token);
assert.ok(fresh.calls.slice(1).every(c=>c.headers.Authorization==='Bearer server-only-key'));
assert.equal(fresh.calls.filter(c=>c.method==='POST').length,1,'never create a clinic membership');
assert.match(fresh.response.headers.get('cache-control'),/no-store/);

const existing=await run();assert.ok(existing.calls.every(c=>c.method==='GET'),'existing profiles never change');
const disabled=await run({memberships:[{clinic_id:clinic}]});assert.equal(disabled.body.status,'access_unavailable');
assert.ok(disabled.calls.every(c=>c.method==='GET'),'inactive or suspended membership cannot be reactivated');

for(const input of [
  {headers:{Origin:'https://attacker.test'}},
  {headers:{Authorization:''}},
  {authStatus:401},
  {user:{...verified,is_anonymous:true}},
  {user:{...verified,email_confirmed_at:null}},
  {user:{...verified,aud:'service_role'}},
  {user:{...verified,banned_until:'2099-01-01T00:00:00Z'}},
  {body:{action:'status',id:other}},
  {body:{action:'status',role:'super_admin'}},
  {ctx:{...context,deploy:{...context.deploy,published:false}}},
  {ctx:{...context,deploy:{...context.deploy,context:'deploy-preview'}}},
  {ctx:{...context,site:{...context.site,id:other}}}
]){
  const rejected=await run(input);assert.ok(rejected.response.status>=400);
  assert.ok(!rejected.calls.some(c=>c.path.startsWith('/rest/')),'invalid callers cannot touch profiles');
}

const crossClinic={...profile,id:other,clinic_memberships:[{clinic_id:other,clinic_role:'admin',active:true}]};
const member={...profile,id:'33333333-3333-4333-8333-333333333333',clinic_memberships:[{clinic_id:clinic,clinic_role:'pharmacy',active:true}]};
const listed=await run({body:{action:'staff_list'},memberRows:[member,crossClinic],pendingRows:[profile,crossClinic]});
assert.deepEqual(listed.body.users.map(p=>p.id),[uid,member.id]);
assert.equal(listed.body.users[0].access_status,'pending_approval');
assert.equal(listed.body.users[1].role,'pharmacy');
assert.ok(listed.calls.filter(c=>c.path.includes('/rpc/')).every(c=>c.headers.Authorization==='Bearer '+token));
assert.ok(listed.calls.every(c=>!c.path.includes('on_conflict')),'listing cannot create users');
const ordinary=await run({body:{action:'staff_list'},access:{...governance,system_role:'admin',clinic_role:'admin'},memberRows:[member]});
assert.equal(ordinary.body.users.length,1);assert.ok(!ordinary.calls.some(c=>c.path.includes('clinic_memberships=is.null')));
for(const access of [null,[],{...governance,ready:false},{...governance,clinic_id:other},{...governance,clinic_code:'OTHER'},{...governance,clinic_role:'viewer',system_role:'staff'}]){
  const r=await run({body:{action:'staff_list'},access});assert.equal(r.response.status,403);
  assert.ok(!r.calls.some(c=>c.path.startsWith('/rest/v1/profiles')));
}
const revoked=await run({body:{action:'staff_list'},afterAccess:null});assert.equal(revoked.response.status,403);assert.equal(revoked.body.users,undefined);

// A service identity response must never be promoted to browser authorization.
const source=fs.readFileSync(new URL('../chananya-runtime.js',import.meta.url),'utf8');
let browserRequests=0;
class Element {
  constructor(tag='div'){this.tag=tag;this.children=[];this.textContent='';this.events={};this.classes=new Set();this.classList={add:x=>this.classes.add(x)};}
  appendChild(child){this.children.push(child);return child;}
  addEventListener(event,listener){this.events[event]=listener;}
}
const spinner=new Element(),title=new Element('h2'),message=new Element('p'),container=new Element();
const boot={firstElementChild:container,querySelector:selector=>selector==='.spinner'?spinner:title};
const document={getElementById:id=>({'boot':boot,'boot-error':message}[id]||null),createElement:tag=>new Element(tag)};
let reloaded=false;
const window={CHANANYA_AUTH:{url:env.SUPABASE_URL,anonKey:'public-key'},supabase:{createClient(){return {
  auth:{async getSession(){return {data:{session:{access_token:token,user:{id:uid}}}};}},
  from(){return {select(){return this;},eq(){return this;},async maybeSingle(){return {data:null,error:null};}};}
};}}};
vm.runInNewContext(source,{window,fetch:async(url,options)=>{
  browserRequests++;assert.equal(url,'/api/account-access');assert.equal(options.headers.Authorization,'Bearer '+token);
  return json({...fresh.body,profile:{...fresh.body.profile,role:'super_admin',system_role:'super_admin',access_context_ready:true}});
},AbortSignal,console,document,location:{reload(){reloaded=true;}}});
const pending=await window.ChananyaRuntime.getProfile(uid);
assert.equal(browserRequests,1);assert.equal(pending.role,'viewer');assert.equal(pending.system_role,'staff');
assert.equal(pending.access_context_ready,false);assert.equal(window.ChananyaRuntime.can(pending,'luopan_read'),false);
window.ChananyaRuntime.showAccountStatus(pending,{user:{email:verified.email}});
assert.ok(spinner.classes.has('hidden'));assert.match(title.textContent,/รอกำหนดสิทธิ์/);
assert.ok(container.children[0].children.some(el=>el.textContent===verified.email));
const retry=container.children[0].children.find(el=>el.textContent==='ตรวจสอบสิทธิ์อีกครั้ง');retry.events.click();assert.equal(reloaded,true);
assert.ok(container.children[0].children.some(el=>el.textContent==='ออกจากระบบ / เปลี่ยนบัญชี'));
await assert.rejects(()=>window.ChananyaRuntime.getProfile(other),/บัญชีเข้าสู่ระบบเปลี่ยนไป/);
for(const file of ['app.js','luopan-auth.js']){
  const code=fs.readFileSync(new URL('../'+file,import.meta.url),'utf8');
  assert.match(code,/access_context_ready !== true.*showAccountStatus\(profile, session\); return;/);
}
console.log('Account access passed: verified self-profile recovery, no role escalation, scoped staff lists, suspension and preview denial, and fail-closed browser handling.');
