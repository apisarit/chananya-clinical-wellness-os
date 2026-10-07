begin;

alter table public.clinical_treatment_sessions
  add column if not exists client_request_id uuid;

do $treatment_session_idempotency_index$
declare
  v_index_oid oid := pg_catalog.to_regclass(
    'public.uq_treatment_session_client_request'
  );
begin
  if v_index_oid is null then
    create unique index uq_treatment_session_client_request
      on public.clinical_treatment_sessions(encounter_id, client_request_id)
      where client_request_id is not null;
    v_index_oid := pg_catalog.to_regclass(
      'public.uq_treatment_session_client_request'
    );
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_class index_relation
    join pg_catalog.pg_index index_definition
      on index_definition.indexrelid = index_relation.oid
    join pg_catalog.pg_am index_method
      on index_method.oid = index_relation.relam
    join pg_catalog.pg_attribute encounter_column
      on encounter_column.attrelid = index_definition.indrelid
     and encounter_column.attname = 'encounter_id'
     and encounter_column.attnum > 0
     and not encounter_column.attisdropped
    join pg_catalog.pg_attribute request_column
      on request_column.attrelid = index_definition.indrelid
     and request_column.attname = 'client_request_id'
     and request_column.attnum > 0
     and not request_column.attisdropped
    where index_relation.oid = v_index_oid
      and index_relation.relkind = 'i'
      and index_method.amname = 'btree'
      and index_definition.indrelid =
        pg_catalog.to_regclass('public.clinical_treatment_sessions')
      and index_definition.indisunique
      and index_definition.indisvalid
      and index_definition.indisready
      and index_definition.indislive
      and index_definition.indimmediate
      and index_definition.indnkeyatts = 2
      and index_definition.indnatts = 2
      and index_definition.indexprs is null
      and index_definition.indkey[0] = encounter_column.attnum
      and index_definition.indkey[1] = request_column.attnum
      and pg_catalog.replace(
        pg_catalog.pg_get_expr(
          index_definition.indpred,
          index_definition.indrelid,
          false
        ),
        '"',
        ''
      ) = '(client_request_id IS NOT NULL)'
  ) then
    raise exception 'TREATMENT_SESSION_IDEMPOTENCY_INDEX_DRIFT'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end;
$treatment_session_idempotency_index$;

create or replace function public.create_clinical_treatment_session(
  p_encounter_id uuid,
  p_client_request_id uuid,
  p_treatment_modalities text[] default '{}',
  p_treatment_detail text default null,
  p_procedure_referral boolean default false,
  p_procedure_referral_detail text default null,
  p_precautions text default null,
  p_pain_before smallint default null,
  p_pain_after smallint default null,
  p_outcome_summary text default null,
  p_advice text default null
)
returns public.clinical_treatment_sessions
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_clinic uuid := public.current_clinic_id();
  v_department text := public.current_department_role();
  v_profile_role text;
  v_encounter public.encounters%rowtype;
  v_session_no integer;
  v_row public.clinical_treatment_sessions%rowtype;
  v_modalities text[] := coalesce(p_treatment_modalities, '{}');
  v_detail text := nullif(btrim(p_treatment_detail), '');
  v_referral_detail text := nullif(btrim(p_procedure_referral_detail), '');
  v_precautions text := nullif(btrim(p_precautions), '');
  v_outcome text := nullif(btrim(p_outcome_summary), '');
  v_advice text := nullif(btrim(p_advice), '');
