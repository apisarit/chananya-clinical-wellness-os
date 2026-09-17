import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { MEMBERSHIP_PROOF_VERSION, runStaffMembershipProof } from '../scripts/staging-membership-proof.mjs';

// Minimal, disposable business-state fixture. No network, JWT service, or live
// schema is used. These tests do not certify the production RLS/helper graph.
const candidate = await readFile(new URL('../supabase/manual/staff_membership_recovery_candidate.sql', import.meta.url), 'utf8');
const start = '-- BEGIN LOCAL FIXTURE DEFINITIONS';
const end = '-- END LOCAL FIXTURE DEFINITIONS';
assert.equal(candidate.split(start).length, 2);
assert.equal(candidate.split(end).length, 2);
const definitions = candidate.split(start)[1].split(end)[0];
const actor = '11111111-1111-4111-8111-111111111111';
const staff = '22222222-2222-4222-8222-222222222222';
const otherActor = '33333333-3333-4333-8333-333333333333';
const clinic = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherClinic = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

async function fixture(t, { install = true } = {}) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('test.actor_id',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
    CREATE TABLE public.profiles(id uuid PRIMARY KEY, role text NOT NULL, system_role text NOT NULL);
    CREATE TABLE public.clinic_memberships(
      clinic_id uuid NOT NULL, profile_id uuid NOT NULL REFERENCES public.profiles(id),
      clinic_role text NOT NULL, active boolean NOT NULL DEFAULT true,
      is_primary boolean NOT NULL DEFAULT false, joined_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(clinic_id,profile_id)
    );
    CREATE UNIQUE INDEX clinic_memberships_one_primary_idx
      ON public.clinic_memberships(profile_id) WHERE is_primary AND active;
    CREATE TABLE public.audit_logs(
      clinic_id uuid, user_id uuid REFERENCES public.profiles(id), action text,
      entity text, entity_id text, metadata jsonb
    );
    CREATE FUNCTION public.current_clinic_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path=pg_catalog,pg_temp AS $$
        SELECT m.clinic_id FROM public.clinic_memberships m
        WHERE m.profile_id=auth.uid() AND m.active ORDER BY m.is_primary DESC,m.joined_at LIMIT 1
      $$;
    CREATE FUNCTION public.department_can(text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path=pg_catalog,pg_temp AS $$
        SELECT $1='governance' AND EXISTS(
          SELECT 1 FROM public.profiles p JOIN public.clinic_memberships m ON m.profile_id=p.id
          WHERE p.id=auth.uid() AND p.system_role='super_admin' AND m.active
            AND m.clinic_id=public.current_clinic_id())
      $$;
    INSERT INTO public.profiles VALUES
      ('${actor}','super_admin','super_admin'),('${staff}','practitioner','staff'),
      ('${otherActor}','super_admin','super_admin');
    INSERT INTO public.clinic_memberships(clinic_id,profile_id,clinic_role,is_primary) VALUES
      ('${clinic}','${actor}','owner',true),('${clinic}','${staff}','practitioner',true),
      ('${clinic}','${otherActor}','owner',true);
  `);
  if (install) await db.exec(`BEGIN; ${definitions} COMMIT;`);
  const setActor = id => db.query('SELECT set_config($1,$2,false)', ['test.actor_id', id || '']);
  await setActor(actor);
  const state = async () => (await db.query(
    'SELECT public.admin_read_staff_membership_state($1::uuid,$2::uuid) AS value', [clinic, staff]
  )).rows[0].value;
  const call = async (expected, { id = randomUUID(), restore = null, reason = 'Synthetic membership test', targetClinic = clinic, targetUser = staff } = {}) =>
    (await db.query('SELECT public.admin_transition_staff_membership($1::uuid,$2::uuid,$3::jsonb,$4::uuid,$5::text,$6::uuid) AS value',
      [targetClinic, targetUser, JSON.stringify(expected), id, reason, restore])).rows[0].value;
  const counts = async () => (await db.query(`SELECT
    (SELECT count(*)::int FROM public.staff_membership_transition_requests) AS requests,
    (SELECT count(*)::int FROM public.audit_logs) AS audits`)).rows[0];
  return { db, state, call, counts, setActor };
}

test('direct candidate is blocked before schema changes, even in the fixture', async t => {
  const { db } = await fixture(t, { install: false });
  await assert.rejects(db.exec(candidate), /STAFF_MEMBERSHIP_RECOVERY_REVIEW_REQUIRED/);
  await db.exec('ROLLBACK');
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_schema='public' AND table_name='clinic_memberships' AND column_name='state_version'`)).rows[0].n, 0);
  assert.equal((await db.query("SELECT to_regclass('public.staff_membership_transition_requests') AS r")).rows[0].r, null);
});

