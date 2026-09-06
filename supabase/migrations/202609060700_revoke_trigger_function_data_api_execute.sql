begin;

-- ============================================================
-- TRIGGER FUNCTION DATA API EXECUTE CLOSURE
--
-- PostgreSQL invokes trigger functions through their trigger bindings. They
-- are implementation details, not browser/service RPC endpoints. Historical
-- default EXECUTE grants made several of these functions reachable through
-- the exposed public schema. Revoke those runtime grants without changing the
-- trigger bindings or function ownership.
-- ============================================================

do $$
declare
  v_function record;
begin
  for v_function in
    select
      p.oid,
      n.nspname,
      p.proname,
      pg_get_function_identity_arguments(p.oid) as identity_arguments
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and exists (
        select 1
        from pg_trigger t
        where t.tgfoid = p.oid
          and not t.tgisinternal
      )
    order by p.oid::regprocedure::text
  loop
    execute format(
      'revoke all privileges on function %I.%I(%s) from public, anon, authenticated, service_role',
      v_function.nspname,
      v_function.proname,
      v_function.identity_arguments
    );
  end loop;
end $$;

-- The only public function currently reported with a mutable search_path is a
-- generic timestamp trigger helper. Pin its resolution path explicitly.
alter function public.set_updated_at()
  set search_path = pg_catalog, public;

-- Fail the migration if any Data API runtime role can still execute a function
-- that is installed as a non-internal trigger.
do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and exists (
        select 1
        from pg_trigger t
        where t.tgfoid = p.oid
          and not t.tgisinternal
      )
      and (
        has_function_privilege('anon', p.oid, 'EXECUTE')
        or has_function_privilege('authenticated', p.oid, 'EXECUTE')
        or has_function_privilege('service_role', p.oid, 'EXECUTE')
      )
  ) then
    raise exception 'CNYOS_TRIGGER_FUNCTION_RUNTIME_EXECUTE_PRESENT';
  end if;

  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'set_updated_at'
      and pg_get_function_identity_arguments(p.oid) = ''
      and coalesce(array_to_string(p.proconfig, ','), '')
          not like '%search_path=pg_catalog, public%'
  ) then
    raise exception 'CNYOS_SET_UPDATED_AT_SEARCH_PATH_MUTABLE';
  end if;
end $$;

commit;

select 'CNYOS_TRIGGER_FUNCTION_DATA_API_CLOSED' as status;
