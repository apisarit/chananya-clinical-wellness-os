// Synthetic native PostgreSQL only: no network, ports, mounts or provider credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createPriceMasterFixture, PRICE_FIXTURE_IDS as ids } from './helpers/price-master-fixture.mjs';

const image = 'sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24';
const container = `cnyos-finite-${process.pid}-${Date.now()}`;
const docker = (args, input) => execFileSync('docker', args, {
  input, encoding: 'utf8', timeout: 45000, maxBuffer: 32 * 1024 * 1024,
  stdio: ['pipe', 'pipe', 'pipe']
});
const sql = text => docker(['exec', '-i', container, 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'],
  `set statement_timeout='30s';\n${text}`).trim();
const owner = "set request.jwt.claim.role='service_role';";
const auth = actor => `set request.jwt.claim.sub='${actor}';set request.jwt.claim.role='authenticated';set role authenticated;`;
const key = n => `9f000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const signature = 'public.complete_production_order(uuid,numeric,numeric,numeric)';
const definition = () => sql(`select pg_get_functiondef('${signature}'::regprocedure);`);
const acl = () => sql(`select jsonb_build_array(proowner,proacl::text,prosecdef,proconfig) from pg_proc where oid='${signature}'::regprocedure;`);
const snapshot = () => Object.fromEntries(['production_orders', 'production_material_issues', 'inventory_lots', 'audit_logs'].map(table =>
  [table, sql(`select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.${table} t;`)]));
const complete = (actor, values = '10,0,0') => sql(`${auth(actor)}select public.complete_production_order('${key(2)}',${values});`);
let owned = false;
try {
  assert.equal(docker(['image', 'inspect', 'postgres:17-alpine', '--format', '{{.Id}}']).trim(), image);
  docker(['run', '--pull=never', '--detach', '--rm', '--network', 'none', '--name', container, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', image]);
  owned = true;
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try {
      assert.match(docker(['logs', container]), /PostgreSQL init process complete/);
      sql('select 1;'); ready = true; break;
    } catch { await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  assert.ok(ready, 'Disposable PostgreSQL startup timeout');
  const version = sql('show server_version;');
  assert.match(version, /^17\./);
  await createPriceMasterFixture({ nativePostgres: true, database: {
    exec: async text => { sql(text); },
    query: async text => { sql(owner + text); return { rows: [] }; }
  } });
  sql(`${owner}
    update public.profiles set role='production' where id='${ids.userA}';
    update public.clinic_memberships set clinic_role='production' where profile_id='${ids.userA}' and clinic_id='${ids.clinicA}';
    insert into public.formulas(id,formula_code,name_th,finished_product_id,standard_batch_size,batch_unit,clinic_id)
      values('${key(1)}','NATIVE-FINITE','Synthetic only','${ids.productA}',10,'ชิ้น','${ids.clinicA}');
    insert into public.production_orders(id,production_order_no,formula_id,finished_product_id,batch_number,planned_quantity,planned_unit,clinic_id,status)
      values('${key(2)}','NATIVE-FINITE','${key(1)}','${ids.productA}','NATIVE-FINITE',10,'ชิ้น','${ids.clinicA}','in_process');
    insert into public.inventory_lots(id,product_id,lot_number,unit,clinic_id,current_quantity,received_quantity)
      values('${key(3)}','${ids.productA}','NATIVE-FINITE','ชิ้น','${ids.clinicA}',10,10);
    insert into public.production_material_issues(production_order_id,material_product_id,inventory_lot_id,required_quantity,issued_quantity,unit,clinic_id)
      values('${key(2)}','${ids.productA}','${key(3)}',1,1,'ชิ้น','${ids.clinicA}');`);
  const before = snapshot(), oldDefinition = definition(), oldAcl = acl();
  // Reproduce the native baseline without retaining the invalid write.
  assert.equal(sql(`begin;${auth(ids.userA)}select (public.complete_production_order('${key(2)}','NaN',0,0)).id;reset role;select actual_quantity::text from public.production_orders where id='${key(2)}';rollback;`), `${key(2)}\nNaN`);
  assert.deepEqual(snapshot(), before);
  const source = await fs.readFile(new URL('../supabase/manual/production_finite_output_candidate.sql', import.meta.url), 'utf8');
  const guard = "do $$ begin raise exception 'PRODUCTION_FINITE_OUTPUT_REVIEW_REQUIRED'; end $$;";
  assert.equal(source.split(guard).length, 2);
  assert.throws(() => sql(source), /PRODUCTION_FINITE_OUTPUT_REVIEW_REQUIRED/);
  const candidate = source.replace(guard, '-- Disposable in-memory derivative only.');
  assert.match(candidate, /commit;\s*$/);
  assert.throws(() => sql(candidate.replace(/commit;\s*$/, () => "do $$ begin raise exception 'SYNTHETIC_INSTALL_FAILURE'; end $$;commit;")), /SYNTHETIC_INSTALL_FAILURE/);
  assert.equal(definition(), oldDefinition);
  assert.equal(acl(), oldAcl);
  assert.deepEqual(snapshot(), before);
  sql(candidate);
  assert.equal(acl(), oldAcl);
  assert.deepEqual(snapshot(), before);
  assert.throws(() => sql(candidate), /PRODUCTION_FINITE_OUTPUT_SOURCE_DRIFT/);
  assert.throws(() => sql(`set role anon;select public.complete_production_order('${key(2)}',10,0,0);`), /permission denied/);
  assert.throws(() => complete(ids.userB), /PRODUCTION_DEPARTMENT_REQUIRED/);
  sql(`${owner}update public.profiles set role='production' where id='${ids.userB}';update public.clinic_memberships set clinic_role='production' where profile_id='${ids.userB}' and clinic_id='${ids.clinicB}';`);
  assert.throws(() => complete(ids.userB), /PRODUCTION_ORDER_NOT_FOUND/);
  for (const value of ['NaN', 'Infinity', '-Infinity']) {
    for (let position = 0; position < 3; position++) {
      const values = ['10', '0', '0']; values[position] = `'${value}'::numeric`;
      assert.throws(() => complete(ids.userA, values.join(',')), /PRODUCTION_OUTPUT_VALUE_INVALID/);
    }
  }
  assert.deepEqual(snapshot(), before, 'Denied writes preserve all observed rows');
  complete(ids.userA); complete(ids.userA);
  assert.equal(sql(`select status||':'||actual_quantity::text from public.production_orders where id='${key(2)}';`), 'awaiting_qc:10.0000');
  assert.equal(sql(`select count(*) from public.audit_logs where entity_id='${key(2)}' and action='complete_production_order';`), '1');
  assert.equal(await fs.readFile(new URL('../supabase/manual/production_finite_output_candidate.sql', import.meta.url), 'utf8'), source);
  console.log(`Native PostgreSQL ${version}: baseline NaN reproduced and rolled back; candidate guard, populated install/failure rollback, ACL preservation, nine nonfinite denials, role/tenant denials and replay passed. Synthetic only; no hosted approval.`);
} finally {
  if (owned) docker(['rm', '--force', container]);
}