test('lost-response replay is identical and restore recovers only the recorded boundary', async t => {
  const { db, state, call, counts } = await fixture(t);
  const initial = await state();
  const offId = randomUUID(), onId = randomUUID();
  await db.exec('SET ROLE authenticated');
  const off = await call(initial, { id: offId });
  assert.deepEqual(await call(initial, { id: offId }), off);
  assert.equal(off.after.active, false);
  assert.equal(off.after.is_primary, false);
  assert.notEqual(off.after.state_version, initial.state_version);
  const on = await call(off.after, { id: onId, restore: offId });
  assert.deepEqual(await call(off.after, { id: onId, restore: offId }), on);
  const restored = await state();
  assert.notEqual(restored.state_version, initial.state_version);
  assert.deepEqual({ ...restored, state_version: initial.state_version }, initial);
  // Replaying OFF after restoration is historical only; it must not disable again.
  assert.deepEqual(await call(initial, { id: offId }), off);
  assert.deepEqual(await state(), restored);
  await db.exec('RESET ROLE');
  assert.deepEqual(await counts(), { requests: 2, audits: 2 });
});

test('legacy no-op updates invalidate the expected membership version', async t => {
  const { db, state, call, counts } = await fixture(t);
  const old = await state();
  await db.query('UPDATE public.clinic_memberships SET active=active WHERE profile_id=$1', [staff]);
  const current = await state();
  assert.notEqual(current.state_version, old.state_version);
  await assert.rejects(call(old), /MEMBERSHIP_STATE_CONFLICT/);
  assert.deepEqual(await state(), current);
  assert.deepEqual(await counts(), { requests: 0, audits: 0 });
});

test('concurrent staff changes cannot be overwritten or rebased during restore', async t => {
  const { db, state, call, counts } = await fixture(t);
  const offId = randomUUID();
  const off = await call(await state(), { id: offId });
  await db.query("UPDATE public.clinic_memberships SET clinic_role='viewer' WHERE profile_id=$1", [staff]);
  const changed = await state();
  await assert.rejects(call(off.after, { restore: offId }), /MEMBERSHIP_STATE_CONFLICT/);
  await assert.rejects(call(changed, { restore: offId }), /MEMBERSHIP_RESTORE_RECEIPT_MISMATCH/);
  assert.deepEqual(await state(), changed);
  assert.deepEqual(await counts(), { requests: 1, audits: 1 });
});

test('a new primary clinic is retained and cannot be displaced by restoration', async t => {
  const { db, state, call, counts } = await fixture(t);
  const offId = randomUUID();
  const off = await call(await state(), { id: offId });
  await db.query(`INSERT INTO public.clinic_memberships(clinic_id,profile_id,clinic_role,active,is_primary)
    VALUES($1,$2,'viewer',true,true)`, [otherClinic, staff]);
  await assert.rejects(call(off.after, { restore: offId }), /MEMBERSHIP_PRIMARY_CONFLICT/);
  assert.deepEqual(await state(), off.after);
  assert.equal((await db.query('SELECT is_primary FROM public.clinic_memberships WHERE clinic_id=$1 AND profile_id=$2', [otherClinic, staff])).rows[0].is_primary, true);
  assert.deepEqual(await counts(), { requests: 1, audits: 1 });
});

