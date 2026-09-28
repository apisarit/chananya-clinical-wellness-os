// Disposable diagnostic. Exit 1 means the upstream write defect remains open.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createPriceMasterFixture } from './helpers/price-master-fixture.mjs';

const { db, ids, asOwner, asUser, asAnon } = await createPriceMasterFixture();
try {
  async function installCandidate() {
    if (!process.argv.includes('--candidate')) return;
    const aclQuery = "select proowner,proacl::text,prosecdef,proconfig from pg_proc where oid='public.complete_production_order(uuid,numeric,numeric,numeric)'::regprocedure";
    const before = (await asOwner(aclQuery)).rows;
    const definitionQuery = "select pg_get_functiondef('public.complete_production_order(uuid,numeric,numeric,numeric)'::regprocedure) definition";
    const definitionBefore = (await asOwner(definitionQuery)).rows;
    const snapshot = async () => {
      const result = {};
      for (const table of ['production_orders', 'production_material_issues', 'inventory_lots', 'audit_logs']) {
        result[table] = (await asOwner(`select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) data from public.${table} t`)).rows[0].data;
      }
      return result;
    };
    const dataBefore = await snapshot();
    assert.ok(dataBefore.production_orders.length > 0 && dataBefore.production_material_issues.length > 0);
    const source = await fs.readFile(new URL('../supabase/manual/production_finite_output_candidate.sql', import.meta.url), 'utf8');
    const guard = "do $$ begin raise exception 'PRODUCTION_FINITE_OUTPUT_REVIEW_REQUIRED'; end $$;";
    assert.ok(source.includes(guard));
    await assert.rejects(db.exec(source), /PRODUCTION_FINITE_OUTPUT_REVIEW_REQUIRED/);
    await db.exec('rollback');
    const executable = source.replace(guard, '');
    assert.match(executable, /commit;\s*$/);
    const interrupted = executable.replace(/commit;\s*$/, () => "do $$ begin raise exception 'SYNTHETIC_INSTALL_FAILURE'; end $$; commit;");
    await assert.rejects(db.exec(interrupted), /SYNTHETIC_INSTALL_FAILURE/);
    await db.exec('rollback');
    assert.deepEqual((await asOwner(definitionQuery)).rows, definitionBefore, 'Failed installation restores the old function definition');
    assert.deepEqual((await asOwner(aclQuery)).rows, before);
    assert.deepEqual(await snapshot(), dataBefore, 'Failed installation preserves populated records');
    await db.exec(source.replace(guard, '')); // Disposable fixture only; on-disk guard unchanged.
    assert.deepEqual((await asOwner(aclQuery)).rows, before);
    assert.deepEqual(await snapshot(), dataBefore, 'Successful installation does not rewrite existing data');
    await assert.rejects(db.exec(source.replace(guard, '')), /PRODUCTION_FINITE_OUTPUT_SOURCE_DRIFT/);
    await db.exec('rollback');
  }
  const [formula, order, lot] = Array.from({ length: 3 }, () => randomUUID());
  await asOwner(`update public.profiles set role='production' where id='${ids.userA}'`);
  await asOwner(`update public.clinic_memberships set clinic_role='production' where profile_id='${ids.userA}' and clinic_id='${ids.clinicA}'`);
  await asOwner(`insert into public.formulas(id,formula_code,name_th,finished_product_id,standard_batch_size,batch_unit,clinic_id)
    values('${formula}','FINITE-SYN','Synthetic only','${ids.productA}',10,'ชิ้น','${ids.clinicA}')`);
  await asOwner(`insert into public.production_orders(id,production_order_no,formula_id,finished_product_id,batch_number,planned_quantity,planned_unit,clinic_id,status)
    values('${order}','FINITE-SYN','${formula}','${ids.productA}','FINITE-SYN',10,'ชิ้น','${ids.clinicA}','in_process')`);
  await asOwner(`insert into public.inventory_lots(id,product_id,lot_number,unit,clinic_id,current_quantity,received_quantity)
    values('${lot}','${ids.productA}','FINITE-SYN','ชิ้น','${ids.clinicA}',10,10)`);
  await asOwner(`insert into public.production_material_issues(production_order_id,material_product_id,inventory_lot_id,required_quantity,issued_quantity,unit,clinic_id)
    values('${order}','${ids.productA}','${lot}',1,1,'ชิ้น','${ids.clinicA}')`);
  await installCandidate();
  const access = await asUser(ids.userA, "select public.department_can('production') allowed");
  assert.equal(access.rows[0].allowed, true);
  await assert.rejects(asAnon('select * from public.complete_production_order($1,10,0,0)', [order]), /permission denied/);
  await assert.rejects(asUser(ids.userB, 'select * from public.complete_production_order($1,10,0,0)', [order]), /PRODUCTION_DEPARTMENT_REQUIRED/);
  // A valid Production actor in another clinic must still be denied this order.
  await asOwner(`update public.profiles set role='production' where id='${ids.userB}'`);
  await asOwner(`update public.clinic_memberships set clinic_role='production' where profile_id='${ids.userB}' and clinic_id='${ids.clinicB}'`);
  assert.equal((await asUser(ids.userB, "select public.department_can('production') allowed")).rows[0].allowed, true);
  await assert.rejects(asUser(ids.userB, 'select * from public.complete_production_order($1,10,0,0)', [order]), /PRODUCTION_ORDER_NOT_FOUND/);
  assert.equal((await asOwner('select status from public.production_orders where id=$1', [order])).rows[0].status, 'in_process');
  assert.equal((await asOwner("select count(*)::int n from public.audit_logs where entity_id=$1 and action='complete_production_order'", [order])).rows[0].n, 0);
  let rejection;
  try {
    await asUser(ids.userA, 'select * from public.complete_production_order($1,$2::numeric,0,0)', [order, 'NaN']);
  } catch (error) { rejection = error; }
  if (rejection) {
    assert.match(rejection.message, /PRODUCTION_OUTPUT_VALUE_INVALID/);
    const row = (await asOwner('select status,actual_quantity::text actual from public.production_orders where id=$1', [order])).rows[0];
    assert.equal(row.status, 'in_process');
    assert.notEqual(row.actual, 'NaN');
    for (const inputs of [['1','NaN','0'], ['1','0','NaN'], ['Infinity','0','0'], ['1','Infinity','0'], ['1','0','-Infinity']]) {
      await assert.rejects(asUser(ids.userA, 'select * from public.complete_production_order($1,$2::numeric,$3::numeric,$4::numeric)', [order, ...inputs]), /PRODUCTION_OUTPUT_VALUE_INVALID/);
    }
    await asUser(ids.userA, 'select * from public.complete_production_order($1,10,0,0)', [order]);
    const valid = (await asOwner('select status,actual_quantity::text actual from public.production_orders where id=$1', [order])).rows[0];
    assert.equal(valid.status, 'awaiting_qc');
    assert.equal(Number(valid.actual), 10);
    await asUser(ids.userA, 'select * from public.complete_production_order($1,10,0,0)', [order]);
    const audit = (await asOwner("select count(*)::int n from public.audit_logs where entity_id=$1 and action='complete_production_order'", [order])).rows[0];
    assert.equal(audit.n, 1, 'Rejected writes and valid replay must not add completion audits');
    console.log('Nonfinite output rejected before production completion; disposable fixture only.');
  } else {
    const row = (await asOwner('select status,actual_quantity::text actual,yield_percent::text yield from public.production_orders where id=$1', [order])).rows[0];
    assert.equal(row.status, 'awaiting_qc');
    assert.equal(row.actual, 'NaN');
    assert.equal(row.yield, 'NaN');
    const audit = (await asOwner("select count(*)::int n from public.audit_logs where entity_id=$1 and action='complete_production_order'", [order])).rows[0];
    assert.equal(audit.n, 1);
    console.error('PRODUCTION_NONFINITE_WRITE_BLOCKED: authorized Production RPC persisted NaN output/yield and advanced to awaiting_qc. Synthetic fixture only; no live write.');
    process.exitCode = 1;
  }
} finally { await db.close(); }
