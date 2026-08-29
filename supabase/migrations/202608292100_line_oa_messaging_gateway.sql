begin;

-- LINE OA transport state contains keyed subject hashes and sanitized action
-- classifications only. Raw LINE user IDs, message text, reply tokens and
-- webhook payloads are deliberately never persisted.
create table if not exists public.line_oa_contact_states (
  id uuid primary key default gen_random_uuid(),
  provider_channel_hash text not null check (provider_channel_hash ~ '^[0-9a-f]{64}$'),
  subject_hash text not null check (subject_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'unknown' check (status in ('unknown','followed','unfollowed')),
  first_seen_at timestamptz not null default now(),
  followed_at timestamptz,
  unfollowed_at timestamptz,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_channel_hash, subject_hash)
);

create table if not exists public.line_oa_webhook_events (
  id bigint generated always as identity primary key,
  provider_channel_hash text not null check (provider_channel_hash ~ '^[0-9a-f]{64}$'),
  event_id_hash text not null check (event_id_hash ~ '^[0-9a-f]{64}$'),
  subject_hash text check (subject_hash is null or subject_hash ~ '^[0-9a-f]{64}$'),
  event_type text not null check (event_type ~ '^[A-Za-z][A-Za-z0-9]{1,40}$'),
  action_code text not null default 'none' check (action_code in (
    'card','status','appointments','privacy','revoke','help','unknown','none'
  )),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  event_timestamp timestamptz not null,
  is_redelivery boolean not null default false,
  processing_status text not null default 'processing' check (processing_status in (
    'processing','processed','ignored','failed'
  )),
  reply_status text not null default 'pending' check (reply_status in (
    'pending','sent','not_applicable','failed'
  )),
  linked_patient_count integer not null default 0 check (linked_patient_count >= 0),
  attempt_count integer not null default 1 check (attempt_count between 1 and 5),
  error_code text check (error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{2,80}$'),
  last_attempt_at timestamptz not null default now(),
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (provider_channel_hash, event_id_hash)
);

create index if not exists line_oa_webhook_events_status_idx
  on public.line_oa_webhook_events(processing_status, last_attempt_at desc);
create index if not exists line_oa_webhook_events_subject_idx
  on public.line_oa_webhook_events(subject_hash, created_at desc)
  where subject_hash is not null;

alter table public.line_oa_contact_states enable row level security;
alter table public.line_oa_webhook_events enable row level security;

revoke all on public.line_oa_contact_states from public, anon, authenticated, service_role;
revoke all on public.line_oa_webhook_events from public, anon, authenticated, service_role;

create or replace function public.register_line_oa_webhook_event(
  p_provider_channel_hash text,
  p_event_id_hash text,
  p_subject_hash text,
  p_event_type text,
  p_action_code text,
  p_event_timestamp timestamptz,
  p_is_redelivery boolean,
  p_payload_hash text
)
returns table (accepted boolean, linked_count integer)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_event_row_id bigint;
  v_linked_count integer := 0;
  v_identity_event_type text;
begin
  if p_provider_channel_hash !~ '^[0-9a-f]{64}$'
     or p_event_id_hash !~ '^[0-9a-f]{64}$'
     or p_payload_hash !~ '^[0-9a-f]{64}$'
     or (p_subject_hash is not null and p_subject_hash !~ '^[0-9a-f]{64}$')
     or p_event_type !~ '^[A-Za-z][A-Za-z0-9]{1,40}$'
     or p_action_code not in (
       'card','status','appointments','privacy','revoke','help','unknown','none'
     )
     or p_event_timestamp is null
     or p_event_timestamp < now() - interval '7 days'
     or p_event_timestamp > now() + interval '10 minutes' then
    raise exception 'LINE_OA_EVENT_INVALID';
  end if;

  insert into public.line_oa_webhook_events (
    provider_channel_hash,event_id_hash,subject_hash,event_type,action_code,
    payload_hash,event_timestamp,is_redelivery,processing_status,reply_status,
    attempt_count,last_attempt_at
  ) values (
    p_provider_channel_hash,p_event_id_hash,p_subject_hash,p_event_type,p_action_code,
    p_payload_hash,p_event_timestamp,coalesce(p_is_redelivery,false),'processing','pending',
    1,now()
  )
  on conflict (provider_channel_hash,event_id_hash)
  do update set
    is_redelivery = public.line_oa_webhook_events.is_redelivery or excluded.is_redelivery,
    processing_status = 'processing',
    reply_status = 'pending',
    attempt_count = public.line_oa_webhook_events.attempt_count + 1,
    error_code = null,
    processed_at = null,
    last_attempt_at = now()
  where public.line_oa_webhook_events.attempt_count < 5
    and (
      public.line_oa_webhook_events.processing_status = 'failed'
      or (
        public.line_oa_webhook_events.processing_status = 'processing'
        and public.line_oa_webhook_events.last_attempt_at < now() - interval '2 minutes'
      )
    )
  returning id into v_event_row_id;

  if v_event_row_id is null then
    return query select false,0;
    return;
  end if;

  if p_subject_hash is not null then
    insert into public.line_oa_contact_states (
      provider_channel_hash,subject_hash,status,followed_at,unfollowed_at,last_seen_at
    ) values (
      p_provider_channel_hash,
      p_subject_hash,
      case
        when p_event_type = 'follow' then 'followed'
        when p_event_type = 'unfollow' then 'unfollowed'
        else 'unknown'
      end,
      case when p_event_type = 'follow' then now() end,
      case when p_event_type = 'unfollow' then now() end,
      now()
    )
    on conflict (provider_channel_hash,subject_hash)
    do update set
      status = case
        when p_event_type = 'follow' then 'followed'
        when p_event_type = 'unfollow' then 'unfollowed'
        else public.line_oa_contact_states.status
      end,
      followed_at = case
        when p_event_type = 'follow' then now()
        else public.line_oa_contact_states.followed_at
      end,
      unfollowed_at = case
        when p_event_type = 'unfollow' then now()
        else public.line_oa_contact_states.unfollowed_at
      end,
      last_seen_at = now(),
      updated_at = now();

    select count(*)::integer into v_linked_count
    from public.patient_identity_links l
    where l.provider = 'line'
      and l.subject_hash = p_subject_hash
      and l.status = 'active';

    v_identity_event_type := case
      when p_event_type = 'follow' then 'LINE_OA_FOLLOWED'
      when p_event_type = 'unfollow' then 'LINE_OA_UNFOLLOWED'
      when p_action_code = 'card' then 'LINE_OA_PATIENT_CARD_REQUESTED'
      when p_action_code = 'appointments' then 'LINE_OA_APPOINTMENT_HELP_REQUESTED'
      when p_action_code in ('privacy','revoke') then 'LINE_OA_PRIVACY_HELP_REQUESTED'
      else null
    end;

    if v_identity_event_type is not null then
      insert into public.patient_identity_events (
        clinic_id,patient_id,event_type,identity_link_id,metadata
      )
      select
        l.clinic_id,
        l.patient_id,
        v_identity_event_type,
        l.id,
        jsonb_build_object(
          'transport','line_oa',
          'event_id_hash',p_event_id_hash,
          'action_code',p_action_code,
          'is_redelivery',coalesce(p_is_redelivery,false)
        )
      from public.patient_identity_links l
      where l.provider = 'line'
        and l.subject_hash = p_subject_hash
        and l.status = 'active';
    end if;
  end if;

  update public.line_oa_webhook_events
  set linked_patient_count = v_linked_count
  where id = v_event_row_id;

  return query select true,v_linked_count;
end;
$$;

revoke all on function public.register_line_oa_webhook_event(
  text,text,text,text,text,timestamptz,boolean,text
) from public, anon, authenticated;
grant execute on function public.register_line_oa_webhook_event(
  text,text,text,text,text,timestamptz,boolean,text
) to service_role;

create or replace function public.finalize_line_oa_webhook_event(
  p_provider_channel_hash text,
  p_event_id_hash text,
  p_processing_status text,
  p_reply_status text,
  p_error_code text default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if p_provider_channel_hash !~ '^[0-9a-f]{64}$'
     or p_event_id_hash !~ '^[0-9a-f]{64}$'
     or p_processing_status not in ('processed','ignored','failed')
     or p_reply_status not in ('sent','not_applicable','failed')
     or (p_error_code is not null and p_error_code !~ '^[A-Z][A-Z0-9_]{2,80}$') then
    raise exception 'LINE_OA_FINALIZATION_INVALID';
  end if;

  update public.line_oa_webhook_events
  set
    processing_status = p_processing_status,
    reply_status = p_reply_status,
    error_code = p_error_code,
    processed_at = now()
  where provider_channel_hash = p_provider_channel_hash
    and event_id_hash = p_event_id_hash
    and processing_status = 'processing';

  return found;
end;
$$;

revoke all on function public.finalize_line_oa_webhook_event(
  text,text,text,text,text
) from public, anon, authenticated;
grant execute on function public.finalize_line_oa_webhook_event(
  text,text,text,text,text
) to service_role;

create or replace function public.line_oa_webhook_evidence(
  p_since timestamptz default now() - interval '1 hour'
)
returns table (
  total_events bigint,
  processed_events bigint,
  failed_events bigint,
  replied_events bigint,
  last_event_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    count(*)::bigint,
    count(*) filter (where processing_status in ('processed','ignored'))::bigint,
    count(*) filter (where processing_status = 'failed')::bigint,
    count(*) filter (where reply_status = 'sent')::bigint,
    max(created_at)
  from public.line_oa_webhook_events
  where created_at >= greatest(coalesce(p_since,now() - interval '1 hour'),now() - interval '7 days');
$$;

revoke all on function public.line_oa_webhook_evidence(timestamptz) from public, anon, authenticated;
grant execute on function public.line_oa_webhook_evidence(timestamptz) to service_role;

comment on table public.line_oa_webhook_events is
  'Sanitized LINE OA delivery/idempotency telemetry. Excludes raw user IDs, message text, reply tokens and payloads.';
comment on table public.line_oa_contact_states is
  'Keyed LINE OA follow state used to fail closed before any future proactive notification.';

commit;
