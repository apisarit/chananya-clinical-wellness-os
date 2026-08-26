(() => {
  'use strict';

  const LOCK_MS = 15 * 60 * 1000;
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const num = value => Number(value || 0);
  const today = () => new Date().toISOString().slice(0, 10);
  const money = value => num(value).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

  let db;
  let session;
  let profile;
  let role = 'viewer';
  let lockTimer;
  let patientFilter = '';
  let editingPatientId = null;
  const data = {
    patients: [], allergies: [], appointments: [], encounters: [], prescriptions: [],
    dispensing: [], dispensingItems: [], rxItems: [], products: [], invoices: [], payments: [], audit: []
  };

  const viewPermissions = {
    super_admin: ['all'], admin: ['all'], practitioner: ['patients'], doctor: ['patients'],
    reception: ['patients'], billing: ['billing'], pharmacy: [], production: [], inventory: [], viewer: []
  };

  const canView = permission => (viewPermissions[role] || []).includes('all') || (viewPermissions[role] || []).includes(permission);

  function toast(message) {
    const element = $('#toast');
    element.textContent = message;
    element.classList.add('show');
    setTimeout(() => element.classList.remove('show'), 2400);
  }

  function fail(error) {
    console.error(error);
    alert(error?.message || String(error));
  }

  function patient(id) { return data.patients.find(item => item.id === id); }
  function patientName(id) {
    const item = patient(id);
    return item ? `${item.prefix || ''}${item.first_name} ${item.last_name}`.trim() : '-';
  }
  function product(id) { return data.products.find(item => item.id === id); }
  function prescriptionFor(order) { return data.prescriptions.find(item => item.id === order?.prescription_id); }
  function encounterFor(prescription) { return data.encounters.find(item => item.id === prescription?.encounter_id); }

  async function audit(action, entity, entityId, metadata = {}) {
    try {
      await db.from('audit_logs').insert({ user_id: session.user.id, action, entity, entity_id: entityId || null, metadata: { ...metadata, role } });
    } catch (error) {
      console.warn('Audit write failed', error);
    }
  }

  async function query(table, select = '*', order) {
    let request = db.from(table).select(select);
    if (order) request = request.order(order, { ascending: false });
    const result = await request;
    if (result.error) throw result.error;
    return result.data || [];
  }

  async function optionalQuery(table, select = '*', order) {
    try { return await query(table, select, order); }
    catch (error) { console.warn(`Optional table unavailable: ${table}`, error); return []; }
  }

  async function loadAll() {
    const rows = await Promise.all([
      optionalQuery('patients', '*', 'created_at'),
      optionalQuery('patient_allergies'),
      optionalQuery('appointments'),
      optionalQuery('encounters', '*', 'started_at'),
      optionalQuery('prescriptions', '*', 'prescribed_at'),
      optionalQuery('dispensing_orders', '*', 'created_at'),
      optionalQuery('dispensing_items'),
      optionalQuery('prescription_items'),
      optionalQuery('products', '*'),
      optionalQuery('invoices', '*', 'created_at'),
      optionalQuery('payments'),
      ['admin', 'super_admin'].includes(role) ? optionalQuery('audit_logs', '*', 'created_at') : Promise.resolve([])
    ]);
    [data.patients, data.allergies, data.appointments, data.encounters, data.prescriptions, data.dispensing,
      data.dispensingItems, data.rxItems, data.products, data.invoices, data.payments, data.audit] = rows;
    render();
  }

  function options(rows, label) {
    return '<option value="">เลือก</option>' + rows.map(item => `<option value="${item.id}">${esc(label(item))}</option>`).join('');
  }

  function show(view) {
    $$('.view').forEach(element => element.classList.toggle('active', element.id === view));
    $$('#main-nav button').forEach(button => button.classList.toggle('active', button.dataset.view === view));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function applyRole() {
    window.ChananyaShell?.mount({ profile, session, active: 'operations' });
    $$('[data-perm]').forEach(element => element.classList.toggle('hidden', !canView(element.dataset.perm)));
    const titles = {
      super_admin: 'ภาพรวมทั้ง Clinical OS', admin: 'ภาพรวมและงานควบคุม', practitioner: 'งานคลินิกที่รอดำเนินการ',
      doctor: 'งานคลินิกที่รอดำเนินการ', reception: 'ผู้รับบริการและคิวนัดหมาย', pharmacy: 'คิวห้องยาและการผลิต',
      production: 'งานผลิตและวัตถุดิบ', inventory: 'คลังและวัตถุดิบ', billing: 'งานการเงินที่รอดำเนินการ', viewer: 'ภาพรวมแบบอ่านอย่างเดียว'
    };
    $('#workspace-title').textContent = titles[role] || titles.viewer;
    show(role === 'billing' ? 'billing' : 'dashboard');
  }

  function render() {
    const openInvoices = data.invoices.filter(invoice => num(invoice.balance_due) > 0 && !['void', 'cancelled'].includes(invoice.status));
    $('#pay-invoice').innerHTML = options(openInvoices, invoice => `${invoice.invoice_number} — ${patientName(invoice.patient_id)} — ฿${money(invoice.balance_due)}`);
    $('#stat-p').textContent = data.patients.length;
    $('#stat-a').textContent = data.appointments.filter(item => item.appointment_date === today()).length;
    $('#stat-d').textContent = data.encounters.filter(item => !['closed', 'cancelled'].includes(item.status)).length;
    $('#stat-rx').textContent = data.dispensing.filter(item => !['submitted_to_billing', 'billed', 'cancelled', 'rejected'].includes(item.status)).length;
    $('#stat-b').textContent = billingOrders().length;
    renderPatients();
    renderBilling();
    renderDashboard();
    renderAudit();
    bindActions();
  }

  function activeAllergies(patientId) {
    return data.allergies.filter(item => item.patient_id === patientId && item.status === 'active');
  }

  function renderPatients() {
    const term = patientFilter.trim().toLowerCase();
    const rows = data.patients.filter(item => {
      const allergies = activeAllergies(item.id).map(allergy => allergy.allergen_name).join(' ');
      return !term || [item.hn, patientName(item.id), item.phone, allergies].some(value => String(value || '').toLowerCase().includes(term));
    });
    $('#patient-list').innerHTML = rows.slice(0, 200).map(item => {
      const allergies = activeAllergies(item.id);
      return `<article class="item"><div><b>${esc(item.hn)} • ${esc(patientName(item.id))}</b><small>${esc(item.phone || 'ไม่มีโทรศัพท์')}${allergies.length ? ` • แพ้: ${esc(allergies.map(allergy => allergy.allergen_name).join(', '))}` : ''}</small></div><div class="actions"><span class="badge">${esc(item.payment_right || 'ทั่วไป')}</span>${canView('patients') ? `<button class="btn ghost" data-edit-patient="${esc(item.id)}">แก้ไข</button>` : ''}</div></article>`;
    }).join('') || '<p class="muted">ไม่พบผู้รับบริการ</p>';
  }

  function billingOrders() { return data.dispensing.filter(order => order.status === 'submitted_to_billing'); }

  function renderBilling() {
    $('#billing-queue').innerHTML = billingOrders().map(order => {
      const prescription = prescriptionFor(order);
      const encounter = encounterFor(prescription);
      const dispensed = data.dispensingItems.filter(item => item.dispensing_order_id === order.id);
      const medicine = dispensed.reduce((sum, item) => sum + num(item.quantity_dispensed) * num(item.unit_price), 0);
      return `<article class="item column"><div class="row"><div><b>${esc(order.queue_number || '-')} • ${esc(patientName(prescription?.patient_id))}</b><small>${esc(encounter?.encounter_no || '-')} • ค่ายาที่จ่ายจริง ฿${money(medicine)}</small></div><span class="badge">พร้อมออก Invoice</span></div><div class="form"><label>ค่าบริการจริง<input data-service-fee="${order.id}" type="number" min="0" step=".01" value="0"></label><label>ส่วนลด<input data-discount="${order.id}" type="number" min="0" step=".01" value="0"></label><button class="btn primary full" data-action="invoice" data-id="${order.id}">สร้าง Invoice</button></div></article>`;
    }).join('') || '<p class="muted">ไม่มีรายการรอออก Invoice</p>';

    $('#invoice-list').innerHTML = data.invoices.map(invoice => `<article class="item"><div><b>${esc(invoice.invoice_number)} • ${esc(patientName(invoice.patient_id))}</b><small>รวม ฿${money(invoice.grand_total)} • ชำระ ฿${money(invoice.paid_amount)} • คงเหลือ ฿${money(invoice.balance_due)}</small></div><span class="badge">${esc(invoice.status)}</span></article>`).join('') || '<p class="muted">ยังไม่มี Invoice</p>';
  }

  function renderDashboard() {
    const shell = window.ChananyaShell?.mount({ profile, session, active: 'operations' });
    const routeNames = { appointments: 'จัดการนัดหมาย', clinical: 'เปิดเวชระเบียน', pharmacy: 'ไปห้องยา', production: 'ดูงานผลิต', admin: 'ศูนย์ควบคุม' };
    $('#quick-actions').innerHTML = (shell?.visibleRoutes || []).filter(route => route.key !== 'operations').map(route => `<a class="item" href="${route.href}"><div><b>${esc(routeNames[route.key] || route.label)}</b><small>${esc(route.note)}</small></div><span class="badge">เปิด →</span></a>`).join('') || '<p class="muted">ไม่มี workstation เพิ่มเติมสำหรับสิทธิ์นี้</p>';

    const work = [];
    if (window.ChananyaRuntime.can(profile, 'appointments_view')) {
      work.push(...data.appointments.filter(item => item.appointment_date === today()).slice(0, 4).map(item => `<article class="item"><div><b>นัด ${esc(item.appointment_time || '')}</b><small>${esc(patientName(item.patient_id))}</small></div><span class="badge">นัดหมาย</span></article>`));
    }
    if (window.ChananyaRuntime.can(profile, 'clinical_read')) {
      work.push(...data.encounters.filter(item => !['closed', 'cancelled'].includes(item.status)).slice(0, 4).map(item => `<a class="item" href="/clinical-v3.html?encounter=${encodeURIComponent(item.id)}"><div><b>${esc(item.encounter_no || '-')}</b><small>${esc(patientName(item.patient_id))} • ${esc(item.chief_complaint || 'ยังไม่มีอาการสำคัญ')}</small></div><span class="badge">เวชระเบียน</span></a>`));
    }
    if (window.ChananyaRuntime.can(profile, 'pharmacy_operate')) {
      work.push(...data.dispensing.filter(item => !['submitted_to_billing', 'billed', 'cancelled'].includes(item.status)).slice(0, 4).map(item => `<a class="item" href="/pharmacy.html"><div><b>${esc(item.queue_number || '-')}</b><small>${esc(patientName(prescriptionFor(item)?.patient_id))}</small></div><span class="badge">${esc(item.status)}</span></a>`));
    }
    if (canView('billing')) {
      work.push(...billingOrders().slice(0, 4).map(item => `<button class="item" data-go-view="billing"><div><b>${esc(item.queue_number || '-')}</b><small>${esc(patientName(prescriptionFor(item)?.patient_id))}</small></div><span class="badge">การเงิน</span></button>`));
    }
    $('#work-list').innerHTML = work.join('') || '<p class="muted">ไม่มีงานค้างในขอบเขตสิทธิ์นี้</p>';
  }

  function renderAudit() {
    $('#audit-list').innerHTML = data.audit.slice(0, 100).map(item => `<article class="item audit-item"><div><b>${esc(item.action)} • ${esc(item.entity)}</b><small>${new Date(item.created_at).toLocaleString('th-TH')} • ${esc(item.user_id || '-')}</small></div></article>`).join('') || '<p class="muted">ไม่มีข้อมูลหรือไม่มีสิทธิ์</p>';
  }

  function bindActions() {
    $$('[data-action="invoice"]').forEach(button => { button.onclick = () => createInvoice(button.dataset.id).catch(fail); });
    $$('[data-go-view]').forEach(button => { button.onclick = () => show(button.dataset.goView); });
  }

  function resetPatientForm() {
    editingPatientId = null;
    $('#patient-form').reset();
    $('#patient-submit').textContent = 'บันทึกผู้รับบริการ';
    $('#patient-cancel').classList.add('hidden');
  }

  function beginPatientEdit(patientId) {
    const item = patient(patientId);
    if (!item) return;
    editingPatientId = patientId;
    $('#p-hn').value = item.hn || '';
    $('#p-prefix').value = item.prefix || '';
    $('#p-first').value = item.first_name || '';
    $('#p-last').value = item.last_name || '';
    $('#p-national').value = item.national_id || '';
    $('#p-gender').value = item.gender || '';
    $('#p-dob').value = item.date_of_birth || '';
    $('#p-phone').value = item.phone || '';
    $('#p-address').value = item.address || '';
    $('#p-right').value = item.payment_right || '';
    $('#p-emergency').value = item.emergency_contact_name || '';
    $('#p-allergy').value = '';
    $('#patient-submit').textContent = 'บันทึกการแก้ไข';
    $('#patient-cancel').classList.remove('hidden');
    $('#patient-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function savePatient(event) {
    event.preventDefault();
    const payload = {
      hn: $('#p-hn').value.trim(), prefix: $('#p-prefix').value.trim() || null,
      first_name: $('#p-first').value.trim(), last_name: $('#p-last').value.trim(),
      national_id: $('#p-national').value.trim() || null, gender: $('#p-gender').value || null,
      date_of_birth: $('#p-dob').value || null, phone: $('#p-phone').value.trim() || null,
      address: $('#p-address').value.trim() || null, payment_right: $('#p-right').value.trim() || null,
      emergency_contact_name: $('#p-emergency').value.trim() || null
    };
    const result = editingPatientId
      ? await db.from('patients').update({ ...payload, updated_at: new Date().toISOString() }).eq('id', editingPatientId).select().single()
      : await db.from('patients').insert({ ...payload, created_by: session.user.id }).select().single();
    if (result.error) throw result.error;
    const allergy = $('#p-allergy').value.trim();
    const alreadyRecorded = activeAllergies(result.data.id).some(item => String(item.allergen_name || '').toLowerCase() === allergy.toLowerCase());
    if (allergy && !alreadyRecorded) {
      const allergyResult = await db.from('patient_allergies').insert({ patient_id: result.data.id, allergen_type: 'other', allergen_name: allergy, status: 'active', created_by: session.user.id });
      if (allergyResult.error) throw allergyResult.error;
    }
    await audit(editingPatientId ? 'update' : 'create', 'patients', result.data.id);
    const wasEditing = Boolean(editingPatientId);
    resetPatientForm();
    await loadAll();
    toast(wasEditing ? 'แก้ไขข้อมูลผู้รับบริการแล้ว' : 'บันทึกผู้รับบริการแล้ว');
  }

  async function createInvoice(orderId) {
    const order = data.dispensing.find(item => item.id === orderId);
    const prescription = prescriptionFor(order);
    const encounter = encounterFor(prescription);
    if (!order || !prescription || !encounter) throw new Error('ข้อมูลใบสั่งยาหรือ Encounter ไม่ครบ');
    if (data.invoices.some(invoice => invoice.encounter_id === encounter.id && !['void', 'cancelled'].includes(invoice.status))) throw new Error('Encounter นี้มี Invoice แล้ว');
    const dispensed = data.dispensingItems.filter(item => item.dispensing_order_id === orderId);
    const medicine = dispensed.reduce((sum, item) => sum + num(item.quantity_dispensed) * num(item.unit_price), 0);
    const serviceFee = num(document.querySelector(`[data-service-fee="${CSS.escape(orderId)}"]`)?.value);
    const discount = num(document.querySelector(`[data-discount="${CSS.escape(orderId)}"]`)?.value);
    const grand = Math.max(0, medicine + serviceFee - discount);
    const invoiceResult = await db.from('invoices').insert({ invoice_number: `INV-${Date.now()}`, patient_id: prescription.patient_id, encounter_id: encounter.id, status: 'issued', subtotal: medicine + serviceFee, discount_total: discount, tax_total: 0, rounding: 0, grand_total: grand, paid_amount: 0, balance_due: grand, issued_at: new Date().toISOString(), created_by: session.user.id }).select().single();
    if (invoiceResult.error) throw invoiceResult.error;
    const lines = [];
    if (serviceFee > 0) lines.push({ invoice_id: invoiceResult.data.id, item_type: 'service', description: 'ค่าตรวจและบริการรักษา', quantity: 1, unit_price: serviceFee, line_total: serviceFee });
    for (const item of dispensed) {
      const prescribed = data.rxItems.find(row => row.id === item.prescription_item_id);
      lines.push({ invoice_id: invoiceResult.data.id, item_type: 'product', product_id: prescribed?.product_id || null, dispensing_item_id: item.id, description: product(prescribed?.product_id)?.name_th || 'ยา/สมุนไพร', quantity: item.quantity_dispensed, unit_price: item.unit_price, line_total: num(item.quantity_dispensed) * num(item.unit_price) });
    }
    if (lines.length) {
      const lineResult = await db.from('invoice_items').insert(lines);
      if (lineResult.error) throw lineResult.error;
    }
    const orderResult = await db.from('dispensing_orders').update({ status: 'billed' }).eq('id', orderId);
    if (orderResult.error) throw orderResult.error;
    await audit('create', 'invoices', invoiceResult.data.id, { orderId });
    await loadAll();
    toast('สร้าง Invoice แล้ว');
  }

  async function savePayment(event) {
    event.preventDefault();
    const invoice = data.invoices.find(item => item.id === $('#pay-invoice').value);
    const amount = num($('#pay-amount').value);
    if (!invoice) throw new Error('ไม่พบ Invoice');
    if (amount > num(invoice.balance_due)) throw new Error('จำนวนรับชำระมากกว่ายอดคงเหลือ');
    const paymentResult = await db.from('payments').insert({ invoice_id: invoice.id, payment_reference: `PAY-${Date.now()}`, provider: 'manual', channel: $('#pay-channel').value, amount, status: 'paid', gateway_transaction_id: $('#pay-note').value || null, paid_at: new Date().toISOString(), received_by: session.user.id }).select().single();
    if (paymentResult.error) throw paymentResult.error;
    const paid = num(invoice.paid_amount) + amount;
    const balance = Math.max(0, num(invoice.grand_total) - paid);
    const status = balance === 0 ? 'paid' : 'partially_paid';
    let result = await db.from('invoices').update({ paid_amount: paid, balance_due: balance, status }).eq('id', invoice.id);
    if (result.error) throw result.error;
    if (balance === 0 && invoice.encounter_id) {
      result = await db.from('encounters').update({ status: 'closed' }).eq('id', invoice.encounter_id);
      if (result.error) throw result.error;
    }
    await audit('payment', 'payments', paymentResult.data.id, { invoice: invoice.id, amount });
    event.target.reset();
    await loadAll();
    toast(balance === 0 ? 'รับชำระและปิด Encounter แล้ว' : 'บันทึกชำระบางส่วนแล้ว');
  }

  function resetLock() {
    clearTimeout(lockTimer);
    lockTimer = setTimeout(() => $('#lock').classList.add('show'), LOCK_MS);
  }

  async function init() {
    try {
      const runtime = window.ChananyaRuntime;
      if (!runtime) throw new Error('ChananyaRuntime ไม่พร้อมใช้งาน');
      db = runtime.getDb();
      session = await runtime.getSession();
      if (!session) { location.replace('/login.html'); return; }
      profile = await runtime.getProfile(session.user.id);
      if (!profile) throw new Error('ไม่พบ Profile');
      role = runtime.roleOf(profile) || 'viewer';
      applyRole();
      $('#app').classList.remove('hidden');
      $('#boot').classList.add('hidden');
      await loadAll();
      resetLock();
    } catch (error) {
      console.error(error);
      $('#boot-error').textContent = error.message;
    }
  }

  $('#main-nav').addEventListener('click', event => {
    const button = event.target.closest('button[data-view]');
    if (button && !button.classList.contains('hidden')) show(button.dataset.view);
  });
  $('#patient-search').addEventListener('input', event => { patientFilter = event.target.value; renderPatients(); });
  $('#patient-list').addEventListener('click', event => {
    const button = event.target.closest('[data-edit-patient]');
    if (button) beginPatientEdit(button.dataset.editPatient);
  });
  $('#patient-form').addEventListener('submit', event => savePatient(event).catch(fail));
  $('#patient-cancel').addEventListener('click', resetPatientForm);
  $('#payment-form').addEventListener('submit', event => savePayment(event).catch(fail));
  $('#logout').addEventListener('click', async () => { await db.auth.signOut(); location.replace('/login.html'); });
  $('#unlock').addEventListener('click', () => { $('#lock').classList.remove('show'); resetLock(); });
  ['click', 'keydown', 'touchstart'].forEach(name => document.addEventListener(name, resetLock, { passive: true }));
  init();
})();
