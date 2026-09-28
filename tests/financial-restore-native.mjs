// Native PostgreSQL 17 pg_dump/pg_restore roundtrip for financial provenance.
// The only database is a disposable, network-isolated container; all rows are synthetic.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createPriceMasterFixture, PRICE_FIXTURE_IDS as ids } from './helpers/price-master-fixture.mjs';

const container = `cnyos-financial-restore-${process.pid}-${Date.now()}`;
const sourceDb = 'cnyos_source';
const targetDb = 'cnyos_restore';
const expectedImage = 'sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24';
const docker = (args, input = undefined, encoding = 'utf8') => execFileSync('docker', args, {
  input, encoding, timeout: 120000, maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe']
});
const image = docker(['image', 'inspect', 'postgres:17-alpine', '--format', '{{.Id}}']).trim();
assert.equal(image, expectedImage, `unexpected local postgres image: ${image}`);
const active = new Set();

function connection(database = sourceDb, name = 'observer') {
  assert.match(database, /^[a-z0-9_]+$/);
  const child = spawn('docker', ['exec', '-i', container, 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database], { stdio: ['pipe', 'pipe', 'pipe'] });
  active.add(child);
  let out = '', err = '';
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`SQL timeout (${name})`)); }, 60000);
    child.on('error', reject);
    child.stdout.on('data', b => { out += b; });
    child.stderr.on('data', b => { err += b; });
    child.on('close', code => { clearTimeout(timer); active.delete(child); resolve({ code, out: out.trim(), err: err.trim() }); });
  });
  done.catch(() => {});
  child.stdin.on('error', () => {});
  child.stdin.write(`set application_name='${name}'; set statement_timeout='45s'; set idle_in_transaction_session_timeout='45s';\n`);
  return { child, done };
}

const auth = (actor, role = 'authenticated') =>
  role === 'service_role'
    ? `set request.jwt.claim.sub='${actor}'; set request.jwt.claim.role='service_role'; set role service_role;`
    : `set request.jwt.claim.sub='${actor}'; set request.jwt.claim.role='authenticated'; set role ${role};`;
async function query(sql, { database = sourceDb, actor = null, role = 'authenticated', name = 'observer', allowError = false } = {}) {
  const c = connection(database, name);
  c.child.stdin.end((actor ? auth(actor, role) : '') + sql);
  const result = await c.done;
  if (result.code !== 0 && !allowError) throw new Error(result.err || result.out);
  return result;
}
const jsonQuery = async (sql, opts) => JSON.parse((await query(sql, opts)).out);
const key = n => `9b000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const encounter = '9b000000-0000-4000-8000-000000000101';
const patient = '9b000000-0000-4000-8000-000000000201';
const literal = value => `'${String(value).replaceAll("'", "''")}'`;

async function seedBilling() {
  const setup = (await query(`select * from public.setup_price_master_default('Synthetic restore service',600,'Synthetic restore setup')`, { actor: ids.owner })).out.split('|');
  const listId = setup[0];
  assert.match(listId, /^[0-9a-f-]{36}$/);
  await query(`select * from public.set_price_master_item('${listId}','product','${ids.productA}',null,'ชิ้น',125,0,'Synthetic product A restore price')`, { actor: ids.owner });
  await query(`set request.jwt.claim.sub='${ids.owner}'; set request.jwt.claim.role='service_role'; insert into public.patients(id,hn,first_name,last_name,created_by)
    values('${patient}','RESTORE-HN-0001','Synthetic','Restore','${ids.owner}');
    insert into public.encounters(id,encounter_no,patient_id,clinic_id,status,practitioner_id,created_by)
    values('${encounter}','RESTORE-ENC-0001','${patient}','${ids.clinicA}','draft','${ids.userA}','${ids.userA}');`, { name: 'seed_patient' });

  for (const n of [1, 2]) {
    const handoff = await query(`select * from public.create_atomic_prescription_handoff('${key(100+n)}','${encounter}','Synthetic restore Rx ${n}', '[{"product_id":"${ids.productA}","quantity_prescribed":1,"unit":"ชิ้น"}]'::jsonb)`, { actor: ids.userA, name: `handoff_${n}` });
    const prescriptionId = handoff.out.split('\n')[0].split('|')[0];
    assert.match(prescriptionId, /^[0-9a-f-]{36}$/);
    await query(`set request.jwt.claim.sub='${ids.owner}'; set request.jwt.claim.role='service_role'; insert into public.dispensing_items(dispensing_order_id,prescription_item_id,quantity_dispensed,unit,unit_price,status)
      select d.id,pi.id,1,'ชิ้น',125,'dispensed'
        from public.dispensing_orders d join public.prescription_items pi on pi.prescription_id=d.prescription_id
       where d.prescription_id='${prescriptionId}';
    update public.dispensing_orders set status='submitted_to_billing' where prescription_id='${prescriptionId}';`, { name: `dispense_${n}` });
  }

  const treatmentRequest = key(300);
  const treatmentCall = `select (public.create_clinical_treatment_session_idempotent('${treatmentRequest}'::uuid,'${encounter}'::uuid,array['massage']::text[],'Synthetic restore treatment',false,null,null,null,null,'Completed','Hydrate',30)).id`;
  const firstSession = (await query(treatmentCall, { actor: ids.userA, name: 'treatment_first' })).out;
  const replaySession = (await query(treatmentCall, { actor: ids.userA, name: 'treatment_replay' })).out;
  assert.equal(replaySession, firstSession, 'treatment request replay must return the same session');
  await query(`set request.jwt.claim.sub='${ids.owner}'; set request.jwt.claim.role='service_role'; insert into public.clinical_record_signoffs(encounter_id,record_section,signer_id,lock_record)
    values('${encounter}','complete_record','${ids.userA}',true);`, { name: 'signoff' });
  const quote = await jsonQuery(`select public.quote_encounter_invoice('${encounter}')`, { actor: ids.owner });
  const issued = await jsonQuery(`select row_to_json(x) from public.issue_atomic_encounter_invoice('${key(400)}','${encounter}','${quote.quote_fingerprint}') x`, { actor: ids.owner, name: 'issue_invoice' });
  const replay = await jsonQuery(`select row_to_json(x) from public.issue_atomic_encounter_invoice('${key(400)}','${encounter}','${quote.quote_fingerprint}') x`, { actor: ids.owner, name: 'invoice_replay' });
  assert.deepEqual(replay, issued, 'invoice request replay must return the same invoice');
  assert.equal(Number(issued.grand_total), 550);
  assert.equal(Number(issued.balance_due), 550);
  return { listId, treatmentRequest, treatmentCall, invoiceRequest: key(400), invoice: issued, quote };
}

