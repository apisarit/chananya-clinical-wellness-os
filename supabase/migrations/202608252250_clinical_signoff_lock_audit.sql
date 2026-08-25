begin;

create table if not exists public.clinical_record_signoffs (
  id uuid primary key default gen_random_uuid(),
  encounter_id uuid not null references public.encounters(id) on delete cascade,
  record_section text not null check (record_section in ('examination','diagnosis','treatment_plan','session','followup','complete_record')),
  signer_id uuid not null references auth.users(id),
  signer_name text,
  professional_license_no text,
  signed_at timestamptz not null default now(),
  lock_record boolean not null default true,
  reason text,
  unique(encounter_id,record_section)
);

alter table public.clinical_record_signoffs enable row level security;
drop policy if exists clinical_record_signoffs_read on public.clinical_record_signoffs;
create policy clinical_record_signoffs_read on public.clinical_record_signoffs
for select to authenticated
using (public.has_role(array['super_admin','admin','practitioner','doctor','pharmacy']));
drop policy if exists clinical_record_signoffs_write on public.clinical_record_signoffs;
create policy clinical_record_signoffs_write on public.clinical_record_signoffs
for all to authenticated
using (public.has_role(array['super_admin','admin','practitioner','doctor']))
with check (public.has_role(array['super_admin','admin','practitioner','doctor']));
grant select,insert,update,delete on public.clinical_record_signoffs to authenticated;

create table if not exists public.clinical_record_audit_events (
  id bigserial primary key,
  encounter_id uuid not null references public.encounters(id) on delete cascade,
  event_type text not null,
  record_section text,
  actor_id uuid references auth.users(id),
  reason text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_clinical_audit_encounter
  on public.clinical_record_audit_events(encounter_id, created_at desc);

alter table public.clinical_record_audit_events enable row level security;
drop policy if exists clinical_record_audit_events_read on public.clinical_record_audit_events;
create policy clinical_record_audit_events_read on public.clinical_record_audit_events
for select to authenticated
using (public.has_role(array['super_admin','admin','practitioner','doctor']));
grant select on public.clinical_record_audit_events to authenticated;

create or replace function public.sign_clinical_record_complete(
  p_encounter_id uuid,
  p_signer_name text default null,
  p_license_no text default null,
  p_reason text default 'Complete clinical record sign-off'
)
returns public.clinical_record_signoffs
language plpgsql
security definer
set search_path=public
as $$
declare v_row public.clinical_record_signoffs;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if not public.has_role(array['super_admin','admin','practitioner','doctor']) then raise exception 'PERMISSION_DENIED'; end if;
  if not exists(select 1 from public.encounters where id=p_encounter_id) then raise exception 'ENCOUNTER_NOT_FOUND'; end if;
  if not exists(select 1 from public.ttm_structured_diagnoses where encounter_id=p_encounter_id) then raise exception 'DIAGNOSIS_REQUIRED_BEFORE_SIGNOFF'; end if;
  if not exists(select 1 from public.clinical_treatment_plans where encounter_id=p_encounter_id)
     and not exists(select 1 from public.clinical_treatment_sessions where encounter_id=p_encounter_id) then
    raise exception 'TREATMENT_REQUIRED_BEFORE_SIGNOFF';
  end if;

  insert into public.clinical_record_signoffs(encounter_id,record_section,signer_id,signer_name,professional_license_no,signed_at,lock_record,reason)
  values(p_encounter_id,'complete_record',auth.uid(),nullif(btrim(p_signer_name),''),nullif(btrim(p_license_no),''),now(),true,p_reason)
  on conflict(encounter_id,record_section) do update set
    signer_id=auth.uid(),signer_name=excluded.signer_name,professional_license_no=excluded.professional_license_no,
    signed_at=now(),lock_record=true,reason=excluded.reason
  returning * into v_row;

  insert into public.clinical_record_audit_events(encounter_id,event_type,record_section,actor_id,reason,details)
  values(p_encounter_id,'SIGN_AND_LOCK','complete_record',auth.uid(),p_reason,jsonb_build_object('license_no',p_license_no,'signed_at',now()));
  return v_row;
end;
$$;
grant execute on function public.sign_clinical_record_complete(uuid,text,text,text) to authenticated;

create or replace function public.unlock_clinical_record_for_amendment(p_encounter_id uuid,p_reason text)
returns boolean
language plpgsql
security definer
set search_path=public
as $$
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if not public.has_role(array['super_admin','admin']) then raise exception 'PERMISSION_DENIED'; end if;
  if p_reason is null or length(btrim(p_reason))<5 then raise exception 'AMENDMENT_REASON_REQUIRED'; end if;
  update public.clinical_record_signoffs set lock_record=false,reason='Unlocked for amendment: '||btrim(p_reason)
   where encounter_id=p_encounter_id and record_section='complete_record';
  if not found then raise exception 'SIGNED_RECORD_NOT_FOUND'; end if;
  insert into public.clinical_record_audit_events(encounter_id,event_type,record_section,actor_id,reason)
  values(p_encounter_id,'UNLOCK_FOR_AMENDMENT','complete_record',auth.uid(),btrim(p_reason));
  return true;
end;
$$;
grant execute on function public.unlock_clinical_record_for_amendment(uuid,text) to authenticated;

create or replace function public.prevent_locked_clinical_record_mutation()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare v_encounter uuid;
begin
  v_encounter:=case when tg_op='DELETE' then old.encounter_id else new.encounter_id end;
  if exists(select 1 from public.clinical_record_signoffs where encounter_id=v_encounter and record_section='complete_record' and lock_record=true) then
    raise exception 'CLINICAL_RECORD_LOCKED';
  end if;
  return case when tg_op='DELETE' then old else new end;
end;
$$;

do $$ declare t text; begin
  foreach t in array array['clinical_examination_findings','ttm_structured_diagnoses','ttm_diagnostic_contexts','clinical_treatment_plans','body_pain_points','ttm_opd_histories','clinical_treatment_sessions','clinical_followup_notes'] loop
    if to_regclass('public.'||t) is not null then
      execute format('drop trigger if exists trg_prevent_locked_record on public.%I',t);
      execute format('create trigger trg_prevent_locked_record before insert or update or delete on public.%I for each row execute function public.prevent_locked_clinical_record_mutation()',t);
    end if;
  end loop;
end $$;

commit;

select 'CHANANYA_CLINICAL_SIGNOFF_LOCK_AUDIT_READY' as status,
       to_regclass('public.clinical_record_signoffs') as signoff_table,
       to_regclass('public.clinical_record_audit_events') as audit_table,
       to_regprocedure('public.sign_clinical_record_complete(uuid,text,text,text)') as sign_rpc,
       to_regprocedure('public.unlock_clinical_record_for_amendment(uuid,text)') as unlock_rpc;
