begin;

-- ============================================================
-- CHANANYA LINE OA OPERATIONAL MESSAGING
--
-- Scope is deliberately limited to patient access and operational service
-- notifications. Marketing/broadcast consent is not implemented here.
-- Raw LINE user IDs are encrypted by the Function before they reach Postgres;
-- chat text, reply tokens, ID tokens and webhook request bodies are never
-- persisted. The HMAC subject remains the join boundary to patient identity.
-- ============================================================

create table public.line_oa_contacts (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  environment text not null check (environment in ('staging','production')),
  deployment_id text not null check (length(deployment_id) between 2 and 80),
  channel_hash text not null check (channel_hash ~ '^[0-9a-f]{64}$'),
  subject_hash text not null check (subject_hash ~ '^[0-9a-f]{64}$'),
  friend_status text not null check (friend_status in ('active','messaged','blocked')),
  user_id_ciphertext text,
  user_id_iv text,
  user_id_auth_tag text,
  encryption_key_id text,
  first_seen_at timestamptz not null default now(),
  last_event_at timestamptz not null,
  followed_at timestamptz,
  blocked_at timestamptz,
  last_interaction_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (clinic_id, environment, deployment_id, channel_hash, subject_hash),
  check (
    (friend_status='blocked' and user_id_ciphertext is null and user_id_iv is null and user_id_auth_tag is null and encryption_key_id is null)
    or
    (friend_status<>'blocked' and user_id_ciphertext is not null and user_id_iv is not null and user_id_auth_tag is not null and encryption_key_id is not null)
  )
);

create index line_oa_contacts_delivery_idx
  on public.line_oa_contacts(clinic_id,environment,deployment_id,channel_hash,friend_status,last_interaction_at desc);

create table public.line_oa_notification_preferences (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  patient_id uuid not null,
  identity_link_id uuid not null,
  subject_hash text not null check (subject_hash ~ '^[0-9a-f]{64}$'),
  environment text not null check (environment in ('staging','production')),
  deployment_id text not null check (length(deployment_id) between 2 and 80),
  channel_hash text not null check (channel_hash ~ '^[0-9a-f]{64}$'),
  operational_enabled boolean not null default false,
  appointment_reminders_enabled boolean not null default false,
  transaction_updates_enabled boolean not null default false,
  marketing_enabled boolean not null default false check (not marketing_enabled),
  consent_version text not null default 'line-oa-operational-v1'
    check (consent_version='line-oa-operational-v1'),
  consented_at timestamptz,
  withdrawn_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (identity_link_id,environment,deployment_id,channel_hash),
  foreign key (identity_link_id,clinic_id,patient_id)
    references public.patient_identity_links(id,clinic_id,patient_id) on delete cascade,
  check (
    (operational_enabled and consented_at is not null and withdrawn_at is null and appointment_reminders_enabled)
    or
    (not operational_enabled and not appointment_reminders_enabled and not transaction_updates_enabled)
  )
);

create index line_oa_preferences_patient_idx
  on public.line_oa_notification_preferences(clinic_id,patient_id,operational_enabled);

create table public.line_oa_webhook_events (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  environment text not null check (environment in ('staging','production')),
  deployment_id text not null check (length(deployment_id) between 2 and 80),
  channel_hash text not null check (channel_hash ~ '^[0-9a-f]{64}$'),
  webhook_event_id text not null check (length(webhook_event_id) between 2 and 128),
  event_type text not null check (length(event_type) between 1 and 40),
  event_timestamp timestamptz not null,
  is_redelivery boolean not null default false,
  mode text not null check (mode in ('active','standby','unknown')),
  subject_hash text check (subject_hash is null or subject_hash ~ '^[0-9a-f]{64}$'),
  processing_status text not null default 'processing' check (processing_status in ('processing','processed','failed')),
  claim_count integer not null default 1 check (claim_count between 1 and 5),
  locked_until timestamptz,
  outcome text,
  error_code text,
  metadata jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (clinic_id,environment,deployment_id,channel_hash,webhook_event_id),
  check (not (metadata ?| array['text','message','replyToken','reply_token','userId','user_id','idToken','id_token','raw_body']))
);

create index line_oa_webhook_events_status_idx
  on public.line_oa_webhook_events(clinic_id,environment,deployment_id,processing_status,received_at desc);

create table public.line_oa_notification_outbox (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  patient_id uuid not null,
  identity_link_id uuid not null,
  appointment_id uuid not null references public.clinic_appointments(id) on delete cascade,
  environment text not null check (environment in ('staging','production')),
  deployment_id text not null check (length(deployment_id) between 2 and 80),
  channel_hash text not null check (channel_hash ~ '^[0-9a-f]{64}$'),
  notification_type text not null check (notification_type in (
    'APPOINTMENT_BOOKED','APPOINTMENT_CONFIRMED','APPOINTMENT_REMINDER',
    'APPOINTMENT_RESCHEDULED','APPOINTMENT_CANCELLED'
  )),
  status text not null default 'pending' check (status in ('pending','sending','retry','sent','dead','cancelled')),
  scheduled_for timestamptz not null,
  expires_at timestamptz not null,
  next_attempt_at timestamptz not null default now(),
  attempt_count integer not null default 0 check (attempt_count between 0 and 10),
  max_attempts integer not null default 5 check (max_attempts between 1 and 10),
  locked_by text,
  locked_until timestamptz,
  idempotency_key text not null check (length(idempotency_key) between 8 and 240),
  retry_key uuid not null default gen_random_uuid(),
  last_error_code text,
  line_request_id text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id,environment,deployment_id,channel_hash,idempotency_key),
  foreign key (identity_link_id,clinic_id,patient_id)
    references public.patient_identity_links(id,clinic_id,patient_id) on delete cascade,
  check (expires_at > scheduled_for),
  check ((status='sent' and sent_at is not null) or (status<>'sent' and sent_at is null))
);

