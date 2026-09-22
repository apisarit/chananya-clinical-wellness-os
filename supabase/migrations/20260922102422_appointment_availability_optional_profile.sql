begin;
-- Profile visibility is optional display metadata, never the schedule's
-- authorization boundary. Keep security_invoker and all base-table RLS.
do $$
declare definition text;
begin
  select pg_get_viewdef('public.available_practitioner_schedules'::regclass, true)
    into definition;
  if position('     JOIN profiles p ON p.id = s.practitioner_id' in definition) = 0 then
    raise exception 'Unexpected availability view definition; review before applying';
  end if;
  definition := replace(definition,
    '     JOIN profiles p ON p.id = s.practitioner_id',
    '     LEFT JOIN profiles p ON p.id = s.practitioner_id');
  execute 'create or replace view public.available_practitioner_schedules with (security_invoker=true) as ' || definition;
end $$;
notify pgrst, 'reload schema';
commit;
