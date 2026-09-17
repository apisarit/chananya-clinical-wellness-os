begin;

-- Staging-only hardening for the shared timestamp trigger.  The trigger is
-- SECURITY INVOKER; pinning its path prevents a mutable session path from
-- resolving now() or other names through an untrusted schema.
alter function public.set_updated_at()
  set search_path = pg_catalog, public;

commit;