async function projection(database, timezone = 'UTC') {
  return {
    products: await jsonQuery(`set timezone='${timezone}'; select public.export_clinic_backup_domain('${ids.clinicA}','products')`, { database, actor: ids.owner, role: 'service_role', name: `export_products_${timezone}` }),
    transactions: await jsonQuery(`set timezone='${timezone}'; select public.export_clinic_backup_domain('${ids.clinicA}','transactions')`, { database, actor: ids.owner, role: 'service_role', name: `export_transactions_${timezone}` }),
    trace: await jsonQuery(`set timezone='${timezone}'; select public.verify_clinic_restore_trace('${ids.clinicA}')`, { database, actor: ids.owner, role: 'service_role', name: `trace_${timezone}` })
  };
}
async function financialState(database) {
  return jsonQuery(`select jsonb_build_object(
    'invoice', (select row_to_json(i) from public.invoices i where i.encounter_id='${encounter}'),
    'source_counts', (select jsonb_object_agg(source_kind,n) from (select source_kind,count(*)::integer n from cnyos_billing_internal.invoice_source_charges sc join public.invoices i on i.id=sc.invoice_id where i.encounter_id='${encounter}' group by source_kind) q),
    'rate_versions', (select coalesce(jsonb_agg(jsonb_build_object('price_list_version',sc.price_list_version,'price_item_version',sc.price_item_version) order by sc.id),'[]'::jsonb) from cnyos_billing_internal.invoice_source_charges sc join public.invoices i on i.id=sc.invoice_id where i.encounter_id='${encounter}'),
    'price_item_versions', (select coalesce(jsonb_agg(jsonb_build_object('id',id,'version',version,'unit_price',unit_price) order by id),'[]'::jsonb) from public.price_list_items where clinic_id='${ids.clinicA}')
  )`, { database, name: 'financial_state' });
}

async function verifyAuditBoundary(database) {
  const sql = `select coalesce(jsonb_agg(entity_id order by entity_id),'[]'::jsonb)
    from public.audit_logs where entity_id like 'RESTORE-AUDIT-%'`;
  assert.deepEqual(await jsonQuery(sql, { database, actor: ids.owner }), ['RESTORE-AUDIT-A'], 'Owner must read only own clinic role event');
  assert.deepEqual(await jsonQuery(sql, { database, actor: ids.userB }), ['RESTORE-AUDIT-B'], 'Admin B must not read clinic A');
  assert.deepEqual(await jsonQuery(sql, { database, actor: ids.userA }), [], 'practitioner must not read role history');
  const anonymous = await query(sql, { database, actor: ids.userA, role: 'anon', allowError: true });
  assert.notEqual(anonymous.code, 0, 'anonymous audit read must fail');
  assert.match(anonymous.err, /permission denied/);
}

const knowledgeSubmit = n => `select row_to_json(x) from public.submit_ttm_knowledge_suggestion_once(
  '${key(900+n)}','ttm_diagnostic_knowledge',null,'create',
  '{"domain":"synthetic","rule_key":"RESTORE-KNOWLEDGE-${n}","input_key":"test","output_value":"Synthetic only"}',
  'Synthetic restore source','Synthetic restore proposal') x`;
async function knowledgeState(database) {
  return jsonQuery(`set timezone='UTC'; select jsonb_build_object(
    'applied_content',(select coalesce(jsonb_agg(to_jsonb(k) order by k.id),'[]'::jsonb) from public.ttm_diagnostic_knowledge k where rule_key like 'RESTORE-KNOWLEDGE-%'),
    'proposals',(select coalesce(jsonb_agg(to_jsonb(s) order by s.id),'[]'::jsonb) from public.ttm_knowledge_suggestions s),
    'events',(select coalesce(jsonb_agg(to_jsonb(e) order by e.id),'[]'::jsonb) from public.ttm_knowledge_suggestion_events e),
    'tasks',(select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]'::jsonb) from public.approval_tasks a
      join public.ttm_knowledge_suggestions s on s.approval_task_id=a.id))`, { database });
}
const stateHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pharmacy=key(700);
const clarificationCall=(order,n,action,text)=>`select public.manage_prescription_clarification('${order}','${key(800+n)}','${action}',${literal(text)})`;
async function seedClarifications() {
  // Pharmacy routines come only from the ordered migration directory.
  await query(`set request.jwt.claim.sub='${ids.owner}'; set request.jwt.claim.role='service_role';
    insert into auth.users(id,email) values('${pharmacy}','restore-pharmacy@example.test');
    update public.profiles set role='pharmacy',system_role='staff' where id='${pharmacy}';
    insert into public.clinic_memberships(clinic_id,profile_id,clinic_role,is_primary,active)
      values('${ids.clinicA}','${pharmacy}','pharmacy',true,true)
      on conflict(clinic_id,profile_id) do update set clinic_role='pharmacy',is_primary=true,active=true;
    insert into public.encounters(id,encounter_no,patient_id,clinic_id,status,practitioner_id,created_by)
      values('${key(710)}','CLARIFICATION-RESTORE','${patient}','${ids.clinicA}','draft','${ids.userA}','${ids.userA}');`);
  const cases=[];
  for(const n of [1,2,3]) {
    const rx=await jsonQuery(`select row_to_json(x) from public.create_atomic_prescription_handoff(
      '${key(720+n)}','${key(710)}','Synthetic clarification restore',
      '[{"product_id":"${ids.productA}","quantity_prescribed":1,"unit":"ชิ้น"}]') x`,{actor:ids.userA});
    const order=rx.dispensing_order_id;
    let ticket=await jsonQuery(clarificationCall(order,n,'open',`Synthetic question ${n}`),{actor:pharmacy});
    if(n>=2) ticket=await jsonQuery(clarificationCall(order,n,'answer',`Synthetic answer ${n}`),{actor:ids.userA});
    if(n===3) ticket=await jsonQuery(clarificationCall(order,n,'acknowledge',''),{actor:pharmacy});
    cases.push({n,order,ticket});
  }
  return cases;
}

