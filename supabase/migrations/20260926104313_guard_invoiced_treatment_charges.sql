begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create or replace function public.guard_invoiced_treatment_charges()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_old uuid;
  v_new uuid;
begin
  if tg_op <> 'INSERT' then v_old := old.encounter_id; end if;
  if tg_op <> 'DELETE' then v_new := new.encounter_id; end if;
  if tg_op = 'UPDATE' and new.encounter_id is not distinct from old.encounter_id
     and new.duration_minutes is not distinct from old.duration_minutes then
    return new;
  end if;
  -- Match invoice issuance's encounter lock. Reassignments lock both endpoints.
  perform e.id from public.encounters e
    where e.id = v_old or e.id = v_new order by e.id for update;
  if exists(select 1 from public.invoices i
      where (i.encounter_id = v_old or i.encounter_id = v_new)
        and i.status not in ('void','cancelled')) then
    raise exception 'TREATMENT_SESSION_ALREADY_BILLED';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.guard_invoiced_treatment_charges()
  from public, anon, authenticated, service_role;
create trigger trg_guard_invoiced_treatment_charges
before insert or update of encounter_id,duration_minutes or delete
on public.clinical_treatment_sessions
for each row execute function public.guard_invoiced_treatment_charges();
commit;
