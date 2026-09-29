-- Review-only, not a production migration or activation authorization.
begin;
do $$ begin raise exception 'PRODUCTION_FINITE_OUTPUT_REVIEW_REQUIRED'; end $$;

-- Patch only the reviewed input check; retain the existing body, owner and ACL.
-- Refuse drift rather than replacing an unknown version of the routine.
do $patch$
declare
  source text := pg_get_functiondef('public.complete_production_order(uuid,numeric,numeric,numeric)'::regprocedure);
  needle text := $old$  if coalesce(p_actual_quantity, 0) <= 0
     or coalesce(p_loss_quantity, 0) < 0
     or coalesce(p_waste_quantity, 0) < 0 then$old$;
  replacement text := $new$  if p_actual_quantity::text in ('NaN','Infinity','-Infinity')
     or p_loss_quantity::text in ('NaN','Infinity','-Infinity')
     or p_waste_quantity::text in ('NaN','Infinity','-Infinity')
     or coalesce(p_actual_quantity, 0) <= 0
     or coalesce(p_loss_quantity, 0) < 0
     or coalesce(p_waste_quantity, 0) < 0 then$new$;
begin
  if (length(source)-length(replace(source,needle,''))) <> length(needle) then
    raise exception 'PRODUCTION_FINITE_OUTPUT_SOURCE_DRIFT';
  end if;
  execute replace(source,needle,replacement);
end;
$patch$;
commit;
