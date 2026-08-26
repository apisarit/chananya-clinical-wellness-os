(() => {
  'use strict';
  if (window.ChananyaRuntime) return;

  let db = null;
  const cfg = () => window.CHANANYA_AUTH || {};

  function getDb() {
    if (db) return db;
    if (!window.supabase) throw new Error('Supabase client library is not loaded');
    const c = cfg();
    const url = c.url || c.supabaseUrl;
    const key = c.anonKey || c.publishableKey;
    if (!url || !key) throw new Error('Chananya Supabase configuration is missing');
    db = window.supabase.createClient(url, key, {
      auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true }
    });
    return db;
  }

  const normalizeRole = value => String(value || '').trim().toLowerCase();

  function rolesOf(profile) {
    const operationalRole = normalizeRole(profile?.role) || 'viewer';
    const systemRole = normalizeRole(profile?.system_role) || 'staff';
    const effectiveRole = ['super_admin', 'admin'].includes(systemRole)
      ? systemRole
      : operationalRole;
    const grantedRoles = [...new Set(
      [effectiveRole, operationalRole, systemRole]
        .filter(role => role && role !== 'staff')
    )];
    return Object.freeze({ operationalRole, systemRole, effectiveRole, grantedRoles });
  }

  function roleOf(profile) {
    return rolesOf(profile).effectiveRole;
  }

  const permissions = Object.freeze({
    knowledge_read: ['super_admin','admin','practitioner','doctor','pharmacy','production','inventory'],
    clinical_read: ['super_admin','admin','practitioner','doctor','pharmacy'],
    clinical_write: ['super_admin','admin','practitioner','doctor'],
    appointments_operate: ['admin','reception'],
    appointments_view: ['super_admin','admin','reception','practitioner','doctor'],
    pharmacy_operate: ['super_admin','admin','pharmacy'],
    production_operate: ['super_admin','admin','production','inventory','pharmacy'],
    admin_center: ['super_admin','admin']
  });

  function can(profile, capability) {
    const allowed = permissions[capability] || [];
    return rolesOf(profile).grantedRoles.some(role => allowed.includes(role));
  }

  async function getSession() {
    return (await getDb().auth.getSession()).data.session || null;
  }

  async function getProfile(userId) {
    if (!userId) return null;
    const { data, error } = await getDb()
      .from('profiles')
      .select('id,role,system_role,full_name,email')
      .eq('id', userId)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  window.ChananyaRuntime = Object.freeze({ getDb, getSession, getProfile, rolesOf, roleOf, can, permissions });
})();
