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
      link.style.cssText = 'display:none;text-decoration:none;align-items:center;justify-content:center;white-space:nowrap';
      actions.insertBefore(link, logout);
    }
    return link;
  }

  async function getAccess() {
    try {
      const cfg = window.CHANANYA_AUTH;
      if (!window.supabase || !cfg?.url || !cfg?.anonKey) return { role: 'viewer', systemRole: 'staff' };
      const client = window.supabase.createClient(cfg.url, cfg.anonKey, {
        auth: { persistSession: true, autoRefreshToken: true }
      });
      const sessionResult = await client.auth.getSession();
      const userId = sessionResult.data.session?.user?.id;
      if (!userId) return { role: 'viewer', systemRole: 'staff' };
      const profile = await client.from('profiles').select('role,system_role').eq('id', userId).single();
      if (profile.error) return { role: 'viewer', systemRole: 'staff' };
      return { role: profile.data.role || 'viewer', systemRole: profile.data.system_role || 'staff' };
    } catch (error) {
      console.warn('Navigation access lookup failed', error);
      return { role: 'viewer', systemRole: 'staff' };
    }
  }

  function installNavigation() {
    const actions = document.querySelector('.top .actions');
    const logout = document.querySelector('#logout');
    if (!actions || !logout) return false;

    const admin = addLink(actions, logout, 'admin-header-link', '/admin.html', 'Admin');
    const clinical = addLink(actions, logout, 'clinical-header-link', '/', 'Clinical');
    const pharmacy = addLink(actions, logout, 'pharmacy-header-link', '/pharmacy.html', 'Pharmacy');
    const production = addLink(actions, logout, 'production-header-link', '/production.html', 'Production');

    getAccess().then(({ role, systemRole }) => {
      const isAdmin = ['admin', 'super_admin'].includes(systemRole);
      const isSuper = systemRole === 'super_admin';

      admin.style.display = isAdmin ? 'inline-flex' : 'none';
      clinical.style.display = path === '/' || path.endsWith('/index.html') ? 'none' :
        (isSuper || ['admin','practitioner','reception','pharmacy','inventory','billing','viewer'].includes(role) ? 'inline-flex' : 'none');
      pharmacy.style.display = path.endsWith('/pharmacy.html') ? 'none' :
        (isSuper || isAdmin || role === 'pharmacy' ? 'inline-flex' : 'none');
      production.style.display = path.endsWith('/production.html') ? 'none' :
        (isSuper || isAdmin || ['pharmacy','production'].includes(role) ? 'inline-flex' : 'none');
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
