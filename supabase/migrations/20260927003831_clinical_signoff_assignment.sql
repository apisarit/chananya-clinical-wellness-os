-- Package the locally rehearsed assignment fix; this file is not live approval.
-- Preserve existing role/tenant checks and the Treatment super-admin exception.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create or replace function public.sign_clinical_record_complete(
  p_encounter_id uuid,
  p_signer_name text default null,
  p_license_no text default null,
  p_reason text default 'Complete clinical record sign-off'
)
returns public.clinical_record_signoffs
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_clinic_id uuid;
  v_practitioner_id uuid;
  v_row public.clinical_record_signoffs;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  v_clinic_id := public.current_clinic_id();
  if v_clinic_id is null then raise exception 'CNYOS_SUBSCRIPTION_SUSPENDED'; end if;
  perform public.assert_clinic_subscription_active(v_clinic_id);
  -- Governance Admin must not shadow an independently assigned clinical role.
  -- This exception is local to signoff, not a change to the global role helper.
  if not public.has_role(array['super_admin','admin','practitioner','doctor'])
     and not public.is_clinic_member(v_clinic_id,array['practitioner','doctor']) then
    raise exception 'PERMISSION_DENIED';
  end if;

  -- Lock before checking assignment and before replacing a prior signature.
  -- Treatment and signoff now serialize through the same Encounter row.
  select e.practitioner_id into v_practitioner_id
  from public.encounters e
  where e.id=p_encounter_id and e.clinic_id=v_clinic_id
  for update;
  if not found then raise exception 'ENCOUNTER_NOT_FOUND'; end if;
  if v_practitioner_id is not null and v_practitioner_id <> auth.uid()
     and not public.is_super_admin() then
    raise exception 'ENCOUNTER_PRACTITIONER_MISMATCH';
  end if;
  if not exists (select 1 from public.ttm_structured_diagnoses d where d.encounter_id=p_encounter_id) then
    raise exception 'DIAGNOSIS_REQUIRED_BEFORE_SIGNOFF';
  end if;
  if not exists (select 1 from public.clinical_treatment_plans p where p.encounter_id=p_encounter_id)
     and not exists (select 1 from public.clinical_treatment_sessions s where s.encounter_id=p_encounter_id) then
    raise exception 'TREATMENT_REQUIRED_BEFORE_SIGNOFF';
  end if;
  insert into public.clinical_record_signoffs(
    encounter_id,record_section,signer_id,signer_name,
    professional_license_no,signed_at,lock_record,reason
  ) values (
    p_encounter_id,'complete_record',auth.uid(),
    nullif(btrim(p_signer_name),''),nullif(btrim(p_license_no),''),now(),true,p_reason
  )
  on conflict(encounter_id,record_section) do update set
    signer_id=auth.uid(),signer_name=excluded.signer_name,
    professional_license_no=excluded.professional_license_no,
    signed_at=now(),lock_record=true,reason=excluded.reason
  returning * into v_row;
  insert into public.clinical_record_audit_events(
    encounter_id,event_type,record_section,actor_id,reason,details
  ) values (
    p_encounter_id,'SIGN_AND_LOCK','complete_record',auth.uid(),p_reason,
    pg_catalog.jsonb_build_object('license_no',p_license_no,'signed_at',now())
  );
  return v_row;
end;
$$;
-- Browser mutations must go through the checked sign/unlock RPCs. Otherwise
-- direct INSERT/UPDATE could bypass assignment, required sections and audit.
revoke insert, update on public.clinical_record_signoffs from authenticated;
-- CREATE OR REPLACE retains the existing routine owner/ACL; no grant is added.
commit;
