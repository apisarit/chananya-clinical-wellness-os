import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const db = new PGlite();
try {
  await db.exec(`
    create role authenticated; create schema auth;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
    create function public.current_clinic_id() returns uuid language sql stable as $$select nullif(current_setting('test.clinic',true),'')::uuid$$;
    create table profiles(id uuid primary key,system_role text);
    create table clinic_memberships(profile_id uuid,clinic_id uuid,active boolean,clinic_role text);
    create table patient_user_links(patient_id uuid,user_id uuid,active boolean);
    create table clinic_appointments(id int,clinic_id uuid,patient_id uuid,practitioner_id uuid);
    insert into profiles values('00000000-0000-0000-0000-000000000001','super_admin');
    insert into clinic_memberships values('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000011',true,'owner');
    insert into clinic_appointments values
      (1,'00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000021',null),
      (2,'00000000-0000-0000-0000-000000000012','00000000-0000-0000-0000-000000000022',null);
    alter table clinic_appointments enable row level security;
    create policy clinic_appointments_staff_read on clinic_appointments for select to authenticated using(false);
    create policy tenant_boundary on clinic_appointments as restrictive for select to authenticated using(clinic_id=current_clinic_id());
    grant usage on schema auth to authenticated;
    grant select on clinic_appointments,patient_user_links to authenticated;
    select set_config('test.uid','00000000-0000-0000-0000-000000000001',false);
    select set_config('test.clinic','00000000-0000-0000-0000-000000000011',false);
  `);
  const helper = read('../supabase/migrations/20260919214500_appointment_schedule_self_service.sql')
    .match(/create or replace function public\.is_appointment_operator\(\)[\s\S]*?\$\$;/)[0];
  await db.exec(helper);
  await db.exec(read('../supabase/migrations/20260922133838_appointment_operator_read_consistency.sql'));
  await db.exec('set role authenticated');
  assert.deepEqual((await db.query('select id from clinic_appointments')).rows,[{id:1}]);
  await db.exec('reset role; update clinic_memberships set active=false; set role authenticated');
  assert.equal((await db.query('select * from clinic_appointments')).rows.length,0);
  await db.exec("reset role; update clinic_memberships set active=true; select set_config('test.clinic','00000000-0000-0000-0000-000000000012',false); set role authenticated");
  assert.equal((await db.query('select * from clinic_appointments')).rows.length,0);
  console.log('PASS: appointment operator can read own clinic; inactive membership and nonmember clinic denied');
} finally { await db.close(); }
