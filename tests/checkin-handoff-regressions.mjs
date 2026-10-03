// Actual event handlers, synthetic DOM/RPC only. No network or live DB evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../check-in.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../check-in.html', import.meta.url), 'utf8');
const A = { patient_id: 'synthetic-a', hn: 'TEST-A', display_name: 'Synthetic A', qr_session_id: 'qr-a' };
const B = { patient_id: 'synthetic-b', hn: 'TEST-B', display_name: 'Synthetic B' };
const receipt = { encounter_id: 'synthetic/enc?1', encounter_no: 'TEST-ENC-1', patient_id: A.patient_id };
const ok = data => ({ data, error: null });
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
class Element {
  constructor(id = '') {
    this.id = id; this.value = ''; this.checked = false; this.disabled = false;
    this.textContent = ''; this.children = []; this.listeners = {};
    const classes = new Set();
    this.classList = {
      add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
      toggle(name, force) { const on = force ?? !classes.has(name); if (on) classes.add(name); else classes.delete(name); }
    };
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type) { for (const fn of this.listeners[type] || []) fn({ target: this, preventDefault() {} }); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  scrollIntoView() {}
  reset() {}
}
async function harness({ role = 'reception', appointment = false, write = () => ok(receipt) } = {}) {
  const nodes = new Map();
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const element = new Element(match[1]);
    (/\bclass="([^"]*)"/.exec(match[0])?.[1]?.split(/\s+/) || []).forEach(name => element.classList.add(name));
    nodes.set(element.id, element);
  }
  const node = id => { assert.ok(nodes.has(id), `Missing real HTML node ${id}`); return nodes.get(id); };
  node('verification-method').value = 'hn_dob';
  node('confirmation-form').reset = () => {
    for (const id of ['verification-note', 'checkin-chief']) node(id).value = '';
    node('patient-present').checked = false; node('verification-method').value = 'hn_dob';
  };
  const calls = []; const alerts = []; const navigation = [];
  const handlers = { write, search: () => ok([A, B]), qr: () => ok(A) };
  const db = {
    rpc(name, payload) {
      calls.push({ name, payload });
      if (name === 'hybrid_patient_identity_healthcheck') return Promise.resolve(ok([{ ready: true }]));
      if (name === 'search_patients_for_checkin') return Promise.resolve(handlers.search(payload));
      if (name === 'resolve_patient_qr') return Promise.resolve(handlers.qr(payload));
      return handlers.write(name, payload);
    },
    from(table) {
      assert.equal(table, 'clinic_appointments');
      const query = { select() { return query; }, eq() { return query; }, maybeSingle: async () => ok({
        id: 'synthetic-appointment', appointment_no: 'TEST-APT', status: 'booked', patient_id: A.patient_id,
        scheduled_start: '2026-10-01T03:00:00Z', chief_complaint: 'Synthetic appointment note',
        patient: { id: A.patient_id, hn: A.hn, first_name: 'Synthetic', last_name: 'A' }
      }) }; return query;
    }
  };
  const document = {
    querySelector: selector => node(selector.slice(1)), createElement: () => new Element(),
    querySelectorAll: selector => selector.includes('#confirmation-form input')
      ? ['patient-present', 'verification-method', 'verification-note', 'checkin-chief'].map(node).concat(node('manual-results').children)
      : ['credential-input', 'manual-search', 'cancel-confirmation'].map(node)
  };
  const location = { href: `https://synthetic.invalid/check-in.html${appointment ? '?appointment=synthetic-appointment' : ''}`, replace: url => navigation.push(url), assign: url => navigation.push(url) };
  vm.runInNewContext(source, {
    document, location, URL, Date, navigator: {},
    window: { addEventListener() {}, ChananyaRuntime: {
      getDb: () => db, getSession: async () => ({ user: { id: 'synthetic-operator' } }),
      getProfile: async () => ({ role }), can: (_profile, capability) => capability === 'patient_checkin' || (capability === 'clinical_write' && role === 'practitioner')
    }, ChananyaShell: { mount() {} } },
    console: { error() {}, warn() {} }, alert: message => alerts.push(message),
    setTimeout() { return 1; }, cancelAnimationFrame() {}, requestAnimationFrame() { return 1; }
  }, { filename: 'check-in.js' });
  await flush();
  assert.equal(node('boot-error').textContent, '');
  assert.equal(node('boot').classList.contains('hidden'), true, 'actual init completed');
  const dispatch = (id, type) => node(id).dispatch(type);
  const search = async () => { node('manual-search').value = 'TEST'; dispatch('manual-search-form', 'submit'); await flush(); };
  const select = index => node('manual-results').children[index].dispatch('click');
  const submit = () => dispatch('confirmation-form', 'submit');
  const writes = () => calls.filter(call => ['start_manual_patient_encounter', 'confirm_patient_qr', 'check_in_clinic_appointment'].includes(call.name));
  return { node, handlers, calls, alerts, navigation, dispatch, search, select, submit, writes };
}
let count = 0;
async function check(name, fn) { await fn(); count++; console.log(`PASS ${name}`); }

