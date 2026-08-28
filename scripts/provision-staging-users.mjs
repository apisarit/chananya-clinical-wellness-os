import {
  STAGING_ROLES,
  loadStagingCredentials,
  loadStagingTarget,
  requestJson,
  sourceCommit,
  stagingIdentity,
  supabaseUrl,
  writeEvidence
} from './staging-support.mjs';

const target = loadStagingTarget();
const credentials = loadStagingCredentials();
const adminHeaders = { 'X-Client-Info': 'clinical-os-staging-provisioner/1.0' };

async function adminRequest(resource, options = {}) {
  return requestJson(supabaseUrl(target, resource), {
    key: credentials.serviceRoleKey,
    bearer: credentials.serviceRoleKey,
    headers: adminHeaders,
    ...options
  });
}

async function listUsers() {
  const users = [];
  for (let page = 1; page <= 50; page += 1) {
    const result = await adminRequest(`/auth/v1/admin/users?page=${page}&per_page=100`);
    const batch = Array.isArray(result) ? result : result?.users || [];
    users.push(...batch);
    if (batch.length < 100) return users;
  }
  throw new Error('Staging Auth user list exceeded the safe pagination limit');
}

async function ensureAuthUser(identity, existing) {
  const body = {
    email: identity.email,
    password: credentials.password,
    email_confirm: true,
    user_metadata: {
      full_name: identity.fullName,
      synthetic_staging_only: true,
      expected_role: identity.role
    },
    app_metadata: {
      synthetic_staging_only: true,
      expected_role: identity.role
    }
  };
  let result;
  if (existing) {
    result = await adminRequest(`/auth/v1/admin/users/${encodeURIComponent(existing.id)}`, {
      method: 'PUT',
      body
    });
  } else {
    result = await adminRequest('/auth/v1/admin/users', { method: 'POST', body });
  }
  return result?.user || result;
}

async function upsertProfile(user, identity) {
  await adminRequest('/rest/v1/profiles?on_conflict=id', {
    method: 'POST',
    headers: {
      ...adminHeaders,
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: [{
      id: user.id,
      email: identity.email,
      full_name: identity.fullName,
      role: identity.profileRole,
      system_role: identity.systemRole,
      updated_at: new Date().toISOString()
    }],
    expected: [200, 201, 204]
  });
}

async function setPrimaryMembership(user, identity) {
  await adminRequest(`/rest/v1/clinic_memberships?profile_id=eq.${encodeURIComponent(user.id)}`, {
    method: 'PATCH',
    headers: { ...adminHeaders, Prefer: 'return=minimal' },
    body: { active: false, is_primary: false, updated_at: new Date().toISOString() },
    expected: [200, 204]
  });
  await adminRequest('/rest/v1/clinic_memberships?on_conflict=clinic_id,profile_id', {
    method: 'POST',
    headers: {
      ...adminHeaders,
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: [{
      clinic_id: target.config.tenant.expectedClinicId,
      profile_id: user.id,
      clinic_role: identity.clinicRole,
      is_primary: true,
      active: true,
      updated_at: new Date().toISOString()
    }],
    expected: [200, 201, 204]
  });
}

const existingUsers = await listUsers();
const byEmail = new Map(existingUsers.map(user => [String(user.email || '').toLowerCase(), user]));
const provisioned = [];

for (const role of STAGING_ROLES) {
  const identity = stagingIdentity(role);
  const existing = byEmail.get(identity.email);
  const user = await ensureAuthUser(identity, existing);
  if (!user?.id) throw new Error(`Auth Admin did not return an id for ${role}`);
  await upsertProfile(user, identity);
  await setPrimaryMembership(user, identity);
  provisioned.push({
    role,
    email: identity.email,
    userId: user.id,
    clinicRole: identity.clinicRole,
    systemRole: identity.systemRole,
    action: existing ? 'updated' : 'created'
  });
}

const evidence = {
  schemaVersion: 1,
  evidenceType: 'authenticated_staging_test_identity_provisioning',
  syntheticOnly: true,
  sourceCommit: sourceCommit(),
  generatedAt: new Date().toISOString(),
  deploymentId: target.config.deploymentId,
  databaseProjectRef: target.projectRef,
  clinicId: target.config.tenant.expectedClinicId,
  clinicCode: target.config.tenant.expectedClinicCode,
  accountCount: provisioned.length,
  accounts: provisioned
};

const evidencePath = writeEvidence('staging-user-provisioning.json', evidence);
process.stdout.write(`Provisioned ${provisioned.length} synthetic staging identities; evidence: ${evidencePath}\n`);
