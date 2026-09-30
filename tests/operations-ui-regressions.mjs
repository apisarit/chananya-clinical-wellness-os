import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');

const retryButtons = [];
class Element {
  constructor(id) {
    this.id = id; this._html = ''; this.textContent = ''; this.value = ''; this.dataset = {}; this.classList = { add() {}, remove() {}, toggle() {} };
    Object.defineProperty(this, 'innerHTML', { get: () => this._html, set: value => {
      this._html = String(value);
      for (const button of retryButtons.filter(item => item.owner === this)) retryButtons.splice(retryButtons.indexOf(button), 1);
      for (const match of this._html.matchAll(/data-retry-load="([^"]+)"/g)) retryButtons.push(Object.assign(new Element(`retry-${match[1]}`), { owner: this, dataset: { retryLoad: match[1] } }));
    } });
  }
  addEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  reset() {}
  scrollIntoView() {}
  closest() { return null; }
}

const ids = ['toast', 'workspace-title', 'app', 'boot', 'boot-error', 'main-nav', 'patient-search', 'patient-list', 'patient-export', 'patient-export-count', 'patient-export-all', 'patient-export-clear', 'patient-export-format', 'patient-export-download', 'patient-form', 'patient-cancel', 'patient-submit', 'p-hn', 'p-prefix', 'p-first', 'p-last', 'p-national', 'p-gender', 'p-dob', 'p-phone', 'p-address', 'p-right', 'p-emergency', 'p-allergy', 'identity-link-form', 'identity-existing-links', 'identity-revoke-form', 'identity-revoke-cancel', 'identity-link-type', 'identity-link-relation', 'identity-link-consent', 'identity-copy-code', 'payment-form', 'pay-invoice', 'pay-amount', 'pay-channel', 'pay-note', 'logout', 'unlock', 'lock', 'receipt-dialog', 'receipt-body', 'quick-actions', 'work-list', 'audit-list', 'billing-queue', 'treatment-billing-queue', 'invoice-list', 'stat-p', 'stat-a', 'stat-d', 'stat-rx', 'stat-b'];
const elements = new Map(ids.map(id => [id, new Element(id)]));
const document = {
  querySelector(selector) { return selector.startsWith('#') ? elements.get(selector.slice(1)) || new Element(selector) : new Element(selector); },
  querySelectorAll(selector) { return selector.includes('data-retry-load') ? retryButtons : []; },
  addEventListener() {},
  body: { classList: { add() {}, remove() {} } },
  createElement() { return new Element('created'); }
};

let billingRpcCalls = 0;
let auditFailure = true;
const tableErrors = new Map();
const tableReplies = new Map();
const rpcReplies = [];
const queriedTables = [];
const tableRows = {
  patients: [], patient_allergies: [], clinic_appointments: [
    { id: 'booked-today', patient_id: 'p1', scheduled_start: '2026-09-29T17:30:00.000Z', status: 'booked' },
    { id: 'cancelled', patient_id: 'p1', scheduled_start: '2026-09-29T18:00:00.000Z', status: 'cancelled' },
    { id: 'malformed', patient_id: 'p1', scheduled_start: 'not-a-date', status: 'booked' }
  ], encounters: [], prescriptions: [], dispensing_orders: [], dispensing_items: [], prescription_items: [], products: [], invoices: [], payments: [], audit_logs: []
};
const db = {
  from(table) {
    queriedTables.push(table);
    const request = { select() { return request; }, order() { return request; }, then(resolve, reject) {
      const queued = tableReplies.get(table)?.shift();
      const result = queued || (tableErrors.has(table) ? { data: null, error: tableErrors.get(table) }
        : auditFailure && table === 'audit_logs' ? { data: null, error: { code: '42P01', message: 'relation audit_logs does not exist' } }
        : { data: structuredClone(tableRows[table] || []), error: null });
      Promise.resolve(result).then(resolve, reject);
    } };
    return request;
  },
  async rpc(name) {
    if (name === 'hybrid_patient_identity_healthcheck' || name === 'clinical_financial_handoffs_healthcheck') return { data: [{ ready: true }], error: null };
    if (name === 'list_billable_treatment_encounters') {
      billingRpcCalls += 1;
      if (rpcReplies.length) return rpcReplies.shift();
      return billingRpcCalls === 1 ? { data: null, error: { code: '500', message: 'temporary failure' } } : { data: [], error: null };
    }
    return { data: [], error: null };
  },
  auth: { async signOut() {} }
};

