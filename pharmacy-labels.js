(() => {
  'use strict';

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  let db = null;
  let session = null;
  let enhancing = false;
  let timer = null;

  const esc = v => String(v ?? '').replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
  const num = v => Number(v || 0);

  async function waitRuntime() {
    for (let i = 0; i < 50; i++) {
      if (window.ChananyaRuntime) return window.ChananyaRuntime;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('ChananyaRuntime ไม่พร้อมใช้งาน');
  }

  function labelWindow(title, labels) {
    const w = window.open('', '_blank', 'width=850,height=900');
    if (!w) { alert('Browser ปิดกั้นหน้าต่างพิมพ์ กรุณาอนุญาต Pop-up'); return; }
    w.document.write(`<!doctype html><html lang="th"><head><meta charset="utf-8"><title>${esc(title)}</title><style>@page{size:60mm 40mm;margin:1.5mm}*{box-sizing:border-box}body{margin:0;font-family:Arial,"Noto Sans Thai",sans-serif;color:#111}.label{width:57mm;min-height:37mm;border:1px solid #222;padding:2.2mm;page-break-after:always;position:relative;overflow:hidden}.label:last-of-type{page-break-after:auto}.clinic{font-size:10pt;font-weight:800;border-bottom:1px solid #333;padding-bottom:1mm;margin-bottom:1mm}.patient{font-size:9pt;font-weight:700}.drug{font-size:12pt;font-weight:800;margin:1mm 0}.directions{font-size:9pt;line-height:1.25}.meta{font-size:7.2pt;line-height:1.2;margin-top:1mm}.warning{font-size:7.5pt;font-weight:700;margin-top:1mm}button{margin:10px;padding:8px 16px}@media print{button{display:none}}</style></head><body>${labels.join('')}<button onclick="print()">พิมพ์ฉลาก</button></body></html>`);
    w.document.close();
  }

  function labelHtml({ patientName, hn, medicine, quantity, unit, dose, frequency, duration, instructions, lot, expiry, reference, pharmacist }) {
    return `<section class="label"><div class="clinic">CHANANYA THAI TRADITIONAL MEDICINE & WELLNESS CLINIC</div><div class="patient">${esc(patientName || 'ผู้รับบริการทั่วไป')} ${hn ? `• HN ${esc(hn)}` : ''}</div><div class="drug">${esc(medicine || 'ยา/สมุนไพร')}</div><div class="directions">จำนวน ${esc(quantity ?? '-')} ${esc(unit || '')}<br>${dose ? `ครั้งละ ${esc(dose)}` : ''} ${frequency ? `• ${esc(frequency)}` : ''} ${duration ? `• ${esc(duration)}` : ''}</div>${instructions ? `<div class="warning">${esc(instructions)}</div>` : ''}<div class="meta">Lot ${esc(lot || '-')} • EXP ${esc(expiry || '-')}<br>Ref ${esc(reference || '-')} • ผู้จ่าย ${esc(pharmacist || '-')}<br>วันที่ ${new Date().toLocaleDateString('th-TH')}</div></section>`;
  }

  async function printDoctorLabels(orderId) {
    const orderResult = await db.from('dispensing_orders').select('*').eq('id', orderId).single();
    if (orderResult.error) throw orderResult.error;
    const order = orderResult.data;
    const rxResult = await db.from('prescriptions').select('*').eq('id', order.prescription_id).single();
    if (rxResult.error) throw rxResult.error;
    const rx = rxResult.data;
    const [patientResult, itemsResult, dispensedResult] = await Promise.all([
      db.from('patients').select('*').eq('id', rx.patient_id).single(),
      db.from('prescription_items').select('*').eq('prescription_id', rx.id),
      db.from('dispensing_items').select('*').eq('dispensing_order_id', orderId)
    ]);
    if (patientResult.error) throw patientResult.error;
    if (itemsResult.error) throw itemsResult.error;
    if (dispensedResult.error) throw dispensedResult.error;
    const patient = patientResult.data;
    const items = itemsResult.data || [];
    const dispensed = dispensedResult.data || [];
    const productIds = [...new Set(items.map(i => i.product_id).filter(Boolean))];
    const lotIds = [...new Set(dispensed.map(i => i.inventory_lot_id).filter(Boolean))];
    const [productsResult, lotsResult] = await Promise.all([
      productIds.length ? db.from('products').select('*').in('id', productIds) : Promise.resolve({ data: [], error: null }),
      lotIds.length ? db.from('inventory_lots').select('*').in('id', lotIds) : Promise.resolve({ data: [], error: null })
    ]);
    if (productsResult.error) throw productsResult.error;
    if (lotsResult.error) throw lotsResult.error;
    const products = productsResult.data || [];
    const lots = lotsResult.data || [];
    const labels = items.map(item => {
      const product = products.find(p => p.id === item.product_id);
      const allocations = dispensed.filter(d => d.prescription_item_id === item.id);
      const quantity = allocations.length ? allocations.reduce((sum, d) => sum + num(d.quantity_dispensed), 0) : item.quantity_prescribed;
      const lotText = allocations.map(d => lots.find(l => l.id === d.inventory_lot_id)?.lot_number).filter(Boolean).join(', ');
      const expiryText = allocations.map(d => lots.find(l => l.id === d.inventory_lot_id)?.expiry_date).filter(Boolean).join(', ');
      return labelHtml({
        patientName: `${patient.prefix || ''}${patient.first_name || ''} ${patient.last_name || ''}`.trim(),
        hn: patient.hn,
        medicine: product?.name_th || product?.sku || 'ยา/สมุนไพร',
        quantity,
        unit: item.unit,
        dose: item.dose,
        frequency: item.frequency,
        duration: item.duration,
        instructions: item.instructions,
        lot: lotText,
        expiry: expiryText,
        reference: rx.prescription_no,
        pharmacist: session?.user?.email
      });
    });
    labelWindow(`ฉลาก ${rx.prescription_no}`, labels);
  }

  async function printWalkinLabels(saleId) {
    const saleResult = await db.from('pharmacy_counter_sales').select('*').eq('id', saleId).single();
    if (saleResult.error) throw saleResult.error;
    const sale = saleResult.data;
    const itemsResult = await db.from('pharmacy_counter_sale_items').select('*').eq('sale_id', saleId);
    if (itemsResult.error) throw itemsResult.error;
    const items = itemsResult.data || [];
    const productIds = [...new Set(items.map(i => i.product_id).filter(Boolean))];
    const productsResult = productIds.length ? await db.from('products').select('*').in('id', productIds) : { data: [], error: null };
    if (productsResult.error) throw productsResult.error;
    const products = productsResult.data || [];
    const labels = items.map(item => {
      const product = products.find(p => p.id === item.product_id);
      return labelHtml({
        patientName: sale.customer_name || 'Walk-in',
        medicine: product?.name_th || product?.sku || 'ยา/สมุนไพร',
        quantity: item.quantity_dispensed || item.quantity_requested,
        unit: item.unit,
        dose: item.dose,
        frequency: item.frequency,
        duration: item.duration,
        instructions: item.instructions || sale.advice,
        lot: item.lot_number || '-',
        expiry: item.expiry_date || '-',
        reference: sale.sale_no,
        pharmacist: session?.user?.email
      });
    });
    labelWindow(`ฉลาก ${sale.sale_no}`, labels);
  }

  function addButton(container, id, text, handler) {
    if (!container || container.querySelector(`[data-label-id="${id}"]`)) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn ghost';
    button.dataset.labelId = id;
    button.textContent = text;
    button.addEventListener('click', event => {
      event.stopPropagation();
      handler().catch(error => { console.error(error); alert(error?.message || String(error)); });
    });
    const target = container.querySelector('.right') || container;
    target.appendChild(button);
  }

  async function enhanceDoctorQueue() {
    const list = $('#rx-list');
    if (!list) return;
    const result = await db.from('dispensing_orders').select('id,status').in('status', ['dispensed','submitted_to_billing','billed']);
    if (result.error) throw result.error;
    const allowed = new Set((result.data || []).map(x => x.id));
    $$('[data-dispensing-order-id]', list).forEach(card => {
      const orderId = card.dataset.dispensingOrderId;
      if (!allowed.has(orderId)) return;
      addButton(card, `rx-${orderId}`, 'พิมพ์ฉลากยา', () => printDoctorLabels(orderId));
    });
  }

  async function enhanceWalkinQueue() {
    const list = $('#walkin-list');
    if (!list) return;
    const result = await db.from('pharmacy_counter_sales').select('id,status').in('status', ['dispensed','submitted_to_billing']);
    if (result.error) throw result.error;
    const allowed = new Set((result.data || []).map(x => x.id));
    $$('[data-sale-id]', list).forEach(card => {
      const saleId = card.dataset.saleId;
      if (!allowed.has(saleId)) return;
      addButton(card, `walkin-${saleId}`, 'พิมพ์ฉลากยา', () => printWalkinLabels(saleId));
    });
  }

  async function enhance() {
    if (enhancing || !db) return;
    enhancing = true;
    try { await Promise.all([enhanceDoctorQueue(), enhanceWalkinQueue()]); }
    finally { enhancing = false; }
  }

  function scheduleEnhance() { clearTimeout(timer); timer = setTimeout(() => enhance().catch(console.error), 150); }

  async function install() {
    const R = await waitRuntime();
    db = R.getDb();
    session = await R.getSession();
    if (!session) return;
    await enhance();
  }

  window.addEventListener('chananya:pharmacy-rendered', scheduleEnhance);
  window.addEventListener('load', () => install().catch(error => console.error('Pharmacy label extension failed', error)));
})();
