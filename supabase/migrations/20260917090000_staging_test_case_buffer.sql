begin;

-- Synthetic staging cases are deliberately kept outside patients, encounters,
-- billing and clinical tables.  This migration is inert until it is reviewed
-- and applied to an isolated staging database; it must never be run against
-- production.
create table if not exists public.staging_test_case_buffer (
  case_key text primary key
    check (case_key ~ '^TEST-00[1-5]$'),
  payload jsonb not null,
  status text not null default 'active'
    check (status in ('active', 'removed')),
  version integer not null default 1 check (version > 0),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  removed_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  removed_at timestamptz,
  check (jsonb_typeof(payload) = 'object'),
  check (coalesce(payload->>'id', '') = case_key),
  check (coalesce(payload->>'symptom', '') ilike '%staging-only not-for-clinical-use%'),
  check (coalesce(payload->>'diagnosis', '') like '%ข้อมูลสาธิต%'),
  check (coalesce(payload->>'product', '') like '%ข้อมูลสาธิต%'),
  check (not (payload ?| array['national_id','phone','email','patient_id','clinic_id','supabase_url']))
);

create index if not exists staging_test_case_buffer_status_idx
  on public.staging_test_case_buffer (status, updated_at desc);

create table if not exists public.staging_test_case_buffer_events (
  id bigint generated always as identity primary key,
  case_key text not null references public.staging_test_case_buffer(case_key),
  action text not null check (action in ('created','updated','removed','restored')),
  before_payload jsonb,
  after_payload jsonb,
  reason text not null,
  actor_id uuid references auth.users(id),
  occurred_at timestamptz not null default now()
);

create index if not exists staging_test_case_buffer_events_case_idx
  on public.staging_test_case_buffer_events (case_key, occurred_at desc);

alter table public.staging_test_case_buffer enable row level security;
alter table public.staging_test_case_buffer force row level security;
alter table public.staging_test_case_buffer_events enable row level security;
alter table public.staging_test_case_buffer_events force row level security;

revoke all on public.staging_test_case_buffer from public, anon, authenticated;
revoke all on public.staging_test_case_buffer_events from public, anon, authenticated;
grant select on public.staging_test_case_buffer to authenticated;
grant select on public.staging_test_case_buffer_events to authenticated;

drop policy if exists staging_test_case_buffer_read on public.staging_test_case_buffer;
create policy staging_test_case_buffer_read
  on public.staging_test_case_buffer for select to authenticated
  using (public.has_role(array['super_admin','admin']));

drop policy if exists staging_test_case_buffer_events_read on public.staging_test_case_buffer_events;
create policy staging_test_case_buffer_events_read
  on public.staging_test_case_buffer_events for select to authenticated
  using (public.has_role(array['super_admin','admin']));

-- The event ledger is append-only.  The trigger runs as its owner, while every
-- browser mutation still passes through the role-checked wrappers below.
create schema if not exists cnyos_staging_internal;
revoke all on schema cnyos_staging_internal from public, anon, authenticated;
grant usage on schema cnyos_staging_internal to authenticated;

create or replace function cnyos_staging_internal.record_buffer_event()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, cnyos_staging_internal, pg_temp
as $$
declare
  v_reason text := coalesce(nullif(current_setting('cnyos.staging_buffer_reason', true), ''), 'unspecified');
begin
  insert into public.staging_test_case_buffer_events(
    case_key, action, before_payload, after_payload, reason, actor_id
  ) values (
    case when tg_op = 'DELETE' then old.case_key else new.case_key end,
    case when tg_op = 'INSERT' then 'created'
         when new.status = 'removed' and old.status <> 'removed' then 'removed'
         when new.status <> 'removed' and old.status = 'removed' then 'restored'
         else 'updated' end,
    case when tg_op = 'INSERT' then null else old.payload end,
    case when tg_op = 'DELETE' then null else new.payload end,
    v_reason,
    auth.uid()
  );
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function cnyos_staging_internal.record_buffer_event() from public, anon, authenticated, service_role;
drop trigger if exists trg_staging_test_case_buffer_events on public.staging_test_case_buffer;
create trigger trg_staging_test_case_buffer_events
after insert or update or delete on public.staging_test_case_buffer
for each row execute function cnyos_staging_internal.record_buffer_event();

create or replace function cnyos_staging_internal.reject_buffer_event_mutation()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
begin
  raise exception 'STAGING_TEST_CASE_EVENT_APPEND_ONLY';
end;
$$;

revoke all on function cnyos_staging_internal.reject_buffer_event_mutation() from public, anon, authenticated, service_role;
drop trigger if exists trg_staging_test_case_buffer_events_append_only on public.staging_test_case_buffer_events;
create trigger trg_staging_test_case_buffer_events_append_only
before update or delete on public.staging_test_case_buffer_events
for each row execute function cnyos_staging_internal.reject_buffer_event_mutation();

create or replace function cnyos_staging_internal.assert_buffer_editor()
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if not public.has_role(array['super_admin','admin']) then
    raise exception 'PERMISSION_DENIED';
  end if;
