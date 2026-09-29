begin;

-- STAGING CANDIDATE ONLY. Review this SQL independently before applying it.
-- Doctors/practitioners submit suggestions; only a different super_admin can
-- approve them. Browser callers never receive table INSERT/UPDATE privileges.

create table if not exists public.ttm_knowledge_suggestions (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  suggestion_no text not null unique,
  target_table text not null check (target_table in ('ttm_diagnostic_knowledge','ttm_concepts')),
  target_id uuid,
  action text not null check (action in ('create','update')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  source_ref text not null check (length(btrim(source_ref)) between 3 and 500),
  reason text not null check (length(btrim(reason)) between 8 and 2000),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  requested_by uuid not null references auth.users(id) on delete restrict,
  requested_at timestamptz not null default now(),
  decided_by uuid references auth.users(id) on delete restrict,
  decided_at timestamptz,
  decision_notes text,
  approval_task_id uuid references public.approval_tasks(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((action = 'create' and target_id is null) or (action = 'update' and target_id is not null)),
  check (octet_length(payload::text) <= 32768)
);

-- Existing pending updates have no trustworthy submission snapshot. Do not
-- backfill them from today's content: they must be rejected and resubmitted.
alter table public.ttm_knowledge_suggestions
  add column if not exists target_snapshot jsonb;

create table if not exists public.ttm_knowledge_suggestion_events (
  id uuid primary key default gen_random_uuid(),
  suggestion_id uuid not null references public.ttm_knowledge_suggestions(id) on delete cascade,
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  from_status text,
  to_status text not null,
  event text not null,
  reason text,
  actor_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

create index if not exists ttm_knowledge_suggestions_queue_idx
  on public.ttm_knowledge_suggestions(clinic_id,status,requested_at desc);

-- Retain actual applied content, not just the requested payload. Historic events
-- remain null: this candidate must not invent evidence for past decisions.
alter table public.ttm_knowledge_suggestion_events
  add column if not exists target_table text,
  add column if not exists target_id uuid,
  add column if not exists before_snapshot jsonb,
  add column if not exists after_snapshot jsonb;
create index if not exists ttm_knowledge_suggestion_events_idx
  on public.ttm_knowledge_suggestion_events(clinic_id,suggestion_id,created_at desc);

alter table public.ttm_knowledge_suggestions enable row level security;
alter table public.ttm_knowledge_suggestion_events enable row level security;

drop policy if exists ttm_knowledge_suggestions_read on public.ttm_knowledge_suggestions;
create policy ttm_knowledge_suggestions_read
on public.ttm_knowledge_suggestions for select to authenticated
using (
  clinic_id = public.current_clinic_id()
  and (requested_by = auth.uid() or public.is_super_admin())
);

drop policy if exists ttm_knowledge_suggestion_events_read on public.ttm_knowledge_suggestion_events;
create policy ttm_knowledge_suggestion_events_read
on public.ttm_knowledge_suggestion_events for select to authenticated
using (
  clinic_id = public.current_clinic_id()
  and exists (
    select 1 from public.ttm_knowledge_suggestions s
    where s.id = suggestion_id
      and (s.requested_by = auth.uid() or public.is_super_admin())
  )
);

revoke all on public.ttm_knowledge_suggestions, public.ttm_knowledge_suggestion_events from public, anon, authenticated, service_role;
grant select on public.ttm_knowledge_suggestions, public.ttm_knowledge_suggestion_events to authenticated;

drop trigger if exists ttm_knowledge_suggestions_updated_at on public.ttm_knowledge_suggestions;
create trigger ttm_knowledge_suggestions_updated_at
before update on public.ttm_knowledge_suggestions
for each row execute function public.set_updated_at();

drop trigger if exists ttm_knowledge_suggestion_events_append_only on public.ttm_knowledge_suggestion_events;
create trigger ttm_knowledge_suggestion_events_append_only
before update or delete on public.ttm_knowledge_suggestion_events
for each row execute function public.reject_append_only_mutation();

create or replace function public.submit_ttm_knowledge_suggestion(
  p_target_table text,
  p_target_id uuid,
  p_action text,
  p_payload jsonb,
  p_source_ref text,
  p_reason text
)
returns public.ttm_knowledge_suggestions
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_id uuid;
  v_task_id uuid;
  v_row public.ttm_knowledge_suggestions;
  v_snapshot jsonb;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if v_clinic_id is null then raise exception 'CLINIC_CONTEXT_REQUIRED'; end if;
  perform public.assert_clinic_subscription_active(v_clinic_id);
  if not public.has_role(array['doctor','practitioner']) then
    raise exception 'TTM_SUGGESTION_ROLE_REQUIRED';
  end if;
  if p_target_table not in ('ttm_diagnostic_knowledge','ttm_concepts') then
    raise exception 'TTM_SUGGESTION_TARGET_NOT_ALLOWED';
  end if;
  if p_action not in ('create','update') then raise exception 'TTM_SUGGESTION_ACTION_NOT_ALLOWED'; end if;
  if (p_action = 'create' and p_target_id is not null)
     or (p_action = 'update' and p_target_id is null) then
    raise exception 'TTM_SUGGESTION_TARGET_ID_INVALID';
  end if;
  if jsonb_typeof(coalesce(p_payload,'null'::jsonb)) <> 'object'
     or octet_length(p_payload::text) > 32768 then
    raise exception 'TTM_SUGGESTION_PAYLOAD_INVALID';
  end if;
  if p_payload ?| array['review_status','active','requested_by','decided_by','status'] then
    raise exception 'TTM_SUGGESTION_CONTROL_FIELD_FORBIDDEN';
  end if;
  if length(btrim(coalesce(p_source_ref,''))) not between 3 and 500
     or length(btrim(coalesce(p_reason,''))) not between 8 and 2000 then
    raise exception 'TTM_SUGGESTION_EVIDENCE_REQUIRED';
  end if;

  if p_action = 'update' then
    if p_target_table = 'ttm_diagnostic_knowledge' then
      select to_jsonb(t) into v_snapshot from public.ttm_diagnostic_knowledge t
      where t.id = p_target_id for share;
    else
      select to_jsonb(t) into v_snapshot from public.ttm_concepts t
      where t.id = p_target_id for share;
    end if;
    if v_snapshot is null then raise exception 'TTM_SUGGESTION_TARGET_NOT_FOUND'; end if;
  end if;

  insert into public.ttm_knowledge_suggestions(
    clinic_id,suggestion_no,target_table,target_id,action,payload,source_ref,reason,requested_by,target_snapshot
  ) values (
    v_clinic_id,
    'TTM-SUG-' || to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS'),
    p_target_table,p_target_id,p_action,p_payload,btrim(p_source_ref),btrim(p_reason),auth.uid(),v_snapshot
  ) returning id into v_id;

  v_task_id := public.create_approval_task(
    'ttm_knowledge_review','ttm_knowledge','ทบทวนข้อเสนอองค์ความรู้ TTM',
    btrim(p_reason),'high','ttm_knowledge_suggestion',v_id,null,
    jsonb_build_object('target_table',p_target_table,'action',p_action,'source_ref',btrim(p_source_ref))
  );
  update public.ttm_knowledge_suggestions
  set approval_task_id = v_task_id
  where id = v_id;

  insert into public.ttm_knowledge_suggestion_events(
    suggestion_id,clinic_id,to_status,event,reason,actor_id
  ) values (v_id,v_clinic_id,'pending','submitted',btrim(p_reason),auth.uid());
  select * into v_row from public.ttm_knowledge_suggestions where id = v_id;
  return v_row;
end;
$$;

create or replace function public.apply_ttm_knowledge_suggestion(p_suggestion_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v public.ttm_knowledge_suggestions;
  v_source_id uuid;
  v_current jsonb;
  v_after jsonb;
  v_applied_id uuid;
begin
  select * into v from public.ttm_knowledge_suggestions where id = p_suggestion_id for update;
  if not found then raise exception 'TTM_SUGGESTION_NOT_FOUND'; end if;
  if v.action = 'update' then
    if v.target_table = 'ttm_diagnostic_knowledge' then
      select to_jsonb(t) into v_current from public.ttm_diagnostic_knowledge t
      where t.id = v.target_id for update;
    elsif v.target_table = 'ttm_concepts' then
      select to_jsonb(t) into v_current from public.ttm_concepts t
      where t.id = v.target_id for update;
    end if;
    if v.target_snapshot is null or v_current is null
       or v_current is distinct from v.target_snapshot then
      raise exception 'TTM_SUGGESTION_TARGET_CHANGED_RESUBMIT';
    end if;
  end if;
  if v.target_table = 'ttm_diagnostic_knowledge' then
    if v.action = 'create' then
      if v.payload->>'domain' is null or v.payload->>'rule_key' is null
         or v.payload->>'input_key' is null or v.payload->>'output_value' is null then
        raise exception 'TTM_DKR_REQUIRED_FIELDS_MISSING';
      end if;
      insert into public.ttm_diagnostic_knowledge(
        domain,rule_key,input_key,output_value,element,samutthan,coordinate,
        description,source_ref,source_class,review_status,version,active,metadata
      ) values (
        v.payload->>'domain',v.payload->>'rule_key',v.payload->>'input_key',v.payload->>'output_value',
        v.payload->>'element',v.payload->>'samutthan',v.payload->>'coordinate',v.payload->>'description',
        v.source_ref,'clinician_suggestion','approved',coalesce(v.payload->>'version','TTM-DKR-v1'),true,
        coalesce(v.payload->'metadata','{}'::jsonb) || jsonb_build_object('approved_suggestion_id',v.id)
      ) returning id into v_applied_id;
    else
      update public.ttm_diagnostic_knowledge
      set domain=coalesce(v.payload->>'domain',domain),
          rule_key=coalesce(v.payload->>'rule_key',rule_key),
          input_key=coalesce(v.payload->>'input_key',input_key),
          output_value=coalesce(v.payload->>'output_value',output_value),
          element=coalesce(v.payload->>'element',element),
          samutthan=coalesce(v.payload->>'samutthan',samutthan),
          coordinate=coalesce(v.payload->>'coordinate',coordinate),
          description=coalesce(v.payload->>'description',description),
          source_ref=v.source_ref, review_status='approved',
          metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object('approved_suggestion_id',v.id)
      where id=v.target_id;
      if not found then raise exception 'TTM_DKR_TARGET_NOT_FOUND'; end if;
      v_applied_id := v.target_id;
    end if;
  elsif v.target_table = 'ttm_concepts' then
    if v.payload->>'concept_code' is null or v.payload->>'concept_type' is null
       or v.payload->>'preferred_term_th' is null then
      raise exception 'TTM_CONCEPT_REQUIRED_FIELDS_MISSING';
    end if;
    if v.action = 'create' then
      if coalesce(v.payload->>'foundation_layer','') !~ '^[1-5]$' then
        raise exception 'TTM_CONCEPT_LAYER_INVALID';
      end if;
      if coalesce(v.payload->>'source_id','') !~* '^[0-9a-f-]{36}$' then
        raise exception 'TTM_CONCEPT_SOURCE_REQUIRED';
      end if;
      v_source_id := (v.payload->>'source_id')::uuid;
      if not exists (select 1 from public.ttm_sources where id=v_source_id and active) then
        raise exception 'TTM_CONCEPT_SOURCE_NOT_FOUND';
      end if;
      insert into public.ttm_concepts(
        concept_code,concept_type,preferred_term_th,preferred_term_en,foundation_layer,
        definition,source_id,review_status,version,active,metadata
      ) values (
        v.payload->>'concept_code',v.payload->>'concept_type',v.payload->>'preferred_term_th',v.payload->>'preferred_term_en',
        (v.payload->>'foundation_layer')::smallint,v.payload->>'definition',v_source_id,'approved',
        coalesce(v.payload->>'version','TTM-FOUNDATION-v1'),true,
        coalesce(v.payload->'metadata','{}'::jsonb) || jsonb_build_object('approved_suggestion_id',v.id)
      ) returning id into v_applied_id;
    else
      update public.ttm_concepts
      set concept_code=coalesce(v.payload->>'concept_code',concept_code),
          concept_type=coalesce(v.payload->>'concept_type',concept_type),
          preferred_term_th=coalesce(v.payload->>'preferred_term_th',preferred_term_th),
          preferred_term_en=coalesce(v.payload->>'preferred_term_en',preferred_term_en),
          definition=coalesce(v.payload->>'definition',definition),
          review_status='approved',
          metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object('approved_suggestion_id',v.id)
      where id=v.target_id;
      if not found then raise exception 'TTM_CONCEPT_TARGET_NOT_FOUND'; end if;
      v_applied_id := v.target_id;
    end if;
  else
    raise exception 'TTM_SUGGESTION_TARGET_NOT_ALLOWED';
  end if;
  if v.target_table = 'ttm_diagnostic_knowledge' then
    select to_jsonb(t) into v_after from public.ttm_diagnostic_knowledge t where t.id=v_applied_id;
  else
    select to_jsonb(t) into v_after from public.ttm_concepts t where t.id=v_applied_id;
  end if;
  if v_after is null then raise exception 'TTM_APPLIED_EVIDENCE_MISSING'; end if;
  insert into public.ttm_knowledge_suggestion_events(
    suggestion_id,clinic_id,from_status,to_status,event,reason,actor_id,
    target_table,target_id,before_snapshot,after_snapshot
  ) values (
    v.id,v.clinic_id,v.status,'approved','knowledge_applied',v.reason,auth.uid(),
    v.target_table,v_applied_id,v_current,v_after
  );
end;
$$;

create or replace function public.decide_ttm_knowledge_suggestion(
  p_suggestion_id uuid,
  p_decision text,
  p_notes text
)
returns public.ttm_knowledge_suggestions
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v public.ttm_knowledge_suggestions;
  v_out public.ttm_knowledge_suggestions;
  v_status text;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if v_clinic_id is null then raise exception 'CLINIC_CONTEXT_REQUIRED'; end if;
  perform public.assert_clinic_subscription_active(v_clinic_id);
  if not public.is_super_admin() then raise exception 'TTM_SUPER_ADMIN_REQUIRED'; end if;
  if p_decision is null or p_decision not in ('approve','reject') then raise exception 'TTM_DECISION_INVALID'; end if;
  v_status := case p_decision when 'approve' then 'approved' else 'rejected' end;
  if length(btrim(coalesce(p_notes,''))) < 8 then raise exception 'TTM_DECISION_REASON_REQUIRED'; end if;
  select * into v from public.ttm_knowledge_suggestions
  where id=p_suggestion_id and clinic_id=v_clinic_id for update;
  if not found then raise exception 'TTM_SUGGESTION_NOT_FOUND'; end if;
  if v.status <> 'pending' then raise exception 'TTM_SUGGESTION_ALREADY_DECIDED'; end if;
  if v.requested_by = auth.uid() then raise exception 'TTM_PRODUCER_CANNOT_APPROVE'; end if;
  if p_decision='approve' then perform public.apply_ttm_knowledge_suggestion(v.id); end if;

  update public.ttm_knowledge_suggestions
  set status=v_status, decided_by=auth.uid(), decided_at=now(), decision_notes=btrim(p_notes)
  where id=v.id
  returning * into v_out;
  insert into public.ttm_knowledge_suggestion_events(
    suggestion_id,clinic_id,from_status,to_status,event,reason,actor_id
  ) values (v.id,v.clinic_id,v.status,v_status,p_decision,btrim(p_notes),auth.uid());
  perform public.decide_approval_task(v.approval_task_id,p_decision,btrim(p_notes));
  return v_out;
end;
$$;

revoke all on function public.submit_ttm_knowledge_suggestion(text,uuid,text,jsonb,text,text) from public, anon, authenticated, service_role;
revoke all on function public.decide_ttm_knowledge_suggestion(uuid,text,text) from public, anon, authenticated, service_role;
revoke all on function public.apply_ttm_knowledge_suggestion(uuid) from public, anon, authenticated, service_role;
grant execute on function public.submit_ttm_knowledge_suggestion(text,uuid,text,jsonb,text,text) to authenticated;
grant execute on function public.decide_ttm_knowledge_suggestion(uuid,text,text) to authenticated;

-- Request identity is retained on the proposal itself, including after decision.
-- Legacy submissions remain supported but do not claim replay protection.
alter table public.ttm_knowledge_suggestions add column if not exists client_request_id uuid;
create unique index if not exists ttm_suggestion_request_identity
  on public.ttm_knowledge_suggestions(clinic_id,requested_by,client_request_id)
  where client_request_id is not null;

create or replace function public.submit_ttm_knowledge_suggestion_once(
  p_request_id uuid, p_target_table text, p_target_id uuid, p_action text,
  p_payload jsonb, p_source_ref text, p_reason text
)
returns public.ttm_knowledge_suggestions
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_user_id uuid := auth.uid();
  v public.ttm_knowledge_suggestions;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED'; end if;
  if v_clinic_id is null then raise exception 'CLINIC_CONTEXT_REQUIRED'; end if;
  perform public.assert_clinic_subscription_active(v_clinic_id);
  if not public.has_role(array['doctor','practitioner']) then
    raise exception 'TTM_SUGGESTION_ROLE_REQUIRED';
  end if;
  if p_request_id is null then raise exception 'TTM_REQUEST_ID_REQUIRED'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'ttm-submit:' || v_clinic_id::text || ':' || v_user_id::text || ':' || p_request_id::text, 0));
  select * into v from public.ttm_knowledge_suggestions
    where clinic_id=v_clinic_id and requested_by=v_user_id and client_request_id=p_request_id;
  if found then
    if v.target_table is distinct from p_target_table
       or v.target_id is distinct from p_target_id
       or v.action is distinct from p_action
       or v.payload is distinct from p_payload
       or v.source_ref is distinct from btrim(p_source_ref)
       or v.reason is distinct from btrim(p_reason) then
      raise exception 'TTM_REQUEST_CONTENT_CONFLICT';
    end if;
    return v;
  end if;
  v := public.submit_ttm_knowledge_suggestion(
    p_target_table,p_target_id,p_action,p_payload,p_source_ref,p_reason);
  update public.ttm_knowledge_suggestions set client_request_id=p_request_id
    where id=v.id returning * into v;
  return v;
end;
$$;
revoke all on function public.submit_ttm_knowledge_suggestion_once(uuid,text,uuid,text,jsonb,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.submit_ttm_knowledge_suggestion_once(uuid,text,uuid,text,jsonb,text,text)
  to authenticated;

commit;
