begin;

-- ============================================================
-- IMMUTABLE BACKUP SLOT OUTCOMES AND REPLAY-SAFE STALE RECOVERY
--
-- One backup_export_runs row is the durable outcome for one clinic/slot.
-- Terminal evidence must never be reset by a repeated schedule invocation or
-- a replayed signed background dispatch. A genuinely new dispatch may recover
-- a stale started lease, while replaying the same request remains idempotent.
-- ============================================================

create or replace function public.begin_backup_export_run(
  p_clinic_id uuid,
  p_scheduled_for timestamptz,
  p_request_id text
)
returns table (run_id uuid, acquired boolean)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_clinic public.clinics%rowtype;
  v_run public.backup_export_runs%rowtype;
  v_request_id text := pg_catalog.btrim(p_request_id);
begin
  if auth.role() <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;
  if p_clinic_id is null then
    raise exception 'CLINIC_ID_REQUIRED';
  end if;
  if p_scheduled_for is null then
    raise exception 'BACKUP_SLOT_REQUIRED';
  end if;
  if v_request_id is null
     or p_request_id is distinct from v_request_id
     or v_request_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'BACKUP_REQUEST_ID_INVALID';
  end if;

  select * into v_clinic
  from public.clinics c
  where c.id = p_clinic_id
  for update;

  if not found or not v_clinic.active then
    raise exception 'CLINIC_NOT_FOUND';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_clinic_id::text || ':' || p_scheduled_for::text,
      0
    )
  );

  select * into v_run
  from public.backup_export_runs r
  where r.clinic_id = p_clinic_id
    and r.scheduled_for = p_scheduled_for
  for update;

  if found then
    -- These outcomes are immutable evidence for this exact clinic/slot.
    if v_run.status in ('completed', 'partial', 'failed') then
      return query select v_run.id, false;
      return;
    end if;

    -- A fresh lease is authoritative regardless of request ID. Once it is
    -- stale, only a different dispatch ID may reacquire it. The exact signed
    -- dispatch replay cannot refresh started_at or obtain another work lease.
    if v_run.status = 'started' and (
      v_run.started_at > pg_catalog.now() - interval '30 minutes'
      or v_run.request_id is not distinct from v_request_id
    ) then
      return query select v_run.id, false;
      return;
    end if;
  end if;

  if found then
    update public.backup_export_runs
    set status = 'started',
        domain_counts = '{}'::jsonb,
        object_manifest = '[]'::jsonb,
        request_id = v_request_id,
        error_code = null,
        started_at = pg_catalog.now(),
        completed_at = null
    where id = v_run.id
    returning * into v_run;
  else
    insert into public.backup_export_runs (
      clinic_id,
      scheduled_for,
      status,
      request_id
    ) values (
      p_clinic_id,
      p_scheduled_for,
      'started',
      v_request_id
    )
    returning * into v_run;
  end if;

  return query select v_run.id, true;
end;
$$;

revoke all on function public.begin_backup_export_run(uuid, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.begin_backup_export_run(uuid, timestamptz, text)
  to service_role;

comment on function public.begin_backup_export_run(uuid, timestamptz, text) is
  'Service-only backup slot lease. Terminal outcomes are immutable; stale started leases require a different request ID.';

commit;

select 'BACKUP_TERMINAL_RUN_GUARD_READY' as status;
