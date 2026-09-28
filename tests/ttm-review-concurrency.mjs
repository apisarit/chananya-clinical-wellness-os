// Local PostgreSQL only: no published ports, mounts, credentials or patient data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { createPriceMasterFixture, PRICE_FIXTURE_IDS as ids } from './helpers/price-master-fixture.mjs';

const container = `cnyos-ttm-review-${process.pid}-${Date.now()}`;
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000, stdio: ['pipe','pipe','pipe'] }).trim();
const image = docker(['image','inspect','postgres:17-alpine','--format','{{.Id}}']);
assert.match(image, /^sha256:[a-f0-9]{64}$/);
const active = new Set();
function connection(name) {
  assert.match(name, /^[a-z_]+$/);
  const child = spawn('docker', ['exec','-i',container,'psql','-XqAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres']);
  active.add(child);
  let out = '', err = '';
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('SQL test timeout')); }, 30000);
    child.stdout.on('data', b => { out += b; });
    child.stderr.on('data', b => { err += b; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); active.delete(child); resolve({ code, out: out.trim(), err }); });
  });
  done.catch(() => {});
  child.stdin.on('error', () => {});
  child.stdin.write(`set application_name='${name}'; set statement_timeout='25s'; set idle_in_transaction_session_timeout='25s';\n`);
  return { child, done };
}
const auth = actor => `set request.jwt.claim.sub='${actor}'; set request.jwt.claim.role='authenticated'; set role authenticated;`;
async function query(sql, actor = null, name = 'observer', allowError = false) {
  const c = connection(name);
  c.child.stdin.end((actor ? auth(actor) : '') + sql);
  const result = await c.done;
  if (result.code !== 0 && !allowError) throw new Error(result.err);
  return result;
}
async function waitFor(sql) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if ((await query(sql)).out === 't') return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Condition not observed: ${sql}`);
}
const waiting = name => `select exists(select 1 from pg_stat_activity where application_name='${name}' and wait_event_type='Lock');`;
const idle = name => `select exists(select 1 from pg_stat_activity where application_name='${name}' and state='idle in transaction');`;
let owned = false;
try {
  docker(['run','--pull=never','--detach','--rm','--network','none','--name',container,'-e','POSTGRES_HOST_AUTH_METHOD=trust',image]);
  owned = true;
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try { if (docker(['exec',container,'cat','/proc/1/comm']) === 'postgres') { docker(['exec',container,'pg_isready','-U','postgres']); ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready);
  await createPriceMasterFixture({ nativePostgres: true, database: {
    exec: sql => query(sql), query: async sql => { await query("set request.jwt.claim.role='service_role';" + sql); return { rows: [] }; }
  } });
  await query(await fs.readFile(new URL('../supabase/manual/20260917_ttm_knowledge_review_rpc_candidate.sql', import.meta.url), 'utf8'));
  const requestId = '77777777-1111-4111-8111-111111111111';
  const onceSql = `select id from public.submit_ttm_knowledge_suggestion_once(
    '${requestId}','ttm_diagnostic_knowledge',null,'create',
    '{"domain":"synthetic","rule_key":"REQUEST-RACE","input_key":"test","output_value":"synthetic"}',
    'Synthetic reference','Synthetic request concurrency');`;
  const firstSubmit = connection('first_submit');
  firstSubmit.child.stdin.write(`begin; ${auth(ids.userA)} ${onceSql}\n`);
  await waitFor(idle('first_submit'));
  const secondSubmit = query(onceSql, ids.userA, 'second_submit');
  await waitFor(waiting('second_submit'));
  firstSubmit.child.stdin.end('commit;\n');
  const firstResult = await firstSubmit.done;
  assert.equal(firstResult.code, 0);
  assert.equal((await secondSubmit).out, firstResult.out);
  assert.equal((await query(`select count(*) from public.ttm_knowledge_suggestions where client_request_id='${requestId}';`)).out, '1');
  assert.equal((await query(`select count(*) from public.ttm_knowledge_suggestion_events where suggestion_id='${firstResult.out}';`)).out, '1');
  console.log('Native simultaneous submission replay: one proposal and one submission event; same original ID returned.');
  for (const table of ['ttm_diagnostic_knowledge', 'ttm_concepts']) {
    const dkr = table === 'ttm_diagnostic_knowledge';
    const target = (await query(dkr
      ? "insert into public.ttm_diagnostic_knowledge(domain,rule_key,input_key,output_value) values ('synthetic','RACE','test','old') returning id;"
      : "insert into public.ttm_concepts(concept_code,concept_type,preferred_term_th,foundation_layer,definition) values ('SYNTHETIC-RACE','knowledge_rule','synthetic',2,'old') returning id;")).out;
    const payload = dkr ? '{"output_value":"proposed"}' : '{"concept_code":"SYNTHETIC-RACE","concept_type":"knowledge_rule","preferred_term_th":"synthetic","definition":"proposed"}';
    const submit = () => query(`select id from public.submit_ttm_knowledge_suggestion('${table}','${target}','update','${payload}','Synthetic reference','Synthetic concurrency regression');`, ids.userA);
    const first = (await submit()).out;
    const field = dkr ? 'output_value' : 'definition';
    const writer = connection('writer');
    writer.child.stdin.write(`begin; update public.${table} set ${field}='concurrent' where id='${target}';\n`);
    await waitFor(idle('writer'));
    const approve = query(`select status from public.decide_ttm_knowledge_suggestion('${first}','approve','Synthetic approval test');`, ids.superAdmin, 'approver', true);
    await waitFor(waiting('approver'));
    writer.child.stdin.end('commit;\n');
    assert.equal((await writer.done).code, 0);
    const failed = await approve;
    assert.notEqual(failed.code, 0);
    assert.match(failed.err, /TTM_SUGGESTION_TARGET_CHANGED_RESUBMIT/);
    assert.equal((await query(`select ${field} from public.${table} where id='${target}';`)).out, 'concurrent');
    assert.equal((await query(`select s.status||'|'||a.status from public.ttm_knowledge_suggestions s join public.approval_tasks a on a.id=s.approval_task_id where s.id='${first}';`)).out, 'pending|pending');
    assert.equal((await query(`select count(*) from public.ttm_knowledge_suggestion_events where suggestion_id='${first}';`)).out, '1');
    const fresh = (await submit()).out;
    assert.equal((await query(`select status from public.decide_ttm_knowledge_suggestion('${fresh}','approve','Synthetic approval test');`, ids.superAdmin)).out, 'approved');
    assert.equal((await query(`select ${field} from public.${table} where id='${target}';`)).out, 'proposed');
    const left = (await submit()).out;
    const right = (await submit()).out;
    const lock = connection('target_lock');
    lock.child.stdin.write(`begin; select id from public.${table} where id='${target}' for update;\n`);
    await waitFor(idle('target_lock'));
    const a = query(`select status from public.decide_ttm_knowledge_suggestion('${left}','approve','Synthetic competing review');`, ids.superAdmin, 'review_left', true);
    const b = query(`select status from public.decide_ttm_knowledge_suggestion('${right}','approve','Synthetic competing review');`, ids.superAdmin, 'review_right', true);
    await waitFor(waiting('review_left'));
    await waitFor(waiting('review_right'));
    lock.child.stdin.end('commit;\n');
    assert.equal((await lock.done).code, 0);
    const competing = await Promise.all([a,b]);
    assert.equal(competing.filter(r => r.code === 0 && r.out === 'approved').length, 1);
    assert.equal(competing.filter(r => r.code !== 0 && /TTM_SUGGESTION_TARGET_CHANGED_RESUBMIT/.test(r.err)).length, 1);
    assert.equal((await query(`select string_agg(status,',' order by status) from public.ttm_knowledge_suggestions where id in ('${left}','${right}');`)).out, 'approved,pending');
    assert.equal((await query(`select count(*) from public.ttm_knowledge_suggestion_events where suggestion_id in ('${left}','${right}') and event='approve';`)).out, '1');
  }
  console.log(`Native TTM review race passed on ${image}: both target types wait for writer, refuse stale approval atomically, preserve concurrent edit, accept fresh resubmission; competing proposals yield one approval only. No live authorization.`);
} finally {
  for (const child of active) child.kill();
  if (owned) docker(['rm','--force',container]);
}
