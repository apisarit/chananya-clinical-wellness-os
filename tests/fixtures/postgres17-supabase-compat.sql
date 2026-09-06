\set ON_ERROR_STOP 1

-- The ledger repair guards need the small part of the Supabase catalog that
-- the migrations reference.  This is deliberately not presented as a full
-- local Supabase installation.
alter schema public owner to postgres;
revoke all on schema public from public;
grant usage on schema public to public;

create extension if not exists pgcrypto with schema public;

create role anon nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
create role authenticated nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
create role service_role nologin noinherit nosuperuser nocreatedb nocreaterole noreplication bypassrls;
create role authenticator login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;

grant anon to authenticator with inherit false, set true;
grant authenticated to authenticator with inherit false, set true;
grant service_role to authenticator with inherit false, set true;

create schema auth authorization postgres;
create table auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  raw_app_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create function auth.role()
returns text
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.role', true), '')::text
$$;

grant usage on schema auth to authenticated, service_role;
grant execute on function auth.uid(), auth.role() to authenticated, service_role;