// Exercise real contending connections, not Promise concurrency on a single DB
// connection. Run after restore comparisons so these rows cannot skew hashes.
async function verifyClarificationRaces() {
  await query(`set request.jwt.claim.sub='${ids.owner}'; set request.jwt.claim.role='service_role';
    insert into public.inventory_lots(clinic_id,product_id,lot_number,expiry_date,
      received_quantity,current_quantity,unit,purchase_cost,status) values
      ('${ids.clinicA}','${ids.productA}','CLARIFICATION-RACE',current_date+30,2,2,'ชิ้น',25,'active');`);
  async function waitForSession(name, predicate) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const result = await query(`select exists(select 1 from pg_stat_activity
        where application_name=${literal(name)} and ${predicate})`);
      if (result.out === 't') return;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error(`Session ${name} never reached ${predicate}`);
  }
  for (const n of [1, 2]) {
    const rx = await jsonQuery(`select row_to_json(x) from public.create_atomic_prescription_handoff(
      '${key(1000+n)}','${key(710)}','Synthetic concurrent clarification',
      '[{"product_id":"${ids.productA}","quantity_prescribed":1,"unit":"ชิ้น"}]') x`, { actor: ids.userA });
    const order = rx.dispensing_order_id;
    const item = (await query(`select pi.id from public.prescription_items pi
      join public.dispensing_orders d on d.prescription_id=pi.prescription_id where d.id='${order}'`)).out;
    assert.match(item, /^[0-9a-f-]{36}$/);
    await query(`select public.transition_atomic_prescription_dispensing('${order}','review')`, { actor: pharmacy });
    const open = `select public.manage_prescription_clarification('${order}','${key(1100+n)}','open','Synthetic race question');`;
    const dispense = `select public.transition_atomic_prescription_dispensing('${order}','dispense',
      '[{"prescription_item_id":"${item}","unit_price":125}]'::jsonb);`;
    const winnerName = `clarification_winner_${n}`, loserName = `clarification_loser_${n}`;
    const winner = connection(sourceDb, winnerName);
    winner.child.stdin.write(`begin; ${auth(pharmacy)} ${n === 1 ? open : dispense}\n`);
    let loser;
    try {
      await waitForSession(winnerName, "state='idle in transaction'");
      loser = query(n === 1 ? dispense : open, { actor: pharmacy, name: loserName, allowError: true });
      // Prove the second RPC is actually blocked by the first transaction.
      await waitForSession(loserName, "wait_event_type='Lock'");
      winner.child.stdin.end('commit;\n');
      const committed = await winner.done;
      assert.equal(committed.code, 0, committed.err);
      const rejected = await loser;
      assert.notEqual(rejected.code, 0, 'both conflicting transitions succeeded');
      assert.match(rejected.err, n === 1 ? /PRESCRIPTION_ORDER_NOT_REVIEWED|PRESCRIPTION_CLARIFICATION_PENDING/ : /CLARIFICATION_CORRECTION_WORKFLOW_REQUIRED/);
      const state = await jsonQuery(`select jsonb_build_object(
        'balance',(select current_quantity from public.inventory_lots where lot_number='CLARIFICATION-RACE'),
        'allocations',(select count(*) from public.dispensing_items where dispensing_order_id='${order}'),
        'movements',(select count(*) from public.stock_movements where reference_id='${order}'),
        'tickets',(select count(*) from cnyos_clarification_internal.tickets where order_id='${order}'),
        'status',(select status from public.dispensing_orders where id='${order}'))`);
      assert.deepEqual(state, n === 1
        ? { balance: 2, allocations: 0, movements: 0, tickets: 1, status: 'waiting' }
        : { balance: 1, allocations: 1, movements: 1, tickets: 0, status: 'dispensed' });
      // Synthetic inconsistent state: cancellation cannot revive a waiting
      // queue or be ignored by the already-dispensed idempotent return path.
      const inactive = n === 1 ? 'cancelled' : 'void';
      await query(`set request.jwt.claim.sub='${ids.owner}'; set request.jwt.claim.role='service_role';
        update public.prescriptions set status='${inactive}' where id=(
          select prescription_id from public.dispensing_orders where id='${order}');`);
      for (const action of ['review','dispense','submit_billing']) {
        const denied = await query(`select public.transition_atomic_prescription_dispensing('${order}','${action}')`,
          {actor:pharmacy,allowError:true});
        assert.notEqual(denied.code,0);
        assert.match(denied.err,/PRESCRIPTION_INACTIVE/);
      }
      assert.equal(Number((await query(`select current_quantity from public.inventory_lots where lot_number='CLARIFICATION-RACE'`)).out),state.balance);
    } finally {
      if (!winner.child.stdin.writableEnded) winner.child.stdin.end('rollback;\n');
      await winner.done;
      if (loser) await loser;
    }
  }
  // Replacement issuance will reuse the handoff primitive. Prove it creates
  // one prescription/order under real same-key contention, not just serial retry.
  const handoff = `select row_to_json(x) from public.create_atomic_prescription_handoff(
    '${key(1201)}','${key(710)}','Synthetic replacement prerequisite',
    '[{"product_id":"${ids.productA}","quantity_prescribed":1,"unit":"ชิ้น"}]') x;`;
  const first = connection(sourceDb, 'handoff_winner');
  first.child.stdin.write(`begin; ${auth(ids.userA)} ${handoff}\n`);
  let second;
  try {
    await waitForSession('handoff_winner', "state='idle in transaction'");
    second = query(handoff, { actor: ids.userA, name: 'handoff_retry', allowError: true });
    await waitForSession('handoff_retry', "wait_event_type='Lock'");
    first.child.stdin.end('commit;\n');
    const a = await first.done, b = await second;
    assert.equal(a.code, 0, a.err);
    assert.equal(b.code, 0, b.err);
    assert.deepEqual(JSON.parse(a.out), JSON.parse(b.out), 'concurrent retry returned a different handoff');
    const counts = await jsonQuery(`select jsonb_build_object(
      'prescriptions',(select count(*) from public.prescriptions where request_key='${key(1201)}'),
      'orders',(select count(*) from public.dispensing_orders d join public.prescriptions p on p.id=d.prescription_id where p.request_key='${key(1201)}'),
      'items',(select count(*) from public.prescription_items i join public.prescriptions p on p.id=i.prescription_id where p.request_key='${key(1201)}'))`);
    assert.deepEqual(counts, { prescriptions: 1, orders: 1, items: 1 });
    for (const changed of [handoff.replace('quantity_prescribed":1','quantity_prescribed":2'),
      handoff.replace('Synthetic replacement prerequisite','Changed replacement prerequisite')]) {
      assert.notEqual(changed, handoff);
      const conflict = await query(changed, { actor: ids.userA, allowError: true });
      assert.notEqual(conflict.code, 0);
      assert.match(conflict.err, /IDEMPOTENCY_KEY_REUSED/);
    }
    const foreign = await query(handoff, { actor: ids.userB, allowError: true });
    assert.notEqual(foreign.code, 0);
    assert.match(foreign.err, /ENCOUNTER_NOT_FOUND|PERMISSION_DENIED/);
    assert.deepEqual(await jsonQuery(handoff, { actor: ids.userA }), JSON.parse(a.out), 'conflicting retries changed the receipt');
  } finally {
    if (!first.child.stdin.writableEnded) first.child.stdin.end('rollback;\n');
    await first.done;
    if (second) await second;
  }
  console.log('prescription-handoff-native: contending same-key requests create one prescription/order/item; changed notes or quantity rejected; foreign-clinic replay denied; original receipt preserved');
  // Installed after the pre-existing restore proof: this section proves races,
  // not backup/restore coverage of the replacement table.
  for (const n of [1,2]) {
    const replacementEncounter=key(2000+n);
    await query(`set request.jwt.claim.sub='${ids.owner}'; set request.jwt.claim.role='service_role';
      insert into public.encounters(id,encounter_no,patient_id,clinic_id,status,practitioner_id,created_by)
      values('${replacementEncounter}','REPLACEMENT-RACE-${n}','${patient}','${ids.clinicA}','draft','${ids.userA}','${ids.userA}');`);
    const original = await jsonQuery(`select row_to_json(x) from public.create_atomic_prescription_handoff(
      '${key(1300+n)}','${replacementEncounter}','Synthetic original for replacement race',
      '[{"product_id":"${ids.productA}","quantity_prescribed":1,"unit":"ชิ้น"}]') x`, {actor:ids.userA});
    const ticket = await jsonQuery(`select public.manage_prescription_clarification(
      '${original.dispensing_order_id}','${key(1400+n)}','open','Synthetic replacement question')`,{actor:pharmacy});
    const replace = request => `select public.manage_prescription_replacement('${request}','${ticket.id}','replace',
      'Synthetic replacement reason','Synthetic revised notes',
      '[{"product_id":"${ids.productA}","quantity_prescribed":1,"unit":"ชิ้น","dose":"Synthetic revision"}]');`;
    const winnerKey=key(1500+n), loserKey=n===1?winnerKey:key(1600+n);
    const winnerName=`replacement_winner_${n}`, loserName=`replacement_loser_${n}`;
    const stockBefore=await query("select current_quantity from public.inventory_lots where lot_number='CLARIFICATION-RACE'");
    const winner=connection(sourceDb,winnerName);
    winner.child.stdin.write(`begin; ${auth(ids.userA)} ${replace(winnerKey)}\n`);
    let loser, dispensing, invoicing;
    try {
      await waitForSession(winnerName,"state='idle in transaction'");
      loser=query(replace(loserKey),{actor:ids.userA,name:loserName,allowError:true});
      await waitForSession(loserName,"wait_event_type='Lock'");
      const dispensingName=`replacement_dispensing_${n}`;
      dispensing=query(`select public.transition_atomic_prescription_dispensing('${original.dispensing_order_id}','dispense')`,
        {actor:pharmacy,name:dispensingName,allowError:true});
      await waitForSession(dispensingName,"wait_event_type='Lock'");
      // No valid quote exists while pharmacy work is pending. A syntactically
      // valid stale fingerprint must not bypass the authoritative readiness check.
      const invoiceName=`replacement_invoice_${n}`;
      invoicing=query(`select * from public.issue_atomic_encounter_invoice('${key(1900+n)}','${replacementEncounter}','${'0'.repeat(64)}')`,
        {actor:ids.owner,name:invoiceName,allowError:true});
      await waitForSession(invoiceName,"wait_event_type='Lock'");
      winner.child.stdin.end('commit;\n');
      const a=await winner.done, b=await loser;
      assert.equal(a.code,0,a.err);
      const receipt=JSON.parse(a.out);
      if(n===1) {assert.equal(b.code,0,b.err);assert.deepEqual(JSON.parse(b.out),receipt);}
      else {assert.notEqual(b.code,0);assert.match(b.err,/REPLACEMENT_REQUEST_CONFLICT/);}
      const denied=await dispensing;
      assert.notEqual(denied.code,0,'superseded order was dispensed');
      assert.match(denied.err,/REPLACEMENT_SUPERSEDED|PRESCRIPTION_INACTIVE/);
      const invoiceDenied=await invoicing;
      assert.notEqual(invoiceDenied.code,0,'pending replacement encounter was invoiced');
      assert.match(invoiceDenied.err,/DISPENSING_ORDER_NOT_READY_FOR_BILLING/);
      assert.equal((await query(`select count(*) from public.invoices where encounter_id='${replacementEncounter}'`)).out,'0');
      assert.equal((await query(`select count(*) from cnyos_billing_internal.invoice_request_receipts where request_key='${key(1900+n)}'`)).out,'0');
      assert.equal((await query("select current_quantity from public.inventory_lots where lot_number='CLARIFICATION-RACE'")).out,stockBefore.out);
      assert.equal((await query(`select count(*) from public.dispensing_items where dispensing_order_id='${original.dispensing_order_id}'`)).out,'0');
      assert.equal((await query(`select count(*) from public.stock_movements where reference_id='${original.dispensing_order_id}'`)).out,'0');
      const state=await jsonQuery(`select jsonb_build_object(
        'receipts',(select count(*) from cnyos_clarification_internal.replacements where old_order_id='${original.dispensing_order_id}'),
        'new_prescriptions',(select count(*) from public.prescriptions where request_key in ('${winnerKey}','${loserKey}')),
        'new_orders',(select count(*) from public.dispensing_orders d join public.prescriptions p on p.id=d.prescription_id where p.request_key in ('${winnerKey}','${loserKey}')),
        'old_status',(select status from public.prescriptions where id='${original.prescription_id}'),
        'new_status',(select status from public.dispensing_orders where id='${receipt.new_order_id}'))`);
      assert.deepEqual(state,{receipts:1,new_prescriptions:1,new_orders:1,old_status:'cancelled',new_status:'waiting'});
      const held=await query(`select public.transition_atomic_prescription_dispensing('${receipt.new_order_id}','review')`,{actor:pharmacy,allowError:true});
      assert.notEqual(held.code,0); assert.match(held.err,/REPLACEMENT_ACK_REQUIRED/);
      const acknowledged=await jsonQuery(`select public.manage_prescription_replacement('${winnerKey}','${ticket.id}','acknowledge')`,{actor:pharmacy});
      assert.equal(acknowledged.acknowledged_by,pharmacy);
      await query(`select public.transition_atomic_prescription_dispensing('${receipt.new_order_id}','review')`,{actor:pharmacy});
      assert.equal(Number((await query(`select count(*) from public.audit_logs where entity='prescription_replacements' and entity_id='${winnerKey}'`)).out),2);
    } finally {
      if(!winner.child.stdin.writableEnded) winner.child.stdin.end('rollback;\n');
      await winner.done; if(loser) await loser; if(dispensing) await dispensing; if(invoicing) await invoicing;
    }
  }
  // Reverse ordering uses a legitimately resolved clarification: an unresolved
  // ticket cannot legally reach dispensing in the first place.
  const reverseEncounter=key(2100);
  await query(`set request.jwt.claim.sub='${ids.owner}'; set request.jwt.claim.role='service_role';
    insert into public.encounters(id,encounter_no,patient_id,clinic_id,status,practitioner_id,created_by)
    values('${reverseEncounter}','INVOICE-FIRST-RACE','${patient}','${ids.clinicA}','draft','${ids.userA}','${ids.userA}');`);
  const reverse=await jsonQuery(`select row_to_json(x) from public.create_atomic_prescription_handoff(
    '${key(1701)}','${reverseEncounter}','Synthetic dispense-first original',
    '[{"product_id":"${ids.productA}","quantity_prescribed":1,"unit":"ชิ้น"}]') x`,{actor:ids.userA});
  const reverseOrder=reverse.dispensing_order_id;
  const reverseTicket=await jsonQuery(clarificationCall(reverseOrder,1000,'open','Synthetic dispense-first question'),{actor:pharmacy});
  await query(clarificationCall(reverseOrder,1000,'answer','Synthetic proceed unchanged'),{actor:ids.userA});
  await query(clarificationCall(reverseOrder,1000,'acknowledge',''),{actor:pharmacy});
  await query(`select public.transition_atomic_prescription_dispensing('${reverseOrder}','review')`,{actor:pharmacy});
  const reverseItem=(await query(`select id from public.prescription_items where prescription_id='${reverse.prescription_id}'`)).out;
  const reverseBefore=Number((await query("select current_quantity from public.inventory_lots where lot_number='CLARIFICATION-RACE'")).out);
  const dispenser=connection(sourceDb,'dispense_before_replacement');
  dispenser.child.stdin.write(`begin; ${auth(pharmacy)} select public.transition_atomic_prescription_dispensing('${reverseOrder}','dispense',
    '[{"prescription_item_id":"${reverseItem}","unit_price":125}]'::jsonb);\n`);
  let lateReplacement;
  try {
    await waitForSession('dispense_before_replacement',"state='idle in transaction'");
    lateReplacement=query(`select public.manage_prescription_replacement('${key(1702)}','${reverseTicket.id}','replace',
      'Synthetic late replacement','Synthetic late notes',
      '[{"product_id":"${ids.productA}","quantity_prescribed":1,"unit":"ชิ้น"}]')`,
      {actor:ids.userA,name:'replacement_after_dispense',allowError:true});
    await waitForSession('replacement_after_dispense',"wait_event_type='Lock'");
    dispenser.child.stdin.end('commit;\n');
    const committed=await dispenser.done;assert.equal(committed.code,0,committed.err);
    const denied=await lateReplacement;assert.notEqual(denied.code,0);assert.match(denied.err,/REPLACEMENT_CORRECTION_REQUIRED/);
    assert.equal(Number((await query("select current_quantity from public.inventory_lots where lot_number='CLARIFICATION-RACE'")).out),reverseBefore-1);
    assert.equal((await query(`select count(*) from public.dispensing_items where dispensing_order_id='${reverseOrder}'`)).out,'1');
    assert.equal((await query(`select count(*) from cnyos_clarification_internal.replacements where request_id='${key(1702)}'`)).out,'0');
    assert.equal((await query(`select count(*) from public.prescriptions where request_key='${key(1702)}'`)).out,'0');
  } finally {
    if(!dispenser.child.stdin.writableEnded)dispenser.child.stdin.end('rollback;\n');
    await dispenser.done;if(lateReplacement)await lateReplacement;
  }
  await query(`select public.transition_atomic_prescription_dispensing('${reverseOrder}','submit_billing')`,{actor:pharmacy});
  const quote=await jsonQuery(`select public.quote_encounter_invoice('${reverseEncounter}')`,{actor:ids.owner});
  const invoiceSql=`select row_to_json(x) from public.issue_atomic_encounter_invoice('${key(2101)}','${reverseEncounter}','${quote.quote_fingerprint}') x;`;
  const issuer=connection(sourceDb,'invoice_before_replacement');
  issuer.child.stdin.write(`begin; ${auth(ids.owner)} ${invoiceSql}\n`);
  let afterInvoice;
  try {
    await waitForSession('invoice_before_replacement',"state='idle in transaction'");
    afterInvoice=query(`select public.manage_prescription_replacement('${key(2102)}','${reverseTicket.id}','replace',
      'Synthetic post-invoice correction','Synthetic revised notes',
      '[{"product_id":"${ids.productA}","quantity_prescribed":1,"unit":"ชิ้น"}]')`,
      {actor:ids.userA,name:'replacement_after_invoice',allowError:true});
    await waitForSession('replacement_after_invoice',"wait_event_type='Lock'");
    issuer.child.stdin.end('commit;\n');
    const committed=await issuer.done;assert.equal(committed.code,0,committed.err);
    const invoice=JSON.parse(committed.out);
    assert.equal(Number(invoice.grand_total),125);
    const denied=await afterInvoice;assert.notEqual(denied.code,0);assert.match(denied.err,/REPLACEMENT_CORRECTION_REQUIRED/);
    assert.deepEqual(await jsonQuery(invoiceSql,{actor:ids.owner}),invoice,'original invoice replay changed');
    assert.equal((await query(`select count(*) from public.invoices where encounter_id='${reverseEncounter}'`)).out,'1');
    assert.equal((await query(`select count(*) from cnyos_clarification_internal.replacements where request_id='${key(2102)}'`)).out,'0');
    assert.equal((await query(`select count(*) from public.prescriptions where request_key='${key(2102)}'`)).out,'0');
    assert.equal((await query(`select status from public.dispensing_orders where id='${reverseOrder}'`)).out,'billed');
    assert.equal(Number((await query("select current_quantity from public.inventory_lots where lot_number='CLARIFICATION-RACE'")).out),reverseBefore-1);
  } finally {
    if(!issuer.child.stdin.writableEnded)issuer.child.stdin.end('rollback;\n');
    await issuer.done;if(afterInvoice)await afterInvoice;
  }
  console.log('replacement-native: both replacement/dispensing and replacement/invoice lock orderings passed; one successor or preserved original invoice; no orphan rejected replacement');
  console.log('clarification-race-native: both lock-winner orderings passed; question-first prevents stock writes; dispense-first rejects late clarification; exactly one stock deduction; inactive prescriptions reject all transitions including replay');
}

