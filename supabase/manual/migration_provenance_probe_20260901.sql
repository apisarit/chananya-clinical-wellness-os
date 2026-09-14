-- Read-only migration provenance probe for the 2026-09-01 closure sequence.
-- This does not prove migration fingerprints by itself. It distinguishes a
-- schema that appears manually advanced from one that has not received the
-- expected objects, before the guarded ledger-recovery generator is used.

with expected_functions(signature) as (
  values
    ('public.list_owner_drive_assignments()'),
    ('public.get_clinic_drive_backup_destination(uuid,text)'),
    ('public.set_clinic_drive_assignment(uuid,uuid,text,text,text,text,text,text,text,bigint,text,uuid,text)'),
    ('public.set_clinic_subscription_state_v20260901(uuid,uuid,text,boolean,bigint,text,uuid,text)'),
    ('public.guard_owner_subscription_forward_only()'),
    ('public.assert_clinic_subscription_active(uuid)'),
    ('public.prepare_line_subscription_off_exception(uuid,text)'),
    ('public.enforce_authenticated_subscription_statement_write()'),
    ('public.get_exact_backup_restore_source(text,timestamptz,text)')
), expected_relations(relation_name) as (
  values
    ('public.clinic_drive_backup_destinations'),
    ('public.clinic_drive_destination_events'),
    ('public.owner_control_historical_replay_guard')
), expected_columns(table_name, column_name) as (
  values
    ('clinics', 'subscription_version'),
    ('clinic_subscription_control_events', 'expected_version'),
    ('practitioner_schedules', 'clinic_id'),
    ('clinic_appointments', 'clinic_id'),
    ('appointment_events', 'clinic_id'),
    ('approval_tasks', 'clinic_id'),
    ('approval_actions', 'clinic_id')
), results as (
  select
    'function'::text as object_type,
    signature as object_name,
    to_regprocedure(signature) is not null as present
  from expected_functions

  union all

  select
    'relation',
    relation_name,
    to_regclass(relation_name) is not null
  from expected_relations

  union all

  select
    'column',
    table_name || '.' || column_name,
    exists (
      select 1
      from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = expected_columns.table_name
        and c.column_name = expected_columns.column_name
    )
  from expected_columns
)
select object_type, object_name, present
from results
order by object_type, object_name;
