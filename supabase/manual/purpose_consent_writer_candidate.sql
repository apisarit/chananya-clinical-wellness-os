-- Depends on the guarded storage proposal. No client grants or permissions seeded.
begin;
do $$ begin raise exception 'PURPOSE_CONSENT_WRITER_REVIEW_REQUIRED'; end $$;
alter table cnyos_consent_internal.decision_events add column request_expected_position bigint
  check(request_expected_position is null or request_expected_position>=0);
create table cnyos_consent_internal.recording_permissions (
  clinic_id uuid not null,
  recorder_id uuid not null,
  purpose_version_id uuid not null,
  active boolean not null default false,
  policy_reference text not null check(length(btrim(policy_reference)) between 1 and 500),
  primary key(clinic_id,recorder_id,purpose_version_id),
  foreign key(clinic_id,recorder_id) references public.clinic_memberships(clinic_id,profile_id) on delete restrict,
  foreign key(purpose_version_id,clinic_id) references cnyos_consent_internal.purpose_versions(id,clinic_id) on delete restrict
);
alter table cnyos_consent_internal.recording_permissions enable row level security;
revoke all on cnyos_consent_internal.recording_permissions from public,anon,authenticated,service_role;

-- Technical provenance only, not approval or proof of the asserted JWT identity.
create table cnyos_consent_internal.recording_permission_events (
  id uuid primary key default gen_random_uuid(),
  audit_position bigint generated always as identity unique,
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  recorder_id uuid not null references public.profiles(id) on delete restrict,
  purpose_version_id uuid not null,
  actor_id uuid references public.profiles(id) on delete restrict,
  database_session_user text not null,
  database_role text not null,
  operation text not null check(operation in ('INSERT','UPDATE','DELETE')),
  before_state jsonb,
  after_state jsonb,
  recorded_at timestamptz not null default clock_timestamp() check(isfinite(recorded_at)),
  foreign key(purpose_version_id,clinic_id) references cnyos_consent_internal.purpose_versions(id,clinic_id) on delete restrict,
  check((operation='INSERT' and before_state is null and after_state is not null)
    or (operation='UPDATE' and before_state is not null and after_state is not null)
    or (operation='DELETE' and before_state is not null and after_state is null))
);
alter table cnyos_consent_internal.recording_permission_events enable row level security;
revoke all on cnyos_consent_internal.recording_permission_events from public,anon,authenticated,service_role;
revoke all on sequence cnyos_consent_internal.recording_permission_events_audit_position_seq from public,anon,authenticated,service_role;
create trigger immutable_permission_event before update or delete on cnyos_consent_internal.recording_permission_events
for each row execute function cnyos_consent_internal.reject_history_mutation();
create trigger no_permission_event_truncate before truncate on cnyos_consent_internal.recording_permission_events
for each statement execute function cnyos_consent_internal.reject_history_mutation();
create trigger no_permission_truncate before truncate on cnyos_consent_internal.recording_permissions
for each statement execute function cnyos_consent_internal.reject_history_mutation();

create function cnyos_consent_internal.audit_recording_permission_change()
returns trigger language plpgsql security invoker set search_path=pg_catalog
as $$
declare v_row cnyos_consent_internal.recording_permissions;
begin
  if tg_op='UPDATE' and row(old.clinic_id,old.recorder_id,old.purpose_version_id)
    is distinct from row(new.clinic_id,new.recorder_id,new.purpose_version_id) then
    raise exception 'CONSENT_PERMISSION_IDENTITY_IMMUTABLE';
  end if;
  if tg_op='DELETE' then v_row:=old; else v_row:=new; end if;
  insert into cnyos_consent_internal.recording_permission_events(
    clinic_id,recorder_id,purpose_version_id,actor_id,database_session_user,database_role,
    operation,before_state,after_state)
  values(v_row.clinic_id,v_row.recorder_id,v_row.purpose_version_id,auth.uid(),
    session_user,current_setting('role'),tg_op,
    case when tg_op='INSERT' then null else to_jsonb(old) end,
    case when tg_op='DELETE' then null else to_jsonb(new) end);
  return null;
end $$;
revoke all on function cnyos_consent_internal.audit_recording_permission_change() from public,anon,authenticated,service_role;
create trigger audit_permission_change after insert or update or delete on cnyos_consent_internal.recording_permissions
for each row execute function cnyos_consent_internal.audit_recording_permission_change();