async function verifyReplacementRestore() {
  const before=await projection(sourceDb);
  const table='cnyos_clarification_internal.replacements';
  assert.equal(before.trace.schema_version,'2026-09-27.1');
  assert.equal(before.trace.counts[table],2);
  const database='cnyos_replacement_restore';
  const dump=docker(['exec','-i',container,'pg_dump','-U','postgres','--format=custom','--dbname',sourceDb],undefined,'buffer');
  docker(['exec',container,'createdb','-U','postgres',database]);
  docker(['exec','-i',container,'pg_restore','-U','postgres','--exit-on-error','--dbname',database],dump);
  const after=await projection(database);
  assert.deepEqual(after.trace.counts,before.trace.counts);
  assert.deepEqual(after.trace.table_sha256,before.trace.table_sha256);
  assert.deepEqual(after.transactions.data[table],before.transactions.data[table]);
  assert.equal(Object.keys(after.trace.table_sha256).length,11);
  for(const receipt of after.transactions.data[table]) {
    const read=`select public.manage_prescription_replacement('${receipt.request_id}','${receipt.ticket_id}','read')`;
    assert.deepEqual(await jsonQuery(read,{database,actor:ids.userA}),receipt);
    const foreign=await query(read,{database,actor:ids.userB,allowError:true});
    assert.notEqual(foreign.code,0);
    assert.match(foreign.err,/TICKET_NOT_FOUND/);
    const replay=await jsonQuery(`select public.manage_prescription_replacement('${receipt.request_id}','${receipt.ticket_id}','acknowledge')`,{database,actor:key(700)});
    assert.deepEqual(replay,receipt);
  }
  assert.deepEqual((await projection(database)).trace.table_sha256,after.trace.table_sha256);
  const first=after.transactions.data[table][0];
  // Corrupt only disposable restored clinical content; verifier must reject it.
  await query(`update public.prescription_items set dose='Synthetic corrupt restored dose' where prescription_id='${first.new_rx_id}'`,{database});
  for(const sql of [`select public.verify_clinic_restore_trace('${ids.clinicA}')`, `select public.export_clinic_backup_domain('${ids.clinicA}','transactions')`]) {
    const rejected=await query(sql,{database,actor:ids.owner,role:'service_role',allowError:true});
    assert.notEqual(rejected.code,0);
    assert.match(rejected.err,/BACKUP_REPLACEMENT_INTEGRITY_ANOMALY/);
  }
  console.log('replacement-restore-native: v3 pg_dump/pg_restore preserved two replacement chains and 11 hashes; replay/tenant denial preserved; changed restored revision rejected by trace and export');
}

