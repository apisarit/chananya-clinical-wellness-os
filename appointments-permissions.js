(() => {
  'use strict';

  let mode = 'read_only';

  async function waitRuntime() {
    for (let i = 0; i < 50; i += 1) {
      if (window.ChananyaRuntime) return window.ChananyaRuntime;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('ChananyaRuntime ไม่พร้อมใช้งาน');
  }

  function applyPermissions() {
    const bookingSection = document.querySelector('#booking-section');
    const scheduleButtons = document.querySelectorAll('[data-book]');
    const statusButtons = document.querySelectorAll('[data-status]');
    const cancelButtons = document.querySelectorAll('[data-cancel]');

    if (bookingSection) bookingSection.style.display = mode === 'operator' ? '' : 'none';
    scheduleButtons.forEach(button => { button.style.display = mode === 'operator' ? '' : 'none'; });

    statusButtons.forEach(button => {
      const next = button.dataset.status;
      if (mode === 'operator') {
        button.style.display = '';
      } else if (mode === 'practitioner' && ['in_service', 'completed'].includes(next)) {
        button.style.display = '';
      } else {
        button.style.display = 'none';
      }
    });

    cancelButtons.forEach(button => { button.style.display = mode === 'operator' ? '' : 'none'; });

    let notice = document.querySelector('#appointment-role-notice');
    if (!notice) {
      notice = document.createElement('div');
      notice.id = 'appointment-role-notice';
      notice.className = 'notice';
      const main = document.querySelector('main');
      if (main) main.insertBefore(notice, main.firstChild);
    }

    if (notice) {
      notice.textContent = mode === 'operator'
        ? 'โหมดปฏิบัติงาน: Admin/Reception สามารถสร้าง ยืนยัน Check-in และยกเลิกนัดได้'
        : mode === 'practitioner'
          ? 'โหมดผู้ให้บริการ: ดูตารางของตนและเปลี่ยนสถานะ เริ่มบริการ/เสร็จสิ้น'
          : 'โหมดผู้บริหาร: Super Admin ดูและตรวจสอบรายการนัดหมายได้ แต่ไม่ทำรายการแทน Admin';
    }
  }

  async function init() {
    const runtime = await waitRuntime();
    const session = await runtime.getSession();
    if (!session) return;
    const profile = await runtime.getProfile(session.user.id) || {};
    const systemRole = String(profile.system_role || '').toLowerCase();
    const role = String(profile.role || '').toLowerCase();

    if (systemRole === 'super_admin') {
      mode = 'read_only';
    } else if (systemRole === 'admin' || ['admin', 'reception'].includes(role)) {
      mode = 'operator';
    } else if (['practitioner', 'doctor'].includes(role)) {
      mode = 'practitioner';
    } else {
      mode = 'read_only';
    }

    applyPermissions();
    new MutationObserver(applyPermissions).observe(document.body, { childList: true, subtree: true });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
