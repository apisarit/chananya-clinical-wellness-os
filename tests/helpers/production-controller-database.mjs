import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

function harness(source) {
  const nodes=new Map();
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',classList:{add(){},remove(){}},addEventListener(){},close(){this.closed=true;}});return nodes.get(id);};
  const context={console,Intl,window:{setTimeout(){}},document:{querySelector:node,querySelectorAll:()=>[]}};
  vm.runInNewContext(source.replace('  init();\n})();',`
    render=()=>{};
    globalThis.hooks={load,setup(database,actor,clinic,orderId){db=database;session={user:{id:actor}};profile={id:actor,clinic_id:clinic};activeOrderId=orderId;},snapshot:()=>data,
    ${source.includes('saveCompletedOrder')?'complete:saveCompletedOrder,ready(){persistenceReady=true;}':'report:qualityReport'}
    };
  })();`),context);
  return {hooks:context.hooks,node};
}

function adapter(asUser,actorId) {
  // asUser switches roles on one PGlite connection: serialize whole role scopes,
  // not merely individual SQL statements, even though page load uses Promise.all.
  let queue=Promise.resolve();
  const run=sql=>{const result=queue.then(()=>asUser(actorId,sql));queue=result.catch(()=>{});return result;};
  const allowed=new Set(['products','inventory_lots','formulas','formula_components','production_requests','production_orders','production_material_issues','production_qc','finished_goods_receipts']);
  return {run,from(table){assert.ok(allowed.has(table));return {select(){return this;},order(){return this;},then(resolve,reject){return run(`select * from public.${table}`).then(result=>({data:result.rows})).then(resolve,reject);}};}};
}

export async function completeProductionThroughController({asUser,actorId,clinicId,orderId,sql}) {
  const h=harness(await fs.readFile(new URL('../../production.js',import.meta.url),'utf8'));
  const api=adapter(asUser,actorId);let calls=0,result;
  api.rpc=async(name,args)=>{
    assert.equal(name,'complete_production_order');
    assert.deepEqual(JSON.parse(JSON.stringify(args)),{p_production_order_id:orderId,p_actual_quantity:11.5,p_loss_quantity:0.3,p_waste_quantity:0.2});
    calls++;result=await api.run(sql);return {data:result.rows};
  };
  h.hooks.setup(api,actorId,clinicId,orderId);h.hooks.ready();
  h.node('#complete-actual').value='11.5';h.node('#complete-loss').value='0.3';h.node('#complete-waste').value='0.2';
  const control={disabled:false},form={querySelectorAll:()=>[control]};
  const event={preventDefault(){},currentTarget:form};
  const first=h.hooks.complete(event),second=h.hooks.complete(event);
  await Promise.all([first,second]);
  assert.equal(calls,1);assert.equal(control.disabled,false);
  assert.equal(h.node('#complete-dialog').closed,true);
  assert.doesNotMatch(h.node('#toast').textContent,/ไม่สำเร็จ/);
  assert.equal(h.hooks.snapshot().orders.find(row=>row.id===orderId)?.status,'awaiting_qc');
  console.log('Production actual controller/disposable SQL: single completion, real role-scoped list readback and awaiting-QC state passed; render and authentication are test hooks.');
  return result;
}

export async function readQualityThroughController({asUser,actorId,clinicId,orderId,status}) {
  const h=harness(await fs.readFile(new URL('../../quality.js',import.meta.url),'utf8'));
  h.hooks.setup(adapter(asUser,actorId),actorId,clinicId,orderId);
  await h.hooks.load();
  const data=h.hooks.snapshot(),order=data.orders.find(row=>row.id===orderId);
  if (!order) {
    const boundary=await asUser(actorId,"select public.department_can('production_read') production_read, public.current_clinic_id() clinic_id, public.has_role(array['admin','production']) legacy_write_role");
    console.error('OPEN_ACCEPTANCE_GAP: Quality cannot read the expected production order',boundary.rows[0]);
  }
  assert.equal(order?.status,status);
  assert.ok(data.products.some(row=>row.id===order.finished_product_id),'Quality must see batch product');
  assert.ok(data.formulas.some(row=>row.id===order.formula_id),'Quality must see batch formula');
  if(status==='released') {
    const report=h.hooks.report(order,data.qc.find(row=>row.production_order_id===orderId));
    assert.ok(report.includes(order.batch_number));
    assert.match(report,/ไม่ใช่ COA ที่รับรองภายนอก/);
  }
  console.log(`Quality actual controller/disposable SQL: role-scoped ${status} readback passed; no hosted login or browser persistence claim.`);
}
