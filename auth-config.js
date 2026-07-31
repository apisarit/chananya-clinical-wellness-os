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
  if (!(path === '/' || path.endsWith('/index.html'))) return;

  const pharmacyRoles = new Set(['admin', 'pharmacy']);
  const productionRoles = new Set(['admin', 'pharmacy', 'production']);

  function installWorkspaceButtons() {
    const actions = document.querySelector('.top .actions');
    const roleBadge = document.querySelector('#role');
    const logoutButton = document.querySelector('#logout');
    if (!actions || !roleBadge || !logoutButton) return false;

    const makeLink = (id, href, text) => {
      let link = document.querySelector(`#${id}`);
      if (!link) {
        link = document.createElement('a');
        link.id = id;
        link.href = href;
        link.textContent = text;
        link.className = 'btn ghost';
        link.style.cssText = 'display:none;text-decoration:none;align-items:center;justify-content:center;white-space:nowrap';
        actions.insertBefore(link, logoutButton);
      }
      return link;
    };

    const pharmacy = makeLink('pharmacy-header-link', '/pharmacy.html', 'Pharmacy');
    const production = makeLink('production-header-link', '/production.html', 'Production');

    const sync = () => {
      const currentRole = (roleBadge.textContent || '').trim().toLowerCase();
      pharmacy.style.display = pharmacyRoles.has(currentRole) ? 'inline-flex' : 'none';
      production.style.display = productionRoles.has(currentRole) ? 'inline-flex' : 'none';
    };
    sync();
    new MutationObserver(sync).observe(roleBadge,{childList:true,subtree:true,characterData:true});
    return true;
  }

  document.addEventListener('DOMContentLoaded',()=>{
    if (installWorkspaceButtons()) return;
    const timer=setInterval(()=>{if(installWorkspaceButtons())clearInterval(timer)},200);
    setTimeout(()=>clearInterval(timer),10000);
  });
})();