create index line_oa_outbox_claim_idx
  on public.line_oa_notification_outbox(clinic_id,environment,deployment_id,channel_hash,status,next_attempt_at,scheduled_for);

create table public.line_oa_delivery_events (
  id bigint generated always as identity primary key,
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  patient_id uuid not null references public.patients(id) on delete cascade,
  notification_id uuid not null references public.line_oa_notification_outbox(id) on delete restrict,
  outcome text not null check (outcome in ('sent','retry','terminal_failure','expired')),
  attempt_no integer not null check (attempt_no between 0 and 10),
  http_status integer,
  error_code text,
  line_request_id text,
  occurred_at timestamptz not null default now()
);

create index line_oa_delivery_events_clinic_idx
  on public.line_oa_delivery_events(clinic_id,occurred_at desc);

alter table public.line_oa_contacts enable row level security;
alter table public.line_oa_notification_preferences enable row level security;
alter table public.line_oa_webhook_events enable row level security;
alter table public.line_oa_notification_outbox enable row level security;
alter table public.line_oa_delivery_events enable row level security;

revoke all on public.line_oa_contacts from public,anon,authenticated;
revoke all on public.line_oa_notification_preferences from public,anon,authenticated;
revoke all on public.line_oa_webhook_events from public,anon,authenticated;
revoke all on public.line_oa_notification_outbox from public,anon,authenticated;
revoke all on public.line_oa_delivery_events from public,anon,authenticated;

drop trigger if exists trg_line_oa_delivery_events_append_only on public.line_oa_delivery_events;
create trigger trg_line_oa_delivery_events_append_only
before update or delete on public.line_oa_delivery_events
for each row execute function public.reject_append_only_mutation();

create or replace function public.queue_line_oa_appointment_notification(
  p_appointment_id uuid,
  p_notification_type text,
  p_scheduled_for timestamptz,
  p_expires_at timestamptz,
  p_idempotency_suffix text
)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_inserted integer;
begin
  if p_notification_type not in (
    'APPOINTMENT_BOOKED','APPOINTMENT_CONFIRMED','APPOINTMENT_REMINDER',
    'APPOINTMENT_RESCHEDULED','APPOINTMENT_CANCELLED'
  ) then raise exception 'LINE_OA_NOTIFICATION_TYPE_INVALID'; end if;
  if p_expires_at <= p_scheduled_for then raise exception 'LINE_OA_NOTIFICATION_EXPIRY_INVALID'; end if;

  insert into public.line_oa_notification_outbox(
    clinic_id,patient_id,identity_link_id,appointment_id,
    environment,deployment_id,channel_hash,notification_type,
    scheduled_for,expires_at,next_attempt_at,idempotency_key
  )
  select
    p.clinic_id,a.patient_id,pref.identity_link_id,a.id,
    pref.environment,pref.deployment_id,pref.channel_hash,p_notification_type,
    p_scheduled_for,p_expires_at,greatest(now(),p_scheduled_for),
    'appointment:'||a.id::text||':'||lower(p_notification_type)||':'||left(coalesce(p_idempotency_suffix,'v1'),80)
  from public.clinic_appointments a
  join public.patients p on p.id=a.patient_id
  join public.line_oa_notification_preferences pref
    on pref.clinic_id=p.clinic_id and pref.patient_id=a.patient_id
   and pref.operational_enabled and pref.appointment_reminders_enabled
  join public.patient_identity_links link
    on link.id=pref.identity_link_id and link.status='active'
  where a.id=p_appointment_id
  on conflict (clinic_id,environment,deployment_id,channel_hash,idempotency_key)
  do update set
    status='pending',scheduled_for=excluded.scheduled_for,expires_at=excluded.expires_at,
    next_attempt_at=excluded.next_attempt_at,attempt_count=0,locked_by=null,locked_until=null,
    last_error_code=null,line_request_id=null,sent_at=null,updated_at=now()
  where public.line_oa_notification_outbox.status='cancelled'
    and excluded.expires_at>now();

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

revoke all on function public.queue_line_oa_appointment_notification(uuid,text,timestamptz,timestamptz,text)
  from public,anon,authenticated,service_role;

