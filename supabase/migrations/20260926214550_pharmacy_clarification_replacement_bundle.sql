-- Atomic pharmacy clarification/replacement and backup contract installation.
-- Local candidate: requires exact-commit review and protected release approval.
-- Runtime exporter/restore configuration must explicitly support 2026-09-27.1.
begin;

-- Component: pharmacy_clarification_candidate.sql
create schema if not exists cnyos_clarification_internal;
revoke all on schema cnyos_clarification_internal from public, anon, authenticated, service_role;
create table if not exists cnyos_clarification_internal.tickets (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id),
  order_id uuid not null references public.dispensing_orders(id),
  request_id uuid not null,
  requested_by uuid not null references auth.users(id),
  question text not null check(length(question) between 3 and 2000),
  snapshot jsonb not null,
  status text not null default 'open' check(status in ('open','answered','resolved')),
  answer text,
  answered_by uuid references auth.users(id),
  answered_at timestamptz,
  acknowledged_by uuid references auth.users(id),
  acknowledged_at timestamptz,
  created_at timestamptz not null default now(),
  unique(clinic_id,requested_by,request_id), unique(order_id,request_id)
);
create unique index if not exists clarification_one_unresolved on cnyos_clarification_internal.tickets(order_id) where status <> 'resolved';
alter table cnyos_clarification_internal.tickets enable row level security;
revoke all on cnyos_clarification_internal.tickets from public, anon, authenticated, service_role;
create table if not exists cnyos_clarification_internal.clearances (
  order_id uuid primary key references public.dispensing_orders(id),
  ticket_id uuid not null unique references cnyos_clarification_internal.tickets(id)
);
alter table cnyos_clarification_internal.clearances enable row level security;
revoke all on cnyos_clarification_internal.clearances from public,anon,authenticated,service_role;

