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

  function addProductionButton() {
    const nav = document.querySelector('#main-nav');
    const roleBadge = document.querySelector('#role');
    if (!nav || !roleBadge) return;

    let link = document.querySelector('#production-nav-link');
    if (!link) {
      link = document.createElement('a');
      link.id = 'production-nav-link';
      link.href = '/production.html';
      link.textContent = 'Production';
      link.setAttribute('aria-label', 'เปิด Production Workstation');
      link.style.cssText = 'display:none;white-space:nowrap;text-decoration:none;background:#ffffff18;color:#fff;border-radius:10px;padding:10px 13px;align-items:center';
      nav.appendChild(link);
    }

    const sync = () => {
      const currentRole = (roleBadge.textContent || '').trim().toLowerCase();
      link.style.display = allowedRoles.has(currentRole) ? 'inline-flex' : 'none';
    };

    sync();
    new MutationObserver(sync).observe(roleBadge, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  document.addEventListener('DOMContentLoaded', addProductionButton);
})();