create or replace function public.set_line_oa_notification_preference_for_subject(
  p_subject_hash text,
  p_patient_id uuid,
  p_clinic_id uuid,
  p_environment text,
  p_deployment_id text,
  p_channel_hash text,
  p_enabled boolean
)
returns table (
  patient_id uuid,
  operational_messaging_enabled boolean,
  appointment_reminders_enabled boolean
)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_link public.patient_identity_links%rowtype;
  v_pref public.line_oa_notification_preferences%rowtype;
  v_appointment record;
  v_had_consent boolean := false;
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if p_subject_hash !~ '^[0-9a-f]{64}$' or p_channel_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'LINE_OA_SUBJECT_INVALID';
  end if;
  if p_environment not in ('staging','production') or length(btrim(coalesce(p_deployment_id,''))) not between 2 and 80 then
    raise exception 'LINE_OA_DEPLOYMENT_INVALID';
  end if;

  select * into v_link
  from public.patient_identity_links l
  where l.patient_id=p_patient_id
    and l.clinic_id=p_clinic_id
    and l.subject_hash=p_subject_hash
    and l.provider='line'
    and l.status='active'
  order by l.link_type='self' desc,l.verified_at desc
  limit 1
  for update;
  if not found then raise exception 'PATIENT_IDENTITY_NOT_LINKED'; end if;

  select exists(
    select 1
    from public.line_oa_notification_preferences pref
    where pref.identity_link_id=v_link.id
      and pref.environment=p_environment
      and pref.deployment_id=p_deployment_id
      and pref.channel_hash=p_channel_hash
      and pref.consented_at is not null
  ) into v_had_consent;

  insert into public.line_oa_notification_preferences(
    clinic_id,patient_id,identity_link_id,subject_hash,
    environment,deployment_id,channel_hash,
    operational_enabled,appointment_reminders_enabled,transaction_updates_enabled,
    consented_at,withdrawn_at,updated_at
  ) values (
    v_link.clinic_id,v_link.patient_id,v_link.id,p_subject_hash,
    p_environment,btrim(p_deployment_id),p_channel_hash,
    p_enabled,p_enabled,false,
    case when p_enabled then now() else null end,
    case when p_enabled then null else now() end,
    now()
  )
  on conflict (identity_link_id,environment,deployment_id,channel_hash)
  do update set
    subject_hash=excluded.subject_hash,
    operational_enabled=excluded.operational_enabled,
    appointment_reminders_enabled=excluded.appointment_reminders_enabled,
    transaction_updates_enabled=false,
    marketing_enabled=false,
    consented_at=case when excluded.operational_enabled then now() else public.line_oa_notification_preferences.consented_at end,
    withdrawn_at=case when excluded.operational_enabled then null else now() end,
    updated_at=now()
  returning * into v_pref;

  if not p_enabled then
    update public.line_oa_notification_outbox o
    set status='cancelled',locked_by=null,locked_until=null,updated_at=now()
    where o.identity_link_id=v_link.id
      and o.environment=p_environment
      and o.deployment_id=p_deployment_id
      and o.channel_hash=p_channel_hash
      and o.status in ('pending','retry','sending');
  else
    for v_appointment in
      select a.id,a.scheduled_start
      from public.clinic_appointments a
      where a.patient_id=p_patient_id
        and a.status in ('booked','confirmed')
        and a.scheduled_start>now()
        and a.scheduled_start<=now()+interval '60 days'
    loop
      perform public.queue_line_oa_appointment_notification(
        v_appointment.id,'APPOINTMENT_REMINDER',
        greatest(now(),v_appointment.scheduled_start-interval '24 hours'),
        v_appointment.scheduled_start,
        extract(epoch from v_appointment.scheduled_start)::bigint::text
      );
    end loop;
  end if;

  insert into public.patient_identity_events(
    clinic_id,patient_id,event_type,identity_link_id,metadata
  ) values (
    v_link.clinic_id,v_link.patient_id,
    case
      when p_enabled then 'LINE_OA_OPERATIONAL_CONSENT_GRANTED'
      when v_had_consent then 'LINE_OA_OPERATIONAL_CONSENT_WITHDRAWN'
      else 'LINE_OA_OPERATIONAL_CONSENT_DECLINED'
    end,
    v_link.id,
    jsonb_build_object(
      'environment',p_environment,'deployment_id',p_deployment_id,
      'channel_hash',p_channel_hash,'consent_version',v_pref.consent_version,'marketing',false
    )
  );

  insert into public.audit_logs(clinic_id,user_id,action,entity,entity_id,metadata)
  values (
    v_link.clinic_id,null,
    case
      when p_enabled then 'line_oa_operational_consent_granted'
      when v_had_consent then 'line_oa_operational_consent_withdrawn'
      else 'line_oa_operational_consent_declined'
    end,
    'line_oa_notification_preferences',v_pref.id::text,
    jsonb_build_object('patient_id',v_link.patient_id,'environment',p_environment,'deployment_id',p_deployment_id)
  );

  return query select v_link.patient_id,v_pref.operational_enabled,v_pref.appointment_reminders_enabled;
end;
$$;

revoke all on function public.set_line_oa_notification_preference_for_subject(text,uuid,uuid,text,text,text,boolean)
  from public,anon,authenticated;
grant execute on function public.set_line_oa_notification_preference_for_subject(text,uuid,uuid,text,text,text,boolean)
  to service_role;

-- Link-code consumption and the optional OA consent must commit together. If
-- the OA clinic/environment boundary fails, the one-time code remains usable.
create or replace function public.complete_patient_line_link_with_oa_consent(
  p_link_code text,
  p_subject_hash text,
  p_provider_channel text,
  p_subject_consent_confirmed boolean,
  p_clinic_id uuid,
  p_environment text,
  p_deployment_id text,
  p_channel_hash text
)
returns table (patient_id uuid, clinic_id uuid, link_type text)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_link record;
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  select * into v_link
  from public.complete_patient_line_link(
    p_link_code,p_subject_hash,p_provider_channel,p_subject_consent_confirmed
  );
  if v_link.clinic_id<>p_clinic_id then raise exception 'LINE_OA_CLINIC_MISMATCH'; end if;
  perform public.set_line_oa_notification_preference_for_subject(
    p_subject_hash,v_link.patient_id,p_clinic_id,
    p_environment,p_deployment_id,p_channel_hash,true
  );
  return query select v_link.patient_id,v_link.clinic_id,v_link.link_type;
end;
$$;

revoke all on function public.complete_patient_line_link_with_oa_consent(text,text,text,boolean,uuid,text,text,text)
  from public,anon,authenticated;
grant execute on function public.complete_patient_line_link_with_oa_consent(text,text,text,boolean,uuid,text,text,text)
  to service_role;

create or replace function public.list_line_oa_notification_preferences_for_subject(
  p_subject_hash text,
  p_clinic_id uuid,
  p_environment text,
  p_deployment_id text,
  p_channel_hash text
)
returns table (patient_id uuid, operational_messaging_enabled boolean)
language sql
stable
security definer
set search_path = public
as $$
  select l.patient_id,coalesce(pref.operational_enabled,false)
  from public.patient_identity_links l
  left join public.line_oa_notification_preferences pref
    on pref.identity_link_id=l.id
   and pref.environment=p_environment
   and pref.deployment_id=p_deployment_id
   and pref.channel_hash=p_channel_hash
  where auth.role()='service_role'
    and l.provider='line'
    and l.clinic_id=p_clinic_id
    and l.subject_hash=p_subject_hash
    and l.status='active'
  order by l.link_type='self' desc,l.verified_at desc;
