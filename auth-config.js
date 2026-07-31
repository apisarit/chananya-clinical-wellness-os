window.CHANANYA_AUTH = Object.freeze({
  url: 'https://qptxnrldzzinlcabudjv.supabase.co',
  anonKey: 'sb_publishable_YCIY8LZeCfRgcSZYgmP6JA_r9OVbpcJ',
  supabaseUrl: 'https://qptxnrldzzinlcabudjv.supabase.co',
  publishableKey: 'sb_publishable_YCIY8LZeCfRgcSZYgmP6JA_r9OVbpcJ',
  redirectTo: 'https://chananya.netlify.app'
});

(() => {
  'use strict';

  const allowedRoles = new Set(['admin', 'pharmacy', 'production']);

  function installProductionButton() {
    const actions = document.querySelector('.top .actions');
    const roleBadge = document.querySelector('#role');
    const logoutButton = document.querySelector('#logout');
    if (!actions || !roleBadge || !logoutButton) return false;

    let link = document.querySelector('#production-header-link');
    if (!link) {
      link = document.createElement('a');
      link.id = 'production-header-link';
      link.href = '/production.html';
      link.textContent = 'Production';
      link.setAttribute('aria-label', 'เปิด Production Workstation');
      link.className = 'btn ghost';
      link.style.cssText = 'display:none;text-decoration:none;align-items:center;justify-content:center;white-space:nowrap';
      actions.insertBefore(link, logoutButton);
    }

    const syncVisibility = () => {
      const currentRole = (roleBadge.textContent || '').trim().toLowerCase();
      link.style.display = allowedRoles.has(currentRole) ? 'inline-flex' : 'none';
    };

    syncVisibility();
    new MutationObserver(syncVisibility).observe(roleBadge, {
      childList: true,
      subtree: true,
      characterData: true
    });
    return true;
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (installProductionButton()) return;
    const timer = window.setInterval(() => {
      if (installProductionButton()) window.clearInterval(timer);
    }, 200);
    window.setTimeout(() => window.clearInterval(timer), 10000);
  });
})();
