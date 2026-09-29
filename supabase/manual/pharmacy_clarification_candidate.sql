-- LOCAL CANDIDATE ONLY. Not a migration or production activation.
-- Implements unchanged-order clarification; replacement revisions remain pending.
begin;
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
-- Explicit current acknowledgement; timestamps are not revision ordering.
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
-- Check the locked prescription even on idempotent return paths (no UPDATE,
-- therefore no transition trigger). Do not revive a stale cancelled queue.
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
-- Bind both quote and invoice issuance (which recomputes this helper) to clearance.
-- Refuse an unexpected upstream body rather than silently skipping the guard.
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
commit;
