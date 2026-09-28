-- Local review candidate only. No live execution or migration authorization.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $$ begin raise exception 'CLINICAL_AMENDMENT_RECOVERY_REVIEW_REQUIRED'; end $$;

create schema cnyos_amendment_internal;
revoke all on schema cnyos_amendment_internal from public,anon,authenticated,service_role;

alter table public.clinical_record_signoffs
  add column signature_generation bigint not null default 1
  check (signature_generation > 0);

create function cnyos_amendment_internal.assign_generation()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if TG_OP = 'INSERT' then
    NEW.signature_generation := 1;
  elsif NEW.lock_record then
    NEW.signature_generation := OLD.signature_generation + 1;
  else
    NEW.signature_generation := OLD.signature_generation;
  end if;
  return NEW;
end;
$$;
revoke all on function cnyos_amendment_internal.assign_generation()
  from public,anon,authenticated,service_role;
create trigger assign_signature_generation
before insert or update on public.clinical_record_signoffs
for each row execute function cnyos_amendment_internal.assign_generation();

create table cnyos_amendment_internal.receipts (
  request_id uuid primary key,
  clinic_id uuid not null,
  actor_id uuid not null,
  encounter_id uuid not null,
  signoff_id uuid not null,
  generation bigint not null check (generation > 0),
  reason text not null check (length(reason) between 5 and 2000 and reason=btrim(reason)),
  result jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
alter table cnyos_amendment_internal.receipts enable row level security;
revoke all on cnyos_amendment_internal.receipts from public,anon,authenticated,service_role;

create function cnyos_amendment_internal.reject_receipt_mutation()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, pg_temp
as $$ begin raise exception 'AMENDMENT_RECEIPT_IMMUTABLE'; end $$;
revoke all on function cnyos_amendment_internal.reject_receipt_mutation()
  from public,anon,authenticated,service_role;
create trigger immutable_amendment_receipt
before update or delete on cnyos_amendment_internal.receipts
for each row execute function cnyos_amendment_internal.reject_receipt_mutation();
create trigger immutable_amendment_receipt_truncate
before truncate on cnyos_amendment_internal.receipts
for each statement execute function cnyos_amendment_internal.reject_receipt_mutation();

create function public.unlock_clinical_record_for_amendment_v2(
  p_request_id uuid, p_encounter_id uuid, p_signoff_id uuid,
  p_signature_generation bigint, p_reason text
) returns jsonb language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_clinic uuid;
  v_receipt cnyos_amendment_internal.receipts;
  v_signoff public.clinical_record_signoffs;
  v_result jsonb;
begin
  if v_actor is null then raise exception 'AUTH_REQUIRED'; end if;
  v_clinic := public.current_clinic_id();
  if v_clinic is null then raise exception 'CNYOS_SUBSCRIPTION_SUSPENDED'; end if;
  perform public.assert_clinic_subscription_active(v_clinic);
  -- Hold the authorization rows through commit; recheck after any lock wait.
  perform 1 from public.profiles where id=v_actor for share;
  if not found then raise exception 'PERMISSION_DENIED'; end if;
  perform 1 from public.clinic_memberships
    where profile_id=v_actor and clinic_id=v_clinic and active for share;
  if not found or public.current_clinic_id() is distinct from v_clinic then
    raise exception 'PERMISSION_DENIED';
  end if;
  -- current_user_role maps clinic Admin/Owner to governance_admin, not admin.
  -- Use the existing tenant-bound governance predicate, not the legacy alias.
  if not public.is_admin_or_super() then raise exception 'PERMISSION_DENIED'; end if;
  if p_request_id is null or p_encounter_id is null or p_signoff_id is null
    or p_signature_generation is null or p_signature_generation < 1
    or p_reason is null or length(btrim(p_reason)) not between 5 and 2000 then
    raise exception 'AMENDMENT_INPUT_INVALID';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(197604,pg_catalog.hashtext(p_request_id::text));
  perform 1 from public.encounters where id=p_encounter_id and clinic_id=v_clinic for update;
  if not found then raise exception 'SIGNED_RECORD_NOT_FOUND'; end if;
  select * into v_receipt from cnyos_amendment_internal.receipts where request_id=p_request_id;
  if found then
    if v_receipt.clinic_id<>v_clinic or v_receipt.actor_id<>v_actor
      or v_receipt.encounter_id<>p_encounter_id or v_receipt.signoff_id<>p_signoff_id
      or v_receipt.generation<>p_signature_generation or v_receipt.reason<>btrim(p_reason) then
      raise exception 'AMENDMENT_REQUEST_CONFLICT';
    end if;
    return v_receipt.result;
  end if;
  select * into v_signoff from public.clinical_record_signoffs
    where encounter_id=p_encounter_id and record_section='complete_record' for update;
  if not found then raise exception 'SIGNED_RECORD_NOT_FOUND'; end if;
  if v_signoff.id<>p_signoff_id or v_signoff.signature_generation<>p_signature_generation then
    raise exception 'AMENDMENT_SIGNATURE_STALE';
  end if;
  if not v_signoff.lock_record then raise exception 'AMENDMENT_ALREADY_UNLOCKED'; end if;
  update public.clinical_record_signoffs
    set lock_record=false, reason='Unlocked for amendment: '||btrim(p_reason)
    where id=v_signoff.id;
  insert into public.clinical_record_audit_events(
    encounter_id,event_type,record_section,actor_id,reason,details
  ) values (
    p_encounter_id,'UNLOCK_FOR_AMENDMENT','complete_record',v_actor,btrim(p_reason),
    pg_catalog.jsonb_build_object('request_id',p_request_id,'signoff_id',p_signoff_id,
      'signature_generation',p_signature_generation::text,'old_locked',true,'new_locked',false)
  );
  v_result := pg_catalog.jsonb_build_object('request_id',p_request_id,'encounter_id',p_encounter_id,
    'signoff_id',p_signoff_id,'signature_generation',p_signature_generation::text,'unlocked',true,
    'actor_id',v_actor,'clinic_id',v_clinic,
    'reason_digest',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(btrim(p_reason),'UTF8')),'hex'));
  insert into cnyos_amendment_internal.receipts(
    request_id,clinic_id,actor_id,encounter_id,signoff_id,generation,reason,result
  ) values (p_request_id,v_clinic,v_actor,p_encounter_id,p_signoff_id,p_signature_generation,btrim(p_reason),v_result);
  return v_result;