create function cnyos_consent_internal.record_decision(
  p_request_id uuid,p_patient_id uuid,p_version_id uuid,p_expected_position bigint,
  p_decision text,p_subject_kind text,p_evidence_reference text,p_evidence_sha256 text,
  p_authority_reference text,p_source_reference text,p_effective_at timestamptz
) returns cnyos_consent_internal.decision_events
language plpgsql security definer set search_path=pg_catalog
as $$
declare
  v_actor uuid:=auth.uid(); v_clinic uuid; v_code text; v_position bigint;
  v_row cnyos_consent_internal.decision_events;
begin
  if v_actor is null then raise exception 'AUTH_REQUIRED'; end if;
  v_clinic:=public.current_clinic_id();
  if v_clinic is null then raise exception 'CLINIC_ACCESS_REQUIRED'; end if;
  perform public.assert_clinic_subscription_active(v_clinic);
  if p_request_id is null or p_expected_position is null or p_expected_position<0 then
    raise exception 'INVALID_CONSENT_REQUEST'; end if;
  -- No role, including Owner, implicitly receives consent-recording authority.
  perform 1 from cnyos_consent_internal.recording_permissions r
    where r.clinic_id=v_clinic and r.recorder_id=v_actor
      and r.purpose_version_id=p_version_id and r.active for share;
  if not found then raise exception 'CONSENT_RECORDING_NOT_AUTHORIZED'; end if;
  perform 1 from public.clinic_memberships m where m.clinic_id=v_clinic
    and m.profile_id=v_actor and m.active for share;
  if not found then raise exception 'CLINIC_ACCESS_REQUIRED'; end if;
  select purpose_code into v_code from cnyos_consent_internal.purpose_versions
    where id=p_version_id and clinic_id=v_clinic;
  if not found then raise exception 'CONSENT_PURPOSE_NOT_FOUND'; end if;
  perform 1 from public.patients where id=p_patient_id and clinic_id=v_clinic for key share;
  if not found then raise exception 'CONSENT_PATIENT_NOT_FOUND'; end if;
  -- Request lock precedes stream lock; request keys span the actor's clinic.
  perform pg_advisory_xact_lock(hashtextextended('consent-request:'||v_clinic||':'||v_actor||':'||p_request_id,0));
  select * into v_row from cnyos_consent_internal.decision_events
    where clinic_id=v_clinic and recorded_by=v_actor and request_id=p_request_id;
  if found then
    if row(v_row.patient_id,v_row.purpose_version_id,v_row.decision,v_row.subject_kind,
      v_row.subject_evidence_reference,v_row.subject_evidence_sha256,
      v_row.representative_authority_reference,v_row.source_reference,v_row.effective_at,v_row.request_expected_position)
      is distinct from row(p_patient_id,p_version_id,p_decision,p_subject_kind,
      p_evidence_reference,p_evidence_sha256,p_authority_reference,p_source_reference,p_effective_at,p_expected_position)
    then raise exception 'CONSENT_REQUEST_CONFLICT'; end if;
    return v_row;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('consent-stream:'||v_clinic||':'||p_patient_id||':'||v_code,0));
  select coalesce(max(e.event_position),0) into v_position
    from cnyos_consent_internal.decision_events e
    join cnyos_consent_internal.purpose_versions p on p.id=e.purpose_version_id and p.clinic_id=e.clinic_id
    where e.clinic_id=v_clinic and e.patient_id=p_patient_id and p.purpose_code=v_code;
  if v_position<>p_expected_position then raise exception 'CONSENT_STATE_CHANGED'; end if;
  insert into cnyos_consent_internal.decision_events(clinic_id,patient_id,purpose_version_id,
    request_id,recorded_by,decision,subject_kind,subject_evidence_reference,
    subject_evidence_sha256,representative_authority_reference,source_reference,effective_at,request_expected_position)
  values(v_clinic,p_patient_id,p_version_id,p_request_id,v_actor,p_decision,p_subject_kind,
    p_evidence_reference,p_evidence_sha256,p_authority_reference,p_source_reference,p_effective_at,p_expected_position)
  returning * into v_row;
  return v_row;
end $$;
revoke all on function cnyos_consent_internal.record_decision(uuid,uuid,uuid,bigint,text,text,text,text,text,text,timestamptz)
  from public,anon,authenticated,service_role;
commit;
