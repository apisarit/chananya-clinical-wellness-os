window.CHANANYA_AUTH = Object.freeze({
  url: 'https://qptxnrldzzinlcabudjv.supabase.co',
  anonKey: 'sb_publishable_YCIY8LZeCfRgcSZYgmP6JA_r9OVbpcJ',
  supabaseUrl: 'https://qptxnrldzzinlcabudjv.supabase.co',
  publishableKey: 'sb_publishable_YCIY8LZeCfRgcSZYgmP6JA_r9OVbpcJ',
  redirectTo: 'https://chananya.netlify.app'
});

(() => {
  'use strict';

  const path = location.pathname;
  const isClinicalHome = path === '/' || path.endsWith('/index.html');

  // Other workstations already have their own navigation in HTML.
  if (!isClinicalHome) return;

  function addLink(actions, logout, id, href, text) {
    let link = document.querySelector(`#${id}`);
    if (!link) {
      link = document.createElement('a');
      link.id = id;
      link.href = href;
      link.textContent = text;
      link.className = 'btn ghost';
      link.style.cssText = 'display:none;text-decoration:none;align-items:center;justify-content:center;white-space:nowrap';
      actions.insertBefore(link, logout);
    }
    return link;
  }

  function installNavigation() {
    const actions = document.querySelector('.top .actions');
    const roleBadge = document.querySelector('#role');
    const logout = document.querySelector('#logout');
    if (!actions || !roleBadge || !logout) return false;

    const admin = addLink(actions, logout, 'admin-header-link', '/admin.html', 'Admin');
    const pharmacy = addLink(actions, logout, 'pharmacy-header-link', '/pharmacy.html', 'Pharmacy');
    const production = addLink(actions, logout, 'production-header-link', '/production.html', 'Production');

    const sync = () => {
      const role = String(
        roleBadge.dataset.effectiveRole ||
        roleBadge.dataset.databaseRole ||
        roleBadge.textContent ||
        ''
      ).trim().toLowerCase();

      const isSuper = role === 'super_admin';
      const isAdmin = isSuper || role === 'admin';

      admin.style.display = isAdmin ? 'inline-flex' : 'none';
      pharmacy.style.display = (isAdmin || role === 'pharmacy') ? 'inline-flex' : 'none';
      production.style.display = (isAdmin || ['pharmacy', 'production'].includes(role)) ? 'inline-flex' : 'none';
    };

    sync();
    new MutationObserver(sync).observe(roleBadge, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true
    });

    // App initialization may update the role shortly after the DOM appears.
    const timer = setInterval(sync, 300);
    setTimeout(() => clearInterval(timer), 10000);
    return true;
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (installNavigation()) return;
    const timer = setInterval(() => {
      if (installNavigation()) clearInterval(timer);
    }, 200);
    setTimeout(() => clearInterval(timer), 10000);
  });
})();
