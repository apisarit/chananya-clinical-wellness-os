import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { PGlite } from '@electric-sql/pglite';

const source = fs.readFileSync(new URL('../appointments.js', import.meta.url), 'utf8');
const expression = source.match(/const term = (rawTerm[^;]+);/)[1];
for (const rawTerm of ['ทดสอบ ผู้ป่วย', 'น้ำหนึ่ง', 'HN-TEST-001']) {
  assert.equal(vm.runInNewContext(expression, { rawTerm }), rawTerm);
}
const db = new PGlite();
try {
  await db.exec(`
    create role authenticated;
    create table profiles(id int primary key, full_name text);
    create table practitioner_schedules(id int primary key, practitioner_id int, clinic_id int);
    insert into profiles values(1,'Synthetic provider'),(2,'Other clinic');
    insert into practitioner_schedules values(1,1,1),(2,2,2);
    alter table profiles enable row level security;
    alter table practitioner_schedules enable row level security;
    create policy no_profiles on profiles for select to authenticated using(false);
    create policy own_clinic on practitioner_schedules for select to authenticated using(clinic_id=1);
    grant select on profiles,practitioner_schedules to authenticated;
    create view available_practitioner_schedules with(security_invoker=true) as
      select s.id,p.full_name from practitioner_schedules s join profiles p on p.id=s.practitioner_id;
    grant select on available_practitioner_schedules to authenticated;
    set role authenticated;
  `);
  assert.equal((await db.query('select * from available_practitioner_schedules')).rows.length, 0);
  await db.exec('reset role');
  await db.exec(fs.readFileSync(new URL('../supabase/migrations/20260922102422_appointment_availability_optional_profile.sql', import.meta.url), 'utf8'));
  await db.exec('set role authenticated');
  assert.deepEqual((await db.query('select * from available_practitioner_schedules')).rows, [{id:1,full_name:null}]);
  assert.equal((await db.query('select * from profiles')).rows.length, 0);
  console.log('PASS: availability survives hidden profile; other clinic and profiles remain hidden; Thai search preserves marks');
} finally { await db.close(); }
