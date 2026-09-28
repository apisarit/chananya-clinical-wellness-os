// Native PostgreSQL, synthetic populated upgrade only. No host ports or network.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createPriceMasterFixture, PRICE_FIXTURE_IDS as ids } from './helpers/price-master-fixture.mjs';

const image = 'sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24';
const container = `cnyos-quality-upgrade-${process.pid}-${Date.now()}`;
const migrationName = '20260926202710_quality_evidence_read.sql';
const migration = await fs.readFile(new URL(`../supabase/migrations/${migrationName}`, import.meta.url), 'utf8');
const tables = ['products','formulas','formula_components','production_orders','production_material_issues','production_qc','finished_goods_receipts'];
const key = n => `8d000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const quality = key(1);
const docker = (args,input) => execFileSync('docker',args,{input,encoding:'utf8',timeout:45000,maxBuffer:32*1024*1024,stdio:['pipe','pipe','pipe']});
const sql = text => docker(['exec','-i',container,'psql','-XqAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres'], `set statement_timeout='30s';\n${text}` ).trim();
const auth = `set request.jwt.claim.sub='${quality}'; set request.jwt.claim.role='authenticated'; set role authenticated;`;
const privileged = `set request.jwt.claim.sub=''; set request.jwt.claim.role='service_role';`;
const read = table => JSON.parse(sql(`${auth} select coalesce(jsonb_agg(id order by id),'[]') from public.${table} where id::text like '8d%';`));
const snapshot = () => Object.fromEntries([...tables,'inventory_lots'].map(table=>[table,JSON.parse(sql(`select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.${table} t where id::text like '8d%';`))]));
const policies = () => JSON.parse(sql(`select coalesce(jsonb_agg(to_jsonb(p) order by tablename,policyname),'[]') from pg_policies p where schemaname='public' and policyname<>'quality_evidence_read';`));
const grants = () => sql(`select coalesce(jsonb_agg(jsonb_build_array(c.relname,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity) order by c.relname),'[]') from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public';`);
const rollback = `begin; ${tables.map(t=>`drop policy quality_evidence_read on public.${t};`).join('\n')} commit;`;
let owned=false, beforeRows, beforePolicies, beforeGrants;
try {
  assert.equal(docker(['image','inspect','postgres:17-alpine','--format','{{.Id}}']).trim(),image);
  docker(['run','--pull=never','--detach','--rm','--network','none','--name',container,'-e','POSTGRES_HOST_AUTH_METHOD=trust',image]);
  owned=true;
  for(let i=0;i<120;i++) {
    try {
      // The image briefly starts a temporary server during initdb; do not
      // mistake its successful query for readiness of the final server.
      assert.match(docker(['logs',container]),/PostgreSQL init process complete/);
      sql('select 1;'); break;
    }
    catch(error) { if(i===119) throw error; await new Promise(resolve=>setTimeout(resolve,250)); }
  }
  assert.match(sql('show server_version;'),/^17\./);
  const adapter={exec:async text=>{sql(text);return {rows:[]};},query:async text=>{sql(privileged+text);return {rows:[]};}};
  await createPriceMasterFixture({database:adapter,nativePostgres:true,beforeMigration:async({file})=>{
    if(file!==migrationName)return;
    sql(`${privileged}
      insert into auth.users(id,email) values('${quality}','quality-upgrade@example.test');
      update public.profiles set role='quality',system_role='staff' where id='${quality}';
      insert into public.clinic_memberships(clinic_id,profile_id,clinic_role,is_primary,active)
        values('${ids.clinicA}','${quality}','quality',true,true);
      insert into public.products(id,sku,name_th,category,stock_unit,dispense_unit,clinic_id)
        values('${key(2)}','QC-UPGRADE','Synthetic QC product','medicine','ชิ้น','ชิ้น','${ids.clinicA}');
      insert into public.formulas(id,formula_code,name_th,finished_product_id,standard_batch_size,batch_unit,status,clinic_id)
        values('${key(3)}','QC-UPGRADE','Synthetic formula','${key(2)}',10,'ชิ้น','approved','${ids.clinicA}');
      insert into public.formula_components(id,formula_id,material_product_id,quantity_per_batch,unit,clinic_id)
        values('${key(4)}','${key(3)}','${key(2)}',10,'ชิ้น','${ids.clinicA}');
      insert into public.inventory_lots(id,product_id,lot_number,received_quantity,current_quantity,unit,clinic_id)
        values('${key(5)}','${key(2)}','QC-UPGRADE-LOT',10,8,'ชิ้น','${ids.clinicA}');
      insert into public.production_orders(id,production_order_no,formula_id,finished_product_id,batch_number,planned_quantity,planned_unit,actual_quantity,status,produced_by,clinic_id)
        values('${key(6)}','QC-UPGRADE-ORDER','${key(3)}','${key(2)}','QC-UPGRADE-BATCH',10,'ชิ้น',10,'released','${ids.userA}','${ids.clinicA}');
      insert into public.production_material_issues(id,production_order_id,formula_component_id,material_product_id,inventory_lot_id,required_quantity,issued_quantity,unit,clinic_id)
        values('${key(7)}','${key(6)}','${key(4)}','${key(2)}','${key(5)}',2,2,'ชิ้น','${ids.clinicA}');
      insert into public.production_qc(id,production_order_id,status,tested_by,result_summary,clinic_id)
        values('${key(8)}','${key(6)}','passed','${quality}','Synthetic historical evidence','${ids.clinicA}');
      insert into public.finished_goods_receipts(id,production_order_id,inventory_lot_id,received_quantity,unit,clinic_id)
        values('${key(9)}','${key(6)}','${key(5)}',10,'ชิ้น','${ids.clinicA}');
    `);
    beforeRows=snapshot();beforePolicies=policies();beforeGrants=grants();
    assert.deepEqual(read('production_orders'),[],'reproduce missing Quality read on populated baseline');
  }});
  assert.deepEqual(snapshot(),beforeRows,'upgrade must preserve historical rows exactly');
  assert.deepEqual(policies(),beforePolicies,'existing policies unchanged');
  assert.equal(grants(),beforeGrants,'table ACL/RLS flags unchanged');
  for(const table of tables) assert.equal(read(table).length,1,`Quality ${table} read after upgrade`);
  sql(rollback);
  assert.deepEqual(read('production_orders'),[],'rollback must restore previous access');
  assert.deepEqual(snapshot(),beforeRows,'rollback must not remove historical evidence');
  // Force a conflict at the final table in the migration. Earlier policies
  // created in that same transaction must not survive the failed application.
  sql('create policy quality_evidence_read on public.finished_goods_receipts for select to authenticated using(false);');
  assert.throws(()=>sql(migration),/already exists/);
  assert.equal(sql("select count(*) from pg_policies where policyname='quality_evidence_read';"),'1');
  assert.deepEqual(snapshot(),beforeRows,'failed apply must preserve data');
  sql('drop policy quality_evidence_read on public.finished_goods_receipts;');
  sql(migration);
  for(const table of tables) assert.equal(read(table).length,1,`Quality ${table} read after forward recovery`);
  assert.deepEqual(snapshot(),beforeRows);
  assert.deepEqual(policies(),beforePolicies);
  assert.equal(grants(),beforeGrants);
  if(process.env.CNYOS_TEST_QUALITY_BROWSER==='1') {
    const producer=key(10),requestId=key(11),materialId=key(12);
    sql(`${privileged}
      insert into auth.users(id,email) values('${producer}','production-browser@example.test');
      update public.profiles set role='production',system_role='staff' where id='${producer}';
      insert into public.clinic_memberships(clinic_id,profile_id,clinic_role,is_primary,active)
        values('${ids.clinicA}','${producer}','production',true,true);
      insert into public.products(id,sku,name_th,category,stock_unit,dispense_unit,clinic_id)
        values('${materialId}','BROWSER-RAW','Synthetic raw material','raw_material','ชิ้น','ชิ้น','${ids.clinicA}');
      insert into public.inventory_lots(id,product_id,lot_number,received_quantity,current_quantity,unit,expiry_date,clinic_id)
        values('${key(13)}','${materialId}','BROWSER-EARLY',1,1,'ชิ้น',current_date+30,'${ids.clinicA}'),
              ('${key(14)}','${materialId}','BROWSER-LATE',3,3,'ชิ้น',current_date+90,'${ids.clinicA}');
      insert into public.production_requests(id,request_no,requested_product_id,requested_quantity,unit,status,clinic_id)
        values('${requestId}','BROWSER-REQUEST','${key(2)}',9,'ชิ้น','requested','${ids.clinicA}');
    `);
    const {productionQualityBrowser}=await import('./helpers/production-quality-browser.mjs');
    const orderId=await productionQualityBrowser({producer,quality,clinic:ids.clinicA,requestId,finishedId:key(2),materialId,
      query:(actor,text)=>JSON.parse(sql(`set request.jwt.claim.sub='${actor}'; set request.jwt.claim.role='authenticated'; set role authenticated; ${text};`))});
    assert.equal(sql(`select status from public.production_orders where id='${orderId}'`),'released');
    assert.equal(sql(`select current_quantity from public.inventory_lots where id='${key(13)}'`),'0.0000');
    assert.equal(sql(`select current_quantity from public.inventory_lots where id='${key(14)}'`),'2.0000');
    assert.equal(sql(`select count(*) from public.production_material_issues where production_order_id='${orderId}'`),'2');
    assert.equal(sql(`select count(*) from public.production_qc where production_order_id='${orderId}'`),'1');
    assert.equal(sql(`select count(*) from public.finished_goods_receipts where production_order_id='${orderId}'`),'1');
    assert.equal(sql(`select received_quantity from public.finished_goods_receipts where production_order_id='${orderId}'`),'9.0000');
    assert.equal(sql(`select tested_by from public.production_qc where production_order_id='${orderId}'`),quality);
    assert.equal(sql(`select produced_by from public.production_orders where id='${orderId}'`),producer);
    assert.equal(sql(`select l.current_quantity from public.finished_goods_receipts r join public.inventory_lots l on l.id=r.inventory_lot_id where r.production_order_id='${orderId}'`),'9.0000');
    for(const [action,actor] of [['complete_production_order',producer],['quality_release_production_order',quality]]) {
      assert.equal(sql(`select count(*) from public.audit_logs where entity_id='${orderId}' and action='${action}' and user_id='${actor}'`),'1');
    }
  }
  console.log('Native PostgreSQL 17 Quality upgrade passed: populated seven-table read, exact historical row/ACL/policy preservation, rollback, late failure atomicity and forward recovery. Synthetic isolated database only.');
} finally {
  if(owned) docker(['rm','--force',container]);
}
