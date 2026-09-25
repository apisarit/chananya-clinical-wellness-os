import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = await fs.readFile(
  path.join(root, 'supabase', 'migrations', '20260923084317_fix_checkin_search_digest.sql'),
  'utf8'
);
const db = new PGlite();
const clinicId = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-000000000002';

try {
await db.exec(`
  create role authenticated nologin;
  create schema auth;
  create schema extensions;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create function extensions.digest(value text, algorithm text) returns bytea
  language sql immutable as $$
    select pg_catalog.sha256(pg_catalog.convert_to(value, pg_catalog.current_setting('server_encoding')))
  $$;
  create table public.clinics (id uuid primary key);
  create table public.patients (
    id uuid primary key, clinic_id uuid not null, hn text not null,
    first_name text not null, last_name text not null, active boolean not null,
    updated_at timestamptz not null default now()
  );
  create table public.patient_identity_events (
    clinic_id uuid not null, event_type text not null, actor_profile_id uuid,
    metadata jsonb not null
  );
  insert into public.clinics values ('${clinicId}');
  insert into public.patients(id, clinic_id, hn, first_name, last_name, active)
    values ('00000000-0000-4000-8000-000000000003', '${clinicId}', 'HN-001', 'Synthetic', 'Checkin', true);
  create function public.current_clinic_id() returns uuid language sql stable as $$
    select '${clinicId}'::uuid
  $$;
  create function public.is_clinic_member(target uuid, roles text[]) returns boolean
    language sql stable as $$ select target = '${clinicId}'::uuid
      and current_setting('request.jwt.claim.sub', true) = '${userId}' $$;
  create function public.search_patients_for_checkin(p_query text)
  returns table (patient_id uuid, hn text, display_name text)
  language plpgsql volatile security definer set search_path = public as $$
  declare
    v_clinic_id uuid := public.current_clinic_id();
    v_query text := btrim(coalesce(p_query, ''));
    v_result_count integer;
  begin
    if not public.is_clinic_member(v_clinic_id, array['owner']) then raise exception 'PERMISSION_DENIED'; end if;
    select count(*) into v_result_count from public.patients p
      where p.clinic_id = v_clinic_id and p.active and p.hn ilike '%' || v_query || '%';
    insert into public.patient_identity_events values (
      v_clinic_id, 'MANUAL_PATIENT_SEARCH', auth.uid(),
      jsonb_build_object('query_hash', encode(digest(lower(v_query), 'sha256'), 'hex'), 'result_count', least(v_result_count, 20))
    );
    return query select p.id, p.hn, concat_ws(' ', p.first_name, p.last_name)
      from public.patients p where p.clinic_id = v_clinic_id and p.active
        and p.hn ilike '%' || v_query || '%' limit 20;
  end;
  $$;
  revoke all on function public.search_patients_for_checkin(text) from public;
  grant execute on function public.search_patients_for_checkin(text) to authenticated;
`);

await db.exec(`select set_config('request.jwt.claim.sub', '${userId}', false)`);
await assert.rejects(
  db.query(`select * from public.search_patients_for_checkin('HN')`),
  /function digest\(text, unknown\) does not exist/,
  'the historical unqualified digest must fail when digest exists only in extensions'
);

const before = (await db.query(`select p.oid, p.proowner, p.proacl::text, p.proconfig, p.prosecdef,
  pg_catalog.pg_get_functiondef(p.oid) definition
  from pg_catalog.pg_proc p where p.oid = 'public.search_patients_for_checkin(text)'::regprocedure`)).rows[0];
await db.exec(migration);
await db.exec('set role authenticated');
const after = (await db.query(`select p.oid, p.proowner, p.proacl::text, p.proconfig, p.prosecdef,
  pg_catalog.pg_get_functiondef(p.oid) definition
  from pg_catalog.pg_proc p where p.oid = 'public.search_patients_for_checkin(text)'::regprocedure`)).rows[0];
assert.equal(after.oid, before.oid);
assert.equal(after.proowner, before.proowner);
assert.equal(after.proacl, before.proacl);
assert.deepEqual(after.proconfig, before.proconfig);
assert.equal(after.prosecdef, before.prosecdef);
assert.match(after.definition, /pg_catalog\.sha256\(pg_catalog\.convert_to\(lower\(v_query\), pg_catalog\.current_setting\('server_encoding'\)\)\)/);

const result = await db.query(`select * from public.search_patients_for_checkin('HN')`);
assert.deepEqual(result.rows, [{
  patient_id: '00000000-0000-4000-8000-000000000003', hn: 'HN-001', display_name: 'Synthetic Checkin'
}]);
await db.exec('reset role');
const audit = (await db.query(`select metadata->>'query_hash' query_hash, metadata->>'result_count' result_count
  from public.patient_identity_events`)).rows[0];
assert.equal(audit.query_hash, '7446783c207819c88f4358a528c02b9dbb7154a31cd89f4795a763ed8f829b5c');
assert.equal(audit.result_count, '1');

await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000099', false)`);
await assert.rejects(
  db.query(`select * from public.search_patients_for_checkin('HN')`),
  /PERMISSION_DENIED/
);
await db.exec('reset role');
assert.equal(
  (await db.query(`select count(*)::int count from public.patient_identity_events`)).rows[0].count,
  1,
  'unauthorized/nonmember search must not append an audit row'
);
await db.exec(`select set_config('request.jwt.claim.sub', '${userId}', false)`);

await db.exec('reset role');
await db.exec(migration); // exact repaired shape is idempotent
const repairedDefinition = (await db.query(`select pg_catalog.pg_get_functiondef('public.search_patients_for_checkin(text)'::regprocedure) definition`)).rows[0].definition;
assert.match(repairedDefinition, /pg_catalog\.sha256/);

await db.exec(`create or replace function public.search_patients_for_checkin(p_query text)
  returns table (patient_id uuid, hn text, display_name text)
  language plpgsql volatile security definer set search_path = public as $$
  begin
    perform digest(lower(p_query), 'sha256');
    perform digest(lower(p_query), 'sha256');
  end; $$`);
await assert.rejects(db.exec(migration), /CHECKIN_SEARCH_DIGEST_UNEXPECTED_FUNCTION_SHAPE/);

console.log('Check-in search digest contract passed: extensions-only failure, bounded repair, SHA-256 audit, ACL/identity preservation, idempotency, and shape guard');
} finally {
  await db.close();
}
