(() => {
  'use strict';
  if (window.ChananyaRuntime) return;

  let db = null;
  const deploymentConfig = () => window.CLINICAL_OS_CONFIG || {};
  const cfg = () => {
    const deployment = deploymentConfig();
    const database = deployment.database || {};
    const legacy = window.CHANANYA_AUTH || {};
    return {
      url: database.url || legacy.url || legacy.supabaseUrl,
      publishableKey: database.publishableKey || legacy.publishableKey || legacy.anonKey
    };
  };

  function getDb() {
    if (db) return db;
    if (deploymentConfig().safety?.previewLocked === true) {
      throw new Error('Deploy Preview database access is locked; use the read-only UI review');
    }
    if (!window.supabase) throw new Error('Supabase client library is not loaded');
    const c = cfg();
    const url = c.url || c.supabaseUrl;
    const key = c.publishableKey;
    if (!url || !key) throw new Error('Clinical OS database configuration is missing');
    db = window.supabase.createClient(url, key, {
      auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true }
    });
    return db;
  }

  const normalizeRole = value => String(value || '').trim().toLowerCase();

  function rolesOf(profile) {
    const membershipRole = normalizeRole(profile?.clinic_role || profile?.role) || 'viewer';
    const operationalRole = membershipRole === 'owner' ? 'admin' : membershipRole;
    const systemRole = normalizeRole(profile?.system_role) || 'staff';
    const effectiveRole = systemRole === 'super_admin'
      ? 'super_admin'
      : systemRole === 'admin' || operationalRole === 'admin'
        ? 'admin'
        : operationalRole;

    // One account has one active department. System admin is governance-only;
    // it never inherits the underlying clinical/pharmacy/production role.
    // Only super_admin receives the cross-workspace override.
    const grantedRoles = Object.freeze([effectiveRole]);
    return Object.freeze({
      clinicId: profile?.clinic_id || null,
      clinicRole: membershipRole,
      operationalRole,
      systemRole,
      effectiveRole,
      accessContextReady: profile?.access_context_ready === true,
      grantedRoles
    });
  }

  function roleOf(profile) {
    return rolesOf(profile).effectiveRole;
  }

  const permissions = Object.freeze({
    operations_view: ['super_admin','admin','practitioner','doctor','reception','pharmacy','production','inventory','quality','billing','viewer'],
    knowledge_read: ['super_admin','practitioner','doctor','pharmacy','production','inventory'],
    clinical_read: ['super_admin','practitioner','doctor'],
    clinical_write: ['super_admin','practitioner','doctor'],
    patient_registry: ['super_admin','practitioner','doctor','reception'],
    patient_checkin: ['super_admin','practitioner','doctor','reception'],
    patient_identity_link: ['super_admin','practitioner','doctor','reception'],
    appointments_operate: ['super_admin','reception'],
    appointments_view: ['super_admin','reception','practitioner','doctor'],
    pharmacy_operate: ['super_admin','pharmacy'],
    product_master_write: ['super_admin','pharmacy','production','inventory'],
    production_operate: ['super_admin','production','inventory'],
    quality_operate: ['super_admin','quality'],
    billing_operate: ['super_admin','billing'],
    admin_center: ['super_admin','admin']
  });

  function can(profile, capability) {
    // Operational access is accepted only after the database returns the
    // tenant + department context. A stale frontend role must never become an
    // authorization fallback while a migration or RPC is unavailable.
    if (profile?.access_context_ready !== true) return false;
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
    if (!data) return null;

    const access = await getDb().rpc('current_access_context');
    if (access.error) {
      console.warn('Department access migration is not active; using fail-closed UI compatibility context');
      return Object.freeze({ ...data, access_context_ready: false });
    }
    const row = Array.isArray(access.data) ? access.data[0] : access.data;
    if (!row?.clinic_id || !row?.clinic_role) {
      return Object.freeze({ ...data, role: 'viewer', access_context_ready: false });
    }
    const expectedTenant = deploymentConfig().tenant || {};
    const expectedClinicId = String(expectedTenant.expectedClinicId || '').toLowerCase();
    const expectedClinicCode = String(expectedTenant.expectedClinicCode || '').toUpperCase();
    const actualClinicId = String(row.clinic_id || '').toLowerCase();
    const actualClinicCode = String(row.clinic_code || '').toUpperCase();
    if ((expectedClinicId && expectedClinicId !== actualClinicId) || (expectedClinicCode && expectedClinicCode !== actualClinicCode)) {
      console.error('Deployment tenant and database tenant do not match');
      return Object.freeze({
        ...data,
        role: 'viewer',
        clinic_id: row.clinic_id,
        clinic_code: row.clinic_code,
        access_context_ready: false,
        tenant_mismatch: true
      });
    }
    return Object.freeze({
      ...data,
      role: row.clinic_role,
      clinic_role: row.clinic_role,
      clinic_id: row.clinic_id,
      clinic_code: row.clinic_code,
      clinic_name: row.clinic_name,
      system_role: row.system_role || data.system_role,
      access_context_ready: row.ready === true
    });
  }

  window.ChananyaRuntime = Object.freeze({ getDb, getSession, getProfile, rolesOf, roleOf, can, permissions });
})();
