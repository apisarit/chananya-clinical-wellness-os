begin;

-- Add only Foundation reference knowledge to the existing publication.
-- Preserve all existing publication members, grants, RLS and replica identities.
do $foundation_realtime$
declare
  target text;
  target_oid oid;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  foreach target in array array[
    'ttm_sources', 'ttm_concepts', 'ttm_concept_relations', 'ttm_diagnostic_knowledge'
  ] loop
    target_oid := to_regclass(format('public.%I', target));
    if target_oid is null or not exists (
      select 1 from pg_class where oid = target_oid and relrowsecurity
    ) then
      raise exception 'Foundation Realtime requires an existing RLS-enabled table: %', target;
    end if;
    if not has_table_privilege('authenticated', target_oid, 'SELECT') then
      raise exception 'Foundation Realtime requires existing authenticated SELECT: %', target;
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = target
    ) then
      execute format('alter publication supabase_realtime add table public.%I', target);
    end if;
  end loop;
end
$foundation_realtime$;

commit;
