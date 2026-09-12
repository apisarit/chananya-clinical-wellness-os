import assert from 'node:assert/strict';

export const MEMBERSHIP_PROOF_VERSION = '1.0.0-candidate.1';
const stateKeys = ['active','clinic_id','clinic_role','is_primary','profile_id','profile_role','state_version','system_role'];
const receiptKeys = ['actor_id','after','before','clinic_id','completed_at','operation','profile_id','request_id','restore_request_id','schema_version'];
const uuid = value => {
  assert.equal(typeof value, 'string', 'MEMBERSHIP_UUID_INVALID');
  assert.equal(value.length, 36, 'MEMBERSHIP_UUID_INVALID');
  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, 'MEMBERSHIP_UUID_INVALID');
  return value.toLowerCase();
};
const row = value => Array.isArray(value) ? value[0] : value;
const exactKeys = (value, keys) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'MEMBERSHIP_PROOF_OBJECT_INVALID');
  assert.deepEqual(Object.keys(value).sort(), keys, 'MEMBERSHIP_PROOF_KEYS_INVALID');
};

/** Candidate-side UAT logic, not a protected publisher or crash-recovery daemon.
 * Request IDs must be retained by the protected runner for cross-process retry.
 * Never fall back to the legacy void/unversioned membership RPC.
 */
