import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash, randomUUID } from 'node:crypto';

const source = fs.readFileSync(new URL('../opd-workflow.js', import.meta.url), 'utf8');

class Element {
  constructor(value = '') {
    this.value = value;
    this.checked = false;
    this.textContent = '';
    this.innerHTML = '';
    this.listeners = {};
  }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  dispatch(type) {
    for (const listener of this.listeners[type] || []) {
      listener({ target: this, preventDefault() {} });
    }
  }
  reset() {
    this.value = '';
    this.resetCount = (this.resetCount || 0) + 1;
  }
}

const ids = [
  'encounter', 'opd-history-form', 'opd-session-form', 'opd-history-status', 'opd-session-list',
  'opd-duration-minutes', 'opd-treatment-detail', 'opd-procedure-referral', 'opd-procedure-detail',
  'opd-precautions', 'opd-pain-before', 'opd-pain-after', 'opd-outcome', 'opd-advice'
];
const elements = Object.fromEntries(ids.map(id => [`#${id}`, new Element()]));
elements['#opd-session-form'].reset = () => {
  elements['#opd-duration-minutes'].value = '';
  elements['#opd-treatment-detail'].value = '';
  elements['#opd-procedure-detail'].value = '';
  elements['#opd-precautions'].value = '';
  elements['#opd-pain-before'].value = '';
  elements['#opd-pain-after'].value = '';
  elements['#opd-outcome'].value = '';
  elements['#opd-advice'].value = '';
};
elements['#opd-procedure-referral'].checked = false;
const selectedModality = new Element();
selectedModality.value = 'นวดไทย';

const pending = [];
const rpcCalls = [];
let nextRpcError = null;
let recoveredSession = null;
const requestStorage = new Map();
const alerts = [];
const listeners = {};
const window = {
  sessionStorage: {
    getItem: key => requestStorage.get(key) || null,
    setItem: (key, value) => requestStorage.set(key, value),
    removeItem: key => requestStorage.delete(key)
  },
  addEventListener(type, listener) { (listeners[type] ||= []).push(listener); },
  dispatchEvent(event) { for (const listener of listeners[event.type] || []) listener(event); }
};
class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } }
const document = {
  readyState: 'complete',
  querySelector(selector) { return elements[selector] || null; },
  querySelectorAll(selector) {
    return selector === 'input[name="opd-modality"]:checked' ? [selectedModality] : [];
  },
  addEventListener() {}
};
const db = {
  auth: { onAuthStateChange() {} },
  from(table) {
    const query = { table, encounter: null };
    return {
      select() { return this; },
      eq(_field, value) { query.encounter = value; return this; },
      maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      order() { return new Promise(resolve => pending.push({ query, resolve })); }
    };
  },
  async rpc(name, args) {
    if (name === 'get_clinical_treatment_session_request') return { data: recoveredSession, error: null };
    rpcCalls.push({ name, args });
    if (nextRpcError) {
      const error = nextRpcError;
      nextRpcError = null;
      return { data: null, error };
    }
    return { data: null, error: null };
  }
};
const context = {
  TextEncoder,
  crypto: { randomUUID, subtle: { digest: async (_algorithm, bytes) => createHash('sha256').update(bytes).digest() } },
  window,
  document,
  CustomEvent,
  console: { error() {}, log() {} },
  alert(message) { alerts.push(String(message)); }
};
window.ChananyaRuntime = {
  getDb: () => db,
  getSession: async () => ({ user: { id: 'synthetic-user' } })
};
vm.runInNewContext(source, context, { filename: 'opd-workflow.js' });

const flush = () => new Promise(resolve => setImmediate(resolve));
function resolveSessions(encounter, rows = [], error = null) {
  const index = pending.findIndex(item => item.query.table === 'clinical_treatment_sessions' && item.query.encounter === encounter);
  assert.notEqual(index, -1, `pending sessions/${encounter}`);
  pending.splice(index, 1)[0].resolve({ data: rows, error });
}
function resolveHistory(encounter) {
  // The treatment workflow's history read is immediate in this focused harness.
  void encounter;
}

await flush();
elements['#encounter'].value = 'enc-duration';
elements['#encounter'].dispatch('change');
resolveHistory('enc-duration');
resolveSessions('enc-duration');
await flush();

elements['#opd-treatment-detail'].value = 'นวดไทยบริเวณบ่า';
for (const value of ['', '0', '-5', '1.5', 'Infinity', '1441']) {
  elements['#opd-duration-minutes'].value = value;
  elements['#opd-session-form'].dispatch('submit');
  await flush();
  assert.match(alerts.at(-1), /ระยะเวลาการรักษา/);
  assert.equal(rpcCalls.length, 0, `invalid duration ${value} must not call the RPC`);
}

elements['#opd-duration-minutes'].value = '45';
elements['#opd-session-form'].dispatch('submit');
elements['#opd-session-form'].dispatch('submit');
await flush();
assert.equal(rpcCalls.length, 1, 'simultaneous double submit must create only one session');
assert.equal(rpcCalls[0].name, 'create_clinical_treatment_session_idempotent');
assert.match(rpcCalls[0].args.p_request_id, /^[a-f0-9-]{36}$/);
assert.equal(rpcCalls[0].args.p_duration_minutes, 45);
assert.equal(elements['#opd-duration-minutes'].value, '', 'successful save must reset duration input');

