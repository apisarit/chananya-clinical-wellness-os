-- Inert technical proposal. Requires privacy/authorization review, approved
-- retention/readers, backup integration and a reviewed API/UI activation.
begin;
do $$ begin raise exception 'SELECTED_EXPORT_AUDIT_REVIEW_REQUIRED'; end $$;
create schema cnyos_export_internal;
revoke all on schema cnyos_export_internal from public,anon,authenticated,service_role;

-- No role implicitly receives export authority; no permissions are seeded.
create table cnyos_export_internal.permissions (
  clinic_id uuid not null,
  actor_id uuid not null,
  active boolean not null default false,
  policy_reference text not null check(length(btrim(policy_reference)) between 1 and 500),
  primary key(clinic_id,actor_id),
  foreign key(clinic_id,actor_id) references public.clinic_memberships(clinic_id,profile_id) on delete restrict
);
create table cnyos_export_internal.permission_events (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  subject_id uuid not null references public.profiles(id) on delete restrict,
  actor_id uuid,
  database_session_user text not null,
  database_role text not null,
  operation text not null check(operation in ('INSERT','UPDATE','DELETE')),
  before_state jsonb,
  after_state jsonb,
  recorded_at timestamptz not null default clock_timestamp(),
  check((operation='INSERT' and before_state is null and after_state is not null)
    or (operation='UPDATE' and before_state is not null and after_state is not null)
    or (operation='DELETE' and before_state is not null and after_state is null))
);
create table cnyos_export_internal.preparation_events (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  patient_ids uuid[] not null check(cardinality(patient_ids) between 1 and 100),
  requested_format text not null check(requested_format in ('csv','json')),
  policy_reference text not null,
  operation text not null default 'patient_export_prepared' check(operation='patient_export_prepared'),
  recorded_at timestamptz not null default clock_timestamp()
);
alter table cnyos_export_internal.permissions enable row level security;
alter table cnyos_export_internal.permission_events enable row level security;
alter table cnyos_export_internal.preparation_events enable row level security;
revoke all on all tables in schema cnyos_export_internal from public,anon,authenticated,service_role;

create function cnyos_export_internal.reject_history_mutation()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin raise exception 'EXPORT_HISTORY_IMMUTABLE'; end $$;
create trigger immutable_export_history before update or delete on cnyos_export_internal.preparation_events
for each row execute function cnyos_export_internal.reject_history_mutation();
create trigger no_export_history_truncate before truncate on cnyos_export_internal.preparation_events
for each statement execute function cnyos_export_internal.reject_history_mutation();
create trigger immutable_permission_history before update or delete on cnyos_export_internal.permission_events
for each row execute function cnyos_export_internal.reject_history_mutation();
create trigger no_permission_history_truncate before truncate on cnyos_export_internal.permission_events
for each statement execute function cnyos_export_internal.reject_history_mutation();
create trigger no_permission_truncate before truncate on cnyos_export_internal.permissions
for each statement execute function cnyos_export_internal.reject_history_mutation();
create function cnyos_export_internal.audit_permission_change()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if tg_op='UPDATE' and row(old.clinic_id,old.actor_id) is distinct from row(new.clinic_id,new.actor_id)
    then raise exception 'EXPORT_PERMISSION_IDENTITY_IMMUTABLE'; end if;
  insert into cnyos_export_internal.permission_events(clinic_id,subject_id,actor_id,database_session_user,database_role,operation,before_state,after_state)
    values(case when tg_op='DELETE' then old.clinic_id else new.clinic_id end,
      case when tg_op='DELETE' then old.actor_id else new.actor_id end,
      auth.uid(),session_user,current_setting('role'),tg_op,
      case when tg_op='INSERT' then null else to_jsonb(old) end,
      case when tg_op='DELETE' then null else to_jsonb(new) end);
  return null;
end $$;
create trigger audit_permission_change after insert or update or delete on cnyos_export_internal.permissions
for each row execute function cnyos_export_internal.audit_permission_change();

-- Private, ungranted SECURITY DEFINER boundary: one fixed projection, explicit
-- tenant/actor authorization, and atomic evidence insertion. No arbitrary table,
-- columns, actor, clinic or client-provided audit payload is accepted.
create function cnyos_export_internal.prepare_patients(p_ids uuid[],p_format text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare
  v_actor uuid:=auth.uid(); v_clinic uuid; v_policy text;
  v_rows jsonb; v_event cnyos_export_internal.preparation_events;
begin
  if v_actor is null then raise exception 'AUTH_REQUIRED'; end if;
  v_clinic:=public.current_clinic_id();
  if v_clinic is null then raise exception 'CLINIC_ACCESS_REQUIRED'; end if;
  perform public.assert_clinic_subscription_active(v_clinic);
  perform 1 from public.clinic_memberships where clinic_id=v_clinic and profile_id=v_actor and active for share;
  if not found then raise exception 'CLINIC_ACCESS_REQUIRED'; end if;
  select policy_reference into v_policy from cnyos_export_internal.permissions
    where clinic_id=v_clinic and actor_id=v_actor and active for share;
  if not found then raise exception 'EXPORT_NOT_AUTHORIZED'; end if;
  if p_ids is null or cardinality(p_ids) not between 1 and 100
    or array_ndims(p_ids)<>1
    or (select count(distinct id) from unnest(p_ids) id)<>cardinality(p_ids)
    or p_format is null or p_format not in ('csv','json')
  then raise exception 'EXPORT_REQUEST_INVALID'; end if;
  select jsonb_agg(jsonb_build_object(
    'id',p.id,'clinic_id',p.clinic_id,'hn',p.hn,'prefix',p.prefix,
    'first_name',p.first_name,'last_name',p.last_name,'gender',p.gender,
    'date_of_birth',p.date_of_birth,'phone',p.phone,'email',p.email,
    'active',p.active,'created_at',p.created_at,'updated_at',p.updated_at
  ) order by requested.ordinality) into v_rows
  from unnest(p_ids) with ordinality requested(id,ordinality)
  join public.patients p on p.id=requested.id and p.clinic_id=v_clinic;
  if coalesce(jsonb_array_length(v_rows),0)<>cardinality(p_ids)
    then raise exception 'EXPORT_SELECTION_UNAVAILABLE'; end if;
  insert into cnyos_export_internal.preparation_events(clinic_id,actor_id,patient_ids,requested_format,policy_reference)
    values(v_clinic,v_actor,p_ids,p_format,v_policy) returning * into v_event;
  return jsonb_build_object('receipt_id',v_event.id,'recorded_at',v_event.recorded_at,
    'operation',v_event.operation,'rows',v_rows);
end $$;
revoke all on all functions in schema cnyos_export_internal from public,anon,authenticated,service_role;
commit;