test('request IDs cannot be reused for a different payload', async t => {
  const { state, call, counts } = await fixture(t);
  const initial = await state(), id = randomUUID();
  const off = await call(initial, { id });
  await assert.rejects(call(initial, { id, reason: 'A different reason' }), /MEMBERSHIP_REQUEST_ID_CONFLICT/);
  assert.deepEqual(await state(), off.after);
  assert.deepEqual(await counts(), { requests: 1, audits: 1 });
});

test('audit failure rolls back mutation, version and receipt together', async t => {
  const { db, state, call, counts } = await fixture(t);
  const initial = await state(), id = randomUUID();
  // A benign availability fault in the fixture, not an exploit simulation.
  await db.exec(`CREATE FUNCTION public.fixture_audit_unavailable() RETURNS trigger LANGUAGE plpgsql AS
    $$ BEGIN RAISE EXCEPTION 'FIXTURE_AUDIT_UNAVAILABLE'; END $$;
    CREATE TRIGGER fixture_audit_unavailable BEFORE INSERT ON public.audit_logs
      FOR EACH ROW EXECUTE FUNCTION public.fixture_audit_unavailable();`);
  await assert.rejects(call(initial, { id }), /FIXTURE_AUDIT_UNAVAILABLE/);
  assert.deepEqual(await state(), initial);
  assert.deepEqual(await counts(), { requests: 0, audits: 0 });
  await db.exec('DROP TRIGGER fixture_audit_unavailable ON public.audit_logs');
  assert.equal((await call(initial, { id })).after.active, false);
});

test('caller transaction rollback leaves no committed transition evidence', async t => {
  const { db, state, call, counts } = await fixture(t);
  const initial = await state();
  await db.exec('BEGIN');
  await call(initial);
  await db.exec('ROLLBACK');
  assert.deepEqual(await state(), initial);
  assert.deepEqual(await counts(), { requests: 0, audits: 0 });
});

test('delete/reinsert ABA and explicit old UUID reuse cannot pass the version check', async t => {
  const { db, state, call } = await fixture(t);
  const initial = await state();
  await db.query('DELETE FROM public.clinic_memberships WHERE profile_id=$1', [staff]);
  await db.query(`INSERT INTO public.clinic_memberships(clinic_id,profile_id,clinic_role,is_primary,state_version)
    VALUES($1,$2,'practitioner',true,$3::uuid)`, [clinic, staff, initial.state_version]);
  const recreated = await state();
  assert.notEqual(recreated.state_version, initial.state_version);
  await assert.rejects(call(initial), /MEMBERSHIP_STATE_CONFLICT/);
  await db.query('UPDATE public.clinic_memberships SET state_version=$1::uuid WHERE profile_id=$2', [initial.state_version, staff]);
  assert.notEqual((await state()).state_version, initial.state_version);
});

test('profile-role drift is part of the expected boundary', async t => {
  const { db, state, call, counts } = await fixture(t);
  const initial = await state();
  await db.query("UPDATE public.profiles SET role='viewer' WHERE id=$1", [staff]);
  await assert.rejects(call(initial), /MEMBERSHIP_STATE_CONFLICT/);
  assert.deepEqual(await counts(), { requests: 0, audits: 0 });
});

test('an originally non-primary membership stays non-primary after restoration', async t => {
  const { db, state, call } = await fixture(t);
  await db.query('UPDATE public.clinic_memberships SET is_primary=false WHERE profile_id=$1', [staff]);
  const id = randomUUID(), off = await call(await state(), { id });
  assert.equal((await call(off.after, { restore: id })).after.is_primary, false);
});

