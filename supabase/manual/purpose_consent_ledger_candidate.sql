-- Storage proposal only. No purposes, approvals, API grants or live activation.
begin;
do $$ begin raise exception 'PURPOSE_CONSENT_REVIEW_REQUIRED'; end $$;
create schema cnyos_consent_internal;
revoke all on schema cnyos_consent_internal from public,anon,authenticated,service_role;
create function cnyos_consent_internal.valid_categories(p_values text[])
returns boolean language sql immutable security invoker set search_path=pg_catalog
as $$ select coalesce(
  cardinality(p_values) between 1 and 32 and array_ndims(p_values)=1
  and array_lower(p_values,1)=1
  and not exists(select 1 from unnest(p_values) v where v is null or v !~ '^[a-z][a-z0-9_]{1,63}$')
  and cardinality(p_values)=(select count(distinct v) from unnest(p_values) v),false) $$;
revoke all on function cnyos_consent_internal.valid_categories(text[]) from public,anon,authenticated,service_role;

create table cnyos_consent_internal.purpose_versions (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  purpose_code text not null check (purpose_code ~ '^[a-z][a-z0-9_]{1,63}$'),
  version integer not null check (version>0),
  data_categories text[] not null check (cnyos_consent_internal.valid_categories(data_categories)),
  notice_sha256 text not null check (notice_sha256 ~ '^[0-9a-f]{64}$'),
  source_reference text not null check (length(btrim(source_reference)) between 1 and 500),
  created_at timestamptz not null default now(),
  unique(clinic_id,purpose_code,version),
  unique(id,clinic_id)
);
create table cnyos_consent_internal.decision_events (
  id uuid primary key default gen_random_uuid(),
  event_position bigint generated always as identity unique,
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  patient_id uuid not null,
  purpose_version_id uuid not null,
  request_id uuid not null,
  recorded_by uuid not null references public.profiles(id) on delete restrict,
  -- Recorder is not necessarily the subject. References are evidence pointers,
  -- not a claim that the database has verified identity or legal authority.
  subject_kind text not null check (subject_kind in ('self','representative')),
  subject_evidence_reference text not null check (length(btrim(subject_evidence_reference)) between 1 and 500),
  subject_evidence_sha256 text not null check (subject_evidence_sha256 ~ '^[0-9a-f]{64}$'),
  representative_authority_reference text,
  check ((subject_kind='self' and representative_authority_reference is null)
    or (subject_kind='representative' and representative_authority_reference is not null
      and length(btrim(representative_authority_reference)) between 1 and 500)),
  decision text not null check (decision in ('grant','decline','withdraw')),
  recorded_at timestamptz not null default now() check (isfinite(recorded_at)),
  effective_at timestamptz not null check (isfinite(effective_at)),
  source_reference text not null check (length(btrim(source_reference)) between 1 and 500),
  foreign key(patient_id,clinic_id) references public.patients(id,clinic_id) on delete restrict,
  foreign key(purpose_version_id,clinic_id) references cnyos_consent_internal.purpose_versions(id,clinic_id) on delete restrict,
  unique(clinic_id,recorded_by,request_id)
);
create index consent_patient_history on cnyos_consent_internal.decision_events(clinic_id,patient_id,event_position);
alter table cnyos_consent_internal.purpose_versions enable row level security;
alter table cnyos_consent_internal.decision_events enable row level security;
-- No policies or browser/service grants. Only disposable owner fixtures write.
revoke all on all tables in schema cnyos_consent_internal from public,anon,authenticated,service_role;
revoke all on all sequences in schema cnyos_consent_internal from public,anon,authenticated,service_role;

create function cnyos_consent_internal.reject_history_mutation()
returns trigger language plpgsql security invoker set search_path=pg_catalog
as $$ begin raise exception 'CONSENT_HISTORY_IMMUTABLE'; end $$;
revoke all on function cnyos_consent_internal.reject_history_mutation() from public,anon,authenticated,service_role;
create trigger immutable_purpose before update or delete on cnyos_consent_internal.purpose_versions
for each row execute function cnyos_consent_internal.reject_history_mutation();
create trigger immutable_event before update or delete on cnyos_consent_internal.decision_events
for each row execute function cnyos_consent_internal.reject_history_mutation();
create trigger no_purpose_truncate before truncate on cnyos_consent_internal.purpose_versions
for each statement execute function cnyos_consent_internal.reject_history_mutation();
create trigger no_event_truncate before truncate on cnyos_consent_internal.decision_events
for each statement execute function cnyos_consent_internal.reject_history_mutation();
commit;
