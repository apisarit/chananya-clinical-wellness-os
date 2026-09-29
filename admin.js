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
  let data = { tasks: [], actions: [], users: [], summary: {} };
  let sourceState = { tasks: 'idle', actions: 'idle', users: 'idle', summary: 'idle' };
  let sourceErrors = {};
  let loadVersion = 0;
  let accountBlocked = false;

  function requireAccount() {
    if (accountBlocked) throw new Error('บัญชีเปลี่ยนหรือหมดอายุ กรุณาเข้าสู่ระบบใหม่');
  }

  function blockAccount() {
    if (accountBlocked) return;
    accountBlocked = true;
    loadVersion++;
    data = { tasks: [], actions: [], users: [], summary: {} };
    sourceErrors = {};
    sourceState = { tasks: 'idle', actions: 'idle', users: 'idle', summary: 'idle' };
    $('#app').inert = true;
    $('#app').classList.add('hidden');
    ['#task-list', '#action-list', '#user-list', '#toast'].forEach(selector => { $(selector).textContent = ''; });
    $$('#app input, #app textarea, #app select').forEach(input => {
      input.value = ''; input.checked = false;
      if (input.tagName === 'SELECT') input.innerHTML = '';
    });
    $('#boot').classList.remove('hidden');
    $('#boot-error').textContent = 'บัญชีเปลี่ยนหรือหมดอายุ กรุณาเปิดหน้าใหม่และเข้าสู่ระบบก่อนจัดการสิทธิ์';
  }

  function watchAccount() {
    const actor = session.user.id;
    // Keep auth callbacks synchronous; no API calls while the auth lock is held.
    db.auth.onAuthStateChange((event, next) => {
      if (event === 'SIGNED_OUT' || !next?.user?.id || next.user.id !== actor) blockAccount();
    });
  }

  function toast(message) {
    if (accountBlocked) return;
    const element = $('#toast');
    element.textContent = message;
    element.classList.add('show');
    setTimeout(() => element.classList.remove('show'), 2200);
  }

  function fail(error) {
    if (accountBlocked) return;
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

  async function load() {
    if (accountBlocked) return false;
    const version = ++loadVersion;
    sourceState = { tasks: 'loading', actions: 'loading', users: 'loading', summary: 'loading' };
    sourceErrors = {};
    data = { tasks: [], actions: [], users: [], summary: {} };
    render();
    const loaders = [
      () => query('approval_tasks', '*', 'requested_at'),
      () => query('approval_actions', '*', 'acted_at'),
      () => window.ChananyaRuntime.accountRequest('staff_list').then(result => {
        if (version === loadVersion && result.truncated) toast('แสดงรายชื่อสูงสุด 500 บัญชี');
        return result.users;
      }),
      () => query('admin_task_summary')
    ];
    const keys = ['tasks', 'actions', 'users', 'summary'];
    await Promise.all(keys.map(async (key, index) => {
      try {
        const value = await loaders[index]();
        if (version !== loadVersion) return;
        data[key] = key === 'summary' ? (value[0] || {}) : (value || []);
        sourceState[key] = 'ready';
      } catch (error) {
        if (version !== loadVersion) return;
        data[key] = key === 'summary' ? {} : [];
        sourceState[key] = 'error';
        sourceErrors[key] = error?.message || String(error || 'ไม่ทราบสาเหตุ');
      }
      render();
    }));
    if (version !== loadVersion) return false;
    return !Object.values(sourceState).includes('error');
  }

  function options(rows, label) {
    return '<option value="">เลือก</option>' + rows.map(item => `<option value="${esc(item.id)}">${esc(label(item))}</option>`).join('');
  }

  function renderTasks() {
    if (sourceState.tasks === 'loading') { $('#task-list').innerHTML = '<p class="muted">กำลังโหลดงาน…</p>'; return; }
    if (sourceState.tasks === 'error') { $('#task-list').innerHTML = `<p class="muted">โหลดงานไม่สำเร็จ: ${esc(sourceErrors.tasks)} · กดโหลดประวัติใหม่เพื่อลองอีกครั้ง</p>`; return; }
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
    if (sourceState.users === 'loading') { $('#user-list').innerHTML = '<p class="muted">กำลังโหลดรายชื่อ…</p>'; return; }
    if (sourceState.users === 'error') { $('#user-list').innerHTML = `<p class="muted">โหลดรายชื่อไม่สำเร็จ: ${esc(sourceErrors.users)} · กดโหลดรายชื่อใหม่เพื่อลองอีกครั้ง</p>`; return; }
    $('#user-list').innerHTML = data.users.map(user => `<article class="item"><div><b>${esc(user.full_name || user.id)}</b><small>${esc(user.email || '')}</small><small>Operational: ${esc(user.role)} • System: ${esc(user.system_role)} • Effective: ${esc(user.effective_role)}</small></div><span class="badge">${esc(user.access_status === 'pending_approval' ? 'รอกำหนดสิทธิ์' : user.access_status === 'inactive' ? 'ระงับสมาชิก' : user.effective_role)}</span></article>`).join('') || '<p class="muted">ไม่พบผู้ใช้</p>';
  }

  function renderActions() {
    if (sourceState.actions === 'loading') {
      $('#history-status').textContent = 'กำลังโหลดประวัติการอนุมัติ…';
      $('#action-list').innerHTML = '<p class="muted">กำลังโหลดประวัติ…</p>';
      return;
    }
    if (sourceState.actions === 'error') {
      $('#history-status').textContent = 'โหลดประวัติการอนุมัติไม่สำเร็จ';
      $('#action-list').innerHTML = `<p class="muted">${esc(sourceErrors.actions)} · กด “โหลดประวัติใหม่” เพื่อลองอีกครั้ง</p>`;
      return;
    }
    $('#history-status').textContent = 'ข้อมูลจาก Approval Actions — แสดงการเปลี่ยนสถานะและผู้ดำเนินการ';
    $('#action-list').innerHTML = data.actions.map(action => {
      const task = data.tasks.find(item => item.id === action.task_id);
      const actor = data.users.find(item => item.id === action.action_by);
      return `<article class="item column"><b>${esc(task?.task_no || action.task_id)} • ${esc(task?.title || 'งานที่อยู่ในขอบเขตสิทธิ์')}</b><p>${esc(action.action)} • ${esc(action.from_status || 'ยังไม่มีสถานะ')} → ${esc(action.to_status || 'ไม่ระบุสถานะ')}</p><small>${esc(new Date(action.acted_at).toLocaleString('th-TH'))} • ผู้ดำเนินการ ${esc(actor?.full_name || action.action_by || 'ไม่มีข้อมูลผู้ดำเนินการ')}</small><p>${esc(action.notes || 'ไม่มีหมายเหตุ')}</p></article>`;
    }).join('') || '<p class="muted">ไม่พบการตัดสินใจของ Approval Task ในขอบเขตสิทธิ์นี้ • ประวัติเปลี่ยนราคาดูที่แท็บราคาบริการและยา</p>';
  }

  function render() {
    const summary = data.summary;
    const stat = (key, fallback = '—') => sourceState.summary === 'ready' ? (summary[key] || 0) : fallback;
    $('#stat-pending').textContent = stat('pending');
    $('#stat-review').textContent = stat('in_review');
    $('#stat-urgent').textContent = stat('urgent');
    $('#stat-overdue').textContent = stat('overdue');
    $('#stat-approved').textContent = stat('approved_today');
    const label = user => `${user.full_name || user.id} · ${user.email || ''} — ${user.access_status === 'pending_approval' ? 'รอกำหนดสิทธิ์' : user.effective_role || user.role}`;
    const selectedStaff = $('#staff-user').value;
    const selectedSystem = $('#system-user').value;
    const userOptions = options(data.users, label);
    $('#staff-user').innerHTML = userOptions;
    $('#system-user').innerHTML = options(data.users.filter(user => user.access_status === 'active'), label);
    $('#staff-user').value = data.users.some(user => user.id === selectedStaff) ? selectedStaff : '';
    $('#system-user').value = data.users.some(user => user.id === selectedSystem && user.access_status === 'active') ? selectedSystem : '';
    $('#super-admin-card').classList.toggle('hidden', systemRole !== 'super_admin');
    renderTasks();
    renderUsers();
    renderActions();
    window.dispatchEvent(new CustomEvent('chananya:admin-rendered'));
  }

  async function decide(taskId, action) {
    requireAccount();
    const notes = prompt('หมายเหตุการตัดสินใจ', '');
    if (notes === null) return;
    requireAccount();
    const result = await db.rpc('decide_approval_task', { p_task_id: taskId, p_action: action, p_notes: notes });
    if (accountBlocked) return;
    if (result.error) throw result.error;
    await load();
    toast('บันทึกการตัดสินใจแล้ว');
  }

  async function saveTask(event) {
    event.preventDefault();
    requireAccount();
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
    if (accountBlocked) return;
    if (result.error) throw result.error;
    event.target.reset();
    await load();
    toast('สร้าง Task แล้ว');
  }

  async function saveStaffRole(event) {
    event.preventDefault();
    requireAccount();
    const result = await db.rpc('admin_assign_staff_role', {
      p_user_id: $('#staff-user').value,
      p_role: $('#staff-role').value,
      p_reason: $('#staff-reason').value.trim() || null
    });
    if (accountBlocked) return;
    if (result.error) throw result.error;
    event.target.reset();
    await load();
    toast('บันทึก Role แล้ว');
  }

  async function saveSystemRole(event) {
    event.preventDefault();
    requireAccount();
    const result = await db.rpc('super_admin_set_system_role', {
      p_user_id: $('#system-user').value,
      p_system_role: $('#system-role').value,
      p_reason: $('#system-reason').value.trim() || null
    });
    if (accountBlocked) return;
    if (result.error) throw result.error;
    event.target.reset();
    await load();
    toast('บันทึก System Role แล้ว');
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
      watchAccount();
      if (accountBlocked) return;
      profile = await runtime.getProfile(session.user.id);
      if (accountBlocked) { profile = null; return; }
      if (!profile) throw new Error('ไม่พบ Profile');
      systemRole = runtime.rolesOf(profile).systemRole;
      if (!runtime.can(profile, 'admin_center')) throw new Error('บัญชีนี้ไม่มีสิทธิ์ Admin Task Center');
      window.ChananyaShell?.mount({ profile, session, active: 'admin' });
      $('#app').classList.remove('hidden');
      $('#boot').classList.add('hidden');
      await load();
    } catch (error) {
      if (accountBlocked) return;
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
  $('#refresh-users').addEventListener('click', async event => {
    event.currentTarget.disabled = true;
    try { await load(); } catch (error) { fail(error); }
    finally { $('#refresh-users').disabled = false; }
  });
  $('#refresh-history').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try { await load(); } catch (error) { fail(error); }
    finally { button.disabled = false; }
  });
  $('#logout').addEventListener('click', async () => { await db.auth.signOut(); location.replace('/login.html'); });
  init();
})();