test('cross-clinic, missing identity, non-governance and self transitions are denied', async t => {
  const { state, call, setActor, counts } = await fixture(t);
  const initial = await state();
  await assert.rejects(call(initial, { targetClinic: otherClinic }), /GOVERNANCE_DEPARTMENT_REQUIRED/);
  await assert.rejects(call(initial, { targetUser: actor }), /SELF_MEMBERSHIP_TRANSITION_NOT_ALLOWED/);
  await setActor(null);
  await assert.rejects(call(initial), /GOVERNANCE_DEPARTMENT_REQUIRED/);
  await setActor(staff);
  await assert.rejects(call(initial), /GOVERNANCE_DEPARTMENT_REQUIRED/);
  await setActor(actor);
  assert.deepEqual(await counts(), { requests: 0, audits: 0 });
});

test('privileged accounts remain outside the staff recovery contract', async t => {
  const { db, state, call, counts } = await fixture(t);
  for (const role of ['owner', 'admin']) {
    await db.query('UPDATE public.clinic_memberships SET clinic_role=$1 WHERE profile_id=$2', [role, staff]);
    await assert.rejects(call(await state()), /PRIVILEGED_MEMBERSHIP_PROTECTED/);
  }
  await db.query("UPDATE public.clinic_memberships SET clinic_role='practitioner' WHERE profile_id=$1", [staff]);
  for (const role of ['super_admin', 'admin']) {
    await db.query('UPDATE public.profiles SET system_role=$1 WHERE id=$2', [role, staff]);
    await assert.rejects(call(await state()), /PRIVILEGED_MEMBERSHIP_PROTECTED/);
  }
  assert.deepEqual(await counts(), { requests: 0, audits: 0 });
});

test('a different administrator cannot restore another actor receipt', async t => {
  const { state, call, setActor, counts } = await fixture(t);
  const id = randomUUID(), off = await call(await state(), { id });
  await setActor(otherActor);
  await assert.rejects(call(off.after, { restore: id }), /MEMBERSHIP_RESTORE_RECEIPT_MISMATCH/);
  assert.deepEqual(await counts(), { requests: 1, audits: 1 });
});

test('runtime ACLs deny receipt access and anonymous/service function execution', async t => {
  const { db, state, call } = await fixture(t);
  const initial = await state();
  for (const role of ['anon','service_role']) {
    await db.exec(`SET ROLE ${role}`);
    await assert.rejects(state(), /permission denied for function/);
    await assert.rejects(call(initial), /permission denied for function/);
    await db.exec('RESET ROLE');
  }
  await db.exec('SET ROLE authenticated');
  await assert.rejects(db.query('SELECT * FROM public.staff_membership_transition_requests'), /permission denied/);
  await assert.rejects(db.query('DELETE FROM public.staff_membership_transition_requests'), /permission denied/);
  await db.exec('RESET ROLE');
  const functions = (await db.query(`SELECT p.proname,p.prosecdef,p.proconfig,
      has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN (
      'refresh_staff_membership_state_version','admin_read_staff_membership_state','admin_transition_staff_membership')`)).rows;
  assert.equal(functions.length, 3);
  for (const f of functions) {
    assert.equal(f.anon_execute, false);
    assert.ok(f.proconfig.includes('search_path=pg_catalog, pg_temp'));
  }
});

