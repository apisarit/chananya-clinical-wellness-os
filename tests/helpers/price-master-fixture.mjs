import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const migrationsDir = path.join(root, 'supabase', 'migrations');

export const PRICE_FIXTURE_IDS = Object.freeze({
  userA: '11111111-1111-4111-a111-111111111111',
  userB: '22222222-2222-4222-a222-222222222222',
  superAdmin: '44444444-4444-4444-a444-444444444444',
  owner: 'dddddddd-4444-4444-a444-444444444444',
  clinicA: '00000000-0000-0000-0000-000000000001',
  clinicB: '33333333-3333-4333-a333-333333333333',
  productA: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  productB: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  serviceA: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
});

const bootstrap = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (
    id uuid primary key, email text,
    raw_user_meta_data jsonb default '{}'::jsonb,
    raw_app_meta_data jsonb default '{}'::jsonb,
    created_at timestamptz default now(), updated_at timestamptz default now()
  );
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create function auth.role() returns text language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'authenticated')::text
  $$;
  grant usage on schema auth to authenticated, service_role;
  grant execute on function auth.uid(), auth.role() to authenticated, service_role;
  create function public.gen_random_uuid() returns uuid language sql volatile as $$
    select (substr(x,1,8)||'-'||substr(x,9,4)||'-4'||substr(x,14,3)||'-a'||substr(x,18,3)||'-'||substr(x,21,12))::uuid
    from (select md5(random()::text || clock_timestamp()::text) x) s
  $$;
  create function public.gen_random_bytes(n integer) returns bytea language sql volatile as $$
    select decode(substr(repeat(md5(random()::text || clock_timestamp()::text), greatest(1,n)),1,n*2),'hex')
  $$;
  create function public.digest(value text, algorithm text) returns bytea language sql immutable as $$
    select decode(md5(value) || md5(value || algorithm), 'hex')
  $$;
`;

export async function createPriceMasterFixture({ permissiveDefaults = false, database = null, nativePostgres = false, beforeMigration = null, stopBeforeMigration = null } = {}) {
  if (nativePostgres && !database) throw new Error('Native fixture requires an explicit disposable database adapter');
  const db = database || new PGlite();
  await db.exec(nativePostgres
    ? bootstrap.slice(0, bootstrap.indexOf('  create function public.gen_random_uuid')) + 'create extension if not exists pgcrypto;'
    : bootstrap);
  const ids = PRICE_FIXTURE_IDS;
  const migrationFiles = (await fs.readdir(migrationsDir)).filter(file => file.endsWith('.sql')).sort();
  if (stopBeforeMigration && !migrationFiles.includes(stopBeforeMigration)) throw new Error('Unknown migration rehearsal boundary');
  for (const file of migrationFiles) {
    if (file === stopBeforeMigration) break;
    if (beforeMigration) await beforeMigration({ db, file, ids });
    if (permissiveDefaults && file === '20260926090000_tenant_price_master.sql') {
      await db.exec(`
        alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
        alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      `);
    }
    if (file === '202608270300_hybrid_patient_identity.sql') {
      await db.exec(`
        insert into auth.users(id,email,raw_user_meta_data) values
          ('${ids.userA}','a@example.test','{"full_name":"Practitioner A"}'),
          ('${ids.userB}','b@example.test','{"full_name":"Practitioner B"}'),
          ('${ids.superAdmin}','c@example.test','{"full_name":"Platform Support"}');
        update public.profiles set role='practitioner', system_role='staff'
          where id in ('${ids.userA}','${ids.userB}');
        update public.profiles set role='viewer', system_role='super_admin' where id='${ids.superAdmin}';
        insert into public.patients(hn,prefix,first_name,last_name,created_by)
          values ('CHANANYA-00009999','นาย','ข้อมูล','เดิม','${ids.userA}');
      `);
    }
    const source = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    await db.exec(nativePostgres ? source : source.replace(/create extension if not exists pgcrypto\s*;/gi, ''));
  }

  await db.exec(`
    reset role;
    select set_config('request.jwt.claim.sub','',false), set_config('request.jwt.claim.role','service_role',false);
    insert into auth.users(id,email,raw_user_meta_data) values
      ('${ids.owner}','owner@example.test','{"full_name":"Clinic Owner"}');
    update public.profiles set role='viewer', system_role='staff' where id='${ids.owner}';
    insert into public.clinic_memberships(clinic_id,profile_id,clinic_role,is_primary,active)
      values ('${ids.clinicA}','${ids.owner}','owner',true,true)
      on conflict (clinic_id,profile_id) do update set clinic_role='owner', is_primary=true, active=true;
    insert into public.clinics(id,code,name_th,name_en)
      values ('${ids.clinicB}','CLINICB','คลินิกบี','Clinic B');
    update public.clinic_memberships set is_primary=false where profile_id='${ids.userB}';
    insert into public.clinic_memberships(clinic_id,profile_id,clinic_role,is_primary,active)
      values ('${ids.clinicB}','${ids.userB}','practitioner',true,true)
      on conflict (clinic_id,profile_id) do update set clinic_role='practitioner', is_primary=true, active=true;
    reset role;
  `);

  async function asUser(userId, sql, params) {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub','${userId}',false), set_config('request.jwt.claim.role','authenticated',false); set role authenticated;`);
    try { return await db.query(sql, params); } finally { await db.exec('reset role;'); }
  }
  async function asAnon(sql, params) {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub','',false), set_config('request.jwt.claim.role','anon',false); set role anon;`);
    try { return await db.query(sql, params); } finally { await db.exec('reset role;'); }
  }
  async function asService(sql, params) {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub','',false), set_config('request.jwt.claim.role','service_role',false); set role service_role;`);
    try { return await db.query(sql, params); } finally { await db.exec('reset role;'); }
  }
  async function asOwner(sql, params) {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub','',false), set_config('request.jwt.claim.role','service_role',false);`);
    return db.query(sql, params);
  }

  await asOwner(`insert into public.products(id,sku,name_th,category,stock_unit,dispense_unit,clinic_id)
    values ('${ids.productA}','PRICE-A','สินค้าคลินิก A','medicine','ชิ้น','ชิ้น','${ids.clinicA}'),
           ('${ids.productB}','PRICE-B','สินค้าคลินิก B','medicine','ชิ้น','ชิ้น','${ids.clinicB}')`);
  await asOwner(`insert into public.services(id,service_code,name_th,name_en,category,duration_minutes,active,clinic_id)
    values ('${ids.serviceA}','SERVICE-A','บริการคลินิก A','Clinic A service','treatment',60,true,'${ids.clinicA}')`);
  // Native adapters may open a fresh connection per operation; never expose
  // helpers that rely on session role state surviving between exec and query.
  if (nativePostgres) return Object.freeze({ db, ids });
  return Object.freeze({ db, ids, asUser, asAnon, asService, asOwner });
}
