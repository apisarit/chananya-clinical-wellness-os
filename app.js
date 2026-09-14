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
  let hybridDatabaseReady = false;
  let lineIdentityReady = false;
  let atomicHandoffsReady = false;
  let identityLinkPatientId = null;
  let latestIdentityLinkCode = '';
  let identityLinks = [];
  const data = {
    patients: [], allergies: [], appointments: [], encounters: [], prescriptions: [],
    dispensing: [], dispensingItems: [], rxItems: [], products: [], invoices: [], payments: [], audit: []
  };

  const viewPermissions = {
    super_admin: ['all'], admin: ['audit'], practitioner: ['patients'], doctor: ['patients'],
    reception: ['patients'], billing: ['billing'], pharmacy: [], production: [], inventory: [], quality: [], viewer: []
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
    const runtime = window.ChananyaRuntime;
    const patientAccess = runtime.can(profile, 'patient_registry')
      || runtime.can(profile, 'appointments_view')
      || runtime.can(profile, 'clinical_read')
      || runtime.can(profile, 'pharmacy_operate')
      || runtime.can(profile, 'billing_operate');
    const clinicalAccess = runtime.can(profile, 'clinical_read')
      || runtime.can(profile, 'pharmacy_operate')
      || runtime.can(profile, 'billing_operate');
    const pharmacyAccess = runtime.can(profile, 'pharmacy_operate')
      || runtime.can(profile, 'billing_operate');
    const billingAccess = runtime.can(profile, 'billing_operate');
    const onlyWhen = (allowed, table, select = '*', order) => allowed
      ? optionalQuery(table, select, order)
      : Promise.resolve([]);
    const rows = await Promise.all([
      onlyWhen(patientAccess, 'patients', '*', 'created_at'),
      onlyWhen(runtime.can(profile, 'patient_registry') || runtime.can(profile, 'clinical_read') || runtime.can(profile, 'pharmacy_operate'), 'patient_allergies'),
      onlyWhen(runtime.can(profile, 'appointments_view'), 'appointments'),
      onlyWhen(clinicalAccess || billingAccess, 'encounters', '*', 'started_at'),
      onlyWhen(clinicalAccess || pharmacyAccess || billingAccess, 'prescriptions', '*', 'prescribed_at'),
      onlyWhen(pharmacyAccess || billingAccess, 'dispensing_orders', '*', 'created_at'),
      onlyWhen(pharmacyAccess || billingAccess, 'dispensing_items'),
      onlyWhen(clinicalAccess || pharmacyAccess || billingAccess, 'prescription_items'),
      onlyWhen(clinicalAccess || pharmacyAccess || billingAccess, 'products'),
      onlyWhen(billingAccess, 'invoices', '*', 'created_at'),
      onlyWhen(billingAccess, 'payments'),
      onlyWhen(['admin', 'super_admin'].includes(role), 'audit_logs', '*', 'created_at')
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
      doctor: 'งานคลินิกที่รอดำเนินการ', reception: 'ผู้รับบริการและคิวนัดหมาย', pharmacy: 'คิวห้องยา',
      production: 'งานผลิตและวัตถุดิบ', inventory: 'คลังและวัตถุดิบ', quality: 'งานตรวจรับรองคุณภาพ', billing: 'งานการเงินที่รอดำเนินการ', viewer: 'ภาพรวมแบบอ่านอย่างเดียว'
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
    window.dispatchEvent(new CustomEvent('chananya:operations-rendered'));
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
      const canLink = lineIdentityReady && window.ChananyaRuntime.can(profile, 'patient_identity_link');
      return `<article class="item"><div><b>${esc(item.hn)} • ${esc(patientName(item.id))}</b><small>${esc(item.phone || 'ไม่มีโทรศัพท์')}${allergies.length ? ` • แพ้: ${esc(allergies.map(allergy => allergy.allergen_name).join(', '))}` : ''}</small></div><div class="actions"><span class="badge">${esc(item.payment_right || 'ทั่วไป')}</span>${canLink ? `<button class="btn ghost" data-link-patient="${esc(item.id)}">เชื่อม LINE</button>` : ''}${canView('patients') ? `<button class="btn ghost" data-edit-patient="${esc(item.id)}">แก้ไข</button>` : ''}</div></article>`;
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
    const routeNames = { appointments: 'จัดการนัดหมาย', clinical: 'เปิดเวชระเบียน', pharmacy: 'ไปห้องยา', production: 'ดูงานผลิต', quality: 'ตรวจและปล่อยผ่าน', admin: 'ศูนย์ควบคุม' };
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

  function applyIdentityMode() {
    const hn = $('#p-hn');
    hn.readOnly = true;
    hn.required = false;
    hn.placeholder = hybridDatabaseReady ? 'ระบบออกให้อัตโนมัติเมื่อบันทึก' : 'ต้องเปิด Identity migration ก่อนบันทึก';
    $('#patient-submit').disabled = !hybridDatabaseReady;
    $('#p-hn-note').textContent = hybridDatabaseReady
      ? 'HN ออกโดยฐานข้อมูลและไม่เปลี่ยนเมื่อแก้ไขข้อมูล'
      : 'Identity migration ยังไม่เปิด ระบบแสดงข้อมูลได้แต่หยุดการเขียนเพื่อป้องกัน Patient/Allergy ครึ่งชุด';
  }

  async function detectIdentityBackend() {
    const [databaseResult, serviceResult, handoffResult] = await Promise.all([
      db.rpc('hybrid_patient_identity_healthcheck'),
      fetch('/api/patient-identity', { cache: 'no-store' }).then(response => response.json()).catch(() => null),
      db.rpc('clinical_financial_handoffs_healthcheck')
    ]);
    hybridDatabaseReady = !databaseResult.error
      && Boolean((Array.isArray(databaseResult.data) ? databaseResult.data[0] : databaseResult.data)?.ready);
    lineIdentityReady = hybridDatabaseReady && serviceResult?.enabled === true;
    atomicHandoffsReady = !handoffResult.error
      && Boolean((Array.isArray(handoffResult.data) ? handoffResult.data[0] : handoffResult.data)?.ready);
    applyIdentityMode();
  }

  function requireAtomicHandoffs() {
    if (!atomicHandoffsReady) {
      throw new Error('ฐานข้อมูลยังไม่เปิดใช้ Atomic Clinical/Financial Handoffs จึงหยุดการบันทึกเพื่อป้องกันข้อมูลครึ่งชุด');
    }
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
    if (!hybridDatabaseReady) {
      throw new Error('ฐานข้อมูลยังไม่เปิดใช้ Hybrid Patient Identity จึงหยุดการบันทึกเพื่อป้องกันข้อมูลครึ่งชุด');
    }
    const payload = {
      hn: $('#p-hn').value.trim(), prefix: $('#p-prefix').value.trim() || null,
      first_name: $('#p-first').value.trim(), last_name: $('#p-last').value.trim(),
      national_id: $('#p-national').value.trim() || null, gender: $('#p-gender').value || null,
      date_of_birth: $('#p-dob').value || null, phone: $('#p-phone').value.trim() || null,
      address: $('#p-address').value.trim() || null, payment_right: $('#p-right').value.trim() || null,
      emergency_contact_name: $('#p-emergency').value.trim() || null
    };
    const allergy = $('#p-allergy').value.trim();
    const result = await db.rpc('upsert_patient_registration', {
      p_patient_id: editingPatientId,
      p_prefix: payload.prefix,
      p_first_name: payload.first_name,
      p_last_name: payload.last_name,
      p_national_id: payload.national_id,
      p_gender: payload.gender,
      p_date_of_birth: payload.date_of_birth,
      p_phone: payload.phone,
      p_address: payload.address,
      p_payment_right: payload.payment_right,
      p_emergency_contact_name: payload.emergency_contact_name,
      p_allergy: allergy || null
    });
    if (result.error) throw result.error;
    const savedPatient = Array.isArray(result.data) ? result.data[0] : result.data;
    if (!savedPatient?.id) throw new Error('ฐานข้อมูลไม่ส่งข้อมูลผู้รับบริการกลับมา');
    const wasEditing = Boolean(editingPatientId);
    resetPatientForm();
    await loadAll();
    toast(wasEditing ? 'แก้ไขข้อมูลผู้รับบริการแล้ว' : 'บันทึกผู้รับบริการแล้ว');
  }

  function renderIdentityLinks() {
    const host = $('#identity-existing-links');
    host.replaceChildren();
    if (!identityLinks.length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'ยังไม่มีบัญชี LINE ที่เชื่อมกับผู้รับบริการรายนี้';
      host.append(empty);
      return;
    }
    for (const link of identityLinks) {
      const item = document.createElement('article');
      item.className = 'item';
      const detail = document.createElement('div');
      const title = document.createElement('b');
      title.textContent = link.link_type === 'guardian'
        ? `ผู้ดูแล • ${link.relation_label || 'ไม่ระบุความสัมพันธ์'}`
        : 'บัญชีของผู้รับบริการ';
      const time = document.createElement('small');
      time.textContent = link.status === 'active'
        ? `เชื่อมเมื่อ ${new Date(link.verified_at).toLocaleString('th-TH')}`
        : `ยกเลิกเมื่อ ${new Date(link.revoked_at).toLocaleString('th-TH')}`;
      detail.append(title, time);
      item.append(detail);
      if (link.status === 'active') {
        const revoke = document.createElement('button');
        revoke.type = 'button';
        revoke.className = 'btn danger';
        revoke.dataset.revokeIdentity = link.link_id;
        revoke.textContent = 'ยกเลิก';
        item.append(revoke);
      } else {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = 'ยกเลิกแล้ว';
        item.append(badge);
      }
      host.append(item);
    }
  }

  async function loadIdentityLinks() {
    const result = await db.rpc('list_patient_identity_links', {
      p_patient_id: identityLinkPatientId
    });
    if (result.error) throw result.error;
    identityLinks = result.data || [];
    renderIdentityLinks();
  }

  async function openIdentityLinkDialog(patientId) {
    const item = patient(patientId);
    if (!item || !lineIdentityReady) return;
    identityLinkPatientId = patientId;
    latestIdentityLinkCode = '';
    $('#identity-link-patient').textContent = `${item.hn} • ${patientName(item.id)}`;
    $('#identity-link-form').reset();
    $('#identity-link-relation').disabled = true;
    $('#identity-link-relation').required = false;
    $('#identity-revoke-form').reset();
    $('#identity-revoke-form').classList.add('hidden');
    $('#identity-existing-links').innerHTML = '<p class="muted">กำลังตรวจสอบ…</p>';
    $('#identity-link-result').classList.add('hidden');
    const dialog = $('#identity-link-dialog');
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    await loadIdentityLinks();
  }

  function beginIdentityRevocation(linkId) {
    const link = identityLinks.find(item => item.link_id === linkId && item.status === 'active');
    if (!link) return;
    $('#identity-revoke-id').value = linkId;
    $('#identity-revoke-summary').textContent = link.link_type === 'guardian'
      ? `ยกเลิกบัญชีผู้ดูแล (${link.relation_label || 'ไม่ระบุความสัมพันธ์'})`
      : 'ยกเลิกบัญชี LINE ของผู้รับบริการ';
    $('#identity-revoke-form').classList.remove('hidden');
    $('#identity-revoke-reason').focus();
  }

  async function revokeIdentityLink(event) {
    event.preventDefault();
    const result = await db.rpc('revoke_patient_identity_link', {
      p_link_id: $('#identity-revoke-id').value,
      p_reason: $('#identity-revoke-reason').value.trim()
    });
    if (result.error) throw result.error;
    $('#identity-revoke-form').reset();
    $('#identity-revoke-form').classList.add('hidden');
    await loadIdentityLinks();
    toast('ยกเลิกการเชื่อม LINE และบันทึก Audit แล้ว');
  }

  async function issueIdentityLink(event) {
    event.preventDefault();
    if (!identityLinkPatientId) throw new Error('ไม่พบผู้รับบริการที่เลือก');
    const result = await db.rpc('issue_patient_line_link_code', {
      p_patient_id: identityLinkPatientId,
      p_link_type: $('#identity-link-type').value,
      p_relation_label: $('#identity-link-relation').value.trim() || null,
      p_consent_confirmed: $('#identity-link-consent').checked
    });
    if (result.error) throw result.error;
    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    if (!row?.link_code) throw new Error('ไม่สามารถออกรหัสเชื่อมบัญชีได้');
    latestIdentityLinkCode = row.link_code;
    $('#identity-link-code').textContent = row.link_code.match(/.{1,4}/g).join('-');
    $('#identity-link-expiry').textContent = `หมดอายุ ${new Date(row.expires_at).toLocaleString('th-TH')}`;
    $('#identity-link-result').classList.remove('hidden');
    toast('ออกรหัสเชื่อมบัญชีแล้ว');
  }

  async function createInvoice(orderId) {
    requireAtomicHandoffs();
    const order = data.dispensing.find(item => item.id === orderId);
    const prescription = prescriptionFor(order);
    const encounter = encounterFor(prescription);
    if (!order || !prescription || !encounter) throw new Error('ข้อมูลใบสั่งยาหรือ Encounter ไม่ครบ');
    if (data.invoices.some(invoice => invoice.encounter_id === encounter.id && !['void', 'cancelled'].includes(invoice.status))) throw new Error('Encounter นี้มี Invoice แล้ว');
    const serviceFee = num(document.querySelector(`[data-service-fee="${CSS.escape(orderId)}"]`)?.value);
    const discount = num(document.querySelector(`[data-discount="${CSS.escape(orderId)}"]`)?.value);
    const result = await db.rpc('issue_atomic_dispensing_invoice', {
      p_dispensing_order_id: orderId,
      p_service_fee: serviceFee,
      p_discount: discount
    });
    if (result.error) throw result.error;
    await loadAll();
    toast('สร้าง Invoice แล้ว');
  }

  async function savePayment(event) {
    event.preventDefault();
    requireAtomicHandoffs();
    const invoice = data.invoices.find(item => item.id === $('#pay-invoice').value);
    const amount = num($('#pay-amount').value);
    if (!invoice) throw new Error('ไม่พบ Invoice');
    const requestKey = event.currentTarget.dataset.requestKey || crypto.randomUUID();
    event.currentTarget.dataset.requestKey = requestKey;
    const result = await db.rpc('record_atomic_invoice_payment', {
      p_request_key: requestKey,
      p_invoice_id: invoice.id,
      p_amount: amount,
      p_channel: $('#pay-channel').value,
      p_reference_note: $('#pay-note').value.trim() || null
    });
    if (result.error) throw result.error;
    const payment = Array.isArray(result.data) ? result.data[0] : result.data;
    const balance = num(payment?.balance_due);
    delete event.currentTarget.dataset.requestKey;
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
      if (profile.access_context_ready !== true) { runtime.showAccountStatus(profile, session); return; }
      role = runtime.roleOf(profile) || 'viewer';
      applyRole();
      await detectIdentityBackend();
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
    const editButton = event.target.closest('[data-edit-patient]');
    if (editButton) beginPatientEdit(editButton.dataset.editPatient);
    const linkButton = event.target.closest('[data-link-patient]');
    if (linkButton) openIdentityLinkDialog(linkButton.dataset.linkPatient).catch(fail);
  });
  $('#patient-form').addEventListener('submit', event => savePatient(event).catch(fail));
  $('#patient-cancel').addEventListener('click', resetPatientForm);
  $('#identity-link-form').addEventListener('submit', event => issueIdentityLink(event).catch(fail));
  $('#identity-existing-links').addEventListener('click', event => {
    const button = event.target.closest('[data-revoke-identity]');
    if (button) beginIdentityRevocation(button.dataset.revokeIdentity);
  });
  $('#identity-revoke-form').addEventListener('submit', event => revokeIdentityLink(event).catch(fail));
  $('#identity-revoke-cancel').addEventListener('click', () => {
    $('#identity-revoke-form').reset();
    $('#identity-revoke-form').classList.add('hidden');
  });
  $('#identity-link-type').addEventListener('change', event => {
    const relation = $('#identity-link-relation');
    const guardian = event.target.value === 'guardian';
    relation.disabled = !guardian;
    relation.required = guardian;
    if (!guardian) relation.value = '';
  });
  $('#identity-copy-code').addEventListener('click', async () => {
    if (!latestIdentityLinkCode) return;
    try {
      await navigator.clipboard.writeText(latestIdentityLinkCode);
      toast('คัดลอกรหัสแล้ว');
    } catch {
      toast('คัดลอกอัตโนมัติไม่ได้ กรุณาจดรหัสจากหน้าจอ');
    }
  });
  $('#payment-form').addEventListener('submit', event => savePayment(event).catch(fail));
  $('#logout').addEventListener('click', async () => { await db.auth.signOut(); location.replace('/login.html'); });
  $('#unlock').addEventListener('click', () => { $('#lock').classList.remove('show'); resetLock(); });
  ['click', 'keydown', 'touchstart'].forEach(name => document.addEventListener(name, resetLock, { passive: true }));
  init();
})();