async function proofFixture(t, options = {}) {
  const f = await fixture(t);
  const calls = [];
  let lostOff = 0, lostOn = 0, changed = false;
  const context = () => ({ ready: true, clinic_id: clinic, clinic_role: 'practitioner',
    system_role: 'staff', effective_role: 'practitioner' });
  const args = {
    target: { clinicId: clinic, userId: staff, clinicRole: 'practitioner', systemRole: 'staff', effectiveRole: 'practitioner' },
    actorId: actor, requestIds: { off: randomUUID(), on: randomUUID() },
    rpc: async (name, body) => {
      calls.push({ name, body: structuredClone(body) });
      if (name === 'admin_read_staff_membership_state') return f.state();
      assert.equal(name, 'admin_transition_staff_membership');
      const result = await f.call(body.p_expected_state, { id: body.p_request_id,
        restore: body.p_restore_request_id, reason: body.p_reason,
        targetClinic: body.p_clinic_id, targetUser: body.p_user_id });
      if (!body.p_restore_request_id) {
        if (lostOff++ < (options.lostOff || 0)) throw new Error('SIMULATED_RESPONSE_LOSS');
        if (options.malformedOff) return { ...result, request_id: randomUUID() };
      } else if (lostOn++ < (options.lostOn || 0)) throw new Error('SIMULATED_RESPONSE_LOSS');
      if (body.p_restore_request_id && options.malformedOn) return { ...result, request_id: randomUUID() };
      if (body.p_restore_request_id && options.mismatchedRestoreReference) {
        return { ...result, restore_request_id: randomUUID() };
      }
      return result;
    },
    readAccessContext: async () => {
      const state = await f.state();
      if (!state.active && options.concurrentChange && !changed) {
        changed = true;
        await f.db.query("UPDATE public.clinic_memberships SET clinic_role='viewer' WHERE profile_id=$1", [staff]);
      }
      return state.active || options.denialFailure ? [context()] : [];
    },
    readClinicalCapability: async () => (await f.state()).active
  };
  return { ...f, calls, args };
}

test('UAT helper completes through real candidate RPCs after lost OFF and ON responses', async t => {
  const f = await proofFixture(t, { lostOff: 1, lostOn: 1 });
  const initial = await f.state();
  const result = await runStaffMembershipProof(f.args);
  assert.equal(result.existingTokenDenied, true);
  assert.equal(result.restoredOriginalBoundary, true);
  assert.equal(result.idempotencyReplayVerified, true);
  assert.deepEqual(await f.counts(), { requests: 2, audits: 2 });
  assert.deepEqual({ ...(await f.state()), state_version: initial.state_version }, initial);
  const off = f.calls.filter(c => c.body?.p_request_id === f.args.requestIds.off);
  const on = f.calls.filter(c => c.body?.p_request_id === f.args.requestIds.on);
  assert.equal(off.length, 3); // Lost response, exact retry, explicit replay.
  assert.equal(on.length, 2);
  assert.ok(off.every(c => JSON.stringify(c.body) === JSON.stringify(off[0].body)));
  assert.deepEqual(on[0].body, on[1].body);
  assert.equal(result.closureConfirmation.schemaVersion, 1);
  assert.equal(result.closureConfirmation.componentVersion, MEMBERSHIP_PROOF_VERSION);
  assert.equal(result.closureConfirmation.scope, 'staff-membership-uat');
  assert.equal(result.closureConfirmation.status, 'verified');
  assert.equal(result.closureConfirmation.requestId, f.args.requestIds.on);
  assert.equal(result.closureConfirmation.offRequestId, f.args.requestIds.off);
  assert.equal(result.closureConfirmation.onRequestId, f.args.requestIds.on);
  assert.equal(result.closureConfirmation.beforeVersion, initial.state_version);
  assert.equal(result.closureConfirmation.suspendedVersion, result.suspendedVersion);
  assert.equal(result.closureConfirmation.restoredVersion, result.restoredVersion);
  assert.ok(Number.isFinite(Date.parse(result.closureConfirmation.offCompletedAt)));
  assert.ok(Number.isFinite(Date.parse(result.closureConfirmation.onCompletedAt)));
});

test('both lost ON responses reject and never emit verified closure', async t => {
  const f = await proofFixture(t, { lostOn: 2 });
  await assert.rejects(runStaffMembershipProof(f.args), /MEMBERSHIP_MUTATION_UNCONFIRMED_PROTECTED_RECOVERY_REQUIRED/);
  assert.equal((await f.state()).active, true);
  assert.deepEqual(await f.counts(), { requests: 2, audits: 2 });
});