end;
$$;

revoke all on function cnyos_staging_internal.assert_buffer_editor() from public, anon, authenticated, service_role;

create or replace function cnyos_staging_internal.validate_buffer_payload(
  p_case_key text, p_payload jsonb
)
returns void
language plpgsql
immutable
security invoker
set search_path = pg_catalog, public
as $$
begin
  if p_case_key is null or p_case_key !~ '^TEST-00[1-5]$' then
    raise exception 'STAGING_TEST_CASE_KEY_INVALID';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or coalesce(p_payload->>'id', '') <> p_case_key
     or coalesce(p_payload->>'symptom', '') not ilike '%staging-only not-for-clinical-use%'
     or coalesce(p_payload->>'diagnosis', '') not like '%ข้อมูลสาธิต%'
     or coalesce(p_payload->>'product', '') not like '%ข้อมูลสาธิต%'
     or p_payload ?| array['national_id','phone','email','patient_id','clinic_id','supabase_url'] then
    raise exception 'STAGING_TEST_CASE_PAYLOAD_INVALID';
  end if;
end;
$$;

revoke all on function cnyos_staging_internal.validate_buffer_payload(text, jsonb) from public, anon, authenticated, service_role;

create or replace function cnyos_staging_internal.edit_staging_test_case(
  p_case_key text,
  p_payload jsonb,
  p_reason text,
  p_expected_version integer default null
)
returns public.staging_test_case_buffer
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, cnyos_staging_internal, pg_temp
as $$
declare
  v_row public.staging_test_case_buffer;
begin
  perform cnyos_staging_internal.assert_buffer_editor();
  perform cnyos_staging_internal.validate_buffer_payload(p_case_key, p_payload);
  if p_reason is null or length(btrim(p_reason)) not between 1 and 500 then
    raise exception 'STAGING_TEST_CASE_REASON_REQUIRED';
  end if;
  perform set_config('cnyos.staging_buffer_reason', btrim(p_reason), true);
  select * into v_row from public.staging_test_case_buffer
    where case_key = p_case_key for update;
  if not found then raise exception 'STAGING_TEST_CASE_NOT_FOUND'; end if;
  if v_row.status = 'removed' then raise exception 'STAGING_TEST_CASE_REMOVED'; end if;
  if p_expected_version is not null and v_row.version <> p_expected_version then
    raise exception 'STAGING_TEST_CASE_VERSION_CONFLICT';
  end if;
  update public.staging_test_case_buffer
     set payload = p_payload, version = version + 1,
         updated_by = auth.uid(), updated_at = now()
   where case_key = p_case_key
   returning * into v_row;
  return v_row;
end;
$$;

create or replace function cnyos_staging_internal.remove_staging_test_case(
  p_case_key text, p_reason text
)
returns public.staging_test_case_buffer
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, cnyos_staging_internal, pg_temp
as $$
declare v_row public.staging_test_case_buffer;
begin
  perform cnyos_staging_internal.assert_buffer_editor();
  if p_reason is null or length(btrim(p_reason)) not between 1 and 500 then
    raise exception 'STAGING_TEST_CASE_REASON_REQUIRED';
  end if;
  perform set_config('cnyos.staging_buffer_reason', btrim(p_reason), true);
  update public.staging_test_case_buffer
     set status = 'removed', removed_by = auth.uid(), removed_at = now(),
         updated_by = auth.uid(), updated_at = now(), version = version + 1
   where case_key = p_case_key and status = 'active'
   returning * into v_row;
  if not found then raise exception 'STAGING_TEST_CASE_NOT_FOUND_OR_REMOVED'; end if;
  return v_row;
end;
$$;

create or replace function cnyos_staging_internal.restore_staging_test_case(
  p_case_key text, p_reason text
)
returns public.staging_test_case_buffer
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, cnyos_staging_internal, pg_temp
as $$
declare v_row public.staging_test_case_buffer;
begin
  perform cnyos_staging_internal.assert_buffer_editor();
  if p_reason is null or length(btrim(p_reason)) not between 1 and 500 then
    raise exception 'STAGING_TEST_CASE_REASON_REQUIRED';
  end if;
  perform set_config('cnyos.staging_buffer_reason', btrim(p_reason), true);
  update public.staging_test_case_buffer
     set status = 'active', removed_by = null, removed_at = null,
         updated_by = auth.uid(), updated_at = now(), version = version + 1
   where case_key = p_case_key and status = 'removed'
   returning * into v_row;
  if not found then raise exception 'STAGING_TEST_CASE_NOT_REMOVED'; end if;
  return v_row;
end;
$$;

revoke all on function cnyos_staging_internal.edit_staging_test_case(text, jsonb, text, integer) from public, anon, authenticated, service_role;
revoke all on function cnyos_staging_internal.remove_staging_test_case(text, text) from public, anon, authenticated, service_role;
revoke all on function cnyos_staging_internal.restore_staging_test_case(text, text) from public, anon, authenticated, service_role;
grant execute on function cnyos_staging_internal.edit_staging_test_case(text, jsonb, text, integer) to authenticated;
grant execute on function cnyos_staging_internal.remove_staging_test_case(text, text) to authenticated;
grant execute on function cnyos_staging_internal.restore_staging_test_case(text, text) to authenticated;

