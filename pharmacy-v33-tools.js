(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
  const num = value => Number(value || 0);
  const clinicBrand = () => window.CLINICAL_OS_CONFIG?.brand || {};
  const PRINT_LIBRARY_INTEGRITY = Object.freeze({
    'https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js': 'sha384-Kk5SjBOKprEnGfyBWfD2zROFd1Cu8kwOXxG2GIhYPcoDL2rBJS9P8Ud1ZMy4412a',
    'https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js': 'sha384-3zSEDfvllQohrq0PHL1fOXJuC/jSOO34H46t6UQfobFOmxE5BpjjaIJY5F2/bMnU'
  });

  let db = null;
  let session = null;
  let timer = null;

  async function waitRuntime() {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (window.ChananyaRuntime) return window.ChananyaRuntime;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('ChananyaRuntime ไม่พร้อมใช้งาน');
  }

  function addButton(card, key, label, handler) {
    if (!card || card.querySelector(`[data-v33-id="${key}"]`)) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn ghost';
    button.dataset.v33Id = key;
    button.textContent = label;
    button.addEventListener('click', event => {
      event.stopPropagation();
      handler().catch(error => {
        console.error(error);
        alert(error.message || String(error));
      });
    });
    (card.querySelector('.right') || card).appendChild(button);
  }

  async function loadOrder(orderId) {
    const orderResult = await db.from('dispensing_orders').select('*').eq('id', orderId).single();
    if (orderResult.error) throw orderResult.error;
    const prescriptionResult = await db.from('prescriptions').select('*').eq('id', orderResult.data.prescription_id).single();
    if (prescriptionResult.error) throw prescriptionResult.error;

    const [patientResult, itemsResult, dispensingResult] = await Promise.all([
      db.from('patients').select('*').eq('id', prescriptionResult.data.patient_id).single(),
      db.from('prescription_items').select('*').eq('prescription_id', prescriptionResult.data.id),
      db.from('dispensing_items').select('*').eq('dispensing_order_id', orderId)
    ]);
    [patientResult, itemsResult, dispensingResult].forEach(result => {
      if (result.error) throw result.error;
    });

    const productIds = [...new Set((itemsResult.data || []).map(item => item.product_id).filter(Boolean))];
    const lotIds = [...new Set((dispensingResult.data || []).map(item => item.inventory_lot_id).filter(Boolean))];
    const [productsResult, lotsResult] = await Promise.all([
      productIds.length
        ? db.from('products').select('*').in('id', productIds)
        : Promise.resolve({ data: [], error: null }),
      lotIds.length
        ? db.from('inventory_lots').select('*').in('id', lotIds)
        : Promise.resolve({ data: [], error: null })
    ]);
    if (productsResult.error) throw productsResult.error;
    if (lotsResult.error) throw lotsResult.error;

    return {
      order: orderResult.data,
      rx: prescriptionResult.data,
      patient: patientResult.data,
      items: itemsResult.data || [],
      dispensing: dispensingResult.data || [],
      products: productsResult.data || [],
      lots: lotsResult.data || []
    };
  }

  function openPrintWindow({ title, body, styles, width = 900, afterOpen }) {
    const printWindow = window.open('', '_blank', `width=${width},height=900`);
    if (!printWindow) {
      alert('กรุณาอนุญาต Pop-up เพื่อพิมพ์เอกสาร');
      return null;
    }
    printWindow.opener = null;
    printWindow.document.write(`<!doctype html><html lang="th"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${styles}</style></head><body>${body}<button type="button" data-print>พิมพ์</button></body></html>`);
    printWindow.document.close();
    printWindow.document.querySelector('[data-print]')?.addEventListener('click', () => printWindow.print());
    afterOpen?.(printWindow);
    return printWindow;
  }

  async function printPrescription(orderId) {
    const data = await loadOrder(orderId);
    const patientName = `${data.patient.prefix || ''}${data.patient.first_name || ''} ${data.patient.last_name || ''}`.trim();
    const rows = data.items.map((item, index) => {
      const product = data.products.find(candidate => candidate.id === item.product_id);
      const allocations = data.dispensing.filter(candidate => candidate.prescription_item_id === item.id);
      const lots = allocations
        .map(allocation => data.lots.find(lot => lot.id === allocation.inventory_lot_id)?.lot_number)
        .filter(Boolean)
        .join(', ');
      const dispensedQuantity = allocations.reduce((total, allocation) => total + num(allocation.quantity_dispensed), 0);
      return `<tr><td>${index + 1}</td><td><b>${esc(product?.name_th || product?.sku || 'ยา/สมุนไพร')}</b></td><td>${esc(item.quantity_prescribed ?? '-')} ${esc(item.unit || '')}</td><td>${esc(item.dose || '')} ${esc(item.frequency || '')} ${esc(item.duration || '')}</td><td>${esc(item.instructions || '')}</td><td>${dispensedQuantity || '-'}</td><td>${esc(lots || '-')}</td></tr>`;
    }).join('');
    const brand = clinicBrand();
    const body = `<div class="head"><div><h1>${esc(brand.shortName || 'CLINIC')}</h1><div>${esc(brand.nameEn || brand.nameTh || brand.productName || 'Clinical & Wellness OS')}</div></div><div><b>ใบสั่งยา / PRESCRIPTION</b><br>${esc(data.rx.prescription_no || '-')}</div></div><div class="meta"><div><b>ผู้รับบริการ:</b> ${esc(patientName)}</div><div><b>HN:</b> ${esc(data.patient.hn || '-')}</div><div><b>วันที่สั่ง:</b> ${data.rx.prescribed_at ? new Date(data.rx.prescribed_at).toLocaleString('th-TH') : '-'}</div><div><b>สถานะ Pharmacy:</b> ${esc(data.order.status || '-')}</div></div><table><thead><tr><th>#</th><th>รายการยา</th><th>จำนวนสั่ง</th><th>วิธีใช้</th><th>คำแนะนำ</th><th>จ่ายจริง</th><th>Lot</th></tr></thead><tbody>${rows}</tbody></table><div class="status">Printed ${new Date().toLocaleString('th-TH')} • Ref ${esc(data.rx.prescription_no || '-')}</div><div class="sign"><div class="line">ผู้สั่งยา / Practitioner</div><div class="line">ผู้จ่ายยา / Pharmacist</div></div>`;
    const styles = '@page{size:A4;margin:12mm}body{font-family:Arial,"Noto Sans Thai",sans-serif;color:#111}h1{font-size:20px;margin:0}.head{display:flex;justify-content:space-between;border-bottom:2px solid #173f31;padding-bottom:10px}.meta{margin:12px 0;display:grid;grid-template-columns:1fr 1fr;gap:6px}table{width:100%;border-collapse:collapse;font-size:12px}th,td{border:1px solid #bbb;padding:7px;vertical-align:top}th{background:#f1f5f3}.sign{margin-top:30px;display:grid;grid-template-columns:1fr 1fr;gap:40px}.line{border-top:1px solid #333;padding-top:6px;text-align:center}.status{margin-top:12px;font-size:11px}@media print{button{display:none}}';
    openPrintWindow({ title: data.rx.prescription_no || 'Prescription', body, styles, width: 1000 });
  }

  function loadPrintLibrary(printWindow, source) {
    return new Promise((resolve, reject) => {
      const integrity = PRINT_LIBRARY_INTEGRITY[source];
      if (!integrity) {
        reject(new Error(`Print library is not allowlisted: ${source}`));
        return;
      }
      const script = printWindow.document.createElement('script');
      script.src = source;
      script.integrity = integrity;
      script.crossOrigin = 'anonymous';
      script.referrerPolicy = 'no-referrer';
      script.addEventListener('load', resolve, { once: true });
      script.addEventListener('error', () => reject(new Error(`โหลด print library ไม่สำเร็จ: ${source}`)), { once: true });
      printWindow.document.head.appendChild(script);
    });
  }

  async function printQrLabels(orderId) {
    const data = await loadOrder(orderId);
    const patientName = `${data.patient.prefix || ''}${data.patient.first_name || ''} ${data.patient.last_name || ''}`.trim();
    const labels = data.items.map((item, index) => {
      const product = data.products.find(candidate => candidate.id === item.product_id);
      const allocations = data.dispensing.filter(candidate => candidate.prescription_item_id === item.id);
      const quantity = allocations.length
        ? allocations.reduce((total, allocation) => total + num(allocation.quantity_dispensed), 0)
        : item.quantity_prescribed;
      const lots = allocations.map(allocation => data.lots.find(lot => lot.id === allocation.inventory_lot_id)?.lot_number).filter(Boolean).join(', ');
      const expiry = allocations.map(allocation => data.lots.find(lot => lot.id === allocation.inventory_lot_id)?.expiry_date).filter(Boolean).join(', ');
      const barcode = `${data.rx.prescription_no || 'RX'}-${String(index + 1).padStart(2, '0')}`;
      const qr = `RX=${data.rx.prescription_no || ''};ITEM=${index + 1};LOT=${lots || ''}`;
      return `<section class="label"><div class="clinic">${esc(clinicBrand().shortName || clinicBrand().nameEn || 'CLINIC')}</div><div class="patient">${esc(patientName)} ${data.patient.hn ? `• HN ${esc(data.patient.hn)}` : ''}</div><div class="drug">${esc(product?.name_th || product?.sku || 'ยา/สมุนไพร')}</div><div class="directions">${esc(quantity ?? '-')} ${esc(item.unit || '')} • ${esc(item.dose || '')} ${esc(item.frequency || '')} ${esc(item.duration || '')}</div>${item.instructions ? `<div class="warning">${esc(item.instructions)}</div>` : ''}<div class="codes"><svg class="barcode" data-code="${esc(barcode)}"></svg><div class="qr" data-qr="${esc(qr)}"></div></div><div class="meta">Lot ${esc(lots || '-')} • EXP ${esc(expiry || '-')}<br>Ref ${esc(data.rx.prescription_no || '-')}</div></section>`;
    }).join('');
    const styles = '@page{size:60mm 40mm;margin:1.5mm}*{box-sizing:border-box}body{margin:0;font-family:Arial,"Noto Sans Thai",sans-serif}.label{width:57mm;height:37mm;border:1px solid #222;padding:1.6mm;page-break-after:always;overflow:hidden}.clinic{font-size:8pt;font-weight:800}.patient{font-size:7.7pt;font-weight:700}.drug{font-size:10pt;font-weight:800}.directions,.warning{font-size:7.4pt}.warning{font-weight:700}.codes{display:flex;align-items:center;gap:2mm;margin-top:.8mm}.barcode{width:31mm;height:8mm}.qr{width:9mm;height:9mm}.qr img,.qr canvas{width:9mm!important;height:9mm!important}.meta{font-size:6.5pt}@media print{button{display:none}}';
    openPrintWindow({
      title: 'QR Labels',
      body: labels,
      styles,
      afterOpen: async printWindow => {
        try {
          await loadPrintLibrary(printWindow, 'https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js');
          await loadPrintLibrary(printWindow, 'https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js');
          printWindow.document.querySelectorAll('.barcode').forEach(element => {
            printWindow.JsBarcode(element, element.dataset.code, { format: 'CODE128', displayValue: false, margin: 0, height: 24 });
          });
          printWindow.document.querySelectorAll('.qr').forEach(element => {
            new printWindow.QRCode(element, { text: element.dataset.qr, width: 60, height: 60, correctLevel: printWindow.QRCode.CorrectLevel.M });
          });
        } catch (error) {
          console.error(error);
          alert(error.message || String(error));
        }
      }
    });
  }

  async function enhance() {
    const list = $('#rx-list');
    if (!list || !db) return;
    $$('[data-dispensing-order-id]', list).forEach(card => {
      const id = card.dataset.dispensingOrderId;
      addButton(card, `rxprint-${id}`, 'พิมพ์ใบสั่งยา', () => printPrescription(id));
      addButton(card, `qr-${id}`, 'ฉลาก QR/Barcode', () => printQrLabels(id));
    });
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => enhance().catch(console.error), 120);
  }

  async function init() {
    const runtime = await waitRuntime();
    db = runtime.getDb();
    session = await runtime.getSession();
    if (!session) return;
    await enhance();
  }

  window.addEventListener('chananya:pharmacy-rendered', schedule);
  window.addEventListener('load', () => init().catch(error => console.error('Pharmacy v3.3 tools failed', error)));
})();