const context = {
  document,
  console: { log() {}, warn() {}, error() {} },
  alert() {},
  setTimeout() { return 1; }, clearTimeout() {},
  setInterval() { return 1; }, clearInterval() {},
  scrollTo() {},
  location: { replace() {} },
  navigator: { clipboard: { writeText: async () => {} } },
  fetch: async () => ({ json: async () => ({ enabled: true }) }),
  addEventListener() {}, dispatchEvent() {},
  crypto: { randomUUID: () => 'test-request' },
  URL,
  Intl,
  CustomEvent: class CustomEvent {},
  ChananyaShell: { mount: () => ({ visibleRoutes: [] }) },
  ChananyaRuntime: {
    getDb: () => db, getSession: async () => ({ user: { id: 'u1' } }), getProfile: async () => ({ access_context_ready: true }), roleOf: () => 'admin',
    can: (_profile, permission) => ['patient_registry', 'appointments_view', 'clinical_read', 'pharmacy_operate', 'billing_operate'].includes(permission), showAccountStatus() {}
  },
  window: null
};
const fixedNow = new Date('2026-09-30T00:00:00+07:00').getTime();
context.Date = class FrozenDate extends Date {
  constructor(...args) { super(args.length ? args[0] : fixedNow); }
  static now() { return fixedNow; }
};
context.window = context;
vm.runInNewContext(source, context, { filename: 'app.js' });
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(String(elements.get('stat-a').textContent), '1', `Bangkok current-day booked appointment is counted, cancelled is not (${elements.get('boot-error').textContent})`);
assert.ok(queriedTables.includes('clinic_appointments'), 'dashboard reads canonical clinic appointment register');
assert.match(elements.get('treatment-billing-queue').innerHTML, /โหลดรายการค่าบริการรักษาไม่สำเร็จ/);
assert.doesNotMatch(elements.get('treatment-billing-queue').innerHTML, /ไม่มี Encounter/);
assert.match(elements.get('audit-list').innerHTML, /Audit log ยังไม่พร้อมใช้งาน/);
const reload = retryButtons.find(button => button.dataset.retryLoad === 'finance').onclick;
auditFailure = false;
for (const button of retryButtons.slice()) if (button.dataset.retryLoad === 'audit' || button.dataset.retryLoad === 'finance') await button.onclick();
await new Promise(resolve => setTimeout(resolve, 0));
assert.match(elements.get('treatment-billing-queue').innerHTML, /ไม่มี Encounter/);
assert.match(elements.get('audit-list').innerHTML, /ยังไม่มีรายการ Audit log/);

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const content = id => elements.get(id).innerHTML;
const ok = data => ({ data, error: null });

// A previous successful snapshot must disappear on denied access.
tableRows.audit_logs = [{ action: 'SYNTHETIC_AUDIT', entity: 'test', created_at: '2026-09-30T00:00:00Z' }];
await reload();
assert.match(content('audit-list'), /SYNTHETIC_AUDIT/);
tableErrors.set('audit_logs', { code: '42501' });
tableErrors.set('clinic_appointments', { code: '42501' });
rpcReplies.push({ data: null, error: { code: '42501' } });
await reload();
assert.match(content('audit-list'), /ไม่มีสิทธิ์/);
assert.doesNotMatch(content('audit-list'), /SYNTHETIC_AUDIT/);
assert.equal(elements.get('stat-a').textContent, 'ไม่มีสิทธิ์');
assert.match(content('treatment-billing-queue'), /ไม่มีสิทธิ์/);
tableErrors.clear();
tableRows.audit_logs = [];

// Pending real DOM render must not say successful zero/empty.
const pendingTable = deferred();
tableReplies.set('clinic_appointments', [pendingTable.promise]);
const loadingRun = reload();
assert.match(content('audit-list'), /กำลังโหลด/);
assert.match(content('treatment-billing-queue'), /กำลังโหลด/);
assert.equal(elements.get('stat-a').textContent, 'กำลังโหลด…');
pendingTable.resolve(ok(tableRows.clinic_appointments));
await loadingRun;
assert.equal(elements.get('stat-a').textContent, 1);

// Missing RPC differs from transport failure and successful empty.
for (const code of ['PGRST202', '42883']) {
  rpcReplies.push({ data: null, error: { code } });
  await reload();
  assert.match(content('treatment-billing-queue'), /ยังไม่พร้อมใช้งาน/);
  assert.doesNotMatch(content('treatment-billing-queue'), /ไม่มี Encounter/);
}

// Older table and RPC reads cannot repaint over a newer load.
const olderTable = deferred();
tableReplies.set('clinic_appointments', [olderTable.promise, ok([])]);
const oldLoad = reload();
await flush();
await reload();
olderTable.resolve(ok(tableRows.clinic_appointments));
await oldLoad;
assert.equal(elements.get('stat-a').textContent, 0);
const olderRpc = deferred();
rpcReplies.push(olderRpc.promise, ok([]));
const oldFinance = reload();
await flush();
await reload();
olderRpc.resolve(ok([{ encounter_id: 'old', encounter_no: 'STALE_ENCOUNTER' }]));
await oldFinance;
assert.match(content('treatment-billing-queue'), /ไม่มี Encounter/);
assert.doesNotMatch(content('treatment-billing-queue'), /STALE_ENCOUNTER/);
assert.ok(!queriedTables.includes('appointments'), 'never silently falls back to the obsolete register');

console.log('operations UI regressions passed: canonical/Bangkok dates, errors/retry, denial, loading, missing RPC, stale table/RPC reads');