end;
$$;
revoke all on function public.unlock_clinical_record_for_amendment_v2(uuid,uuid,uuid,bigint,text)
  from public,anon,authenticated,service_role;
grant execute on function public.unlock_clinical_record_for_amendment_v2(uuid,uuid,uuid,bigint,text) to authenticated;

-- Read-only recovery: null means not visible/committed, never permission to issue
-- a new mutation. Row locks protect authorization; no application rows are written.
create function public.read_clinical_amendment_receipt(p_request_id uuid)
returns jsonb language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_clinic uuid;
  v_result jsonb;
begin
  if v_actor is null then raise exception 'AUTH_REQUIRED'; end if;
  v_clinic := public.current_clinic_id();
  if v_clinic is null then raise exception 'CNYOS_SUBSCRIPTION_SUSPENDED'; end if;
  perform public.assert_clinic_subscription_active(v_clinic);
  perform 1 from public.profiles where id=v_actor for share;
  if not found then raise exception 'PERMISSION_DENIED'; end if;
  perform 1 from public.clinic_memberships
    where profile_id=v_actor and clinic_id=v_clinic and active for share;
  if not found or public.current_clinic_id() is distinct from v_clinic then
    raise exception 'PERMISSION_DENIED';
  end if;
  if not public.is_admin_or_super() then raise exception 'PERMISSION_DENIED'; end if;
  if p_request_id is null then raise exception 'AMENDMENT_INPUT_INVALID'; end if;
  select r.result into v_result from cnyos_amendment_internal.receipts r
    join public.encounters e on e.id=r.encounter_id and e.clinic_id=v_clinic
    where r.request_id=p_request_id and r.clinic_id=v_clinic and r.actor_id=v_actor;
  return v_result;
end;
$$;
revoke all on function public.read_clinical_amendment_receipt(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.read_clinical_amendment_receipt(uuid) to authenticated;

-- No compatibility mutation: the legacy API has no request/signature precondition.
create or replace function public.unlock_clinical_record_for_amendment(p_encounter_id uuid,p_reason text)
returns boolean language plpgsql volatile security invoker
set search_path = pg_catalog, pg_temp
as $$ begin raise exception 'AMENDMENT_VERSIONED_REQUEST_REQUIRED'; end $$;
revoke all on function public.unlock_clinical_record_for_amendment(uuid,text)
  from public,anon,authenticated,service_role;
revoke insert,update,delete,truncate on public.clinical_record_signoffs from public,anon,authenticated,service_role;
commit;
