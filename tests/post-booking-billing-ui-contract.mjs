import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app.css'), 'utf8');
assert.match(app, /'audit_logs', 'id,occurred_at,user_id,action,entity', 'occurred_at'/);
assert.match(app, /new Date\(item\.occurred_at\)/);
assert.doesNotMatch(app, /'audit_logs', '\*', 'created_at'/);
const auditRenderer = app.match(/function renderAudit\(\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(auditRenderer);
const auditNode = { innerHTML: '' };
vm.runInNewContext(`${auditRenderer}; renderAudit();`, {
  $: () => auditNode,
  data: { audit: [{ occurred_at: '2026-09-26T10:00:00Z', action: 'synthetic', entity: 'roles', user_id: 'test' }] },
  esc: value => String(value)
});
assert.match(auditNode.innerHTML, /synthetic/);
assert.doesNotMatch(auditNode.innerHTML, /Invalid Date/);
vm.runInNewContext(`${auditRenderer}; renderAudit();`, {
  $: () => auditNode, data: { audit: [], auditFailed: true }
});
assert.match(auditNode.innerHTML, /โหลดประวัติไม่สำเร็จ/);
const auditLoader = app.match(/async function loadAuditOverview\(allowed\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(auditLoader);
let auditCalls = 0;
const auditContext = vm.createContext({ query: async () => { auditCalls++; throw new Error('private details'); } });
vm.runInContext(`${auditLoader}; globalThis.load = loadAuditOverview;`, auditContext);
assert.equal((await auditContext.load(false)).failed, false);
assert.equal(auditCalls, 0);
assert.equal((await auditContext.load(true)).failed, true);
auditContext.query = async () => [];
assert.equal((await auditContext.load(true)).failed, false, 'successful empty response clears failure');

assert.match(app, /list_billable_treatment_encounters/);
assert.match(app, /issue_atomic_treatment_invoice/);
assert.match(app, /async function createServiceInvoice\(encounterId, resumeMarker = null\)/);
assert.doesNotMatch(app.match(/async function createServiceInvoice\(encounterId, resumeMarker = null\)[\s\S]*?\n  \}/)?.[0] || '', /requireAtomicHandoffs/);
assert.match(app, /p_request_key:\s*requestKey/);
assert.match(app, /serviceInvoiceRequestKeys\.set\(encounterId, \{ requestKey, amount, description, actorSession, actorProfile \}\)/);
assert.match(app, /serviceInvoiceRequestKeys\.delete\(encounterId\)/);
assert.match(app, /quote_treatment_invoice/);
assert.match(app, /treatmentQuotes\.get\(encounterId\)/);
assert.doesNotMatch(app, /<input[^>]*data-treatment-amount/);
assert.doesNotMatch(app, /<input[^>]*data-service-fee/);
assert.match(app, /issue_atomic_encounter_invoice/);
assert.match(app, /p_quote_fingerprint: request.fingerprint/);
assert.doesNotMatch(app, /issue_atomic_dispensing_invoice/);
assert.match(app, /data-action="receipt"/);
assert.match(app, /payment_reference/);
assert.match(app, /esc\(payment\.paid_at\)/);
assert.match(app, /!payment\.paid_at/);
assert.match(app, /window\.print\(\)/);
assert.match(app, /document\.body\.classList\.add\('receipt-printing'\)/);
assert.match(app, /afterprint/);
assert.match(css, /body\.receipt-printing > :not\(#receipt-dialog\)/);
assert.match(css, /body\.receipt-printing #receipt-dialog \.identity-dialog-head/);
assert.match(app, /esc\(payment\.payment_reference\)/);
assert.match(app, /esc\(invoice\.invoice_number\)/);
assert.match(app, /esc\(patientName\(invoice\.patient_id\)\)/);
assert.match(html, /id="treatment-billing-queue"/);
assert.match(html, /id="receipt-dialog"/);
assert.match(html, /id="receipt-body"/);
assert.doesNotMatch(app, /KBank|2C2P|gateway_callback/i);
console.log('Post-booking billing UI contract passed: service-only RPC wiring, sticky request keys, escaped receipt readback, no gateway claim');
