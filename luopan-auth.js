(() => {
  'use strict';

  const $ = selector => document.querySelector(selector);
  let db;

  async function init() {
    try {
      const runtime = window.ChananyaRuntime;
      if (!runtime) throw new Error('ChananyaRuntime ไม่พร้อมใช้งาน');
      db = runtime.getDb();
      const session = await runtime.getSession();
      if (!session) { location.replace('/login.html'); return; }
      const profile = await runtime.getProfile(session.user.id);
      if (!profile) throw new Error('ไม่พบ Profile');
      if (!runtime.can(profile, 'luopan_read')) throw new Error('บัญชีนี้ไม่มีสิทธิ์เปิด Luopan');

      window.ChananyaShell?.mount({ profile, session, active: 'luopan' });
      const frame = $('#luopan-frame');
      frame.src = frame.dataset.src;
      $('#app').classList.remove('hidden');
      $('#boot').classList.add('hidden');
    } catch (error) {
      console.error(error);
      $('#boot-error').textContent = error.message;
    }
  }

  $('#logout').addEventListener('click', async () => {
    await db.auth.signOut();
    location.replace('/login.html');
  });
  init();
})();
