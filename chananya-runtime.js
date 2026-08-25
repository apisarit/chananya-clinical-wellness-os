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

  function roleOf(profile) {
    return String(profile?.system_role || profile?.role || '').trim().toLowerCase();
  }

  const permissions = Object.freeze({
    clinical_read: ['super_admin','admin','practitioner','doctor','pharmacy'],
    clinical_write: ['super_admin','admin','practitioner','doctor'],
    appointments_operate: ['admin','reception'],
    appointments_view: ['super_admin','admin','reception','practitioner','doctor'],
    pharmacy_operate: ['super_admin','admin','pharmacy'],
    production_operate: ['super_admin','admin','production','inventory','pharmacy'],
    admin_center: ['super_admin','admin']
  });

  function can(profile, capability) {
    return (permissions[capability] || []).includes(roleOf(profile));
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

  window.ChananyaRuntime = Object.freeze({ getDb, getSession, getProfile, roleOf, can, permissions });
})();
