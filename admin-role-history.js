(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const actions = ['assign_staff_role', 'assign_department_role', 'set_system_role'];
  const fields = 'id,occurred_at,user_id,entity_id,action,old_role:metadata->>old_role,new_role:metadata->>new_role,old_profile_role:metadata->>old_profile_role,old_clinic_role:metadata->>old_clinic_role,new_clinic_role:metadata->>new_clinic_role,old_system_role:metadata->>old_system_role,new_system_role:metadata->>new_system_role,reason:metadata->>reason';
  const pageSize = 50;
  let rows = [], cursor = null, scope = null, version = 0, pending = false, more = false;
  let accountBlocked = false, watchedActor = null;
  function watchAccount(runtime, actor) {
    if (watchedActor) return;
    watchedActor = actor;
    runtime.getDb().auth.onAuthStateChange((event, next) => {
      if (event !== 'SIGNED_OUT' && next?.user?.id === watchedActor) return;
      accountBlocked = true;
      version++;
      rows = []; cursor = null; scope = null; pending = false; more = false;
      $('#role-history-list').textContent = '';
      $('#role-history-status').textContent = 'บัญชีเปลี่ยนหรือหมดอายุ กรุณาเปิดหน้าใหม่และเข้าสู่ระบบ';
      $('#role-history-more').disabled = true;
      $('#role-history-refresh').disabled = true;
    });
  }
  const value = input => input == null || input === '' ? 'ไม่มีค่าบันทึก' : String(input);
  function render() {
    $('#role-history-list').innerHTML = rows.map(row => {
      const changes = row.action === 'set_system_role'
        ? [['System role', row.old_system_role, row.new_system_role]]
        : row.action === 'assign_department_role'
          ? [['บทบาทในคลินิก', row.old_clinic_role, row.new_clinic_role], ['บทบาท Profile เดิม', row.old_profile_role, null, true]]
          : [['บทบาท', row.old_role, row.new_role]];
      return `<article class="item column"><b>${esc(row.action)}</b><small>${esc(new Date(row.occurred_at).toLocaleString('th-TH'))} • ผู้เปลี่ยน ${esc(row.user_id || 'ไม่ระบุ')}</small><p>บัญชีที่เปลี่ยน: ${esc(row.entity_id || 'ไม่ระบุ')}</p>${changes.map(([label, before, after, previousOnly]) => `<p>${esc(label)}: ${esc(value(before))}${previousOnly ? '' : ` → ${esc(value(after))}`}</p>`).join('')}<p>เหตุผล: ${esc(row.reason || 'ไม่มีเหตุผลบันทึกไว้')}</p></article>`;
    }).join('') || '<p class="muted">ไม่พบประวัติเปลี่ยนสิทธิ์ในขอบเขตที่บัญชีนี้อ่านได้ ไม่ใช่การยืนยันว่าไม่มีการเปลี่ยนแปลงในระบบ</p>';
  }
  async function load(append = false) {
    if (accountBlocked) return;
    if (append && (pending || !more)) return;
    const request = ++version;
    pending = true;
    $('#role-history-more').disabled = true;
    $('#role-history-status').textContent = 'กำลังโหลดประวัติเปลี่ยนสิทธิ์…';
    if (!append) { rows = []; cursor = null; more = false; $('#role-history-list').textContent = ''; }
    try {
      const runtime = window.ChananyaRuntime;
      const session = await runtime?.getSession();
      if (request !== version) return;
      if (!session) { append = false; more = false; throw new Error('AUTH_REQUIRED'); }
      watchAccount(runtime, session.user.id);
      if (accountBlocked) return;
      const profile = await runtime.getProfile(session.user.id);
      if (request !== version) return;
      if (!profile?.clinic_id || !runtime.can(profile, 'admin_center')) { append = false; more = false; throw new Error('ACCESS_REQUIRED'); }
      if (request !== version) return;
      const nextScope = `${session.user.id}:${profile.clinic_id}`;
      if (scope !== nextScope) { rows = []; cursor = null; more = false; append = false; $('#role-history-list').textContent = ''; }
      scope = nextScope;
      let query = runtime.getDb().from('audit_logs').select(fields)
        .eq('clinic_id', profile.clinic_id).in('action', actions)
        .order('id', { ascending: false }).limit(pageSize + 1);
      if (append && cursor) query = query.lt('id', cursor);
      const result = await query;
      if (request !== version) return;
      if (result.error) throw result.error;
      if (!Array.isArray(result.data) || result.data.length > pageSize + 1) throw new Error('INVALID_HISTORY');
      let previousId = append && cursor ? BigInt(cursor) : null;
      for (const row of result.data) {
        if (!row || !actions.includes(row.action) || !/^[1-9]\d*$/.test(String(row.id)) ||
            (typeof row.id === 'number' && !Number.isSafeInteger(row.id))) throw new Error('INVALID_HISTORY');
        const id = BigInt(row.id);
        if (previousId !== null && id >= previousId) throw new Error('INVALID_HISTORY');
        previousId = id;
      }
      const page = result.data.slice(0, pageSize);
      rows = append ? rows.concat(page) : page;
      more = result.data.length > pageSize;
      cursor = page.length ? String(page[page.length - 1].id) : cursor;
      render();
      $('#role-history-status').textContent = `แสดง ${rows.length} รายการ${more ? ' • ยังมีรายการเก่า กดโหลดเพิ่มเติม' : ' • โหลดครบในขอบเขตสิทธิ์และตัวกรองนี้'} — เป็นบันทึกการเปลี่ยนสิทธิ์ ไม่ใช่คำอนุมัติอิสระ`;
    } catch {
      if (request !== version) return;
      if (!append) { rows = []; $('#role-history-list').textContent = 'ยังยืนยันรายการประวัติไม่ได้'; }
      $('#role-history-status').textContent = 'โหลดประวัติไม่สำเร็จ กรุณาตรวจการเข้าสู่ระบบและสิทธิ์ แล้วกดโหลดใหม่';
    } finally {
      if (request === version) { pending = false; $('#role-history-more').disabled = !more; }
    }
  }
  $('#role-history-refresh').addEventListener('click', () => load());
  $('#role-history-more').addEventListener('click', () => load(true));
  $('#admin-nav').addEventListener('click', event => {
    if (event.target.closest('[data-view="history"]')) load();
  });
})();
