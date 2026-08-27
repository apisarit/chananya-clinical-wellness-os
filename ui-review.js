(() => {
  'use strict';

  const workspaces = Object.freeze({
    operations: { kicker: 'Operations', title: 'ศูนย์ปฏิบัติการคลินิก' },
    appointments: { kicker: 'Appointments', title: 'นัดหมายและตารางแพทย์' },
    checkin: { kicker: 'Hybrid Identity', title: 'ยืนยันผู้รับบริการด้วย LINE / HN' },
    foundation: { kicker: 'Knowledge Foundation', title: 'รากวิชาและความครอบคลุมองค์ความรู้' },
    clinical: { kicker: 'Clinical Workspace', title: 'เวชระเบียนแพทย์แผนไทย' },
    pharmacy: { kicker: 'Pharmacy', title: 'ห้องยาและ Product Master' },
    production: { kicker: 'Production', title: 'ผลิตและคลังวัตถุดิบ' },
    quality: { kicker: 'Independent Quality', title: 'ตรวจคุณภาพและปล่อยผ่าน' },
    admin: { kicker: 'Governance', title: 'สิทธิ์ Audit และการควบคุม' }
  });

  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];

  function setMenu(open) {
    document.body.classList.toggle('shell-open', Boolean(open));
    $$('[data-review-menu]').forEach(button => button.setAttribute('aria-expanded', String(Boolean(open))));
  }

  function activate(workspace, updateHash = true) {
    const key = Object.hasOwn(workspaces, workspace) ? workspace : 'operations';
    $$('[data-review-workspace]').forEach(section => {
      const active = section.dataset.reviewWorkspace === key;
      section.hidden = !active;
      section.classList.toggle('active', active);
    });
    $$('[data-review-route]').forEach(link => {
      const active = link.dataset.reviewRoute === key;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    $('#review-kicker').textContent = workspaces[key].kicker;
    $('#review-title').textContent = workspaces[key].title;
    setMenu(false);
    if (updateHash && location.hash !== `#${key}`) history.replaceState(null, '', `#${key}`);
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  document.addEventListener('click', event => {
    const route = event.target.closest('[data-review-route]');
    if (route) {
      event.preventDefault();
      activate(route.dataset.reviewRoute);
      return;
    }
    if (event.target.closest('[data-review-menu]')) setMenu(true);
    if (event.target.closest('[data-review-close]')) setMenu(false);
  });

  window.addEventListener('hashchange', () => activate(location.hash.slice(1), false));
  document.addEventListener('keydown', event => { if (event.key === 'Escape') setMenu(false); });
  activate(location.hash.slice(1), false);
})();