export async function runStaffMembershipProof({ rpc, readAccessContext, readClinicalCapability,
  target, actorId, requestIds }) {
  const clinicId = uuid(target.clinicId), userId = uuid(target.userId);
  const actor = uuid(actorId), offId = uuid(requestIds.off), onId = uuid(requestIds.on);
  assert.notEqual(actor, userId, 'SELF_MEMBERSHIP_TRANSITION_NOT_ALLOWED');
  assert.notEqual(offId, onId, 'MEMBERSHIP_REQUEST_IDS_MUST_DIFFER');
  for (const value of [target.clinicRole, target.systemRole, target.effectiveRole]) {
    assert.equal(typeof value, 'string', 'MEMBERSHIP_BOUNDARY_REQUIRED');
    assert.ok(value.length > 0, 'MEMBERSHIP_BOUNDARY_REQUIRED');
  }
  const state = value => {
    exactKeys(value, stateKeys);
    assert.equal(value.clinic_id, clinicId, 'MEMBERSHIP_CLINIC_MISMATCH');
    assert.equal(value.profile_id, userId, 'MEMBERSHIP_USER_MISMATCH');
    assert.equal(value.state_version, uuid(value.state_version), 'MEMBERSHIP_VERSION_NOT_CANONICAL');
    assert.equal(typeof value.active, 'boolean');
    assert.equal(typeof value.is_primary, 'boolean');
    assert.equal(typeof value.profile_role, 'string');
    assert.equal(value.clinic_role, target.clinicRole, 'MEMBERSHIP_ROLE_MISMATCH');
    assert.equal(value.system_role, target.systemRole, 'MEMBERSHIP_SYSTEM_ROLE_MISMATCH');
  };
  const boundary = context => {
    context = row(context);
    assert.equal(context?.ready, true, 'MEMBERSHIP_CONTEXT_NOT_READY');
    assert.equal(context.clinic_id, clinicId, 'MEMBERSHIP_CONTEXT_CLINIC_MISMATCH');
    assert.equal(context.clinic_role, target.clinicRole, 'MEMBERSHIP_CONTEXT_ROLE_MISMATCH');
    assert.equal(context.system_role, target.systemRole, 'MEMBERSHIP_CONTEXT_SYSTEM_ROLE_MISMATCH');
    assert.equal(context.effective_role, target.effectiveRole, 'MEMBERSHIP_CONTEXT_EFFECTIVE_ROLE_MISMATCH');
  };
  const receipt = (value, operation, before, id, restoreId, original) => {
    exactKeys(value, receiptKeys);
    assert.equal(value.schema_version, 1);
    assert.equal(value.actor_id, actor);
    assert.equal(value.clinic_id, clinicId);
    assert.equal(value.profile_id, userId);
    assert.equal(value.request_id, id);
    assert.equal(value.operation, operation);
    assert.equal(value.restore_request_id, restoreId);
    assert.ok(typeof value.completed_at === 'string' && Number.isFinite(Date.parse(value.completed_at)), 'MEMBERSHIP_RECEIPT_TIME_INVALID');
    assert.deepEqual(value.before, before, 'MEMBERSHIP_RECEIPT_BEFORE_MISMATCH');
    state(value.after);
    assert.notEqual(value.after.state_version, before.state_version, 'MEMBERSHIP_VERSION_NOT_ADVANCED');
    const expected = operation === 'suspend' ? { ...before, active: false, is_primary: false } : original;
    assert.deepEqual({ ...value.after, state_version: expected.state_version }, expected, 'MEMBERSHIP_RECEIPT_AFTER_MISMATCH');
    return structuredClone(value);
  };
  const request = async payload => {
    // At most two identical transmissions. A failure never changes the UUID,
    // expected state, or restore reference and never causes a latest-state rebase.
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await rpc('admin_transition_staff_membership', structuredClone(payload)); }
      catch (error) {
        if (attempt === 1) throw new Error('MEMBERSHIP_MUTATION_UNCONFIRMED_PROTECTED_RECOVERY_REQUIRED', { cause: error });
      }
    }
  };
  const initial = structuredClone(await rpc('admin_read_staff_membership_state', {
    p_clinic_id: clinicId, p_user_id: userId
  }));
  state(initial);
  assert.equal(initial.active, true, 'MEMBERSHIP_MUST_START_ACTIVE');
  boundary(await readAccessContext());
  assert.equal(await readClinicalCapability(), true, 'MEMBERSHIP_MUST_START_CLINICAL');
  const offPayload = {
    p_clinic_id: clinicId, p_user_id: userId, p_expected_state: initial,
    p_request_id: offId, p_reason: 'Authenticated staging account-disable verification',
    p_restore_request_id: null
  };
  // Malformed/lost OFF confirmation never enters the restoration path.
  const off = receipt(await request(offPayload), 'suspend', initial, offId, null, initial);
  let denialFailure;
  try {
    assert.deepEqual(await request(offPayload), off, 'MEMBERSHIP_IDEMPOTENCY_REPLAY_MISMATCH');
    const disabledContext = row(await readAccessContext());
    assert.ok(disabledContext === undefined || disabledContext === null, 'DISABLED_MEMBERSHIP_RETAINED_CONTEXT');
    assert.equal(await readClinicalCapability(), false, 'DISABLED_MEMBERSHIP_RETAINED_CLINICAL_ACCESS');
  } catch (error) {
    denialFailure = error;
  }
  // A confirmed OFF alone permits this exact receipt-bound restore. The server
  // rejects concurrent writes, changed roles/primary clinic, and rebased states.
  const on = receipt(await request({
    p_clinic_id: clinicId, p_user_id: userId, p_expected_state: off.after,
    p_request_id: onId, p_reason: 'Restore synthetic practitioner after staging verification',
    p_restore_request_id: offId
  }), 'restore', off.after, onId, offId, initial);
  boundary(await readAccessContext());
  assert.equal(await readClinicalCapability(), true, 'MEMBERSHIP_RESTORED_CLINICAL_ACCESS_MISSING');
  if (denialFailure) throw denialFailure;
  const closureConfirmation = {
    schemaVersion: 1,
    componentVersion: MEMBERSHIP_PROOF_VERSION,
    scope: 'staff-membership-uat',
    status: 'verified',
    requestId: on.request_id,
    offRequestId: off.request_id,
    onRequestId: on.request_id,
    beforeVersion: off.before.state_version,
    suspendedVersion: off.after.state_version,
    restoredVersion: on.after.state_version,
    offCompletedAt: off.completed_at,
    onCompletedAt: on.completed_at
  };
  return {
    role: target.clinicRole, offRequestId: offId, onRequestId: onId,
    existingTokenDenied: true, reactivated: true, restoredOriginalBoundary: true,
    idempotencyReplayVerified: true, beforeVersion: initial.state_version,
    suspendedVersion: off.after.state_version, restoredVersion: on.after.state_version,
    closureConfirmation
  };
}
