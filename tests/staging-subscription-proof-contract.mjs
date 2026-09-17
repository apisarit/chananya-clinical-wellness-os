import assert from 'node:assert/strict';
import { runOwnerSubscriptionProof } from '../scripts/staging-subscription-proof.mjs';

const target = { clinicId: 'clinic-a', clinicCode: 'A-STG', clinicRole: 'practitioner', systemRole: 'staff', effectiveRole: 'practitioner' };
const actor = { userId: 'owner-a', email: 'owner@example.test' };
const ids = { off: '11111111-1111-4111-8111-111111111111', on: '22222222-2222-4222-8222-222222222222' };

function mock(options = {}) {
  const version = Object.hasOwn(options, 'version') ? options.version : 7;
  const initialState = options.initialState || 'active';
  const fail = options.fail || {};
  const dropAfterCommit = options.dropAfterCommit || {};
  const failReplay = options.failReplay || {};
  let bumpBeforeOn = options.bumpBeforeOn === true;
  const freshIdempotent = options.freshIdempotent === true;
  const receiptPatch = options.receiptPatch || {};
  const contextPatch = options.contextPatch || {};
  const restoredContextPatch = options.restoredContextPatch || {};
  const restoredClinical = options.restoredClinical;
  const hasOriginalContextResult = Object.hasOwn(options, 'originalContextResult');
  const hasSuspendedContextResult = Object.hasOwn(options, 'suspendedContextResult');
  const hasRestoredContextResult = Object.hasOwn(options, 'restoredContextResult');
  const originalContextResult = options.originalContextResult;
  const suspendedContextResult = options.suspendedContextResult;
  const restoredContextResult = options.restoredContextResult;
  let bumpBeforeWrite = options.bumpBeforeWrite === true;
  const state = { enabled: initialState === 'active', version, writes: [], calls: 0, restored: false };
  const receipts = new Map();
  const access = () => {
    if (!state.enabled) return hasSuspendedContextResult ? suspendedContextResult : [];
    const context = { ready: true, clinic_id: target.clinicId, clinic_code: target.clinicCode, clinic_role: target.clinicRole,
      system_role: contextPatch.system_role || 'staff', effective_role: contextPatch.effective_role || 'practitioner',
      ...(state.restored ? restoredContextPatch : contextPatch) };
    if (state.restored) return hasRestoredContextResult ? restoredContextResult : [context];
    return hasOriginalContextResult ? originalContextResult : [context];
  };
  const capability = () => state.enabled && (state.restored ? restoredClinical !== false : true);
  const serviceRpc = async (name, body) => {
    state.calls += 1;
    if (name === 'list_owner_subscription_clinics') {
      return [{ clinic_id: target.clinicId, clinic_code: target.clinicCode, enabled: state.enabled,
        subscription_state: state.enabled ? 'active' : 'suspended', subscription_version: state.version }];
    }
    assert.equal(name, 'set_clinic_subscription_state');
    if (bumpBeforeWrite) {
      bumpBeforeWrite = false;
      state.version += 1;
    }
    assert.deepEqual(Object.keys(body).sort(), [
      'p_actor_email', 'p_actor_user_id', 'p_clinic_id', 'p_enabled',
      'p_expected_clinic_code', 'p_expected_version', 'p_reason', 'p_request_id'
    ]);
    state.writes.push(structuredClone(body));
    if (fail[body.p_request_id] > 0) {
      fail[body.p_request_id] -= 1;
      throw new Error('simulated lost response');
    }
    const prior = receipts.get(body.p_request_id);
    if (prior) {
      if (JSON.stringify(prior.payload) !== JSON.stringify(body)) throw new Error('request-id conflict');
      if (failReplay[body.p_request_id] > 0) {
        failReplay[body.p_request_id] -= 1;
        throw new Error('replay response lost');
      }
      if (dropAfterCommit[body.p_request_id] > 0) {
        dropAfterCommit[body.p_request_id] -= 1;
        throw new Error('committed but response lost');
      }
      return { ...prior.receipt, idempotent: true };
    }
    if (body.p_clinic_id !== target.clinicId || body.p_expected_clinic_code !== target.clinicCode) throw new Error('binding mismatch');
    if (body.p_expected_version !== state.version) throw new Error('version conflict');
    if (bumpBeforeOn && body.p_enabled) {
      bumpBeforeOn = false;
      state.version += 1;
      throw new Error('other operator changed state');
    }
    state.version += 1;
    state.enabled = body.p_enabled;
    if (body.p_enabled) state.restored = true;
    const receipt = { clinicId: target.clinicId, clinicCode: target.clinicCode, enabled: state.enabled,
      state: state.enabled ? 'active' : 'suspended', version: state.version, changed: true,
      idempotent: freshIdempotent && !state.enabled, ...receiptPatch };
    receipts.set(body.p_request_id, { payload: structuredClone(body), receipt });
    if (dropAfterCommit[body.p_request_id] > 0) {
      dropAfterCommit[body.p_request_id] -= 1;
      throw new Error('committed but response lost');
    }
    return receipt;
  };
  return { state, serviceRpc, readAccessContext: access, readClinicalCapability: capability };
}