let owned = false;
async function verifyAmendmentRestore() {
  for (const [file,code] of [
    ['clinical_amendment_recovery_candidate.sql','CLINICAL_AMENDMENT_RECOVERY_REVIEW_REQUIRED'],
    ['clinical_amendment_backup_candidate.sql','CLINICAL_AMENDMENT_BACKUP_REVIEW_REQUIRED']
  ]) {
    const source=await fs.readFile(new URL(`../supabase/manual/${file}`,import.meta.url),'utf8');
    const blocker=`do $$ begin raise exception '${code}'; end $$;`;
    assert.equal(source.split(blocker).length,2);
    await query(source.replace(blocker,'-- In-memory isolated native test only'));
  }
  const encounterId=key(900),requestId=key(901);
  await query(`set request.jwt.claim.role='service_role';
    insert into public.encounters(id,encounter_no,patient_id,clinic_id,status,practitioner_id)
      values('${encounterId}','SYN-AMEND-RESTORE','${patient}','${ids.clinicA}','draft','${ids.userA}');
    insert into public.ttm_structured_diagnoses(encounter_id,analysis_summary,thai_diagnosis,diagnosed_by)
      values('${encounterId}','Synthetic','Synthetic','${ids.userA}');
    insert into public.clinical_treatment_plans(encounter_id,goal_1,planned_by)
      values('${encounterId}','Synthetic','${ids.userA}');`);
  const signSql=`select row_to_json(s) from public.sign_clinical_record_complete('${encounterId}','Synthetic practitioner',null,'Synthetic restore signature') s`;
  const old=await jsonQuery(signSql,{actor:ids.userA});
  const retrySql=`select public.unlock_clinical_record_for_amendment_v2('${requestId}','${encounterId}','${old.id}',${old.signature_generation},'Synthetic restore amendment')`;
  const receipt=await jsonQuery(retrySql,{actor:ids.superAdmin});
  await jsonQuery(signSql,{actor:ids.userA});
  const latest=await jsonQuery(signSql,{actor:ids.userA});
  assert.equal(latest.signature_generation,3);
  const before=await projection(sourceDb);
  assert.equal(before.trace.schema_version,'2026-09-27.2');
  assert.equal(Object.keys(before.trace.table_sha256).length,14);
  const database='cnyos_amendment_restore';
  const dump=docker(['exec','-i',container,'pg_dump','-U','postgres','--format=custom','--dbname',sourceDb],undefined,'buffer');
  docker(['exec',container,'createdb','-U','postgres',database]);
  docker(['exec','-i',container,'pg_restore','-U','postgres','--exit-on-error','--dbname',database],dump);
  const restored=await projection(database);
  assert.deepEqual(restored.trace.counts,before.trace.counts);
  assert.deepEqual(restored.trace.table_sha256,before.trace.table_sha256);
  const readSql=`select coalesce(public.read_clinical_amendment_receipt('${requestId}'),'null'::jsonb)`;
  assert.deepEqual(await jsonQuery(readSql,{database,actor:ids.superAdmin}),receipt);
  assert.deepEqual(await jsonQuery(retrySql,{database,actor:ids.superAdmin}),receipt);
  const signoff=await jsonQuery(`select to_jsonb(s) from public.clinical_record_signoffs s where id='${old.id}'`,{database});
  assert.deepEqual(signoff,latest,'dump restore must preserve generation 3, not reset INSERT to 1');
  assert.equal(signoff.lock_record,true);
  assert.equal(await jsonQuery(readSql,{database,actor:ids.userB}),null);
  for(const sql of [
    `select * from cnyos_amendment_internal.receipts`,
    `select public.export_clinic_backup_domain_pre_amendment('${ids.clinicA}','transactions')`
  ]) {
    const denied=await query(sql,{database,actor:ids.owner,role:'service_role',allowError:true});
    assert.notEqual(denied.code,0);assert.match(denied.err,/permission denied/);
  }
  const immutable=await query('delete from cnyos_amendment_internal.receipts',{database,allowError:true});
  assert.notEqual(immutable.code,0);assert.match(immutable.err,/AMENDMENT_RECEIPT_IMMUTABLE/);
  assert.deepEqual((await projection(database)).trace.table_sha256,before.trace.table_sha256);
  // Corrupt only disposable restored state. Missing receipts must fail even
  // when a newer signature makes the clinical record look otherwise healthy.
  await query('alter table cnyos_amendment_internal.receipts disable trigger user; delete from cnyos_amendment_internal.receipts; alter table cnyos_amendment_internal.receipts enable trigger user;',{database});
  for(const sql of [`select public.verify_clinic_restore_trace('${ids.clinicA}')`,
    `select public.export_clinic_backup_domain('${ids.clinicA}','patients')`]) {
    const failed=await query(sql,{database,actor:ids.owner,role:'service_role',allowError:true});
    assert.notEqual(failed.code,0);assert.match(failed.err,/BACKUP_AMENDMENT_INTEGRITY_ANOMALY/);
  }
  console.log('amendment-restore-native: full pg_dump/pg_restore preserved generation 3, immutable receipt and 14 hashes; historical read/retry preserved the newer signature; missing receipt rejected; service/internal and cross-clinic boundaries retained.');
}