$$;

revoke all on function public.list_line_oa_notification_preferences_for_subject(text,uuid,text,text,text)
  from public,anon,authenticated;
grant execute on function public.list_line_oa_notification_preferences_for_subject(text,uuid,text,text,text)
  to service_role;

create or replace function public.claim_line_oa_webhook_event(
  p_clinic_id uuid,
  p_environment text,
  p_deployment_id text,
  p_channel_hash text,
  p_webhook_event_id text,
  p_event_type text,
  p_event_timestamp timestamptz,
  p_is_redelivery boolean,
  p_mode text,
  p_subject_hash text,
  p_contact_state text,
  p_user_id_ciphertext text,
  p_user_id_iv text,
  p_user_id_auth_tag text,
  p_encryption_key_id text,
  p_metadata jsonb
)
returns table (claimed boolean,linked_patient_count integer)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_event public.line_oa_webhook_events%rowtype;
  v_inserted_id uuid;
  v_contact_changed uuid;
  v_linked integer := 0;
  v_friend_status text;
  v_appointment record;
  v_preference record;
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if not exists(select 1 from public.clinics c where c.id=p_clinic_id and c.active) then raise exception 'CLINIC_NOT_FOUND'; end if;
  if p_environment not in ('staging','production') or p_channel_hash !~ '^[0-9a-f]{64}$' then raise exception 'LINE_OA_DEPLOYMENT_INVALID'; end if;
  if length(btrim(coalesce(p_deployment_id,''))) not between 2 and 80
     or length(btrim(coalesce(p_webhook_event_id,''))) not between 2 and 128 then raise exception 'LINE_OA_WEBHOOK_EVENT_INVALID'; end if;
  if p_mode not in ('active','standby','unknown') or p_contact_state not in ('active','blocked','interacted','none') then raise exception 'LINE_OA_WEBHOOK_EVENT_INVALID'; end if;
  if p_subject_hash is not null and p_subject_hash !~ '^[0-9a-f]{64}$' then raise exception 'LINE_OA_SUBJECT_INVALID'; end if;
  if coalesce(p_metadata,'{}'::jsonb) ?| array['text','message','replyToken','reply_token','userId','user_id','idToken','id_token','raw_body'] then
    raise exception 'LINE_OA_PERSISTED_METADATA_FORBIDDEN';
  end if;

  if p_subject_hash is not null and p_contact_state in ('active','interacted') then
    if nullif(p_user_id_ciphertext,'') is null or nullif(p_user_id_iv,'') is null
       or nullif(p_user_id_auth_tag,'') is null or nullif(p_encryption_key_id,'') is null then
      raise exception 'LINE_OA_ENCRYPTED_RECIPIENT_REQUIRED';
    end if;
    v_friend_status := case when p_contact_state='active' then 'active' else 'messaged' end;
    insert into public.line_oa_contacts(
      clinic_id,environment,deployment_id,channel_hash,subject_hash,friend_status,
      user_id_ciphertext,user_id_iv,user_id_auth_tag,encryption_key_id,
      last_event_at,followed_at,last_interaction_at,updated_at
    ) values (
      p_clinic_id,p_environment,p_deployment_id,p_channel_hash,p_subject_hash,v_friend_status,
      p_user_id_ciphertext,p_user_id_iv,p_user_id_auth_tag,p_encryption_key_id,
      p_event_timestamp,case when p_contact_state='active' then p_event_timestamp else null end,
      p_event_timestamp,now()
    )
    on conflict (clinic_id,environment,deployment_id,channel_hash,subject_hash)
    do update set
      friend_status=case when p_contact_state='active' then 'active' when public.line_oa_contacts.friend_status='active' then 'active' else 'messaged' end,
      user_id_ciphertext=excluded.user_id_ciphertext,
      user_id_iv=excluded.user_id_iv,
      user_id_auth_tag=excluded.user_id_auth_tag,
      encryption_key_id=excluded.encryption_key_id,
      last_event_at=excluded.last_event_at,
      followed_at=case when p_contact_state='active' then coalesce(public.line_oa_contacts.followed_at,excluded.last_event_at) else public.line_oa_contacts.followed_at end,
      blocked_at=null,
      last_interaction_at=excluded.last_interaction_at,
      updated_at=now()
    where public.line_oa_contacts.last_event_at<excluded.last_event_at
       or (
         public.line_oa_contacts.last_event_at=excluded.last_event_at
         and public.line_oa_contacts.friend_status<>'blocked'
       )
    returning id into v_contact_changed;
  elsif p_subject_hash is not null and p_contact_state='blocked' then
    insert into public.line_oa_contacts(
      clinic_id,environment,deployment_id,channel_hash,subject_hash,friend_status,
      last_event_at,blocked_at,updated_at
    ) values (
      p_clinic_id,p_environment,p_deployment_id,p_channel_hash,p_subject_hash,'blocked',
      p_event_timestamp,p_event_timestamp,now()
    )
    on conflict (clinic_id,environment,deployment_id,channel_hash,subject_hash)
    do update set
      friend_status='blocked',user_id_ciphertext=null,user_id_iv=null,
      user_id_auth_tag=null,encryption_key_id=null,last_event_at=excluded.last_event_at,
      blocked_at=excluded.blocked_at,updated_at=now()
    where public.line_oa_contacts.last_event_at<excluded.last_event_at
       or (
         public.line_oa_contacts.last_event_at=excluded.last_event_at
         and public.line_oa_contacts.friend_status<>'blocked'
       )
    returning id into v_contact_changed;

    if v_contact_changed is not null then
      for v_preference in
        select *
        from public.line_oa_notification_preferences pref
        where pref.subject_hash=p_subject_hash
          and pref.environment=p_environment
          and pref.deployment_id=p_deployment_id
          and pref.channel_hash=p_channel_hash
          and pref.operational_enabled
        for update
      loop
        update public.line_oa_notification_preferences
        set operational_enabled=false,appointment_reminders_enabled=false,
            transaction_updates_enabled=false,marketing_enabled=false,
            withdrawn_at=p_event_timestamp,updated_at=now()
        where id=v_preference.id;
        update public.line_oa_notification_outbox
        set status='cancelled',locked_by=null,locked_until=null,updated_at=now()
        where identity_link_id=v_preference.identity_link_id
          and environment=p_environment and deployment_id=p_deployment_id
          and channel_hash=p_channel_hash and status in ('pending','retry','sending');
        insert into public.patient_identity_events(
          clinic_id,patient_id,event_type,identity_link_id,metadata
        ) values (
          v_preference.clinic_id,v_preference.patient_id,
          'LINE_OA_OPERATIONAL_CONSENT_WITHDRAWN',v_preference.identity_link_id,
          jsonb_build_object(
            'environment',p_environment,'deployment_id',p_deployment_id,
            'channel_hash',p_channel_hash,'consent_version',v_preference.consent_version,
            'reason','oa_blocked','marketing',false
          )
        );
        insert into public.audit_logs(clinic_id,user_id,action,entity,entity_id,metadata)
        values (
          v_preference.clinic_id,null,'line_oa_operational_consent_withdrawn',
          'line_oa_notification_preferences',v_preference.id::text,
          jsonb_build_object(
            'patient_id',v_preference.patient_id,'environment',p_environment,
            'deployment_id',p_deployment_id,'reason','oa_blocked'
          )
        );
      end loop;
    end if;
  end if;

  insert into public.line_oa_webhook_events(
    clinic_id,environment,deployment_id,channel_hash,webhook_event_id,
    event_type,event_timestamp,is_redelivery,mode,subject_hash,
    processing_status,claim_count,locked_until,metadata
  ) values (
    p_clinic_id,p_environment,p_deployment_id,p_channel_hash,btrim(p_webhook_event_id),
    left(coalesce(nullif(p_event_type,''),'unknown'),40),p_event_timestamp,p_is_redelivery,p_mode,p_subject_hash,
    'processing',1,now()+interval '2 minutes',coalesce(p_metadata,'{}'::jsonb)
  )
  on conflict (clinic_id,environment,deployment_id,channel_hash,webhook_event_id) do nothing
  returning id into v_inserted_id;

  if v_inserted_id is null then
    select * into v_event
    from public.line_oa_webhook_events e
    where e.clinic_id=p_clinic_id and e.environment=p_environment
      and e.deployment_id=p_deployment_id and e.channel_hash=p_channel_hash
      and e.webhook_event_id=p_webhook_event_id
    for update;
    if v_event.processing_status='processed'
       or (v_event.processing_status='processing' and v_event.locked_until>now())
       or v_event.claim_count>=5 then
      return query select false,0;
      return;
    end if;
    update public.line_oa_webhook_events
    set processing_status='processing',claim_count=claim_count+1,
        locked_until=now()+interval '2 minutes',is_redelivery=(is_redelivery or p_is_redelivery),
        error_code=null
    where id=v_event.id;
  end if;

  if p_subject_hash is not null then
    select count(*)::integer into v_linked
    from public.patient_identity_links l
    where l.clinic_id=p_clinic_id and l.provider='line'
      and l.subject_hash=p_subject_hash and l.status='active';
  end if;

  if p_contact_state='active' and p_subject_hash is not null and v_contact_changed is not null then
    for v_appointment in
      select a.id,a.scheduled_start
      from public.clinic_appointments a
      join public.patients p on p.id=a.patient_id and p.clinic_id=p_clinic_id
      join public.line_oa_notification_preferences pref
        on pref.patient_id=a.patient_id and pref.subject_hash=p_subject_hash
       and pref.environment=p_environment and pref.deployment_id=p_deployment_id
       and pref.channel_hash=p_channel_hash and pref.operational_enabled
       and pref.appointment_reminders_enabled
      where a.status in ('booked','confirmed')
        and a.scheduled_start>now() and a.scheduled_start<=now()+interval '60 days'
    loop
      perform public.queue_line_oa_appointment_notification(
        v_appointment.id,'APPOINTMENT_REMINDER',
        greatest(now(),v_appointment.scheduled_start-interval '24 hours'),
        v_appointment.scheduled_start,
        extract(epoch from v_appointment.scheduled_start)::bigint::text
      );
    end loop;
  end if;

  return query select true,v_linked;
