import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createPriceMasterFixture } from './helpers/price-master-fixture.mjs';

const f = await createPriceMasterFixture();
const { db, ids, asUser, asService, asOwner } = f;
const encounterId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const requestId = 'aaaaaaaa-1111-4111-a111-aaaaaaaaaaaa';
const requestId2 = 'aaaaaaaa-2222-4222-a222-aaaaaaaaaaaa';
const requestId3 = 'aaaaaaaa-3333-4333-a333-aaaaaaaaaaaa';
const requestId4 = 'aaaaaaaa-4444-4444-a444-aaaaaaaaaaaa';

await asOwner(`
  insert into public.encounters(id,encounter_no,patient_id,clinic_id,status,practitioner_id)
  select '${encounterId}','REPLAY-0001',p.id,'${ids.clinicA}','draft','${ids.userA}'
    from public.patients p limit 1;
`);

const call = (key = requestId, detail = 'Manual treatment', duration = 60) => `
  select (public.create_clinical_treatment_session_idempotent(
    '${key}'::uuid,'${encounterId}'::uuid,array['acupuncture']::text[],'${detail}',false,null::text,null::text,4::smallint,2::smallint,'Improved','Hydrate',${duration}::integer
  )).id as id;
`;
const expectError = async (promise, code) => {
  await assert.rejects(promise, error => String(error?.message ?? error).includes(code));
};

const first = (await asUser(ids.userA, call())).rows[0].id;
const replay = (await asUser(ids.userA, call())).rows[0].id;
assert.equal(replay, first, 'same request and payload must replay the same row');
assert.equal((await asUser(ids.userA, `select count(*)::int as n from public.clinical_treatment_sessions where encounter_id='${encounterId}'`)).rows[0].n, 1);

const distinctRequest = (await asUser(ids.userA, call(requestId4))).rows[0].id;
assert.notEqual(distinctRequest, first, 'different request UUIDs create distinct sessions even with identical payload');
assert.equal((await asUser(ids.userA, `select count(*)::int as n from public.clinical_treatment_sessions where encounter_id='${encounterId}'`)).rows[0].n, 2);

// The ordinary clinical API must not expose the underlying cascade. Privileged
// maintenance/retention is a separate, still-unverified receipt lifecycle.
for (const actor of [ids.userA, ids.owner, ids.superAdmin]) {
  await assert.rejects(asUser(actor, `delete from public.clinical_treatment_sessions where id='${distinctRequest}'`), error => error.code === '42501');
  await assert.rejects(asUser(actor, `delete from cnyos_treatment_internal.session_request_receipts where request_id='${requestId4}'`), error => error.code === '42501');
}
assert.equal((await asUser(ids.userA, call(requestId4))).rows[0].id, distinctRequest);
assert.equal((await asOwner(`select count(*)::int as n from cnyos_treatment_internal.session_request_receipts where request_id='${requestId4}'`)).rows[0].n, 1);

await expectError(asUser(ids.userA, call(requestId, 'Changed payload')), 'TREATMENT_REQUEST_CONFLICT');
await expectError(asUser(ids.superAdmin, call()), 'TREATMENT_REQUEST_CONFLICT');

await expectError(asUser(ids.userA, call(requestId2, 'Will fail', 0)), 'TREATMENT_DURATION_REQUIRED');
assert.equal((await asUser(ids.userA, `select (public.get_clinical_treatment_session_request('${requestId2}','${encounterId}')).id as id`)).rows[0].id, null, 'failed writes leave no receipt');

// Lock the encounter through the same sign-off trigger used in production.
await asOwner(`
  insert into public.clinical_record_signoffs(encounter_id,record_section,signer_id,lock_record)
  values ('${encounterId}','complete_record','${ids.owner}',true);
`);
assert.equal((await asUser(ids.userA, call())).rows[0].id, first, 'authorized replay remains valid after sign-off');
await expectError(asUser(ids.userA, call(requestId3, 'New post-signoff write')), 'CLINICAL_RECORD_LOCKED');

const reconciled = (await asUser(ids.userA, `select (public.get_clinical_treatment_session_request('${requestId}','${encounterId}')).id as id`)).rows[0].id;
assert.equal(reconciled, first, 'reload reconciliation returns the committed session');
const missing = (await asUser(ids.userA, `select (public.get_clinical_treatment_session_request('${requestId3}','${encounterId}')).id as id`)).rows[0].id;
assert.equal(missing, null);

const migration = await fs.readFile(path.resolve('supabase/migrations/20260926101714_treatment_request_replay.sql'), 'utf8');
assert.match(migration, /revoke all on schema cnyos_treatment_internal from public, anon, authenticated, service_role/);
assert.match(migration, /revoke all on table cnyos_treatment_internal\.session_request_receipts from public, anon, authenticated, service_role/);
assert.match(migration, /revoke all on function public\.create_clinical_treatment_session_idempotent[\s\S]+from public, anon, authenticated, service_role/);
assert.match(migration, /grant execute on function public\.create_clinical_treatment_session_idempotent[\s\S]+to authenticated/);

await db.close();
console.log('treatment-request-replay: ok');
