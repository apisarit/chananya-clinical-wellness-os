import assert from 'node:assert/strict';
import { recoverStaffMembershipProof, runStaffMembershipProof, MEMBERSHIP_PROOF_VERSION } from '../scripts/staging-membership-proof.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const target = { clinicId: id(1), userId: id(2), clinicRole: 'practitioner', systemRole: 'staff', effectiveRole: 'practitioner' };
const actor = id(3), ids = { off: id(4), on: id(5) };
const state = (active, version, primary = active) => ({ active, clinic_id: target.clinicId, clinic_role: 'practitioner', is_primary: primary, profile_id: target.userId, profile_role: 'practitioner', state_version: id(version), system_role: 'staff' });
const initial = state(true, 10), suspended = state(false, 11, false), restored = state(true, 12);
const receipt = (operation, before, after, requestId, restoreRequestId) => ({ actor_id: actor, after, before, clinic_id: target.clinicId, completed_at: '2026-09-12T00:00:00.000Z', operation, profile_id: target.userId, request_id: requestId, restore_request_id: restoreRequestId, schema_version: 1 });
const makeRpc = ({ lose = new Set() } = {}) => { let current = structuredClone(initial); const calls = []; const seen = new Map(); return { calls, get current() { return current; }, async rpc(name, body = {}) { calls.push({ name, body: structuredClone(body) }); if (name === 'admin_read_staff_membership_state') return structuredClone(current); if (name !== 'admin_transition_staff_membership') throw new Error('unexpected rpc'); const idv = body.p_request_id; if (seen.has(idv)) return structuredClone(seen.get(idv)); const off = body.p_expected_state.active === true; const next = off ? suspended : restored; const r = receipt(off ? 'suspend' : 'restore', body.p_expected_state, next, idv, body.p_restore_request_id); current = structuredClone(next); seen.set(idv, r); if (lose.has(idv)) { lose.delete(idv); throw new Error('lost response'); } return structuredClone(r); } }; };
const context = async () => [{ ready: true, clinic_id: target.clinicId, clinic_code: 'STG', clinic_role: 'practitioner', system_role: 'staff', effective_role: 'practitioner' }];
const cap = async () => true;
const snap = phase => ({ schemaVersion: 1, componentVersion: MEMBERSHIP_PROOF_VERSION, executionKind: 'uat', phase, target, actorId: actor, requestIds: ids, initial, off: null, on: null, denialPassed: null });

// Checkpoint is durable-before-mutation, and a failed checkpoint prevents the next RPC.
{
  const events = [], rpc = makeRpc();
  await assert.rejects(runStaffMembershipProof({ rpc: rpc.rpc, readAccessContext: context, readClinicalCapability: cap, target, actorId: actor, requestIds: ids, checkpoint: async s => { events.push(s.phase); if (s.phase === 'off-intent') throw new Error('checkpoint failed'); } }));
  assert.deepEqual(events, ['off-intent']); assert.equal(rpc.calls.filter(c => c.name === 'admin_transition_staff_membership').length, 0);
}

// Lost OFF and ON responses are retried with the same IDs and expected states.
{
  const rpc = makeRpc({ lose: new Set([ids.off, ids.on]) }), checkpoints = [];
  const result = await recoverStaffMembershipProof({ rpc: rpc.rpc, readAccessContext: context, readClinicalCapability: cap, target, actorId: actor, requestIds: ids, snapshot: snap('off-intent'), checkpoint: async s => checkpoints.push(s) });
  assert.equal(result.disposition, 'recovered'); assert.equal(result.freshUatEvidence, false); assert.deepEqual(rpc.calls.filter(c => c.name === 'admin_transition_staff_membership').map(c => c.body.p_request_id), [ids.off, ids.off, ids.on, ids.on]); assert.deepEqual(checkpoints.map(s => s.phase), ['off-intent', 'off-confirmed', 'on-intent', 'on-confirmed', 'completed']);
}

// Completed recovery is refused before any RPC or checkpoint I/O.
{
  const rpc = makeRpc(); let checkpoints = 0;
  const completed = { ...snap('completed'), off: receipt('suspend', initial, suspended, ids.off, null), on: receipt('restore', suspended, restored, ids.on, ids.off), denialPassed: true };
  await assert.rejects(recoverStaffMembershipProof({ rpc: rpc.rpc, readAccessContext: context, readClinicalCapability: cap, target, actorId: actor, requestIds: ids, snapshot: completed, checkpoint: async () => { checkpoints++; } }), /COMPLETED_RECOVERY_REFUSED/);
  assert.equal(rpc.calls.length, 0); assert.equal(checkpoints, 0);
}

// Malformed/cross-target/phase snapshots are rejected before I/O.
for (const mutate of [s => { s.target = { ...target, clinicId: id(99) }; }, s => { s.requestIds = { off: id(9), on: ids.on }; }, s => { s.phase = 'bad'; }, s => { s.off = receipt('restore', initial, restored, ids.off, null); }]) {
  const rpc = makeRpc(); const bad = snap('off-intent'); mutate(bad);
  await assert.rejects(recoverStaffMembershipProof({ rpc: rpc.rpc, readAccessContext: context, readClinicalCapability: cap, target, actorId: actor, requestIds: ids, snapshot: bad, checkpoint: async () => {} })); assert.equal(rpc.calls.length, 0);
}

for (const denialPassed of [{}, 'yes', 1]) {
  const rpc = makeRpc();
  const bad = { ...snap('on-intent'), executionKind: 'recovery', off: receipt('suspend', initial, suspended, ids.off, null), denialPassed };
  await assert.rejects(recoverStaffMembershipProof({ rpc: rpc.rpc, readAccessContext: context, readClinicalCapability: cap, target, actorId: actor, requestIds: ids, snapshot: bad, checkpoint: async () => {} }));
  assert.equal(rpc.calls.length, 0);
}

{
  const rpc = makeRpc();
  const selfTarget = { ...target, userId: actor };
  await assert.rejects(recoverStaffMembershipProof({ rpc: rpc.rpc, readAccessContext: context, readClinicalCapability: cap, target: selfTarget, actorId: actor, requestIds: ids, snapshot: snap('off-intent'), checkpoint: async () => {} }), /SELF_MEMBERSHIP_TRANSITION_NOT_ALLOWED/);
  assert.equal(rpc.calls.length, 0);
}

// Current-state drift after ON prevents completion/closure.
{
  const rpc = makeRpc(); const checkpoints = []; const original = rpc.rpc; rpc.rpc = async (name, body) => { const value = await original(name, body); if (name === 'admin_read_staff_membership_state' && rpc.calls.filter(c => c.name === name).length > 1) return state(true, 99); return value; };
  await assert.rejects(runStaffMembershipProof({ rpc: rpc.rpc, readAccessContext: context, readClinicalCapability: cap, target, actorId: actor, requestIds: ids, checkpoint: async s => checkpoints.push(s.phase) }), /CURRENT_STATE_MISMATCH/);
  assert.deepEqual(checkpoints, ['off-intent', 'off-confirmed', 'on-intent', 'on-confirmed']);
}

process.stdout.write('CNYOS staging membership checkpoint contract: passed\n');