async function run(options = {}) {
  const m = mock(options);
  const evidence = await runOwnerSubscriptionProof({
    serviceRpc: m.serviceRpc,
    readAccessContext: m.readAccessContext,
    readClinicalCapability: m.readClinicalCapability,
    target,
    actor,
    requestIds: options.requestIds || ids
  });
  return { ...m, evidence };
}

const mixedCaseIds = {
  off: 'AaAaAaAa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  on: 'BbBbBbBb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
};
const canonicalMixedCaseIds = {
  off: mixedCaseIds.off.toLowerCase(),
  on: mixedCaseIds.on.toLowerCase()
};
const mixedCase = await run({ requestIds: mixedCaseIds });
assert.equal(mixedCase.evidence.offRequestId, canonicalMixedCaseIds.off);
assert.equal(mixedCase.evidence.onRequestId, canonicalMixedCaseIds.on);
assert.equal(mixedCase.state.writes[0].p_request_id, canonicalMixedCaseIds.off);
assert.equal(mixedCase.state.writes.at(-1).p_request_id, canonicalMixedCaseIds.on);

let preflightCalls = 0;
const sameMixedCase = { off: 'AaAaAaAa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', on: 'aAaAaAaA-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
await assert.rejects(runOwnerSubscriptionProof({
  serviceRpc: async () => { preflightCalls += 1; },
  readAccessContext: async () => { preflightCalls += 1; },
  readClinicalCapability: async () => { preflightCalls += 1; },
  target,
  actor,
  requestIds: sameMixedCase
}), /request ids must be distinct/);
assert.equal(preflightCalls, 0, 'same UUID mixed-case variants must reject before any RPC or access read');

const success = await run();
assert.equal(success.evidence.existingTokenDenied, true);
assert.equal(success.evidence.offReplayIdempotent, true);
assert.equal(success.evidence.restoredOriginalBoundary, true);
assert.equal(success.state.version, 9);
assert.deepEqual(success.state.writes[0], {
  p_request_id: ids.off, p_clinic_id: target.clinicId, p_expected_clinic_code: target.clinicCode,
  p_enabled: false, p_expected_version: 7, p_reason: 'Authenticated staging database suspension proof',
  p_actor_user_id: actor.userId, p_actor_email: actor.email
});
assert.equal(success.state.writes.at(-1).p_expected_version, 8);

for (const badVersion of [undefined, '7', 0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1]) {
  const m = mock({ version: badVersion });
  await assert.rejects(runOwnerSubscriptionProof({
    serviceRpc: m.serviceRpc, readAccessContext: m.readAccessContext,
    readClinicalCapability: m.readClinicalCapability, target, actor, requestIds: ids
  }), /INVALID_INITIAL_VERSION|INITIAL_VERSION_HAS_NO_ROOM/);
  assert.equal(m.state.writes.length, 0, 'invalid initial version must reject before mutation');
}

const stale = mock({ bumpBeforeWrite: true });
await assert.rejects(runOwnerSubscriptionProof({
  serviceRpc: stale.serviceRpc, readAccessContext: stale.readAccessContext,
  readClinicalCapability: stale.readClinicalCapability, target, actor, requestIds: ids
}), /RECOVERY_REQUIRED_OFF_UNCONFIRMED/);
assert.equal(stale.state.enabled, true, 'stale OFF must not rebase or overwrite another operator');

const lostOff = await run({ fail: { [ids.off]: 1 } });
assert.equal(lostOff.state.version, 9);
assert.equal(lostOff.evidence.restoredOriginalBoundary, true);
const lostOn = await run({ fail: { [ids.on]: 1 } });
assert.equal(lostOn.state.version, 9);
assert.equal(lostOn.evidence.restoredOriginalBoundary, true);

const committedLostOff = await run({ dropAfterCommit: { [ids.off]: 1 } });
assert.equal(committedLostOff.state.version, 9);
assert.equal(committedLostOff.evidence.restoredOriginalBoundary, true);
const committedLostOn = await run({ dropAfterCommit: { [ids.on]: 1 } });
assert.equal(committedLostOn.state.version, 9);
assert.equal(committedLostOn.evidence.restoredOriginalBoundary, true);

const committedAndLostOff = mock({ dropAfterCommit: { [ids.off]: 2 } });
await assert.rejects(runOwnerSubscriptionProof({
  serviceRpc: committedAndLostOff.serviceRpc, readAccessContext: committedAndLostOff.readAccessContext,
  readClinicalCapability: committedAndLostOff.readClinicalCapability, target, actor, requestIds: ids
}), /RECOVERY_REQUIRED_OFF_UNCONFIRMED/);
assert.equal(committedAndLostOff.state.enabled, false);
const committedLostOffWrites = committedAndLostOff.state.writes.filter(write => write.p_request_id === ids.off);
assert.equal(committedLostOffWrites.length, 2);
assert.deepEqual(committedLostOffWrites[1], committedLostOffWrites[0]);
assert.equal(committedAndLostOff.state.writes.filter(write => write.p_request_id === ids.on).length, 0);

const committedAndLostOn = mock({ dropAfterCommit: { [ids.on]: 2 } });
await assert.rejects(runOwnerSubscriptionProof({
  serviceRpc: committedAndLostOn.serviceRpc, readAccessContext: committedAndLostOn.readAccessContext,
  readClinicalCapability: committedAndLostOn.readClinicalCapability, target, actor, requestIds: ids
}), /RECOVERY_REQUIRED_ON_UNCONFIRMED/);
assert.equal(committedAndLostOn.state.enabled, true);
const committedLostOnWrites = committedAndLostOn.state.writes.filter(write => write.p_request_id === ids.on);
assert.equal(committedLostOnWrites.length, 2);
assert.deepEqual(committedLostOnWrites[1], committedLostOnWrites[0]);
assert.equal(committedLostOnWrites[0].p_expected_version, 8);
assert.equal(committedLostOnWrites[1].p_expected_version, 8);

const denialFailure = mock();
denialFailure.readClinicalCapability = () => true;
await assert.rejects(runOwnerSubscriptionProof({
  serviceRpc: denialFailure.serviceRpc, readAccessContext: denialFailure.readAccessContext,
  readClinicalCapability: denialFailure.readClinicalCapability, target, actor, requestIds: ids
}), /retained Clinical capability/);
assert.equal(denialFailure.state.enabled, true, 'denial assertion failure must still restore');
assert.equal(denialFailure.state.version, 9);

const unresolvedOff = mock({ fail: { [ids.off]: 2 } });
await assert.rejects(runOwnerSubscriptionProof({
  serviceRpc: unresolvedOff.serviceRpc, readAccessContext: unresolvedOff.readAccessContext,
  readClinicalCapability: unresolvedOff.readClinicalCapability, target, actor, requestIds: ids
}), /RECOVERY_REQUIRED_OFF_UNCONFIRMED/);
assert.equal(unresolvedOff.state.enabled, true);
assert.equal(unresolvedOff.state.writes.filter(write => write.p_request_id === ids.on).length, 0);

const unresolvedOn = mock({ fail: { [ids.on]: 2 } });
await assert.rejects(runOwnerSubscriptionProof({
  serviceRpc: unresolvedOn.serviceRpc, readAccessContext: unresolvedOn.readAccessContext,
  readClinicalCapability: unresolvedOn.readClinicalCapability, target, actor, requestIds: ids
}), /RECOVERY_REQUIRED_ON_UNCONFIRMED/);
assert.equal(unresolvedOn.state.enabled, false, 'unresolved ON must not claim restoration');

const replayLost = mock({ failReplay: { [ids.off]: 2 } });
await assert.rejects(runOwnerSubscriptionProof({
  serviceRpc: replayLost.serviceRpc, readAccessContext: replayLost.readAccessContext,
  readClinicalCapability: replayLost.readClinicalCapability, target, actor, requestIds: ids
}), /RECOVERY_REQUIRED_OFF_REPLAY_UNCONFIRMED/);
assert.equal(replayLost.state.enabled, true, 'OFF replay failure must still clean up with ON');
const replayLostOffWrites = replayLost.state.writes.filter(write => write.p_request_id === ids.off);
assert.equal(replayLostOffWrites.length, 3);
assert.deepEqual(replayLostOffWrites[1], replayLostOffWrites[0]);
assert.deepEqual(replayLostOffWrites[2], replayLostOffWrites[0]);
const replayLostOnWrites = replayLost.state.writes.filter(write => write.p_request_id === ids.on);
assert.equal(replayLostOnWrites.length, 1);
assert.equal(replayLostOnWrites[0].p_expected_version, 8);

const denialAndRecoveryFailure = mock({ fail: { [ids.on]: 2 } });
denialAndRecoveryFailure.readClinicalCapability = () => true;
await assert.rejects(runOwnerSubscriptionProof({
  serviceRpc: denialAndRecoveryFailure.serviceRpc, readAccessContext: denialAndRecoveryFailure.readAccessContext,
  readClinicalCapability: denialAndRecoveryFailure.readClinicalCapability, target, actor, requestIds: ids
}), error => error instanceof AggregateError && error.errors.some(item => /retained Clinical capability/.test(item.message)) && error.errors.some(item => /RECOVERY_REQUIRED_ON_UNCONFIRMED/.test(item.message)));
const denialRecoveryOnWrites = denialAndRecoveryFailure.state.writes.filter(write => write.p_request_id === ids.on);
assert.equal(denialRecoveryOnWrites.length, 2);
assert.deepEqual(denialRecoveryOnWrites[1], denialRecoveryOnWrites[0]);

const staleRestore = mock({ bumpBeforeOn: true });
await assert.rejects(runOwnerSubscriptionProof({
  serviceRpc: staleRestore.serviceRpc, readAccessContext: staleRestore.readAccessContext,
  readClinicalCapability: staleRestore.readClinicalCapability, target, actor, requestIds: ids
}), /RECOVERY_REQUIRED_ON_UNCONFIRMED/);
assert.equal(staleRestore.state.enabled, false, 'conflicting restore must not overwrite another operator');
assert.equal(staleRestore.state.version, 9, 'conflicting restore must preserve other operator version');

const invalidMarker = mock({ freshIdempotent: true });
await assert.rejects(runOwnerSubscriptionProof({
  serviceRpc: invalidMarker.serviceRpc, readAccessContext: invalidMarker.readAccessContext,
  readClinicalCapability: invalidMarker.readClinicalCapability, target, actor, requestIds: ids
}), /idempotent marker mismatch/);
assert.equal(invalidMarker.state.enabled, false, 'invalid fresh idempotent receipt must not be normalized as a confirmed mutation');
assert.equal(invalidMarker.state.calls, 2, 'invalid fresh idempotent receipt must not retry or blindly restore');

for (const receiptPatch of [{ version: 99 }, { clinicCode: 'OTHER' }, { changed: false }, { idempotent: 'true' }]) {
  const malformed = mock({ receiptPatch });
  await assert.rejects(runOwnerSubscriptionProof({
    serviceRpc: malformed.serviceRpc, readAccessContext: malformed.readAccessContext,
    readClinicalCapability: malformed.readClinicalCapability, target, actor, requestIds: ids
  }));
  assert.equal(malformed.state.calls, 2, 'malformed receipt must not retry or blindly restore');
}

const roleMismatch = mock({ contextPatch: { effective_role: 'admin' } });
await assert.rejects(runOwnerSubscriptionProof({
  serviceRpc: roleMismatch.serviceRpc, readAccessContext: roleMismatch.readAccessContext,
  readClinicalCapability: roleMismatch.readClinicalCapability, target, actor, requestIds: ids
}), /effective role mismatch/);

for (const [field, value, expectedError] of [
  ['ready', false, /context is not ready/],
  ['clinic_id', 'other-clinic', /clinic id mismatch/],
  ['clinic_code', 'OTHER', /clinic code mismatch/],
  ['clinic_role', 'admin', /clinic role mismatch/],
  ['system_role', 'admin', /system role mismatch/],
  ['effective_role', 'admin', /effective role mismatch/]
]) {
  const mismatch = mock({ restoredContextPatch: { [field]: value } });
  await assert.rejects(runOwnerSubscriptionProof({
    serviceRpc: mismatch.serviceRpc, readAccessContext: mismatch.readAccessContext,
    readClinicalCapability: mismatch.readClinicalCapability, target, actor, requestIds: ids
  }), expectedError);
  assert.equal(mismatch.state.enabled, true);
}
const capabilityMismatch = mock({ restoredClinical: false });
await assert.rejects(runOwnerSubscriptionProof({
  serviceRpc: capabilityMismatch.serviceRpc, readAccessContext: capabilityMismatch.readAccessContext,
  readClinicalCapability: capabilityMismatch.readClinicalCapability, target, actor, requestIds: ids
}), /regain clinical capability/);

const validContext = {
  ready: true, clinic_id: target.clinicId, clinic_code: target.clinicCode,
  clinic_role: target.clinicRole, system_role: target.systemRole, effective_role: target.effectiveRole
};
for (const malformed of [null, undefined, validContext, [], [null], [[]], [validContext, { ...validContext, clinic_code: 'OTHER' }]]) {
  const malformedOriginal = mock({ originalContextResult: malformed });
  await assert.rejects(runOwnerSubscriptionProof({
    serviceRpc: malformedOriginal.serviceRpc, readAccessContext: malformedOriginal.readAccessContext,
    readClinicalCapability: malformedOriginal.readClinicalCapability, target, actor, requestIds: ids
  }), /original access context/);
  assert.equal(malformedOriginal.state.writes.length, 0, 'malformed original context must reject before OFF');
}

for (const malformed of [null, undefined, validContext, [validContext], [null], [[]], [validContext, { ...validContext, clinic_code: 'OTHER' }]]) {
  const malformedSuspended = mock({ suspendedContextResult: malformed });
  await assert.rejects(runOwnerSubscriptionProof({
    serviceRpc: malformedSuspended.serviceRpc, readAccessContext: malformedSuspended.readAccessContext,
    readClinicalCapability: malformedSuspended.readClinicalCapability, target, actor, requestIds: ids
  }), /suspended access context/);
  assert.equal(malformedSuspended.state.enabled, true, 'malformed suspended context must still restore ON');
  assert.equal(malformedSuspended.state.writes.filter(write => write.p_request_id === ids.on).length, 1);
}

for (const malformed of [null, undefined, validContext, [], [null], [[]], [validContext, { ...validContext, clinic_code: 'OTHER' }]]) {
  const malformedRestored = mock({ restoredContextResult: malformed });
  await assert.rejects(runOwnerSubscriptionProof({
    serviceRpc: malformedRestored.serviceRpc, readAccessContext: malformedRestored.readAccessContext,
    readClinicalCapability: malformedRestored.readClinicalCapability, target, actor, requestIds: ids
  }), /restored access context/);
  assert.equal(malformedRestored.state.enabled, true, 'malformed restored context must not succeed');
}

console.log('Staging subscription proof contract passed: version-bound idempotency, conflict isolation, retry and recovery semantics');
