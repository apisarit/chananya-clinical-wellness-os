import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.join(root, 'supabase', 'migrations');
const USER_A = '11111111-1111-4111-a111-111111111111';
const USER_B = '22222222-2222-4222-a222-222222222222';
const USER_C = '44444444-4444-4444-a444-444444444444';
const CLINIC_B = '33333333-3333-4333-a333-333333333333';
const db = new PGlite();

// PGlite validates PostgreSQL DDL, PL/pgSQL, RLS, triggers, FKs and
// transactions. These test-only functions mimic pgcrypto signatures; crypto
// strength is covered by the Node helper tests and real Supabase must provide
// pgcrypto before this migration is activated.
await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (
    id uuid primary key,
    email text,
    raw_user_meta_data jsonb default '{}'::jsonb,
    raw_app_meta_data jsonb default '{}'::jsonb,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
  );
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create function auth.role() returns text language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.role', true), ''),
      'authenticated'
    )::text
  $$;
  create function public.gen_random_uuid() returns uuid language sql volatile as $$
    select (
      substr(x,1,8)||'-'||substr(x,9,4)||'-4'||substr(x,14,3)||
      '-a'||substr(x,18,3)||'-'||substr(x,21,12)
    )::uuid
    from (select md5(random()::text || clock_timestamp()::text) x) s
  $$;
  create function public.gen_random_bytes(n integer) returns bytea language sql volatile as $$
    select decode(
      substr(repeat(md5(random()::text || clock_timestamp()::text), greatest(1,n)),1,n*2),
      'hex'
    )
  $$;
  create function public.digest(value text, algorithm text) returns bytea language sql immutable as $$
    select decode(md5(value) || md5(value || algorithm), 'hex')
  $$;
`);

const migrationFiles = (await fs.readdir(migrationsDir))
  .filter(file => file.endsWith('.sql'))
  .sort();

for (const file of migrationFiles) {
  if (file === '202608270300_hybrid_patient_identity.sql') {
    await db.exec(`
      insert into auth.users(id,email,raw_user_meta_data) values
        ('${USER_A}','a@example.test','{"full_name":"Practitioner A"}'),
        ('${USER_B}','b@example.test','{"full_name":"Practitioner B"}'),
        ('${USER_C}','c@example.test','{"full_name":"Platform Support"}');
      update public.profiles
      set role='practitioner', system_role='staff'
      where id in ('${USER_A}','${USER_B}');
      update public.profiles
      set role='viewer', system_role='super_admin'
      where id='${USER_C}';
      insert into public.patients(
        hn,prefix,first_name,last_name,created_by
      ) values (
        'CHANANYA-00009999','นาย','ข้อมูล','เดิม','${USER_A}'
      );
    `);
  }
  const source = await fs.readFile(path.join(migrationsDir, file), 'utf8');
  const compatibleSource = source.replace(
    /create extension if not exists pgcrypto\s*;/gi,
    ''
  );
  await db.exec(compatibleSource);
}

async function asUser(userId, sql) {
  await db.exec(`
    reset role;
    select
      set_config('request.jwt.claim.sub','${userId}',false),
      set_config('request.jwt.claim.role','authenticated',false);
    set role authenticated;
  `);
  try {
    return await db.query(sql);
  } finally {
    await db.exec('reset role;');
  }
}

async function expectDatabaseError(promise, code) {
  await assert.rejects(promise, error => String(error.message).includes(code));
}

await expectDatabaseError(
  asUser(USER_A, `select * from public.issue_patient_line_link_code(null,'self',null,false)`),
  'CONSENT_REQUIRED'
);

const createdA = await asUser(USER_A, `
  select (public.upsert_patient_registration(
    null,'นาง','ทดสอบ','หนึ่ง',null,'female','1990-01-02',
    '0812345678',null,null,null,'penicillin'
  )).*;
`);
const patientA = createdA.rows[0];
assert.match(patientA.hn, /^CHANANYA-\d{8,}$/);
assert.ok(Number(patientA.hn.split('-').at(-1)) > 9999);

const linkResult = await asUser(USER_A, `
  select * from public.issue_patient_line_link_code(
    '${patientA.id}','self',null,true
  )
`);
const linkCode = linkResult.rows[0].link_code;
assert.match(linkCode, /^[0-9A-F]{12}$/);

await db.exec(`
  select set_config('request.jwt.claim.sub','',false);
  set role service_role;
`);
const subjectHash = 'a'.repeat(64);
await db.query(`
  select * from public.complete_patient_line_link(
    '${linkCode}','${subjectHash}','line-channel',true
  )
`);
const hashes = await db.query(`
  select
    encode(digest('opaque-token','sha256'),'hex') token_hash,
    encode(digest('123456','sha256'),'hex') code_hash
`);
const { token_hash: tokenHash, code_hash: codeHash } = hashes.rows[0];
const qrIssued = await db.query(`
  select * from public.issue_patient_qr_for_subject(
    '${subjectHash}','${patientA.id}','${tokenHash}','${codeHash}',
    now()+interval '90 seconds'
  )
`);
assert.equal(qrIssued.rows[0].patient_id, patientA.id);
await db.exec('reset role;');

const resolved = await asUser(USER_A, `
  select * from public.resolve_patient_qr('CHANANYA:PT1:opaque-token',null)
