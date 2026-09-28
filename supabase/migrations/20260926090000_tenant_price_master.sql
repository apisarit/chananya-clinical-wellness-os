begin;

-- Tenant price master.  Rows from the pre-tenant schema are deliberately
-- quarantined rather than guessed into a clinic.  Only the RPCs below can
-- create or change operational rows.
alter table public.services
  add column if not exists clinic_id uuid,
  add column if not exists unit_code text not null default 'session',
  add column if not exists quarantine_reason text;
alter table public.price_lists
  add column if not exists clinic_id uuid,
  add column if not exists quarantine_reason text,
  add column if not exists version bigint not null default 1;
alter table public.price_list_items
  add column if not exists clinic_id uuid,
  add column if not exists unit_code text,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists version bigint not null default 1,
  add column if not exists quarantine_reason text;

update public.services
   set active = false,
       quarantine_reason = coalesce(quarantine_reason, 'LEGACY_UNASSIGNED_CLINIC')
 where clinic_id is null;
update public.price_lists
   set active = false,
       quarantine_reason = coalesce(quarantine_reason, 'LEGACY_UNASSIGNED_CLINIC')
 where clinic_id is null;
update public.price_list_items i
   set clinic_id = l.clinic_id,
       active = false,
       quarantine_reason = coalesce(i.quarantine_reason, 'LEGACY_UNASSIGNED_CLINIC')
  from public.price_lists l
 where l.id = i.price_list_id
   and (i.clinic_id is null or l.clinic_id is null);

alter table public.services drop constraint if exists services_service_code_key;
drop index if exists public.services_service_code_key;
alter table public.price_lists drop constraint if exists price_lists_code_key;
drop index if exists public.price_lists_code_key;
create unique index if not exists services_clinic_code_uidx
  on public.services(clinic_id, service_code) where clinic_id is not null;
create unique index if not exists price_lists_clinic_code_uidx
  on public.price_lists(clinic_id, code) where clinic_id is not null;
create unique index if not exists price_lists_id_clinic_uidx
  on public.price_lists(id, clinic_id);
create index if not exists price_list_items_clinic_idx
  on public.price_list_items(clinic_id, price_list_id, active);

do $$
begin
  if not exists (select 1 from pg_constraint where conname='services_clinic_id_fkey'
                 and conrelid='public.services'::regclass) then
    alter table public.services add constraint services_clinic_id_fkey
      foreign key (clinic_id) references public.clinics(id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname='price_lists_clinic_id_fkey'
                 and conrelid='public.price_lists'::regclass) then
    alter table public.price_lists add constraint price_lists_clinic_id_fkey
      foreign key (clinic_id) references public.clinics(id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname='price_list_items_list_clinic_fkey'
                 and conrelid='public.price_list_items'::regclass) then
    alter table public.price_list_items add constraint price_list_items_list_clinic_fkey
      foreign key (price_list_id, clinic_id)
      references public.price_lists(id, clinic_id) on delete cascade;
  end if;
end $$;

create table if not exists public.price_master_audit (
  id bigint generated always as identity primary key,
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  price_list_id uuid not null,
  price_list_item_id uuid,
  action text not null check (action in ('setup','insert','update')),
  reason text not null,
  before_state jsonb,
  after_state jsonb not null,
  actor_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);
alter table public.price_master_audit enable row level security;
revoke all on public.price_master_audit from public, anon, authenticated, service_role;
grant select on public.price_master_audit to authenticated;
create policy price_master_audit_read_current_clinic on public.price_master_audit
  for select to authenticated
  using (clinic_id = public.current_clinic_id()
         and public.is_clinic_member(clinic_id, array['owner','admin']));
create policy cnyos_active_subscription_boundary on public.price_master_audit
  as restrictive for all to authenticated
  using (clinic_id=public.current_clinic_id())
  with check (clinic_id=public.current_clinic_id());

create or replace function public.reject_price_master_audit_mutation()
returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $$
begin raise exception 'PRICE_MASTER_AUDIT_APPEND_ONLY'; end;
$$;
revoke all on function public.reject_price_master_audit_mutation() from public,anon,authenticated,service_role;
drop trigger if exists price_master_audit_append_only on public.price_master_audit;
create trigger price_master_audit_append_only
  before update or delete on public.price_master_audit
  for each row execute function public.reject_price_master_audit_mutation();
