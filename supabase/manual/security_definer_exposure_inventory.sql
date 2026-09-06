-- Read-only inventory for Issue #35.
-- Run separately against each tenant project and retain the result with the
-- exact source revision and project reference. This script changes no data.

with public_functions as (
  select
    p.oid,
    p.oid::regprocedure::text as function_identity,
    p.prosecdef as security_definer,
    coalesce(array_to_string(p.proconfig, ','), '') as function_config,
    has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
    has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
    has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_execute,
    exists (
      select 1
      from pg_trigger t
      where t.tgfoid = p.oid
        and not t.tgisinternal
    ) as used_by_trigger
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind = 'f'
), classified as (
  select *,
    case
      when used_by_trigger then 'internal_trigger'
      when security_definer and anon_execute then 'review_anon_security_definer'
      when security_definer and authenticated_execute then 'review_authenticated_security_definer'
      when security_definer and service_role_execute then 'review_service_security_definer'
      when security_definer then 'closed_security_definer'
      else 'security_invoker'
    end as exposure_class
  from public_functions
)
select
  exposure_class,
  count(*) as function_count,
  jsonb_agg(
    jsonb_build_object(
      'function', function_identity,
      'security_definer', security_definer,
      'used_by_trigger', used_by_trigger,
      'anon_execute', anon_execute,
      'authenticated_execute', authenticated_execute,
      'service_role_execute', service_role_execute,
      'config', function_config
    )
    order by function_identity
  ) as functions
from classified
group by exposure_class
order by exposure_class;
