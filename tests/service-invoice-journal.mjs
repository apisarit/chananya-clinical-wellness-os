import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto, randomUUID } from 'node:crypto';
const window = {};
vm.runInNewContext(fs.readFileSync(new URL('../service-invoice-journal.js', import.meta.url), 'utf8'), { window, crypto: webcrypto, TextEncoder });
const journal = window.CnyosServiceInvoiceJournal;
const entries = new Map();
const storage = { getItem: k => entries.get(k) ?? null, setItem: (k,v) => entries.set(k,v), removeItem: k => entries.delete(k) };
const context = { actorId: randomUUID(), clinicId: randomUUID(), storage };
const draft = { ...context, encounterId: randomUUID(), amount: 650, description: 'Synthetic service' };
const marker = await journal.prepare(draft);
assert.equal((await journal.prepare(draft)).requestId, marker.requestId);
assert.ok(![...entries.values()][0].includes('Synthetic service'));
assert.deepEqual(Object.keys(JSON.parse([...entries.values()][0])).sort(), ['actorId','clinicId','digest','encounterId','requestId','version']);
assert.equal(journal.restore(context).requestId, marker.requestId);
await assert.rejects(journal.prepare({ ...draft, amount: 700 }), /UNRESOLVED/);
assert.equal(journal.restore({ ...context, actorId: randomUUID() }), null);
const invoice = { id: randomUUID(), created_by: context.actorId, encounter_id: draft.encounterId, source_service_request_key: marker.requestId, grand_total: '650.00' };
const result = { clinicId: context.clinicId, invoice, items: [{ invoice_id: invoice.id, item_type: 'service', quantity: '1.000', unit_price: '650.00', line_total: '650.00', description: draft.description }] };
for (const bad of [
  { ...result, clinicId: randomUUID() }, { ...result, invoice: { ...invoice, created_by: randomUUID() } },
  { ...result, invoice: { ...invoice, source_service_request_key: randomUUID() } },
  { ...result, invoice: { ...invoice, grand_total: null } }, { ...result, items: [] },
  { ...result, items: [{ ...result.items[0], description: 'Changed' }] },
  ...['0', '-1', 'NaN', '1e0', '0.75', '1.0000000000000'].map(quantity =>
    ({ ...result, items: [{ ...result.items[0], quantity }] })),
  { ...result, items: [{ ...result.items[0], unit_price: '649.99' }] }
]) {
  await assert.rejects(journal.recover({ ...context, isCurrent: () => true, readInvoice: async () => bad }), /MISMATCH/);
  assert.equal(journal.restore(context).requestId, marker.requestId);
}
await assert.rejects(journal.recover({ ...context, isCurrent: () => false, readInvoice: async () => result }), /CONTEXT_CHANGED/);
assert.equal((await journal.recover({ ...context, isCurrent: () => true, readInvoice: async () => result })).id, invoice.id);
assert.equal(journal.restore(context), null);
await assert.rejects(journal.prepare({ ...draft, expectedRequestId: marker.requestId }), /JOURNAL_CHANGED/);
assert.equal(journal.restore(context), null, 'missing saved marker must not create a new identity on explicit resume');
await assert.rejects(journal.prepare({ ...draft, storage: { getItem: () => null, setItem() { throw new Error('blocked storage'); } } }), /blocked storage/);
console.log('Service invoice journal passed: metadata-only identity, same-key retry, changed draft refusal, actor/clinic isolation and exact read-only recovery. Unit evidence only.');
