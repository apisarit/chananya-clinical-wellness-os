// Disposable native PostgreSQL concurrency test. No host ports, mounts or remote credentials.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createPriceMasterFixture, PRICE_FIXTURE_IDS as ids } from './helpers/price-master-fixture.mjs';

const container = `cnyos-aggregate-invoice-${process.pid}-${Date.now()}`;
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const image = docker(['image', 'inspect', 'postgres:17-alpine', '--format', '{{.Id}}']);
assert.match(image, /^sha256:[a-f0-9]{64}$/);
const active = new Set();
const key = n => `8b000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const encounter = n => `8b000000-0000-4000-8000-${String(100 + n).padStart(12, '0')}`;
const patient = n => `8b000000-0000-4000-8000-${String(200 + n).padStart(12, '0')}`;
const literal = value => `'${String(value).replaceAll("'", "''")}'`;

function connection(name) {
  assert.match(name, /^[a-z0-9_-]+$/);
  const child = spawn('docker', ['exec', '-i', container, 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'], { stdio: ['pipe', 'pipe', 'pipe'] });
  active.add(child);
  let out = '', err = '';
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Disposable SQL timeout')); }, 30000);
    child.on('error', reject);
    child.stdout.on('data', b => { out += b; });
    child.stderr.on('data', b => { err += b; });
    child.on('close', code => { clearTimeout(timer); active.delete(child); resolve({ code, out: out.trim(), err: err.trim() }); });
  });
  done.catch(() => {});
  child.stdin.on('error', () => {});
  child.stdin.write(`set application_name='${name}'; set statement_timeout='25s'; set idle_in_transaction_session_timeout='25s';\n`);
  return { child, done };
}

const auth = user => `set request.jwt.claim.sub='${user}'; set request.jwt.claim.role='authenticated'; set role authenticated;`;
async function query(sql, { actor = null, role = 'authenticated', name = 'observer', allowError = false } = {}) {
  const c = connection(name);
  c.child.stdin.end((actor ? (role === 'service_role'
    ? `set request.jwt.claim.sub='${actor}'; set request.jwt.claim.role='service_role';`
    : `${auth(actor)} set role ${role};`) : '') + sql);
  const result = await c.done;
  if (result.code !== 0 && !allowError) throw new Error(result.err || result.out);
  return result;
}
function holder(sql, name) {
  const c = connection(name);
  c.child.stdin.write(`begin; ${sql}\n`);
  return { done: c.done, release: () => c.child.stdin.end('commit;\n') };
}
async function waitFor(sql, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if ((await query(sql)).out === 't') return;
    await new Promise(resolve => setTimeout(resolve, 35));
  }
  throw new Error(message);
}
const idle = name => `select exists(select 1 from pg_stat_activity where application_name='${name}' and state='idle in transaction');`;
const waiting = name => `select exists(select 1 from pg_stat_activity where application_name='${name}' and wait_event_type='Lock');`;
const issue = (requestKey, enc, fingerprint) => `select * from public.issue_atomic_encounter_invoice('${requestKey}'::uuid,'${enc}'::uuid,${literal(fingerprint)});`;
const handoff = (requestKey, enc) => `select * from public.create_atomic_prescription_handoff('${requestKey}','${enc}','Late Rx','[{"product_id":"${ids.productA}","quantity_prescribed":1,"unit":"ชิ้น"}]'::jsonb);`;

async function createEncounter(n, { twoRx = true } = {}) {
  const e = encounter(n), p = patient(n);
  await query(`insert into public.patients(id,hn,first_name,last_name,created_by) values('${p}','NATIVE-AGG-${n}','Synthetic','Aggregate','${ids.owner}');
    insert into public.encounters(id,encounter_no,patient_id,clinic_id,status,practitioner_id,created_by)
    values('${e}','NATIVE-AGG-ENC-${n}','${p}','${ids.clinicA}','draft','${ids.userA}','${ids.userA}');`, { actor: ids.owner, role: 'service_role' });
  for (let i = 1; i <= (twoRx ? 2 : 0); i++) {
    const result = await query(handoff(key(1000 + n * 10 + i), e), { actor: ids.userA, name: `setup_rx_${n}_${i}` });
    assert.equal(result.code, 0, result.err);
    const row = result.out.split('\n')[0].split('|');
    assert.ok(row[0], `handoff ${n}/${i} did not return prescription`);
    await query(`insert into public.dispensing_items(dispensing_order_id,prescription_item_id,quantity_dispensed,unit,unit_price,status)
      select d.id,pi.id,1,'ชิ้น',100,'dispensed'
        from public.dispensing_orders d join public.prescription_items pi on pi.prescription_id=d.prescription_id
       where d.prescription_id='${row[0]}';
      update public.dispensing_orders set status='submitted_to_billing'
       where prescription_id='${row[0]}';`, { actor: ids.owner, role: 'service_role', name: `setup_dispense_${n}_${i}` });
  }
  return e;
}

