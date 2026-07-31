begin;

-- Allow production users to read operational master/stock data.
do $$
declare t text;
begin
  foreach t in array array['products','suppliers','inventory_lots','stock_movements'] loop
    execute format('drop policy if exists %I_read_staff on public.%I', t, t);
    execute format(
      'create policy %I_read_staff on public.%I for select to authenticated using (public.has_role(array[''admin'',''practitioner'',''reception'',''pharmacy'',''production'',''inventory'',''billing'',''viewer'']))',
      t, t
    );
  end loop;
end $$;

-- Production must be able to create/update finished-goods and consume raw-material lots.
drop policy if exists inventory_lots_write_inventory on public.inventory_lots;
create policy inventory_lots_write_inventory on public.inventory_lots for all to authenticated
using (public.has_role(array['admin','pharmacy','production','inventory']))
with check (public.has_role(array['admin','pharmacy','production','inventory']));

drop policy if exists stock_movements_write_inventory on public.stock_movements;
create policy stock_movements_write_inventory on public.stock_movements for insert to authenticated
with check (public.has_role(array['admin','pharmacy','production','inventory']));

drop policy if exists products_write_inventory on public.products;
create policy products_write_inventory on public.products for all to authenticated
using (public.has_role(array['admin','pharmacy','production','inventory']))
with check (public.has_role(array['admin','pharmacy','production','inventory']));

drop policy if exists suppliers_write_inventory on public.suppliers;
create policy suppliers_write_inventory on public.suppliers for all to authenticated
using (public.has_role(array['admin','production','inventory']))
with check (public.has_role(array['admin','production','inventory']));

commit;

select 'CHANANYA_PRODUCTION_INVENTORY_PERMISSIONS_READY' as status;
