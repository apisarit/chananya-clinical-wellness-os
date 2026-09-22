import assert from 'node:assert/strict';
import fs from 'node:fs';

const appointments = fs.readFileSync(new URL('../appointments.js', import.meta.url), 'utf8');
const checkin = fs.readFileSync(new URL('../check-in.js', import.meta.url), 'utf8');
const checkinHtml = fs.readFileSync(new URL('../check-in.html', import.meta.url), 'utf8');
const migration = fs.readFileSync(
  new URL('../supabase/migrations/20260922163445_link_appointment_encounter_idempotently.sql', import.meta.url),
  'utf8'
);

assert.match(appointments, /href="\/check-in\.html\?appointment=\$\{encodeURIComponent\(item\.id\)\}"/u);
assert.match(appointments, /href="\/clinical-v3\.html\?encounter=\$\{encodeURIComponent\(item\.encounter_id\)\}&step=history"/u);
assert.match(appointments, /canClinicalStatus && practitionerStatus\(status\)/u);
assert.match(
  appointments,
  /\(canOperate \|\| mayProvideCare\) && \['booked', 'confirmed'\]\.includes\(item\.status\)/u,
  'the assigned practitioner must be able to enter the verified check-in flow'
);
assert.doesNotMatch(
  appointments,
  /async function setStatus\(id, status\) \{\s*if \(!canOperate\) throw/u,
  'assigned practitioners must not be rejected by the old operator-only browser guard'
);

assert.match(checkinHtml, /id="appointment-context"/u);
assert.match(checkin, /searchParams\.get\('appointment'\)/u);
assert.match(checkin, /clinic_appointments_patient_clinic_fkey/u);
assert.match(checkin, /rpc\('check_in_clinic_appointment'/u);
assert.match(checkin, /p_appointment_id: appointmentContext\.id/u);
assert.match(checkin, /p_qr_session_id: selected\.source === 'qr'/u);
assert.match(checkin, /location\.assign\(`\/clinical-v3\.html\?encounter=/u);

assert.match(migration, /create unique index if not exists clinic_appointments_encounter_uidx/u);
assert.match(migration, /foreign key \(encounter_id, clinic_id, patient_id\)/u);
assert.match(migration, /references public\.encounters\(id, clinic_id, patient_id\)/u);
assert.match(migration, /create or replace function public\.check_in_clinic_appointment\(/u);
assert.match(migration, /security definer\nset search_path = pg_catalog, public, pg_temp/u);
assert.match(migration, /from public\.clinic_appointments a[\s\S]+for update;/u);
assert.match(
  migration,
  /if v_appt\.encounter_id is not null then[\s\S]+v_qr\.encounter_id is distinct from v_appt\.encounter_id/u,
  'a lost-response QR retry may reuse only the QR session already consumed by that Encounter'
);
assert.match(migration, /raise exception 'QR_REPLAY_OR_APPOINTMENT_MISMATCH'/u);
assert.match(
  migration,
  /if v_appt\.encounter_id is not null then[\s\S]+return query select[\s\S]+v_appt\.status, true;[\s\S]+return;/u,
  'a repeated check-in must return the already-linked Encounter with reused=true'
);
assert.match(migration, /v_appt\.practitioner_id = v_actor/u);
assert.match(migration, /raise exception 'APPOINTMENT_PATIENT_MISMATCH'/u);
assert.match(migration, /set encounter_id = v_encounter\.id/u);
assert.match(migration, /'check_in_appointment_encounter'/u);
assert.match(
  migration,
  /revoke all on function public\.check_in_clinic_appointment\([\s\S]+from public, anon, authenticated, service_role;/u
);
assert.match(
  migration,
  /grant execute on function public\.check_in_clinic_appointment\([\s\S]+to authenticated;/u
);
assert.match(migration, /create or replace function public\.list_billable_treatment_encounters\(\)/u);
assert.match(migration, /create or replace function public\.create_clinical_treatment_session\(/u);
assert.match(migration, /if not public\.department_can\('clinical'\)/u);
assert.match(migration, /select p\.role into v_profile_role[\s\S]+where p\.id = v_actor/u);
assert.match(migration, /v_profile_role in \('practitioner','doctor'\)/u);
assert.match(migration, /v_encounter\.practitioner_id <> v_actor/u);
assert.match(migration, /raise exception 'ENCOUNTER_PRACTITIONER_MISMATCH'/u);
assert.match(migration, /'create_clinical_treatment_session'/u);
assert.match(
  migration,
  /revoke insert, update, delete on public\.clinical_treatment_sessions\s+from authenticated;/u,
  'treatment sessions must be RPC-only so assignment checks cannot be bypassed'
);
assert.match(migration, /array\['owner','admin','billing'\]/u);
assert.match(migration, /record_section = 'complete_record'/u);
assert.match(migration, /rx\.status not in \('cancelled','void'\)/u);
assert.match(migration, /i\.status not in \('cancelled','void'\)/u);
assert.doesNotMatch(migration, /grant execute on function[^;]+to anon;/u);

console.log('Post-booking appointment contract passed: appointment check-in is linked, idempotent, practitioner-owned and billable without bypassing roles');
