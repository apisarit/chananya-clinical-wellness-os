begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- A request receipt is deliberately private.  It is the durable boundary for
-- browser retries; application code must use the RPCs below rather than write
-- this table directly.
create schema if not exists cnyos_treatment_internal;

create table if not exists cnyos_treatment_internal.session_request_receipts (
  request_id uuid primary key,
  actor_id uuid not null references auth.users(id),
  clinic_id uuid not null references public.clinics(id),
  encounter_id uuid not null references public.encounters(id) on delete cascade,
  payload_fingerprint text not null,
  session_id uuid not null references public.clinical_treatment_sessions(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table cnyos_treatment_internal.session_request_receipts enable row level security;
revoke all on schema cnyos_treatment_internal from public, anon, authenticated, service_role;
revoke all on table cnyos_treatment_internal.session_request_receipts from public, anon, authenticated, service_role;

-- Sign-off and treatment writes acquire the same encounter-row lock.  This
-- also closes the absent-signoff-row race: inserting the first sign-off waits
-- behind an in-flight treatment write (and vice versa).
create or replace function public.lock_encounter_for_clinical_signoff()
returns trigger
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_encounter_id uuid := case when tg_op = 'DELETE' then old.encounter_id else new.encounter_id end;
begin
  perform 1 from public.encounters where id = v_encounter_id for update;
  if not found then raise exception 'ENCOUNTER_NOT_FOUND'; end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke all on function public.lock_encounter_for_clinical_signoff() from public, anon, authenticated, service_role;
drop trigger if exists trg_lock_encounter_for_signoff on public.clinical_record_signoffs;
create trigger trg_lock_encounter_for_signoff
before insert or update or delete on public.clinical_record_signoffs
for each row execute function public.lock_encounter_for_clinical_signoff();

-- Legacy eleven-argument callers remain available only as a coordinated-rollout
-- compatibility surface.  They do not acquire replay receipts.
comment on function public.create_clinical_treatment_session(
  uuid,text[],text,boolean,text,text,smallint,smallint,text,text,integer
) is 'LEGACY: non-idempotent compatibility RPC; migrate callers to request-id RPC before removal.';

create or replace function public.create_clinical_treatment_session_idempotent(
  p_request_id uuid,
  p_encounter_id uuid,
  p_treatment_modalities text[],
  p_treatment_detail text,
  p_procedure_referral boolean,
  p_procedure_referral_detail text,
  p_precautions text,
  p_pain_before smallint,
  p_pain_after smallint,
  p_outcome_summary text,
  p_advice text,
  p_duration_minutes integer
)
returns public.clinical_treatment_sessions
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_clinic uuid := public.current_clinic_id();
  v_department text;
  v_profile_role text;
  v_encounter public.encounters%rowtype;
  v_existing cnyos_treatment_internal.session_request_receipts%rowtype;
  v_row public.clinical_treatment_sessions%rowtype;
  v_session_no integer;
  v_fingerprint text;
begin
  if v_actor is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_request_id is null or p_encounter_id is null then raise exception 'REQUEST_AND_ENCOUNTER_REQUIRED'; end if;
  if v_clinic is null then raise exception 'CLINIC_CONTEXT_REQUIRED'; end if;
  perform public.assert_clinic_subscription_active(v_clinic);

  -- Authorization is intentionally before receipt replay.  A stale or copied
  -- request key cannot be used as an oracle after membership is removed.
  select p.role into v_profile_role from public.profiles p where p.id = v_actor;
  v_department := public.current_department_role();
  if not public.department_can('clinical')
     and not (v_department in ('owner','admin') and v_profile_role in ('practitioner','doctor')) then
    raise exception 'PERMISSION_DENIED';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('cnyos-treatment-request:' || p_request_id::text, 0));
  select e.* into v_encounter
    from public.encounters e
   where e.id = p_encounter_id and e.clinic_id = v_clinic
   for update;
  if not found then raise exception 'ENCOUNTER_NOT_FOUND'; end if;
  if v_encounter.practitioner_id is not null
     and v_encounter.practitioner_id <> v_actor and not public.is_super_admin() then
    raise exception 'ENCOUNTER_PRACTITIONER_MISMATCH';
  end if;

  v_fingerprint := encode(sha256(convert_to(jsonb_build_array(
    v_clinic, v_actor, p_encounter_id, coalesce(p_treatment_modalities, '{}'::text[]),
    btrim(p_treatment_detail), coalesce(p_procedure_referral, false),
    nullif(btrim(p_procedure_referral_detail), ''), nullif(btrim(p_precautions), ''),
    p_pain_before, p_pain_after, nullif(btrim(p_outcome_summary), ''),
    nullif(btrim(p_advice), ''), p_duration_minutes
  )::text, 'UTF8')), 'hex');

  select * into v_existing
    from cnyos_treatment_internal.session_request_receipts r
   where r.request_id = p_request_id;
  if found then
    if v_existing.actor_id <> v_actor
       or v_existing.clinic_id <> v_clinic
       or v_existing.encounter_id <> p_encounter_id
       or v_existing.payload_fingerprint <> v_fingerprint then
      raise exception 'TREATMENT_REQUEST_CONFLICT';
    end if;
    select * into v_row from public.clinical_treatment_sessions where id = v_existing.session_id;
    if not found then raise exception 'TREATMENT_REQUEST_RECEIPT_INVALID'; end if;
    return v_row;
  end if;

  if p_treatment_detail is null or btrim(p_treatment_detail) = '' then raise exception 'TREATMENT_DETAIL_REQUIRED'; end if;
  if p_duration_minutes is null or p_duration_minutes <= 0 or p_duration_minutes > 1440 then raise exception 'TREATMENT_DURATION_REQUIRED'; end if;
  if p_pain_before is not null and (p_pain_before < 0 or p_pain_before > 10) then raise exception 'INVALID_PAIN_BEFORE'; end if;
  if p_pain_after is not null and (p_pain_after < 0 or p_pain_after > 10) then raise exception 'INVALID_PAIN_AFTER'; end if;
  if v_encounter.status in ('closed','cancelled','void') then raise exception 'ENCOUNTER_NOT_EDITABLE'; end if;
  if exists (select 1 from public.clinical_record_signoffs s
             where s.encounter_id = p_encounter_id and s.record_section = 'complete_record' and s.lock_record) then
    raise exception 'CLINICAL_RECORD_LOCKED';
  end if;

  select coalesce(max(s.session_no), 0) + 1 into v_session_no
    from public.clinical_treatment_sessions s where s.encounter_id = p_encounter_id;
  insert into public.clinical_treatment_sessions(
    encounter_id, session_no, treatment_modalities, treatment_detail, procedure_referral,
    procedure_referral_detail, precautions, pain_before, pain_after, outcome_summary, advice,
    duration_minutes, practitioner_id
  ) values (
    p_encounter_id, v_session_no, coalesce(p_treatment_modalities, '{}'), p_treatment_detail,
    coalesce(p_procedure_referral, false), nullif(btrim(p_procedure_referral_detail), ''),
    nullif(btrim(p_precautions), ''), p_pain_before, p_pain_after,
    nullif(btrim(p_outcome_summary), ''), nullif(btrim(p_advice), ''), p_duration_minutes, v_actor
  ) returning * into v_row;

  insert into cnyos_treatment_internal.session_request_receipts(
    request_id, actor_id, clinic_id, encounter_id, payload_fingerprint, session_id
  ) values (p_request_id, v_actor, v_clinic, p_encounter_id, v_fingerprint, v_row.id);
  insert into public.audit_logs(clinic_id, user_id, action, entity, entity_id, metadata)
  values (v_clinic, v_actor, 'create_clinical_treatment_session_idempotent', 'clinical_treatment_sessions', v_row.id::text,
          jsonb_build_object('request_id', p_request_id, 'encounter_id', p_encounter_id, 'session_no', v_session_no));
  return v_row;
end;
$$;

revoke all on function public.create_clinical_treatment_session_idempotent(uuid,uuid,text[],text,boolean,text,text,smallint,smallint,text,text,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.create_clinical_treatment_session_idempotent(uuid,uuid,text[],text,boolean,text,text,smallint,smallint,text,text,integer)
  to authenticated;

create or replace function public.get_clinical_treatment_session_request(p_request_id uuid, p_encounter_id uuid)
returns public.clinical_treatment_sessions
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_clinic uuid := public.current_clinic_id();
  v_department text;
  v_profile_role text;
  v_encounter public.encounters%rowtype;
  v_receipt cnyos_treatment_internal.session_request_receipts%rowtype;
  v_row public.clinical_treatment_sessions%rowtype;
begin
  if v_actor is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_request_id is null or p_encounter_id is null then raise exception 'REQUEST_AND_ENCOUNTER_REQUIRED'; end if;
  if v_clinic is null then raise exception 'CLINIC_CONTEXT_REQUIRED'; end if;
  perform public.assert_clinic_subscription_active(v_clinic);
  select p.role into v_profile_role from public.profiles p where p.id = v_actor;
  v_department := public.current_department_role();
  if not public.department_can('clinical')
     and not (v_department in ('owner','admin') and v_profile_role in ('practitioner','doctor')) then
    raise exception 'PERMISSION_DENIED';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('cnyos-treatment-request:' || p_request_id::text, 0));
  select e.* into v_encounter from public.encounters e where e.id = p_encounter_id and e.clinic_id = v_clinic for share;
  if not found then raise exception 'ENCOUNTER_NOT_FOUND'; end if;
  if v_encounter.practitioner_id is not null and v_encounter.practitioner_id <> v_actor and not public.is_super_admin() then
    raise exception 'ENCOUNTER_PRACTITIONER_MISMATCH';
  end if;
  select * into v_receipt from cnyos_treatment_internal.session_request_receipts r
   where r.request_id = p_request_id and r.actor_id = v_actor and r.clinic_id = v_clinic and r.encounter_id = p_encounter_id;
  if not found then return null; end if;
  select * into v_row from public.clinical_treatment_sessions where id = v_receipt.session_id;
  if not found then return null; end if;
  return v_row;
end;
$$;
revoke all on function public.get_clinical_treatment_session_request(uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_clinical_treatment_session_request(uuid,uuid) to authenticated;

commit;