begin
  if v_actor is null then raise exception 'AUTH_REQUIRED'; end if;
  if v_clinic is null then raise exception 'CLINIC_CONTEXT_REQUIRED'; end if;
  if p_client_request_id is null then raise exception 'CLIENT_REQUEST_ID_REQUIRED'; end if;
  if v_detail is null then raise exception 'TREATMENT_DETAIL_REQUIRED'; end if;
  if p_pain_before is not null and (p_pain_before < 0 or p_pain_before > 10) then
    raise exception 'INVALID_PAIN_BEFORE';
  end if;
  if p_pain_after is not null and (p_pain_after < 0 or p_pain_after > 10) then
    raise exception 'INVALID_PAIN_AFTER';
  end if;

  select p.role into v_profile_role
  from public.profiles p
  where p.id = v_actor;
  perform public.assert_clinic_subscription_active(v_clinic);
  if not public.department_can('clinical')
     and not (
       v_department in ('owner','admin')
       and v_profile_role in ('practitioner','doctor')
     ) then
    raise exception 'PERMISSION_DENIED';
  end if;

  -- The encounter lock serializes session numbering and same-request replays.
  select e.* into v_encounter
  from public.encounters e
  where e.id = p_encounter_id and e.clinic_id = v_clinic
  for update;
  if not found then raise exception 'ENCOUNTER_NOT_FOUND'; end if;
  if v_encounter.status in ('closed','cancelled','void') then
    raise exception 'ENCOUNTER_NOT_EDITABLE';
  end if;
  if v_encounter.practitioner_id is not null
     and v_encounter.practitioner_id <> v_actor
     and not public.is_super_admin() then
    raise exception 'ENCOUNTER_PRACTITIONER_MISMATCH';
  end if;

  select s.* into v_row
  from public.clinical_treatment_sessions s
  where s.encounter_id = p_encounter_id
    and s.client_request_id = p_client_request_id;

  if found then
    if v_row.practitioner_id is distinct from v_actor
       or v_row.treatment_modalities is distinct from v_modalities
       or v_row.treatment_detail is distinct from v_detail
       or v_row.procedure_referral is distinct from coalesce(p_procedure_referral, false)
       or v_row.procedure_referral_detail is distinct from v_referral_detail
       or v_row.precautions is distinct from v_precautions
       or v_row.pain_before is distinct from p_pain_before
       or v_row.pain_after is distinct from p_pain_after
       or v_row.outcome_summary is distinct from v_outcome
       or v_row.advice is distinct from v_advice then
      raise exception 'CLIENT_REQUEST_ID_REUSE';
    end if;
    return v_row;
  end if;

  select coalesce(max(s.session_no), 0) + 1 into v_session_no
  from public.clinical_treatment_sessions s
  where s.encounter_id = p_encounter_id;

  insert into public.clinical_treatment_sessions (
    encounter_id, client_request_id, session_no, treatment_modalities,
    treatment_detail, procedure_referral, procedure_referral_detail,
    precautions, pain_before, pain_after, outcome_summary, advice,
    practitioner_id
  ) values (
    p_encounter_id, p_client_request_id, v_session_no, v_modalities,
    v_detail, coalesce(p_procedure_referral, false), v_referral_detail,
    v_precautions, p_pain_before, p_pain_after, v_outcome, v_advice,
    v_actor
  ) returning * into v_row;

  insert into public.audit_logs(clinic_id,user_id,action,entity,entity_id,metadata)
  values (
    v_clinic,v_actor,'create_clinical_treatment_session',
    'clinical_treatment_sessions',v_row.id::text,
    jsonb_build_object(
      'encounter_id',p_encounter_id,
      'session_no',v_session_no,
      'client_request_id',p_client_request_id
    )
  );
  return v_row;
end;
$$;

-- Retire the non-keyed overload. Leaving its earlier authenticated grant in
-- place would let stale browser clients bypass the request-id boundary.
revoke all on function public.create_clinical_treatment_session(
  uuid,text[],text,boolean,text,text,smallint,smallint,text,text
) from public, anon, authenticated, service_role;

revoke all on function public.create_clinical_treatment_session(
  uuid,uuid,text[],text,boolean,text,text,smallint,smallint,text,text
) from public, anon, authenticated, service_role;
grant execute on function public.create_clinical_treatment_session(
  uuid,uuid,text[],text,boolean,text,text,smallint,smallint,text,text
) to authenticated;

revoke insert, update, delete on public.clinical_treatment_sessions
  from authenticated;

commit;

select 'TREATMENT_SESSION_IDEMPOTENCY_READY' as status;
