import assert from 'node:assert/strict';

export const MEMBERSHIP_PROOF_VERSION = '1.0.0-candidate.2';
export const MEMBERSHIP_CHECKPOINT_VERSION = MEMBERSHIP_PROOF_VERSION;
const stateKeys = ['active','clinic_id','clinic_role','is_primary','profile_id','profile_role','state_version','system_role'];
const receiptKeys = ['actor_id','after','before','clinic_id','completed_at','operation','profile_id','request_id','restore_request_id','schema_version'];
const snapshotKeys = ['schemaVersion','componentVersion','executionKind','phase','target','actorId','requestIds','initial','off','on','denialPassed'];
const uuid = value => {
  assert.equal(typeof value, 'string', 'MEMBERSHIP_UUID_INVALID');
  assert.equal(value.length, 36, 'MEMBERSHIP_UUID_INVALID');
  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, 'MEMBERSHIP_UUID_INVALID');
  return value.toLowerCase();
};
const row = value => Array.isArray(value) ? value[0] : value;
const exactKeys = (value, keys) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'MEMBERSHIP_PROOF_OBJECT_INVALID');
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), 'MEMBERSHIP_PROOF_KEYS_INVALID');
};
function validators(target, actor) {
  for (const key of ['clinicRole', 'systemRole', 'effectiveRole']) { assert.equal(typeof target[key], 'string', 'MEMBERSHIP_BOUNDARY_REQUIRED'); assert.ok(target[key].length > 0, 'MEMBERSHIP_BOUNDARY_REQUIRED'); }
  assert.notEqual(actor, target.userId, 'SELF_MEMBERSHIP_TRANSITION_NOT_ALLOWED');
  const state = value => { exactKeys(value, stateKeys); assert.equal(value.clinic_id, target.clinicId); assert.equal(value.profile_id, target.userId); assert.equal(value.state_version, uuid(value.state_version), 'MEMBERSHIP_VERSION_NOT_CANONICAL'); assert.equal(typeof value.active, 'boolean'); assert.equal(typeof value.is_primary, 'boolean'); assert.equal(typeof value.profile_role, 'string'); assert.equal(value.clinic_role, target.clinicRole); assert.equal(value.system_role, target.systemRole); return structuredClone(value); };
  const receipt = (value, operation, before, id, restoreId, original) => { exactKeys(value, receiptKeys); assert.equal(value.schema_version, 1); assert.equal(value.actor_id, actor); assert.equal(value.clinic_id, target.clinicId); assert.equal(value.profile_id, target.userId); assert.equal(value.request_id, id); assert.equal(value.operation, operation); assert.equal(value.restore_request_id, restoreId); assert.ok(typeof value.completed_at === 'string' && Number.isFinite(Date.parse(value.completed_at))); assert.deepEqual(value.before, before); state(value.after); assert.notEqual(value.after.state_version, before.state_version); const expected = operation === 'suspend' ? { ...before, active: false, is_primary: false } : original; assert.deepEqual({ ...value.after, state_version: expected.state_version }, expected); return structuredClone(value); };
  return { state, receipt };
}

/** Candidate-side UAT logic, not a protected publisher or crash-recovery daemon.
 * Request IDs must be retained by the protected runner for cross-process retry.
 * Never fall back to the legacy void/unversioned membership RPC.
 */
