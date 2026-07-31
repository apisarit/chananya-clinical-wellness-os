window.CHANANYA_AUTH = Object.freeze({
  supabaseUrl: 'https://qptxnrldzzinlcabudjv.supabase.co',
  publishableKey: 'sb_publishable_YCIY8LZeCfRgcSZYgmP6JA_r9OVbpcJ',
  redirectTo: 'https://chananya.netlify.app'
});

(() => {
  'use strict';

  const allowedRoles = new Set(['admin', 'production', 'pharmacy']);

  function installProductionNavigation() {
    const nav = document.querySelector('#main-nav');
    const roleBadge = document.querySelector('#role');
    if (!nav || !roleBadge) return false;

    let link = document.querySelector('#production-workstation-link');
    if (!link) {
      link = document.createElement('a');
      link.id = 'production-workstation-link';
      link.href = '/production.html?v=prod3';
      link.textContent = 'Production';
      link.setAttribute('aria-label', 'เปิด Production Workstation');
      link.style.cssText = [
        'display:none',
        'white-space:nowrap',
        'text-decoration:none',
        'background:#ffffff18',
        'color:#fff',
        'border:0',
        'border-radius:10px',
        'padding:10px 13px',
        'font:inherit'
      ].join(';');
      nav.appendChild(link);
    }

    const syncVisibility = () => {
      const currentRole = (roleBadge.textContent || '').trim().toLowerCase();
      link.style.display = allowedRoles.has(currentRole) ? 'inline-flex' : 'none';
    };

    syncVisibility();
    new MutationObserver(syncVisibility).observe(roleBadge, {
      childList: true,
      characterData: true,
      subtree: true
    });
    return true;
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (installProductionNavigation()) return;
    const timer = window.setInterval(() => {
      if (installProductionNavigation()) window.clearInterval(timer);
    }, 200);
    window.setTimeout(() => window.clearInterval(timer), 10000);
  });
})();
