-- Synthetic native functional fixture, not Supabase Auth/JWT/RLS certification.
-- Loaded only into the test harness's newly initialized Unix-socket-only cluster.
CREATE ROLE cnyos_fixture_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
GRANT USAGE, CREATE ON SCHEMA public TO cnyos_fixture_owner;
GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
CREATE SCHEMA auth AUTHORIZATION cnyos_fixture_owner;
SET ROLE cnyos_fixture_owner;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('test.actor_id',true),'')::uuid $$;
GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
CREATE TABLE public.profiles(id uuid PRIMARY KEY, role text NOT NULL, system_role text NOT NULL);
CREATE TABLE public.clinic_memberships(
  clinic_id uuid NOT NULL, profile_id uuid NOT NULL REFERENCES public.profiles(id),
  clinic_role text NOT NULL, active boolean NOT NULL DEFAULT true,
  is_primary boolean NOT NULL DEFAULT false, joined_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(clinic_id,profile_id)
);
CREATE UNIQUE INDEX clinic_memberships_one_primary_idx
  ON public.clinic_memberships(profile_id) WHERE is_primary AND active;
CREATE TABLE public.audit_logs(
  clinic_id uuid, user_id uuid REFERENCES public.profiles(id), action text,
  entity text, entity_id text, metadata jsonb
);
CREATE FUNCTION public.current_clinic_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path=pg_catalog,pg_temp AS $$
    SELECT m.clinic_id FROM public.clinic_memberships m
    WHERE m.profile_id=auth.uid() AND m.active ORDER BY m.is_primary DESC,m.joined_at LIMIT 1
  $$;
CREATE FUNCTION public.department_can(text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path=pg_catalog,pg_temp AS $$
    SELECT $1='governance' AND EXISTS(
      SELECT 1 FROM public.profiles p JOIN public.clinic_memberships m ON m.profile_id=p.id
      WHERE p.id=auth.uid() AND p.system_role='super_admin' AND m.active
        AND m.clinic_id=public.current_clinic_id())
  $$;
INSERT INTO public.profiles VALUES
  ('11111111-1111-4111-8111-111111111111','super_admin','super_admin'),
  ('22222222-2222-4222-8222-222222222222','practitioner','staff');
INSERT INTO public.clinic_memberships(clinic_id,profile_id,clinic_role,is_primary) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','owner',true),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','22222222-2222-4222-8222-222222222222','practitioner',true);
RESET ROLE;
