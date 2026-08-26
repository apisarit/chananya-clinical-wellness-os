(() => {
  'use strict';
  if (window.ChananyaShell) return;

  const routes = Object.freeze([
    { key: 'operations', href: '/', icon: '⌂', label: 'ศูนย์ปฏิบัติการ', note: 'ภาพรวม ผู้รับบริการ การเงิน' },
    { key: 'appointments', href: '/appointments.html', icon: '◷', label: 'นัดหมาย', note: 'ตารางแพทย์และคิว', capability: 'appointments_view' },
    { key: 'foundation', href: '/foundation.html', icon: 'ร', label: 'รากวิชา', note: 'คัมภีร์และองค์ความรู้', capability: 'knowledge_read' },
    { key: 'clinical', href: '/clinical-v3.html', icon: '✚', label: 'เวชระเบียน', note: 'ตรวจ วินิจฉัย รักษา', capability: 'clinical_read' },
    { key: 'pharmacy', href: '/pharmacy.html', icon: 'Rx', label: 'ห้องยา', note: 'จ่ายยาและผลิตภัณฑ์', capability: 'pharmacy_operate' },
    { key: 'production', href: '/production.html', icon: '⚗', label: 'ผลิตและคลัง', note: 'สูตร Batch และ QC', capability: 'production_operate' },
    { key: 'admin', href: '/admin.html', icon: '⚙', label: 'ศูนย์ควบคุม', note: 'สิทธิ์ อนุมัติ Audit', capability: 'admin_center' }
  ]);

  const $ = (selector, root = document) => root.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const allowed = (route, profile) => !route.capability || Boolean(window.ChananyaRuntime?.can(profile, route.capability));

  function routeMarkup(route, active) {
    return `<a href="${route.href}"${route.key === active ? ' aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">${route.icon}</span><span class="nav-copy"><b>${esc(route.label)}</b><small>${esc(route.note)}</small></span></a>`;
  }

  function setMenu(open) {
    document.body.classList.toggle('shell-open', Boolean(open));
    document.querySelectorAll('[data-shell-menu]').forEach(button => button.setAttribute('aria-expanded', String(Boolean(open))));
  }

  function bindMenu() {
    document.querySelectorAll('[data-shell-menu]').forEach(button => {
      if (button.dataset.shellBound === '1') return;
      button.dataset.shellBound = '1';
      button.addEventListener('click', () => setMenu(!document.body.classList.contains('shell-open')));
    });
    document.querySelectorAll('[data-shell-close]').forEach(button => {
      if (button.dataset.shellBound === '1') return;
      button.dataset.shellBound = '1';
      button.addEventListener('click', () => setMenu(false));
    });
    const nav = $('#global-nav');
    if (nav && nav.dataset.shellBound !== '1') {
      nav.dataset.shellBound = '1';
      nav.addEventListener('click', () => setMenu(false));
    }
  }

  function mount({ profile, session, active = document.body.dataset.page || 'operations' } = {}) {
    const runtime = window.ChananyaRuntime;
    const roles = runtime?.rolesOf(profile) || { effectiveRole: profile?.role || 'viewer', systemRole: profile?.system_role || 'staff', operationalRole: profile?.role || 'viewer' };
    const visibleRoutes = routes.filter(route => allowed(route, profile));
    const nav = $('#global-nav');
    if (nav) nav.innerHTML = visibleRoutes.map(route => routeMarkup(route, active)).join('');
    const identity = $('#identity');
    if (identity) identity.textContent = profile?.full_name || session?.user?.email || 'ผู้ใช้งาน';
    const role = $('#role');
    if (role) {
      role.textContent = roles.effectiveRole;
      role.dataset.systemRole = roles.systemRole;
      role.dataset.operationalRole = roles.operationalRole;
      role.dataset.effectiveRole = roles.effectiveRole;
    }
    bindMenu();
    window.dispatchEvent(new CustomEvent('chananya:shell-ready', { detail: { active, roles, visibleRoutes: visibleRoutes.map(route => route.key) } }));
    return { roles, visibleRoutes };
  }

  document.addEventListener('keydown', event => { if (event.key === 'Escape') setMenu(false); });
  window.ChananyaShell = Object.freeze({ routes, mount, setMenu });
})();
