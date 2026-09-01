begin;

-- ============================================================
-- ARCHIVED SECURITY-DEFINER EXECUTION HARDENING
--
-- Archived implementations remain callable by their current owner-defined
-- wrappers. They are implementation details, not service RPCs: a runtime
-- role must never be able to invoke one directly and skip the current tenant,
-- subscription, or evidence boundary.
-- ============================================================

-- Owner-only delegation works only while each archive and its current wrapper
-- share the same trusted definer. Abort rather than silently changing owners.
do $owner_parity$
declare
  v_invalid text;
begin
  select pg_catalog.string_agg(
    archive_signature || ' -> ' || wrapper_signature,
    ', ' order by archive_signature
  )
  into v_invalid
  from (values
    ('public.export_clinic_backup_domain_v20260831(uuid,text)', 'public.export_clinic_backup_domain(uuid,text)'),
    ('public.export_clinic_backup_domain_v20260829(uuid,text)', 'public.export_clinic_backup_domain(uuid,text)'),
    ('public.export_clinic_backup_domain_v20260828(uuid,text)', 'public.export_clinic_backup_domain(uuid,text)'),
    ('public.verify_clinic_restore_trace_v20260831(uuid)', 'public.verify_clinic_restore_trace(uuid)'),
    ('public.verify_clinic_restore_trace_v20260829(uuid)', 'public.verify_clinic_restore_trace(uuid)'),
    ('public.verify_clinic_restore_trace_v20260828(uuid)', 'public.verify_clinic_restore_trace(uuid)'),
    ('public.line_oa_queue_notification_v20260829(uuid,text,timestamptz,timestamptz,text)', 'public.queue_line_oa_appointment_notification(uuid,text,timestamptz,timestamptz,text)'),
    ('public.line_oa_set_preference_v20260829(text,uuid,uuid,text,text,text,boolean)', 'public.set_line_oa_notification_preference_for_subject(text,uuid,uuid,text,text,text,boolean)'),
    ('public.line_oa_complete_link_consent_v20260829(text,text,text,boolean,uuid,text,text,text)', 'public.complete_patient_line_link_with_oa_consent(text,text,text,boolean,uuid,text,text,text)'),
    ('public.line_oa_list_preferences_v20260829(text,uuid,text,text,text)', 'public.list_line_oa_notification_preferences_for_subject(text,uuid,text,text,text)'),
    ('public.line_oa_claim_webhook_v20260829(uuid,text,text,text,text,text,timestamptz,boolean,text,text,text,text,text,text,text,jsonb)', 'public.claim_line_oa_webhook_event(uuid,text,text,text,text,text,timestamptz,boolean,text,text,text,text,text,text,text,jsonb)'),
    ('public.line_oa_finish_webhook_v20260829(uuid,text,text,text,text,text,text,boolean)', 'public.finish_line_oa_webhook_event(uuid,text,text,text,text,text,text,boolean)'),
    ('public.line_oa_claim_batch_v20260829(uuid,text,text,text,text,integer)', 'public.claim_line_oa_notification_batch(uuid,text,text,text,text,integer)'),
    ('public.line_oa_finish_notification_v20260829(uuid,text,text,integer,text,text)', 'public.finish_line_oa_notification(uuid,text,text,integer,text,text)'),
    ('public.line_oa_register_gateway_v20260829(text,text,text,text,text,timestamptz,boolean,text)', 'public.register_line_oa_webhook_event_for_clinic(uuid,text,text,text,text,text,timestamptz,boolean,text)')
  ) expected(archive_signature, wrapper_signature)
  left join pg_catalog.pg_proc archive_proc
    on archive_proc.oid=pg_catalog.to_regprocedure(archive_signature)
  left join pg_catalog.pg_proc wrapper_proc
    on wrapper_proc.oid=pg_catalog.to_regprocedure(wrapper_signature)
  left join pg_catalog.pg_roles archive_owner
    on archive_owner.oid=archive_proc.proowner
  where archive_proc.oid is null
     or wrapper_proc.oid is null
     or archive_proc.proowner <> wrapper_proc.proowner
     or archive_owner.rolname in ('anon', 'authenticated', 'service_role');

  if v_invalid is not null then
    raise exception 'ARCHIVE_DELEGATE_OWNER_MISMATCH: %', v_invalid;
  end if;
end;
$owner_parity$;

-- Backup/restore wrappers form a three-generation owner-to-owner chain.
-- Preserve that chain while closing every archived generation to runtimes.
alter function public.export_clinic_backup_domain_v20260831(uuid, text)
  set search_path = pg_catalog, public;
alter function public.export_clinic_backup_domain_v20260829(uuid, text)
  set search_path = pg_catalog, public;
alter function public.export_clinic_backup_domain_v20260828(uuid, text)
  set search_path = pg_catalog, public;
alter function public.verify_clinic_restore_trace_v20260831(uuid)
  set search_path = pg_catalog, public;
alter function public.verify_clinic_restore_trace_v20260829(uuid)
  set search_path = pg_catalog, public;
alter function public.verify_clinic_restore_trace_v20260828(uuid)
  set search_path = pg_catalog, public;

