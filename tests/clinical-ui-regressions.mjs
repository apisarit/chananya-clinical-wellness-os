import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../clinical-signoff.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const ok = data => ({ data, error: null });
class Element {
  constructor() { this.value = ''; this.disabled = false; this.inert = false; this.dataset = {}; this.listeners = {}; this.html = ''; }
  set innerHTML(value) { this.html = String(value); }
  get innerHTML() { return this.html; }
  set textContent(value) { this.html = String(value); }
  get textContent() { return this.html.replace(/<[^>]*>/g, ''); }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  dispatch(name) { return Promise.all((this.listeners[name] || []).map(fn => fn({ preventDefault() {}, target: this }))); }
  setAttribute() {}
}
async function harness({ capability = true, initialId = 'A', rows = {} } = {}) {
  const elements = new Map(['clinical-signoff-panel', 'clinical-record-fields', 'signoff-form', 'signoff-btn', 'signoff-status', 'signer-name', 'license-no', 'signoff-reason', 'encounter'].map(id => [id, new Element()]));
  elements.get('encounter').value = initialId;
  const events = {}, state = { rows, calls: [], confirmations: 0, alerts: [], onRead: null, onRpc: null };
  const db = {
    from(table) {
      const filters = {};
      const read = () => {
        const id = filters.encounter_id;
        if (state.onRead) { const value = state.onRead(table, id); if (value) return value; }
        const row = state.rows[id] || {};
        if (row.error) return { data: null, error: row.error };
        if (table === 'ttm_structured_diagnoses') return ok(row.diagnosis ? { id: 'diagnosis' } : null);
        if (table === 'clinical_treatment_plans') return ok(row.plan ? { id: 'plan' } : null);
        if (table === 'clinical_treatment_sessions') return ok(row.treatment ? [{ id: 'treatment' }] : []);
        return ok(row.status || null);
      };
      const q = { select() { return q; }, eq(key, value) { filters[key] = value; return q; }, order() { return q; }, limit() { return q; }, maybeSingle() { return Promise.resolve().then(read); }, then(resolve, reject) { return Promise.resolve().then(read).then(resolve, reject); } };
      return q;
    },
    async rpc(name, args) {
      state.calls.push({ name, args });
      if (state.onRpc) return state.onRpc(args);
      (state.rows[args.p_encounter_id] ||= {}).status = { lock_record: true, signer_name: 'SYNTHETIC', signed_at: '2026-09-30T00:00:00Z' };
      return ok({ lock_record: true });
    }
  };
  const window = {
    addEventListener(name, fn) { (events[name] ||= []).push(fn); },
    dispatchEvent(event) { for (const fn of events[event.type] || []) fn(event); },
    ChananyaRuntime: { getDb: () => db, getSession: async () => ({ user: { id: 'synthetic' } }), getProfile: async () => ({ role: 'practitioner' }) }
  };
  if (capability !== null) window.ChananyaRuntime.can = () => capability;
  class CustomEvent { constructor(type, { detail } = {}) { this.type = type; this.detail = detail; } }
  const context = { window, document: { readyState: 'complete', querySelector: s => elements.get(s.slice(1)) || null }, console: { error() {} }, CustomEvent, setTimeout, alert: message => state.alerts.push(message), confirm: () => { state.confirmations++; return true; } };
  vm.runInNewContext(source, context, { filename: 'clinical-signoff.js' });
  await flush();
  return {
    state, get: id => elements.get(id),
    emit: (type, id = elements.get('encounter').value) => window.dispatchEvent(new CustomEvent(type, { detail: { encounterId: id } })),
    select(id) { elements.get('encounter').value = id; window.dispatchEvent(new CustomEvent('chananya:encounter-changed', { detail: { encounterId: id } })); },
    submit: () => elements.get('signoff-form').dispatch('submit')
  };
}
test('missing encounter/Diagnosis/Treatment never confirms or writes; successful saves enable same encounter', async () => {
  const h = await harness();
  assert.equal(h.get('signoff-btn').disabled, true);
  await h.submit(); assert.equal(h.state.confirmations, 0);
  h.state.rows.A = { diagnosis: true };
  h.emit('chananya:diagnosis-saved'); await flush();
  assert.equal(h.get('signoff-btn').disabled, true);
  h.state.rows.A.plan = true;
  h.emit('chananya:clinical-data-changed'); await flush();
  assert.equal(h.get('signoff-btn').disabled, false);
  h.select(''); await flush(); await h.submit();
  assert.equal(h.state.calls.length, 0);
  assert.equal(h.get('signoff-btn').disabled, true);
});
test('valid session treatment and duplicate submits produce one write with verified lock readback', async () => {
  const h = await harness({ rows: { A: { diagnosis: true, treatment: true } } });
  assert.equal(h.get('signoff-btn').disabled, false);
  await Promise.all([h.submit(), h.submit()]);
  assert.equal(h.state.calls.length, 1);
  assert.equal(h.state.calls[0].args.p_encounter_id, 'A');
  assert.equal(h.get('clinical-record-fields').inert, true);
  assert.match(h.get('signoff-status').textContent, /SIGNED & LOCKED/);
  assert.match(h.state.alerts.at(-1), /สำเร็จ/);
});
test('denied or missing capability refuses even a programmatic submit', async () => {
  for (const capability of [false, null]) {
    const h = await harness({ capability, rows: { A: { diagnosis: true, plan: true } } });
    await h.submit();
    assert.equal(h.get('signoff-btn').disabled, true);
    assert.equal(h.state.calls.length, 0);
    assert.equal(h.state.confirmations, 0);
  }
});
test('unknown initial status keeps editing blocked until a successful read', async () => {
  const h = await harness({ rows: { A: { error: { code: '42501' } } } });
  assert.equal(h.get('clinical-record-fields').inert, true);
  assert.equal(h.get('signoff-btn').disabled, true);
  await h.submit(); assert.equal(h.state.calls.length, 0);
  h.state.rows.A = { diagnosis: true, plan: true };
  h.emit('chananya:clinical-data-changed'); await flush();
  assert.equal(h.get('clinical-record-fields').inert, false);
});
test('two overlapping failed refreshes cannot erase a previously known lock', async () => {
  const h = await harness({ rows: { A: { diagnosis: true, treatment: true, status: { lock_record: true, signed_at: '2026-09-30' } } } });
  const pending = [];
  h.state.onRead = () => { const d = deferred(); pending.push(d); return d.promise; };
  h.emit('chananya:clinical-data-changed'); await flush();
  h.emit('chananya:diagnosis-saved'); await flush();
  assert.equal(pending.length, 8);
  for (const d of pending.slice(4)) d.resolve({ data: null, error: { code: '500' } });
  await flush();
  assert.equal(h.get('clinical-record-fields').inert, true);
  assert.match(h.get('signoff-btn').textContent, /Lock แล้ว/);
  for (const d of pending.slice(0, 4)) d.resolve(ok(null));
  await flush(); assert.equal(h.get('clinical-record-fields').inert, true);
});
test('confirmed RPC lock survives failed readback without a false verified-success alert', async () => {
  const h = await harness({ rows: { A: { diagnosis: true, plan: true } } });
  h.state.onRpc = () => { h.state.rows.A.error = { code: '500' }; return ok({ lock_record: true }); };
  await h.submit();
  assert.equal(h.state.calls.length, 1);
  assert.equal(h.get('clinical-record-fields').inert, true);
  assert.equal(h.get('signoff-btn').disabled, true);
  assert.match(h.state.alerts.at(-1), /ยังยืนยันผลอ่านกลับไม่ได้/);
});
test('late A readiness/status cannot repaint B; pending submit cannot sign a different encounter', async () => {
  const h = await harness({ rows: { A: { diagnosis: true, plan: true }, B: {} } });
  const pending = [];
  h.state.onRead = (_table, id) => { if (id === 'A') { const d = deferred(); pending.push(d); return d.promise; } };
  const submit = h.submit(); await flush();
  h.select('B'); await flush();
  assert.match(h.get('signoff-status').textContent, /ยังไม่พร้อมลงนาม/);
  assert.equal(h.get('signoff-btn').disabled, true);
  for (const d of pending) d.resolve(ok({ id: 'stale', lock_record: true }));
  await submit; await flush();
  assert.match(h.get('signoff-status').textContent, /ยังไม่พร้อมลงนาม/);
  assert.doesNotMatch(h.get('signoff-status').textContent, /SIGNED/);
  assert.equal(h.get('clinical-record-fields').inert, false);
  assert.equal(h.state.calls.length, 0);
});
test('committed-then-timeout remains unknown/inert until exact status readback; no blind re-sign', async () => {
  const h = await harness({ rows: { A: { diagnosis: true, plan: true } } });
  h.state.onRpc = () => {
    h.state.rows.A.status = { lock_record: true, signed_at: '2026-09-30' };
    throw new Error('SYNTHETIC timeout after commit');
  };
  await h.submit();
  assert.equal(h.state.calls.length, 1);
  assert.equal(h.get('clinical-record-fields').inert, true);
  assert.equal(h.get('signoff-btn').disabled, true);
  h.emit('chananya:clinical-data-changed'); await flush();
  assert.match(h.get('signoff-status').textContent, /SIGNED & LOCKED/);
  await h.submit();
  assert.equal(h.state.calls.length, 1);
});
