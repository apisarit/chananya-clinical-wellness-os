begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Restrictive insertion boundary, not a replacement for role/tenant policies.
-- Authentic handoff retries return their existing receipt without an INSERT.
create function public.guard_invoiced_prescription_creation()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform e.id from public.encounters e where e.id = new.encounter_id for update;
  if exists (
    select 1 from public.invoices i
    where i.encounter_id = new.encounter_id and i.status not in ('void','cancelled')
  ) then
    raise exception 'PRESCRIPTION_ENCOUNTER_ALREADY_BILLED';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_invoiced_prescription_creation()
  from public, anon, authenticated, service_role;
create trigger trg_guard_invoiced_prescription_creation
before insert on public.prescriptions
for each row execute function public.guard_invoiced_prescription_creation();
commit;