create or replace function cnyos_clarification_internal.snapshot(p_rx uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('prescription', to_jsonb(rx) - array['status','updated_at','completed_at','sent_to_pharmacy_at'],
    'items', coalesce((select jsonb_agg(to_jsonb(pi) - array['status','updated_at'] order by pi.id)
      from public.prescription_items pi where pi.prescription_id=rx.id), '[]'::jsonb))
  from public.prescriptions rx where rx.id=p_rx
$$;

create or replace function public.manage_prescription_clarification(
  p_order_id uuid, p_request_id uuid, p_action text, p_text text default null
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
  v_clinic uuid := public.current_clinic_id();
  v_actor uuid := auth.uid();
  v_order public.dispensing_orders%rowtype;
  v_rx public.prescriptions%rowtype;
  v_ticket cnyos_clarification_internal.tickets%rowtype;
  v_pharmacy boolean;
  v_prescriber boolean;
  v_snapshot jsonb;
  v_history jsonb;
  v_text text := btrim(p_text);
begin
  if v_actor is null or v_clinic is null or not exists (
    select 1 from public.clinic_memberships m where m.profile_id=v_actor and m.clinic_id=v_clinic and m.active
  ) then raise exception 'CLARIFICATION_ACCESS_DENIED'; end if;
  perform public.assert_clinic_subscription_active(v_clinic);
  if (p_request_id is null and p_action is distinct from 'history')
    or p_action is null or p_action not in ('open','answer','acknowledge','read','history') then
    raise exception 'CLARIFICATION_REQUEST_INVALID';
  end if;
  -- Same order as effective dispensing/invoicing: encounter -> order -> rx.
  perform e.id from public.encounters e join public.prescriptions rx on rx.encounter_id=e.id
    join public.dispensing_orders d on d.prescription_id=rx.id
    where d.id=p_order_id and e.clinic_id=v_clinic for update of e;
  if not found then raise exception 'CLARIFICATION_ORDER_NOT_FOUND'; end if;
  select * into v_order from public.dispensing_orders where id=p_order_id for update;
  select * into v_rx from public.prescriptions where id=v_order.prescription_id for update;
  v_pharmacy := coalesce(public.department_can('pharmacy'),false);
  v_prescriber := v_rx.prescriber_id=v_actor and exists(select 1 from public.clinic_memberships m
    where m.profile_id=v_actor and m.clinic_id=v_clinic and m.active and m.clinic_role in ('doctor','practitioner'));
  if not (v_pharmacy or coalesce(v_prescriber,false)) then raise exception 'CLARIFICATION_ACCESS_DENIED'; end if;
  if p_action='history' then
    -- For history only, p_request_id is the last ticket ID cursor, not a write key.
    -- Stable ID pagination; callers refresh from null to discover newly added rows.
    with page as materialized (
      select t.* from cnyos_clarification_internal.tickets t
      where t.order_id=p_order_id and t.clinic_id=v_clinic
        and (p_request_id is null or t.id>p_request_id)
      order by t.id limit 101
    ), visible as (select * from page order by id limit 100)
    select jsonb_build_object(
      'tickets',coalesce(jsonb_agg(to_jsonb(v) order by v.id),'[]'::jsonb),
      'next_cursor',case when (select count(*) from page)>100
        then (select id from visible order by id desc limit 1) else null end
    ) into v_history from visible v;
    return v_history;
  end if;
  select * into v_ticket from cnyos_clarification_internal.tickets where order_id=p_order_id and request_id=p_request_id for update;
  if p_action='read' then
    if v_ticket.id is null then raise exception 'CLARIFICATION_NOT_FOUND'; end if;
    return to_jsonb(v_ticket);
  end if;
  if p_action in ('open','acknowledge') and not v_pharmacy then raise exception 'CLARIFICATION_PHARMACY_REQUIRED'; end if;
  if p_action='answer' and not coalesce(v_prescriber,false) then raise exception 'CLARIFICATION_PRESCRIBER_REQUIRED'; end if;
  if p_action in ('open','answer') and (v_text is null or length(v_text) not between 3 and 2000) then
    raise exception 'CLARIFICATION_TEXT_REQUIRED';
  end if;
  if p_action='open' and v_ticket.id is not null then
    if v_ticket.requested_by<>v_actor or v_ticket.question<>v_text then raise exception 'CLARIFICATION_REQUEST_CONFLICT'; end if;
    return to_jsonb(v_ticket);
  end if;
  if p_action<>'open' and v_ticket.id is null then raise exception 'CLARIFICATION_NOT_FOUND'; end if;
  if p_action='answer' and v_ticket.status in ('answered','resolved') then
    if v_ticket.answered_by<>v_actor or v_ticket.answer<>v_text then raise exception 'CLARIFICATION_ANSWER_CONFLICT'; end if;
    return to_jsonb(v_ticket);
  end if;
  if p_action='acknowledge' and v_ticket.status='resolved' then return to_jsonb(v_ticket); end if;
  if v_rx.status in ('cancelled','void') then raise exception 'CLARIFICATION_PRESCRIPTION_INACTIVE'; end if;
  if v_order.status not in ('waiting','pending','reviewed') or exists(
    select 1 from public.dispensing_items di where di.dispensing_order_id=p_order_id
  ) or exists(select 1 from public.invoices i where i.encounter_id=v_rx.encounter_id and i.status not in ('void','cancelled')) then
    raise exception 'CLARIFICATION_CORRECTION_WORKFLOW_REQUIRED';
  end if;
  perform pi.id from public.prescription_items pi where pi.prescription_id=v_rx.id order by pi.id for update;
  v_snapshot := cnyos_clarification_internal.snapshot(v_rx.id);
  if p_action='open' then
    if exists(select 1 from cnyos_clarification_internal.tickets where order_id=p_order_id and status<>'resolved') then
      raise exception 'CLARIFICATION_ALREADY_OPEN';
    end if;
    insert into cnyos_clarification_internal.tickets(clinic_id,order_id,request_id,requested_by,question,snapshot)
      values(v_clinic,p_order_id,p_request_id,v_actor,v_text,v_snapshot) returning * into v_ticket;
    update public.dispensing_orders set status='waiting',reviewed_by=null,reviewed_at=null where id=p_order_id;
  else
    if v_snapshot is distinct from v_ticket.snapshot then raise exception 'CLARIFICATION_REVISION_CHANGED'; end if;
    if p_action='answer' then
      if v_ticket.requested_by=v_actor then raise exception 'CLARIFICATION_SEPARATE_RESPONDER_REQUIRED'; end if;
      update cnyos_clarification_internal.tickets set answer=v_text,answered_by=v_actor,answered_at=now(),status='answered'
        where id=v_ticket.id returning * into v_ticket;
    else
      if v_ticket.status<>'answered' then raise exception 'CLARIFICATION_ANSWER_REQUIRED'; end if;
      if v_ticket.answered_by=v_actor then raise exception 'CLARIFICATION_SEPARATE_ACKNOWLEDGER_REQUIRED'; end if;
      update cnyos_clarification_internal.tickets set status='resolved',acknowledged_by=v_actor,acknowledged_at=now()
        where id=v_ticket.id returning * into v_ticket;
      insert into cnyos_clarification_internal.clearances(order_id,ticket_id)
        values(p_order_id,v_ticket.id) on conflict(order_id)
        do update set ticket_id=excluded.ticket_id;
      -- Re-review is mandatory, even if the prior order was reviewed.
      update public.dispensing_orders set status='waiting',reviewed_by=null,reviewed_at=null where id=p_order_id;
    end if;
  end if;
  insert into public.audit_logs(clinic_id,user_id,action,entity,entity_id,metadata)
    values(v_clinic,v_actor,'prescription_clarification_'||p_action,'prescription_clarifications',v_ticket.id::text,
      jsonb_build_object('order_id',p_order_id,'request_id',p_request_id,'status',v_ticket.status));
  return to_jsonb(v_ticket);
end $$;

create or replace function cnyos_clarification_internal.clearance_evidence(p_order uuid,p_rx uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_ticket cnyos_clarification_internal.tickets%rowtype;
begin
  if exists(select 1 from public.prescriptions where id=p_rx and status in ('cancelled','void')) then
    raise exception 'PRESCRIPTION_INACTIVE';
  end if;
  if exists(
    select 1 from cnyos_clarification_internal.tickets t where t.order_id=p_order and t.status<>'resolved'
  ) then raise exception 'PRESCRIPTION_CLARIFICATION_PENDING'; end if;
  if not exists(select 1 from cnyos_clarification_internal.tickets where order_id=p_order) then return null; end if;
    select t.* into v_ticket
      from cnyos_clarification_internal.clearances c
      join cnyos_clarification_internal.tickets t on t.id=c.ticket_id and t.order_id=c.order_id
      where c.order_id=p_order and t.status='resolved';
    if v_ticket.id is null or v_ticket.snapshot is distinct from cnyos_clarification_internal.snapshot(p_rx) then
      raise exception 'PRESCRIPTION_CLARIFICATION_REVISION_CHANGED';
    end if;
  return jsonb_build_object('ticket_id',v_ticket.id,'snapshot',v_ticket.snapshot,
    'answered_by',v_ticket.answered_by,'acknowledged_by',v_ticket.acknowledged_by);
end $$;

create or replace function cnyos_clarification_internal.guard_dispensing()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.status in ('reviewed','dispensed','submitted_to_billing','billed') then
    perform cnyos_clarification_internal.clearance_evidence(new.id,new.prescription_id);
  end if;
  return new;
end $$;
drop trigger if exists clarification_blocks_dispensing on public.dispensing_orders;
create trigger clarification_blocks_dispensing before update of status on public.dispensing_orders
  for each row execute function cnyos_clarification_internal.guard_dispensing();
do $bind_inactive$
declare v_def text; v_anchor text := '  if v_action = ''review'' then';
begin
  v_def := pg_get_functiondef('public.transition_atomic_prescription_dispensing(uuid,text,jsonb,text)'::regprocedure);
  if position('PRESCRIPTION_INACTIVE' in v_def)=0 then
    if position(v_anchor in v_def)=0 then raise exception 'CLARIFICATION_DISPENSING_BINDING_ANCHOR_MISSING'; end if;
    v_def := replace(v_def,v_anchor,
      '  if v_prescription.status in (''cancelled'',''void'') then raise exception ''PRESCRIPTION_INACTIVE''; end if;'
      || E'\n' || v_anchor);
    execute v_def;
  end if;
end $bind_inactive$;
do $bind_quote$
declare v_def text; v_anchor text := '    v_order_count := v_order_count + 1;';
begin
  v_def := pg_get_functiondef('cnyos_billing_internal.encounter_invoice_quote(uuid,uuid,boolean)'::regprocedure);
  if position('cnyos_clarification_internal.clearance_evidence' in v_def)=0 then
    if position(v_anchor in v_def)=0 then raise exception 'CLARIFICATION_QUOTE_BINDING_ANCHOR_MISSING'; end if;
    v_def := replace(v_def,v_anchor,
      '    v_fingerprint_input := v_fingerprint_input || jsonb_build_array(cnyos_clarification_internal.clearance_evidence(v_order.id,v_rx.id));'
      || E'\n' || v_anchor);
    execute v_def;
  end if;
end $bind_quote$;
revoke all on all functions in schema cnyos_clarification_internal from public,anon,authenticated,service_role;
revoke all on function public.manage_prescription_clarification(uuid,uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.manage_prescription_clarification(uuid,uuid,text,text) to authenticated;

-- Component: pharmacy_clarification_backup_candidate.sql
create or replace function cnyos_clarification_internal.backup_projection(p_clinic uuid)
returns jsonb language plpgsql stable security definer set search_path=''
set timezone='UTC' set datestyle='ISO, YMD' as $$
declare v_data jsonb; v_counts jsonb; v_hashes jsonb;
begin
  if p_clinic is null then raise exception 'CLINIC_ID_REQUIRED'; end if;
  if exists(select 1 from cnyos_clarification_internal.tickets t
    join public.dispensing_orders d on d.id=t.order_id
    join public.prescriptions rx on rx.id=d.prescription_id
    join public.encounters e on e.id=rx.encounter_id
    where (t.clinic_id=p_clinic or e.clinic_id=p_clinic) and t.clinic_id is distinct from e.clinic_id)
    or exists(select 1 from cnyos_clarification_internal.clearances c
      join cnyos_clarification_internal.tickets t on t.id=c.ticket_id
      join public.dispensing_orders d on d.id=c.order_id
      join public.prescriptions rx on rx.id=d.prescription_id
      join public.encounters e on e.id=rx.encounter_id
      where (t.clinic_id=p_clinic or e.clinic_id=p_clinic)
        and (t.order_id<>c.order_id or t.clinic_id is distinct from e.clinic_id or t.status<>'resolved'))
  then raise exception 'BACKUP_CLARIFICATION_INTEGRITY_ANOMALY'; end if;
  v_data:=jsonb_build_object(
    'cnyos_clarification_internal.tickets',coalesce((select jsonb_agg(to_jsonb(t) order by t.id)
      from cnyos_clarification_internal.tickets t where t.clinic_id=p_clinic),'[]'::jsonb),
    'cnyos_clarification_internal.clearances',coalesce((select jsonb_agg(to_jsonb(c) order by c.order_id)
      from cnyos_clarification_internal.clearances c join cnyos_clarification_internal.tickets t on t.id=c.ticket_id
      where t.clinic_id=p_clinic),'[]'::jsonb));
  select jsonb_object_agg(k,jsonb_array_length(v_data->k)),
    jsonb_object_agg(k,encode(pg_catalog.sha256(convert_to((v_data->k)::text,'UTF8')),'hex'))
    into v_counts,v_hashes from jsonb_object_keys(v_data) keys(k);
  return jsonb_build_object('data',v_data,'counts',v_counts,'table_sha256',v_hashes);
end $$;
revoke all on function cnyos_clarification_internal.backup_projection(uuid) from public,anon,authenticated,service_role;

do $$ begin
  if to_regprocedure('public.export_clinic_backup_domain_pre_clarification(uuid,text)') is null then
    alter function public.export_clinic_backup_domain(uuid,text) rename to export_clinic_backup_domain_pre_clarification;
  end if;
  if to_regprocedure('public.verify_clinic_restore_trace_pre_clarification(uuid)') is null then
    alter function public.verify_clinic_restore_trace(uuid) rename to verify_clinic_restore_trace_pre_clarification;
  end if;
end $$;
revoke all on function public.export_clinic_backup_domain_pre_clarification(uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.verify_clinic_restore_trace_pre_clarification(uuid) from public,anon,authenticated,service_role;

create or replace function public.export_clinic_backup_domain(p_clinic_id uuid,p_domain text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_base jsonb; v_extra jsonb; v_data jsonb; v_tables jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  v_base:=public.export_clinic_backup_domain_pre_clarification(p_clinic_id,p_domain);
  v_extra:=cnyos_clarification_internal.backup_projection(p_clinic_id);
  if p_domain='transactions' then
    v_data:=(v_base->'data')||(v_extra->'data');
    select jsonb_agg(k order by k) into v_tables from jsonb_object_keys(v_data) keys(k);
    v_base:=v_base||jsonb_build_object('data',v_data,'included_tables',v_tables,
      'table_sha256',coalesce(v_base->'table_sha256','{}'::jsonb)||(v_extra->'table_sha256'));
  end if;
  return v_base||jsonb_build_object('schema_version','2026-09-26.2');
end $$;
revoke all on function public.export_clinic_backup_domain(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.export_clinic_backup_domain(uuid,text) to service_role;

create or replace function public.verify_clinic_restore_trace(p_clinic_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_base jsonb; v_extra jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  v_base:=public.verify_clinic_restore_trace_pre_clarification(p_clinic_id);
  v_extra:=cnyos_clarification_internal.backup_projection(p_clinic_id);
  return v_base||jsonb_build_object('schema_version','2026-09-26.2',
    'counts',(v_base->'counts')||(v_extra->'counts'),
    'table_sha256',coalesce(v_base->'table_sha256','{}'::jsonb)||(v_extra->'table_sha256'));
end $$;
revoke all on function public.verify_clinic_restore_trace(uuid) from public,anon,authenticated,service_role;
grant execute on function public.verify_clinic_restore_trace(uuid) to service_role;

create or replace function public.backup_restore_contract_healthcheck()
returns table(ready boolean,schema_version text,domain_count integer,patient_table_count integer,product_table_count integer,pharmacy_table_count integer,transaction_table_count integer,managed_database_restore_required boolean)
language sql stable security definer set search_path='' as $$
  select true,'2026-09-26.2',4,31,16,7,19,true where auth.role()='service_role' or public.is_super_admin();
$$;
revoke all on function public.backup_restore_contract_healthcheck() from public,anon,authenticated,service_role;
grant execute on function public.backup_restore_contract_healthcheck() to authenticated,service_role;

-- Component: prescription_replacement_candidate.sql
create table if not exists cnyos_clarification_internal.replacements (
  request_id uuid primary key,
  clinic_id uuid not null references public.clinics(id),
  ticket_id uuid not null unique references cnyos_clarification_internal.tickets(id),
  old_order_id uuid not null unique references public.dispensing_orders(id),
  old_rx_id uuid not null unique references public.prescriptions(id),
  new_order_id uuid not null unique references public.dispensing_orders(id),
  new_rx_id uuid not null unique references public.prescriptions(id),
  actor_id uuid not null references auth.users(id),
  request_payload jsonb not null,
  old_snapshot jsonb not null,
  new_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  acknowledged_by uuid references auth.users(id),
  acknowledged_at timestamptz,
  check(old_rx_id<>new_rx_id and old_order_id<>new_order_id),
  check((acknowledged_by is null)=(acknowledged_at is null)),
  check(acknowledged_by is null or acknowledged_by<>actor_id)
);
alter table cnyos_clarification_internal.replacements enable row level security;
revoke all on cnyos_clarification_internal.replacements from public,anon,authenticated,service_role;

create or replace function cnyos_clarification_internal.guard_replacement_receipt()
returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' then raise exception 'REPLACEMENT_RECEIPT_IMMUTABLE'; end if;
  if (to_jsonb(new)-array['acknowledged_by','acknowledged_at']) is distinct from
     (to_jsonb(old)-array['acknowledged_by','acknowledged_at'])
     or (old.acknowledged_by is not null and to_jsonb(new) is distinct from to_jsonb(old)) then
    raise exception 'REPLACEMENT_RECEIPT_IMMUTABLE';
  end if;
  return new;
end $$;
drop trigger if exists replacement_receipt_immutable on cnyos_clarification_internal.replacements;
create trigger replacement_receipt_immutable before update or delete on cnyos_clarification_internal.replacements
  for each row execute function cnyos_clarification_internal.guard_replacement_receipt();

create or replace function public.manage_prescription_replacement(
  p_request_id uuid,p_ticket_id uuid,p_action text,
  p_reason text default null,p_notes text default null,p_items jsonb default '[]'::jsonb
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
  v_clinic uuid:=public.current_clinic_id(); v_actor uuid:=auth.uid();
  v_ticket cnyos_clarification_internal.tickets%rowtype;
  v_receipt cnyos_clarification_internal.replacements%rowtype;
  v_rx public.prescriptions%rowtype; v_order public.dispensing_orders%rowtype;
  v_new record; v_payload jsonb; v_pharmacy boolean; v_prescriber boolean;
begin
  if v_actor is null or v_clinic is null or not exists(select 1 from public.clinic_memberships
    where clinic_id=v_clinic and profile_id=v_actor and active) then raise exception 'REPLACEMENT_ACCESS_DENIED'; end if;
  perform public.assert_clinic_subscription_active(v_clinic);
  if p_request_id is null or p_ticket_id is null or p_action is null or p_action not in ('replace','read','acknowledge') then
    raise exception 'REPLACEMENT_REQUEST_INVALID'; end if;
  perform e.id from public.encounters e join public.prescriptions rx on rx.encounter_id=e.id
    join public.dispensing_orders d on d.prescription_id=rx.id
    join cnyos_clarification_internal.tickets t on t.order_id=d.id
    where t.id=p_ticket_id and t.clinic_id=v_clinic and e.clinic_id=v_clinic for update of e;
  if not found then raise exception 'REPLACEMENT_TICKET_NOT_FOUND'; end if;
  select * into v_ticket from cnyos_clarification_internal.tickets where id=p_ticket_id;
  select * into v_order from public.dispensing_orders where id=v_ticket.order_id for update;
  select * into v_rx from public.prescriptions where id=v_order.prescription_id for update;
  perform id from public.prescription_items where prescription_id=v_rx.id order by id for update;
  select * into v_ticket from cnyos_clarification_internal.tickets where id=p_ticket_id for update;
  v_pharmacy:=coalesce(public.department_can('pharmacy'),false);
  v_prescriber:=v_rx.prescriber_id=v_actor and exists(select 1 from public.clinic_memberships
    where clinic_id=v_clinic and profile_id=v_actor and active and clinic_role in ('doctor','practitioner'));
  if not (v_pharmacy or coalesce(v_prescriber,false)) then raise exception 'REPLACEMENT_ACCESS_DENIED'; end if;
  select * into v_receipt from cnyos_clarification_internal.replacements where request_id=p_request_id and clinic_id=v_clinic for update;
  if v_receipt.request_id is not null and v_receipt.ticket_id<>p_ticket_id then raise exception 'REPLACEMENT_REQUEST_CONFLICT'; end if;
  if p_action='read' then
    if v_receipt.request_id is null then raise exception 'REPLACEMENT_NOT_FOUND'; end if;
    return to_jsonb(v_receipt);
  end if;
  if p_action='acknowledge' then
    if not v_pharmacy or v_receipt.actor_id=v_actor then raise exception 'REPLACEMENT_PHARMACY_REQUIRED'; end if;
    if v_receipt.request_id is null then raise exception 'REPLACEMENT_NOT_FOUND'; end if;
    if v_receipt.acknowledged_by is not null then
      if v_receipt.acknowledged_by<>v_actor then raise exception 'REPLACEMENT_ACK_CONFLICT'; end if;
      return to_jsonb(v_receipt);
    end if;
    perform id from public.dispensing_orders where id=v_receipt.new_order_id and status in ('waiting','pending') for update;
    if not found then raise exception 'REPLACEMENT_CORRECTION_REQUIRED'; end if;
    perform id from public.prescriptions where id=v_receipt.new_rx_id and status not in ('cancelled','void') for update;
    if not found then raise exception 'REPLACEMENT_CORRECTION_REQUIRED'; end if;
    perform id from public.prescription_items where prescription_id=v_receipt.new_rx_id order by id for update;
    if exists(select 1 from public.dispensing_items where dispensing_order_id=v_receipt.new_order_id)
      or exists(select 1 from public.invoices where encounter_id=v_rx.encounter_id and status not in ('void','cancelled')) then
      raise exception 'REPLACEMENT_CORRECTION_REQUIRED'; end if;
    if v_receipt.new_snapshot is distinct from cnyos_clarification_internal.snapshot(v_receipt.new_rx_id) then raise exception 'REPLACEMENT_REVISION_CHANGED'; end if;
    update cnyos_clarification_internal.replacements set acknowledged_by=v_actor,acknowledged_at=now()
      where request_id=p_request_id returning * into v_receipt;
  else
    if not coalesce(v_prescriber,false) then raise exception 'REPLACEMENT_PRESCRIBER_REQUIRED'; end if;
    if p_reason is null or length(btrim(p_reason)) not between 3 and 2000 then raise exception 'REPLACEMENT_REASON_REQUIRED'; end if;
    v_payload:=jsonb_build_object('ticket',p_ticket_id,'reason',btrim(p_reason),'notes',p_notes,'items',p_items);
    if v_receipt.request_id is not null then
      if v_receipt.actor_id<>v_actor or v_receipt.request_payload is distinct from v_payload then raise exception 'REPLACEMENT_REQUEST_CONFLICT'; end if;
      return to_jsonb(v_receipt);
    end if;
    if exists(select 1 from cnyos_clarification_internal.replacements where old_order_id=v_order.id)
      or exists(select 1 from public.prescriptions where request_key=p_request_id) then raise exception 'REPLACEMENT_REQUEST_CONFLICT'; end if;
    if v_ticket.status not in ('open','answered') or v_rx.status in ('cancelled','void')
      or v_order.status not in ('waiting','pending','reviewed')
      or exists(select 1 from public.dispensing_items where dispensing_order_id=v_order.id)
      or exists(select 1 from public.invoices where encounter_id=v_rx.encounter_id and status not in ('void','cancelled')) then
      raise exception 'REPLACEMENT_CORRECTION_REQUIRED'; end if;
    if v_ticket.snapshot is distinct from cnyos_clarification_internal.snapshot(v_rx.id) then raise exception 'REPLACEMENT_REVISION_CHANGED'; end if;
    select * into v_new from public.create_atomic_prescription_handoff(p_request_id,v_rx.encounter_id,p_notes,p_items);
    insert into cnyos_clarification_internal.replacements(request_id,clinic_id,ticket_id,old_order_id,old_rx_id,
      new_order_id,new_rx_id,actor_id,request_payload,old_snapshot,new_snapshot)
    values(p_request_id,v_clinic,p_ticket_id,v_order.id,v_rx.id,v_new.dispensing_order_id,v_new.prescription_id,
      v_actor,v_payload,v_ticket.snapshot,cnyos_clarification_internal.snapshot(v_new.prescription_id)) returning * into v_receipt;
    update public.prescriptions set status='cancelled',updated_at=now() where id=v_rx.id;
    update public.dispensing_orders set status='cancelled',updated_at=now() where id=v_order.id;
  end if;
  insert into public.audit_logs(clinic_id,user_id,action,entity,entity_id,metadata)
    values(v_clinic,v_actor,'prescription_replacement_'||p_action,'prescription_replacements',p_request_id::text,
      jsonb_build_object('old_order_id',v_receipt.old_order_id,'new_order_id',v_receipt.new_order_id));
  return to_jsonb(v_receipt);
end $$;

create or replace function public.read_prescription_replacements(p_order_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_rows jsonb;
begin
  perform public.manage_prescription_clarification(p_order_id,null,'history',null);
  select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at,r.request_id),'[]'::jsonb)
    into v_rows from cnyos_clarification_internal.replacements r
    where r.clinic_id=public.current_clinic_id()
      and (r.old_order_id=p_order_id or r.new_order_id=p_order_id);
  return jsonb_build_object('order_id',p_order_id,'replacements',v_rows);
end $$;
revoke all on function public.read_prescription_replacements(uuid) from public,anon,authenticated,service_role;
grant execute on function public.read_prescription_replacements(uuid) to authenticated;

create or replace function cnyos_clarification_internal.check_replacement_clearance(p_order uuid,p_rx uuid)
returns void language plpgsql stable security definer set search_path='' as $$
declare v_receipt cnyos_clarification_internal.replacements%rowtype;
begin
  if exists(select 1 from cnyos_clarification_internal.replacements where old_order_id=p_order) then raise exception 'PRESCRIPTION_SUPERSEDED'; end if;
  select * into v_receipt from cnyos_clarification_internal.replacements where new_order_id=p_order;
  if not found then return; end if;
  if v_receipt.acknowledged_by is null then raise exception 'PRESCRIPTION_REPLACEMENT_ACK_REQUIRED'; end if;
  if v_receipt.new_rx_id<>p_rx or v_receipt.new_snapshot is distinct from cnyos_clarification_internal.snapshot(p_rx) then
    raise exception 'PRESCRIPTION_REPLACEMENT_REVISION_CHANGED'; end if;
end $$;

do $bind$
declare v_def text;
begin
  v_def:=pg_get_functiondef('public.transition_atomic_prescription_dispensing(uuid,text,jsonb,text)'::regprocedure);
  if position('check_replacement_clearance' in v_def)=0 then
    if position('  if v_action = ''review'' then' in v_def)=0 then raise exception 'REPLACEMENT_DISPENSING_ANCHOR_MISSING'; end if;
    execute replace(v_def,'  if v_action = ''review'' then',
      E'  perform cnyos_clarification_internal.check_replacement_clearance(v_order.id,v_prescription.id);\n  if v_action = ''review'' then');
  end if;
  v_def:=pg_get_functiondef('cnyos_clarification_internal.clearance_evidence(uuid,uuid)'::regprocedure);
  if position('check_replacement_clearance' in v_def)=0 then
    if position(E'begin\n' in v_def)=0 then raise exception 'REPLACEMENT_BINDING_ANCHOR_MISSING'; end if;
    execute replace(v_def,E'begin\n',E'begin\n  perform cnyos_clarification_internal.check_replacement_clearance(p_order,p_rx);\n');
  end if;
  v_def:=pg_get_functiondef('cnyos_clarification_internal.backup_projection(uuid)'::regprocedure);
  if position('BACKUP_REPLACEMENT_CONTRACT_REQUIRED' in v_def)=0 and position('replacement_backup_rows' in v_def)=0 then
    if position(E'begin\n' in v_def)=0 then raise exception 'REPLACEMENT_BACKUP_BINDING_ANCHOR_MISSING'; end if;
    execute replace(v_def,E'begin\n',E'begin\n  if exists(select 1 from cnyos_clarification_internal.replacements where clinic_id=p_clinic) then raise exception ''BACKUP_REPLACEMENT_CONTRACT_REQUIRED''; end if;\n');
  end if;
end $bind$;
revoke all on function cnyos_clarification_internal.guard_replacement_receipt(),cnyos_clarification_internal.check_replacement_clearance(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.manage_prescription_replacement(uuid,uuid,text,text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.manage_prescription_replacement(uuid,uuid,text,text,text,jsonb) to authenticated;

-- Component: prescription_replacement_backup_candidate.sql
create or replace function cnyos_clarification_internal.replacement_backup_rows(p_clinic uuid)
returns jsonb language plpgsql stable security definer set search_path=''
set timezone='UTC' set datestyle='ISO, YMD' as $$
begin
  if p_clinic is null then raise exception 'CLINIC_ID_REQUIRED'; end if;
  if exists(
    select 1 from cnyos_clarification_internal.replacements r
    join public.prescriptions old_rx on old_rx.id=r.old_rx_id
    join public.prescriptions new_rx on new_rx.id=r.new_rx_id
    join public.encounters old_e on old_e.id=old_rx.encounter_id
    join public.encounters new_e on new_e.id=new_rx.encounter_id
    join public.dispensing_orders old_d on old_d.id=r.old_order_id
    join public.dispensing_orders new_d on new_d.id=r.new_order_id
    join cnyos_clarification_internal.tickets t on t.id=r.ticket_id
    where (r.clinic_id=p_clinic or old_e.clinic_id=p_clinic or new_e.clinic_id=p_clinic or t.clinic_id=p_clinic)
      and (r.clinic_id is distinct from old_e.clinic_id or r.clinic_id is distinct from new_e.clinic_id
        or t.clinic_id is distinct from r.clinic_id or t.order_id<>r.old_order_id
        or old_d.prescription_id<>r.old_rx_id or new_d.prescription_id<>r.new_rx_id
        or old_rx.encounter_id<>new_rx.encounter_id or old_rx.patient_id<>new_rx.patient_id
        or old_rx.patient_id<>old_e.patient_id or new_rx.patient_id<>new_e.patient_id
        or old_rx.prescriber_id is distinct from r.actor_id or new_rx.prescriber_id is distinct from r.actor_id
        or old_rx.status<>'cancelled' or old_d.status<>'cancelled'
        or r.old_snapshot is distinct from cnyos_clarification_internal.snapshot(r.old_rx_id)
        or r.new_snapshot is distinct from cnyos_clarification_internal.snapshot(r.new_rx_id)
        or r.request_payload->>'ticket' is distinct from r.ticket_id::text)
  ) then raise exception 'BACKUP_REPLACEMENT_INTEGRITY_ANOMALY'; end if;
  return coalesce((select jsonb_agg(to_jsonb(r) order by r.request_id)
    from cnyos_clarification_internal.replacements r where r.clinic_id=p_clinic),'[]'::jsonb);
end $$;
revoke all on function cnyos_clarification_internal.replacement_backup_rows(uuid) from public,anon,authenticated,service_role;

do $extend$
declare
  v_def text; v_name text;
  v_guard text:=E'  if exists(select 1 from cnyos_clarification_internal.replacements where clinic_id=p_clinic) then raise exception ''BACKUP_REPLACEMENT_CONTRACT_REQUIRED''; end if;\n';
  v_anchor text:='  select jsonb_object_agg(k,jsonb_array_length(v_data->k)),';
begin
  v_def:=pg_get_functiondef('cnyos_clarification_internal.backup_projection(uuid)'::regprocedure);
  if position('replacement_backup_rows' in v_def)=0 then
    if position(v_guard in v_def)=0 or position(v_anchor in v_def)=0 then raise exception 'REPLACEMENT_BACKUP_ANCHOR_MISSING'; end if;
    v_def:=replace(v_def,v_guard,'');
    v_def:=replace(v_def,v_anchor,
      E'  v_data:=v_data||jsonb_build_object(''cnyos_clarification_internal.replacements'',cnyos_clarification_internal.replacement_backup_rows(p_clinic));\n'||v_anchor);
    execute v_def;
  end if;
  foreach v_name in array array['public.export_clinic_backup_domain(uuid,text)',
    'public.verify_clinic_restore_trace(uuid)','public.backup_restore_contract_healthcheck()'] loop
    v_def:=pg_get_functiondef(v_name::regprocedure);
    if position('2026-09-27.1' in v_def)=0 then
      if position('2026-09-26.2' in v_def)=0 then raise exception 'REPLACEMENT_BACKUP_VERSION_MISMATCH'; end if;
      v_def:=replace(v_def,'2026-09-26.2','2026-09-27.1');
      if v_name='public.backup_restore_contract_healthcheck()' then
        if position('4,31,16,7,19,true' in v_def)=0 then raise exception 'REPLACEMENT_BACKUP_HEALTH_MISMATCH'; end if;
        v_def:=replace(v_def,'4,31,16,7,19,true','4,31,16,7,20,true');
      end if;
      execute v_def;
    end if;
  end loop;
end $extend$;

commit;