await check('fresh confirmation required; identity switch clears consent and notes', async () => {
  const h = await harness(); await h.search(); h.select(0); h.submit(); await flush();
  assert.equal(h.writes().length, 0);
  h.node('patient-present').checked = true; h.node('verification-note').value = 'A note'; h.node('checkin-chief').value = 'A chief'; h.select(1);
  assert.equal(h.node('confirm-hn').textContent, B.hn); assert.equal(h.node('patient-present').checked, false);
  assert.equal(h.node('verification-note').value, ''); assert.equal(h.node('checkin-chief').value, '');
});
for (const [role, appointment, destination] of [
  ['reception', false, '/check-in.html'], ['reception', true, '/appointments.html#appointment-register'],
  ['practitioner', false, '/clinical-v3.html?encounter=synthetic%2Fenc%3F1&step=history']
]) await check(`${role}/${appointment ? 'appointment' : 'walk-in'} duplicate guard and exact receipt destination`, async () => {
  const pending = deferred(); const h = await harness({ role, appointment, write: () => pending.promise });
  if (!appointment) { await h.search(); h.select(0); }
  h.node('patient-present').checked = true; h.submit(); h.submit();
  assert.equal(h.writes().length, 1); assert.equal(h.node('confirm-encounter').disabled, true);
  h.dispatch('cancel-confirmation', 'click'); assert.equal(h.node('confirm-hn').textContent, A.hn);
  pending.resolve(ok(receipt)); await flush(); h.submit(); await flush();
  assert.equal(h.writes().length, 1); assert.equal(h.node('handoff-receipt').classList.contains('hidden'), false);
  assert.equal(h.node('handoff-primary').href, destination); assert.equal(h.navigation.length, 0);
  assert.equal(h.node('confirm-encounter').disabled, true); assert.match(h.node('handoff-receipt-detail').textContent, /TEST-ENC-1/);
  if (appointment) {
    assert.match(h.node('appointment-context-detail').textContent, /เชื่อม Encounter TEST-ENC-1 สำเร็จ/);
    assert.doesNotMatch(h.node('appointment-context-detail').textContent, /สถานะ booked/);
  }
  if (role === 'reception' && !appointment) assert.match(h.node('handoff-receipt-status').textContent, /จะไม่ปรากฏในรายการนัดหมาย/);
});
await check('QR happy path unlocks confirmation and uses QR RPC', async () => {
  const h = await harness(); h.node('credential-input').value = '123456'; h.dispatch('credential-form', 'submit'); await flush();
  assert.equal(h.node('confirm-hn').textContent, A.hn); assert.equal(h.node('confirm-encounter').disabled, false);
  h.node('patient-present').checked = true; h.submit(); await flush();
  assert.equal(h.writes()[0].name, 'confirm_patient_qr'); assert.equal(h.writes()[0].payload.p_qr_session_id, 'qr-a');
});
for (const kind of ['search', 'qr']) await check(`selection supersedes pending ${kind}; stale completion cannot unlock write`, async () => {
  const pending = deferred(); const write = deferred(); const h = await harness({ write: () => write.promise });
  await h.search(); h.select(0); h.handlers[kind] = () => pending.promise;
  if (kind === 'search') h.dispatch('manual-search-form', 'submit');
  else { h.node('credential-input').value = '123456'; h.dispatch('credential-form', 'submit'); }
  h.select(1); assert.equal(h.node('confirm-encounter').disabled, false);
  h.node('patient-present').checked = true; h.submit(); pending.resolve(ok(kind === 'search' ? [A] : A)); await flush();
  assert.equal(h.node('confirm-hn').textContent, B.hn); assert.equal(h.node('confirm-encounter').disabled, true);
  assert.equal(h.writes()[0].payload.p_patient_id, B.patient_id);
  write.resolve(ok({ ...receipt, patient_id: B.patient_id })); await flush(); assert.equal(h.node('handoff-receipt').classList.contains('hidden'), false);
});
await check('older QR finalizer never unlocks newer request', async () => {
  const first = deferred(); const second = deferred(); const h = await harness(); let n = 0;
  h.handlers.qr = () => (++n === 1 ? first : second).promise;
  h.node('credential-input').value = '123456'; h.dispatch('credential-form', 'submit'); h.dispatch('credential-form', 'submit');
  first.resolve(ok(A)); await flush(); assert.equal(h.node('confirm-encounter').disabled, true);
  second.resolve(ok(B)); await flush(); assert.equal(h.node('confirm-encounter').disabled, false); assert.equal(h.node('confirm-hn').textContent, B.hn);
});
await check('permission rejection permits deliberate retry, not false success', async () => {
  const h = await harness({ write: () => ({ data: null, error: { code: '42501', message: 'PERMISSION_DENIED' } }) });
  await h.search(); h.select(0); h.node('patient-present').checked = true; h.submit(); await flush();
  assert.equal(h.node('handoff-receipt').classList.contains('hidden'), true);
  assert.equal(h.node('handoff-uncertain').classList.contains('hidden'), true); assert.equal(h.node('confirm-encounter').disabled, false);
  h.handlers.write = () => ok(receipt); h.submit(); await flush(); assert.equal(h.writes().length, 2);
});
for (const [label, write] of [
  ['synchronous throw', () => { throw new Error('synthetic transport error'); }],
  ['rejected promise', () => Promise.reject(new Error('synthetic timeout'))],
  ['connection code', () => ({ error: { code: '08006', message: 'synthetic lost connection' } })],
  ['missing reply', () => undefined], ['null data', () => ok(null)], ['empty result', () => ok([])],
  ['multiple rows', () => ok([receipt, receipt])], ['non-string ID', () => ok({ ...receipt, encounter_id: 12 })],
  ['empty ID', () => ok({ ...receipt, encounter_id: '  ' })], ['different patient', () => ok({ ...receipt, patient_id: B.patient_id })]
]) await check(`${label}: uncertain result blocks resubmission`, async () => {
  const h = await harness({ write }); await h.search(); h.select(0); h.node('patient-present').checked = true;
  h.submit(); await flush(); h.submit(); h.dispatch('cancel-confirmation', 'click'); await flush();
  assert.equal(h.writes().length, 1); assert.equal(h.node('confirm-encounter').disabled, true);
  assert.equal(h.node('handoff-receipt').classList.contains('hidden'), true); assert.equal(h.node('handoff-uncertain').classList.contains('hidden'), false);
});
await check('one-row RPC array accepted', async () => {
  const h = await harness({ write: () => ok([receipt]) }); await h.search(); h.select(0); h.node('patient-present').checked = true;
  h.submit(); await flush(); assert.equal(h.node('handoff-receipt').classList.contains('hidden'), false);
});
console.log(`Check-in handoff: ${count} synthetic behavioral cases passed. Local VM only; not staging or live database acceptance.`);
