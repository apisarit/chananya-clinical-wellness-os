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
  const selectedPatientIds = new Set();
  let editingPatientId = null;
  let hybridDatabaseReady = false;
  let lineIdentityReady = false;
  let atomicHandoffsReady = false;
  let identityLinkPatientId = null;
  let latestIdentityLinkCode = '';
  let identityLinks = [];
  const serviceInvoiceRequestKeys = new Map();
  const pendingBillingActions = new Set();
  const treatmentQuotes = new Map();
  const treatmentQuoteErrors = new Map();
  const encounterInvoiceQuotes = new Map();
  const encounterInvoiceErrors = new Map();
  const encounterInvoiceRequests = new Map();
  const encounterInvoicePending = new Set();
  let paymentPending = false;
  let paymentRequest = null;
  let savedPaymentMarker = null;
  let savedServiceMarker = null;
  let serviceRecoveryPending = false;
  let receiptRequestVersion = 0;
  let accountBlocked = false;

  function blockChangedAccount(cachedPage = false) {
    if (accountBlocked) return;
    accountBlocked = true;
    session = null;
    profile = null;
    role = 'viewer';
    loadRequestVersion++;
    receiptRequestVersion++;
    clearTimeout(lockTimer);
    for (const key of Object.keys(data)) data[key] = Array.isArray(data[key]) ? [] : '';
    selectedPatientIds.clear();
    treatmentQuotes.clear();
    encounterInvoiceQuotes.clear();
    // Keep unresolved payment identity in memory; never replay it for a new account.
    const app = $('#app');
    app.inert = true;
    app.classList.add('hidden');
    $$('dialog[open]').forEach(dialog => dialog.close());
    $('#receipt-body')?.replaceChildren();
    $('#toast').textContent = '';
    $('#boot').classList.remove('hidden');
    $('#boot-error').textContent = (paymentRequest || savedPaymentMarker)
      ? 'บัญชีเปลี่ยนแล้ว จึงหยุดหน้านี้ มีคำขอรับเงินที่ยังไม่ยืนยันผล ห้ามรับเงินซ้ำ ให้ผู้รับเงินเดิมตรวจรายการก่อนเริ่มใหม่'
      : cachedPage ? 'กำลังตรวจสิทธิ์ใหม่หลังกลับมาที่หน้านี้'
        : 'บัญชีเปลี่ยนหรือออกจากระบบแล้ว กรุณาเปิดหน้าใหม่และเข้าสู่ระบบอีกครั้ง';
  }

  function watchAccount() {
    // Synchronous callback: do not call Supabase APIs while its auth lock is held.
    db.auth.onAuthStateChange((event, nextSession) => {
      if (accountBlocked) return;
      if (event === 'SIGNED_OUT' || !nextSession?.user?.id
        || nextSession.user.id !== session?.user?.id) blockChangedAccount();
    });
  }
  const data = {
    patients: [], allergies: [], appointments: [], encounters: [], prescriptions: [],
    dispensing: [], dispensingItems: [], rxItems: [], products: [], invoices: [], payments: [], audit: [],
    billableTreatmentEncounters: [], billableTreatmentError: '', ownerFinanceContexts: []
  };

  const viewPermissions = {
    super_admin: ['all'], admin: ['audit'], practitioner: ['patients'], doctor: ['patients'],
    reception: ['patients'], billing: ['billing'], pharmacy: [], production: [], inventory: [], quality: [], viewer: []
  };

  const canView = permission => (permission === 'billing' && ownerFinance())
    || (viewPermissions[role] || []).includes('all') || (viewPermissions[role] || []).includes(permission);

  function toast(message) {
    if (accountBlocked) return;
    const element = $('#toast');
    element.textContent = message;
    element.classList.add('show');
    setTimeout(() => element.classList.remove('show'), 2400);
  }

  function fail(error) {
    if (accountBlocked) return;
    console.error(error);
    const serviceMessages = {
      SERVICE_OUTCOME_UNRESOLVED: 'ราคาหรือรายการบริการเปลี่ยนจากคำขอเดิม กรุณาตรวจบิลเดิมก่อน ยังไม่ได้ออกบิลใหม่',
      SERVICE_READBACK_MISMATCH: 'ข้อมูลบิลที่อ่านกลับไม่ตรงกับคำขอเดิม ระบบยังไม่ยืนยันผล กรุณาให้ผู้ดูแลตรวจสอบ',
      SERVICE_JOURNAL_CHANGED: 'ข้อมูลคำขอบิลค้างเปลี่ยนไป กรุณาโหลดหน้าใหม่และตรวจบิลเดิมก่อน',
      SERVICE_JOURNAL_INVALID: 'ข้อมูลคำขอบิลค้างไม่สมบูรณ์ กรุณาให้ผู้ดูแลตรวจสอบ ห้ามออกบิลซ้ำ',
      SERVICE_JOURNAL_UNAVAILABLE: 'เก็บข้อมูลติดตามคำขอบิลไม่ได้ กรุณาตรวจการตั้งค่าเบราว์เซอร์และตรวจบิลเดิมก่อน',
      SERVICE_CONTEXT_CHANGED: 'บัญชีหรือคลินิกเปลี่ยนแล้ว กรุณาเข้าสู่ระบบและตรวจบิลเดิมอีกครั้ง'
    };
    alert(serviceMessages[error?.message] || error?.message || String(error));
  }

  function patient(id) { return data.patients.find(item => item.id === id); }
  function ownerFinance() {
    return profile?.access_context_ready === true && profile?.clinic_role === 'owner' && Boolean(profile?.clinic_id);
  }

  async function readOwnerInvoiceContext(invoiceId) {
    const actorSession = session, actorProfile = profile;
    const result = await db.rpc('get_owner_invoice_context', { p_invoice_id: invoiceId });
    if (accountBlocked || session !== actorSession || profile !== actorProfile) throw new Error('PAYMENT_CONTEXT_CHANGED');
    const row = Array.isArray(result.data) && result.data.length === 1 ? result.data[0] : null;
    if (result.error || !row || row.invoice_id !== invoiceId || row.clinic_id !== actorProfile.clinic_id || !row.patient_id) {
      throw new Error('PAYMENT_READBACK_MISMATCH');
    }
    return row;
  }
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

  let loadRequestVersion = 0;
  function invalidateFinancialReadback() {
      // Invalidate the stale choices, but preserve paymentRequest so an
      // uncertain committed payment can still be retried with its original key.
      data.invoices = [];
      data.payments = [];
      data.billableTreatmentEncounters = [];
      data.prescriptions = [];
      data.dispensing = [];
      data.ownerFinanceContexts = [];
      treatmentQuotes.clear();
      encounterInvoiceQuotes.clear();
      for (const selector of ['#billing-queue', '#treatment-billing-queue']) {
        const element = $(selector);
        if (element) element.textContent = 'โหลดข้อมูลส่งต่อเพื่อออกบิลไม่สำเร็จ กรุณาโหลดใหม่ ไม่ใช่การยืนยันว่าไม่มีงาน';
      }
      $('#pay-invoice').replaceChildren();
      $('#invoice-list').textContent = 'ยังอ่านข้อมูลการเงินล่าสุดไม่ได้ กรุณาโหลดใหม่ก่อนรับเงินรายการใหม่ ไม่ใช่การยืนยันว่าไม่มีบิล';
  }

  async function financialQuery(table, order, isCurrent, select = '*') {
    try { return await query(table, select, order); }
    catch (error) {
      if (!isCurrent()) throw error;
      invalidateFinancialReadback();
      throw error;
    }
  }

  async function loadAuditOverview(allowed) {
    if (!allowed) return { rows: [], failed: false };
    try {
      return { rows: await query('audit_logs', 'id,occurred_at,user_id,action,entity', 'occurred_at'), failed: false };
    } catch {
      return { rows: [], failed: true };
    }
  }

  async function loadAll() {
    if (accountBlocked) return;
    const version = ++loadRequestVersion;
    const actorSession = session, actorProfile = profile;
    const isCurrent = () => version === loadRequestVersion && session === actorSession && profile === actorProfile;
    receiptRequestVersion++;
    if ($('#receipt-dialog')?.open) $('#receipt-dialog').close();
    $('#receipt-body')?.replaceChildren();
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
      ? (billingAccess ? financialQuery(table, order, isCurrent, select) : optionalQuery(table, select, order))
      : Promise.resolve([]);
    const rows = await Promise.all([
      onlyWhen(patientAccess && !ownerFinance(), 'patients', '*', 'created_at'),
      onlyWhen(runtime.can(profile, 'patient_registry') || runtime.can(profile, 'clinical_read') || runtime.can(profile, 'pharmacy_operate'), 'patient_allergies'),
      onlyWhen(runtime.can(profile, 'appointments_view'), 'appointments'),
      onlyWhen(!ownerFinance() && (clinicalAccess || billingAccess), 'encounters', '*', 'started_at'),
      onlyWhen(!ownerFinance() && (clinicalAccess || pharmacyAccess || billingAccess), 'prescriptions', '*', 'prescribed_at'),
      onlyWhen(!ownerFinance() && (pharmacyAccess || billingAccess), 'dispensing_orders', '*', 'created_at'),
      onlyWhen(!ownerFinance() && (pharmacyAccess || billingAccess), 'dispensing_items'),
      onlyWhen(!ownerFinance() && (clinicalAccess || pharmacyAccess || billingAccess), 'prescription_items'),
      onlyWhen(!ownerFinance() && (clinicalAccess || pharmacyAccess || billingAccess), 'products'),
      // Financial read failures are not empty financial ledgers. Propagate them
      // so initial load/reload and post-payment recovery report the failure.
      billingAccess ? financialQuery('invoices', 'created_at', isCurrent) : Promise.resolve([]),
      billingAccess ? financialQuery('payments', undefined, isCurrent) : Promise.resolve([]),
      loadAuditOverview(['admin', 'super_admin'].includes(role))
    ]);
    if (!isCurrent()) return;
    const auditResult = rows.pop();
    data.audit = auditResult.rows;
    data.auditFailed = auditResult.failed;
    [data.patients, data.allergies, data.appointments, data.encounters, data.prescriptions, data.dispensing,
      data.dispensingItems, data.rxItems, data.products, data.invoices, data.payments] = rows;
    data.ownerFinanceContexts = [];
    if (ownerFinance()) {
      try {
      const context = await db.rpc('list_owner_finance_context');
      if (!isCurrent()) return;
      if (context.error || !Array.isArray(context.data) || context.data.some(row =>
        row.clinic_id !== actorProfile.clinic_id || !row.patient_id || typeof row.has_prescription !== 'boolean')) {
        throw new Error('ยังโหลดข้อมูลการเงิน Owner ไม่สำเร็จ กรุณาโหลดใหม่');
      }
      data.ownerFinanceContexts = context.data;
      data.patients = [...new Map(context.data.map(row => [row.patient_id, {
        id: row.patient_id, hn: row.hn, prefix: row.prefix, first_name: row.first_name, last_name: row.last_name
      }])).values()];
      data.encounters = context.data.filter(row => row.encounter_id).map(row => ({
        id: row.encounter_id, encounter_no: row.encounter_no, patient_id: row.patient_id
      }));
      } catch (error) {
        if (!isCurrent()) return;
        invalidateFinancialReadback();
        throw error;
      }
    }
    data.billableTreatmentEncounters = [];
    data.billableTreatmentError = '';
    if (billingAccess) {
      try {
        const result = await db.rpc('list_billable_treatment_encounters');
        if (!isCurrent()) return;
        if (result.error) throw result.error;
        data.billableTreatmentEncounters = result.data || [];
      } catch (error) {
        if (!isCurrent()) return;
        data.billableTreatmentError = 'ยังโหลดรายการค่าบริการรักษาไม่ได้ กรุณาตรวจสอบ migration ที่เกี่ยวข้อง';
        console.warn('Optional treatment billing RPC unavailable', error);
      }
    }
    treatmentQuotes.clear();
    treatmentQuoteErrors.clear();
    encounterInvoiceQuotes.clear();
    encounterInvoiceErrors.clear();
    if (billingAccess) {
      const ids = [...new Set([
        ...data.billableTreatmentEncounters.map(item => item.encounter_id),
        ...billingOrders().map(order => prescriptionFor(order)?.encounter_id)
      ].filter(Boolean))];
      for (let offset = 0; offset < ids.length; offset += 4) {
        await Promise.all(ids.slice(offset, offset + 4).map(async id => {
          try {
            const result = await db.rpc('quote_treatment_invoice', { p_encounter_id: id });
            if (!isCurrent()) return;
            if (result.error) throw result.error;
            const quote = Array.isArray(result.data) ? result.data[0] : result.data;
            if (quote && Number.isFinite(Number(quote.amount)) && Number(quote.amount) >= 0) treatmentQuotes.set(id, quote);
          } catch (error) {
            if (!isCurrent()) return;
            treatmentQuoteErrors.set(id, String(error?.message || '').includes('DURATION')
              ? 'มี Session ที่ยังไม่บันทึกเวลาจริง ให้ผู้รักษาบันทึกเวลา; หากลงนามแล้วต้องผ่าน Amendment ก่อน'
              : 'ยังอ่านราคาค่าบริการไม่ได้ ตรวจราคากลางและสิทธิ์ หรือโหลดใหม่');
          }
        }));
      }
      const pharmacyEncounterIds = billingEncounterIds();
      for (let offset = 0; offset < pharmacyEncounterIds.length; offset += 4) {
        await Promise.all(pharmacyEncounterIds.slice(offset, offset + 4).map(async id => {
          try {
            const result = await db.rpc('quote_encounter_invoice', { p_encounter_id: id });
            if (!isCurrent()) return;
            if (result.error) throw result.error;
            const quote = Array.isArray(result.data) ? result.data[0] : result.data;
            if (!validEncounterQuote(quote, id)) throw new Error('INVALID_INVOICE_QUOTE');
            encounterInvoiceQuotes.set(id, quote);
          } catch (error) {
            if (!isCurrent()) return;
            encounterInvoiceErrors.set(id, invoiceQuoteError(error));
          }
        }));
      }
    }
    if (isCurrent()) render();
  }

  async function refreshBilling() {
    if (accountBlocked) return;
    const button = $('#billing-refresh');
    const status = $('#billing-refresh-status');
    if (button?.disabled) return;
    if (button) button.disabled = true;
    if (status) status.textContent = 'กำลังโหลดคิวและยอดเงินล่าสุด…';
    const expectedVersion = loadRequestVersion + 1;
    const actorSession = session, actorProfile = profile;
    const stillCurrent = () => !accountBlocked && session === actorSession && profile === actorProfile;
    try {
      await loadAll();
      if (stillCurrent() && status) status.textContent = loadRequestVersion === expectedVersion
        ? 'โหลดข้อมูลแล้ว — รายการที่ยังไม่ยืนยันผลต้องตรวจบิลหรือการรับเงินเดิมต่อ'
        : 'มีคำขอโหลดข้อมูลใหม่กว่า กรุณาตรวจสถานะคิวล่าสุด';
    } catch (_) {
      if (stillCurrent() && status) status.textContent = loadRequestVersion === expectedVersion
        ? 'โหลดไม่สำเร็จ กรุณาลองอีกครั้ง — ไม่ได้ออกบิลหรือรับเงินเพิ่ม'
        : 'มีคำขอโหลดข้อมูลใหม่กว่า กรุณาตรวจสถานะคิวล่าสุด';
    } finally {
      if (button) button.disabled = false;
    }
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
    $('#stat-b').textContent = billingEncounterIds().length;
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
    const visibleRows = rows.slice(0, 200);
    for (const id of selectedPatientIds) if (!data.patients.some(item => item.id === id)) selectedPatientIds.delete(id);
    $('#patient-export').hidden = !['admin', 'super_admin'].includes(role);
    $('#patient-export-count').textContent = selectedPatientIds.size;
    $('#patient-list').innerHTML = visibleRows.map(item => {
      const allergies = activeAllergies(item.id);
      const canLink = lineIdentityReady && window.ChananyaRuntime.can(profile, 'patient_identity_link');
      const exportControl = ['admin', 'super_admin'].includes(role)
        ? `<label class="check-row" title="เลือกรายการสำหรับ export"><input type="checkbox" data-export-patient="${esc(item.id)}"${selectedPatientIds.has(item.id) ? ' checked' : ''}>เลือก</label>`
        : '';
      return `<article class="item"><div><b>${esc(item.hn)} • ${esc(patientName(item.id))}</b><small>${esc(item.phone || 'ไม่มีโทรศัพท์')}${allergies.length ? ` • แพ้: ${esc(allergies.map(allergy => allergy.allergen_name).join(', '))}` : ''}</small></div><div class="actions">${exportControl}<span class="badge">${esc(item.payment_right || 'ทั่วไป')}</span>${canLink ? `<button class="btn ghost" data-link-patient="${esc(item.id)}">เชื่อม LINE</button>` : ''}${canView('patients') ? `<button class="btn ghost" data-edit-patient="${esc(item.id)}">แก้ไข</button>` : ''}</div></article>`;
    }).join('') || '<p class="muted">ไม่พบผู้รับบริการ</p>';
    // Avoid retaining selections that are no longer in the current dataset.
    for (const id of selectedPatientIds) if (!data.patients.some(item => item.id === id)) selectedPatientIds.delete(id);
  }

  function downloadSelectedPatients() {
    if (accountBlocked) throw new Error('บัญชีเปลี่ยนแล้ว กรุณาเข้าสู่ระบบใหม่');
    if (!['admin', 'super_admin'].includes(role)) throw new Error('บัญชีนี้ไม่มีสิทธิ์ Export ผู้รับบริการ');
    const clinicId = profile?.clinic_id;
    if (typeof clinicId !== 'string' || !clinicId.trim()) throw new Error('ยังยืนยันคลินิกปัจจุบันไม่ได้ กรุณาเข้าสู่ระบบใหม่ก่อน Export');
    const ids = [...selectedPatientIds];
    if (ids.length < 1) throw new Error('กรุณาเลือกรายการผู้รับบริการก่อน Export');
    if (ids.length > 100) throw new Error('Export ได้ไม่เกิน 100 รายการต่อครั้ง');
    const matches = ids.map(id => data.patients.filter(item => item.id === id));
    if (matches.some(items => items.length === 0)) throw new Error('รายการที่เลือกไม่ครบในข้อมูลล่าสุด กรุณาโหลดและเลือกใหม่ก่อน Export');
    if (matches.some(items => items.length !== 1)) throw new Error('พบรายการผู้รับบริการซ้ำ กรุณาโหลดและเลือกใหม่ก่อน Export');
    const selected = matches.map(items => items[0]);
    if (selected.some(item => item.clinic_id !== clinicId)) throw new Error('ข้อมูลที่เลือกไม่ตรงกับคลินิกปัจจุบัน กรุณาโหลดและเลือกใหม่ก่อน Export');
    const rows = selected.map(item => window.CnyosSelectedExport.projectPatient(item));
    const format = $('#patient-export-format').value;
    if (!['csv', 'json'].includes(format)) throw new Error('รูปแบบ Export ไม่ถูกต้อง');
    const body = format === 'json'
      ? `${JSON.stringify(rows, null, 2)}\n`
      : window.CnyosSelectedExport.patientCsv(rows);
    const blob = new Blob([body], { type: format === 'json' ? 'application/json' : 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `cnyos-patients-selected-${new Date().toISOString().replace(/[:.]/g, '-')}.${format}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    toast(`ดาวน์โหลด ${rows.length} รายการแล้ว (ข้อมูลยังอยู่ในเครื่องนี้)`);
  }

  function billingOrders() { return data.dispensing.filter(order => order.status === 'submitted_to_billing'); }

  function billingEncounterIds() {
    return [...new Set([...(data.ownerFinanceContexts || []).filter(row => row.has_prescription && row.encounter_id
      && !data.invoices.some(invoice => invoice.encounter_id === row.encounter_id && !['void', 'cancelled'].includes(invoice.status)))
      .map(row => row.encounter_id), ...data.prescriptions
      .filter(rx => !['cancelled', 'rejected', 'void'].includes(rx.status))
      .map(rx => rx.encounter_id).filter(id => id && !data.invoices.some(invoice =>
        invoice.encounter_id === id && !['void', 'cancelled'].includes(invoice.status))),
      ...encounterInvoiceRequests.keys()])];
  }

  function validEncounterQuote(quote, encounterId) {
    return quote?.encounter_id === encounterId && typeof quote.quote_fingerprint === 'string'
      && /^[a-f0-9]{64}$/.test(quote.quote_fingerprint)
      && ['medicine_total', 'service_total', 'grand_total'].every(key =>
        quote[key] !== null && quote[key] !== undefined && Number.isFinite(Number(quote[key])) && Number(quote[key]) >= 0)
      && Number(quote.grand_total) > 0
      && Math.round(Number(quote.grand_total) * 100) === Math.round(Number(quote.medicine_total) * 100) + Math.round(Number(quote.service_total) * 100)
      && Array.isArray(quote.orders) && quote.orders.length > 0
      && quote.orders.every(order => typeof order?.id === 'string' && order.id.length > 0)
      && new Set(quote.orders.map(order => order.id)).size === quote.orders.length;
  }

  function invoiceQuoteError(error) {
    const code = String(error?.message || '');
    if (/NOT_READY|NOT_FINALIZED|MISSING_ORDER|INCOMPLETE/.test(code)) return 'ห้องยายังส่งงานไม่ครบทุกใบสั่งยา ให้ตรวจและส่งต่อทุกคิวก่อนออกบิล';
    if (/STALE|MISMATCH/.test(code)) return 'รายการหรือราคาเปลี่ยนแล้ว กรุณาโหลดและตรวจยอดใหม่ก่อนยืนยัน';
    if (/DURATION/.test(code)) return 'ยังบันทึกเวลารับบริการไม่ครบ ให้ผู้รักษาตรวจ Session ก่อนออกบิล';
    if (/SIGNED_CLINICAL_RECORD_REQUIRED/.test(code)) return 'ผู้รักษายังไม่ลงนามเวชระเบียน กรุณาส่งกลับให้ลงนามก่อนออกบิล';
    if (/CANCELLED_PRESCRIPTION_HAS_DISPENSED_ITEMS/.test(code)) return 'พบใบสั่งยาที่ยกเลิกแต่ยังมีรายการจ่ายยา ให้ห้องยาตรวจและปรับรายการตามขั้นตอนก่อนออกบิล';
    if (/PRICE/.test(code)) return 'ราคากลางไม่ครบหรือใช้งานไม่ได้ ให้ Owner/Admin ตรวจราคา';
    return 'ยังตรวจยอดรวม Encounter ไม่สำเร็จ กรุณาโหลดใหม่หรือตรวจสิทธิ์และรุ่นระบบ ไม่ออกบิลจากรายการบางส่วน';
  }

  function renderBilling() {
    $('#billing-queue').innerHTML = billingEncounterIds().map(encounterId => {
      const encounter = data.encounters.find(item => item.id === encounterId);
      const prescriptions = data.prescriptions.filter(rx => rx.encounter_id === encounterId);
      const quote = encounterInvoiceQuotes.get(encounterId);
      const pending = encounterInvoiceRequests.get(encounterId);
      const ready = validEncounterQuote(quote, encounterId);
      const queues = ready ? quote.orders.map(order => esc(order.queue_number || order.id)).join(', ')
        : prescriptions.map(rx => {
          const order = data.dispensing.find(item => item.prescription_id === rx.id);
          return `${esc(rx.prescription_no || rx.id)}: ${esc(order?.status || 'ยังไม่พบคิวห้องยา')}`;
        }).join('<br>');
      return `<article class="item column"><div><b>${esc(encounter?.encounter_no || encounterId)} • ${esc(patientName(encounter?.patient_id))}</b><small>รวมทุกใบสั่งยาใน Encounter เดียว</small></div><p>${queues}</p><p>${ready ? `ค่ายา ฿${money(quote.medicine_total)} + ค่าบริการ ฿${money(quote.service_total)} = รวม ฿${money(quote.grand_total)}` : esc(encounterInvoiceErrors.get(encounterId) || 'กำลังรอตรวจยอดและความครบถ้วนจากระบบ')}</p>${pending ? `<p class="notice">คำขอเดิมยอด ฿${money(pending.total)} ยังตรวจผลไม่ครบ กดตรวจผลคำขอเดิม ห้ามสร้างบิลใหม่</p>` : ''}<div class="actions"><button class="btn primary" data-action="invoice" data-id="${esc(encounterId)}"${ready || pending ? '' : ' disabled'}>${pending ? 'ตรวจผลคำขอเดิม' : 'ยืนยันออกบิลรวม Encounter'}</button><button class="btn ghost" data-action="invoice-refresh" data-id="${esc(encounterId)}">ตรวจยอดใหม่</button></div></article>`;
    }).join('') || '<p class="muted">ไม่มีรายการรอออก Invoice</p>';

    const treatmentNotice = data.billableTreatmentError ? `<p class="notice">${esc(data.billableTreatmentError)}</p>` : '';
    const serviceRows = new Map(data.billableTreatmentEncounters.map(item => [item.encounter_id, item]));
    for (const [id, request] of serviceInvoiceRequestKeys) {
      if (!accountBlocked && request.actorSession === session && request.actorProfile === profile && !serviceRows.has(id)) {
        serviceRows.set(id, { encounter_id: id });
      }
    }
    $('#treatment-billing-queue').innerHTML = treatmentNotice + ([...serviceRows.values()].map(item => {
      const quote = treatmentQuotes.get(item.encounter_id);
      const request = serviceInvoiceRequestKeys.get(item.encounter_id);
      const pending = !accountBlocked && request?.actorSession === session && request?.actorProfile === profile ? request : null;
      if (pending) return `<article class="item column"><b>${esc(item.encounter_no || item.encounter_id)}</b><p class="notice">คำขอออกบิลค่าบริการยอด ฿${money(pending.amount)} ยังยืนยันผลไม่ครบ ใช้คำขอเดิมเท่านั้น ไม่ออกบิลใหม่</p><button class="btn primary" data-action="service-invoice" data-id="${esc(item.encounter_id)}">ตรวจผลคำขอเดิม</button></article>`;
      const ready = quote && Number(quote.amount) > 0;
      return `<article class="item column"><div><b>${esc(item.encounter_no || item.encounter_id || '-')} • ${esc(patientName(item.patient_id))}</b><small>บริการรักษาแบบไม่มีรายการยา</small></div><p>${ready ? `${esc(quote.description)} • ${esc(quote.duration_minutes)} นาที × ฿${money(quote.unit_price)}/ชั่วโมง = ฿${money(quote.amount)}` : esc(treatmentQuoteErrors.get(item.encounter_id) || 'ยังออกบิลไม่ได้: ต้องมีราคากลางและเวลารับบริการจริงครบทุก Session')}</p><button class="btn primary" data-action="service-invoice" data-id="${esc(item.encounter_id)}"${ready ? '' : ' disabled'}>สร้าง Invoice ค่าบริการ</button></article>`;
    }).join('') || '<p class="muted">ไม่มี Encounter ที่พร้อมออก Invoice ค่าบริการ</p>');
    $('#invoice-list').innerHTML = data.invoices.map(invoice => {
      const payments = data.payments.filter(payment => payment.invoice_id === invoice.id && payment.status === 'paid');
      const receiptButtons = payments.map(payment => `<button class="btn ghost" data-action="receipt" data-id="${esc(payment.id)}">ใบรับเงิน ${esc(payment.payment_reference)}</button>`).join('');
      return `<article class="item"><div><b>${esc(invoice.invoice_number)} • ${esc(patientName(invoice.patient_id))}</b><small>รวม ฿${money(invoice.grand_total)} • ชำระ ฿${money(invoice.paid_amount)} • คงเหลือ ฿${money(invoice.balance_due)}</small></div><div class="actions"><span class="badge">${esc(invoice.status)}</span>${receiptButtons}</div></article>`;
    }).join('') || '<p class="muted">ยังไม่มี Invoice</p>';
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
      work.push(...billingEncounterIds().slice(0, 4).map(id => {
        const encounter = data.encounters.find(item => item.id === id);
        return `<button class="item" data-go-view="billing"><div><b>${esc(encounter?.encounter_no || id)}</b><small>${esc(patientName(encounter?.patient_id))}</small></div><span class="badge">ตรวจยอดรวมการเงิน</span></button>`;
      }));
    }
    $('#work-list').innerHTML = work.join('') || '<p class="muted">ไม่มีงานค้างในขอบเขตสิทธิ์นี้</p>';
  }

  function renderAudit() {
    if (data.auditFailed) {
      $('#audit-list').innerHTML = '<p class="muted" role="alert">โหลดประวัติไม่สำเร็จ กรุณาโหลดหน้าใหม่หรือตรวจประวัติในศูนย์ควบคุม ไม่ใช่การยืนยันว่าไม่มีรายการ</p>';
      return;
    }
    $('#audit-list').innerHTML = data.audit.slice(0, 100).map(item => `<article class="item audit-item"><div><b>${esc(item.action)} • ${esc(item.entity)}</b><small>${new Date(item.occurred_at).toLocaleString('th-TH')} • ${esc(item.user_id || '-')}</small></div></article>`).join('') || '<p class="muted">ไม่มีข้อมูลหรือไม่มีสิทธิ์</p>';
  }

  function bindActions() {
    for (const [action, handler] of [['invoice', createInvoice], ['service-invoice', createServiceInvoice], ['invoice-refresh', loadAll]]) {
      $$(`[data-action="${action}"]`).forEach(button => { button.onclick = async () => {
        const key = `${action}:${button.dataset.id}`;
        if (pendingBillingActions.has(key)) return;
        pendingBillingActions.add(key); button.disabled = true;
        try { await handler(button.dataset.id); } catch (error) { fail(error); }
        finally { pendingBillingActions.delete(key); button.disabled = false; }
      }; });
    }
    $$('[data-action="receipt"]').forEach(button => { button.onclick = () => showReceipt(button.dataset.id).catch(error => toast(error.message)); });
    $$('[data-go-view]').forEach(button => { button.onclick = () => show(button.dataset.goView); });
  }

  async function createServiceInvoice(encounterId, resumeMarker = null) {
    if (accountBlocked) throw new Error('บัญชีเปลี่ยนแล้ว กรุณาเข้าสู่ระบบใหม่');
    if (!window.CnyosServiceInvoiceJournal) throw new Error('ตัวกู้คำขอบิลยังไม่พร้อม');
    if (savedServiceMarker && resumeMarker !== savedServiceMarker) throw new Error('กรุณาตรวจบิลเดิมก่อนออกบิลใหม่');
    if (resumeMarker && (resumeMarker !== savedServiceMarker || resumeMarker.encounterId !== encounterId)) throw new Error('SERVICE_JOURNAL_CHANGED');
    const actorSession = session;
    const actorProfile = profile;
    const pending = serviceInvoiceRequestKeys.get(encounterId);
    if (pending && (pending.actorSession !== actorSession || pending.actorProfile !== actorProfile)) {
      throw new Error('บัญชีเปลี่ยนแล้ว กรุณาตรวจบิลเดิมก่อนออกบิลใหม่');
    }
    const quote = pending || treatmentQuotes.get(encounterId);
    const amount = Number(quote?.amount);
    const description = quote?.description;
    if (!(amount > 0) || !description) throw new Error('กรุณาตั้งราคากลางและบันทึกเวลารับบริการจริงก่อนออกบิล');
    const marker = await window.CnyosServiceInvoiceJournal.prepare({ actorId: actorSession.user.id, clinicId: actorProfile.clinic_id, encounterId, amount, description, expectedRequestId: resumeMarker?.requestId || pending?.requestKey || null });
    if (session !== actorSession || profile !== actorProfile || accountBlocked) return;
    const requestKey = marker.requestId;
    serviceInvoiceRequestKeys.set(encounterId, { requestKey, amount, description, actorSession, actorProfile });
    renderBilling();
    bindActions();
    const result = await db.rpc('issue_atomic_treatment_invoice', {
      p_request_key: requestKey, p_encounter_id: encounterId, p_amount: amount, p_description: description
    });
    if (result.error) throw result.error;
    if (session !== actorSession || profile !== actorProfile || accountBlocked) return;
    const issued = Array.isArray(result.data) ? result.data[0] : result.data;
    if (!issued?.invoice_id) throw new Error('ส่งคำขอออกบิลแล้ว แต่ตรวจอ่านกลับยังไม่สำเร็จ กรุณาตรวจผลคำขอเดิมก่อน');
    const readback = await db.from('invoices').select('id,encounter_id,grand_total').eq('id', issued.invoice_id).single();
    if (session !== actorSession || profile !== actorProfile || accountBlocked) return;
    if (readback.error || readback.data?.id !== issued.invoice_id
      || readback.data?.encounter_id !== encounterId
      || readback.data?.grand_total === null || readback.data?.grand_total === undefined
      || !Number.isFinite(Number(readback.data.grand_total))
      || Math.round(Number(readback.data.grand_total) * 100) !== Math.round(amount * 100)) {
      throw new Error('ส่งคำขอออกบิลแล้ว แต่ตรวจอ่านกลับยังไม่สำเร็จ กรุณาตรวจผลคำขอเดิมก่อน');
    }
    await window.CnyosServiceInvoiceJournal.recover({ actorId: actorSession.user.id, clinicId: actorProfile.clinic_id,
      isCurrent: () => !accountBlocked && session === actorSession && profile === actorProfile,
      readInvoice: value => readServiceInvoiceReceipt(value) });
    if (session !== actorSession || profile !== actorProfile || accountBlocked) return;
    serviceInvoiceRequestKeys.delete(encounterId);
    if (resumeMarker) {
      savedServiceMarker = null;
      $('#service-invoice-recovery').classList.add('hidden');
    }
    await loadAll();
    if (session === actorSession && profile === actorProfile && !accountBlocked) toast('สร้าง Invoice ค่าบริการแล้ว');
  }

  async function showReceipt(paymentId, print = false) {
    const version = ++receiptRequestVersion;
    const actorSession = session;
    const actorProfile = profile;
    const dialog = $('#receipt-dialog');
    if (dialog.open) dialog.close();
    $('#receipt-body').replaceChildren();
    const read = async (table, id, fields) => {
      const result = await db.from(table).select(fields).eq('id', id).single();
      if (result.error || !result.data || result.data.id !== id) throw new Error('ยังตรวจข้อมูลใบรับเงินไม่ได้ กรุณาลองใหม่');
      return result.data;
    };
    const payment = await read('payments', paymentId, 'id,invoice_id,status,payment_reference,amount,channel,paid_at');
    if (version !== receiptRequestVersion || session !== actorSession || profile !== actorProfile) return;
    const invoice = await read('invoices', payment.invoice_id, 'id,invoice_number,patient_id');
    if (version !== receiptRequestVersion || session !== actorSession || profile !== actorProfile) return;
    if (!payment || !invoice) throw new Error('ไม่พบข้อมูลใบรับเงิน');
    const patient = ownerFinance() ? await readOwnerInvoiceContext(invoice.id)
      : await read('patients', invoice.patient_id, 'id,first_name,last_name');
    if (ownerFinance() && patient.patient_id !== invoice.patient_id) throw new Error('PAYMENT_READBACK_MISMATCH');
    if (version !== receiptRequestVersion || session !== actorSession || profile !== actorProfile) return;
    if (payment.status !== 'paid' || !payment.payment_reference || !invoice.invoice_number
      || !patient || !payment.channel || !payment.paid_at || !Number.isFinite(Date.parse(payment.paid_at))
      || !Number.isFinite(Number(payment.amount)) || Number(payment.amount) <= 0) {
      throw new Error('ยังแสดงใบรับเงินไม่ได้: ต้องมีรายการรับเงินสำเร็จและข้อมูลครบ กรุณาโหลดข้อมูลใหม่');
    }
    $('#receipt-body').innerHTML = `<h2>ใบรับเงิน</h2><p><b>เลขที่รับเงิน:</b> ${esc(payment.payment_reference)}</p><p><b>Invoice:</b> ${esc(invoice.invoice_number)}</p><p><b>ผู้รับบริการ:</b> ${esc([patient.first_name, patient.last_name].filter(Boolean).join(' '))}</p><p><b>จำนวนเงิน:</b> ฿${money(payment.amount)}</p><p><b>ช่องทาง:</b> ${esc(payment.channel)}</p><p><b>เวลารับเงิน:</b> ${esc(payment.paid_at)}</p><button class="btn primary" type="button" id="receipt-print">พิมพ์</button>`;
    $('#receipt-print').onclick = () => showReceipt(paymentId, true).catch(error => toast(error.message));
    dialog.showModal();
    if (print) {
      const finishPrint = () => {
        document.body.classList.remove('receipt-printing');
        window.removeEventListener('afterprint', finishPrint);
      };
      document.body.classList.add('receipt-printing');
      window.addEventListener('afterprint', finishPrint, { once: true });
      try {
        window.print();
      } catch {
        finishPrint();
        throw new Error('พิมพ์ใบรับเงินไม่สำเร็จ กรุณาลองพิมพ์อีกครั้ง ไม่ต้องบันทึกรับเงินซ้ำ');
      }
    }
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
    if (accountBlocked) throw new Error('บัญชีเปลี่ยนแล้ว กรุณาเข้าสู่ระบบใหม่');
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

  async function createInvoice(encounterId) {
    requireAtomicHandoffs();
    if (encounterInvoicePending.has(encounterId)) return;
    let request = encounterInvoiceRequests.get(encounterId);
    if (!request) {
      if (data.invoices.some(invoice => invoice.encounter_id === encounterId && !['void', 'cancelled'].includes(invoice.status))) throw new Error('Encounter นี้มี Invoice แล้ว');
      const quote = encounterInvoiceQuotes.get(encounterId);
      if (!validEncounterQuote(quote, encounterId)) throw new Error('ยังไม่มีราคากลางและยอดรวมทุกใบสั่งยาที่ตรวจสอบแล้ว กรุณาโหลดใหม่');
      request = { key: crypto.randomUUID(), fingerprint: quote.quote_fingerprint, total: Number(quote.grand_total) };
      encounterInvoiceRequests.set(encounterId, request);
    }
    encounterInvoicePending.add(encounterId);
    try {
      const result = await db.rpc('issue_atomic_encounter_invoice', {
        p_request_key: request.key, p_encounter_id: encounterId, p_quote_fingerprint: request.fingerprint
      });
      if (result.error) {
        if (String(result.error.message) === 'STALE_INVOICE_QUOTE') {
          encounterInvoiceRequests.delete(encounterId);
          encounterInvoiceQuotes.delete(encounterId);
          encounterInvoiceErrors.set(encounterId, invoiceQuoteError(result.error));
          renderBilling();
          bindActions();
        }
        throw new Error(invoiceQuoteError(result.error));
      }
      const receipt = Array.isArray(result.data) ? result.data[0] : result.data;
      if (!receipt?.invoice_id || Number(receipt.grand_total) !== request.total) throw new Error('ผลออกบิลไม่ตรงกับยอดที่ยืนยัน ให้ตรวจผลคำขอเดิมก่อน');
      const readback = await db.from('invoices').select('id,encounter_id,invoice_number,grand_total').eq('id', receipt.invoice_id).single();
      if (readback.error || readback.data?.encounter_id !== encounterId
        || readback.data?.invoice_number !== receipt.invoice_number || Number(readback.data?.grand_total) !== request.total) {
        throw new Error('ส่งออกบิลแล้ว แต่ตรวจอ่านกลับยังไม่สำเร็จ ให้ตรวจผลคำขอเดิม ห้ามสร้างบิลใหม่');
      }
      encounterInvoiceRequests.delete(encounterId);
      try { await loadAll(); } catch { toast('อ่านบิลที่ออกสำเร็จแล้ว แต่โหลดคิวล่าสุดไม่สำเร็จ กรุณาโหลดหน้าใหม่'); return; }
      toast('ออกบิลรวมทุกใบสั่งยาและค่าบริการแล้ว');
    } catch (error) {
      renderBilling();
      bindActions();
      throw error;
    } finally { encounterInvoicePending.delete(encounterId); }
  }

  function renderPaymentRecovery() {
    const panel = $('#payment-recovery');
    if (!panel) return;
    panel.classList.toggle('hidden', !paymentRequest && !savedPaymentMarker);
    $('#payment-retry').disabled = paymentPending;
    $('#payment-retry').textContent = savedPaymentMarker ? 'ตรวจผลรายการเดิม (ไม่ส่งรับเงิน)' : 'ตรวจและส่งคำขอเดิมซ้ำ';
    $('#payment-resume-form')?.classList.toggle('hidden', !savedPaymentMarker);
    $('#payment-recovery-message').textContent = savedPaymentMarker
      ? `พบคำขอรับเงินจากก่อนโหลดหน้า — Invoice ${savedPaymentMarker.invoiceId} กรุณาตรวจผลรายการเดิมก่อน ห้ามรับเงินใหม่จนยืนยันผลได้`
      : paymentRequest
      ? `${paymentPending ? 'กำลังตรวจคำขอรับเงิน' : 'ยังไม่ยืนยันผลรับเงิน'} ฿${money(paymentRequest.p_amount)} — Invoice ${paymentRequest.p_invoice_id}`
      : '';
  }

  function restoreSavedPayment() {
    if (!window.ChananyaRuntime.can(profile, 'billing_operate')) return;
    if (!window.CnyosPaymentJournal) throw new Error('ตัวกู้คำขอรับเงินยังไม่พร้อม');
    savedPaymentMarker = window.CnyosPaymentJournal.restore({actorId:session.user.id,clinicId:profile.clinic_id});
    renderPaymentRecovery();
  }

  function restoreSavedServiceInvoice() {
    if (!window.ChananyaRuntime.can(profile, 'billing_operate')) return;
    if (!window.CnyosServiceInvoiceJournal) throw new Error('ตัวกู้คำขอบิลยังไม่พร้อม');
    savedServiceMarker = window.CnyosServiceInvoiceJournal.restore({ actorId: session.user.id, clinicId: profile.clinic_id });
    $('#service-invoice-recovery').classList.toggle('hidden', !savedServiceMarker);
  }

  async function readServiceInvoiceReceipt(marker) {
    const result = await db.from('invoices').select('id,encounter_id,created_by,source_service_request_key,grand_total').eq('source_service_request_key', marker.requestId).single();
    if (result.error || !result.data) throw new Error('ยังไม่พบบิลเดิมที่ตรวจสอบได้ ห้ามออกบิลซ้ำ');
    const invoice = result.data;
    const context = ownerFinance() ? await readOwnerInvoiceContext(invoice.id) : null;
    const encounter = context ? { data: { id: context.encounter_id, clinic_id: context.clinic_id } }
      : await db.from('encounters').select('id,clinic_id').eq('id', invoice.encounter_id).single();
    if (encounter.error || encounter.data?.id !== marker.encounterId) throw new Error('SERVICE_READBACK_MISMATCH');
    const items = await db.from('invoice_items').select('invoice_id,item_type,quantity,unit_price,line_total,description').eq('invoice_id', invoice.id);
    if (items.error) throw new Error('ยังตรวจรายการในบิลเดิมไม่ได้');
    return { invoice, items: items.data, clinicId: encounter.data.clinic_id };
  }

  async function recoverSavedServiceInvoice() {
    if (accountBlocked || serviceRecoveryPending || !savedServiceMarker) return;
    const actorSession = session, actorProfile = profile;
    const isCurrent = () => !accountBlocked && session === actorSession && profile === actorProfile;
    serviceRecoveryPending = true;
    $('#service-invoice-recover').disabled = true;
    try {
      await window.CnyosServiceInvoiceJournal.recover({ actorId: actorSession.user.id, clinicId: actorProfile.clinic_id,
        isCurrent, readInvoice: marker => readServiceInvoiceReceipt(marker) });
      if (!isCurrent()) return;
      serviceInvoiceRequestKeys.delete(savedServiceMarker.encounterId);
      savedServiceMarker = null;
      $('#service-invoice-recovery').classList.add('hidden');
      await loadAll();
      if (isCurrent()) toast('ตรวจพบบิลเดิมแล้ว ไม่มีการออกบิลซ้ำ');
    } finally {
      serviceRecoveryPending = false;
      if (isCurrent()) $('#service-invoice-recover').disabled = false;
    }
  }

  async function resumeSavedServiceInvoice() {
    if (accountBlocked || serviceRecoveryPending || !savedServiceMarker) return;
    const marker = savedServiceMarker, actorSession = session, actorProfile = profile;
    const isCurrent = () => !accountBlocked && session === actorSession && profile === actorProfile && savedServiceMarker === marker;
    serviceRecoveryPending = true;
    $('#service-invoice-resume').disabled = true;
    try {
      const result = await db.rpc('quote_treatment_invoice', { p_encounter_id: marker.encounterId });
      if (!isCurrent()) return;
      if (result.error) throw result.error;
      const quote = Array.isArray(result.data) ? result.data[0] : result.data;
      treatmentQuotes.set(marker.encounterId, quote);
      // prepare compares the authoritative quote with the persisted digest and
      // requires this exact marker to still exist before any issue RPC.
      await createServiceInvoice(marker.encounterId, marker);
    } finally {
      serviceRecoveryPending = false;
      if (!accountBlocked && session === actorSession && profile === actorProfile) $('#service-invoice-resume').disabled = false;
    }
  }

  async function readPaymentReceipt(marker, isCurrent) {
    const payment=await db.from('payments').select('id,request_key,invoice_id,received_by,provider,status,amount,payment_reference,paid_at,channel,gateway_transaction_id').eq('request_key',marker.requestId).single();
    if (!isCurrent()) throw new Error('PAYMENT_CONTEXT_CHANGED');
    if (payment.error || !payment.data) throw new Error('ยังตรวจผลรับเงินเดิมไม่ได้ ห้ามรับเงินซ้ำ');
    const invoice=await db.from('invoices').select('id,patient_id').eq('id',payment.data.invoice_id).single();
    if (!isCurrent()) throw new Error('PAYMENT_CONTEXT_CHANGED');
    if (invoice.error || invoice.data?.id!==marker.invoiceId) throw new Error('PAYMENT_READBACK_MISMATCH');
    const context=ownerFinance() ? await readOwnerInvoiceContext(invoice.data.id) : null;
    const person=context ? {data:{id:context.patient_id,clinic_id:context.clinic_id}}
      : await db.from('patients').select('id,clinic_id').eq('id',invoice.data.patient_id).single();
    if (!isCurrent()) throw new Error('PAYMENT_CONTEXT_CHANGED');
    if (person.error || person.data?.id!==invoice.data.patient_id) throw new Error('PAYMENT_READBACK_MISMATCH');
    return {clinicId:person.data.clinic_id,payment:payment.data};
  }

  async function recoverSavedPayment() {
    if (accountBlocked || paymentPending || !savedPaymentMarker) return;
    const actorSession=session, actorProfile=profile;
    const isCurrent=()=>!accountBlocked && session===actorSession && profile===actorProfile;
    paymentPending=true;
    renderPaymentRecovery();
    try {
      await window.CnyosPaymentJournal.recover({actorId:actorSession.user.id,clinicId:actorProfile.clinic_id,isCurrent,
        readPayment:marker=>readPaymentReceipt(marker,isCurrent)});
      if (!isCurrent()) return;
      savedPaymentMarker=null;
      try {
        await loadAll();
      } catch (error) {
        if (isCurrent()) toast('ตรวจพบการรับเงินเดิมแล้ว ไม่มีการรับเงินซ้ำ แต่โหลดหน้ารายการไม่สำเร็จ กรุณาโหลดรายการใหม่');
        return;
      }
      if (!isCurrent()) return;
      toast('ตรวจพบการรับเงินเดิมแล้ว ไม่มีการรับเงินซ้ำ');
    } finally {
      paymentPending=false;
      if (!accountBlocked) renderPaymentRecovery();
    }
  }

  async function savePayment(event, retryOriginal = false, resumeSaved = false) {
    event.preventDefault();
    if (accountBlocked) return;
    if (paymentPending) return;
    if (resumeSaved && !savedPaymentMarker) throw new Error('ไม่พบคำขอเดิมสำหรับกู้คืน กรุณาตรวจรายการก่อน');
    if (savedPaymentMarker && !resumeSaved) {
      if (retryOriginal) return recoverSavedPayment();
      throw new Error('มีคำขอรับเงินเดิมค้างตรวจผล กรุณาตรวจผลก่อนรับเงินใหม่');
    }
    if (retryOriginal && !paymentRequest) return;
    requireAtomicHandoffs();
    const invoice = data.invoices.find(item => item.id === $('#pay-invoice').value);
    const amount = num($('#pay-amount').value);
    const form = event.currentTarget;
    const resumeMarker=resumeSaved?savedPaymentMarker:null;
    const currentPayload = resumeSaved ? {
      p_invoice_id:resumeMarker.invoiceId,
      p_amount:num($('#resume-amount').value),
      p_channel:$('#resume-channel').value,
      p_reference_note:$('#resume-note').value.trim() || null
    } : retryOriginal ? paymentRequest : {
      p_invoice_id: $('#pay-invoice').value,
      p_amount: amount,
      p_channel: $('#pay-channel').value,
      p_reference_note: $('#pay-note').value.trim() || null
    };
    if (paymentRequest && Object.keys(currentPayload).some(key => currentPayload[key] !== paymentRequest[key])) {
      throw new Error('คำขอรับเงินเดิมยังไม่ยืนยัน กรุณาคงบิล ยอด ช่องทาง และหมายเหตุเดิมเพื่อตรวจผล ห้ามสร้างรายการใหม่');
    }
    if (!paymentRequest && !resumeSaved) {
      if (!invoice) throw new Error('ไม่พบ Invoice');
      if (!Number.isFinite(amount) || amount <= 0 || amount > Number(invoice.balance_due)) throw new Error('จำนวนเงินต้องมากกว่า 0 และไม่เกินยอดคงเหลือ');
    }
    if (!window.CnyosPaymentJournal) throw new Error('ตัวกู้คำขอรับเงินยังไม่พร้อม');
    const actorSession=session, actorProfile=profile;
    const isCurrent=()=>!accountBlocked && session===actorSession && profile===actorProfile;
    paymentPending = true;
    const controls = [...form.querySelectorAll('button, input, select')];
    const disabled = controls.map(control => control.disabled);
    renderPaymentRecovery();
    try {
      controls.forEach(control => { control.disabled = true; });
      const marker=await window.CnyosPaymentJournal.prepare({actorId:actorSession?.user?.id,clinicId:actorProfile?.clinic_id,payload:currentPayload,expectedRequestId:resumeMarker?.requestId ?? paymentRequest?.p_request_key ?? null});
      if (!isCurrent()) return;
      paymentRequest=Object.freeze({...currentPayload,p_request_key:marker.requestId});
      savedPaymentMarker=null;
      form.dataset.requestKey=marker.requestId;
      const payload = paymentRequest;
      renderPaymentRecovery();
      const result = await db.rpc('record_atomic_invoice_payment', payload);
      if (accountBlocked) return;
      if (result.error) throw result.error;
      const payment = Array.isArray(result.data) ? result.data[0] : result.data;
      const balance = payment?.balance_due;
      const validBalance = (typeof balance === 'number' || (typeof balance === 'string' && /^\d+(?:\.\d+)?$/.test(balance)))
        && Number.isFinite(Number(balance)) && Number(balance) >= 0;
      if (!payment?.payment_id || !validBalance) throw new Error('ยังยืนยันผลรับเงินไม่ได้ กรุณาตรวจรายการก่อนลองใหม่');
      const readback = await db.from('payments').select('id,invoice_id,amount,payment_reference').eq('id', payment.payment_id).single();
      if (accountBlocked) return;
      if (readback.error || readback.data?.id !== payment.payment_id || readback.data?.invoice_id !== payload.p_invoice_id || Number(readback.data?.amount) !== payload.p_amount) throw new Error('ส่งรับเงินแล้ว แต่ตรวจอ่านกลับยังไม่สำเร็จ อย่าเปลี่ยนยอดหรือสร้างรายการใหม่');
      await window.CnyosPaymentJournal.recover({actorId:actorSession.user.id,clinicId:actorProfile.clinic_id,isCurrent,readPayment:marker=>readPaymentReceipt(marker,isCurrent)});
      if (!isCurrent()) return;
      paymentRequest = null;
      delete form.dataset.requestKey;
      form.reset();
      try { await loadAll(); }
      catch (_) { toast('รับเงินและตรวจอ่านกลับแล้ว แต่โหลดหน้ารายการไม่สำเร็จ กรุณาโหลดใหม่'); return; }
      toast(Number(payment.balance_due) === 0
        ? (payment.encounter_closed === true ? 'รับชำระและปิด Encounter แล้ว' : 'รับชำระครบแล้ว กรุณาตรวจสถานะงานบริการแยกต่างหาก')
        : 'บันทึกชำระบางส่วนแล้ว');
    } finally {
      paymentPending = false;
      controls.forEach((control, index) => { control.disabled = disabled[index]; });
      if (!accountBlocked) renderPaymentRecovery();
    }
  }

  function resetLock() {
    if (accountBlocked) return;
    clearTimeout(lockTimer);
    lockTimer = setTimeout(() => $('#lock').classList.add('show'), LOCK_MS);
  }

  async function init() {
    try {
      const runtime = window.ChananyaRuntime;
      if (!runtime) throw new Error('ChananyaRuntime ไม่พร้อมใช้งาน');
      db = runtime.getDb();
      session = await runtime.getSession();
      if (accountBlocked) { session = null; return; }
      if (!session) { location.replace('/login.html'); return; }
      watchAccount();
      profile = await runtime.getProfile(session.user.id);
      if (accountBlocked) { profile = null; return; }
      if (!profile) throw new Error('ไม่พบ Profile');
      if (profile.access_context_ready !== true) { runtime.showAccountStatus(profile, session); return; }
      role = runtime.roleOf(profile) || 'viewer';
      applyRole();
      restoreSavedPayment();
      restoreSavedServiceInvoice();
      await detectIdentityBackend();
      if (accountBlocked) return;
      $('#app').classList.remove('hidden');
      $('#boot').classList.add('hidden');
      await loadAll();
      if (accountBlocked) return;
      resetLock();
    } catch (error) {
      if (accountBlocked) return;
      console.error(error);
      $('#boot-error').textContent = error.message;
    }
  }

  $('#main-nav').addEventListener('click', event => {
    const button = event.target.closest('button[data-view]');
    if (button && !button.classList.contains('hidden')) show(button.dataset.view);
  });
  $('#patient-search').addEventListener('input', event => { patientFilter = event.target.value; renderPatients(); });
  $('#service-invoice-recover').addEventListener('click', () => recoverSavedServiceInvoice().catch(fail));
  $('#service-invoice-resume').addEventListener('click', () => resumeSavedServiceInvoice().catch(fail));
  $('#patient-list').addEventListener('click', event => {
    const editButton = event.target.closest('[data-edit-patient]');
    if (editButton) beginPatientEdit(editButton.dataset.editPatient);
    const linkButton = event.target.closest('[data-link-patient]');
    if (linkButton) openIdentityLinkDialog(linkButton.dataset.linkPatient).catch(fail);
  });
  $('#patient-list').addEventListener('change', event => {
    const checkbox = event.target.closest('[data-export-patient]');
    if (!checkbox) return;
    if (checkbox.checked) {
      if (selectedPatientIds.size >= 100) {
        checkbox.checked = false;
        return toast('เลือกได้ไม่เกิน 100 รายการต่อครั้ง');
      }
      selectedPatientIds.add(checkbox.dataset.exportPatient);
    } else selectedPatientIds.delete(checkbox.dataset.exportPatient);
    $('#patient-export-count').textContent = selectedPatientIds.size;
  });
  $('#patient-export-all').addEventListener('click', () => {
    const visible = [...document.querySelectorAll('[data-export-patient]')];
    const remaining = 100 - selectedPatientIds.size;
    if (visible.filter(input => !selectedPatientIds.has(input.dataset.exportPatient)).length > remaining) {
      return toast('เลือกได้ไม่เกิน 100 รายการต่อครั้ง');
    }
    visible.forEach(input => { input.checked = true; selectedPatientIds.add(input.dataset.exportPatient); });
    $('#patient-export-count').textContent = selectedPatientIds.size;
  });
  $('#patient-export-clear').addEventListener('click', () => {
    selectedPatientIds.clear();
    document.querySelectorAll('[data-export-patient]').forEach(input => { input.checked = false; });
    $('#patient-export-count').textContent = '0';
  });
  $('#patient-export-download').addEventListener('click', () => {
    try { downloadSelectedPatients(); } catch (error) { fail(error); }
  });
  $('#patient-form').addEventListener('submit', event => savePatient(event).catch(fail));
  $('#billing-refresh')?.addEventListener('click', refreshBilling);
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
  $('#payment-retry')?.addEventListener('click', () => savePayment({ preventDefault() {}, currentTarget: $('#payment-form') }, true).catch(fail));
  $('#payment-resume-form')?.addEventListener('submit', event => savePayment(event,false,true).catch(fail));
  $('#logout').addEventListener('click', async () => { await db.auth.signOut(); location.replace('/login.html'); });
  $('#unlock').addEventListener('click', () => { $('#lock').classList.remove('show'); resetLock(); });
  ['click', 'keydown', 'touchstart'].forEach(name => document.addEventListener(name, resetLock, { passive: true }));
  // Hide retained clinical/financial UI before a history-cache snapshot is reused.
  window.addEventListener('pagehide', () => blockChangedAccount(true));
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    blockChangedAccount(true);
    // A fresh bootstrap must re-authorize. Never discard an uncertain payment
    // merely to refresh a cached page: reconciliation still belongs to its actor.
    if (!paymentRequest && !savedPaymentMarker) location.reload();
  });
  init();
})();