end;
$$;

revoke all on function public.claim_line_oa_webhook_event(uuid,text,text,text,text,text,timestamptz,boolean,text,text,text,text,text,text,text,jsonb)
  from public,anon,authenticated;
grant execute on function public.claim_line_oa_webhook_event(uuid,text,text,text,text,text,timestamptz,boolean,text,text,text,text,text,text,text,jsonb)
  to service_role;

create or replace function public.finish_line_oa_webhook_event(
  p_clinic_id uuid,
  p_environment text,
  p_deployment_id text,
  p_channel_hash text,
  p_webhook_event_id text,
  p_outcome text,
  p_error_code text,
  p_retryable boolean
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare v_updated integer;
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  update public.line_oa_webhook_events e
  set processing_status=case when p_retryable then 'failed' else 'processed' end,
      outcome=left(coalesce(p_outcome,'unknown'),80),
      error_code=case when p_error_code is null then null else left(p_error_code,120) end,
      locked_until=null,
      processed_at=case when p_retryable then null else now() end
  where e.clinic_id=p_clinic_id and e.environment=p_environment
    and e.deployment_id=p_deployment_id and e.channel_hash=p_channel_hash
    and e.webhook_event_id=p_webhook_event_id
    and e.processing_status='processing';
  get diagnostics v_updated=row_count;
  return v_updated=1;
end;
$$;

revoke all on function public.finish_line_oa_webhook_event(uuid,text,text,text,text,text,text,boolean)
  from public,anon,authenticated;
grant execute on function public.finish_line_oa_webhook_event(uuid,text,text,text,text,text,text,boolean)
  to service_role;

create or replace function public.enqueue_line_oa_from_appointment()
returns trigger
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_change_suffix text;
  v_schedule_suffix text;
begin
  v_change_suffix := (extract(epoch from new.updated_at)*1000000)::bigint::text;
  v_schedule_suffix := extract(epoch from new.scheduled_start)::bigint::text;
  if tg_op='INSERT' then
    if new.status='booked' then
      perform public.queue_line_oa_appointment_notification(
        new.id,'APPOINTMENT_BOOKED',now(),new.scheduled_start,v_change_suffix
      );
    elsif new.status='confirmed' then
      perform public.queue_line_oa_appointment_notification(
        new.id,'APPOINTMENT_CONFIRMED',now(),new.scheduled_start,v_change_suffix
      );
    elsif new.status in ('cancelled','rescheduled') then
      perform public.queue_line_oa_appointment_notification(
        new.id,
        case when new.status='cancelled' then 'APPOINTMENT_CANCELLED' else 'APPOINTMENT_RESCHEDULED' end,
        now(),now()+interval '7 days',v_change_suffix
      );
    end if;
    if new.status in ('booked','confirmed') and new.scheduled_start>now()+interval '1 minute' then
      perform public.queue_line_oa_appointment_notification(
        new.id,'APPOINTMENT_REMINDER',greatest(now(),new.scheduled_start-interval '24 hours'),
        new.scheduled_start,v_schedule_suffix
      );
    end if;
  else
    if new.status is distinct from old.status
       and new.status in ('checked_in','in_service','completed','cancelled','no_show','rescheduled') then
      update public.line_oa_notification_outbox
      set status='cancelled',locked_by=null,locked_until=null,updated_at=now()
      where appointment_id=new.id and status in ('pending','retry','sending');
      if new.status in ('cancelled','rescheduled') then
        perform public.queue_line_oa_appointment_notification(
          new.id,
          case when new.status='cancelled' then 'APPOINTMENT_CANCELLED' else 'APPOINTMENT_RESCHEDULED' end,
          now(),now()+interval '7 days',v_change_suffix
        );
      end if;
    elsif new.scheduled_start is distinct from old.scheduled_start then
      update public.line_oa_notification_outbox
      set status='cancelled',locked_by=null,locked_until=null,updated_at=now()
      where appointment_id=new.id and status in ('pending','retry','sending');
      if new.status in ('booked','confirmed') then
        perform public.queue_line_oa_appointment_notification(
          new.id,'APPOINTMENT_RESCHEDULED',now(),new.scheduled_start,v_change_suffix
        );
        if new.scheduled_start>now()+interval '1 minute' then
          perform public.queue_line_oa_appointment_notification(
            new.id,'APPOINTMENT_REMINDER',greatest(now(),new.scheduled_start-interval '24 hours'),
            new.scheduled_start,v_schedule_suffix
          );
        end if;
      end if;
    elsif new.status is distinct from old.status and new.status='confirmed' then
      perform public.queue_line_oa_appointment_notification(
        new.id,'APPOINTMENT_CONFIRMED',now(),new.scheduled_start,v_change_suffix
      );
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.enqueue_line_oa_from_appointment() from public,anon,authenticated,service_role;

drop trigger if exists trg_enqueue_line_oa_from_appointment on public.clinic_appointments;
create trigger trg_enqueue_line_oa_from_appointment
after insert or update of scheduled_start,status on public.clinic_appointments
for each row execute function public.enqueue_line_oa_from_appointment();

create or replace function public.claim_line_oa_notification_batch(
  p_clinic_id uuid,
  p_environment text,
  p_deployment_id text,
  p_channel_hash text,
  p_worker_id text,
  p_limit integer default 8
)
returns table (
  notification_id uuid,
  notification_type text,
  appointment_no text,
  scheduled_start timestamptz,
  subject_hash text,
  user_id_ciphertext text,
  user_id_iv text,
  user_id_auth_tag text,
  encryption_key_id text,
  retry_key uuid
)
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if p_environment not in ('staging','production') or p_channel_hash !~ '^[0-9a-f]{64}$'
     or length(btrim(coalesce(p_worker_id,''))) not between 2 and 120
     or p_limit not between 1 and 20 then raise exception 'LINE_OA_DISPATCH_CLAIM_INVALID'; end if;

  with expired as (
    update public.line_oa_notification_outbox o
    set status='cancelled',locked_by=null,locked_until=null,updated_at=now()
    where o.clinic_id=p_clinic_id and o.environment=p_environment
      and o.deployment_id=p_deployment_id and o.channel_hash=p_channel_hash
      and o.status in ('pending','retry','sending') and o.expires_at<=now()
    returning o.*
  )
  insert into public.line_oa_delivery_events(
    clinic_id,patient_id,notification_id,outcome,attempt_no,error_code
  )
  select clinic_id,patient_id,id,'expired',attempt_count,'LINE_OA_NOTIFICATION_EXPIRED'
  from expired;

  return query
  with candidates as (
    select o.id
    from public.line_oa_notification_outbox o
    join public.line_oa_notification_preferences pref
      on pref.identity_link_id=o.identity_link_id
     and pref.environment=o.environment and pref.deployment_id=o.deployment_id
     and pref.channel_hash=o.channel_hash
     and pref.operational_enabled and pref.appointment_reminders_enabled
    join public.patient_identity_links link
      on link.id=o.identity_link_id and link.status='active'
    join public.line_oa_contacts contact
      on contact.clinic_id=o.clinic_id and contact.environment=o.environment
     and contact.deployment_id=o.deployment_id and contact.channel_hash=o.channel_hash
     and contact.subject_hash=pref.subject_hash
     and (
       contact.friend_status='active'
       or (contact.friend_status='messaged' and contact.last_interaction_at>=now()-interval '7 days')
     )
    where o.clinic_id=p_clinic_id and o.environment=p_environment
      and o.deployment_id=p_deployment_id and o.channel_hash=p_channel_hash
      and (
        o.status in ('pending','retry')
        or (o.status='sending' and o.locked_until<=now())
      )
      and o.scheduled_for<=now() and o.next_attempt_at<=now()
      and o.expires_at>now() and o.attempt_count<o.max_attempts
    order by o.scheduled_for,o.created_at
    for update of o skip locked
    limit p_limit
  ), claimed as (
    update public.line_oa_notification_outbox o
    set status='sending',attempt_count=o.attempt_count+1,
        locked_by=p_worker_id,locked_until=now()+interval '2 minutes',updated_at=now()
    from candidates c
    where o.id=c.id
    returning o.*
  )
  select
    o.id,o.notification_type,a.appointment_no,a.scheduled_start,
    pref.subject_hash,contact.user_id_ciphertext,contact.user_id_iv,
    contact.user_id_auth_tag,contact.encryption_key_id,o.retry_key
  from claimed o
  join public.clinic_appointments a on a.id=o.appointment_id
  join public.line_oa_notification_preferences pref
    on pref.identity_link_id=o.identity_link_id
   and pref.environment=o.environment and pref.deployment_id=o.deployment_id
   and pref.channel_hash=o.channel_hash
  join public.line_oa_contacts contact
    on contact.clinic_id=o.clinic_id and contact.environment=o.environment
   and contact.deployment_id=o.deployment_id and contact.channel_hash=o.channel_hash
   and contact.subject_hash=pref.subject_hash
  order by o.scheduled_for,o.created_at;
end;
$$;

revoke all on function public.claim_line_oa_notification_batch(uuid,text,text,text,text,integer)
  from public,anon,authenticated;
grant execute on function public.claim_line_oa_notification_batch(uuid,text,text,text,text,integer)
  to service_role;

create or replace function public.finish_line_oa_notification(
  p_notification_id uuid,
  p_worker_id text,
  p_outcome text,
  p_http_status integer,
  p_error_code text,
  p_line_request_id text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_notification public.line_oa_notification_outbox%rowtype;
  v_final_status text;
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if p_outcome not in ('sent','retry','terminal_failure') then raise exception 'LINE_OA_DELIVERY_OUTCOME_INVALID'; end if;
  select * into v_notification
  from public.line_oa_notification_outbox o
  where o.id=p_notification_id and o.status='sending' and o.locked_by=p_worker_id
  for update;
  if not found then return false; end if;

  v_final_status := case
    when p_outcome='sent' then 'sent'
    when p_outcome='terminal_failure' then 'dead'
    when v_notification.attempt_count>=v_notification.max_attempts or v_notification.expires_at<=now() then 'dead'
    else 'retry'
  end;

  update public.line_oa_notification_outbox
  set status=v_final_status,
      next_attempt_at=case when v_final_status='retry' then
        now()+make_interval(secs=>least(3600,(30*power(2,least(v_notification.attempt_count,6)))::integer))
        else next_attempt_at end,
      locked_by=null,locked_until=null,
      last_error_code=case when p_error_code is null then null else left(p_error_code,120) end,
      line_request_id=case when p_line_request_id is null then null else left(p_line_request_id,180) end,
      sent_at=case when v_final_status='sent' then now() else null end,
      updated_at=now()
  where id=v_notification.id;

  insert into public.line_oa_delivery_events(
    clinic_id,patient_id,notification_id,outcome,attempt_no,http_status,error_code,line_request_id
  ) values (
    v_notification.clinic_id,v_notification.patient_id,v_notification.id,
    case when v_final_status='sent' then 'sent' when v_final_status='retry' then 'retry' else 'terminal_failure' end,
    v_notification.attempt_count,p_http_status,
    case when p_error_code is null then null else left(p_error_code,120) end,
    case when p_line_request_id is null then null else left(p_line_request_id,180) end
  );

  if v_final_status='sent' then
    insert into public.patient_identity_events(clinic_id,patient_id,event_type,identity_link_id,metadata)
    values (
      v_notification.clinic_id,v_notification.patient_id,'LINE_OA_NOTIFICATION_SENT',v_notification.identity_link_id,
      jsonb_build_object(
        'notification_type',v_notification.notification_type,
        'environment',v_notification.environment,
        'deployment_id',v_notification.deployment_id,
        'notification_id',v_notification.id
      )
    );
  end if;
  return true;
end;
$$;

revoke all on function public.finish_line_oa_notification(uuid,text,text,integer,text,text)
  from public,anon,authenticated;
grant execute on function public.finish_line_oa_notification(uuid,text,text,integer,text,text)
  to service_role;

create or replace function public.line_oa_operational_healthcheck()
returns table (
  ready boolean,
  contact_count bigint,
  consent_count bigint,
  pending_count bigint,
  dead_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    true,
    (select count(*) from public.line_oa_contacts c where c.clinic_id=public.current_clinic_id()),
    (select count(*) from public.line_oa_notification_preferences p where p.clinic_id=public.current_clinic_id() and p.operational_enabled),
    (select count(*) from public.line_oa_notification_outbox o where o.clinic_id=public.current_clinic_id() and o.status in ('pending','retry','sending')),
    (select count(*) from public.line_oa_notification_outbox o where o.clinic_id=public.current_clinic_id() and o.status='dead')
  where auth.role()='service_role' or public.is_super_admin();
$$;

revoke all on function public.line_oa_operational_healthcheck() from public,anon;
grant execute on function public.line_oa_operational_healthcheck() to authenticated,service_role;

-- Identity revocation must also withdraw operational messaging and cancel any
-- queued delivery for that identity link. Historical delivery evidence stays.
create or replace function public.withdraw_line_oa_on_identity_revoke()
returns trigger
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if old.status='active' and new.status='revoked' then
    update public.line_oa_notification_preferences
    set operational_enabled=false,appointment_reminders_enabled=false,
        transaction_updates_enabled=false,marketing_enabled=false,
        withdrawn_at=now(),updated_at=now()
    where identity_link_id=new.id and operational_enabled;
    update public.line_oa_notification_outbox
    set status='cancelled',locked_by=null,locked_until=null,updated_at=now()
    where identity_link_id=new.id and status in ('pending','retry','sending');
  end if;
  return new;
end;
$$;

revoke all on function public.withdraw_line_oa_on_identity_revoke() from public,anon,authenticated,service_role;

drop trigger if exists trg_withdraw_line_oa_on_identity_revoke on public.patient_identity_links;
create trigger trg_withdraw_line_oa_on_identity_revoke
after update of status on public.patient_identity_links
for each row execute function public.withdraw_line_oa_on_identity_revoke();

-- Extend the encrypted Drive recovery contract without duplicating the large
-- v20260828 tenant-filtered exporter. Recipient identifiers remain ciphertext;
-- encryption keys stay exclusively in the secret manager.
alter function public.export_clinic_backup_domain(uuid,text)
  rename to export_clinic_backup_domain_v20260828;

create or replace function public.export_clinic_backup_domain(
  p_clinic_id uuid,
  p_domain text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_export jsonb;
  v_data jsonb;
  v_included jsonb;
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  v_export := public.export_clinic_backup_domain_v20260828(p_clinic_id,p_domain);
  v_data := coalesce(v_export->'data','{}'::jsonb);
  if p_domain='patients' then
    v_data := v_data || jsonb_build_object(
      'line_oa_contacts',coalesce((
        select jsonb_agg(to_jsonb(c) order by c.id)
        from public.line_oa_contacts c where c.clinic_id=p_clinic_id
      ),'[]'::jsonb),
      'line_oa_notification_preferences',coalesce((
        select jsonb_agg(to_jsonb(p) order by p.id)
        from public.line_oa_notification_preferences p where p.clinic_id=p_clinic_id
      ),'[]'::jsonb)
    );
  elsif p_domain='transactions' then
    v_data := v_data || jsonb_build_object(
      'line_oa_webhook_events',coalesce((
        select jsonb_agg(to_jsonb(e) order by e.received_at,e.id)
        from public.line_oa_webhook_events e where e.clinic_id=p_clinic_id
      ),'[]'::jsonb),
      'line_oa_notification_outbox',coalesce((
        select jsonb_agg(to_jsonb(o) order by o.created_at,o.id)
        from public.line_oa_notification_outbox o where o.clinic_id=p_clinic_id
      ),'[]'::jsonb),
      'line_oa_delivery_events',coalesce((
        select jsonb_agg(to_jsonb(d) order by d.id)
        from public.line_oa_delivery_events d where d.clinic_id=p_clinic_id
      ),'[]'::jsonb)
    );
  end if;
  select coalesce(jsonb_agg(k order by k),'[]'::jsonb)
  into v_included from jsonb_object_keys(v_data) as keys(k);
  return jsonb_set(
    jsonb_set(
      jsonb_set(v_export,'{schema_version}','"2026-08-29.1"'::jsonb),
      '{included_tables}',v_included
    ),
    '{data}',v_data
  ) || jsonb_build_object(
    'line_oa_recovery',jsonb_build_object(
      'recipient_identifiers','AES-256-GCM ciphertext only',
      'decryption_key','secret-manager recovery required',
      'chat_text_persisted',false,
      'marketing_enabled',false
    )
  );
end;
$$;

revoke all on function public.export_clinic_backup_domain(uuid,text) from public,anon,authenticated;
grant execute on function public.export_clinic_backup_domain(uuid,text) to service_role;

create or replace function public.backup_restore_contract_healthcheck()
returns table (
  ready boolean,
  schema_version text,
  domain_count integer,
  patient_table_count integer,
  product_table_count integer,
  pharmacy_table_count integer,
  transaction_table_count integer,
  managed_database_restore_required boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select true,'2026-08-29.1',4,31,16,7,10,true
  where auth.role()='service_role' or public.is_super_admin();
$$;

revoke all on function public.backup_restore_contract_healthcheck() from public,anon;
grant execute on function public.backup_restore_contract_healthcheck() to authenticated,service_role;

alter function public.verify_clinic_restore_trace(uuid)
  rename to verify_clinic_restore_trace_v20260828;

create or replace function public.verify_clinic_restore_trace(p_clinic_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_trace jsonb;
  v_counts jsonb;
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  v_trace := public.verify_clinic_restore_trace_v20260828(p_clinic_id);
  v_counts := coalesce(v_trace->'counts','{}'::jsonb) || jsonb_build_object(
    'line_oa_contacts',(select count(*) from public.line_oa_contacts c where c.clinic_id=p_clinic_id),
    'line_oa_notification_preferences',(select count(*) from public.line_oa_notification_preferences p where p.clinic_id=p_clinic_id),
    'line_oa_webhook_events',(select count(*) from public.line_oa_webhook_events e where e.clinic_id=p_clinic_id),
    'line_oa_notification_outbox',(select count(*) from public.line_oa_notification_outbox o where o.clinic_id=p_clinic_id),
    'line_oa_delivery_events',(select count(*) from public.line_oa_delivery_events d where d.clinic_id=p_clinic_id)
  );
  return jsonb_set(
    jsonb_set(v_trace,'{schema_version}','"2026-08-29.1"'::jsonb),
    '{counts}',v_counts
  );
end;
$$;

revoke all on function public.verify_clinic_restore_trace(uuid) from public,anon,authenticated;
grant execute on function public.verify_clinic_restore_trace(uuid) to service_role;

commit;
