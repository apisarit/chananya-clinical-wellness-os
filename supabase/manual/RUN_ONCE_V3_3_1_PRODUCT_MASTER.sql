begin;

alter table public.products add column if not exists created_by uuid references auth.users(id) on delete set null;
alter table public.products add column if not exists updated_by uuid references auth.users(id) on delete set null;
alter table public.products add column if not exists deactivated_at timestamptz;
alter table public.products add column if not exists deactivated_by uuid references auth.users(id) on delete set null;

create or replace function public.prevent_product_hard_delete()
returns trigger
language plpgsql
security invoker
set search_path=public
as $$
begin
  raise exception 'Products are clinical/inventory master data and cannot be hard-deleted. Set active=false instead.';
end;
$$;

drop trigger if exists products_prevent_hard_delete on public.products;
create trigger products_prevent_hard_delete
before delete on public.products
for each row execute function public.prevent_product_hard_delete();

create or replace function public.set_product_active(p_product_id uuid, p_active boolean)
returns public.products
language plpgsql
security definer
set search_path=public
as $$
declare
  v_role text;
  v_row public.products;
begin
  v_role := public.current_user_role();
  if v_role not in ('admin','super_admin','pharmacy','inventory') then
    raise exception 'Not authorized to manage products';
  end if;

  update public.products
  set active = p_active,
      updated_by = auth.uid(),
      deactivated_at = case when p_active then null else now() end,
      deactivated_by = case when p_active then null else auth.uid() end
  where id = p_product_id
  returning * into v_row;

  if v_row.id is null then raise exception 'Product not found'; end if;
  return v_row;
end;
$$;

revoke all on function public.set_product_active(uuid,boolean) from public;
grant execute on function public.set_product_active(uuid,boolean) to authenticated, service_role;

commit;

with checks(name,ready) as (
  values
    ('products.created_by', exists(select 1 from information_schema.columns where table_schema='public' and table_name='products' and column_name='created_by')),
    ('products.updated_by', exists(select 1 from information_schema.columns where table_schema='public' and table_name='products' and column_name='updated_by')),
    ('products.deactivated_at', exists(select 1 from information_schema.columns where table_schema='public' and table_name='products' and column_name='deactivated_at')),
    ('products.deactivated_by', exists(select 1 from information_schema.columns where table_schema='public' and table_name='products' and column_name='deactivated_by')),
    ('prevent_product_hard_delete', to_regprocedure('public.prevent_product_hard_delete()') is not null),
    ('set_product_active', to_regprocedure('public.set_product_active(uuid,boolean)') is not null)
), summary as (
  select count(*) total, count(*) filter(where ready) ready from checks
)
select name, case when ready then 'READY' else 'MISSING' end status from checks
union all
select 'SUMMARY', case when ready=total then 'CHANANYA_PRODUCT_MASTER_V3_3_1 READY '||ready||'/'||total else 'CHANANYA_PRODUCT_MASTER_V3_3_1 MISSING '||(total-ready)||' OF '||total end from summary
order by name;