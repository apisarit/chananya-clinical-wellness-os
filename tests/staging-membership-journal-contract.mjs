import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { initializeMembershipJournal, withMembershipJournal, readMembershipJournal, abandonUnstartedMembershipRun } from '../ops/cnyos-staging-controller/scripts/membership-journal-store.mjs';

const childFile = fileURLToPath(new URL('./fixtures/membership-journal-child.mjs', import.meta.url));
function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cnyos-membership-journal-')));
  fs.chmodSync(directory, 0o700);
  initializeMembershipJournal(directory);
  const binding = { schemaVersion: 1, environment: 'cnyos-staging', runId: randomUUID(),
    controllerCommit: 'a'.repeat(40), candidateCommit: 'b'.repeat(40), artifactSha256: 'c'.repeat(64), actorId: randomUUID(),
    target: { clinicId: randomUUID(), userId: randomUUID(), clinicRole: 'practitioner', systemRole: 'staff', effectiveRole: 'practitioner' },
    requestIds: { off: randomUUID(), on: randomUUID() } };
  const initial = { active: true, clinic_id: binding.target.clinicId, clinic_role: 'practitioner', is_primary: true,
    profile_id: binding.target.userId, profile_role: 'practitioner', state_version: randomUUID(), system_role: 'staff' };
  let state = structuredClone(initial);
  const receipts = new Map(), calls = [], children = new Set();
  t.after(async () => {
    for (const child of children) child.kill('SIGKILL');
    await Promise.all([...children].map(child => child.exited));
    // Only this test's unique temporary directory, never application data.
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const context = () => state.active ? [{ ready: true, clinic_id: initial.clinic_id,
    clinic_role: state.clinic_role, system_role: state.system_role, effective_role: 'practitioner' }] : [];
  function rpc({ name, body }) {
    calls.push(structuredClone({ name, body }));
    if (name === 'admin_read_staff_membership_state') return structuredClone(state);
    assert.equal(name, 'admin_transition_staff_membership');
    const previous = receipts.get(body.p_request_id);
    if (previous) {
      assert.deepEqual(body, previous.payload, 'request must not be rebased');
      return structuredClone(previous.receipt);
    }
    assert.deepEqual(body.p_expected_state, state, 'synthetic CAS conflict');
    const restore = body.p_restore_request_id !== null;
    if (restore) assert.equal(body.p_restore_request_id, binding.requestIds.off);
    const after = restore ? { ...initial, state_version: randomUUID() }
      : { ...state, active: false, is_primary: false, state_version: randomUUID() };
    const receipt = { actor_id: binding.actorId, after, before: structuredClone(state), clinic_id: initial.clinic_id,
      completed_at: new Date().toISOString(), operation: restore ? 'restore' : 'suspend', profile_id: initial.profile_id,
      request_id: body.p_request_id, restore_request_id: body.p_restore_request_id, schema_version: 1 };
    receipts.set(body.p_request_id, { payload: structuredClone(body), receipt: structuredClone(receipt) });
    state = structuredClone(after);
    return receipt;
  }
  function start({ mode = 'start', useBinding = binding, pause, afterRpc } = {}) {
    const child = fork(childFile, [], { cwd: directory, env: { LANG: 'C', NODE_NO_WARNINGS: '1' },
      execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    children.add(child);
    let result, failure, pausedResolve, output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => { failure = 'CHILD_DEADLINE'; child.kill('SIGKILL'); }, 10000);
    child.paused = new Promise(resolve => { pausedResolve = resolve; });
    child.on('message', message => {
      if (message.kind === 'result') { result = message.value; return; }
      if (message.kind === 'failure') { failure = message.code; return; }
      if (message.kind === 'checkpoint' && pause?.(message.value)) {
        pausedResolve(message.value); return;
      }
      try {
        const value = message.kind === 'rpc' ? rpc(message.value)
          : message.kind === 'context' ? context()
            : message.kind === 'capability' ? state.active : null;
        if (message.kind === 'rpc' && afterRpc?.(message.value)) {
          pausedResolve(message.value); return; // Server committed, reply lost.
        }
        child.send({ kind: 'response', id: message.id, value });
      } catch (error) { child.send({ kind: 'response', id: message.id, error: error.message }); }
    });
    child.exited = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code, signal) => {
        clearTimeout(timer); children.delete(child);
        pausedResolve(null);
        resolve({ code, signal, result, failure, output });
      });
    });
    child.send({ directory, binding: useBinding, mode });
    return child;
  }
  return { directory, binding, initial, receipts, calls, start,
    get state() { return structuredClone(state); },
    change: update => { state = { ...state, ...update }; } };
}

