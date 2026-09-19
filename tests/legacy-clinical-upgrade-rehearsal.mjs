import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

// Synthetic, disposable SQL rehearsal only. No remote database connections.
// The baseline is reconstructed from source, not a clone of production drift.
// Auth/crypto helpers below are test doubles; this does not verify OAuth,
// cryptography, appointment-booking RPCs, or authorize a live migration.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.join(root, 'supabase', 'migrations');
const practitioner = '11111111-1111-4111-a111-111111111111';
const admin = '22222222-2222-4222-a222-222222222222';
const clinic = '00000000-0000-0000-0000-000000000001';
const baseline = '202608252250_clinical_signoff_lock_audit.sql';
const db = new PGlite();

try {
await db.exec(`
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth;
create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}'::jsonb,created_at timestamptz default now(),updated_at timestamptz default now());
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create function auth.role() returns text language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claim.role',true),''),'authenticated') $$;
grant usage on schema auth to authenticated,service_role; grant execute on function auth.uid(),auth.role() to authenticated,service_role;
create function public.gen_random_uuid() returns uuid language sql volatile as $$ select gen_random_uuid() $$;
create function public.gen_random_bytes(n integer) returns bytea language sql volatile as $$ select decode(repeat('00',n),'hex') $$;
create function public.digest(value text, algorithm text) returns bytea language sql immutable as $$ select decode(md5(value||algorithm)||md5(value),'hex') $$;
insert into auth.users values
 ('${practitioner}','practitioner@example.test'),('${admin}','admin@example.test');
`);

const files = (await fs.readdir(migrationsDir)).filter(name => name.endsWith('.sql')).sort();
assert.ok(files.includes(baseline), 'populated rehearsal baseline must exist');
const before = files.filter(name => name <= baseline);
for (const file of before) {
  const source = (await fs.readFile(path.join(migrationsDir, file), 'utf8')).replace(/create extension if not exists pgcrypto\s*;/gi, '');
  await db.exec(source);
}
await db.exec(`
insert into public.profiles(id,email,full_name,role,system_role) values
 ('${practitioner}','practitioner@example.test','Synthetic Practitioner','practitioner','staff'),
 ('${admin}','admin@example.test','Synthetic Admin','admin','staff') on conflict(id) do update set role=excluded.role,system_role=excluded.system_role;
`);

await db.exec(`
insert into public.patients(id,hn,first_name,last_name,created_by) values
 ('30000000-0000-4000-8000-000000000001','SYN-0001','Patient','One','${practitioner}'),
 ('30000000-0000-4000-8000-000000000002','SYN-0002','Patient','Two','${practitioner}'),
 ('30000000-0000-4000-8000-000000000003','SYN-0003','Patient','Three','${practitioner}'),
 ('30000000-0000-4000-8000-000000000004','SYN-0004','Patient','Four','${practitioner}'),
 ('30000000-0000-4000-8000-000000000005','SYN-0005','Patient','Five','${practitioner}');
insert into public.appointments(id,patient_id,appointment_date) values
 ('40000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',current_date);
insert into public.encounters(id,encounter_no,patient_id,encounter_type,status,practitioner_id,created_by)
select ('50000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'SYN-E-'||i,
 ('30000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'opd','draft','${practitioner}','${practitioner}' from generate_series(1,5) i;
update public.encounters set chief_complaint='Synthetic complaint',present_illness='Synthetic present illness';
insert into public.ttm_structured_diagnoses(encounter_id,analysis_summary,thai_diagnosis,diagnosed_by)
select id,'Synthetic diagnosis','Synthetic diagnosis','${practitioner}' from public.encounters;
insert into public.clinical_treatment_plans(encounter_id,goal_1,planned_by)
select id,'Synthetic treatment','${practitioner}' from public.encounters;
insert into public.ttm_opd_histories(encounter_id,physical_exam_narrative,created_by,updated_by)
select id,'Synthetic OPD history','${practitioner}','${practitioner}' from public.encounters;
insert into public.vital_signs(encounter_id,temperature,recorded_by)
values('50000000-0000-4000-8000-000000000001',36.4,'${practitioner}');
`);

await db.exec(`reset role; select set_config('request.jwt.claim.sub','${practitioner}',false),set_config('request.jwt.claim.role','authenticated',false); set role authenticated;`);
await db.query(`select public.sign_clinical_record_complete('50000000-0000-4000-8000-000000000001','Synthetic Practitioner','SYN-1','Baseline signoff')`);
await db.exec('reset role;');
const snapshot = (await db.query(`
select jsonb_build_object(
 'patients',(select jsonb_agg(to_jsonb(p) order by p.id) from public.patients p where p.hn like 'SYN-%'),
 'encounters',(select jsonb_agg(to_jsonb(e) order by e.id) from public.encounters e where e.encounter_no like 'SYN-%'),
 'opd',(select jsonb_agg(to_jsonb(h) order by h.id) from public.ttm_opd_histories h join public.encounters e on e.id=h.encounter_id where e.encounter_no like 'SYN-%'),
 'diagnoses',(select jsonb_agg(to_jsonb(d) order by d.id) from public.ttm_structured_diagnoses d join public.encounters e on e.id=d.encounter_id where e.encounter_no like 'SYN-%'),
 'plans',(select jsonb_agg(to_jsonb(t) order by t.id) from public.clinical_treatment_plans t join public.encounters e on e.id=t.encounter_id where e.encounter_no like 'SYN-%'),
 'vitals',(select jsonb_agg(to_jsonb(v) order by v.id) from public.vital_signs v join public.encounters e on e.id=v.encounter_id where e.encounter_no like 'SYN-%'),
 'signoffs',(select jsonb_agg(to_jsonb(s) order by s.id) from public.clinical_record_signoffs s join public.encounters e on e.id=s.encounter_id where e.encounter_no like 'SYN-%'),
 'audit',(select jsonb_agg(to_jsonb(a) order by a.id) from public.clinical_record_audit_events a join public.encounters e on e.id=a.encounter_id where e.encounter_no like 'SYN-%')
) value`)).rows[0].value;
const snapshotFields = {
  patients: ['id','hn','first_name','last_name'],
  encounters: ['id','encounter_no','patient_id','status','chief_complaint','present_illness','thai_diagnosis'],
  opd: ['id','encounter_id','physical_exam_narrative'],
  diagnoses: ['id','encounter_id','analysis_summary','thai_diagnosis'],
  plans: ['id','encounter_id','goal_1','status'],
  vitals: ['id','encounter_id','temperature'],
  signoffs: ['id','encounter_id','lock_record','signer_id','signed_at'],
  audit: ['id','encounter_id','event_type','record_section','actor_id','reason','details','created_at']
};
function projectSnapshot(input) {
  return Object.fromEntries(Object.entries(snapshotFields).map(([section, fields]) => [section, (input[section] || []).map(row => Object.fromEntries(fields.map(field => {
    assert.ok(Object.hasOwn(row, field), `${section}.${field} must exist`);
    return [field, row[field]];
  })))]));
}
const projectedSnapshot = projectSnapshot(snapshot);
for (const section of ['patients', 'encounters', 'opd', 'diagnoses', 'plans']) {
  assert.equal(projectedSnapshot[section].length, 5, `${section} fixture must contain five synthetic cases`);
}
assert.equal(projectedSnapshot.vitals.length, 1);
assert.equal(Number(projectedSnapshot.vitals[0].temperature), 36.4);
assert.equal(projectedSnapshot.signoffs.length, 1);
assert.equal(projectedSnapshot.signoffs[0].signer_id, practitioner);
assert.equal(projectedSnapshot.signoffs[0].lock_record, true);
assert.ok(projectedSnapshot.signoffs[0].signed_at);
assert.ok(projectedSnapshot.audit.length > 0, 'baseline signoff must produce an audit event');
assert.ok(projectedSnapshot.audit.some(row => row.event_type === 'SIGN_AND_LOCK' && row.actor_id === practitioner));

const after = files.filter(name => name > baseline);
for (const file of after) {
  try {
    const source = (await fs.readFile(path.join(migrationsDir, file), 'utf8')).replace(/create extension if not exists pgcrypto\s*;/gi, '');
    await db.exec(source);
  } catch (error) {
    const code = String(error?.message || '').match(/[A-Z][A-Z0-9_]{3,}/)?.[0] || 'POSTGRES_ERROR';
    console.error(`LEGACY_UPGRADE_REPRODUCTION_FAILED ${file} ${code}`);
    process.exitCode = 1;
    break;
  }
}

if (!process.exitCode) {
  const current = (await db.query(`select jsonb_build_object(
   'patients',(select jsonb_agg(to_jsonb(p) order by p.id) from public.patients p where p.hn like 'SYN-%'),
   'encounters',(select jsonb_agg(to_jsonb(e) order by e.id) from public.encounters e where e.encounter_no like 'SYN-%'),
   'opd',(select jsonb_agg(to_jsonb(h) order by h.id) from public.ttm_opd_histories h join public.encounters e on e.id=h.encounter_id where e.encounter_no like 'SYN-%'),
   'diagnoses',(select jsonb_agg(to_jsonb(d) order by d.id) from public.ttm_structured_diagnoses d join public.encounters e on e.id=d.encounter_id where e.encounter_no like 'SYN-%'),
   'plans',(select jsonb_agg(to_jsonb(t) order by t.id) from public.clinical_treatment_plans t join public.encounters e on e.id=t.encounter_id where e.encounter_no like 'SYN-%'),
   'vitals',(select jsonb_agg(to_jsonb(v) order by v.id) from public.vital_signs v join public.encounters e on e.id=v.encounter_id where e.encounter_no like 'SYN-%'),
   'signoffs',(select jsonb_agg(to_jsonb(s) order by s.id) from public.clinical_record_signoffs s join public.encounters e on e.id=s.encounter_id where e.encounter_no like 'SYN-%'),
   'audit',(select jsonb_agg(to_jsonb(a) order by a.id) from public.clinical_record_audit_events a join public.encounters e on e.id=a.encounter_id where e.encounter_no like 'SYN-%')
  ) value`)).rows[0].value;
  assert.deepEqual(projectSnapshot(current), projectedSnapshot, 'legacy clinical values changed during migration replay');
  await db.exec(`reset role; select set_config('request.jwt.claim.sub','${practitioner}',false),set_config('request.jwt.claim.role','authenticated',false); set role authenticated;`);
  const context = (await db.query(`select * from public.current_access_context()`)).rows[0];
  assert.equal(context?.clinic_role, 'practitioner');
  assert.equal(context?.system_role, 'staff');
  const visiblePatients = (await db.query(`select clinic_id from public.patients where hn like 'SYN-%'`)).rows;
  assert.equal(visiblePatients.length, 5, 'practitioner must still see the five upgraded cases');
  assert.ok(visiblePatients.every(row => row.clinic_id === clinic), 'cases must belong to the legacy clinic');
  const updated = await db.query(`update public.ttm_opd_histories set physical_exam_narrative='Unsigned amendment' where encounter_id='50000000-0000-4000-8000-000000000002' returning id`);
  assert.equal(updated.rows.length, 1);
  // Independent SQL requests are autocommitted. Re-bind authentication before
  // reading persisted values; this is not a browser refresh or real OAuth test.
  await db.exec(`reset role; select set_config('request.jwt.claim.sub','${practitioner}',false),set_config('request.jwt.claim.role','authenticated',false); set role authenticated;`);
  assert.equal((await db.query('select auth.uid() as id')).rows[0].id, practitioner);
  assert.equal((await db.query(`select physical_exam_narrative from public.ttm_opd_histories where id='${updated.rows[0].id}'`)).rows[0].physical_exam_narrative, 'Unsigned amendment');
  await assert.rejects(db.query(`update public.ttm_opd_histories set physical_exam_narrative='Signed bypass' where encounter_id='50000000-0000-4000-8000-000000000001'`), /CLINICAL_RECORD_LOCKED/);
  assert.equal((await db.query(`select physical_exam_narrative from public.ttm_opd_histories where encounter_id='50000000-0000-4000-8000-000000000001'`)).rows[0].physical_exam_narrative, 'Synthetic OPD history');
  await db.exec('reset role;');
  console.log('Legacy clinical upgrade rehearsal passed: populated synthetic baseline survived and lock boundary held');
}
} finally {
  await db.close();
}
