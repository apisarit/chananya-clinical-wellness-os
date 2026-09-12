import assert from 'node:assert/strict';

const MAX_SAFE_VERSION = Number.MAX_SAFE_INTEGER;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function receiptRow(value) {
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new Error('OWNER_SUBSCRIPTION_PROOF_RECEIPT_SHAPE_INVALID');
    return value[0];
  }
  return value;
}

function singleContextRow(value, label) {
  assert.ok(Array.isArray(value), `${label} access context must be an array`);
  assert.equal(value.length, 1, `${label} access context must contain exactly one row`);
  const row = value[0];
  assert.ok(row && typeof row === 'object' && !Array.isArray(row), `${label} access context row is invalid`);
  return row;
}

function fail(message) {
  throw new Error(`OWNER_SUBSCRIPTION_PROOF_${message}`);
}

function versionOf(value, label) {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) fail(`INVALID_${label.toUpperCase()}_VERSION`);
  return value;
}

function canonicalRequestId(value, label) {
  if (typeof value !== 'string' || value.length !== 36 || !UUID_V4.test(value)) {
    fail('INVALID_' + label.toUpperCase() + '_REQUEST_ID');
  }
  return value.toLowerCase();
}

function requestBody({ requestId, clinicId, clinicCode, enabled, expectedVersion, reason, actor }) {
  return Object.freeze({
    p_request_id: requestId,
    p_clinic_id: clinicId,
    p_expected_clinic_code: clinicCode,
    p_enabled: enabled,
    p_expected_version: expectedVersion,
    p_reason: reason,
    p_actor_user_id: actor.userId,
    p_actor_email: actor.email
  });
}

function assertReceipt(receipt, expected) {
  const value = receiptRow(receipt);
  assert.ok(value && typeof value === 'object', 'owner mutation returned no receipt');
  assert.equal(value.clinicId, expected.clinicId, 'owner receipt clinic id mismatch');
  assert.equal(value.clinicCode, expected.clinicCode, 'owner receipt clinic code mismatch');
  assert.equal(value.enabled, expected.enabled, 'owner receipt enabled mismatch');
  assert.equal(value.state, expected.enabled ? 'active' : 'suspended', 'owner receipt state mismatch');
  assert.equal(value.changed, true, 'owner mutation did not report changed=true');
  assert.equal(value.version, expected.version, 'owner receipt version mismatch');
  assert.equal(typeof value.idempotent, 'boolean', 'owner receipt idempotent marker is invalid');
  if (expected.idempotent !== undefined) assert.equal(value.idempotent, expected.idempotent, 'owner receipt idempotent marker mismatch');
  return Object.freeze({
    clinicId: value.clinicId,
    clinicCode: value.clinicCode,
    enabled: value.enabled,
    state: value.state,
    version: value.version,
    changed: value.changed,
    idempotent: value.idempotent
  });
}

async function mutateBounded({ serviceRpc, payload, expected, phase }) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response;
    try {
      response = await serviceRpc('set_clinic_subscription_state', payload);
    } catch (error) {
      if (attempt === 1) {
        throw new Error(phase === 'ON'
          ? 'OWNER_SUBSCRIPTION_PROOF_RECOVERY_REQUIRED_ON_UNCONFIRMED'
          : `OWNER_SUBSCRIPTION_PROOF_RECOVERY_REQUIRED_${phase}_UNCONFIRMED`);
      }
      continue;
    }
    return assertReceipt(response, { ...expected, idempotent: attempt === 0 ? false : undefined });
  }
}

async function replayBounded({ serviceRpc, payload, expectedVersion }) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response;
    try {
      response = await serviceRpc('set_clinic_subscription_state', payload);
    } catch (error) {
      if (attempt === 1) throw new Error('OWNER_SUBSCRIPTION_PROOF_RECOVERY_REQUIRED_OFF_REPLAY_UNCONFIRMED');
      continue;
    }
    return assertReceipt(response, {
      clinicId: payload.p_clinic_id,
      clinicCode: payload.p_expected_clinic_code,
      enabled: false,
      version: expectedVersion,
      idempotent: true
    });
  }
}

function assertOriginalBoundary(result, expected) {
  const context = singleContextRow(result?.context, 'restored');
  assert.equal(context?.clinic_id, expected.clinicId, 'restored access clinic id mismatch');
  assert.equal(context?.clinic_code, expected.clinicCode, 'restored access clinic code mismatch');
  assert.equal(context?.clinic_role, expected.clinicRole, 'restored access clinic role mismatch');
  assert.equal(context?.ready, true, 'restored access context is not ready');
  assert.equal(context?.system_role, expected.systemRole, 'restored system role mismatch');
  assert.equal(context?.effective_role, expected.effectiveRole, 'restored effective role mismatch');
  assert.equal(result?.clinical, true, 'restored access did not regain clinical capability');
}

