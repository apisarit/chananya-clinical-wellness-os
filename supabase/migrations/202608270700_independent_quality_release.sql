begin;

-- ============================================================
-- INDEPENDENT QUALITY RELEASE
--
-- Production records the batch and actual yield. A separate Quality account
-- alone may release or reject it. The producer can never approve their own
-- batch, including when the same person later receives elevated UI access.
-- ============================================================

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check
  check (role in (
    'admin','practitioner','doctor','reception','pharmacy','production',
    'inventory','quality','billing','viewer'
  ));

alter table public.clinic_memberships
  drop constraint if exists clinic_memberships_clinic_role_check;
alter table public.clinic_memberships
  add constraint clinic_memberships_clinic_role_check
  check (clinic_role in (
    'owner','admin','practitioner','doctor','reception','pharmacy',
    'billing','inventory','production','quality','viewer'
  ));

create or replace function public.department_can(p_capability text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when auth.uid() is null then false
    when public.is_super_admin() then true
    when p_capability = 'governance' then
      exists (
        select 1 from public.profiles p
        where p.id = auth.uid() and p.system_role = 'admin'
      ) or public.current_department_role() in ('owner','admin')
    when p_capability = 'patient_read' then
      public.current_department_role() in ('practitioner','doctor','reception','pharmacy','billing')
    when p_capability = 'patient_registry' then
      public.current_department_role() in ('practitioner','doctor','reception')
    when p_capability = 'clinical' then
      public.current_department_role() in ('practitioner','doctor')
    when p_capability = 'pharmacy' then
      public.current_department_role() = 'pharmacy'
    when p_capability = 'product_read' then
      public.current_department_role() in ('practitioner','doctor','pharmacy','production','inventory','quality')
    when p_capability = 'product_write' then
      public.current_department_role() in ('pharmacy','production','inventory')
    when p_capability = 'inventory' then
      public.current_department_role() in ('pharmacy','production','inventory')
    when p_capability = 'production_read' then
      public.current_department_role() in ('production','inventory','quality')
    when p_capability = 'production' then
      public.current_department_role() in ('production','inventory')
    when p_capability = 'quality' then
      public.current_department_role() = 'quality'
    when p_capability = 'billing' then
      public.current_department_role() = 'billing'
    else false
  end;
$$;

-- The existing tenant-assignment triggers still run inside trusted RPCs and
-- evaluate the end user's department. Independent Quality therefore needs a
-- narrowly-scoped trigger path to receive the released lot and its matching
-- stock movement. This does not grant table writes or the general inventory
-- capability; direct authenticated mutations remain revoked and RLS-protected.
create or replace function public.assign_inventory_lot_clinic()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid;
begin
  select p.clinic_id into v_clinic_id
  from public.products p where p.id = new.product_id;
  if v_clinic_id is null then raise exception 'PRODUCT_NOT_FOUND'; end if;
  if auth.role() <> 'service_role' then
    if not (
      public.department_can('inventory') or public.department_can('quality')
    ) then
      raise exception 'INVENTORY_DEPARTMENT_REQUIRED';
    end if;
    if v_clinic_id <> public.current_clinic_id() then
      raise exception 'INVENTORY_TENANT_MISMATCH';
    end if;
  end if;
  if new.clinic_id is not null and new.clinic_id <> v_clinic_id then
    raise exception 'INVENTORY_TENANT_MISMATCH';
  end if;
  new.clinic_id := v_clinic_id;
  return new;
end;
$$;

create or replace function public.assign_stock_movement_clinic()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid;
begin
  select l.clinic_id into v_clinic_id
  from public.inventory_lots l where l.id = new.inventory_lot_id;
  if v_clinic_id is null then raise exception 'INVENTORY_LOT_NOT_FOUND'; end if;
  if auth.role() <> 'service_role' then
    if not (
      public.department_can('inventory') or public.department_can('quality')
    ) then
      raise exception 'INVENTORY_DEPARTMENT_REQUIRED';
    end if;
    if v_clinic_id <> public.current_clinic_id() then
      raise exception 'INVENTORY_TENANT_MISMATCH';
    end if;
  end if;
  if new.clinic_id is not null and new.clinic_id <> v_clinic_id then
    raise exception 'INVENTORY_TENANT_MISMATCH';
  end if;
  new.clinic_id := v_clinic_id;
  return new;
end;
$$;

create or replace function public.admin_assign_staff_role(
  p_user_id uuid,
  p_role text,
  p_reason text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_old_role text;
  v_old_system_role text;
  v_old_clinic_role text;
begin
  if v_clinic_id is null or not public.department_can('governance') then
    raise exception 'GOVERNANCE_DEPARTMENT_REQUIRED';
  end if;
  if p_role not in (
    'practitioner','doctor','reception','pharmacy','production',
    'inventory','quality','billing','viewer'
  ) then
    raise exception 'STAFF_DEPARTMENT_ROLE_INVALID';
  end if;
  select p.role, p.system_role into v_old_role, v_old_system_role
  from public.profiles p where p.id = p_user_id for update;
  if not found then raise exception 'USER_PROFILE_NOT_FOUND'; end if;
  if v_old_system_role = 'super_admin' then
    raise exception 'SUPER_ADMIN_ROLE_PROTECTED';
  end if;
  if v_old_system_role = 'admin' and not public.is_super_admin() then
    raise exception 'SYSTEM_ADMIN_ROLE_PROTECTED';
  end if;
  if p_user_id = auth.uid() and not public.is_super_admin() then
    raise exception 'SELF_ROLE_CHANGE_NOT_ALLOWED';
  end if;

  select m.clinic_role into v_old_clinic_role
  from public.clinic_memberships m
  where m.clinic_id = v_clinic_id and m.profile_id = p_user_id
  for update;

  insert into public.clinic_memberships (
    clinic_id, profile_id, clinic_role, is_primary, active, updated_at
  ) values (
    v_clinic_id, p_user_id, p_role,
    not exists (
      select 1 from public.clinic_memberships x
      where x.profile_id = p_user_id and x.active and x.is_primary
    ),
    true, now()
  )
  on conflict (clinic_id, profile_id) do update
  set clinic_role = excluded.clinic_role,
      active = true,
      updated_at = now();

  update public.profiles
  set role = p_role,
      system_role = case when v_old_system_role = 'admin' then 'staff' else system_role end,
      updated_at = now()
  where id = p_user_id;

  insert into public.audit_logs (
    clinic_id, user_id, action, entity, entity_id, metadata
  ) values (
    v_clinic_id, auth.uid(), 'assign_department_role',
    'clinic_memberships', p_user_id::text,
    jsonb_build_object(
      'old_profile_role', v_old_role,
      'old_clinic_role', v_old_clinic_role,
      'new_clinic_role', p_role,
      'reason', nullif(btrim(p_reason), '')
    )
  );
end;
$$;

-- Quality may inspect only production evidence required for release. It does
-- not receive patient, prescription, dispensing, billing or governance data.
drop policy if exists formulas_department_boundary on public.formulas;
create policy formulas_department_boundary
on public.formulas as restrictive for all to authenticated
using (clinic_id = public.current_clinic_id() and public.department_can('production_read'))
with check (clinic_id = public.current_clinic_id() and public.department_can('production'));

drop policy if exists formula_components_department_boundary on public.formula_components;
create policy formula_components_department_boundary
on public.formula_components as restrictive for all to authenticated
using (clinic_id = public.current_clinic_id() and public.department_can('production_read'))
with check (clinic_id = public.current_clinic_id() and public.department_can('production'));

drop policy if exists production_orders_department_boundary on public.production_orders;
create policy production_orders_department_boundary
on public.production_orders as restrictive for all to authenticated
using (clinic_id = public.current_clinic_id() and public.department_can('production_read'))
with check (clinic_id = public.current_clinic_id() and public.department_can('production'));

drop policy if exists production_issues_department_boundary on public.production_material_issues;
create policy production_issues_department_boundary
on public.production_material_issues as restrictive for all to authenticated
using (clinic_id = public.current_clinic_id() and public.department_can('production_read'))
with check (clinic_id = public.current_clinic_id() and public.department_can('production'));

drop policy if exists production_qc_department_boundary on public.production_qc;
create policy production_qc_department_boundary
on public.production_qc as restrictive for all to authenticated
using (clinic_id = public.current_clinic_id() and public.department_can('production_read'))
with check (clinic_id = public.current_clinic_id() and public.department_can('quality'));

drop policy if exists finished_receipts_department_boundary on public.finished_goods_receipts;
create policy finished_receipts_department_boundary
on public.finished_goods_receipts as restrictive for all to authenticated
using (clinic_id = public.current_clinic_id() and public.department_can('production_read'))
with check (clinic_id = public.current_clinic_id() and public.department_can('quality'));

-- The old combined RPCs are retained for migration compatibility and service
-- recovery only. Browser users cannot execute them after this migration.
revoke execute on function public.release_production_order(uuid,text,text,text,numeric,numeric,numeric) from authenticated;
revoke execute on function public.reject_production_order(uuid,text,text) from authenticated;

create or replace function public.quality_release_production_order(
  p_production_order_id uuid,
  p_result_summary text,
  p_sample_reference text default null,
  p_appearance_result text default null,
  p_moisture_result numeric default null,
  p_water_activity_result numeric default null,
  p_weight_result numeric default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_order public.production_orders%rowtype;
  v_formula public.formulas%rowtype;
  v_request public.production_requests%rowtype;
  v_qc public.production_qc%rowtype;
  v_lot public.inventory_lots%rowtype;
  v_receipt public.finished_goods_receipts%rowtype;
  v_expiry date;
begin
  if v_clinic_id is null or not public.department_can('quality') then
    raise exception 'QUALITY_DEPARTMENT_REQUIRED';
  end if;
  if length(btrim(coalesce(p_result_summary, ''))) < 3 then
    raise exception 'QC_RESULT_SUMMARY_REQUIRED';
  end if;
  if coalesce(p_moisture_result, 0) < 0
     or coalesce(p_water_activity_result, 0) < 0
     or coalesce(p_weight_result, 0) < 0 then
    raise exception 'QC_RESULT_VALUE_INVALID';
  end if;

  select * into v_order from public.production_orders o
  where o.id = p_production_order_id and o.clinic_id = v_clinic_id
  for update;
  if not found then raise exception 'PRODUCTION_ORDER_NOT_FOUND'; end if;
  if v_order.status = 'released' then
    select * into v_receipt from public.finished_goods_receipts r
    where r.production_order_id = v_order.id and r.clinic_id = v_clinic_id;
    return jsonb_build_object(
      'production_order_id',v_order.id,
      'status',v_order.status,
      'inventory_lot_id',v_receipt.inventory_lot_id,
      'received_quantity',v_receipt.received_quantity
    );
  end if;
  if v_order.produced_by is null then
    raise exception 'PRODUCTION_OPERATOR_EVIDENCE_REQUIRED';
  end if;
  if v_order.produced_by = auth.uid() then
    raise exception 'QC_INDEPENDENCE_REQUIRED';
  end if;
  if v_order.status <> 'awaiting_qc' or coalesce(v_order.actual_quantity, 0) <= 0 then
    raise exception 'PRODUCTION_ORDER_NOT_AWAITING_QC';
  end if;
  select * into v_formula from public.formulas f
  where f.id = v_order.formula_id and f.clinic_id = v_clinic_id;
  if not found then raise exception 'FORMULA_NOT_FOUND'; end if;

  insert into public.production_qc(
    clinic_id, production_order_id, sample_reference, appearance_result,
    moisture_result, water_activity_result, weight_result, result_summary,
    status, tested_by, tested_at, approved_by, approved_at, rejection_reason
  ) values (
    v_clinic_id, v_order.id, nullif(btrim(p_sample_reference), ''),
    nullif(btrim(p_appearance_result), ''), p_moisture_result,
    p_water_activity_result, p_weight_result, btrim(p_result_summary),
    'passed', auth.uid(), now(), auth.uid(), now(), null
  )
  on conflict (production_order_id) do update set
    clinic_id = excluded.clinic_id,
    sample_reference = excluded.sample_reference,
    appearance_result = excluded.appearance_result,
    moisture_result = excluded.moisture_result,
    water_activity_result = excluded.water_activity_result,
    weight_result = excluded.weight_result,
    result_summary = excluded.result_summary,
    status = 'passed',
    tested_by = excluded.tested_by,
    tested_at = excluded.tested_at,
    approved_by = excluded.approved_by,
    approved_at = excluded.approved_at,
    rejection_reason = null,
    updated_at = now()
  returning * into v_qc;

  v_expiry := case
    when coalesce(v_formula.shelf_life_days, 0) > 0
      then current_date + v_formula.shelf_life_days
    else null
  end;
  insert into public.inventory_lots(
    clinic_id, product_id, lot_number, manufacture_date, expiry_date,
    received_quantity, current_quantity, unit, purchase_cost,
    storage_location, status, created_by
  ) values (
    v_clinic_id, v_order.finished_product_id, v_order.batch_number,
    current_date, v_expiry, v_order.actual_quantity, 0,
    v_order.planned_unit, 0, 'Finished Goods', 'active', auth.uid()
  ) returning * into v_lot;

  insert into public.finished_goods_receipts(
    clinic_id, production_order_id, inventory_lot_id,
    received_quantity, unit, received_by
  ) values (
    v_clinic_id, v_order.id, v_lot.id,
    v_order.actual_quantity, v_order.planned_unit, auth.uid()
  ) returning * into v_receipt;

  insert into public.stock_movements(
    clinic_id, inventory_lot_id, movement_type, quantity, direction,
    reference_type, reference_id, reason, performed_by
  ) values (
    v_clinic_id, v_lot.id, 'production_receipt', v_order.actual_quantity,
    'in', 'production_receipt', v_receipt.id,
    'Independent Quality release ' || v_order.production_order_no, auth.uid()
  );

  update public.production_orders
  set status = 'released', updated_at = now()
  where id = v_order.id
  returning * into v_order;

  if v_order.production_request_id is not null then
    select * into v_request from public.production_requests r
    where r.id = v_order.production_request_id and r.clinic_id = v_clinic_id
    for update;
    if found then
      update public.production_requests
      set status = 'fulfilled', updated_at = now()
      where id = v_request.id;
      if v_request.dispensing_order_id is not null then
        update public.dispensing_orders
        set status = 'waiting', updated_at = now()
        where id = v_request.dispensing_order_id and status = 'out_of_stock';
      end if;
    end if;
  end if;

  insert into public.audit_logs(clinic_id,user_id,action,entity,entity_id,metadata)
  values (
    v_clinic_id, auth.uid(), 'quality_release_production_order',
    'production_orders', v_order.id::text,
    jsonb_build_object(
      'production_order_no',v_order.production_order_no,
      'batch_number',v_order.batch_number,
      'produced_by',v_order.produced_by,
      'quality_released_by',auth.uid(),
      'qc_id',v_qc.id,
      'inventory_lot_id',v_lot.id,
      'receipt_id',v_receipt.id,
      'received_quantity',v_receipt.received_quantity,
      'expiry_date',v_expiry,
      'separation_of_duties',true
    )
  );
  return jsonb_build_object(
    'production_order_id',v_order.id,
    'status',v_order.status,
    'qc_id',v_qc.id,
    'inventory_lot_id',v_lot.id,
    'received_quantity',v_receipt.received_quantity,
    'expiry_date',v_expiry
  );
end;
$$;

create or replace function public.quality_reject_production_order(
  p_production_order_id uuid,
  p_rejection_reason text,
  p_result_summary text default 'ไม่ผ่านข้อกำหนด'
)
returns public.production_orders
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_order public.production_orders%rowtype;
begin
  if v_clinic_id is null or not public.department_can('quality') then
    raise exception 'QUALITY_DEPARTMENT_REQUIRED';
  end if;
  if length(btrim(coalesce(p_rejection_reason, ''))) < 5 then
    raise exception 'QC_REJECTION_REASON_REQUIRED';
  end if;
  select * into v_order from public.production_orders o
  where o.id = p_production_order_id and o.clinic_id = v_clinic_id
  for update;
  if not found then raise exception 'PRODUCTION_ORDER_NOT_FOUND'; end if;
  if v_order.status = 'rejected' then return v_order; end if;
  if v_order.produced_by is null then
    raise exception 'PRODUCTION_OPERATOR_EVIDENCE_REQUIRED';
  end if;
  if v_order.produced_by = auth.uid() then
    raise exception 'QC_INDEPENDENCE_REQUIRED';
  end if;
  if v_order.status <> 'awaiting_qc' then
    raise exception 'PRODUCTION_ORDER_NOT_AWAITING_QC';
  end if;

  insert into public.production_qc(
    clinic_id, production_order_id, result_summary, status,
    tested_by, tested_at, rejection_reason
  ) values (
    v_clinic_id, v_order.id,
    coalesce(nullif(btrim(p_result_summary), ''), 'ไม่ผ่านข้อกำหนด'),
    'rejected', auth.uid(), now(), btrim(p_rejection_reason)
  )
  on conflict (production_order_id) do update set
    clinic_id = excluded.clinic_id,
    result_summary = excluded.result_summary,
    status = 'rejected',
    tested_by = excluded.tested_by,
    tested_at = excluded.tested_at,
    approved_by = null,
    approved_at = null,
    rejection_reason = excluded.rejection_reason,
    updated_at = now();

  update public.production_orders
  set status = 'rejected', updated_at = now()
  where id = v_order.id
  returning * into v_order;
  if v_order.production_request_id is not null then
    update public.production_requests
    set status = 'rejected', updated_at = now()
    where id = v_order.production_request_id and clinic_id = v_clinic_id;
  end if;

  insert into public.audit_logs(clinic_id,user_id,action,entity,entity_id,metadata)
  values (
    v_clinic_id, auth.uid(), 'quality_reject_production_order',
    'production_orders', v_order.id::text,
    jsonb_build_object(
      'production_order_no',v_order.production_order_no,
      'batch_number',v_order.batch_number,
      'produced_by',v_order.produced_by,
      'quality_rejected_by',auth.uid(),
      'reason',btrim(p_rejection_reason),
      'separation_of_duties',true
    )
  );
  return v_order;
end;
$$;

create or replace function public.quality_release_healthcheck()
returns table(ready boolean, schema_version text)
language sql
stable
security definer
set search_path = public
as $$
  select
    to_regprocedure('public.quality_release_production_order(uuid,text,text,text,numeric,numeric,numeric)') is not null
    and to_regprocedure('public.quality_reject_production_order(uuid,text,text)') is not null,
    '2026-08-27.3'::text;
$$;

revoke all on function public.department_can(text) from public;
revoke all on function public.admin_assign_staff_role(uuid,text,text) from public;
revoke all on function public.quality_release_production_order(uuid,text,text,text,numeric,numeric,numeric) from public;
revoke all on function public.quality_reject_production_order(uuid,text,text) from public;
revoke all on function public.quality_release_healthcheck() from public;
grant execute on function public.department_can(text) to authenticated, service_role;
grant execute on function public.admin_assign_staff_role(uuid,text,text) to authenticated;
grant execute on function public.quality_release_production_order(uuid,text,text,text,numeric,numeric,numeric) to authenticated, service_role;
grant execute on function public.quality_reject_production_order(uuid,text,text) to authenticated, service_role;
grant execute on function public.quality_release_healthcheck() to authenticated, service_role;

commit;

select
  'CLINICAL_OS_INDEPENDENT_QUALITY_RELEASE_READY' as status,
  to_regprocedure('public.quality_release_production_order(uuid,text,text,text,numeric,numeric,numeric)') as release_rpc,
  to_regprocedure('public.quality_reject_production_order(uuid,text,text)') as reject_rpc;