resolveSessions('enc-duration', [{
  session_no: 1,
  treated_at: '2026-09-26T00:00:00Z',
  treatment_modalities: ['นวดไทย'],
  treatment_detail: 'นวดไทยบริเวณบ่า',
  duration_minutes: 45,
  pain_before: 6,
  pain_after: 3,
  outcome_summary: 'ดีขึ้น'
}]);
await flush();
assert.match(elements['#opd-session-list'].innerHTML, /ระยะเวลา:<\/b> 45 นาที/);

elements['#opd-duration-minutes'].value = '20';
elements['#opd-session-form'].dispatch('submit');
await flush();
assert.equal(rpcCalls.length, 2, 'a later intentional session is allowed after read-back');
resolveSessions('enc-duration');
await flush();

elements['#encounter'].value = 'enc-next';
elements['#encounter'].dispatch('change');
assert.equal(elements['#opd-duration-minutes'].value, '', 'switching Encounter must clear duration');
resolveSessions('enc-next');
await flush();

nextRpcError = { code: '42501', message: 'SYNTHETIC_PERMISSION_DENIED' };
elements['#opd-duration-minutes'].value = '30';
elements['#opd-session-form'].dispatch('submit');
await flush();
assert.match(alerts.at(-1), /SYNTHETIC_PERMISSION_DENIED/);
assert.equal(elements['#opd-duration-minutes'].value, '30', 'rejected save preserves draft');
elements['#opd-session-form'].dispatch('submit');
await flush();
assert.equal(rpcCalls.length, 4, 'a definitive rejection must release the pending guard');
resolveSessions('enc-next');
await flush();

elements['#opd-duration-minutes'].value = '25';
elements['#opd-session-form'].dispatch('submit');
await flush();
resolveSessions('enc-next', [], { message: 'READ_BACK_FAILED' });
await flush();
assert.match(alerts.at(-1), /บันทึกการรักษาแล้ว.*ไม่ต้องบันทึกซ้ำ/);
assert.equal(elements['#opd-duration-minutes'].value, '', 'committed write is not restored as an unsaved draft');

nextRpcError = { message: 'Network timeout' };
elements['#opd-duration-minutes'].value = '35';
elements['#opd-session-form'].dispatch('submit');
await flush();
const uncertainId = rpcCalls.at(-1).args.p_request_id;
assert.equal(requestStorage.size, 1, 'unknown outcome retains durable reference');
const pendingRecord = JSON.parse([...requestStorage.values()][0]);
assert.deepEqual(Object.keys(pendingRecord).sort(), ['fingerprint', 'id'], 'no clinical text is persisted');
const callsBeforeEdit = rpcCalls.length;
elements['#opd-duration-minutes'].value = '40';
elements['#opd-session-form'].dispatch('submit');
await flush();
assert.equal(rpcCalls.length, callsBeforeEdit, 'changed payload cannot escape uncertain request');
elements['#opd-duration-minutes'].value = '35';
elements['#opd-session-form'].dispatch('submit');
await flush();
assert.equal(rpcCalls.at(-1).args.p_request_id, uncertainId, 'retry reuses original UUID');
resolveSessions('enc-next');
await flush();
assert.equal(requestStorage.size, 0);

nextRpcError = { message: 'Response lost after commit' };
elements['#opd-duration-minutes'].value = '50';
elements['#opd-session-form'].dispatch('submit');
await flush();
const beforeRecovery = rpcCalls.length;
recoveredSession = { id: 'saved-session' };
elements['#opd-duration-minutes'].value = '50';
elements['#opd-session-form'].dispatch('submit');
await flush();
assert.equal(rpcCalls.length, beforeRecovery, 'receipt recovery does not repeat mutation');
resolveSessions('enc-next');
await flush();
assert.equal(requestStorage.size, 0);
assert.match(alerts.at(-1), /พบการบันทึกเดิมแล้ว/);
assert.equal(elements['#opd-duration-minutes'].value, '', 'recovered committed draft must be cleared');
elements['#opd-session-form'].dispatch('submit');
await flush();
assert.equal(rpcCalls.length, beforeRecovery, 'immediate submit after recovery must not duplicate the saved session');
nextRpcError = {code:'P0001',message:'TREATMENT_SESSION_ALREADY_BILLED'};
elements['#opd-duration-minutes'].value='15';
elements['#opd-session-form'].dispatch('submit');
await flush();
assert.match(alerts.at(-1),/ออกบิลแล้ว.*ประสานฝ่ายการเงิน/,'billing boundary must give an actionable explanation');
assert.equal(elements['#opd-duration-minutes'].value,'15','rejected charge does not silently discard clinical input');

console.log('treatment duration UI contract: validation, duplicate suppression, request UUID retry, changed-payload denial, receipt recovery and readback failure passed');