let owned = false;
try {
  docker(['run', '--pull=never', '--detach', '--rm', '--network', 'none', '--name', container, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', image]);
  owned = true;
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try { if (docker(['exec', container, 'cat', '/proc/1/comm']) === 'postgres') { docker(['exec', container, 'pg_isready', '-U', 'postgres']); ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Database startup timeout');
  await waitFor('select pg_postmaster_start_time() is not null;', 'Database unavailable');
  const adapter = { exec: async sql => query(sql), query: async sql => { await query("set request.jwt.claim.role='service_role';" + sql); return { rows: [] }; } };
  await createPriceMasterFixture({ database: adapter, nativePostgres: true });
  await query(`select set_config('request.jwt.claim.sub','${ids.owner}',false),set_config('request.jwt.claim.role','service_role',false);`);
  await query(`select * from public.setup_price_master_default();`, { actor: ids.owner });
  await query(`select * from public.set_price_master_item(
    (select id from public.price_lists where clinic_id='${ids.clinicA}' order by created_at desc limit 1),
    'product','${ids.productA}',null,'ชิ้น',100,0,'Synthetic aggregate concurrency price');`, { actor: ids.owner });

  // Same request key: both callers wait on the encounter and return one receipt/invoice.
  const sameEncounter = await createEncounter(1);
  const sameQuote = JSON.parse((await query(`select public.quote_encounter_invoice('${sameEncounter}') quote`, { actor: ids.owner })).out);
  let h = holder(`select id from public.encounters where id='${sameEncounter}' for update;`, 'same_holder');
  await waitFor(idle('same_holder'), 'Same-key encounter holder not ready');
  const sameA = query(issue(key(2001), sameEncounter, sameQuote.quote_fingerprint), { actor: ids.owner, name: 'same_a' });
  const sameB = query(issue(key(2001), sameEncounter, sameQuote.quote_fingerprint), { actor: ids.owner, name: 'same_b' });
  sameA.catch(() => {}); sameB.catch(() => {});
  await waitFor(waiting('same_a'), 'Same-key first RPC did not wait');
  await waitFor(waiting('same_b'), 'Same-key second RPC did not wait');
  h.release(); assert.equal((await h.done).code, 0);
  const same = await Promise.all([sameA, sameB]);
  assert.equal(same[0].code, 0, same[0].err); assert.equal(same[1].code, 0, same[1].err);
  assert.equal(same[0].out, same[1].out);
  assert.equal((await query(`select count(*) from public.invoices where encounter_id='${sameEncounter}';`)).out, '1');
  assert.equal((await query(`select count(*) from cnyos_billing_internal.invoice_orders io join public.invoices i on i.id=io.invoice_id where i.encounter_id='${sameEncounter}';`)).out, '2');
  assert.equal((await query(`select count(*) from cnyos_billing_internal.invoice_source_charges sc join public.invoices i on i.id=sc.invoice_id where i.encounter_id='${sameEncounter}' and sc.source_kind='dispensing_item';`)).out, '2');
  assert.equal((await query(`select count(*) from public.dispensing_orders d join public.prescriptions rx on rx.id=d.prescription_id where rx.encounter_id='${sameEncounter}' and d.status='billed';`)).out, '2');

  // Different keys still serialize on the encounter: one commits, one observes the active invoice.
  const differentEncounter = await createEncounter(2);
  const differentQuote = JSON.parse((await query(`select public.quote_encounter_invoice('${differentEncounter}') quote`, { actor: ids.owner })).out);
  h = holder(`select id from public.encounters where id='${differentEncounter}' for update;`, 'different_holder');
  await waitFor(idle('different_holder'), 'Different-key encounter holder not ready');
  const differentA = query(issue(key(2101), differentEncounter, differentQuote.quote_fingerprint), { actor: ids.owner, name: 'different_a', allowError: true });
  const differentB = query(issue(key(2102), differentEncounter, differentQuote.quote_fingerprint), { actor: ids.owner, name: 'different_b', allowError: true });
  differentA.catch(() => {}); differentB.catch(() => {});
  await waitFor(waiting('different_a'), 'Different-key A did not wait');
  await waitFor(waiting('different_b'), 'Different-key B did not wait');
  h.release(); assert.equal((await h.done).code, 0);
  const different = await Promise.all([differentA, differentB]);
  const successful = different.filter(x => x.code === 0), failed = different.filter(x => x.code !== 0);
  assert.equal(successful.length, 1); assert.equal(failed.length, 1);
  // The committed winner marks source orders billed before the loser re-quotes;
  // current SQL therefore rejects either at the active-invoice guard or the
  // earlier order-readiness check, both preserving one committed invoice.
  assert.match(failed[0].err, /ENCOUNTER_ALREADY_HAS_ACTIVE_INVOICE|DISPENSING_ORDER_NOT_READY_FOR_BILLING/);
  assert.equal((await query(`select count(*) from public.invoices where encounter_id='${differentEncounter}';`)).out, '1');
  assert.equal((await query(`select count(*) from cnyos_billing_internal.invoice_orders io join public.invoices i on i.id=io.invoice_id where i.encounter_id='${differentEncounter}';`)).out, '2');

  // Invoice wins: a prescription handoff waits for the encounter and is rejected after commit.
  const invoiceFirst = await createEncounter(3);
  const invoiceFirstQuote = JSON.parse((await query(`select public.quote_encounter_invoice('${invoiceFirst}') quote`, { actor: ids.owner })).out);
  h = holder(`select id from public.encounters where id='${invoiceFirst}' for update;`, 'invoice_first_holder');
  await waitFor(idle('invoice_first_holder'), 'Invoice-first holder not ready');
  const invoiceCall = query(issue(key(2201), invoiceFirst, invoiceFirstQuote.quote_fingerprint), { actor: ids.owner, name: 'invoice_first_call' }); invoiceCall.catch(() => {});
  await waitFor(waiting('invoice_first_call'), 'Invoice-first RPC did not wait');
  const lateRx = query(handoff(key(2202), invoiceFirst), { actor: ids.userA, name: 'late_rx', allowError: true }); lateRx.catch(() => {});
  await waitFor(waiting('late_rx'), 'Late Rx did not wait behind invoice');
  h.release(); assert.equal((await h.done).code, 0);
  assert.equal((await invoiceCall).code, 0);
  assert.match((await lateRx).err, /PRESCRIPTION_ENCOUNTER_ALREADY_BILLED/);
  assert.equal((await query(`select count(*) from public.prescriptions where encounter_id='${invoiceFirst}';`)).out, '2');

  // Rx wins: the old quote is stale/incomplete once a new active prescription commits.
  const rxFirst = await createEncounter(4);
  const rxFirstQuote = JSON.parse((await query(`select public.quote_encounter_invoice('${rxFirst}') quote`, { actor: ids.owner })).out);
  h = holder(`select id from public.encounters where id='${rxFirst}' for update;`, 'rx_first_holder');
  await waitFor(idle('rx_first_holder'), 'Rx-first holder not ready');
  const newRx = query(handoff(key(2301), rxFirst), { actor: ids.userA, name: 'rx_first_call' }); newRx.catch(() => {});
  await waitFor(waiting('rx_first_call'), 'New Rx did not wait');
  const staleInvoice = query(issue(key(2302), rxFirst, rxFirstQuote.quote_fingerprint), { actor: ids.owner, name: 'stale_invoice', allowError: true }); staleInvoice.catch(() => {});
  await waitFor(waiting('stale_invoice'), 'Invoice did not wait behind new Rx');
  h.release(); assert.equal((await h.done).code, 0);
  assert.equal((await newRx).code, 0);
  assert.match((await staleInvoice).err, /DISPENSING_ORDER_NOT_READY_FOR_BILLING|STALE_INVOICE_QUOTE/);
  assert.equal((await query(`select count(*) from public.invoices where encounter_id='${rxFirst}';`)).out, '0');

  // Independent pharmacy sessions compete for the final valid unit. The first
  // RPC holds its actual allocation transaction open, not a simulated stock lock.
  const pharmacy = key(3000);
  const pharmacyTwo = key(3001);
  await query(`insert into auth.users(id,email,raw_user_meta_data)
    values('${pharmacy}','native-pharmacy@example.test','{"full_name":"Synthetic Pharmacy"}');
    update public.profiles set role='pharmacy',system_role='staff' where id='${pharmacy}';
    insert into public.clinic_memberships(clinic_id,profile_id,clinic_role,is_primary,active)
    values('${ids.clinicA}','${pharmacy}','pharmacy',true,true)
    on conflict(clinic_id,profile_id) do update set clinic_role='pharmacy',is_primary=true,active=true;
    insert into public.inventory_lots(clinic_id,product_id,lot_number,expiry_date,
      received_quantity,current_quantity,unit,purchase_cost,status) values
    ('${ids.clinicA}','${ids.productA}','NATIVE-EXPIRED',current_date-1,10,10,'ชิ้น',25,'active'),
    ('${ids.clinicA}','${ids.productA}','NATIVE-LAST',current_date+1,1,1,'ชิ้น',25,'active');`,
    { actor: ids.owner, role: 'service_role' });
  await query(`insert into auth.users(id,email,raw_user_meta_data)
    values('${pharmacyTwo}','native-pharmacy-two@example.test','{"full_name":"Synthetic Pharmacy Two"}');
    update public.profiles set role='pharmacy',system_role='staff' where id='${pharmacyTwo}';
    insert into public.clinic_memberships(clinic_id,profile_id,clinic_role,is_primary,active)
    values('${ids.clinicA}','${pharmacyTwo}','pharmacy',true,true)
    on conflict(clinic_id,profile_id) do update set clinic_role='pharmacy',is_primary=true,active=true;`,
    { actor: ids.owner, role: 'service_role' });
  const orders = [];
  for (const n of [5, 6]) {
    const enc = await createEncounter(n, { twoRx: false });
    const receipt = JSON.parse((await query(`select row_to_json(r) from
      public.create_atomic_prescription_handoff('${key(3000+n)}','${enc}','Concurrent synthetic Rx',
      '[{"product_id":"${ids.productA}","quantity_prescribed":1,"unit":"ชิ้น"}]'::jsonb) r;`,
      { actor: ids.userA })).out);
    const order = receipt.dispensing_order_id;
    await query(`select public.transition_atomic_prescription_dispensing('${order}','review','[]'::jsonb,'Synthetic review');`, { actor: pharmacy });
    const item = (await query(`select id from public.prescription_items where prescription_id='${receipt.prescription_id}';`, { actor: pharmacy })).out;
    orders.push({ order, sql: `select public.transition_atomic_prescription_dispensing('${order}','dispense',
      '[{"prescription_item_id":"${item}","unit_price":100}]'::jsonb,'Synthetic concurrent dispense');` });
  }
  h = holder(`${auth(pharmacy)} ${orders[0].sql}`, 'dispense_winner');
  await waitFor(idle('dispense_winner'), 'First pharmacy transaction did not finish allocation');
  const competing = query(orders[1].sql, { actor: pharmacyTwo, name: 'dispense_waiter', allowError: true });
  competing.catch(() => {});
  await waitFor(waiting('dispense_waiter'), 'Competing pharmacy session did not wait on stock lock');
  const duplicate = query(orders[0].sql, { actor: pharmacyTwo, name: 'dispense_duplicate' });
  duplicate.catch(() => {});
  await waitFor(waiting('dispense_duplicate'), 'Same-order second user did not wait for first dispense');
  h.release();
  const winner = await h.done;
  assert.equal(winner.code, 0, winner.err);
  assert.equal(JSON.parse(winner.out).status, 'dispensed');
  const duplicateResult = await duplicate;
  assert.equal(duplicateResult.code, 0, duplicateResult.err);
  assert.equal(JSON.parse(duplicateResult.out).idempotent, true);
  const loser = await competing;
  assert.notEqual(loser.code, 0);
  assert.match(loser.err, /PRESCRIPTION_STOCK_INSUFFICIENT/);
  assert.equal(Number((await query(`select current_quantity from public.inventory_lots where lot_number='NATIVE-LAST';`)).out), 0);
  assert.equal(Number((await query(`select current_quantity from public.inventory_lots where lot_number='NATIVE-EXPIRED';`)).out), 10);
  assert.equal((await query(`select count(*) from public.dispensing_items where dispensing_order_id='${orders[0].order}';`)).out, '1');
  assert.equal((await query(`select count(*) from public.stock_movements where reference_id='${orders[0].order}';`)).out, '1');
  assert.equal((await query(`select count(*) from public.dispensing_items where dispensing_order_id='${orders[1].order}';`)).out, '0');
  assert.equal((await query(`select count(*) from public.stock_movements where reference_id='${orders[1].order}';`)).out, '0');
  assert.equal((await query(`select status from public.dispensing_orders where id='${orders[1].order}';`)).out, 'reviewed');
  const replay = JSON.parse((await query(orders[0].sql, { actor: pharmacy })).out);
  assert.equal(replay.idempotent, true);
  assert.equal(Number((await query(`select current_quantity from public.inventory_lots where lot_number='NATIVE-LAST';`)).out), 0);
  assert.equal((await query(`select count(*) from public.stock_movements where reference_id='${orders[0].order}';`)).out, '1');

  // Two real Billing connections contend for the same invoice. No Owner-role
  // inference: both actors have explicit Billing memberships in this fixture.
  const billers=[key(4000),key(4001)];
  for(const [index,biller] of billers.entries()) {
    await query(`insert into auth.users(id,email) values('${biller}','synthetic-biller-${index}@example.test');
      update public.profiles set role='billing',system_role='staff' where id='${biller}';
      insert into public.clinic_memberships(clinic_id,profile_id,clinic_role,is_primary,active)
      values('${ids.clinicA}','${biller}','billing',true,true)
      on conflict(clinic_id,profile_id) do update set clinic_role='billing',is_primary=true,active=true;`,
      {actor:ids.owner,role:'service_role'});
  }
  for(const sameKey of [true,false]) {
    const enc=sameKey?sameEncounter:differentEncounter;
    const invoice=JSON.parse((await query(`select row_to_json(i) from
      (select id,grand_total from public.invoices where encounter_id='${enc}') i;`)).out);
    const request=key(sameKey?4100:4200);
    const pay=requestKey=>`select row_to_json(p) from public.record_atomic_invoice_payment(
      '${requestKey}','${invoice.id}',${Number(invoice.grand_total)},'cash','Synthetic native payment') p;`;
    const prefix=sameKey?'pay_same':'pay_different';
    h=holder(`select id from public.invoices where id='${invoice.id}' for update;`,`${prefix}_holder`);
    await waitFor(idle(`${prefix}_holder`),'Payment lock holder not ready');
    const first=query(pay(request),{actor:billers[0],name:`${prefix}_a`,allowError:true});
    const second=query(pay(sameKey?request:key(4201)),{actor:billers[1],name:`${prefix}_b`,allowError:true});
    first.catch(()=>{});second.catch(()=>{});
    await waitFor(waiting(`${prefix}_a`),'First payment did not wait on invoice lock');
    await waitFor(waiting(`${prefix}_b`),'Second payment did not wait on invoice lock');
    h.release();assert.equal((await h.done).code,0);
    const results=await Promise.all([first,second]);
    if(sameKey) {
      for(const result of results) assert.equal(result.code,0,result.err);
      assert.deepEqual(JSON.parse(results[0].out),JSON.parse(results[1].out));
    } else {
      assert.equal(results.filter(result=>result.code===0).length,1);
      assert.match(results.find(result=>result.code!==0).err,/INVOICE_NOT_PAYABLE|PAYMENT_EXCEEDS_BALANCE/);
    }
    const persisted=JSON.parse((await query(`select json_build_object(
      'count',(select count(*) from public.payments where invoice_id='${invoice.id}'),
      'sum',(select sum(amount) from public.payments where invoice_id='${invoice.id}'),
      'balance',i.balance_due,'paid',i.paid_amount) from public.invoices i where id='${invoice.id}';`)).out);
    assert.equal(persisted.count,1);
    assert.equal(Number(persisted.sum),Number(invoice.grand_total));
    assert.equal(Number(persisted.paid),Number(invoice.grand_total));
    assert.equal(Number(persisted.balance),0);
  }

  console.log(`Native concurrency passed: encounter invoice/replay/Rx ordering, pharmacy stock contention and two Billing actors collecting with same/different keys; observed Lock waits and one persisted payment per invoice. Image ${image}`);
} finally {
  for (const child of active) child.kill();
  if (owned) docker(['rm', '--force', container]);
}