`);
assert.equal(resolved.rows[0].patient_id, patientA.id);
assert.equal(resolved.rows[0].active_allergies[0].name, 'penicillin');
const qrSession = resolved.rows[0].qr_session_id;
await assert.rejects(
  asUser(USER_A, `
    select * from public.confirm_patient_qr(
      '${qrSession}',true,'ข้อมูลทดสอบที่ต้อง rollback',
      '{"pain_before":99}'::jsonb
    )
  `)
);
const rolledBackEncounter = await asUser(USER_A, `
  select count(*)::int count
  from public.encounters
  where patient_id='${patientA.id}'
`);
assert.equal(rolledBackEncounter.rows[0].count, 0);
const confirmed = await asUser(USER_A, `
  select * from public.confirm_patient_qr(
    '${qrSession}',true,'ปวดหลัง','{"pain_before":6,"pulse":72}'::jsonb
  )
`);
assert.equal(confirmed.rows[0].patient_id, patientA.id);
const encounterA = confirmed.rows[0].encounter_id;
assert.ok(encounterA);
await expectDatabaseError(
  asUser(USER_A, `
    select * from public.confirm_patient_qr(
      '${qrSession}',true,null,'{}'::jsonb
    )
  `),
  'QR_INVALID_EXPIRED_OR_USED'
);

const intakeCounts = await db.query(`
  select
    (select count(*)::int from public.vital_signs where encounter_id='${encounterA}') vitals,
    (select count(*)::int from public.pain_assessments where encounter_id='${encounterA}') pain,
    (select count(*)::int from public.encounter_identity_verifications where encounter_id='${encounterA}') verification,
    (select count(*)::int from public.audit_logs where entity_id='${encounterA}') audit
`);
assert.deepEqual(
  intakeCounts.rows[0],
  { vitals: 1, pain: 1, verification: 1, audit: 1 }
);

const linksBeforeRevoke = await asUser(USER_A, `
  select * from public.list_patient_identity_links('${patientA.id}')
`);
assert.equal(linksBeforeRevoke.rows.length, 1);
assert.equal(linksBeforeRevoke.rows[0].status, 'active');
assert.equal('subject_hash' in linksBeforeRevoke.rows[0], false);
const revoked = await asUser(USER_A, `
  select public.revoke_patient_identity_link(
    '${linksBeforeRevoke.rows[0].link_id}',
    'ผู้รับบริการขอยกเลิกบัญชีทดสอบ'
  ) revoked
`);
assert.equal(revoked.rows[0].revoked, true);
const linksAfterRevoke = await asUser(USER_A, `
  select * from public.list_patient_identity_links('${patientA.id}')
`);
assert.equal(linksAfterRevoke.rows[0].status, 'revoked');

await asUser(USER_A, `
  do $rate_limit_test$
  begin
    for attempt in 1..20 loop
      perform * from public.resolve_patient_qr(null,'999999');
    end loop;
  end
  $rate_limit_test$;
`);
const failedLookups = await db.query(`
  select count(*)::int count
  from public.patient_identity_events
  where event_type='PATIENT_QR_LOOKUP_FAILED'
`);
assert.equal(failedLookups.rows[0].count, 20);
await expectDatabaseError(
  asUser(USER_A, `select * from public.resolve_patient_qr(null,'999999')`),
  'RATE_LIMITED'
);

const createdManual = await asUser(USER_A, `
  select (public.upsert_patient_registration(
    null,'นาย','ไม่มี','มือถือ',null,'male','1960-02-03',
    null,null,null,null,null
  )).*;
`);
const manualEncounter = await asUser(USER_A, `
  select * from public.start_manual_patient_encounter(
    '${createdManual.rows[0].id}','manual_hn',true,null,
    'ติดตามอาการ','{}'::jsonb
  )
`);
assert.equal(manualEncounter.rows[0].patient_id, createdManual.rows[0].id);

await db.exec(`
  insert into public.clinics(id,code,name_th)
  values ('${CLINIC_B}','CLINICB','คลินิกบี');
  update public.clinic_memberships
  set is_primary=false
  where profile_id='${USER_B}';
  insert into public.clinic_memberships(
    clinic_id,profile_id,clinic_role,is_primary
  ) values ('${CLINIC_B}','${USER_B}','practitioner',true);
`);
const createdB = await asUser(USER_B, `
  select (public.upsert_patient_registration(
    null,'นาง','ต่าง','คลินิก',null,'female','1988-03-04',
    '0899999999',null,null,null,null
  )).*;
`);
assert.match(createdB.rows[0].hn, /^CLINICB-\d{8}$/);
const visibleA = await asUser(
  USER_A,
  `select count(*)::int count from public.patients where id='${createdB.rows[0].id}'`
);
assert.equal(visibleA.rows[0].count, 0);
const visibleToUnassignedSuperAdmin = await asUser(
  USER_C,
  `select count(*)::int count from public.patients where id='${createdB.rows[0].id}'`
);
assert.equal(visibleToUnassignedSuperAdmin.rows[0].count, 0);
const crossSearch = await asUser(
  USER_A,
  `select * from public.search_patients_for_checkin('ต่าง')`
);
assert.equal(crossSearch.rows.length, 0);

const auditEvents = await db.query(`
  select event_type,count(*)::int count
  from public.patient_identity_events
  group by event_type
  order by event_type
`);
assert.ok(
  auditEvents.rows.some(row => row.event_type === 'PATIENT_IDENTITY_CONFIRMED')
);

await db.close();
console.log(
  'PostgreSQL behavioral smoke passed: consent, HN, LINE link/revocation, QR issue/resolve/consume, replay rejection, atomic intake/audit, no-phone fallback and tenant isolation'
);