for (const crashPoint of ['off-intent', 'off-commit', 'on-intent', 'on-commit', 'on-confirmed']) {
  test(`SIGKILL at ${crashPoint}: same-operation recovery, no duplicate effects or fresh UAT claim`, { timeout: 20000 }, async t => {
    const f = fixture(t);
    const child = f.start({
      pause: snapshot => snapshot.phase === crashPoint,
      afterRpc: ({ name, body }) => name === 'admin_transition_staff_membership' &&
        ((crashPoint === 'off-commit' && body.p_restore_request_id === null) ||
         (crashPoint === 'on-commit' && body.p_restore_request_id !== null))
    });
    assert.ok(await child.paused, 'child must reach the acknowledged crash barrier');
    const before = readMembershipJournal({ directory: f.directory, binding: f.binding });
    assert.ok(before.snapshot);
    child.kill('SIGKILL');
    assert.equal((await child.exited).signal, 'SIGKILL');
    const recovered = await f.start({ mode: 'recover' }).exited;
    assert.equal(recovered.code, 0, recovered.failure || recovered.output);
    assert.equal(recovered.result.disposition, 'recovered');
    assert.equal(recovered.result.freshUatEvidence, false);
    assert.equal(recovered.result.requestId, f.binding.requestIds.on);
    assert.equal(recovered.result.closureConfirmation, undefined);
    assert.equal(f.receipts.size, 2);
    assert.deepEqual({ ...f.state, state_version: f.initial.state_version }, f.initial);
    const saved = readMembershipJournal({ directory: f.directory, binding: f.binding });
    assert.equal(saved.snapshot.phase, 'completed');
    assert.equal(saved.snapshot.executionKind, 'recovery');
    assert.equal(saved.freshUatEvidence, false);
    const callCount = f.calls.length;
    const repeated = await f.start({ mode: 'recover' }).exited;
    assert.equal(repeated.code, 1);
    assert.match(repeated.failure, /COMPLETED_RUN_NOT_FRESH/);
    assert.equal(f.calls.length, callCount);
  });
}

test('exclusive process lock and unresolved-run guard preserve the original intent', { timeout: 20000 }, async t => {
  const f = fixture(t), child = f.start({ pause: s => s.phase === 'off-intent' });
  assert.ok(await child.paused);
  const other = { ...f.binding, runId: randomUUID(), requestIds: { off: randomUUID(), on: randomUUID() } };
  const busy = await f.start({ useBinding: other }).exited;
  assert.equal(busy.code, 1); assert.match(busy.failure, /BUSY|locked/i);
  assert.equal(f.receipts.size, 0);
  child.kill('SIGKILL'); await child.exited;
  const unreconciled = await f.start({ useBinding: other }).exited;
  assert.equal(unreconciled.code, 1); assert.match(unreconciled.failure, /PRIOR_RUN_UNRECONCILED/);
  assert.equal((await f.start({ mode: 'recover' }).exited).code, 0);
});

test('recovery can itself stop and recover again using unchanged IDs', { timeout: 20000 }, async t => {
  const f = fixture(t);
  const first = f.start({ afterRpc: ({ name, body }) => name === 'admin_transition_staff_membership' && body.p_restore_request_id === null });
  assert.ok(await first.paused); first.kill('SIGKILL'); await first.exited;
  const second = f.start({ mode: 'recover', pause: s => s.phase === 'on-intent' });
  assert.ok(await second.paused); second.kill('SIGKILL'); await second.exited;
  const result = await f.start({ mode: 'recover' }).exited;
  assert.equal(result.code, 0, result.failure); assert.equal(f.receipts.size, 2);
  assert.equal(result.result.freshUatEvidence, false);
});

test('completed UAT survives lost final acknowledgment and status stays historical', { timeout: 20000 }, async t => {
  const f = fixture(t), child = f.start({ pause: s => s.phase === 'completed' });
  assert.ok(await child.paused); child.kill('SIGKILL'); await child.exited;
  const before = fs.readFileSync(path.join(f.directory, 'membership-journal.sqlite'));
  const count = f.calls.length;
  const status = await f.start({ mode: 'status' }).exited;
  assert.equal(status.code, 0); assert.equal(status.result.historical, true);
  assert.equal(status.result.freshUatEvidence, false);
  assert.equal((await f.start({ mode: 'recover' }).exited).code, 1);
  assert.equal((await f.start().exited).code, 1);
  assert.equal(f.calls.length, count);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, 'membership-journal.sqlite')), before);
});

