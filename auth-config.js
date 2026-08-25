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
  const isClinicalV3 = path.endsWith('/clinical-v3.html');
  const isPharmacy = path.endsWith('/pharmacy.html');
  const isAppointments = path.endsWith('/appointments.html');

  function loadScript(src, id) {
    return new Promise((resolve, reject) => {
      const existing = document.getElementById(id);
      if (existing) {
        if (existing.dataset.loaded === '1') return resolve(existing);
        existing.addEventListener('load', () => resolve(existing), { once: true });
        existing.addEventListener('error', reject, { once: true });
        return;
      }
      const s = document.createElement('script');
      s.id = id;
      s.src = src;
      s.defer = true;
      s.addEventListener('load', () => { s.dataset.loaded = '1'; resolve(s); }, { once: true });
      s.addEventListener('error', reject, { once: true });
      document.head.appendChild(s);
    });
  }

  async function bootExtensions() {
    try {
      await loadScript('/chananya-runtime.js?v=runtime-1', 'chananya-runtime');
      if (isClinicalV3) {
        await loadScript('/body-pain-map.js?v=interactive-pain-map-1', 'body-pain-map-extension');
        await loadScript('/ttm-diagnosis-assistant.js?v=ttm-dkr-v1', 'ttm-diagnosis-assistant');
        await loadScript('/opd-workflow.js?v=opd-workflow-1', 'opd-workflow-extension');
        return;
      }
      if (isPharmacy) {
        await loadScript('/pharmacy-labels.js?v=medicine-labels-1', 'pharmacy-label-extension');
        return;
      }
      if (isAppointments) {
        await loadScript('/appointments-permissions.js?v=appointment-role-fix-1', 'appointments-permissions');
        return;
      }
      if (isClinicalHome) {
        await loadScript('/clinical-enhancements.js?v=multi-rx-1', 'clinical-enhancements');
      }
    } catch (error) {
      console.error('Chananya extension boot failed', error);
    }
  }

  bootExtensions();
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
    const appointments = addLink(actions, logout, 'appointments-header-link', '/appointments.html', 'นัดหมาย');
    const clinicalV3 = addLink(actions, logout, 'clinical-v3-header-link', '/clinical-v3.html', 'Clinical v3');
    const pharmacy = addLink(actions, logout, 'pharmacy-header-link', '/pharmacy.html', 'Pharmacy');
    const production = addLink(actions, logout, 'production-header-link', '/production.html', 'Production');

    const sync = () => {
      const role = String(roleBadge.dataset.effectiveRole || roleBadge.dataset.databaseRole || roleBadge.textContent || '').trim().toLowerCase();
      const isSuper = role === 'super_admin';
      const isAdmin = role === 'admin';
      const isPractitioner = ['practitioner', 'doctor'].includes(role);
      const isReception = role === 'reception';

      admin.style.display = (isSuper || isAdmin) ? 'inline-flex' : 'none';
      appointments.style.display = (isSuper || isAdmin || isPractitioner || isReception) ? 'inline-flex' : 'none';
      clinicalV3.style.display = (isSuper || isAdmin || isPractitioner) ? 'inline-flex' : 'none';
      pharmacy.style.display = (isSuper || isAdmin || role === 'pharmacy') ? 'inline-flex' : 'none';
      production.style.display = (isSuper || isAdmin || ['pharmacy', 'production', 'inventory'].includes(role)) ? 'inline-flex' : 'none';
    };

    sync();
    new MutationObserver(sync).observe(roleBadge, { childList: true, subtree: true, characterData: true, attributes: true });
    const timer = setInterval(sync, 300);
    setTimeout(() => clearInterval(timer), 10000);
    return true;
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (installNavigation()) return;
    const timer = setInterval(() => { if (installNavigation()) clearInterval(timer); }, 200);
    setTimeout(() => clearInterval(timer), 10000);
  });
})();
