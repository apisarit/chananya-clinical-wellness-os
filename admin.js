(() => {
  'use strict';

  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));

  let db;
  let session;
  let profile;
  let systemRole = 'staff';
  let canAdminCenter = false;
  let canManagePrices = false;
  let data = { tasks: [], actions: [], users: [], pharmacyEvents: [], prices: [], summary: {} };

  function toast(message) {
    const element = $('#toast');
    element.textContent = message;
    element.classList.add('show');
    setTimeout(() => element.classList.remove('show'), 2200);
  }

  function fail(error) {
    console.error(error);
    alert(error?.message || String(error));
  }

  async function query(table, select = '*', order) {
    let request = db.from(table).select(select);
    if (order) request = request.order(order, { ascending: false });
    const result = await request;
    if (result.error) throw result.error;
    return result.data || [];
  }

  async function loadPrices() {
    const result = await db.rpc('list_clinic_product_price_completeness');
    if (result.error) throw result.error;
    return result.data || [];
  }

  async function load() {
    if (!canAdminCenter) {
      data = {
        tasks: [], actions: [], users: [], pharmacyEvents: [], summary: {},
        prices: await loadPrices()
      };
      render();
      return;
    }
    const [tasks, actions, users, summaries, pharmacyEvents, prices] = await Promise.all([
      query('approval_tasks', '*', 'requested_at'),
      query('approval_actions', '*', 'acted_at'),
      window.ChananyaRuntime.accountRequest('staff_list').then(result => {
        if (result.truncated) toast('แสดงรายชื่อสูงสุด 500 บัญชี');
        return result.users;
      }),
      query('admin_task_summary'),
      query('dispensing_order_events', '*', 'created_at'),
      loadPrices()
    ]);
    data = { tasks, actions, users, pharmacyEvents, prices, summary: summaries[0] || {} };
    render();
  }

  function options(rows, label) {
    return '<option value="">เลือก</option>' + rows.map(item => `<option value="${esc(item.id ?? item.product_id)}">${esc(label(item))}</option>`).join('');
  }

  function renderTasks() {
    const active = data.tasks.filter(task => ['pending', 'in_review'].includes(task.status));
    $('#task-list').innerHTML = active.map(task => {
      const actions = [];
      if (task.status === 'pending') actions.push(`<button class="btn ghost" data-task-action="take" data-id="${esc(task.id)}">รับตรวจ</button>`);
      actions.push(`<button class="btn primary" data-task-action="approve" data-id="${esc(task.id)}">อนุมัติ</button>`);
      actions.push(`<button class="btn danger" data-task-action="reject" data-id="${esc(task.id)}">ปฏิเสธ</button>`);
      return `<article class="item column"><div class="row"><b>${esc(task.task_no)} • ${esc(task.title)}</b><span class="badge">${esc(task.priority)} / ${esc(task.status)}</span></div><small>${esc(task.module)} • ${esc(task.task_type)} • ${new Date(task.requested_at).toLocaleString('th-TH')}</small><p>${esc(task.description || '')}</p><div class="right">${actions.join('')}</div></article>`;
    }).join('') || '<p class="muted">ไม่มีงานรออนุมัติ</p>';
  }

  function renderUsers() {
    $('#user-list').innerHTML = data.users.map(user => `<article class="item"><div><b>${esc(user.full_name || user.id)}</b><small>${esc(user.email || '')}</small><small>Operational: ${esc(user.role)} • System: ${esc(user.system_role)} • Effective: ${esc(user.effective_role)}</small></div><span class="badge">${esc(user.access_status === 'pending_approval' ? 'รอกำหนดสิทธิ์' : user.access_status === 'inactive' ? 'ระงับสมาชิก' : user.effective_role)}</span></article>`).join('') || '<p class="muted">ไม่พบผู้ใช้</p>';
  }

  function renderActions() {
    $('#action-list').innerHTML = data.actions.map(action => `<article class="item"><div><b>${esc(action.action)} • ${esc(action.from_status || '-')} → ${esc(action.to_status || '-')}</b><small>${new Date(action.acted_at).toLocaleString('th-TH')} • ${esc(action.notes || '')}</small></div></article>`).join('') || '<p class="muted">ยังไม่มีประวัติ</p>';
    const userById = new Map(data.users.map(user => [user.id, user]));
    $('#pharmacy-event-list').innerHTML = data.pharmacyEvents.map(event => {
      const actor = userById.get(event.actor_id);
      const actorLabel = actor?.full_name || actor?.email || event.actor_id;
      return `<article class="item column"><div class="row"><div><b>Pharmacy • ${esc(event.from_status)} → ${esc(event.to_status)}</b><small>${esc(event.action)} • ${new Date(event.created_at).toLocaleString('th-TH')}</small></div><span class="badge">${esc(event.actor_role)}</span></div><small>ผู้ปฏิบัติงาน: ${esc(actorLabel)} • Actor ${esc(event.actor_id)}</small><small>Rx ${esc(event.prescription_id)} • Order ${esc(event.dispensing_order_id)}</small>${event.reason ? `<p>เหตุผล: ${esc(event.reason)}</p>` : ''}</article>`;
    }).join('') || '<p class="muted">ยังไม่มีประวัติการส่งต่อห้องยา</p>';
  }

  function renderPrices() {
    const ready = data.prices.filter(item => item.price_ready === true);
    const missing = data.prices.filter(item => item.price_ready !== true);
    $('#price-ready-count').textContent = ready.length;
    $('#price-missing-count').textContent = missing.length;
    $('#price-blocking-message').textContent = missing.length
      ? `ยังขาดราคา ${missing.length} รายการ — ห้องยาจะจ่ายรายการเหล่านี้ไม่ได้จนกว่า Billing/Governance จะกำหนดราคา`
      : 'Price Master ครบสำหรับผลิตภัณฑ์ที่เปิดใช้งานทั้งหมด';
    $('#price-blocking-message').classList.toggle('danger-text',missing.length > 0);

    const sorted = [...data.prices].sort((a,b) =>
      Number(a.price_ready) - Number(b.price_ready)
      || String(a.sku || '').localeCompare(String(b.sku || ''))
    );
    $('#price-product').innerHTML = options(sorted,item =>
      `${item.sku || '-'} · ${item.name_th || '-'}${item.price_ready ? ` · ฿${Number(item.unit_price).toFixed(2)}` : ' · ขาดราคา'}`
    );
    $('#price-master-list').innerHTML = sorted.map(item => {
      const state = item.price_ready
        ? `<span class="badge">พร้อม · ฿${Number(item.unit_price).toFixed(2)} THB/${esc(item.dispense_unit)}</span>`
        : '<span class="badge danger-text">ขาดราคา · Blocking</span>';
      return `<article class="item column"><div class="row"><div><b>${esc(item.sku)} • ${esc(item.name_th)}</b><small>อัตราแปลง: 1 ${esc(item.dispense_unit)} = ${esc(item.conversion_factor)} ${esc(item.stock_unit)} (หน่วยสต็อกฐานต่อ 1 หน่วยจ่าย)</small></div>${state}</div><div class="right"><button type="button" class="btn ghost" data-price-product="${esc(item.product_id)}">${item.price_ready ? 'แก้ราคา' : 'กำหนดราคา'}</button></div></article>`;
    }).join('') || '<p class="muted">ไม่มีผลิตภัณฑ์ที่เปิดใช้งาน</p>';
  }

  function render() {
    if (canAdminCenter) {
      const summary = data.summary;
      $('#stat-pending').textContent = summary.pending || 0;
      $('#stat-review').textContent = summary.in_review || 0;
      $('#stat-urgent').textContent = summary.urgent || 0;
      $('#stat-overdue').textContent = summary.overdue || 0;
      $('#stat-approved').textContent = summary.approved_today || 0;
      const label = user => `${user.full_name || user.id} · ${user.email || ''} — ${user.access_status === 'pending_approval' ? 'รอกำหนดสิทธิ์' : user.effective_role || user.role}`;
      const userOptions = options(data.users, label);
      $('#staff-user').innerHTML = userOptions;
      $('#system-user').innerHTML = options(data.users.filter(user => user.access_status === 'active'), label);
      $('#super-admin-card').classList.toggle('hidden', systemRole !== 'super_admin');
      renderTasks();
      renderUsers();
      renderActions();
    }
    renderPrices();
    window.dispatchEvent(new CustomEvent('chananya:admin-rendered'));
  }

  async function decide(taskId, action) {
    if (!canAdminCenter) throw new Error('บัญชีนี้ไม่มีสิทธิ์ Admin Task Center');
    const notes = prompt('หมายเหตุการตัดสินใจ', '') ?? '';
    const result = await db.rpc('decide_approval_task', { p_task_id: taskId, p_action: action, p_notes: notes });
    if (result.error) throw result.error;
    await load();
    toast('บันทึกการตัดสินใจแล้ว');
  }

  async function saveTask(event) {
    event.preventDefault();
    if (!canAdminCenter) throw new Error('บัญชีนี้ไม่มีสิทธิ์ Admin Task Center');
    const due = $('#task-due').value;
    const result = await db.rpc('create_approval_task', {
      p_task_type: $('#task-type').value.trim(),
      p_module: $('#task-module').value,
      p_title: $('#task-title').value.trim(),
      p_description: $('#task-description').value.trim() || null,
      p_priority: $('#task-priority').value,
      p_reference_type: null,
      p_reference_id: null,
      p_due_at: due ? new Date(due).toISOString() : null,
      p_metadata: { source: 'admin_task_center' }
    });
    if (result.error) throw result.error;
    event.target.reset();
    await load();
    toast('สร้าง Task แล้ว');
  }

  async function saveStaffRole(event) {
    event.preventDefault();
    if (!canAdminCenter) throw new Error('บัญชีนี้ไม่มีสิทธิ์จัดการผู้ใช้');
    const result = await db.rpc('admin_assign_staff_role', {
      p_user_id: $('#staff-user').value,
      p_role: $('#staff-role').value,
      p_reason: $('#staff-reason').value.trim() || null
    });
    if (result.error) throw result.error;
    event.target.reset();
    await load();
    toast('บันทึก Role แล้ว');
  }

  async function saveSystemRole(event) {
    event.preventDefault();
    if (!canAdminCenter) throw new Error('บัญชีนี้ไม่มีสิทธิ์จัดการ System Role');
    const result = await db.rpc('super_admin_set_system_role', {
      p_user_id: $('#system-user').value,
      p_system_role: $('#system-role').value,
      p_reason: $('#system-reason').value.trim() || null
    });
    if (result.error) throw result.error;
    event.target.reset();
    await load();
    toast('บันทึก System Role แล้ว');
  }

  async function savePrice(event) {
    event.preventDefault();
    if (!canManagePrices) throw new Error('บัญชีนี้ไม่มีสิทธิ์จัดการ Price Master');
    const productId = $('#price-product').value;
    const unitPrice = Number($('#price-unit-price').value);
    const reason = $('#price-reason').value.trim();
    if (!productId) throw new Error('กรุณาเลือกผลิตภัณฑ์');
    if (!Number.isFinite(unitPrice) || unitPrice < 100 || unitPrice > 2000) {
      throw new Error('ราคาต้องอยู่ระหว่าง 100–2,000 บาท');
    }
    if (!reason) throw new Error('กรุณาระบุเหตุผลหรือหลักฐานอนุมัติราคา');
    const result = await db.rpc('set_clinic_product_price', {
      p_product_id: productId,
      p_unit_price: unitPrice,
      p_currency: 'THB',
      p_reason: reason
    });
    if (result.error) throw result.error;
    event.target.reset();
    $('#price-currency').value = 'THB';
    await load();
    toast('บันทึกราคา THB และ Audit แล้ว');
  }

  function showView(view) {
    $$('#admin-nav button').forEach(button => button.classList.toggle('active', button.dataset.view === view));
    $$('.view').forEach(section => section.classList.toggle('active', section.id === view));
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
      systemRole = runtime.rolesOf(profile).systemRole;
      canAdminCenter = runtime.can(profile, 'admin_center');
      canManagePrices = runtime.can(profile, 'price_master_manage');
      if (!canAdminCenter && !canManagePrices) {
        throw new Error('บัญชีนี้ไม่มีสิทธิ์ Admin Task Center หรือ Price Master');
      }
      const pricesOnly = !canAdminCenter;
      window.ChananyaShell?.mount({
        profile,
        session,
        active: pricesOnly || location.hash === '#prices' ? 'prices' : 'admin'
      });
      $('#app').classList.remove('hidden');
      $('#boot').classList.add('hidden');
      if (pricesOnly) {
        $$('#admin-nav button').forEach(button => {
          if (button.dataset.view !== 'prices') button.remove();
        });
        $$('.view').forEach(section => {
          if (section.id !== 'prices') section.remove();
        });
        showView('prices');
      } else if (location.hash === '#prices') {
        showView('prices');
      }
      await load();
    } catch (error) {
      console.error(error);
      $('#boot-error').textContent = error.message;
    }
  }

  $('#admin-nav').addEventListener('click', event => {
    const button = event.target.closest('button[data-view]');
    if (button) showView(button.dataset.view);
  });
  $('#task-list').addEventListener('click', event => {
    const button = event.target.closest('[data-task-action]');
    if (button) decide(button.dataset.id, button.dataset.taskAction).catch(fail);
  });
  $('#task-form').addEventListener('submit', event => saveTask(event).catch(fail));
  $('#staff-role-form').addEventListener('submit', event => saveStaffRole(event).catch(fail));
  $('#system-role-form').addEventListener('submit', event => saveSystemRole(event).catch(fail));
  $('#price-master-form').addEventListener('submit', event => savePrice(event).catch(fail));
  $('#price-master-list').addEventListener('click', event => {
    const button = event.target.closest('[data-price-product]');
    if (!button) return;
    const item = data.prices.find(price => price.product_id === button.dataset.priceProduct);
    $('#price-product').value = button.dataset.priceProduct;
    $('#price-unit-price').value = item?.unit_price ?? '';
    $('#price-reason').focus();
  });
  $('#refresh-prices').addEventListener('click', async event => {
    event.currentTarget.disabled = true;
    try { await load(); toast('ตรวจ Price Master ใหม่แล้ว'); } catch (error) { fail(error); }
    finally { event.currentTarget.disabled = false; }
  });
  $('#refresh-users').addEventListener('click', async event => {
    event.currentTarget.disabled = true;
    try { await load(); } catch (error) { fail(error); }
    finally { $('#refresh-users').disabled = false; }
  });
  $('#logout').addEventListener('click', async () => { await db.auth.signOut(); location.replace('/login.html'); });
  init();
})();
