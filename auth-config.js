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

  function addLink(actions, logout, id, href, text) {
    let link = document.querySelector(`#${id}`);
    if (!link) {
      link = document.createElement('a');
      link.id = id;
      link.href = href;
      link.textContent = text;
      link.className = 'btn ghost';
      link.style.cssText = 'display:inline-flex;text-decoration:none;align-items:center;justify-content:center;white-space:nowrap';
      actions.insertBefore(link, logout);
    }
    return link;
  }

  function installNavigation() {
    const actions = document.querySelector('.top .actions');
    const roleBadge = document.querySelector('#role');
    const logout = document.querySelector('#logout');
    if (!actions || !roleBadge || !logout) return false;

    const effectiveRole = () => {
      const current = String(roleBadge.dataset.databaseRole || roleBadge.textContent || '').trim().toLowerCase();
      return current === 'admin' ? 'super_admin' : current;
    };

    const syncBadge = () => {
      const currentText = String(roleBadge.textContent || '').trim().toLowerCase();
      if (currentText === 'admin') {
        roleBadge.dataset.databaseRole = 'admin';
        roleBadge.textContent = 'super_admin';
      }
    };

    let pharmacy;
    let production;

    if (path === '/' || path.endsWith('/index.html')) {
      pharmacy = addLink(actions, logout, 'pharmacy-header-link', '/pharmacy.html', 'Pharmacy');
      production = addLink(actions, logout, 'production-header-link', '/production.html', 'Production');
    }

    if (path.endsWith('/production.html')) {
      pharmacy = addLink(actions, logout, 'pharmacy-from-production', '/pharmacy.html', 'Pharmacy');
    }

    const sync = () => {
      syncBadge();
      const role = effectiveRole();
      if (pharmacy) pharmacy.style.display = ['super_admin', 'admin', 'pharmacy'].includes(role) ? 'inline-flex' : 'none';
      if (production) production.style.display = ['super_admin', 'admin', 'pharmacy', 'production'].includes(role) ? 'inline-flex' : 'none';
    };

    sync();
    new MutationObserver(sync).observe(roleBadge, {
      childList: true,
      subtree: true,
      characterData: true
    });
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
