import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../pharmacy.js', import.meta.url), 'utf8');
const start = source.indexOf('  function renderPrescriptionQueue()');
const end = source.indexOf('  function prescription(id)', start);
assert.ok(start > -1 && end > start, 'renderPrescriptionQueue must remain extractable');
const renderSource = source.slice(start, end);

const rxList = { innerHTML: '' };
const data = {
  products: [{ id: 'product-a', sku: 'RX-A', name_th: 'ยาสังเคราะห์' }],
  patients: [{ id: 'patient-a', hn: 'SYNTHETIC-E2E', prefix: '', first_name: 'ทดสอบ', last_name: 'เท่านั้น' }],
  prescriptions: [
    { id: 'rx-own', patient_id: 'patient-a', prescription_no: 'RX-OWN' },
    { id: 'rx-other', patient_id: 'patient-a', prescription_no: 'RX-OTHER' },
    { id: 'rx-unpriced', patient_id: 'patient-a', prescription_no: 'RX-UNPRICED' }
  ],
  dispensing: [
    { id: 'order-own', prescription_id: 'rx-own', queue_number: 'Q-1', status: 'reviewed', reviewed_by: 'reviewer-a' },
    { id: 'order-other', prescription_id: 'rx-other', queue_number: 'Q-2', status: 'reviewed', reviewed_by: 'reviewer-b' },
    { id: 'order-unpriced', prescription_id: 'rx-unpriced', queue_number: 'Q-3', status: 'reviewed', reviewed_by: 'reviewer-b' }
  ],
  prescriptionItems: [
    { id: 'item-own', prescription_id: 'rx-own', product_id: 'product-a', quantity_prescribed: 2, unit: 'ขวด' },
    { id: 'item-other', prescription_id: 'rx-other', product_id: 'product-a', quantity_prescribed: 1, unit: 'ขวด' },
    { id: 'item-unpriced', prescription_id: 'rx-unpriced', product_id: 'product-missing', quantity_prescribed: 1, unit: 'ขวด' }
  ],
  dispensingItems: [],
  productPrices: [{ product_id: 'product-a', unit_price: 650, currency: 'THB', active: true, effective_to: null }],
  dispensingEvents: [{
    dispensing_order_id: 'order-own',
    from_status: 'waiting',
    to_status: 'reviewed',
    actor_id: '12345678-aaaa-4000-8000-000000000001',
    actor_role: 'pharmacy',
    reason: 'Synthetic review',
    created_at: '2026-10-08T12:00:00Z'
  }]
};

const sandbox = vm.createContext({
  data,
  session: { user: { id: 'reviewer-a' } },
  $: selector => {
    assert.equal(selector, '#rx-list');
    return rxList;
  },
  product: id => data.products.find(item => item.id === id),
  patient: id => data.patients.find(item => item.id === id),
  patientName: item => item ? `${item.prefix || ''}${item.first_name || ''} ${item.last_name || ''}`.trim() : '',
  num: value => Number(value || 0),
  money: value => Number(value || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  esc: value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]))
});

vm.runInContext(`${renderSource}\nrenderPrescriptionQueue();`, sandbox);

assert.match(rxList.innerHTML, /ราคากลาง ฿650\.00\/ขวด/);
assert.match(rxList.innerHTML, /ฐานข้อมูลเป็นผู้กำหนดราคา/);
assert.match(rxList.innerHTML, /รอบัญชีผู้จ่ายยาอีกคน/);
assert.match(rxList.innerHTML, /data-act="rx-dispense" data-id="order-other"/);
assert.doesNotMatch(rxList.innerHTML, /data-act="rx-dispense" data-id="order-own"/);
assert.match(rxList.innerHTML, /รอ Price Master/);
assert.doesNotMatch(rxList.innerHTML, /data-act="rx-dispense" data-id="order-unpriced"/);
assert.match(rxList.innerHTML, /waiting → reviewed/);
assert.match(rxList.innerHTML, /pharmacy • 12345678/);
assert.doesNotMatch(rxList.innerHTML, /<input[^>]+data-rx-price/);

console.log('Pharmacy queue account separation passed: governed price, distinct dispenser control and actor transition history render fail-closed.');
