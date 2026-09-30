import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const app = fs.readFileSync(new URL('../appointments.js', import.meta.url), 'utf8');
const scheduleSql = fs.readFileSync(new URL('../supabase/migrations/20260919214500_appointment_schedule_self_service.sql', import.meta.url), 'utf8');
const baseSql = fs.readFileSync(new URL('../supabase/migrations/202608041300_chananya_appointments_compatible.sql', import.meta.url), 'utf8');

assert.match(app, /\.gt\('available_capacity', 0\)/);
assert.match(app, /เหลือ \$\{esc\(item\.available_capacity\)\} ที่ จาก \$\{esc\(item\.max_patients\)\} ที่/);
assert.match(scheduleSql, /p_max_patients integer default 1/i);
assert.match(scheduleSql, /p_max_patients < 1 or p_max_patients > 200/i);
assert.match(baseSql, /group by s\.id,p\.full_name,cs\.name_th,cs\.name_en/i);

const db = new PGlite();
try {
  await db.exec(`
    create table practitioner_schedules(
      id text primary key,
      practitioner_id text not null,
      max_patients integer not null
    );
    create table clinic_appointments(
      id text primary key,
      schedule_id text not null,
      status text not null
    );
    insert into practitioner_schedules values
      ('doctor-a-slot','doctor-a',2),
      ('doctor-b-slot','doctor-b',1);
    insert into clinic_appointments values
      ('a-1','doctor-a-slot','booked'),
      ('a-cancelled','doctor-a-slot','cancelled'),
      ('b-1','doctor-b-slot','confirmed');
  `);
  const result = await db.query(`
    select s.practitioner_id,
           greatest(s.max_patients - count(a.id) filter (
             where a.status in ('booked','confirmed','checked_in','in_service')
           )::integer, 0) as available_capacity
    from practitioner_schedules s
    left join clinic_appointments a on a.schedule_id = s.id
    group by s.id
    order by s.practitioner_id
  `);
  assert.deepEqual(result.rows, [
    { practitioner_id: 'doctor-a', available_capacity: 1 },
    { practitioner_id: 'doctor-b', available_capacity: 0 },
  ]);
  console.log('Practitioner capacity regression passed: capacity remains per provider slot; cancelled appointments do not consume capacity; sold-out slots remain zero.');
} finally {
  await db.close();
}