revoke all on function public.export_clinic_backup_domain_v20260831(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.export_clinic_backup_domain_v20260829(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.export_clinic_backup_domain_v20260828(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.verify_clinic_restore_trace_v20260831(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.verify_clinic_restore_trace_v20260829(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.verify_clinic_restore_trace_v20260828(uuid)
  from public, anon, authenticated, service_role;

-- The nine operational LINE implementations are owner-only delegates behind
-- the subscription-aware wrappers installed by 202609011000.
alter function public.line_oa_queue_notification_v20260829(
  uuid, text, timestamptz, timestamptz, text
) set search_path = pg_catalog, public;
alter function public.line_oa_set_preference_v20260829(
  text, uuid, uuid, text, text, text, boolean
) set search_path = pg_catalog, public;
alter function public.line_oa_complete_link_consent_v20260829(
  text, text, text, boolean, uuid, text, text, text
) set search_path = pg_catalog, public;
alter function public.line_oa_list_preferences_v20260829(
  text, uuid, text, text, text
) set search_path = pg_catalog, public;
alter function public.line_oa_claim_webhook_v20260829(
  uuid, text, text, text, text, text, timestamptz, boolean,
  text, text, text, text, text, text, text, jsonb
) set search_path = pg_catalog, public;
alter function public.line_oa_finish_webhook_v20260829(
  uuid, text, text, text, text, text, text, boolean
) set search_path = pg_catalog, public;
alter function public.line_oa_claim_batch_v20260829(
  uuid, text, text, text, text, integer
) set search_path = pg_catalog, public;
alter function public.line_oa_finish_notification_v20260829(
  uuid, text, text, integer, text, text
) set search_path = pg_catalog, public;
alter function public.line_oa_register_gateway_v20260829(
  text, text, text, text, text, timestamptz, boolean, text
) set search_path = pg_catalog, public;

revoke all on function public.line_oa_queue_notification_v20260829(
  uuid, text, timestamptz, timestamptz, text
) from public, anon, authenticated, service_role;
revoke all on function public.line_oa_set_preference_v20260829(
  text, uuid, uuid, text, text, text, boolean
) from public, anon, authenticated, service_role;
revoke all on function public.line_oa_complete_link_consent_v20260829(
  text, text, text, boolean, uuid, text, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.line_oa_list_preferences_v20260829(
  text, uuid, text, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.line_oa_claim_webhook_v20260829(
  uuid, text, text, text, text, text, timestamptz, boolean,
  text, text, text, text, text, text, text, jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.line_oa_finish_webhook_v20260829(
  uuid, text, text, text, text, text, text, boolean
) from public, anon, authenticated, service_role;
revoke all on function public.line_oa_claim_batch_v20260829(
  uuid, text, text, text, text, integer
) from public, anon, authenticated, service_role;
revoke all on function public.line_oa_finish_notification_v20260829(
  uuid, text, text, integer, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.line_oa_register_gateway_v20260829(
  text, text, text, text, text, timestamptz, boolean, text
) from public, anon, authenticated, service_role;

-- These gateway endpoints remain current service RPCs. Require both the
-- database ACL and an explicit service JWT claim so a no-claim execution
-- context cannot use SECURITY DEFINER privileges.
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
set search_path = pg_catalog, public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;

  if p_provider_channel_hash !~ '^[0-9a-f]{64}$'
     or p_event_id_hash !~ '^[0-9a-f]{64}$'
     or p_processing_status not in ('processed', 'ignored', 'failed')
     or p_reply_status not in ('sent', 'not_applicable', 'failed')
     or (
       p_error_code is not null
       and p_error_code !~ '^[A-Z][A-Z0-9_]{2,80}$'
     ) then
    raise exception 'LINE_OA_FINALIZATION_INVALID';
  end if;

  update public.line_oa_gateway_webhook_events
  set processing_status = p_processing_status,
      reply_status = p_reply_status,
      error_code = p_error_code,
      processed_at = pg_catalog.now()
  where provider_channel_hash = p_provider_channel_hash
    and event_id_hash = p_event_id_hash
    and processing_status = 'processing';

  return found;
end;
$$;

revoke all on function public.finalize_line_oa_webhook_event(
  text, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.finalize_line_oa_webhook_event(
  text, text, text, text, text
) to service_role;

create or replace function public.line_oa_webhook_evidence(
  p_since timestamptz default pg_catalog.now() - interval '1 hour'
)
returns table (
  total_events bigint,
  processed_events bigint,
  failed_events bigint,
  replied_events bigint,
  last_event_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;

  return query
  select
    pg_catalog.count(*)::bigint,
    pg_catalog.count(*) filter (
      where e.processing_status in ('processed', 'ignored')
    )::bigint,
    pg_catalog.count(*) filter (
      where e.processing_status = 'failed'
    )::bigint,
    pg_catalog.count(*) filter (
      where e.reply_status = 'sent'
    )::bigint,
    pg_catalog.max(e.created_at)
  from public.line_oa_gateway_webhook_events e
  where e.created_at >= greatest(
    coalesce(p_since, pg_catalog.now() - interval '1 hour'),
    pg_catalog.now() - interval '7 days'
  );
end;
$$;

revoke all on function public.line_oa_webhook_evidence(timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.line_oa_webhook_evidence(timestamptz)
  to service_role;

comment on function public.finalize_line_oa_webhook_event(
  text, text, text, text, text
) is 'Service-only LINE gateway finalization with an explicit service JWT gate.';

comment on function public.line_oa_webhook_evidence(timestamptz) is
  'Service-only sanitized LINE gateway evidence with an explicit service JWT gate.';

commit;

select 'ARCHIVE_DELEGATE_EXECUTION_HARDENING_READY' as status;