export async function runOwnerSubscriptionProof({
  serviceRpc,
  readAccessContext,
  readClinicalCapability,
  target,
  actor,
  requestIds,
  reasons = {}
}) {
  assert.equal(typeof serviceRpc, 'function');
  assert.equal(typeof readAccessContext, 'function');
  assert.equal(typeof readClinicalCapability, 'function');
  const clinicId = target.clinicId;
  const clinicCode = target.clinicCode;
  assert.ok(clinicId && clinicCode && actor?.userId && actor?.email, 'owner proof target is incomplete');
  assert.ok(target.clinicRole && target.systemRole && target.effectiveRole, 'owner proof role boundary is incomplete');
  const offRequestId = canonicalRequestId(requestIds?.off, 'off');
  const onRequestId = canonicalRequestId(requestIds?.on, 'on');
  assert.notEqual(offRequestId, onRequestId, 'owner proof request ids must be distinct');

  const rows = await serviceRpc('list_owner_subscription_clinics', {});
  const matches = (Array.isArray(rows) ? rows : []).filter(row => row?.clinic_id === clinicId);
  assert.equal(matches.length, 1, 'owner proof requires exactly one matching clinic row');
  const initial = matches[0];
  assert.equal(initial.clinic_code, clinicCode, 'owner proof initial clinic code mismatch');
  assert.equal(initial.enabled, true, 'staging subscription must start ON before the reversible enforcement proof');
  assert.equal(initial.subscription_state, 'active', 'staging subscription must start active before proof');
  const initialVersion = versionOf(initial.subscription_version, 'initial');
  if (initialVersion > MAX_SAFE_VERSION - 2) fail('INITIAL_VERSION_HAS_NO_ROOM_FOR_RESTORE');
  const expectedBoundary = {
    clinicId,
    clinicCode,
    clinicRole: target.clinicRole,
    systemRole: target.systemRole,
    effectiveRole: target.effectiveRole
  };
  const originalContext = singleContextRow(await readAccessContext(), 'original');
  assert.equal(originalContext?.ready, true, 'original practitioner context is not ready');
  assert.equal(originalContext?.clinic_id, clinicId, 'original practitioner clinic id mismatch');
  assert.equal(originalContext?.clinic_code, clinicCode, 'original practitioner clinic code mismatch');
  assert.equal(originalContext?.clinic_role, expectedBoundary.clinicRole, 'original practitioner clinic role mismatch');
  assert.equal(originalContext?.system_role, expectedBoundary.systemRole, 'original practitioner system role mismatch');
  assert.equal(originalContext?.effective_role, expectedBoundary.effectiveRole, 'original practitioner effective role mismatch');
  const evidence = {
    clinicCode,
    offRequestId,
    onRequestId,
    initialVersion,
    existingTokenDenied: false,
    restoredOriginalBoundary: false,
    databaseEnforced: false,
    offReplayIdempotent: false
  };

  let offReceipt;
  let originalFailure;
  try {
    const offPayload = requestBody({
      requestId: offRequestId,
      clinicId,
      clinicCode,
      enabled: false,
      expectedVersion: initialVersion,
      reason: reasons.off || 'Authenticated staging database suspension proof',
      actor
    });
    const offPayloadSnapshot = JSON.stringify(offPayload);
    offReceipt = await mutateBounded({
      serviceRpc,
      payload: offPayload,
      phase: 'OFF',
      expected: { clinicId, clinicCode, enabled: false, version: initialVersion + 1 }
    });
    assert.equal(JSON.stringify(offPayload), offPayloadSnapshot, 'OFF payload changed before exact replay');
    await replayBounded({ serviceRpc, payload: offPayload, expectedVersion: offReceipt.version });
    evidence.offReplayIdempotent = true;

    const suspendedContext = await readAccessContext();
    const suspendedClinical = await readClinicalCapability();
    assert.ok(Array.isArray(suspendedContext), 'suspended access context must be an array');
    assert.equal(suspendedContext.length, 0, 'suspended access context must be empty');
    assert.equal(suspendedClinical, false, 'existing practitioner token retained Clinical capability while subscription was OFF');
    evidence.existingTokenDenied = true;
    evidence.databaseEnforced = true;
  } catch (error) {
    originalFailure = error;
  } finally {
    if (offReceipt) {
      try {
        const onPayload = requestBody({
          requestId: onRequestId,
          clinicId,
          clinicCode,
          enabled: true,
          expectedVersion: offReceipt.version,
          reason: reasons.on || 'Restore staging subscription after enforcement proof',
          actor
        });
        const onReceipt = await mutateBounded({
          serviceRpc,
          payload: onPayload,
          phase: 'ON',
          expected: { clinicId, clinicCode, enabled: true, version: offReceipt.version + 1 }
        });
        const restoredContext = await readAccessContext();
        const restoredClinical = await readClinicalCapability();
        assertOriginalBoundary({ context: restoredContext, clinical: restoredClinical }, expectedBoundary);
        evidence.restoredOriginalBoundary = true;
        evidence.restoreVersion = onReceipt.version;
      } catch (restoreError) {
        if (originalFailure) {
          throw new AggregateError([originalFailure, restoreError], 'OWNER_SUBSCRIPTION_PROOF_RECOVERY_FAILED');
        }
        throw restoreError;
      }
    }
  }
  if (originalFailure) throw originalFailure;
  return evidence;
}