export async function runStaffMembershipProof({ rpc, readAccessContext, readClinicalCapability,
  target, actorId, requestIds, checkpoint }) {
  const clinicId = uuid(target.clinicId), userId = uuid(target.userId);
  const actor = uuid(actorId), offId = uuid(requestIds.off), onId = uuid(requestIds.on);
  assert.notEqual(actor, userId, 'SELF_MEMBERSHIP_TRANSITION_NOT_ALLOWED');
  assert.notEqual(offId, onId, 'MEMBERSHIP_REQUEST_IDS_MUST_DIFFER');
  for (const value of [target.clinicRole, target.systemRole, target.effectiveRole]) {
    assert.equal(typeof value, 'string', 'MEMBERSHIP_BOUNDARY_REQUIRED');
    assert.ok(value.length > 0, 'MEMBERSHIP_BOUNDARY_REQUIRED');
  }
  const { state, receipt } = validators({ clinicId, userId, clinicRole: target.clinicRole, systemRole: target.systemRole, effectiveRole: target.effectiveRole }, actor);
  const boundary = context => {
    context = row(context);
    assert.equal(context?.ready, true, 'MEMBERSHIP_CONTEXT_NOT_READY');
    assert.equal(context.clinic_id, clinicId, 'MEMBERSHIP_CONTEXT_CLINIC_MISMATCH');
    assert.equal(context.clinic_role, target.clinicRole, 'MEMBERSHIP_CONTEXT_ROLE_MISMATCH');
    assert.equal(context.system_role, target.systemRole, 'MEMBERSHIP_CONTEXT_SYSTEM_ROLE_MISMATCH');
    assert.equal(context.effective_role, target.effectiveRole, 'MEMBERSHIP_CONTEXT_EFFECTIVE_ROLE_MISMATCH');
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
  const save = async (phase, off = null, on = null, denialPassed = null) => {
    if (checkpoint) await checkpoint(structuredClone({ schemaVersion: 1, componentVersion: MEMBERSHIP_PROOF_VERSION,
      executionKind: 'uat', phase, target: { clinicId, userId, clinicRole: target.clinicRole, systemRole: target.systemRole, effectiveRole: target.effectiveRole },
      actorId: actor, requestIds: { off: offId, on: onId }, initial: structuredClone(initial), off: off && structuredClone(off), on: on && structuredClone(on), denialPassed }));
  };
  await save('off-intent');
  const offPayload = {
    p_clinic_id: clinicId, p_user_id: userId, p_expected_state: initial,
    p_request_id: offId, p_reason: 'Authenticated staging account-disable verification',
    p_restore_request_id: null
  };
  // Malformed/lost OFF confirmation never enters the restoration path.
  const off = receipt(await request(offPayload), 'suspend', initial, offId, null, initial);
  await save('off-confirmed', off);
  let denialFailure;
  try {
    assert.deepEqual(await request(offPayload), off, 'MEMBERSHIP_IDEMPOTENCY_REPLAY_MISMATCH');
    const disabledContext = row(await readAccessContext());
    assert.ok(disabledContext === undefined || disabledContext === null, 'DISABLED_MEMBERSHIP_RETAINED_CONTEXT');
    assert.equal(await readClinicalCapability(), false, 'DISABLED_MEMBERSHIP_RETAINED_CLINICAL_ACCESS');
  } catch (error) {
    denialFailure = error;
  }
  await save('on-intent', off, null, !denialFailure);
  // A confirmed OFF alone permits this exact receipt-bound restore. The server
  // rejects concurrent writes, changed roles/primary clinic, and rebased states.
  const on = receipt(await request({
    p_clinic_id: clinicId, p_user_id: userId, p_expected_state: off.after,
    p_request_id: onId, p_reason: 'Restore synthetic practitioner after staging verification',
    p_restore_request_id: offId
  }), 'restore', off.after, onId, offId, initial);
  await save('on-confirmed', off, on, !denialFailure);
  boundary(await readAccessContext());
  assert.equal(await readClinicalCapability(), true, 'MEMBERSHIP_RESTORED_CLINICAL_ACCESS_MISSING');
  const fresh = structuredClone(await rpc('admin_read_staff_membership_state', {
    p_clinic_id: clinicId, p_user_id: userId
  }));
  state(fresh);
  assert.deepEqual(fresh, on.after, 'MEMBERSHIP_RESTORED_CURRENT_STATE_MISMATCH');
  if (denialFailure) throw denialFailure;
  await save('completed', off, on, true);
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

/** Recover one exact checkpoint; never rebases state or allocates request IDs. */
export async function recoverStaffMembershipProof({ rpc, readAccessContext, readClinicalCapability,
  target, actorId, requestIds, snapshot, checkpoint }) {
  assert.equal(typeof checkpoint, 'function', 'MEMBERSHIP_RECOVERY_CHECKPOINT_REQUIRED');
  const clinicId = uuid(target.clinicId), userId = uuid(target.userId), actor = uuid(actorId);
  const offId = uuid(requestIds.off), onId = uuid(requestIds.on);
  assert.notEqual(offId, onId, 'MEMBERSHIP_REQUEST_IDS_MUST_DIFFER');
  const v = validators({ clinicId, userId, clinicRole: target.clinicRole, systemRole: target.systemRole, effectiveRole: target.effectiveRole }, actor);
  exactKeys(snapshot, snapshotKeys);
  assert.equal(snapshot.schemaVersion, 1); assert.equal(snapshot.componentVersion, MEMBERSHIP_PROOF_VERSION);
  assert.ok(['uat', 'recovery'].includes(snapshot.executionKind), 'MEMBERSHIP_SNAPSHOT_EXECUTION_KIND_INVALID');
  if (snapshot.phase === 'completed') throw new Error('MEMBERSHIP_COMPLETED_RECOVERY_REFUSED');
  assert.ok(['off-intent','off-confirmed','on-intent','on-confirmed'].includes(snapshot.phase), 'MEMBERSHIP_SNAPSHOT_PHASE_INVALID');
  assert.deepEqual(snapshot.target, { clinicId, userId, clinicRole: target.clinicRole, systemRole: target.systemRole, effectiveRole: target.effectiveRole }, 'MEMBERSHIP_SNAPSHOT_TARGET_MISMATCH');
  assert.equal(snapshot.actorId, actor, 'MEMBERSHIP_SNAPSHOT_ACTOR_MISMATCH');
  assert.deepEqual(snapshot.requestIds, { off: offId, on: onId }, 'MEMBERSHIP_SNAPSHOT_REQUEST_IDS_MISMATCH');
  const initial = v.state(snapshot.initial); assert.equal(initial.active, true); assert.equal(snapshot.phase === 'off-intent' ? snapshot.off : true, snapshot.phase === 'off-intent' ? null : true);
  if (['off-confirmed', 'on-intent', 'on-confirmed'].includes(snapshot.phase)) assert.ok(snapshot.off, 'MEMBERSHIP_SNAPSHOT_OFF_REQUIRED');
  if (['off-intent', 'off-confirmed'].includes(snapshot.phase)) { assert.equal(snapshot.denialPassed, null, 'MEMBERSHIP_SNAPSHOT_DENIAL_EARLY'); assert.equal(snapshot.on, null, 'MEMBERSHIP_SNAPSHOT_ON_TOO_EARLY'); }
  if (['on-intent', 'on-confirmed'].includes(snapshot.phase)) {
    assert.ok(snapshot.denialPassed === null || typeof snapshot.denialPassed === 'boolean', 'MEMBERSHIP_SNAPSHOT_DENIAL_INVALID');
    if (snapshot.executionKind === 'uat') assert.equal(typeof snapshot.denialPassed, 'boolean', 'MEMBERSHIP_SNAPSHOT_DENIAL_REQUIRED');
  }
  if (snapshot.phase === 'off-confirmed') assert.equal(snapshot.on, null, 'MEMBERSHIP_SNAPSHOT_ON_TOO_EARLY');
  if (snapshot.phase === 'on-intent') assert.equal(snapshot.on, null, 'MEMBERSHIP_SNAPSHOT_ON_TOO_EARLY');
  if (snapshot.phase === 'on-confirmed') assert.ok(snapshot.on, 'MEMBERSHIP_SNAPSHOT_ON_REQUIRED');
  let off = snapshot.off && v.receipt(snapshot.off, 'suspend', initial, offId, null, initial); let on = snapshot.on && v.receipt(snapshot.on, 'restore', off.after, onId, offId, initial);
  const save = async value => checkpoint(structuredClone({ ...value, executionKind: 'recovery' }));
  await save(snapshot);
  if (snapshot.phase === 'off-intent') { off = v.receipt(await requestTwiceRecovery(rpc, { p_clinic_id: clinicId, p_user_id: userId, p_expected_state: initial, p_request_id: offId, p_reason: 'Authenticated staging account-disable verification', p_restore_request_id: null }), 'suspend', initial, offId, null, initial); await save({ ...snapshot, phase: 'off-confirmed', off, on: null, denialPassed: null }); }
  if (snapshot.phase === 'off-intent' || snapshot.phase === 'off-confirmed') { await save({ ...snapshot, phase: 'on-intent', off, on: null, denialPassed: snapshot.denialPassed }); }
  if (snapshot.phase !== 'on-confirmed') { on = v.receipt(await requestTwiceRecovery(rpc, { p_clinic_id: clinicId, p_user_id: userId, p_expected_state: off.after, p_request_id: onId, p_reason: 'Restore synthetic practitioner after staging verification', p_restore_request_id: offId }), 'restore', off.after, onId, offId, initial); await save({ ...snapshot, phase: 'on-confirmed', off, on, denialPassed: snapshot.denialPassed }); }
  const context = row(await readAccessContext()); assert.equal(context?.ready, true); assert.equal(context.clinic_id, clinicId); assert.equal(context.clinic_role, target.clinicRole); assert.equal(context.system_role, target.systemRole); assert.equal(context.effective_role, target.effectiveRole); assert.equal(await readClinicalCapability(), true); const fresh = v.state(await rpc('admin_read_staff_membership_state', { p_clinic_id: clinicId, p_user_id: userId })); assert.deepEqual(fresh, on.after, 'MEMBERSHIP_RESTORED_CURRENT_STATE_MISMATCH'); await save({ ...snapshot, phase: 'completed', off, on, denialPassed: snapshot.denialPassed });
  return { disposition: 'recovered', freshUatEvidence: false, requestId: onId, offRequestId: offId, onRequestId: onId, beforeVersion: initial.state_version, suspendedVersion: off.after.state_version, restoredVersion: on.after.state_version };
}

async function requestTwiceRecovery(rpc, payload) { for (let attempt = 0; attempt < 2; attempt++) { try { return await rpc('admin_transition_staff_membership', structuredClone(payload)); } catch (error) { if (attempt === 1) throw new Error('MEMBERSHIP_MUTATION_UNCONFIRMED_PROTECTED_RECOVERY_REQUIRED', { cause: error }); } } }
