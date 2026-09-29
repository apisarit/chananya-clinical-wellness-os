-- LOCAL CANDIDATE: apply after replacement and clarification backup candidates.
-- Requires explicit 2026-09-27.1 runtime/restore configuration before activation.
begin;
create or replace function cnyos_clarification_internal.replacement_backup_rows(p_clinic uuid)
returns jsonb language plpgsql stable security definer set search_path=''
set timezone='UTC' set datestyle='ISO, YMD' as $$
begin
  if p_clinic is null then raise exception 'CLINIC_ID_REQUIRED'; end if;
  if exists(
    select 1 from cnyos_clarification_internal.replacements r
    join public.prescriptions old_rx on old_rx.id=r.old_rx_id
    join public.prescriptions new_rx on new_rx.id=r.new_rx_id
    join public.encounters old_e on old_e.id=old_rx.encounter_id
    join public.encounters new_e on new_e.id=new_rx.encounter_id
    join public.dispensing_orders old_d on old_d.id=r.old_order_id
    join public.dispensing_orders new_d on new_d.id=r.new_order_id
    join cnyos_clarification_internal.tickets t on t.id=r.ticket_id
    where (r.clinic_id=p_clinic or old_e.clinic_id=p_clinic or new_e.clinic_id=p_clinic or t.clinic_id=p_clinic)
      and (r.clinic_id is distinct from old_e.clinic_id or r.clinic_id is distinct from new_e.clinic_id
        or t.clinic_id is distinct from r.clinic_id or t.order_id<>r.old_order_id
        or old_d.prescription_id<>r.old_rx_id or new_d.prescription_id<>r.new_rx_id
        or old_rx.encounter_id<>new_rx.encounter_id or old_rx.patient_id<>new_rx.patient_id
        or old_rx.patient_id<>old_e.patient_id or new_rx.patient_id<>new_e.patient_id
        or old_rx.prescriber_id is distinct from r.actor_id or new_rx.prescriber_id is distinct from r.actor_id
        or old_rx.status<>'cancelled' or old_d.status<>'cancelled'
        or r.old_snapshot is distinct from cnyos_clarification_internal.snapshot(r.old_rx_id)
        or r.new_snapshot is distinct from cnyos_clarification_internal.snapshot(r.new_rx_id)
        or r.request_payload->>'ticket' is distinct from r.ticket_id::text)
  ) then raise exception 'BACKUP_REPLACEMENT_INTEGRITY_ANOMALY'; end if;
  return coalesce((select jsonb_agg(to_jsonb(r) order by r.request_id)
    from cnyos_clarification_internal.replacements r where r.clinic_id=p_clinic),'[]'::jsonb);
end $$;
revoke all on function cnyos_clarification_internal.replacement_backup_rows(uuid) from public,anon,authenticated,service_role;

do $extend$
declare
  v_def text; v_name text;
  v_guard text:=E'  if exists(select 1 from cnyos_clarification_internal.replacements where clinic_id=p_clinic) then raise exception ''BACKUP_REPLACEMENT_CONTRACT_REQUIRED''; end if;\n';
  v_anchor text:='  select jsonb_object_agg(k,jsonb_array_length(v_data->k)),';
begin
  v_def:=pg_get_functiondef('cnyos_clarification_internal.backup_projection(uuid)'::regprocedure);
  if position('replacement_backup_rows' in v_def)=0 then
    if position(v_guard in v_def)=0 or position(v_anchor in v_def)=0 then raise exception 'REPLACEMENT_BACKUP_ANCHOR_MISSING'; end if;
    v_def:=replace(v_def,v_guard,'');
    v_def:=replace(v_def,v_anchor,
      E'  v_data:=v_data||jsonb_build_object(''cnyos_clarification_internal.replacements'',cnyos_clarification_internal.replacement_backup_rows(p_clinic));\n'||v_anchor);
    execute v_def;
  end if;
  foreach v_name in array array['public.export_clinic_backup_domain(uuid,text)',
    'public.verify_clinic_restore_trace(uuid)','public.backup_restore_contract_healthcheck()'] loop
    v_def:=pg_get_functiondef(v_name::regprocedure);
    if position('2026-09-27.1' in v_def)=0 then
      if position('2026-09-26.2' in v_def)=0 then raise exception 'REPLACEMENT_BACKUP_VERSION_MISMATCH'; end if;
      v_def:=replace(v_def,'2026-09-26.2','2026-09-27.1');
      if v_name='public.backup_restore_contract_healthcheck()' then
        if position('4,31,16,7,19,true' in v_def)=0 then raise exception 'REPLACEMENT_BACKUP_HEALTH_MISMATCH'; end if;
        v_def:=replace(v_def,'4,31,16,7,19,true','4,31,16,7,20,true');
      end if;
      execute v_def;
    end if;
  end loop;
end $extend$;
commit;