try {
  docker(['run', '--pull=never', '--detach', '--rm', '--network', 'none', '--name', container, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', image]);
  owned = true;
  for (let i = 0; i < 180; i++) {
    // The image's initialization server is socket-only and exits before the
    // final server starts. Probe container-local TCP so it cannot look ready.
    try { docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); break; } catch { if (i === 179) throw new Error('Database startup timeout'); await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  for (let i = 0; i < 120; i++) {
    try { await query('select 1', { database: 'postgres', name: 'startup_probe' }); break; }
    catch (error) { if (i === 119) throw error; await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  docker(['exec', container, 'createdb', '-U', 'postgres', sourceDb]);
  const nativeAdapter = {
    exec: async sql => { await query(sql, { database: sourceDb, name: 'fixture_exec' }); return { rows: [] }; },
    query: async sql => { await query(`set request.jwt.claim.sub='${ids.owner}'; set request.jwt.claim.role='service_role'; ${sql}`, { database: sourceDb, name: 'fixture_query' }); return { rows: [] }; }
  };
  await createPriceMasterFixture({ database: nativeAdapter, nativePostgres: true });
  await query(await fs.readFile(new URL('../supabase/manual/20260917_ttm_knowledge_review_rpc_candidate.sql', import.meta.url), 'utf8'));
  const knowledgePending = await jsonQuery(knowledgeSubmit(1), { actor: ids.userA });
  const knowledgeApproved = await jsonQuery(knowledgeSubmit(2), { actor: ids.userA });
  await query(`select id from public.decide_ttm_knowledge_suggestion('${knowledgeApproved.id}','approve','Synthetic independent fixture decision')`, { actor: ids.superAdmin });
  const seeded = await seedBilling();
  const clarificationCases = await seedClarifications();
  await query(`set request.jwt.claim.role='service_role';
    update public.clinic_memberships set clinic_role='admin' where profile_id='${ids.userB}' and clinic_id='${ids.clinicB}';
    insert into public.audit_logs(clinic_id,user_id,action,entity,entity_id,metadata) values
      ('${ids.clinicA}','${ids.owner}','assign_department_role','clinic_memberships','RESTORE-AUDIT-A','{"old_clinic_role":"viewer","new_clinic_role":"billing"}'),
      ('${ids.clinicB}','${ids.userB}','assign_department_role','clinic_memberships','RESTORE-AUDIT-B','{}'),
      ('${ids.clinicA}','${ids.owner}','clinical_view','encounters','RESTORE-AUDIT-UNRELATED','{}');`, { name: 'seed_audit_boundary' });
  await verifyAuditBoundary(sourceDb);

  const before = await projection(sourceDb, 'UTC');
  const beforeKnowledge = await knowledgeState(sourceDb);
  const beforeFinancialState = await financialState(sourceDb);
  const otherZone = await projection(sourceDb, 'America/Los_Angeles');
  assert.deepEqual(otherZone.products.table_sha256, before.products.table_sha256, 'products hashes must be UTC/timezone invariant');
  assert.deepEqual(otherZone.transactions.table_sha256, before.transactions.table_sha256, 'transaction hashes must be UTC/timezone invariant');
  assert.equal(before.products.schema_version, '2026-09-27.1');
  assert.equal(before.transactions.schema_version, '2026-09-27.1');
  assert.equal(before.trace.counts['cnyos_clarification_internal.tickets'],3);
  assert.equal(before.trace.counts['cnyos_clarification_internal.clearances'],1);

  const dump = docker(['exec', '-i', container, 'pg_dump', '-U', 'postgres', '--format=custom', '--dbname', sourceDb], undefined, 'buffer');
  assert.ok(Buffer.isBuffer(dump) && dump.length > 1000, 'pg_dump custom stream is empty');
  docker(['exec', container, 'createdb', '-U', 'postgres', targetDb]);
  docker(['exec', '-i', container, 'pg_restore', '-U', 'postgres', '--exit-on-error', '--dbname', targetDb], dump);

  const after = await projection(targetDb, 'UTC');
  for(const {n,order,ticket} of clarificationCases) {
    const replay=await jsonQuery(clarificationCall(order,n,'open',`Synthetic question ${n}`),{database:targetDb,actor:pharmacy});
    assert.deepEqual(replay,ticket,'restored clarification replay changed content or state');
    const foreign=await query(clarificationCall(order,n,'read',''),{database:targetDb,actor:ids.userB,allowError:true});
    assert.notEqual(foreign.code,0);
    assert.match(foreign.err,/ORDER_NOT_FOUND/);
    if(n<3) {
      const held=await query(`select public.transition_atomic_prescription_dispensing('${order}','review')`,{database:targetDb,actor:pharmacy,allowError:true});
      assert.notEqual(held.code,0);
      assert.match(held.err,/CLARIFICATION_PENDING/);
    }
  }
  const replayedProjection=await projection(targetDb);
  assert.deepEqual(replayedProjection.transactions.table_sha256,after.transactions.table_sha256,'restored clarification retries changed evidence');
  console.log('clarification-restore-native: open/answered/resolved tickets, clearance and hashes restored; replay and unresolved hold preserved; foreign-clinic reads denied');
  const afterKnowledge = await knowledgeState(targetDb);
  assert.deepEqual(afterKnowledge, beforeKnowledge, 'knowledge rows, snapshots, identities or linked decisions changed after restore');
  assert.equal(stateHash(afterKnowledge), stateHash(beforeKnowledge));
  for (const [n, original, status] of [[1, knowledgePending, 'pending'], [2, knowledgeApproved, 'approved']]) {
    const replay = await jsonQuery(knowledgeSubmit(n), { database: targetDb, actor: ids.userA });
    assert.equal(replay.id, original.id);
    assert.equal(replay.status, status);
    assert.equal(replay.client_request_id, key(900+n));
  }
  assert.deepEqual(await knowledgeState(targetDb), afterKnowledge, 'restored knowledge retries must not add or modify history');
  const foreignKnowledge = await jsonQuery('select coalesce(jsonb_agg(id),\'[]\'::jsonb) from public.ttm_knowledge_suggestions', { database: targetDb, actor: ids.userB });
  assert.deepEqual(foreignKnowledge, [], 'restored knowledge RLS must deny other clinic');
  const internalKnowledge = await query(`select public.apply_ttm_knowledge_suggestion('${knowledgePending.id}')`, { database: targetDb, actor: ids.userA, allowError: true });
  assert.notEqual(internalKnowledge.code, 0);
  assert.match(internalKnowledge.err, /permission denied/);
  console.log(`knowledge-restore-native: proposal/event/task SHA-256 ${stateHash(afterKnowledge)}; pending and approved request replay preserved; cross-clinic and internal-mutator denial preserved`);
  await verifyAuditBoundary(targetDb);
  const afterFinancialState = await financialState(targetDb);
  for (const domain of ['products', 'transactions']) {
    assert.deepEqual(after[domain].table_sha256, before[domain].table_sha256, `${domain} table_sha256 changed after restore`);
  }
  assert.deepEqual(after.trace.table_sha256, { ...before.products.table_sha256, ...before.transactions.table_sha256 });
  assert.equal(after.trace.schema_version, '2026-09-27.1');
  assert.equal(after.trace.referential_integrity_anomalies, 0);
  assert.deepEqual(after.trace.counts, before.trace.counts, 'restore trace counts changed');
  assert.deepEqual(afterFinancialState, beforeFinancialState, 'invoice balance, source counts, or price rate versions changed');

  const receiptRows = before.transactions.data['cnyos_billing_internal.invoice_request_receipts'];
  const treatmentReceiptRows = before.transactions.data['cnyos_treatment_internal.session_request_receipts'];
  assert.ok(Array.isArray(receiptRows) && receiptRows.length > 0);
  assert.ok(Array.isArray(treatmentReceiptRows) && treatmentReceiptRows.length > 0);
  const restoredQuoteFingerprint = receiptRows[0].quote_fingerprint;
  const replayAfter = await jsonQuery(`select row_to_json(x) from public.issue_atomic_encounter_invoice('${key(400)}','${encounter}','${restoredQuoteFingerprint}') x`, { database: targetDb, actor: ids.owner, name: 'restored_invoice_replay' });
  assert.deepEqual(replayAfter, seeded.invoice, 'restored invoice replay changed its result');
  const treatmentReplay = await query(`select (public.get_clinical_treatment_session_request('${key(300)}','${encounter}')).id`, { database: targetDb, actor: ids.userA, name: 'restored_treatment_replay' });
  assert.equal(treatmentReplay.out, treatmentReceiptRows[0].session_id, 'restored treatment replay changed its session');

  // Replay the original write RPC, not only its read-only receipt lookup.
  // The encounter is already signed and invoiced: retry must recover the old
  // result without creating another treatment or changing financial evidence.
  const repeatedTreatment = await query(seeded.treatmentCall, { database: targetDb, actor: ids.userA, name: 'restored_treatment_write_retry' });
  assert.equal(repeatedTreatment.out, treatmentReceiptRows[0].session_id, 'restored write retry created a different treatment');
  const changedTreatmentCall = seeded.treatmentCall.replace('Synthetic restore treatment', 'Changed restore treatment');
  assert.notEqual(changedTreatmentCall, seeded.treatmentCall, 'conflict fixture must change the request body');
  const conflict = await query(changedTreatmentCall, { database: targetDb, actor: ids.userA, name: 'restored_treatment_conflict', allowError: true });
  assert.notEqual(conflict.code, 0, 'restored request accepted changed treatment details');
  assert.match(conflict.err, /TREATMENT_REQUEST_CONFLICT/, 'restored conflict did not preserve request fingerprint validation');
  const afterRetries = await projection(targetDb, 'UTC');
  assert.deepEqual(afterRetries.trace.counts, after.trace.counts, 'restored retries changed row counts');
  assert.deepEqual(afterRetries.trace.table_sha256, after.trace.table_sha256, 'restored retries changed provenance');
  assert.deepEqual(await financialState(targetDb), afterFinancialState, 'restored retries changed financial state');

  // Corruption is performed only in the isolated restored database. Disabling
  // the immutable trigger models an owner/test repair operation without ever
  // granting application roles access to provenance tables.
  await query(`alter table cnyos_billing_internal.invoice_request_receipts disable trigger all;
    delete from cnyos_billing_internal.invoice_request_receipts where request_key='${key(400)}';
    alter table cnyos_billing_internal.invoice_request_receipts enable trigger all;`, { database: targetDb, name: 'isolated_corruption' });
  const corruptedTrace = await jsonQuery(`select public.verify_clinic_restore_trace('${ids.clinicA}')`, { database: targetDb, actor: ids.owner, role: 'service_role', name: 'corrupted_trace' });
  assert.equal(corruptedTrace.ready, false, 'corrupted restore unexpectedly remained ready');
  assert.ok(corruptedTrace.referential_integrity_anomalies > 0, 'corrupted restore did not report anomalies');
  assert.notDeepEqual(corruptedTrace.table_sha256, before.trace.table_sha256, 'receipt corruption did not change transaction hashes');
  assert.notEqual(corruptedTrace.counts['cnyos_billing_internal.invoice_request_receipts'], before.trace.counts['cnyos_billing_internal.invoice_request_receipts'], 'receipt corruption did not change trace count');
  const rejectedExport = await query(`select public.export_clinic_backup_domain('${ids.clinicA}','transactions')`, { database: targetDb, actor: ids.owner, role: 'service_role', name: 'corrupted_export', allowError: true });
  assert.notEqual(rejectedExport.code, 0, 'corrupted exporter unexpectedly succeeded');
  assert.match(rejectedExport.err, /BACKUP_FINANCIAL_INTEGRITY_ANOMALY/);
  await verifyClarificationRaces();
  await verifyReplacementRestore();
  await verifyAmendmentRestore();
  console.log(`financial-restore-native: ok; image ${image}; dump_bytes ${dump.length}; exporter/restore trace ${Object.keys(after.trace.table_sha256).length} hashes equal; UTC/timezone stable; replay preserved; audit role/tenant boundaries preserved; isolated corruption detected`);
} finally {
  for (const child of active) child.kill();
  if (owned) docker(['rm', '--force', container]);
}
