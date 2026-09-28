-- Disposable-fixture prototype. Depends on amendment-generation-prototype.sql.
-- Not exposed via public/PostgREST; legacy endpoint remains unchanged in this test.
create table cnyos_amendment_test.receipts (
  request_id uuid primary key, clinic_id uuid not null, actor_id uuid not null,
  encounter_id uuid not null, signoff_id uuid not null, generation bigint not null,
  reason text not null, result jsonb not null
);
alter table cnyos_amendment_test.receipts enable row level security;
revoke all on cnyos_amendment_test.receipts from public,anon,authenticated,service_role;
create function cnyos_amendment_test.unlock_once(
  p_request uuid,p_encounter uuid,p_signoff uuid,p_generation bigint,p_reason text
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,pg_temp
as $$
declare
  v_clinic uuid;
  v_receipt cnyos_amendment_test.receipts;
  v_signoff public.clinical_record_signoffs;
  v_result jsonb;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  v_clinic:=public.current_clinic_id();
  if v_clinic is null then raise exception 'CNYOS_SUBSCRIPTION_SUSPENDED'; end if;
  perform public.assert_clinic_subscription_active(v_clinic);
  if not public.has_role(array['super_admin','admin']) then raise exception 'PERMISSION_DENIED'; end if;
  if p_request is null or p_encounter is null or p_signoff is null or p_generation is null
    or p_generation<1 or p_reason is null or length(btrim(p_reason))<5 then
    raise exception 'AMENDMENT_INPUT_INVALID';
  end if;
  -- Serialize the request before the Encounter. A hash collision only serializes
  -- unrelated requests; the receipt's exact UUID remains authoritative.
  perform pg_catalog.pg_advisory_xact_lock(197604,pg_catalog.hashtext(p_request::text));
  perform 1 from public.encounters where id=p_encounter and clinic_id=v_clinic for update;
  if not found then raise exception 'SIGNED_RECORD_NOT_FOUND'; end if;
  select * into v_receipt from cnyos_amendment_test.receipts where request_id=p_request;
  if found then
    if v_receipt.clinic_id<>v_clinic or v_receipt.actor_id<>auth.uid()
      or v_receipt.encounter_id<>p_encounter or v_receipt.signoff_id<>p_signoff
      or v_receipt.generation<>p_generation or v_receipt.reason<>btrim(p_reason) then
      raise exception 'AMENDMENT_REQUEST_CONFLICT';
    end if;
    return v_receipt.result;
  end if;
  select * into v_signoff from public.clinical_record_signoffs
    where encounter_id=p_encounter and record_section='complete_record' for update;
  if not found then raise exception 'SIGNED_RECORD_NOT_FOUND'; end if;
  if v_signoff.id<>p_signoff or v_signoff.signature_generation<>p_generation then
    raise exception 'AMENDMENT_SIGNATURE_STALE';
  end if;
  if not v_signoff.lock_record then raise exception 'AMENDMENT_ALREADY_UNLOCKED'; end if;
  perform public.unlock_clinical_record_for_amendment(p_encounter,btrim(p_reason));
  v_result:=jsonb_build_object('request_id',p_request,'encounter_id',p_encounter,
    'signoff_id',p_signoff,'signature_generation',p_generation::text,'unlocked',true);
  insert into cnyos_amendment_test.receipts values
    (p_request,v_clinic,auth.uid(),p_encounter,p_signoff,p_generation,btrim(p_reason),v_result);
  return v_result;
end;
$$;
revoke all on function cnyos_amendment_test.unlock_once(uuid,uuid,uuid,bigint,text) from public,anon,authenticated,service_role;
-- Fixture-only SQL access, not an application grant or production endpoint.
grant usage on schema cnyos_amendment_test to authenticated;
grant execute on function cnyos_amendment_test.unlock_once(uuid,uuid,uuid,bigint,text) to authenticated;
