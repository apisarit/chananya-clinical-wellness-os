-- Independent Quality needs a permissive SELECT path in addition to the
-- existing restrictive tenant, subscription and department boundaries.
-- No grants, write policies, RPCs or clinical/financial access are changed.
begin;
do $$
declare t text;
begin
  foreach t in array array[
    'products', 'formulas', 'formula_components', 'production_orders',
    'production_material_issues', 'production_qc', 'finished_goods_receipts'
  ] loop
    execute format('create policy quality_evidence_read on public.%I for select to authenticated using (clinic_id = public.current_clinic_id() and public.current_department_role() = ''quality'' and public.department_can(''production_read''))', t);
  end loop;
end;
$$;
commit;
