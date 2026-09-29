-- LOCAL CANDIDATE ONLY. Requires clarification + clarification backup candidates.
-- Populated replacement data blocks structured backup until its versioned
-- projection/restore contract is implemented. Do not activate in production.
begin;
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

-- Discover linkage from either queue without exposing the private table. Reuse
-- the order-history authorization boundary, including empty-history requests.
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
commit;
