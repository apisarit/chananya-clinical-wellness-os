(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const money = value => Number(value).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let db;
  let rows = [];
  let selected = null;
  let pending = false;
  let loaded = false;
  let historyVersion = 0;
  let actorId = null;
  let observedActor;
  let accountBlocked = false;
  const message = text => { $('#price-status').textContent = accountBlocked
    ? 'บัญชีผู้ใช้เปลี่ยนหรือออกจากระบบแล้ว กรุณาโหลดหน้าใหม่ก่อนดูหรือแก้ราคา' : text; };
  function invalidateAccount() {
    accountBlocked = true;
    rows = []; selected = null; loaded = false; historyVersion += 1;
    $('#price-list').innerHTML = '';
    $('#price-history').innerHTML = '';
    $('#price-history').textContent = '';
    for (const selector of ['#price-search','#price-item-label','#price-amount','#price-unit','#price-reason','#price-setup-reason']) $(selector).value = '';
    $('#price-setup-form').classList.add('hidden');
    setPending(true);message('');
  }
  function failure(error) {
    const code = String(error?.message || '');
    if (code.includes('VERSION_CONFLICT')) return 'ราคาถูกแก้โดยผู้อื่น กรุณาโหลดราคาใหม่แล้วเลือกอีกครั้ง';
    if (code.includes('ADMIN_REQUIRED') || code.includes('PERMISSION_DENIED')) return 'เฉพาะ Owner/Admin ของคลินิกนี้ที่แก้ราคาได้';
    if (code.includes('UNIT_MISMATCH')) return 'หน่วยขายเปลี่ยนแล้ว กรุณาโหลดรายการใหม่';
    return 'ไม่สามารถโหลดหรือบันทึกราคาได้ กรุณาตรวจสิทธิ์และความพร้อมของระบบ แล้วลองใหม่';
  }
  async function rpc(name, args = {}) {
    if (accountBlocked) throw new Error('ACCOUNT_CHANGED');
    if (!db) {
      const runtime = window.ChananyaRuntime;
      if (!runtime) throw new Error('AUTH_REQUIRED');
      db = runtime.getDb();
      if (!db?.auth?.onAuthStateChange) { invalidateAccount(); throw new Error('AUTH_WATCH_REQUIRED'); }
      // Synchronous invalidation only: no awaited auth calls inside the callback.
      db.auth.onAuthStateChange((event, next) => {
        const id = next?.user?.id || null;
        if (event === 'SIGNED_OUT' || !id || (actorId && id !== actorId)
          || (observedActor && id !== observedActor)) invalidateAccount();
        observedActor = id;
      });
      let session;
      try { session = await runtime.getSession(); }
      catch (error) { invalidateAccount(); throw error; }
      actorId = session?.user?.id || null;
      if (!actorId || accountBlocked || (observedActor !== undefined && observedActor !== actorId)) {
        invalidateAccount();throw new Error('ACCOUNT_CHANGED');
      }
    }
    if (!actorId || accountBlocked) { invalidateAccount(); throw new Error('ACCOUNT_CHANGED'); }
    const result = await db.rpc(name, args);
    if (accountBlocked) throw new Error('ACCOUNT_CHANGED');
    if (result.error) throw result.error;
    return result.data || [];
  }
  function setPending(value) {
    pending = value;
    value = value || accountBlocked;
    $('#price-refresh').disabled = value;
    $('#price-save').disabled = value || !selected;
    $('#price-setup-form button').disabled = value;
    ['#price-amount', '#price-reason', '#price-setup-reason'].forEach(selector => { $(selector).disabled = value; });
    $('#price-list').querySelectorAll('button').forEach(button => { button.disabled = value; });
  }
  function render() {
    if (accountBlocked) return;
    const term = $('#price-search').value.trim().toLocaleLowerCase('th-TH');
    $('#price-list').innerHTML = rows.map((row, index) => ({ row, index }))
      .filter(({ row }) => row.item_type && String(row.item_description).toLocaleLowerCase('th-TH').includes(term))
      .map(({ row, index }) => `<article class="item"><div><b>${esc(row.item_description)}</b><small>${row.item_type === 'service' ? 'บริการ' : 'ยา/ผลิตภัณฑ์'} • ${esc(row.price_list_name)} • ${esc(row.unit_code)} • ${row.unit_price == null ? 'ยังไม่ได้ตั้งราคา — ห้ามออกบิล' : `฿${money(row.unit_price)} / ${esc(row.unit_code)}`} • รุ่น ${esc(row.item_version || 0)}</small></div><button class="btn ghost" type="button" data-price-index="${index}"${pending ? ' disabled' : ''}>ราคา / ประวัติ</button></article>`).join('') || '<p class="muted">ไม่มีรายการตรงเงื่อนไข</p>';
  }
  async function load() {
    if (pending || accountBlocked) return;
    setPending(true);
    message('กำลังโหลดราคากลาง…');
    selected = null;
    historyVersion += 1;
    $('#price-edit-form').reset();
    $('#price-history').textContent = 'เลือกรายการเพื่อดูประวัติ';
    try {
      const result = await rpc('list_price_master');
      if (accountBlocked) return false;
      rows = result;
      loaded = true;
      $('#price-setup-form').classList.toggle('hidden', rows.length > 0);
      render();
      message(`โหลด ${rows.filter(row => row.item_type).length} รายการแล้ว • ราคาที่บันทึกไว้ในบิลเดิมไม่เปลี่ยน`);
      return true;
    } catch (error) {
      if (accountBlocked) return false;
      rows = [];
      loaded = false;
      render();
      $('#price-setup-form').classList.add('hidden');
      message(failure(error));
      return false;
    } finally { setPending(false); }
  }
  async function select(index) {
    if (pending || accountBlocked || !rows[index]?.item_type) return;
    selected = rows[index];
    const version = ++historyVersion;
    $('#price-item-label').value = selected.item_description;
    $('#price-amount').value = selected.unit_price ?? '';
    $('#price-unit').value = selected.unit_code || '';
    $('#price-reason').value = '';
    $('#price-save').disabled = false;
    $('#price-history').textContent = 'กำลังโหลดประวัติ…';
    try {
      const history = selected.item_id ? await rpc('list_price_master_history', { p_item_id: selected.item_id }) : [];
      if (version !== historyVersion) return;
      $('#price-history').innerHTML = history.map(item => `<article class="item column"><b>${esc(item.action)} • ${item.before_state?.unit_price == null ? 'ยังไม่มีราคา' : `฿${money(item.before_state.unit_price)}`} → ${item.after_state?.unit_price == null ? 'ตั้งต้นรายการ' : `฿${money(item.after_state.unit_price)}`}</b><small>${esc(new Date(item.created_at).toLocaleString('th-TH'))} • ผู้บันทึก ${esc(item.actor_id)}</small><p>${esc(item.reason)}</p></article>`).join('') || '<p class="muted">ยังไม่มีประวัติราคาสำหรับรายการนี้</p>';
    } catch (error) { if (version === historyVersion) $('#price-history').textContent = failure(error); }
  }
  async function save(event) {
    event.preventDefault();
    if (pending || accountBlocked || !selected) return;
    const amount = Number($('#price-amount').value);
    const reason = $('#price-reason').value.trim();
    if (!Number.isFinite(amount) || amount <= 0 || amount > 10000000 || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.00001 || reason.length < 3) {
      message('กรุณาระบุราคามากกว่า 0 ไม่เกินสองตำแหน่งทศนิยม และเหตุผลอย่างน้อย 3 ตัวอักษร');
      return;
    }
    const item = selected;
    setPending(true);
    message('กำลังบันทึกราคา กรุณารอผลก่อนแก้ไขต่อ');
    try {
      await rpc('set_price_master_item', {
        p_price_list_id: item.price_list_id, p_item_type: item.item_type,
        p_product_id: item.product_id, p_service_id: item.service_id,
        p_unit_code: item.unit_code, p_unit_price: amount,
        p_expected_version: item.item_version || 0, p_reason: reason
      });
      setPending(false);
      if (!await load()) { message('บันทึกราคาแล้ว แต่โหลดกลับไม่สำเร็จ กรุณาโหลดราคาใหม่ก่อนทำรายการต่อ'); return; }
      const index = rows.findIndex(row => row.price_list_id === item.price_list_id && row.product_id === item.product_id && row.service_id === item.service_id && row.item_type === item.item_type);
      if (index < 0) { message('ระบบรับบันทึกราคาแล้ว แต่ไม่พบรายการนี้ในการอ่านกลับ กรุณาโหลดใหม่และตรวจสิทธิ์ก่อนทำรายการต่อ'); return; }
      const readback = rows[index];
      await select(index);
      if (Number(readback.unit_price) !== amount || readback.unit_code !== item.unit_code || Number(readback.item_version) !== Number(item.item_version || 0) + 1) {
        message('ระบบรับบันทึกราคาแล้ว แต่ราคา/รุ่นที่อ่านกลับไม่ตรงกับครั้งนี้ กรุณาตรวจราคาล่าสุดและประวัติ ห้ามถือว่าราคาเดิมยังมีผล');
        return;
      }
      message('บันทึกราคากลางแล้ว และโหลดรายการกลับจากฐานข้อมูล');
    } catch (error) { message(failure(error)); }
    finally { setPending(false); }
  }
  $('#price-edit-form').addEventListener('submit', save);
  $('#price-setup-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (pending || accountBlocked) return;
    const reason = $('#price-setup-reason').value.trim();
    if (reason.length < 3) { message('กรุณาระบุเหตุผลอย่างน้อย 3 ตัวอักษร'); return; }
    setPending(true);
    message('กำลังตั้งราคากลาง กรุณารอผลก่อนแก้ไขต่อ');
    try {
      await rpc('setup_price_master_default', { p_service_name: 'Session', p_unit_price: 650, p_reason: reason });
      setPending(false);
      if (!await load()) message('ระบบรับตั้งราคากลางแล้ว แต่โหลดกลับไม่สำเร็จ กรุณาโหลดราคาใหม่ก่อนตั้งค่าซ้ำ');
    } catch (error) { message(failure(error)); }
    finally { setPending(false); }
  });
  $('#price-refresh').addEventListener('click', load);
  $('#price-search').addEventListener('input', render);
  $('#price-list').addEventListener('click', event => {
    const button = event.target.closest('[data-price-index]');
    if (button) select(Number(button.dataset.priceIndex));
  });
  $('#admin-nav').addEventListener('click', event => {
    if (event.target.closest('[data-view="price-master"]') && !loaded) load();
  });
})();
