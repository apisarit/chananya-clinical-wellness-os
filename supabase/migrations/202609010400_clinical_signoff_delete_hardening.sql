begin;

-- A signed clinical record is retained evidence. Authenticated clients may
-- still create and amend sign-offs through the existing role checks, but they
-- must never remove the evidence row directly.
revoke delete on table public.clinical_record_signoffs from authenticated;

-- Replace the legacy FOR ALL policy so a future table-level grant cannot
-- silently restore a browser DELETE path.
drop policy if exists clinical_record_signoffs_write
  on public.clinical_record_signoffs;
drop policy if exists clinical_record_signoffs_insert
  on public.clinical_record_signoffs;
create policy clinical_record_signoffs_insert
on public.clinical_record_signoffs for insert to authenticated
with check (
  public.has_role(array['super_admin','admin','practitioner','doctor'])
);

drop policy if exists clinical_record_signoffs_update
  on public.clinical_record_signoffs;
create policy clinical_record_signoffs_update
on public.clinical_record_signoffs for update to authenticated
using (
  public.has_role(array['super_admin','admin','practitioner','doctor'])
)
with check (
  public.has_role(array['super_admin','admin','practitioner','doctor'])
);

-- The sign-off and clinical audit foreign keys historically cascade from an
-- Encounter. Guard the parent row before PostgreSQL can invoke either cascade.
-- Using a definer boundary makes the evidence check independent of caller RLS.
create or replace function public.prevent_encounter_clinical_evidence_delete()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
begin
  if exists (
    select 1
    from public.clinical_record_signoffs s
    where s.encounter_id = old.id
  ) or exists (
    select 1
    from public.clinical_record_audit_events a
    where a.encounter_id = old.id
  ) then
    raise exception 'ENCOUNTER_CLINICAL_EVIDENCE_DELETE_DENIED'
      using errcode = '55000',
        detail = 'Signed or audited clinical encounters must be retained';
  end if;

  return old;
end;
$$;

-- Trigger functions are not RPCs. Only the table trigger may invoke this
-- boundary; browser and service clients receive no EXECUTE grant.
revoke all on function public.prevent_encounter_clinical_evidence_delete()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_prevent_encounter_clinical_evidence_delete
  on public.encounters;
create trigger trg_prevent_encounter_clinical_evidence_delete
before delete on public.encounters
for each row
execute function public.prevent_encounter_clinical_evidence_delete();

commit;

select 'CLINICAL_SIGNOFF_DELETE_HARDENING_READY' as status;