-- Public invoker wrappers are the only browser-callable API.  They do not own
-- elevated privileges; the private definer functions enforce the role check.
create or replace function public.edit_staging_test_case(
  p_case_key text, p_payload jsonb, p_reason text, p_expected_version integer default null
)
returns public.staging_test_case_buffer
language sql
volatile
security invoker
set search_path = pg_catalog, public
as $$ select * from cnyos_staging_internal.edit_staging_test_case($1, $2, $3, $4) $$;

create or replace function public.remove_staging_test_case(p_case_key text, p_reason text)
returns public.staging_test_case_buffer
language sql
volatile
security invoker
set search_path = pg_catalog, public
as $$ select * from cnyos_staging_internal.remove_staging_test_case($1, $2) $$;

create or replace function public.restore_staging_test_case(p_case_key text, p_reason text)
returns public.staging_test_case_buffer
language sql
volatile
security invoker
set search_path = pg_catalog, public
as $$ select * from cnyos_staging_internal.restore_staging_test_case($1, $2) $$;

revoke all on function public.edit_staging_test_case(text, jsonb, text, integer) from public, anon, authenticated, service_role;
revoke all on function public.remove_staging_test_case(text, text) from public, anon, authenticated, service_role;
revoke all on function public.restore_staging_test_case(text, text) from public, anon, authenticated, service_role;
grant execute on function public.edit_staging_test_case(text, jsonb, text, integer) to authenticated;
grant execute on function public.remove_staging_test_case(text, text) to authenticated;
grant execute on function public.restore_staging_test_case(text, text) to authenticated;

-- Seed the five Ollama-generated cases into the isolated buffer only.  This is
-- deliberately not an insert into any clinical or patient table.
insert into public.staging_test_case_buffer(case_key, payload)
values
('TEST-001', $json${"id":"TEST-001","prefix":"นาย","first":"สาธิต","last":"กรณีหนึ่ง","gender":"male","dob":"1991-05-12","symptom":"staging-only not-for-clinical-use: synthetic demonstration symptom 1","diagnosis":"ข้อมูลสาธิต 123 — ไม่ใช่คำแนะนำทางคลินิก","dosha":"ข้อมูลสาธิต","product":"ข้อมูลสาธิต 456 — ห้ามใช้รักษาจริง","qty":2,"price":150,"serviceFee":30,"discount":15,"channel":"qr"}$json$::jsonb),
('TEST-002', $json${"id":"TEST-002","prefix":"นางสาว","first":"สาธิต","last":"กรณีสอง","gender":"female","dob":"1993-08-23","symptom":"staging-only not-for-clinical-use: synthetic demonstration symptom 2","diagnosis":"ข้อมูลสาธิต 789 — ไม่ใช่คำแนะนำทางคลินิก","dosha":"ข้อมูลสาธิต","product":"ข้อมูลสาธิต 012 — ห้ามใช้รักษาจริง","qty":1,"price":200,"serviceFee":25,"discount":10,"channel":"cash"}$json$::jsonb),
('TEST-003', $json${"id":"TEST-003","prefix":"นาย","first":"สาธิต","last":"กรณีสาม","gender":"male","dob":"1990-11-30","symptom":"staging-only not-for-clinical-use: synthetic demonstration symptom 3","diagnosis":"ข้อมูลสาธิต 345 — ไม่ใช่คำแนะนำทางคลินิก","dosha":"ข้อมูลสาธิต","product":"ข้อมูลสาธิต 678 — ห้ามใช้รักษาจริง","qty":3,"price":120,"serviceFee":20,"discount":5,"channel":"bank_transfer"}$json$::jsonb),
('TEST-004', $json${"id":"TEST-004","prefix":"นางสาว","first":"สาธิต","last":"กรณีสี่","gender":"female","dob":"1994-02-15","symptom":"staging-only not-for-clinical-use: synthetic demonstration symptom 4","diagnosis":"ข้อมูลสาธิต 901 — ไม่ใช่คำแนะนำทางคลินิก","dosha":"ข้อมูลสาธิต","product":"ข้อมูลสาธิต 234 — ห้ามใช้รักษาจริง","qty":2,"price":180,"serviceFee":35,"discount":20,"channel":"card"}$json$::jsonb),
('TEST-005', $json${"id":"TEST-005","prefix":"นาย","first":"สาธิต","last":"กรณีห้า","gender":"male","dob":"1992-07-18","symptom":"staging-only not-for-clinical-use: synthetic demonstration symptom 5","diagnosis":"ข้อมูลสาธิต 567 — ไม่ใช่คำแนะนำทางคลินิก","dosha":"ข้อมูลสาธิต","product":"ข้อมูลสาธิต 890 — ห้ามใช้รักษาจริง","qty":1,"price":90,"serviceFee":15,"discount":10,"channel":"qr"}$json$::jsonb)
on conflict (case_key) do nothing;

commit;