drop trigger if exists trg_cnyos_authenticated_subscription_statement_write on public.price_master_audit;
create trigger trg_cnyos_authenticated_subscription_statement_write
  before insert or update or delete on public.price_master_audit for each statement
  execute function public.enforce_authenticated_subscription_statement_write();

create or replace function public.price_master_admin(p_clinic uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public as $$
  select auth.uid() is not null
     and public.is_clinic_member(p_clinic, array['owner','admin'])
$$;
revoke all on function public.price_master_admin(uuid) from public, anon, authenticated, service_role;
grant execute on function public.price_master_admin(uuid) to authenticated;

create or replace function public.list_price_master()
returns table (
  price_list_id uuid, price_list_code text, price_list_name text,
  effective_from date, effective_to date, customer_type text,
  price_list_version bigint, item_id uuid, item_type text,
  product_id uuid, service_id uuid, item_description text,
  unit_code text, unit_price numeric, item_version bigint
)
language sql stable security invoker set search_path = pg_catalog, public as $$
  select * from (
  select l.id as price_list_id,l.code as price_list_code,l.name as price_list_name,
         l.effective_from,l.effective_to,l.customer_type,l.version as price_list_version,
         i.id as item_id,i.item_type,i.product_id,i.service_id,
         coalesce(p.name_th,p.sku,s.name_th,s.service_code) as item_description,
         i.unit_code,i.unit_price,i.version as item_version
    from public.price_lists l
    left join public.price_list_items i
      on i.price_list_id=l.id and i.clinic_id=l.clinic_id and i.active
    left join public.products p on p.id=i.product_id and p.clinic_id=l.clinic_id
    left join public.services s on s.id=i.service_id and s.clinic_id=l.clinic_id
   where l.clinic_id=public.current_clinic_id() and l.active
  union all
  select l.id,l.code,l.name,l.effective_from,l.effective_to,l.customer_type,l.version,
         null::uuid,'product',p.id,null::uuid,coalesce(p.name_th,p.sku),p.dispense_unit,null::numeric,null::bigint
    from public.price_lists l join public.products p on p.clinic_id=l.clinic_id and p.active
   where l.clinic_id=public.current_clinic_id() and l.active
     and not exists (select 1 from public.price_list_items i where i.price_list_id=l.id and i.clinic_id=l.clinic_id and i.product_id=p.id and i.active)
  union all
  select l.id,l.code,l.name,l.effective_from,l.effective_to,l.customer_type,l.version,
         null::uuid,'service',null::uuid,s.id,coalesce(s.name_th,s.service_code),s.unit_code,null::numeric,null::bigint
    from public.price_lists l join public.services s on s.clinic_id=l.clinic_id and s.active
   where l.clinic_id=public.current_clinic_id() and l.active
     and not exists (select 1 from public.price_list_items i where i.price_list_id=l.id and i.clinic_id=l.clinic_id and i.service_id=s.id and i.active)
  ) q order by q.effective_from desc,q.price_list_code,q.item_type,q.item_id
$$;
revoke all on function public.list_price_master() from public,anon,authenticated,service_role;
grant execute on function public.list_price_master() to authenticated;

create or replace function public.list_price_master_history(p_item_id uuid)
returns table(audit_id bigint, action text, reason text, before_state jsonb,
              after_state jsonb, actor_id uuid, created_at timestamptz)
language sql stable security invoker set search_path = pg_catalog, public as $$
  select a.id,a.action,a.reason,a.before_state,a.after_state,a.actor_id,a.created_at
    from public.price_master_audit a
   where a.price_list_item_id=p_item_id and a.clinic_id=public.current_clinic_id()
   order by a.created_at desc,a.id desc
$$;
revoke all on function public.list_price_master_history(uuid) from public,anon,authenticated,service_role;
grant execute on function public.list_price_master_history(uuid) to authenticated;

create or replace function public.set_price_master_item(
  p_price_list_id uuid, p_item_type text, p_product_id uuid default null,
  p_service_id uuid default null, p_unit_code text default null,
  p_unit_price numeric default null, p_expected_version bigint default 0,
  p_reason text default null
)
returns table(item_id uuid, item_version bigint, unit_price numeric)
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_clinic uuid := public.current_clinic_id();
  v_list public.price_lists%rowtype;
  v_item public.price_list_items%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_unit text;
begin
  if v_clinic is null then raise exception 'CNYOS_CLINIC_CONTEXT_REQUIRED'; end if;
  perform public.assert_clinic_subscription_active(v_clinic);
  if not public.price_master_admin(v_clinic) then raise exception 'PRICE_MASTER_ADMIN_REQUIRED'; end if;
  if p_reason is null or length(btrim(p_reason)) < 3 or length(p_reason) > 500 then
    raise exception 'PRICE_MASTER_REASON_REQUIRED';
  end if;
  if p_item_type is null or p_item_type not in ('product','service') then raise exception 'PRICE_MASTER_ITEM_TYPE_INVALID'; end if;
  if p_expected_version is null then raise exception 'PRICE_MASTER_VERSION_REQUIRED'; end if;
  if p_unit_price is null or p_unit_price::text in ('NaN','Infinity','-Infinity')
     or p_unit_price <= 0 or p_unit_price > 10000000
     or p_unit_price <> round(p_unit_price,2) then raise exception 'PRICE_MASTER_PRICE_INVALID'; end if;
  if (p_item_type='product' and (p_product_id is null or p_service_id is not null))
     or (p_item_type='service' and (p_service_id is null or p_product_id is not null)) then
    raise exception 'PRICE_MASTER_ITEM_REFERENCE_INVALID';
  end if;
  select * into v_list from public.price_lists l
   where l.id=p_price_list_id and l.clinic_id=v_clinic and l.active for update;
  if not found then raise exception 'PRICE_MASTER_LIST_NOT_FOUND'; end if;

  if p_item_type='product' then
    select p.dispense_unit into v_unit from public.products p
     where p.id=p_product_id and p.clinic_id=v_clinic and p.active;
    if not found then raise exception 'PRICE_MASTER_PRODUCT_NOT_AVAILABLE'; end if;
  else
    select s.unit_code into v_unit from public.services s
     where s.id=p_service_id and s.clinic_id=v_clinic and s.active;
    if not found then raise exception 'PRICE_MASTER_SERVICE_NOT_AVAILABLE'; end if;
  end if;
  if p_unit_code is null or lower(btrim(p_unit_code)) <> lower(btrim(v_unit)) then
    raise exception 'PRICE_MASTER_UNIT_MISMATCH';
  end if;

  select i.* into v_item from public.price_list_items i
   where i.price_list_id=v_list.id and i.clinic_id=v_clinic and i.item_type=p_item_type
     and ((p_item_type='product' and i.product_id=p_product_id)
       or (p_item_type='service' and i.service_id=p_service_id)) for update;
  if found then
    if v_item.version <> p_expected_version then raise exception 'PRICE_MASTER_VERSION_CONFLICT'; end if;
    v_before := to_jsonb(v_item);
    update public.price_list_items set unit_code=p_unit_code, unit_price=p_unit_price,
      version=version+1, updated_at=now() where id=v_item.id returning * into v_item;
    v_after := to_jsonb(v_item);
    insert into public.price_master_audit(clinic_id,price_list_id,price_list_item_id,action,reason,before_state,after_state,actor_id)
      values(v_clinic,v_list.id,v_item.id,'update',btrim(p_reason),v_before,v_after,auth.uid());
  else
    if p_expected_version <> 0 then raise exception 'PRICE_MASTER_VERSION_CONFLICT'; end if;
    insert into public.price_list_items(clinic_id,price_list_id,item_type,product_id,service_id,unit_code,unit_price,version)
      values(v_clinic,v_list.id,p_item_type,p_product_id,p_service_id,btrim(p_unit_code),p_unit_price,1)
      returning * into v_item;
    v_after := to_jsonb(v_item);
    insert into public.price_master_audit(clinic_id,price_list_id,price_list_item_id,action,reason,before_state,after_state,actor_id)
      values(v_clinic,v_list.id,v_item.id,'insert',btrim(p_reason),null,v_after,auth.uid());
  end if;
  return query select v_item.id,v_item.version,v_item.unit_price;
end;
$$;
revoke all on function public.set_price_master_item(uuid,text,uuid,uuid,text,numeric,bigint,text) from public,anon,authenticated,service_role;
grant execute on function public.set_price_master_item(uuid,text,uuid,uuid,text,numeric,bigint,text) to authenticated;

create or replace function public.resolve_price_master_item(
  p_item_type text, p_product_id uuid default null, p_service_id uuid default null,
  p_as_of date default current_date, p_customer_type text default null
)
returns table(price_list_id uuid, price_list_version bigint, item_id uuid, unit_code text, unit_price numeric, item_version bigint)
language sql stable security invoker set search_path = pg_catalog, public as $$
  select l.id,l.version,i.id,i.unit_code,i.unit_price,i.version
    from public.price_lists l join public.price_list_items i
      on i.price_list_id=l.id and i.clinic_id=l.clinic_id and i.active
   where l.clinic_id=public.current_clinic_id() and l.active
     and l.effective_from <= coalesce(p_as_of,current_date)
     and (l.effective_to is null or l.effective_to >= coalesce(p_as_of,current_date))
     and ((p_customer_type is null and l.customer_type='general') or l.customer_type=p_customer_type)
     and i.item_type=p_item_type
     and ((i.item_type='product' and exists (select 1 from public.products p where p.id=i.product_id and p.clinic_id=l.clinic_id and p.active and p.dispense_unit=i.unit_code))
       or (i.item_type='service' and exists (select 1 from public.services s where s.id=i.service_id and s.clinic_id=l.clinic_id and s.active and s.unit_code=i.unit_code)))
     and ((p_item_type='product' and i.product_id=p_product_id)
       or (p_item_type='service' and i.service_id=p_service_id))
   order by l.effective_from desc,l.version desc,l.id,i.id limit 1
$$;
revoke all on function public.resolve_price_master_item(text,uuid,uuid,date,text) from public,anon,authenticated,service_role;
grant execute on function public.resolve_price_master_item(text,uuid,uuid,date,text) to authenticated;

create or replace function public.create_price_master_service(
  p_service_code text, p_name text, p_unit_code text, p_reason text
)
returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_clinic uuid := public.current_clinic_id(); v_id uuid;
begin
  if v_clinic is null then raise exception 'CNYOS_CLINIC_CONTEXT_REQUIRED'; end if;
  perform public.assert_clinic_subscription_active(v_clinic);
  if not public.price_master_admin(v_clinic) then raise exception 'PRICE_MASTER_ADMIN_REQUIRED'; end if;
  if p_service_code is null or p_service_code !~ '^[A-Z0-9][A-Z0-9_-]{1,63}$' then raise exception 'PRICE_MASTER_SERVICE_CODE_INVALID'; end if;
  if p_name is null or length(btrim(p_name)) not between 1 and 200 then raise exception 'PRICE_MASTER_SERVICE_NAME_INVALID'; end if;
  if p_unit_code is null or lower(btrim(p_unit_code)) not in ('hour','session','procedure') then raise exception 'PRICE_MASTER_UNIT_INVALID'; end if;
  if p_reason is null or length(btrim(p_reason)) < 3 or length(p_reason) > 500 then raise exception 'PRICE_MASTER_REASON_REQUIRED'; end if;
  insert into public.services(clinic_id,service_code,name_th,name_en,category,unit_code,active)
    values(v_clinic,upper(btrim(p_service_code)),btrim(p_name),btrim(p_name),'custom',lower(btrim(p_unit_code)),true)
    returning id into v_id;
  return v_id;
exception when unique_violation then raise exception 'PRICE_MASTER_SERVICE_CODE_EXISTS';
end;
$$;
revoke all on function public.create_price_master_service(text,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.create_price_master_service(text,text,text,text) to authenticated;

-- Explicit, operator-invoked setup only. No tenant receives a default row
-- unless an owner/admin deliberately calls this function; 650 is the
-- documented setup example, not a pharmacy-item price or an automatic seed.
create or replace function public.setup_price_master_default(
  p_service_name text default 'บริการปรึกษา 1 ชั่วโมง', p_unit_price numeric default 650,
  p_reason text default 'Explicit initial price-master setup'
)
returns table(price_list_id uuid, service_id uuid, item_id uuid)
language plpgsql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_clinic uuid := public.current_clinic_id(); v_list public.price_lists%rowtype;
  v_service public.services%rowtype; v_item public.price_list_items%rowtype;
  v_code text := 'STANDARD-'||substr(replace(v_clinic::text,'-',''),1,8);
begin
  if v_clinic is null then raise exception 'CNYOS_CLINIC_CONTEXT_REQUIRED'; end if;
  perform public.assert_clinic_subscription_active(v_clinic);
  if not public.price_master_admin(v_clinic) then raise exception 'PRICE_MASTER_ADMIN_REQUIRED'; end if;
  if p_service_name is null or length(btrim(p_service_name)) not between 1 and 200 then raise exception 'PRICE_MASTER_SERVICE_NAME_INVALID'; end if;
  select s.* into v_service from public.services s
   where s.clinic_id=v_clinic and s.service_code='SESSION_HOURLY' for update;
  if not found then
    insert into public.services(clinic_id,service_code,name_th,name_en,category,unit_code,active)
      values(v_clinic,'SESSION_HOURLY',btrim(p_service_name),btrim(p_service_name),'setup','hour',true)
      returning * into v_service;
  end if;
  select l.* into v_list from public.price_lists l
   where l.clinic_id=v_clinic and l.code=v_code for update;
  if not found then
    insert into public.price_lists(clinic_id,code,name,effective_from,customer_type,active)
      values(v_clinic,v_code,'ราคามาตรฐาน',current_date,'general',true)
      returning * into v_list;
  else
    update public.price_lists set active=true,quarantine_reason=null,updated_at=now()
     where id=v_list.id returning * into v_list;
  end if;
  select i.* into v_item from public.price_list_items i
   where i.price_list_id=v_list.id and i.service_id=v_service.id and i.clinic_id=v_clinic and i.active;
  if not found then
    perform public.set_price_master_item(v_list.id,'service',null,v_service.id,'hour',p_unit_price,0,p_reason);
    select i.* into v_item from public.price_list_items i
     where i.price_list_id=v_list.id and i.service_id=v_service.id and i.clinic_id=v_clinic;
    insert into public.price_master_audit(clinic_id,price_list_id,price_list_item_id,action,reason,before_state,after_state,actor_id)
      values(v_clinic,v_list.id,v_item.id,'setup',btrim(p_reason),null,jsonb_build_object('service_id',v_service.id,'price_list_id',v_list.id),auth.uid());
  end if;
  return query select v_list.id,v_service.id,v_item.id;
end;
$$;
revoke all on function public.setup_price_master_default(text,numeric,text) from public,anon,authenticated,service_role;
grant execute on function public.setup_price_master_default(text,numeric,text) to authenticated;

revoke insert,update,delete on public.services,public.price_lists,public.price_list_items from authenticated;
grant select on public.services,public.price_lists,public.price_list_items to authenticated;
alter table public.services enable row level security;
alter table public.price_lists enable row level security;
alter table public.price_list_items enable row level security;
drop policy if exists cnyos_active_subscription_boundary on public.services;
drop policy if exists cnyos_active_subscription_boundary on public.price_lists;
drop policy if exists cnyos_active_subscription_boundary on public.price_list_items;
drop policy if exists services_read_staff on public.services;
drop policy if exists services_write_admin_billing on public.services;
create policy services_read_current_clinic on public.services for select to authenticated
  using (clinic_id=public.current_clinic_id() and active);
create policy cnyos_active_subscription_boundary on public.services as restrictive for all to authenticated
  using (clinic_id=public.current_clinic_id()) with check (clinic_id=public.current_clinic_id());
drop policy if exists price_lists_read_staff on public.price_lists;
drop policy if exists price_lists_write_admin_billing on public.price_lists;
create policy price_lists_read_current_clinic on public.price_lists for select to authenticated
  using (clinic_id=public.current_clinic_id() and active);
create policy cnyos_active_subscription_boundary on public.price_lists as restrictive for all to authenticated
  using (clinic_id=public.current_clinic_id()) with check (clinic_id=public.current_clinic_id());
drop policy if exists price_list_items_read_staff on public.price_list_items;
drop policy if exists price_list_items_write_admin_billing on public.price_list_items;
create policy price_list_items_read_current_clinic on public.price_list_items for select to authenticated
  using (clinic_id=public.current_clinic_id() and active);
create policy cnyos_active_subscription_boundary on public.price_list_items as restrictive for all to authenticated
  using (clinic_id=public.current_clinic_id()) with check (clinic_id=public.current_clinic_id());

commit;