test('source/actor/target binding mismatch and concurrent ordinary edits stop recovery', { timeout: 20000 }, async t => {
  const f = fixture(t), child = f.start({ pause: s => s.phase === 'on-intent' });
  assert.ok(await child.paused); child.kill('SIGKILL'); await child.exited;
  const count = f.calls.length;
  for (const change of [{ candidateCommit: 'd'.repeat(40) }, { actorId: randomUUID() },
    { target: { ...f.binding.target, clinicId: randomUUID() } }]) {
    const result = await f.start({ mode: 'recover', useBinding: { ...f.binding, ...change } }).exited;
    assert.equal(result.code, 1); assert.match(result.failure, /BINDING_CHANGED/);
  }
  assert.equal(f.calls.length, count);
  f.change({ state_version: randomUUID(), clinic_role: 'viewer' });
  const changed = f.state;
  assert.equal((await f.start({ mode: 'recover' }).exited).code, 1);
  assert.deepEqual(f.state, changed); assert.equal(f.receipts.size, 1);
  assert.equal(readMembershipJournal({ directory: f.directory, binding: f.binding }).snapshot.phase, 'on-intent');
});

test('explicit private initialization and immutable IDs; no silent fresh store on recovery', async t => {
  const f = fixture(t);
  assert.throws(() => initializeMembershipJournal(f.directory), /ALREADY_INITIALIZED/);
  const completed = await f.start().exited;
  assert.equal(completed.code, 0, completed.failure);
  const other = { ...f.binding, runId: randomUUID() };
  let called = false;
  await assert.rejects(withMembershipJournal({ directory: f.directory, binding: other, mode: 'start' }, async () => { called = true; }));
  assert.equal(called, false);
  fs.chmodSync(path.join(f.directory, 'membership-journal.sqlite'), 0o644);
  assert.throws(() => readMembershipJournal({ directory: f.directory, binding: f.binding }), /PRIVATE_REGULAR/);
});

test('crash before first intent can be abandoned without effects; next distinct run is permitted', { timeout: 20000 }, async t => {
  const f = fixture(t);
  // Only the initial read has completed; no checkpoint or mutation can follow
  // until this acknowledged barrier is released.
  const child = f.start({ afterRpc: ({ name }) => name === 'admin_read_staff_membership_state' });
  assert.ok(await child.paused);
  assert.equal(readMembershipJournal({ directory: f.directory, binding: f.binding }).snapshot, null);
  child.kill('SIGKILL'); await child.exited;
  const calls = f.calls.length;
  const abandoned = await abandonUnstartedMembershipRun({ directory: f.directory, binding: f.binding });
  assert.equal(abandoned.disposition, 'abandoned-before-effects');
  assert.equal(abandoned.freshUatEvidence, false);
  assert.equal(f.calls.length, calls); assert.equal(f.receipts.size, 0);
  assert.deepEqual(f.state, f.initial);
  assert.equal(readMembershipJournal({ directory: f.directory, binding: f.binding }).disposition, 'abandoned-before-effects');
  await assert.rejects(withMembershipJournal({ directory: f.directory, binding: f.binding, mode: 'recover' }, () => {}), /COMPLETED_RUN_NOT_FRESH/);
  const next = { ...f.binding, runId: randomUUID(), requestIds: { off: randomUUID(), on: randomUUID() } };
  // Test only store admission: complete no external operations in this new run.
  let admitted = false;
  await assert.rejects(withMembershipJournal({ directory: f.directory, binding: next, mode: 'start' }, () => {
    admitted = true; throw new Error('READ_CONTEXT_FAILED_BEFORE_INTENT');
  }), /READ_CONTEXT_FAILED_BEFORE_INTENT/);
  assert.equal(admitted, true);
  await abandonUnstartedMembershipRun({ directory: f.directory, binding: next });
  assert.equal(f.calls.length, calls);
  // Original request IDs stay reserved, even after abandoning an unused run.
  await assert.rejects(withMembershipJournal({ directory: f.directory,
    binding: { ...f.binding, runId: randomUUID() }, mode: 'start' }, () => assert.fail('must not enter')));
});

test('an existing intent cannot be abandoned or rebound', { timeout: 20000 }, async t => {
  const f = fixture(t), child = f.start({ pause: s => s.phase === 'off-intent' });
  assert.ok(await child.paused); child.kill('SIGKILL'); await child.exited;
  const before = readMembershipJournal({ directory: f.directory, binding: f.binding });
  await assert.rejects(abandonUnstartedMembershipRun({ directory: f.directory, binding: f.binding }), /INTENT_EXISTS_RECOVERY_REQUIRED/);
  await assert.rejects(abandonUnstartedMembershipRun({ directory: f.directory,
    binding: { ...f.binding, controllerCommit: 'd'.repeat(40) } }), /BINDING_CHANGED/);
  assert.deepEqual(readMembershipJournal({ directory: f.directory, binding: f.binding }), before);
  assert.equal(f.receipts.size, 0);
});