test('unconfirmed OFF stops without sending a blind restore', async t => {
  const f = await proofFixture(t, { lostOff: 2 });
  await assert.rejects(runStaffMembershipProof(f.args), /MEMBERSHIP_MUTATION_UNCONFIRMED_PROTECTED_RECOVERY_REQUIRED/);
  assert.equal((await f.state()).active, false);
  assert.deepEqual(await f.counts(), { requests: 1, audits: 1 });
  assert.equal(f.calls.some(c => c.body?.p_restore_request_id), false);
});

test('malformed OFF confirmation stops without fabricating recovery evidence', async t => {
  const f = await proofFixture(t, { malformedOff: true });
  await assert.rejects(runStaffMembershipProof(f.args));
  assert.equal(f.calls.some(c => c.body?.p_restore_request_id), false);
  assert.equal((await f.state()).active, false);
});

test('malformed ON confirmation rejects without verified closure', async t => {
  const f = await proofFixture(t, { malformedOn: true });
  await assert.rejects(runStaffMembershipProof(f.args));
  assert.equal((await f.state()).active, true);
  assert.deepEqual(await f.counts(), { requests: 2, audits: 2 });
});

test('mismatched ON restore reference rejects without verified closure', async t => {
  const f = await proofFixture(t, { mismatchedRestoreReference: true });
  await assert.rejects(runStaffMembershipProof(f.args));
  assert.equal((await f.state()).active, true);
  assert.deepEqual(await f.counts(), { requests: 2, audits: 2 });
});

test('failed denial assertion restores a confirmed OFF but never reports UAT success', async t => {
  const f = await proofFixture(t, { denialFailure: true });
  await assert.rejects(runStaffMembershipProof(f.args), /DISABLED_MEMBERSHIP_RETAINED_CONTEXT/);
  assert.equal((await f.state()).active, true);
  assert.deepEqual(await f.counts(), { requests: 2, audits: 2 });
});

test('UAT restore does not rebase to an administrator change', async t => {
  const f = await proofFixture(t, { concurrentChange: true });
  await assert.rejects(runStaffMembershipProof(f.args), /MEMBERSHIP_MUTATION_UNCONFIRMED_PROTECTED_RECOVERY_REQUIRED/);
  const state = await f.state();
  assert.equal(state.clinic_role, 'viewer');
  assert.equal(state.active, false);
  assert.deepEqual(await f.counts(), { requests: 1, audits: 1 });
  assert.equal(f.calls.filter(c => c.name === 'admin_read_staff_membership_state').length, 1);
});

test('case variants of the same request UUID are rejected before any I/O', async () => {
  let calls = 0;
  const id = 'abcdefab-abcd-4bcd-8bcd-abcdefabcdef';
  await assert.rejects(runStaffMembershipProof({
    target: { clinicId: clinic, userId: staff }, actorId: actor,
    requestIds: { off: id, on: id.toUpperCase() }, rpc: async () => { calls++; }
  }), /MEMBERSHIP_REQUEST_IDS_MUST_DIFFER/);
  assert.equal(calls, 0);
});

test('invalid or missing OFF/ON request UUIDs are rejected before any I/O', async () => {
  for (const requestIds of [
    { off: 'not-a-uuid', on: randomUUID() },
    { off: randomUUID(), on: 'not-a-uuid' },
    { off: undefined, on: randomUUID() },
    { off: randomUUID(), on: undefined }
  ]) {
    let calls = 0;
    await assert.rejects(runStaffMembershipProof({
      target: { clinicId: clinic, userId: staff }, actorId: actor, requestIds,
      rpc: async () => { calls++; }
    }), /MEMBERSHIP_UUID_INVALID/);
    assert.equal(calls, 0);
  }
});
