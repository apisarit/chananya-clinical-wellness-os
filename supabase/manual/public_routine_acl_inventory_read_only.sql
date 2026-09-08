-- CNYOS public-routine and ACL observation (read-only, PostgreSQL 17).
--
-- Run this as a single, fresh, direct psql process.  -X is mandatory so a
-- user psqlrc cannot alter the evidence protocol.  The two metadata values
-- label the observation; they do not authenticate or authorize its target.
--
--   psql -X --quiet --no-align --tuples-only \
--     --set=ON_ERROR_STOP=1 --set=AUTOCOMMIT=on \
--     --set=cnyos_observation_source_revision="$(git rev-parse HEAD)" \
--     --set=cnyos_observation_project_label="chananya-staging" \
--     --file=supabase/manual/public_routine_acl_inventory_read_only.sql \
--     "$DIRECT_POSTGRES_URL"
--
-- Do not use --single-transaction, ON_ERROR_ROLLBACK, a transaction pooler,
-- a SQL editor, or a driver-managed outer transaction.  This artifact does
-- not compare the target to a reviewed hash and never grants authorization.

\set QUIET on
\encoding UTF8
\pset format unaligned
\pset tuples_only on
\pset expanded off
\pset pager off
\set ON_ERROR_STOP 1
\set ON_ERROR_ROLLBACK off
\unset cnyos_observation_probe_xid
\unset cnyos_observation_existing_transaction
\unset cnyos_observation_metadata_valid
\unset cnyos_observation_lock_unheld
\unset cnyos_observation_lock_acquired
\unset cnyos_observation_lock_released
\unset cnyos_observation_lock_fully_released
\unset cnyos_public_routine_acl_observation

\if :AUTOCOMMIT
\else
\warn 'CNYOS public-routine observation requires psql AUTOCOMMIT=on; rolling back and refusing execution'
rollback;
do $cnyos_observation_autocommit_abort$
begin
  raise exception 'CNYOS_PUBLIC_ROUTINE_OBSERVATION_PSQL_AUTOCOMMIT_REQUIRED';
end
$cnyos_observation_autocommit_abort$;
\endif

\if :{?cnyos_observation_source_revision}
\else
do $cnyos_observation_source_abort$
begin
  raise exception 'CNYOS_PUBLIC_ROUTINE_OBSERVATION_SOURCE_REVISION_REQUIRED';
end
$cnyos_observation_source_abort$;
\endif

\if :{?cnyos_observation_project_label}
\else
do $cnyos_observation_label_abort$
begin
  raise exception 'CNYOS_PUBLIC_ROUTINE_OBSERVATION_PROJECT_LABEL_REQUIRED';
end
$cnyos_observation_label_abort$;
\endif

set search_path = pg_catalog, pg_temp;

select (
  :'cnyos_observation_source_revision' ~ '^[0-9a-f]{40}$'
  and :'cnyos_observation_project_label' ~
        '^[a-z0-9][a-z0-9._-]{0,127}$'
) as cnyos_observation_metadata_valid
\gset
\if :cnyos_observation_metadata_valid
\else
do $cnyos_observation_metadata_abort$
begin
  raise exception
    'CNYOS_PUBLIC_ROUTINE_OBSERVATION_METADATA_INVALID';
end
$cnyos_observation_metadata_abort$;
\endif

-- Two adjacent top-level XIDs distinguish a fresh AUTOCOMMIT session from an
-- included file running inside a caller transaction.  On detection, the
-- caller transaction is rolled back and execution is refused.
select pg_catalog.pg_current_xact_id()::text as cnyos_observation_probe_xid
\gset
select (
  pg_catalog.pg_current_xact_id()::text = :'cnyos_observation_probe_xid'
) as cnyos_observation_existing_transaction
\gset
\if :cnyos_observation_existing_transaction
\warn 'CNYOS public-routine observation detected and rolled back an existing transaction; refusing execution'
rollback;
do $cnyos_observation_transaction_abort$
begin
  raise exception
    'CNYOS_PUBLIC_ROUTINE_OBSERVATION_PSQL_EXISTING_TRANSACTION_REFUSED';
end
$cnyos_observation_transaction_abort$;
\endif

select not exists (
  select 1
  from pg_catalog.pg_locks lock_row
  where lock_row.locktype = 'advisory'
    and lock_row.pid = pg_catalog.pg_backend_pid()
    and lock_row.granted
    and lock_row.classid::bigint = (202608302100::bigint >> 32)
    and lock_row.objid::bigint =
        (202608302100::bigint & 4294967295::bigint)
    and lock_row.objsubid = 1
) as cnyos_observation_lock_unheld
\gset
\if :cnyos_observation_lock_unheld
\else
do $cnyos_observation_interlock_state_abort$
begin
  raise exception
    'CNYOS_PUBLIC_ROUTINE_OBSERVATION_ADVISORY_INTERLOCK_ALREADY_HELD';
end
$cnyos_observation_interlock_state_abort$;
\endif

select pg_catalog.pg_try_advisory_lock(202608302100::bigint)
  as cnyos_observation_lock_acquired
\gset
\if :cnyos_observation_lock_acquired
\else
do $cnyos_observation_interlock_abort$
begin
  raise exception 'CNYOS_PUBLIC_ROUTINE_OBSERVATION_ADVISORY_INTERLOCK_BUSY';
end
$cnyos_observation_interlock_abort$;
\endif

begin isolation level repeatable read read only;
set local search_path = pg_catalog, pg_temp;
-- CNYOS_OBSERVATION_OUTPUT_GUCS_BEGIN
-- These settings affect catalog deparsing or textual JSON values that feed
-- the canonical digest rows.  Pin them before the catalog snapshot capture.
set local timezone = 'UTC';
set local datestyle = 'ISO, YMD';
set local intervalstyle = 'postgres';
set local extra_float_digits = 3;
set local bytea_output = 'hex';
set local quote_all_identifiers = off;
set local standard_conforming_strings = on;
set local lc_monetary = 'C';
set local lc_numeric = 'C';
set local lc_time = 'C';
-- CNYOS_OBSERVATION_OUTPUT_GUCS_END
set local statement_timeout = '120s';
set local lock_timeout = '5s';

-- A read-only transaction permits only ACCESS SHARE here.  These locks are
-- acquired before the first evidence SELECT.  The repeatable-read snapshot,
-- rather than a write-conflicting catalog lock, supplies MVCC consistency.
lock table pg_catalog.pg_proc,
  pg_catalog.pg_namespace,
  pg_catalog.pg_authid,
  pg_catalog.pg_auth_members,
  pg_catalog.pg_depend,
  pg_catalog.pg_extension,
  pg_catalog.pg_language,
  pg_catalog.pg_default_acl,
  pg_catalog.pg_aggregate,
  pg_catalog.pg_type,
  pg_catalog.pg_db_role_setting,
  pg_catalog.pg_database,
  pg_catalog.pg_trigger,
  pg_catalog.pg_event_trigger,
  pg_catalog.pg_class,
  pg_catalog.pg_attribute,
  pg_catalog.pg_constraint
in access share mode;

-- CNYOS_OBSERVATION_CAPTURE_BEGIN
with recursive
parameters as (
  select
    :'cnyos_observation_source_revision'::text as source_revision,
    :'cnyos_observation_project_label'::text as project_label
),
public_namespace as (
  select
    namespace.oid as namespace_oid,
    namespace.nspname,
    namespace.nspowner,
    namespace.nspacl
  from pg_catalog.pg_namespace namespace
  where namespace.nspname = 'public'
),
extension_membership_rows as (
  select
    procedure.oid as routine_oid,
    pg_catalog.jsonb_build_object(
      'row_schema', 'cnyos-extension-membership/v1',
      'routine_oid', procedure.oid::text,
      'dependency_class_oid', dependency.classid::text,
      'dependency_object_oid', dependency.objid::text,
      'dependency_object_subid', dependency.objsubid,
      'referenced_class_oid', dependency.refclassid::text,
      'extension_oid', extension.oid::text,
      'extension_name', extension.extname,
      'extension_owner_oid', extension.extowner::text,
      'extension_schema_oid', extension.extnamespace::text,
      'extension_relocatable', extension.extrelocatable,
      'extension_version', extension.extversion,
      'referenced_object_subid', dependency.refobjsubid,
      'dependency_type', dependency.deptype::text
    ) as row_json
  from pg_catalog.pg_proc procedure
  join pg_catalog.pg_namespace namespace
    on namespace.oid = procedure.pronamespace
  join pg_catalog.pg_depend dependency
    on dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
   and dependency.objid = procedure.oid
   and dependency.objsubid = 0
   and dependency.refclassid =
       'pg_catalog.pg_extension'::pg_catalog.regclass
   and dependency.refobjsubid = 0
   and dependency.deptype = 'e'
  join pg_catalog.pg_extension extension
    on extension.oid = dependency.refobjid
  where namespace.nspname = 'public'
),
extension_memberships as (
  select
    routine_oid,
    pg_catalog.jsonb_agg(
      row_json order by row_json::text collate "C"
    ) as memberships
  from extension_membership_rows
  group by routine_oid
),
public_routines as (
  select
    procedure.*,
    namespace.oid as public_namespace_oid,
    namespace.nspname as public_namespace_name,
    owner_role.rolname as owner_name,
    language.lanname as language_name,
    coalesce(
      memberships.memberships,
      '[]'::pg_catalog.jsonb
    ) as extension_memberships,
    memberships.routine_oid is not null as is_extension_member
  from pg_catalog.pg_proc procedure
  join pg_catalog.pg_namespace namespace
    on namespace.oid = procedure.pronamespace
  left join pg_catalog.pg_roles owner_role
    on owner_role.oid = procedure.proowner
  left join pg_catalog.pg_language language
    on language.oid = procedure.prolang
  left join extension_memberships memberships
    on memberships.routine_oid = procedure.oid
  where namespace.nspname = 'public'
),
semantic_rows as (
  select
    case when routine.is_extension_member
      then 'extension_member'
      else 'non_extension_application'
    end as classification,
    routine.oid as routine_oid,
    pg_catalog.jsonb_build_object(
      'row_schema', 'cnyos-public-routine-semantic/v1',
      'classification', case when routine.is_extension_member
        then 'extension_member'
        else 'non_extension_application'
      end,
      'routine_oid', routine.oid::text,
      'namespace_oid', routine.pronamespace::text,
      'signature', routine.oid::pg_catalog.regprocedure::text,
      'arguments', pg_catalog.pg_get_function_arguments(routine.oid),
      'identity_arguments',
        pg_catalog.pg_get_function_identity_arguments(routine.oid),
      'result', pg_catalog.pg_get_function_result(routine.oid),
      'result_schema', result_namespace.nspname,
      'result_type', pg_catalog.format_type(routine.prorettype, null),
      'returns_trigger',
        routine.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype,
      'returns_event_trigger',
        routine.prorettype = 'pg_catalog.event_trigger'::pg_catalog.regtype,
      'data_api_candidate',
        routine.prokind = 'f'
        and routine.prorettype not in (
          'pg_catalog.trigger'::pg_catalog.regtype,
          'pg_catalog.event_trigger'::pg_catalog.regtype
        ),
      'owner_oid', routine.proowner::text,
      'owner_name', routine.owner_name,
      'language_oid', routine.prolang::text,
      'language_name', routine.language_name,
      'support_routine', case when routine.prosupport = 0
        then null
        else routine.prosupport::pg_catalog.regprocedure::text
      end,
      'formatted_variadic_type', case when routine.provariadic = 0
        then null
        else pg_catalog.format_type(routine.provariadic, null)
      end,
      'function_definition', case when routine.prokind in ('f', 'p')
        then pg_catalog.pg_get_functiondef(routine.oid)
        else null
      end,
      'pg_proc_catalog', pg_catalog.to_jsonb(routine) -
        'public_namespace_oid' - 'public_namespace_name' -
        'owner_name' - 'language_name' -
        'extension_memberships' - 'is_extension_member' - 'proacl',
      'pg_aggregate_catalog', pg_catalog.to_jsonb(aggregate_catalog),
      'extension_memberships', routine.extension_memberships
    ) as row_json
  from public_routines routine
  left join pg_catalog.pg_type result_type
    on result_type.oid = routine.prorettype
  left join pg_catalog.pg_namespace result_namespace
    on result_namespace.oid = result_type.typnamespace
  left join pg_catalog.pg_aggregate aggregate_catalog
    on aggregate_catalog.aggfnoid = routine.oid
),
raw_routine_acl_rows as (
  select
    case when routine.is_extension_member
      then 'extension_member'
      else 'non_extension_application'
    end as classification,
    routine.oid as routine_oid,
    pg_catalog.jsonb_build_object(
      'row_schema', 'cnyos-public-routine-raw-acl/v1',
      'classification', case when routine.is_extension_member
        then 'extension_member'
        else 'non_extension_application'
      end,
      'routine_oid', routine.oid::text,
      'signature', routine.oid::pg_catalog.regprocedure::text,
      'owner_oid', routine.proowner::text,
      'owner_name', routine.owner_name,
      'proacl_is_null', routine.proacl is null,
      'raw_proacl_text', routine.proacl::text,
      'expanded_acl_source', case when routine.proacl is null
        then 'implicit_hard_wired_function_default'
        else 'explicit_pg_proc_proacl'
      end,
      'expanded_acl_rows', coalesce(
        expanded_acl.rows,
        '[]'::pg_catalog.jsonb
      )
    ) as row_json
  from public_routines routine
  left join lateral (
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'grantor_oid', acl.grantor::text,
        'grantor_label', case when acl.grantor = 0::oid
          then 'PUBLIC'
          when grantor_role.rolname is not null then grantor_role.rolname
          else 'OID:' || acl.grantor::text
        end,
        'grantee_oid', acl.grantee::text,
        'grantee_label', case when acl.grantee = 0::oid
          then 'PUBLIC'
          when grantee_role.rolname is not null then grantee_role.rolname
          else 'OID:' || acl.grantee::text
        end,
        'privilege_type', acl.privilege_type,
        'is_grantable', acl.is_grantable
      ) order by
        acl.grantee,
        acl.privilege_type collate "C",
        acl.is_grantable,
        acl.grantor
    ) as rows
    from pg_catalog.aclexplode(coalesce(
      routine.proacl,
      pg_catalog.acldefault('f', routine.proowner)
    )) acl
    left join pg_catalog.pg_roles grantee_role
      on acl.grantee <> 0::oid
     and grantee_role.oid = acl.grantee
    left join pg_catalog.pg_roles grantor_role
      on acl.grantor <> 0::oid
     and grantor_role.oid = acl.grantor
  ) expanded_acl on true
),
bound_handler_oids(routine_oid) as (
  select trigger_definition.tgfoid
  from pg_catalog.pg_trigger trigger_definition
  where not trigger_definition.tgisinternal
  union
  select event_trigger.evtfoid
  from pg_catalog.pg_event_trigger event_trigger
),
current_database_identity as (
  select
    database.oid as database_oid,
    database.datname as database_name
  from pg_catalog.pg_database database
  where database.datname = pg_catalog.current_database()
),
all_role_security_rows as (
  select
    role.oid as role_oid,
    pg_catalog.jsonb_build_object(
      'row_schema', 'cnyos-role-security-context-node/v1',
      'role_oid', role.oid::text,
      'role_name', role.rolname,
      'rolsuper', role.rolsuper,
      'rolinherit', role.rolinherit,
      'rolcreaterole', role.rolcreaterole,
      'rolcreatedb', role.rolcreatedb,
      'rolcanlogin', role.rolcanlogin,
      'rolreplication', role.rolreplication,
      'rolconnlimit', role.rolconnlimit,
      'rolvaliduntil', role.rolvaliduntil,
      'rolbypassrls', role.rolbypassrls,
      'rolconfig', pg_catalog.to_jsonb(role.rolconfig)
    ) as row_json
  from pg_catalog.pg_roles role
),
all_role_membership_security_rows as (
  select
    membership.oid as membership_oid,
    pg_catalog.jsonb_build_object(
      'row_schema', 'cnyos-role-security-context-edge/v1',
      'membership_oid', membership.oid::text,
      'granted_role_oid', membership.roleid::text,
      'granted_role_name', granted_role.rolname,
      'member_role_oid', membership.member::text,
      'member_role_name', member_role.rolname,
      'grantor_oid', membership.grantor::text,
      'grantor_name', grantor_role.rolname,
      'admin_option', membership.admin_option,
      'inherit_option', membership.inherit_option,
      'set_option', membership.set_option
    ) as row_json
  from pg_catalog.pg_auth_members membership
  left join pg_catalog.pg_roles granted_role
    on granted_role.oid = membership.roleid
  left join pg_catalog.pg_roles member_role
    on member_role.oid = membership.member
  left join pg_catalog.pg_roles grantor_role
    on grantor_role.oid = membership.grantor
),
relevant_database_role_setting_rows as (
  select
    role_setting.setdatabase as database_oid,
    role_setting.setrole as role_oid,
    pg_catalog.jsonb_build_object(
      'row_schema', 'cnyos-database-role-setting/v1',
      'database_oid', role_setting.setdatabase::text,
      'database_name', case when role_setting.setdatabase = 0::oid
        then 'ALL_DATABASES'
        else database.database_name
      end,
      'role_oid', role_setting.setrole::text,
      'role_name', case when role_setting.setrole = 0::oid
        then 'ALL_ROLES'
        else role.rolname
      end,
      'setconfig', pg_catalog.to_jsonb(role_setting.setconfig)
    ) as row_json
  from pg_catalog.pg_db_role_setting role_setting
  cross join current_database_identity database
  left join pg_catalog.pg_roles role
    on role.oid = role_setting.setrole
  where role_setting.setdatabase in (0::oid, database.database_oid)
),
current_database_security as (
  select pg_catalog.jsonb_build_object(
    'row_schema', 'cnyos-current-database-security/v1',
    'database_oid', database.oid::text,
    'database_name', database.datname,
    'owner_oid', database.datdba::text,
    'owner_name', owner_role.rolname,
    'pg_database_catalog', pg_catalog.to_jsonb(database) -
      'datacl' - 'datfrozenxid' - 'datminmxid',
    'excluded_churn_columns', pg_catalog.jsonb_build_array(
      'datfrozenxid',
      'datminmxid'
    ),
    'raw_acl', pg_catalog.jsonb_build_object(
      'datacl_is_null', database.datacl is null,
      'raw_datacl_text', database.datacl::text,
      'expanded_acl_source', case when database.datacl is null
        then 'implicit_hard_wired_database_default'
        else 'explicit_pg_database_datacl'
      end,
      'expanded_acl_rows', coalesce(
        expanded_acl.rows,
        '[]'::pg_catalog.jsonb
      )
    ),
    'effective_access_all_roles', coalesce(
      effective_access.rows,
      '[]'::pg_catalog.jsonb
    )
  ) as row_json
  from current_database_identity current_database_row
  join pg_catalog.pg_database database
    on database.oid = current_database_row.database_oid
  left join pg_catalog.pg_roles owner_role
    on owner_role.oid = database.datdba
  left join lateral (
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'grantor_oid', acl.grantor::text,
        'grantor_label', case when acl.grantor = 0::oid
          then 'PUBLIC'
          when grantor_role.rolname is not null then grantor_role.rolname
          else 'OID:' || acl.grantor::text
        end,
        'grantee_oid', acl.grantee::text,
        'grantee_label', case when acl.grantee = 0::oid
          then 'PUBLIC'
          when grantee_role.rolname is not null then grantee_role.rolname
          else 'OID:' || acl.grantee::text
        end,
        'privilege_type', acl.privilege_type,
        'is_grantable', acl.is_grantable
      ) order by
        acl.grantee,
        acl.privilege_type collate "C",
        acl.is_grantable,
        acl.grantor
    ) as rows
    from pg_catalog.aclexplode(coalesce(
      database.datacl,
      pg_catalog.acldefault('d', database.datdba)
    )) acl
    left join pg_catalog.pg_roles grantee_role
      on acl.grantee <> 0::oid
     and grantee_role.oid = acl.grantee
    left join pg_catalog.pg_roles grantor_role
      on acl.grantor <> 0::oid
     and grantor_role.oid = acl.grantor
  ) expanded_acl on true
  left join lateral (
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'role_oid', access_role.role_oid::text,
        'role_name', access_role.role_name,
        'is_public_pseudo_role', access_role.is_public_pseudo_role,
        'connect', case when access_role.is_public_pseudo_role then exists (
          select 1
          from pg_catalog.aclexplode(coalesce(
            database.datacl,
            pg_catalog.acldefault('d', database.datdba)
          )) public_acl
          where public_acl.grantee = 0::oid
            and public_acl.privilege_type = 'CONNECT'
        ) else pg_catalog.has_database_privilege(
          access_role.role_oid,
          database.oid,
          'CONNECT'
        ) end,
        'connect_with_grant_option',
          case when access_role.is_public_pseudo_role then exists (
            select 1
            from pg_catalog.aclexplode(coalesce(
              database.datacl,
              pg_catalog.acldefault('d', database.datdba)
            )) public_acl
            where public_acl.grantee = 0::oid
              and public_acl.privilege_type = 'CONNECT'
              and public_acl.is_grantable
          ) else pg_catalog.has_database_privilege(
            access_role.role_oid,
            database.oid,
            'CONNECT WITH GRANT OPTION'
          ) end,
        'create', case when access_role.is_public_pseudo_role then exists (
          select 1
          from pg_catalog.aclexplode(coalesce(
            database.datacl,
            pg_catalog.acldefault('d', database.datdba)
          )) public_acl
          where public_acl.grantee = 0::oid
            and public_acl.privilege_type = 'CREATE'
        ) else pg_catalog.has_database_privilege(
          access_role.role_oid,
          database.oid,
          'CREATE'
        ) end,
        'create_with_grant_option',
          case when access_role.is_public_pseudo_role then exists (
            select 1
            from pg_catalog.aclexplode(coalesce(
              database.datacl,
              pg_catalog.acldefault('d', database.datdba)
            )) public_acl
            where public_acl.grantee = 0::oid
              and public_acl.privilege_type = 'CREATE'
              and public_acl.is_grantable
          ) else pg_catalog.has_database_privilege(
            access_role.role_oid,
            database.oid,
            'CREATE WITH GRANT OPTION'
          ) end,
        'temporary', case when access_role.is_public_pseudo_role then exists (
          select 1
          from pg_catalog.aclexplode(coalesce(
            database.datacl,
            pg_catalog.acldefault('d', database.datdba)
          )) public_acl
          where public_acl.grantee = 0::oid
            and public_acl.privilege_type = 'TEMPORARY'
        ) else pg_catalog.has_database_privilege(
          access_role.role_oid,
          database.oid,
          'TEMPORARY'
        ) end,
        'temporary_with_grant_option',
          case when access_role.is_public_pseudo_role then exists (
            select 1
            from pg_catalog.aclexplode(coalesce(
              database.datacl,
              pg_catalog.acldefault('d', database.datdba)
            )) public_acl
            where public_acl.grantee = 0::oid
              and public_acl.privilege_type = 'TEMPORARY'
              and public_acl.is_grantable
          ) else pg_catalog.has_database_privilege(
            access_role.role_oid,
            database.oid,
            'TEMPORARY WITH GRANT OPTION'
          ) end
      ) order by
        access_role.role_name collate "C",
        access_role.role_oid
    ) as rows
    from (
      select
        0::oid as role_oid,
        'PUBLIC'::text as role_name,
        true as is_public_pseudo_role
      union all
      select role.oid, role.rolname, false
      from pg_catalog.pg_roles role
    ) access_role
  ) effective_access on true
),
all_role_security_context as (
  select pg_catalog.jsonb_build_object(
    'row_schema', 'cnyos-bound-handler-authorization-context/v1',
    'current_database_security', (
      select database.row_json from current_database_security database
    ),
    'role_nodes', coalesce((
      select pg_catalog.jsonb_agg(
        role.row_json order by role.role_oid
      )
      from all_role_security_rows role
    ), '[]'::pg_catalog.jsonb),
    'membership_edges', coalesce((
      select pg_catalog.jsonb_agg(
        membership.row_json order by membership.membership_oid
      )
      from all_role_membership_security_rows membership
    ), '[]'::pg_catalog.jsonb),
    'current_database_and_global_role_settings', coalesce((
      select pg_catalog.jsonb_agg(
        setting.row_json
        order by setting.database_oid, setting.role_oid
      )
      from relevant_database_role_setting_rows setting
    ), '[]'::pg_catalog.jsonb)
  ) as row_json
),
bound_handler_namespace_oids(namespace_oid) as (
  select distinct procedure.pronamespace
  from bound_handler_oids bound_handler
  join pg_catalog.pg_proc procedure
    on procedure.oid = bound_handler.routine_oid
),
bound_handler_language_oids(language_oid) as (
  select distinct procedure.prolang
  from bound_handler_oids bound_handler
  join pg_catalog.pg_proc procedure
    on procedure.oid = bound_handler.routine_oid
),
persistent_namespace_oids(namespace_oid) as (
  select namespace.oid
  from pg_catalog.pg_namespace namespace
  where namespace.nspname !~ '^pg_(toast_)?temp_[0-9]+$'
),
security_relevant_namespace_oids(namespace_oid) as (
  select namespace_oid from persistent_namespace_oids
  union
  select namespace_oid from bound_handler_namespace_oids
),
namespace_security_rows as (
  select
    namespace.oid as namespace_oid,
    pg_catalog.jsonb_build_object(
      'row_schema', 'cnyos-schema-security/v1',
      'schema_oid', namespace.oid::text,
      'schema_name', namespace.nspname,
      'temporary_schema',
        namespace.nspname ~ '^pg_(toast_)?temp_[0-9]+$',
      'owner_oid', namespace.nspowner::text,
      'owner_name', owner_role.rolname,
      'pg_namespace_catalog',
        pg_catalog.to_jsonb(namespace) - 'nspacl',
      'raw_acl', pg_catalog.jsonb_build_object(
        'nspacl_is_null', namespace.nspacl is null,
        'raw_nspacl_text', namespace.nspacl::text,
        'expanded_acl_source', case when namespace.nspacl is null
          then 'implicit_hard_wired_schema_default'
          else 'explicit_pg_namespace_nspacl'
        end,
        'expanded_acl_rows', coalesce(
          expanded_acl.rows,
          '[]'::pg_catalog.jsonb
        )
      ),
      'effective_access_all_roles', coalesce(
        effective_access.rows,
        '[]'::pg_catalog.jsonb
      )
    ) as row_json
  from security_relevant_namespace_oids selected_namespace
  join pg_catalog.pg_namespace namespace
    on namespace.oid = selected_namespace.namespace_oid
  left join pg_catalog.pg_roles owner_role
    on owner_role.oid = namespace.nspowner
  left join lateral (
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'grantor_oid', acl.grantor::text,
        'grantor_label', case when acl.grantor = 0::oid
          then 'PUBLIC'
          when grantor_role.rolname is not null then grantor_role.rolname
          else 'OID:' || acl.grantor::text
        end,
        'grantee_oid', acl.grantee::text,
        'grantee_label', case when acl.grantee = 0::oid
          then 'PUBLIC'
          when grantee_role.rolname is not null then grantee_role.rolname
          else 'OID:' || acl.grantee::text
        end,
        'privilege_type', acl.privilege_type,
        'is_grantable', acl.is_grantable
      ) order by
        acl.grantee,
        acl.privilege_type collate "C",
        acl.is_grantable,
        acl.grantor
    ) as rows
    from pg_catalog.aclexplode(coalesce(
      namespace.nspacl,
      pg_catalog.acldefault('n', namespace.nspowner)
    )) acl
    left join pg_catalog.pg_roles grantee_role
      on acl.grantee <> 0::oid
     and grantee_role.oid = acl.grantee
    left join pg_catalog.pg_roles grantor_role
      on acl.grantor <> 0::oid
     and grantor_role.oid = acl.grantor
  ) expanded_acl on true
  left join lateral (
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'role_oid', access_role.role_oid::text,
        'role_name', access_role.role_name,
        'is_public_pseudo_role', access_role.is_public_pseudo_role,
        'usage', case when access_role.is_public_pseudo_role then exists (
          select 1
          from pg_catalog.aclexplode(coalesce(
            namespace.nspacl,
            pg_catalog.acldefault('n', namespace.nspowner)
          )) public_acl
          where public_acl.grantee = 0::oid
            and public_acl.privilege_type = 'USAGE'
        ) else pg_catalog.has_schema_privilege(
          access_role.role_oid,
          namespace.oid,
          'USAGE'
        ) end,
        'usage_with_grant_option',
          case when access_role.is_public_pseudo_role then exists (
            select 1
            from pg_catalog.aclexplode(coalesce(
              namespace.nspacl,
              pg_catalog.acldefault('n', namespace.nspowner)
            )) public_acl
            where public_acl.grantee = 0::oid
              and public_acl.privilege_type = 'USAGE'
              and public_acl.is_grantable
          ) else pg_catalog.has_schema_privilege(
            access_role.role_oid,
            namespace.oid,
            'USAGE WITH GRANT OPTION'
          ) end,
        'create', case when access_role.is_public_pseudo_role then exists (
          select 1
          from pg_catalog.aclexplode(coalesce(
            namespace.nspacl,
            pg_catalog.acldefault('n', namespace.nspowner)
          )) public_acl
          where public_acl.grantee = 0::oid
            and public_acl.privilege_type = 'CREATE'
        ) else pg_catalog.has_schema_privilege(
          access_role.role_oid,
          namespace.oid,
          'CREATE'
        ) end,
        'create_with_grant_option',
          case when access_role.is_public_pseudo_role then exists (
            select 1
            from pg_catalog.aclexplode(coalesce(
              namespace.nspacl,
              pg_catalog.acldefault('n', namespace.nspowner)
            )) public_acl
            where public_acl.grantee = 0::oid
              and public_acl.privilege_type = 'CREATE'
              and public_acl.is_grantable
          ) else pg_catalog.has_schema_privilege(
            access_role.role_oid,
            namespace.oid,
            'CREATE WITH GRANT OPTION'
          ) end
      ) order by
        access_role.role_name collate "C",
        access_role.role_oid
    ) as rows
    from (
      select
        0::oid as role_oid,
        'PUBLIC'::text as role_name,
        true as is_public_pseudo_role
      union all
      select role.oid, role.rolname, false
      from pg_catalog.pg_roles role
    ) access_role
  ) effective_access on true
),
persistent_namespace_security_digest_rows as (
  select pg_catalog.jsonb_build_array(
    'cnyos-observation-positional-digest-row/v1',
    'schemas.all_non_temporary.security',
    coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(field.key, field.value)
        order by field.key collate "C"
      )
      from pg_catalog.jsonb_each(schema_security.row_json) field
    ), '[]'::pg_catalog.jsonb)
  ) as digest_row
  from namespace_security_rows schema_security
  join persistent_namespace_oids persistent_namespace
    on persistent_namespace.namespace_oid = schema_security.namespace_oid
),
persistent_namespace_security_metrics as (
  select
    pg_catalog.count(*)::bigint as row_count,
    coalesce(
      pg_catalog.string_agg(
        schema_security.digest_row::text,
        E'\n' order by schema_security.digest_row::text collate "C"
      ),
      ''
    ) as payload_without_terminal_newline
  from persistent_namespace_security_digest_rows schema_security
),
persistent_namespace_security_digest as (
  select pg_catalog.jsonb_build_object(
    'row_schema', 'cnyos-all-persistent-schema-security-digest/v1',
    'dataset_name', 'schemas.all_non_temporary.security',
    'row_count', metric.row_count,
    'payload_bytes', pg_catalog.octet_length(
      case when metric.row_count = 0 then ''
        else metric.payload_without_terminal_newline || E'\n'
      end
    )::bigint,
    'payload_sha256', pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(
        case when metric.row_count = 0 then ''
          else metric.payload_without_terminal_newline || E'\n'
        end,
        'UTF8'
      )),
      'hex'
    )
  ) as row_json
  from persistent_namespace_security_metrics metric
),
bound_handler_rows as (
  select
    procedure.oid as routine_oid,
    pg_catalog.jsonb_build_object(
      'row_schema', 'cnyos-bound-trigger-handler/v1',
      'routine_oid', procedure.oid::text,
      'namespace_oid', procedure.pronamespace::text,
      'function_schema', function_namespace.nspname,
      'function_name', procedure.proname,
      'function_signature', procedure.oid::pg_catalog.regprocedure::text,
      'function_local_search_path', (
        select setting
        from pg_catalog.unnest(procedure.proconfig) setting
        where pg_catalog.split_part(setting, '=', 1) = 'search_path'
        limit 1
      ),
      'function_local_search_path_absent', not exists (
        select 1
        from pg_catalog.unnest(procedure.proconfig) setting
        where pg_catalog.split_part(setting, '=', 1) = 'search_path'
      ),
      'function_local_search_path_mentions_dynamic_user', exists (
        select 1
        from pg_catalog.unnest(procedure.proconfig) setting
        where pg_catalog.split_part(setting, '=', 1) = 'search_path'
          and setting like '%$user%'
      ),
      'function_local_search_path_mentions_session_specific_temp_schema',
        exists (
          select 1
          from pg_catalog.unnest(procedure.proconfig) setting
          where pg_catalog.split_part(setting, '=', 1) = 'search_path'
            and setting ~ 'pg_(toast_)?temp_[0-9]+'
        ),
      'function_local_search_path_contains_quoted_identifier', exists (
        select 1
        from pg_catalog.unnest(procedure.proconfig) setting
        where pg_catalog.split_part(setting, '=', 1) = 'search_path'
          and setting like '%"%'
      ),
      'function_local_search_path_has_explicit_terminal_pg_temp', exists (
        select 1
        from pg_catalog.unnest(procedure.proconfig) setting
        where pg_catalog.split_part(setting, '=', 1) = 'search_path'
          and setting not like '%"%'
          and pg_catalog.substring(
            setting,
            pg_catalog.length('search_path=') + 1
          ) ~ '(^|.*,)[[:space:]]*pg_temp[[:space:]]*$'
      ),
      'function_local_search_path_potentially_temp_dynamic',
        not exists (
          select 1
          from pg_catalog.unnest(procedure.proconfig) setting
          where pg_catalog.split_part(setting, '=', 1) = 'search_path'
        ) or not exists (
          select 1
          from pg_catalog.unnest(procedure.proconfig) setting
          where pg_catalog.split_part(setting, '=', 1) = 'search_path'
            and setting not like '%"%'
            and pg_catalog.substring(
              setting,
              pg_catalog.length('search_path=') + 1
            ) ~ '(^|.*,)[[:space:]]*pg_temp[[:space:]]*$'
        ) or exists (
          select 1
          from pg_catalog.unnest(procedure.proconfig) setting
          where pg_catalog.split_part(setting, '=', 1) = 'search_path'
            and (
              setting like '%$user%'
              or setting like '%"%'
              or setting ~ 'pg_(toast_)?temp_[0-9]+'
            )
        ),
      'all_non_temporary_schema_security_digest',
        persistent_schema_security.row_json,
      'arguments', pg_catalog.pg_get_function_arguments(procedure.oid),
      'identity_arguments',
        pg_catalog.pg_get_function_identity_arguments(procedure.oid),
      'result', pg_catalog.pg_get_function_result(procedure.oid),
      'result_schema', result_namespace.nspname,
      'result_type', pg_catalog.format_type(procedure.prorettype, null),
      'returns_trigger',
        procedure.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype,
      'returns_event_trigger',
        procedure.prorettype = 'pg_catalog.event_trigger'::pg_catalog.regtype,
      'owner_oid', procedure.proowner::text,
      'owner_name', owner_role.rolname,
      'owner_role_security', owner_security.row_json,
      'authorization_context', authorization_context.row_json,
      'function_schema_security', handler_namespace.row_json,
      'language_oid', procedure.prolang::text,
      'language_name', language.lanname,
      'language_security', pg_catalog.jsonb_build_object(
        'row_schema', 'cnyos-bound-handler-language-security/v1',
        'language_oid', language.oid::text,
        'language_name', language.lanname,
        'owner_oid', language.lanowner::text,
        'owner_name', language_owner_role.rolname,
        'pg_language_catalog',
          pg_catalog.to_jsonb(language) - 'lanacl',
        'raw_acl', pg_catalog.jsonb_build_object(
          'lanacl_is_null', language.lanacl is null,
          'raw_lanacl_text', language.lanacl::text,
          'expanded_acl_source', case when language.lanacl is null
            then 'implicit_hard_wired_language_default'
            else 'explicit_pg_language_lanacl'
          end,
          'expanded_acl_rows', coalesce(
            language_acl.rows,
            '[]'::pg_catalog.jsonb
          )
        )
      ),
      'support_routine', case when procedure.prosupport = 0
        then null
        else procedure.prosupport::pg_catalog.regprocedure::text
      end,
      'formatted_variadic_type', case when procedure.provariadic = 0
        then null
        else pg_catalog.format_type(procedure.provariadic, null)
      end,
      'function_definition', case when procedure.prokind in ('f', 'p')
        then pg_catalog.pg_get_functiondef(procedure.oid)
        else null
      end,
      'pg_proc_catalog', pg_catalog.to_jsonb(procedure) - 'proacl',
      'pg_aggregate_catalog', pg_catalog.to_jsonb(aggregate_catalog),
      'raw_acl', pg_catalog.jsonb_build_object(
        'proacl_is_null', procedure.proacl is null,
        'raw_proacl_text', procedure.proacl::text,
        'expanded_acl_source', case when procedure.proacl is null
          then 'implicit_hard_wired_function_default'
          else 'explicit_pg_proc_proacl'
        end,
        'expanded_acl_rows', coalesce(
          expanded_acl.rows,
          '[]'::pg_catalog.jsonb
        )
      ),
      'effective_runtime_access', coalesce(
        runtime_access.rows,
        '[]'::pg_catalog.jsonb
      ),
      'extension_memberships', coalesce(
        extension_membership.rows,
        '[]'::pg_catalog.jsonb
      )
    ) as row_json
  from bound_handler_oids bound_handler
  join pg_catalog.pg_proc procedure
    on procedure.oid = bound_handler.routine_oid
  left join pg_catalog.pg_namespace function_namespace
    on function_namespace.oid = procedure.pronamespace
  left join pg_catalog.pg_roles owner_role
    on owner_role.oid = procedure.proowner
  left join all_role_security_rows owner_security
    on owner_security.role_oid = procedure.proowner
  cross join all_role_security_context authorization_context
  cross join persistent_namespace_security_digest persistent_schema_security
  left join namespace_security_rows handler_namespace
    on handler_namespace.namespace_oid = procedure.pronamespace
  left join pg_catalog.pg_language language
    on language.oid = procedure.prolang
  left join pg_catalog.pg_roles language_owner_role
    on language_owner_role.oid = language.lanowner
  left join pg_catalog.pg_type result_type
    on result_type.oid = procedure.prorettype
  left join pg_catalog.pg_namespace result_namespace
    on result_namespace.oid = result_type.typnamespace
  left join pg_catalog.pg_aggregate aggregate_catalog
    on aggregate_catalog.aggfnoid = procedure.oid
  left join lateral (
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'grantor_oid', acl.grantor::text,
        'grantor_label', case when acl.grantor = 0::oid
          then 'PUBLIC'
          when grantor_role.rolname is not null then grantor_role.rolname
          else 'OID:' || acl.grantor::text
        end,
        'grantee_oid', acl.grantee::text,
        'grantee_label', case when acl.grantee = 0::oid
          then 'PUBLIC'
          when grantee_role.rolname is not null then grantee_role.rolname
          else 'OID:' || acl.grantee::text
        end,
        'privilege_type', acl.privilege_type,
        'is_grantable', acl.is_grantable
      ) order by
        acl.grantee,
        acl.privilege_type collate "C",
        acl.is_grantable,
        acl.grantor
    ) as rows
    from pg_catalog.aclexplode(coalesce(
      language.lanacl,
      pg_catalog.acldefault('l', language.lanowner)
    )) acl
    left join pg_catalog.pg_roles grantee_role
      on acl.grantee <> 0::oid
     and grantee_role.oid = acl.grantee
    left join pg_catalog.pg_roles grantor_role
      on acl.grantor <> 0::oid
     and grantor_role.oid = acl.grantor
  ) language_acl on true
  left join lateral (
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'grantor_oid', acl.grantor::text,
        'grantor_label', case when acl.grantor = 0::oid
          then 'PUBLIC'
          when grantor_role.rolname is not null then grantor_role.rolname
          else 'OID:' || acl.grantor::text
        end,
        'grantee_oid', acl.grantee::text,
        'grantee_label', case when acl.grantee = 0::oid
          then 'PUBLIC'
          when grantee_role.rolname is not null then grantee_role.rolname
          else 'OID:' || acl.grantee::text
        end,
        'privilege_type', acl.privilege_type,
        'is_grantable', acl.is_grantable
      ) order by
        acl.grantee,
        acl.privilege_type collate "C",
        acl.is_grantable,
        acl.grantor
    ) as rows
    from pg_catalog.aclexplode(coalesce(
      procedure.proacl,
      pg_catalog.acldefault('f', procedure.proowner)
    )) acl
    left join pg_catalog.pg_roles grantee_role
      on acl.grantee <> 0::oid
     and grantee_role.oid = acl.grantee
    left join pg_catalog.pg_roles grantor_role
      on acl.grantor <> 0::oid
     and grantor_role.oid = acl.grantor
  ) expanded_acl on true
  left join lateral (
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'role_name', required.role_name,
        'role_oid', case when required.is_public_pseudo_role then '0'
          else role.oid::text
        end,
        'role_exists', required.is_public_pseudo_role or role.oid is not null,
        'is_public_pseudo_role', required.is_public_pseudo_role,
        'schema_usage', case
          when function_namespace.oid is null then false
          when required.is_public_pseudo_role then exists (
            select 1
            from pg_catalog.aclexplode(coalesce(
              function_namespace.nspacl,
              pg_catalog.acldefault('n', function_namespace.nspowner)
            )) schema_acl
            where schema_acl.grantee = 0::oid
              and schema_acl.privilege_type = 'USAGE'
          )
          when role.oid is null then false
          else pg_catalog.has_schema_privilege(
            role.oid,
            function_namespace.oid,
            'USAGE'
          )
        end,
        'function_execute', case
          when required.is_public_pseudo_role then exists (
            select 1
            from pg_catalog.aclexplode(coalesce(
              procedure.proacl,
              pg_catalog.acldefault('f', procedure.proowner)
            )) function_acl
            where function_acl.grantee = 0::oid
              and function_acl.privilege_type = 'EXECUTE'
          )
          when role.oid is null then false
          else pg_catalog.has_function_privilege(
            role.oid,
            procedure.oid,
            'EXECUTE'
          )
        end,
        'invocable_through_function_schema', case
          when function_namespace.oid is null then false
          when required.is_public_pseudo_role then
            exists (
              select 1
              from pg_catalog.aclexplode(coalesce(
                function_namespace.nspacl,
                pg_catalog.acldefault('n', function_namespace.nspowner)
              )) schema_acl
              where schema_acl.grantee = 0::oid
                and schema_acl.privilege_type = 'USAGE'
            ) and exists (
              select 1
              from pg_catalog.aclexplode(coalesce(
                procedure.proacl,
                pg_catalog.acldefault('f', procedure.proowner)
              )) function_acl
              where function_acl.grantee = 0::oid
                and function_acl.privilege_type = 'EXECUTE'
            )
          when role.oid is null then false
          else pg_catalog.has_schema_privilege(
            role.oid,
            function_namespace.oid,
            'USAGE'
          ) and pg_catalog.has_function_privilege(
            role.oid,
            procedure.oid,
            'EXECUTE'
          )
        end
      ) order by required.role_name collate "C"
    ) as rows
    from (values
      ('PUBLIC'::text, true),
      ('anon'::text, false),
      ('authenticated'::text, false),
      ('authenticator'::text, false),
      ('service_role'::text, false)
    ) required(role_name, is_public_pseudo_role)
    left join pg_catalog.pg_roles role
      on not required.is_public_pseudo_role
     and role.rolname = required.role_name
  ) runtime_access on true
  left join lateral (
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'dependency_class_oid', dependency.classid::text,
        'dependency_object_oid', dependency.objid::text,
        'dependency_object_subid', dependency.objsubid,
        'referenced_class_oid', dependency.refclassid::text,
        'extension_oid', extension.oid::text,
        'extension_name', extension.extname,
        'extension_owner_oid', extension.extowner::text,
        'extension_schema_oid', extension.extnamespace::text,
        'extension_relocatable', extension.extrelocatable,
        'extension_version', extension.extversion,
        'referenced_object_subid', dependency.refobjsubid,
        'dependency_type', dependency.deptype::text
      ) order by extension.extname collate "C", extension.oid
    ) as rows
    from pg_catalog.pg_depend dependency
    join pg_catalog.pg_extension extension
      on extension.oid = dependency.refobjid
    where dependency.classid =
          'pg_catalog.pg_proc'::pg_catalog.regclass
      and dependency.objid = procedure.oid
      and dependency.objsubid = 0
      and dependency.refclassid =
          'pg_catalog.pg_extension'::pg_catalog.regclass
      and dependency.refobjsubid = 0
      and dependency.deptype = 'e'
  ) extension_membership on true
),
trigger_binding_rows as (
  select pg_catalog.jsonb_build_object(
    'row_schema', 'cnyos-trigger-binding/v1',
    'trigger_oid', trigger_definition.oid::text,
    'relation_oid', trigger_definition.tgrelid::text,
    'relation_schema', relation_namespace.nspname,
    'relation_name', relation.relname,
    'relation_kind', relation.relkind::text,
    'relation_persistence', relation.relpersistence::text,
    'temporary_relation', relation.relpersistence = 't',
    'trigger_name', trigger_definition.tgname,
    'is_internal', trigger_definition.tgisinternal,
    'function_oid', trigger_definition.tgfoid::text,
    'function_schema', function_namespace.nspname,
    'function_name', procedure.proname,
    'function_signature', case when procedure.oid is null then null
      else procedure.oid::pg_catalog.regprocedure::text
    end,
    'handler_semantics_and_raw_acl', bound_handler.row_json,
    'definition', pg_catalog.pg_get_triggerdef(trigger_definition.oid, false),
    'enabled', trigger_definition.tgenabled::text,
    'trigger_type', trigger_definition.tgtype,
    'update_columns', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'attnum', selected.attnum,
          'name', attribute.attname
        ) order by selected.ordinality
      )
      from pg_catalog.unnest(trigger_definition.tgattr::smallint[])
        with ordinality selected(attnum, ordinality)
      join pg_catalog.pg_attribute attribute
        on attribute.attrelid = trigger_definition.tgrelid
       and attribute.attnum = selected.attnum
    ), '[]'::pg_catalog.jsonb),
    'argument_count', trigger_definition.tgnargs,
    'arguments_hex', pg_catalog.encode(trigger_definition.tgargs, 'hex'),
    'deferrable', trigger_definition.tgdeferrable,
    'initially_deferred', trigger_definition.tginitdeferred,
    'when_expression_tree', trigger_definition.tgqual::text,
    'old_transition_table', trigger_definition.tgoldtable,
    'new_transition_table', trigger_definition.tgnewtable,
    'constraint_oid', nullif(trigger_definition.tgconstraint, 0::oid)::text,
    'constraint_schema', constraint_namespace.nspname,
    'constraint_name', constraint_definition.conname,
    'referenced_relation_oid',
      nullif(trigger_definition.tgconstrrelid, 0::oid)::text,
    'referenced_relation_schema', referenced_namespace.nspname,
    'referenced_relation_name', referenced_relation.relname,
    'index_oid', nullif(trigger_definition.tgconstrindid, 0::oid)::text,
    'index_schema', index_namespace.nspname,
    'index_name', index_relation.relname,
    'parent_trigger_oid', nullif(trigger_definition.tgparentid, 0::oid)::text,
    'parent_relation_schema', parent_namespace.nspname,
    'parent_relation_name', parent_relation.relname,
    'parent_trigger_name', parent_trigger.tgname
  ) as row_json
  from pg_catalog.pg_trigger trigger_definition
  left join pg_catalog.pg_class relation
    on relation.oid = trigger_definition.tgrelid
  left join pg_catalog.pg_namespace relation_namespace
    on relation_namespace.oid = relation.relnamespace
  left join pg_catalog.pg_proc procedure
    on procedure.oid = trigger_definition.tgfoid
  left join pg_catalog.pg_namespace function_namespace
    on function_namespace.oid = procedure.pronamespace
  left join bound_handler_rows bound_handler
    on bound_handler.routine_oid = trigger_definition.tgfoid
  left join pg_catalog.pg_constraint constraint_definition
    on constraint_definition.oid = trigger_definition.tgconstraint
  left join pg_catalog.pg_namespace constraint_namespace
    on constraint_namespace.oid = constraint_definition.connamespace
  left join pg_catalog.pg_class referenced_relation
    on referenced_relation.oid = trigger_definition.tgconstrrelid
  left join pg_catalog.pg_namespace referenced_namespace
    on referenced_namespace.oid = referenced_relation.relnamespace
  left join pg_catalog.pg_class index_relation
    on index_relation.oid = trigger_definition.tgconstrindid
  left join pg_catalog.pg_namespace index_namespace
    on index_namespace.oid = index_relation.relnamespace
  left join pg_catalog.pg_trigger parent_trigger
    on parent_trigger.oid = trigger_definition.tgparentid
  left join pg_catalog.pg_class parent_relation
    on parent_relation.oid = parent_trigger.tgrelid
  left join pg_catalog.pg_namespace parent_namespace
    on parent_namespace.oid = parent_relation.relnamespace
  where not trigger_definition.tgisinternal
),
event_trigger_binding_rows as (
  select pg_catalog.jsonb_build_object(
    'row_schema', 'cnyos-event-trigger-binding/v1',
    'event_trigger_oid', event_trigger.oid::text,
    'event_trigger_name', event_trigger.evtname,
    'event', event_trigger.evtevent,
    'owner_oid', event_trigger.evtowner::text,
    'owner_name', owner_role.rolname,
    'function_oid', event_trigger.evtfoid::text,
    'function_schema', function_namespace.nspname,
    'function_name', procedure.proname,
    'function_signature', case when procedure.oid is null then null
      else procedure.oid::pg_catalog.regprocedure::text
    end,
    'handler_semantics_and_raw_acl', bound_handler.row_json,
    'enabled', event_trigger.evtenabled::text,
    'tags', case when event_trigger.evttags is null then null
      else (
        select pg_catalog.jsonb_agg(tag.value order by tag.value collate "C")
        from pg_catalog.unnest(event_trigger.evttags) tag(value)
      )
    end
  ) as row_json
  from pg_catalog.pg_event_trigger event_trigger
  left join pg_catalog.pg_proc procedure
    on procedure.oid = event_trigger.evtfoid
  left join pg_catalog.pg_namespace function_namespace
    on function_namespace.oid = procedure.pronamespace
  left join bound_handler_rows bound_handler
    on bound_handler.routine_oid = event_trigger.evtfoid
  left join pg_catalog.pg_roles owner_role
    on owner_role.oid = event_trigger.evtowner
),
runtime_anchor_names(anchor_name) as (
  values
    ('anon'::text),
    ('authenticated'::text),
    ('service_role'::text),
    ('authenticator'::text)
),
runtime_anchor_rows as (
  select pg_catalog.jsonb_build_object(
    'row_schema', 'cnyos-runtime-role-anchor/v1',
    'anchor_name', anchor.anchor_name,
    'role_exists', role.oid is not null,
    'role_oid', role.oid::text
  ) as row_json
  from runtime_anchor_names anchor
  left join pg_catalog.pg_roles role
    on role.rolname = anchor.anchor_name
  union all
  select pg_catalog.jsonb_build_object(
    'row_schema', 'cnyos-runtime-role-anchor/v1',
    'anchor_name', 'PUBLIC',
    'role_exists', true,
    'role_oid', '0',
    'pseudo_role', true
  )
),
existing_runtime_anchor_oids(role_oid) as (
  select role.oid
  from runtime_anchor_names anchor
  join pg_catalog.pg_roles role
    on role.rolname = anchor.anchor_name
),
connected_role_oids(role_oid) as (
  select role_oid from existing_runtime_anchor_oids
  union
  select case when membership.member = connected.role_oid
    then membership.roleid
    else membership.member
  end
  from connected_role_oids connected
  join pg_catalog.pg_auth_members membership
    on membership.member = connected.role_oid
    or membership.roleid = connected.role_oid
),
connected_role_nodes as (
  select
    role.oid as role_oid,
    role.rolname as role_name,
    pg_catalog.jsonb_build_object(
      'row_schema', 'cnyos-connected-runtime-role/v1',
      'role_oid', role.oid::text,
      'role_name', role.rolname,
      'is_runtime_anchor', exists (
        select 1 from runtime_anchor_names anchor
        where anchor.anchor_name = role.rolname
      ),
      'rolsuper', role.rolsuper,
      'rolinherit', role.rolinherit,
      'rolcreaterole', role.rolcreaterole,
      'rolcreatedb', role.rolcreatedb,
      'rolcanlogin', role.rolcanlogin,
      'rolreplication', role.rolreplication,
      'rolconnlimit', role.rolconnlimit,
      'rolvaliduntil', role.rolvaliduntil,
      'rolbypassrls', role.rolbypassrls,
      'rolconfig', pg_catalog.to_jsonb(role.rolconfig)
    ) as row_json
  from connected_role_oids connected
  join pg_catalog.pg_roles role on role.oid = connected.role_oid
),
connected_role_edges as (
  select pg_catalog.jsonb_build_object(
    'row_schema', 'cnyos-connected-runtime-role-edge/v1',
    'membership_oid', membership.oid::text,
    'granted_role_oid', membership.roleid::text,
    'granted_role_name', granted_role.rolname,
    'member_role_oid', membership.member::text,
    'member_role_name', member_role.rolname,
    'grantor_oid', membership.grantor::text,
    'grantor_name', grantor_role.rolname,
    'admin_option', membership.admin_option,
    'inherit_option', membership.inherit_option,
    'set_option', membership.set_option
  ) as row_json
  from pg_catalog.pg_auth_members membership
  join connected_role_oids connected_granted
    on connected_granted.role_oid = membership.roleid
  join connected_role_oids connected_member
    on connected_member.role_oid = membership.member
  left join pg_catalog.pg_roles granted_role
    on granted_role.oid = membership.roleid
  left join pg_catalog.pg_roles member_role
    on member_role.oid = membership.member
  left join pg_catalog.pg_roles grantor_role
    on grantor_role.oid = membership.grantor
),
routine_public_privileges as (
  select
    routine.oid as routine_oid,
    coalesce(pg_catalog.bool_or(
      acl.privilege_type = 'EXECUTE'
    ) filter (where acl.grantee = 0::oid), false) as execute,
    coalesce(pg_catalog.bool_or(
      acl.privilege_type = 'EXECUTE' and acl.is_grantable
    ) filter (where acl.grantee = 0::oid), false) as execute_grantable
  from public_routines routine
  left join lateral pg_catalog.aclexplode(coalesce(
    routine.proacl,
    pg_catalog.acldefault('f', routine.proowner)
  )) acl on true
  group by routine.oid
),
public_schema_public_privileges as (
  select
    namespace.namespace_oid,
    coalesce(pg_catalog.bool_or(
      acl.privilege_type = 'USAGE'
    ) filter (where acl.grantee = 0::oid), false) as usage,
    coalesce(pg_catalog.bool_or(
      acl.privilege_type = 'USAGE' and acl.is_grantable
    ) filter (where acl.grantee = 0::oid), false) as usage_grantable,
    coalesce(pg_catalog.bool_or(
      acl.privilege_type = 'CREATE'
    ) filter (where acl.grantee = 0::oid), false) as create_privilege,
    coalesce(pg_catalog.bool_or(
      acl.privilege_type = 'CREATE' and acl.is_grantable
    ) filter (where acl.grantee = 0::oid), false) as create_grantable
  from public_namespace namespace
  left join lateral pg_catalog.aclexplode(coalesce(
    namespace.nspacl,
    pg_catalog.acldefault('n', namespace.nspowner)
  )) acl on true
  group by namespace.namespace_oid
),
required_runtime_role_names(role_name, is_public_pseudo_role) as (
  values
    ('PUBLIC'::text, true),
    ('anon'::text, false),
    ('authenticated'::text, false),
    ('service_role'::text, false)
),
required_effective_runtime_roles as (
  select
    case when required.is_public_pseudo_role then 0::oid
      else role.oid
    end as role_oid,
    required.role_name,
    required.is_public_pseudo_role or role.oid is not null as role_exists,
    required.is_public_pseudo_role
  from required_runtime_role_names required
  left join pg_catalog.pg_roles role
    on not required.is_public_pseudo_role
   and role.rolname = required.role_name
),
effective_routine_access_rows as (
  select
    case when routine.is_extension_member
      then 'extension_member'
      else 'non_extension_application'
    end as classification,
    routine.oid as routine_oid,
    pg_catalog.jsonb_build_object(
      'row_schema', 'cnyos-public-routine-effective-access/v1',
      'classification', case when routine.is_extension_member
        then 'extension_member'
        else 'non_extension_application'
      end,
      'routine_oid', routine.oid::text,
      'signature', routine.oid::pg_catalog.regprocedure::text,
      'role_oid', runtime_role.role_oid::text,
      'role_name', runtime_role.role_name,
      'role_exists', runtime_role.role_exists,
      'is_public_pseudo_role', runtime_role.is_public_pseudo_role,
      'schema_usage', case when runtime_role.is_public_pseudo_role
        then schema_public.usage
        when runtime_role.role_exists then pg_catalog.has_schema_privilege(
          runtime_role.role_oid,
          routine.public_namespace_oid,
          'USAGE'
        )
        else false
      end,
      'function_execute', case when runtime_role.is_public_pseudo_role
        then routine_public.execute
        when runtime_role.role_exists then pg_catalog.has_function_privilege(
          runtime_role.role_oid,
          routine.oid,
          'EXECUTE'
        )
        else false
      end,
      'function_execute_with_grant_option',
        case when runtime_role.is_public_pseudo_role
          then routine_public.execute_grantable
          when runtime_role.role_exists then pg_catalog.has_function_privilege(
            runtime_role.role_oid,
            routine.oid,
            'EXECUTE WITH GRANT OPTION'
          )
          else false
        end,
      'invocable_through_public_schema',
        case when runtime_role.is_public_pseudo_role
          then schema_public.usage and routine_public.execute
          when runtime_role.role_exists then
            pg_catalog.has_schema_privilege(
              runtime_role.role_oid,
              routine.public_namespace_oid,
              'USAGE'
            ) and pg_catalog.has_function_privilege(
              runtime_role.role_oid,
              routine.oid,
              'EXECUTE'
            )
          else false
        end
    ) as row_json
  from public_routines routine
  join routine_public_privileges routine_public
    on routine_public.routine_oid = routine.oid
  join public_schema_public_privileges schema_public
    on schema_public.namespace_oid = routine.public_namespace_oid
  cross join required_effective_runtime_roles runtime_role
),
connected_routine_effective_diagnostic_rows as (
  select pg_catalog.jsonb_build_object(
    'row_schema',
      'cnyos-connected-role-public-routine-effective-access/v1',
    'routine_oid', routine.oid::text,
    'signature', routine.oid::pg_catalog.regprocedure::text,
    'role_oid', role.role_oid::text,
    'role_name', role.role_name,
    'schema_usage', pg_catalog.has_schema_privilege(
      role.role_oid,
      routine.public_namespace_oid,
      'USAGE'
    ),
    'function_execute', pg_catalog.has_function_privilege(
      role.role_oid,
      routine.oid,
      'EXECUTE'
    ),
    'invocable_through_public_schema',
      pg_catalog.has_schema_privilege(
        role.role_oid,
        routine.public_namespace_oid,
        'USAGE'
      ) and pg_catalog.has_function_privilege(
        role.role_oid,
        routine.oid,
        'EXECUTE'
      )
  ) as row_json
  from public_routines routine
  cross join connected_role_nodes role
  where role.role_name not in ('anon', 'authenticated', 'service_role')
),
public_schema_acl_rows as (
  select pg_catalog.jsonb_build_object(
    'row_schema', 'cnyos-public-schema-raw-acl/v1',
    'schema_exists', true,
    'schema_oid', namespace.namespace_oid::text,
    'schema_name', namespace.nspname,
    'owner_oid', namespace.nspowner::text,
    'owner_name', owner_role.rolname,
    'nspacl_is_null', namespace.nspacl is null,
    'raw_nspacl_text', namespace.nspacl::text,
    'expanded_acl_source', case when namespace.nspacl is null
      then 'implicit_hard_wired_schema_default'
      else 'explicit_pg_namespace_nspacl'
    end,
    'expanded_acl_rows', coalesce(
      expanded_acl.rows,
      '[]'::pg_catalog.jsonb
    )
  ) as row_json
  from public_namespace namespace
  left join pg_catalog.pg_roles owner_role
    on owner_role.oid = namespace.nspowner
  left join lateral (
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'grantor_oid', acl.grantor::text,
        'grantor_label', case when acl.grantor = 0::oid
          then 'PUBLIC'
          when grantor_role.rolname is not null then grantor_role.rolname
          else 'OID:' || acl.grantor::text
        end,
        'grantee_oid', acl.grantee::text,
        'grantee_label', case when acl.grantee = 0::oid
          then 'PUBLIC'
          when grantee_role.rolname is not null then grantee_role.rolname
          else 'OID:' || acl.grantee::text
        end,
        'privilege_type', acl.privilege_type,
        'is_grantable', acl.is_grantable
      ) order by
        acl.grantee,
        acl.privilege_type collate "C",
        acl.is_grantable,
        acl.grantor
    ) as rows
    from pg_catalog.aclexplode(coalesce(
      namespace.nspacl,
      pg_catalog.acldefault('n', namespace.nspowner)
    )) acl
    left join pg_catalog.pg_roles grantee_role
      on acl.grantee <> 0::oid
     and grantee_role.oid = acl.grantee
    left join pg_catalog.pg_roles grantor_role
      on acl.grantor <> 0::oid
     and grantor_role.oid = acl.grantor
  ) expanded_acl on true
  union all
  select pg_catalog.jsonb_build_object(
    'row_schema', 'cnyos-public-schema-raw-acl/v1',
    'schema_exists', false,
    'schema_name', 'public'
  )
  where not exists (select 1 from public_namespace)
),
public_schema_effective_rows as (
  select pg_catalog.jsonb_build_object(
    'row_schema', 'cnyos-public-schema-effective-access/v1',
    'schema_oid', namespace.namespace_oid::text,
    'schema_name', namespace.nspname,
    'role_oid', runtime_role.role_oid::text,
    'role_name', runtime_role.role_name,
    'role_exists', runtime_role.role_exists,
    'is_public_pseudo_role', runtime_role.is_public_pseudo_role,
    'usage', case when runtime_role.is_public_pseudo_role
      then public_privilege.usage
      when runtime_role.role_exists then pg_catalog.has_schema_privilege(
        runtime_role.role_oid,
        namespace.namespace_oid,
        'USAGE'
      )
      else false
    end,
    'usage_with_grant_option',
      case when runtime_role.is_public_pseudo_role
        then public_privilege.usage_grantable
        when runtime_role.role_exists then pg_catalog.has_schema_privilege(
          runtime_role.role_oid,
          namespace.namespace_oid,
          'USAGE WITH GRANT OPTION'
        )
        else false
      end,
    'create', case when runtime_role.is_public_pseudo_role
      then public_privilege.create_privilege
      when runtime_role.role_exists then pg_catalog.has_schema_privilege(
        runtime_role.role_oid,
        namespace.namespace_oid,
        'CREATE'
      )
      else false
    end,
    'create_with_grant_option',
      case when runtime_role.is_public_pseudo_role
        then public_privilege.create_grantable
        when runtime_role.role_exists then pg_catalog.has_schema_privilege(
          runtime_role.role_oid,
          namespace.namespace_oid,
          'CREATE WITH GRANT OPTION'
        )
        else false
      end
  ) as row_json
  from public_namespace namespace
  join public_schema_public_privileges public_privilege
    on public_privilege.namespace_oid = namespace.namespace_oid
  cross join required_effective_runtime_roles runtime_role
),
connected_schema_effective_diagnostic_rows as (
  select pg_catalog.jsonb_build_object(
    'row_schema', 'cnyos-connected-role-public-schema-effective-access/v1',
    'schema_oid', namespace.namespace_oid::text,
    'schema_name', namespace.nspname,
    'role_oid', role.role_oid::text,
    'role_name', role.role_name,
    'usage', pg_catalog.has_schema_privilege(
      role.role_oid,
      namespace.namespace_oid,
      'USAGE'
    ),
    'create', pg_catalog.has_schema_privilege(
      role.role_oid,
      namespace.namespace_oid,
      'CREATE'
    )
  ) as row_json
  from public_namespace namespace
  cross join connected_role_nodes role
  where role.role_name not in ('anon', 'authenticated', 'service_role')
),
relevant_default_acl_owner_oids(role_oid) as (
  select distinct routine.proowner from public_routines routine
  union
  select namespace.nspowner from public_namespace namespace
  union
  select role.oid
  from pg_catalog.pg_roles role
  cross join public_namespace namespace
  where pg_catalog.has_schema_privilege(
    role.oid,
    namespace.namespace_oid,
    'CREATE'
  )
  union
  select default_acl.defaclrole
  from pg_catalog.pg_default_acl default_acl
  where default_acl.defaclobjtype = 'f'
    and (
      default_acl.defaclnamespace = 0::oid
      or default_acl.defaclnamespace in (
        select namespace_oid from public_namespace
      )
    )
),
default_acl_scopes as (
  select
    'global'::text as scope_name,
    0::oid as namespace_oid,
    null::text as namespace_name
  union all
  select
    'public_schema'::text,
    namespace.namespace_oid,
    namespace.nspname
  from public_namespace namespace
),
function_default_acl_rows as (
  select pg_catalog.jsonb_build_object(
    'row_schema', 'cnyos-function-default-acl/v1',
    'owner_oid', owner.role_oid::text,
    'owner_name', owner_role.rolname,
    'scope', scope.scope_name,
    'namespace_oid', scope.namespace_oid::text,
    'namespace_name', scope.namespace_name,
    'catalog_row_present', default_acl.oid is not null,
    'default_acl_oid', default_acl.oid::text,
    'object_type', 'FUNCTION',
    'raw_defaclacl_text', default_acl.defaclacl::text,
    'owner_effective_create_on_public', exists (
      select 1
      from public_namespace public_namespace_for_owner
      where pg_catalog.has_schema_privilege(
        owner.role_oid,
        public_namespace_for_owner.namespace_oid,
        'CREATE'
      )
    ),
    'absent_row_semantics', case
      when default_acl.oid is not null then
        'catalog_row_supplies_function_default_acl'
      when scope.scope_name = 'global' then
        'hard_wired_function_default_applies_owner_and_public_execute'
      else
        'no_public_schema_specific_function_default_acl_contribution'
    end,
    'expanded_or_contribution_acl_rows', coalesce(
      expanded_acl.rows,
      '[]'::pg_catalog.jsonb
    )
  ) as row_json
  from relevant_default_acl_owner_oids owner
  left join pg_catalog.pg_roles owner_role
    on owner_role.oid = owner.role_oid
  cross join default_acl_scopes scope
  left join pg_catalog.pg_default_acl default_acl
    on default_acl.defaclrole = owner.role_oid
   and default_acl.defaclnamespace = scope.namespace_oid
   and default_acl.defaclobjtype = 'f'
  left join lateral (
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'grantor_oid', acl.grantor::text,
        'grantor_label', case when acl.grantor = 0::oid
          then 'PUBLIC'
          when grantor_role.rolname is not null then grantor_role.rolname
          else 'OID:' || acl.grantor::text
        end,
        'grantee_oid', acl.grantee::text,
        'grantee_label', case when acl.grantee = 0::oid
          then 'PUBLIC'
          when grantee_role.rolname is not null then grantee_role.rolname
          else 'OID:' || acl.grantee::text
        end,
        'privilege_type', acl.privilege_type,
        'is_grantable', acl.is_grantable
      ) order by
        acl.grantee,
        acl.privilege_type collate "C",
        acl.is_grantable,
        acl.grantor
    ) as rows
    from pg_catalog.aclexplode(
      case
        when default_acl.oid is not null then default_acl.defaclacl
        when scope.scope_name = 'global' then
          pg_catalog.acldefault('f', owner.role_oid)
        else null::aclitem[]
      end
    ) acl
    left join pg_catalog.pg_roles grantee_role
      on acl.grantee <> 0::oid
     and grantee_role.oid = acl.grantee
    left join pg_catalog.pg_roles grantor_role
      on acl.grantor <> 0::oid
     and grantor_role.oid = acl.grantor
  ) expanded_acl on true
),
function_default_acl_future_public_rows as (
  select pg_catalog.jsonb_build_object(
    'row_schema', 'cnyos-future-public-function-execute/v1',
    'owner_oid', owner.role_oid::text,
    'owner_name', owner_role.rolname,
    'owner_effective_create_on_public', exists (
      select 1
      from public_namespace public_namespace_for_owner
      where pg_catalog.has_schema_privilege(
        owner.role_oid,
        public_namespace_for_owner.namespace_oid,
        'CREATE'
      )
    ),
    'global_catalog_row_present', global_default.oid is not null,
    'global_default_acl_oid', global_default.oid::text,
    'global_raw_defaclacl_text', global_default.defaclacl::text,
    'global_absent_uses_hard_wired_function_default',
      global_default.oid is null,
    'global_effective_public_execute', global_public.execute,
    'global_effective_public_execute_grantable',
      global_public.execute_grantable,
    'public_schema_catalog_row_present', schema_default.oid is not null,
    'public_schema_default_acl_oid', schema_default.oid::text,
    'public_schema_raw_defaclacl_text', schema_default.defaclacl::text,
    'public_schema_public_execute_contribution', schema_public.execute,
    'public_schema_public_execute_grantable_contribution',
      schema_public.execute_grantable,
    'future_public_function_execute_in_public_schema',
      global_public.execute or schema_public.execute,
    'future_public_function_execute_grantable_in_public_schema',
      global_public.execute_grantable or schema_public.execute_grantable
  ) as row_json
  from relevant_default_acl_owner_oids owner
  left join pg_catalog.pg_roles owner_role
    on owner_role.oid = owner.role_oid
  left join pg_catalog.pg_default_acl global_default
    on global_default.defaclrole = owner.role_oid
   and global_default.defaclnamespace = 0::oid
   and global_default.defaclobjtype = 'f'
  left join pg_catalog.pg_default_acl schema_default
    on schema_default.defaclrole = owner.role_oid
   and schema_default.defaclnamespace in (
     select namespace_oid from public_namespace
   )
   and schema_default.defaclobjtype = 'f'
  left join lateral (
    select
      coalesce(pg_catalog.bool_or(
        acl.privilege_type = 'EXECUTE'
      ) filter (where acl.grantee = 0::oid), false) as execute,
      coalesce(pg_catalog.bool_or(
        acl.privilege_type = 'EXECUTE' and acl.is_grantable
      ) filter (where acl.grantee = 0::oid), false) as execute_grantable
    from pg_catalog.aclexplode(coalesce(
      global_default.defaclacl,
      pg_catalog.acldefault('f', owner.role_oid)
    )) acl
  ) global_public on true
  left join lateral (
    select
      coalesce(pg_catalog.bool_or(
        acl.privilege_type = 'EXECUTE'
      ) filter (where acl.grantee = 0::oid), false) as execute,
      coalesce(pg_catalog.bool_or(
        acl.privilege_type = 'EXECUTE' and acl.is_grantable
      ) filter (where acl.grantee = 0::oid), false) as execute_grantable
    from pg_catalog.aclexplode(schema_default.defaclacl) acl
  ) schema_public on true
),
acl_identity_references as (
  select
    'public_routine'::text as source_kind,
    routine.oid::text as source_oid,
    routine.oid::pg_catalog.regprocedure::text as source_name,
    acl.grantor,
    acl.grantee,
    acl.privilege_type,
    acl.is_grantable
  from public_routines routine
  cross join lateral pg_catalog.aclexplode(coalesce(
    routine.proacl,
    pg_catalog.acldefault('f', routine.proowner)
  )) acl
  union all
  select
    'public_schema',
    namespace.namespace_oid::text,
    namespace.nspname,
    acl.grantor,
    acl.grantee,
    acl.privilege_type,
    acl.is_grantable
  from public_namespace namespace
  cross join lateral pg_catalog.aclexplode(coalesce(
    namespace.nspacl,
    pg_catalog.acldefault('n', namespace.nspowner)
  )) acl
  union all
  select
    'current_database',
    database.oid::text,
    database.datname,
    acl.grantor,
    acl.grantee,
    acl.privilege_type,
    acl.is_grantable
  from current_database_identity current_database_row
  join pg_catalog.pg_database database
    on database.oid = current_database_row.database_oid
  cross join lateral pg_catalog.aclexplode(coalesce(
    database.datacl,
    pg_catalog.acldefault('d', database.datdba)
  )) acl
  union all
  select
    'bound_trigger_handler_language',
    language.oid::text,
    language.lanname,
    acl.grantor,
    acl.grantee,
    acl.privilege_type,
    acl.is_grantable
  from bound_handler_language_oids bound_language
  join pg_catalog.pg_language language
    on language.oid = bound_language.language_oid
  cross join lateral pg_catalog.aclexplode(coalesce(
    language.lanacl,
    pg_catalog.acldefault('l', language.lanowner)
  )) acl
  union all
  select
    'bound_trigger_handler',
    procedure.oid::text,
    procedure.oid::pg_catalog.regprocedure::text,
    acl.grantor,
    acl.grantee,
    acl.privilege_type,
    acl.is_grantable
  from bound_handler_oids bound_handler
  join pg_catalog.pg_proc procedure
    on procedure.oid = bound_handler.routine_oid
  cross join lateral pg_catalog.aclexplode(coalesce(
    procedure.proacl,
    pg_catalog.acldefault('f', procedure.proowner)
  )) acl
  union all
  select
    'security_relevant_schema',
    namespace.oid::text,
    namespace.nspname,
    acl.grantor,
    acl.grantee,
    acl.privilege_type,
    acl.is_grantable
  from security_relevant_namespace_oids selected_namespace
  join pg_catalog.pg_namespace namespace
    on namespace.oid = selected_namespace.namespace_oid
  cross join lateral pg_catalog.aclexplode(coalesce(
    namespace.nspacl,
    pg_catalog.acldefault('n', namespace.nspowner)
  )) acl
  union all
  select
    'function_default_acl_' || scope.scope_name,
    coalesce(default_acl.oid::text, 'ABSENT'),
    coalesce(owner_role.rolname, 'OID:' || owner.role_oid::text),
    acl.grantor,
    acl.grantee,
    acl.privilege_type,
    acl.is_grantable
  from relevant_default_acl_owner_oids owner
  left join pg_catalog.pg_roles owner_role
    on owner_role.oid = owner.role_oid
  cross join default_acl_scopes scope
  left join pg_catalog.pg_default_acl default_acl
    on default_acl.defaclrole = owner.role_oid
   and default_acl.defaclnamespace = scope.namespace_oid
   and default_acl.defaclobjtype = 'f'
  cross join lateral pg_catalog.aclexplode(
    case
      when default_acl.oid is not null then default_acl.defaclacl
      when scope.scope_name = 'global' then
        pg_catalog.acldefault('f', owner.role_oid)
      else null::aclitem[]
    end
  ) acl
),
unresolved_acl_identity_rows as (
  select pg_catalog.jsonb_build_object(
    'row_schema', 'cnyos-unresolved-acl-role-oid/v1',
    'source_kind', reference.source_kind,
    'source_oid', reference.source_oid,
    'source_name', reference.source_name,
    'grantor_oid', reference.grantor::text,
    'grantor_unresolved',
      reference.grantor <> 0::oid and grantor_role.oid is null,
    'grantee_oid', reference.grantee::text,
    'grantee_unresolved',
      reference.grantee <> 0::oid and grantee_role.oid is null,
    'privilege_type', reference.privilege_type,
    'is_grantable', reference.is_grantable
  ) as row_json
  from acl_identity_references reference
  left join pg_catalog.pg_roles grantor_role
    on reference.grantor <> 0::oid
   and grantor_role.oid = reference.grantor
  left join pg_catalog.pg_roles grantee_role
    on reference.grantee <> 0::oid
   and grantee_role.oid = reference.grantee
  where (
    reference.grantor <> 0::oid and grantor_role.oid is null
  ) or (
    reference.grantee <> 0::oid and grantee_role.oid is null
  )
),
dataset_names(dataset_name) as (
  values
    ('public_routines.all.semantic'::text),
    ('public_routines.non_extension_application.semantic'::text),
    ('public_routines.extension_members.semantic'::text),
    ('public_routines.all.raw_acl'::text),
    ('public_routines.non_extension_application.raw_acl'::text),
    ('public_routines.extension_members.raw_acl'::text),
    ('public_routines.all.effective_access'::text),
    ('public_routines.non_extension_application.effective_access'::text),
    ('public_routines.extension_members.effective_access'::text),
    ('extensions.membership_dependencies'::text),
    ('public_schema.raw_acl'::text),
    ('public_schema.effective_access'::text),
    ('runtime_role_graph.anchors'::text),
    ('runtime_role_graph.nodes'::text),
    ('runtime_role_graph.edges'::text),
    ('runtime_role_graph.connected_routine_effective_diagnostics'::text),
    ('runtime_role_graph.connected_schema_effective_diagnostics'::text),
    ('current_database.security'::text),
    ('schemas.all_non_temporary.security'::text),
    ('database_role_settings.current_database_and_global'::text),
    ('function_default_acl.global_and_public_schema'::text),
    ('function_default_acl.future_public_execute'::text),
    ('trigger_bindings.all_non_internal'::text),
    ('event_trigger_bindings.all'::text),
    ('acl_identity.unresolved_nonzero_oids'::text)
),
review_dataset_rows(dataset_name, review_row) as (
  select 'public_routines.all.semantic', row_json from semantic_rows
  union all
  select 'public_routines.non_extension_application.semantic', row_json
  from semantic_rows where classification = 'non_extension_application'
  union all
  select 'public_routines.extension_members.semantic', row_json
  from semantic_rows where classification = 'extension_member'
  union all
  select 'public_routines.all.raw_acl', row_json from raw_routine_acl_rows
  union all
  select 'public_routines.non_extension_application.raw_acl', row_json
  from raw_routine_acl_rows where classification = 'non_extension_application'
  union all
  select 'public_routines.extension_members.raw_acl', row_json
  from raw_routine_acl_rows where classification = 'extension_member'
  union all
  select 'public_routines.all.effective_access', row_json
  from effective_routine_access_rows
  union all
  select 'public_routines.non_extension_application.effective_access', row_json
  from effective_routine_access_rows
  where classification = 'non_extension_application'
  union all
  select 'public_routines.extension_members.effective_access', row_json
  from effective_routine_access_rows where classification = 'extension_member'
  union all
  select 'extensions.membership_dependencies', row_json
  from extension_membership_rows
  union all
  select 'public_schema.raw_acl', row_json from public_schema_acl_rows
  union all
  select 'public_schema.effective_access', row_json
  from public_schema_effective_rows
  union all
  select 'runtime_role_graph.anchors', row_json from runtime_anchor_rows
  union all
  select 'runtime_role_graph.nodes', row_json from connected_role_nodes
  union all
  select 'runtime_role_graph.edges', row_json from connected_role_edges
  union all
  select 'runtime_role_graph.connected_routine_effective_diagnostics', row_json
  from connected_routine_effective_diagnostic_rows
  union all
  select 'runtime_role_graph.connected_schema_effective_diagnostics', row_json
  from connected_schema_effective_diagnostic_rows
  union all
  select 'current_database.security', row_json
  from current_database_security
  union all
  select 'schemas.all_non_temporary.security', schema_security.row_json
  from namespace_security_rows schema_security
  join persistent_namespace_oids persistent_namespace
    on persistent_namespace.namespace_oid = schema_security.namespace_oid
  union all
  select 'database_role_settings.current_database_and_global', row_json
  from relevant_database_role_setting_rows
  union all
  select 'function_default_acl.global_and_public_schema', row_json
  from function_default_acl_rows
  union all
  select 'function_default_acl.future_public_execute', row_json
  from function_default_acl_future_public_rows
  union all
  select 'trigger_bindings.all_non_internal', row_json
  from trigger_binding_rows
  union all
  select 'event_trigger_bindings.all', row_json
  from event_trigger_binding_rows
  union all
  select 'acl_identity.unresolved_nonzero_oids', row_json
  from unresolved_acl_identity_rows
),
dataset_rows(dataset_name, digest_row, review_row) as (
  select
    source.dataset_name,
    pg_catalog.jsonb_build_array(
      'cnyos-observation-positional-digest-row/v1',
      source.dataset_name,
      coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_array(field.key, field.value)
          order by field.key collate "C"
        )
        from pg_catalog.jsonb_each(source.review_row) field
      ), '[]'::pg_catalog.jsonb)
    ) as digest_row,
    source.review_row
  from review_dataset_rows source
),
dataset_aggregates as (
  select
    name.dataset_name,
    pg_catalog.count(rows.digest_row)::bigint as row_count,
    coalesce(
      pg_catalog.string_agg(
        rows.digest_row::text,
        E'\n' order by rows.digest_row::text collate "C"
      ) filter (where rows.digest_row is not null),
      ''
    ) as payload_without_terminal_newline,
    coalesce(
      pg_catalog.jsonb_agg(
        rows.digest_row order by rows.digest_row::text collate "C"
      ) filter (where rows.digest_row is not null),
      '[]'::pg_catalog.jsonb
    ) as digest_rows,
    coalesce(
      pg_catalog.jsonb_agg(
        rows.review_row order by rows.digest_row::text collate "C"
      ) filter (where rows.review_row is not null),
      '[]'::pg_catalog.jsonb
    ) as review_rows
  from dataset_names name
  left join dataset_rows rows using (dataset_name)
  group by name.dataset_name
),
dataset_metrics as (
  select
    aggregate.dataset_name,
    aggregate.row_count,
    case when aggregate.row_count = 0 then ''
      else aggregate.payload_without_terminal_newline || E'\n'
    end as canonical_payload,
    aggregate.digest_rows,
    aggregate.review_rows
  from dataset_aggregates aggregate
),
dataset_digests as (
  select
    metric.dataset_name,
    metric.row_count,
    pg_catalog.octet_length(metric.canonical_payload)::bigint as payload_bytes,
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(metric.canonical_payload, 'UTF8')
      ),
      'hex'
    ) as payload_sha256,
    metric.canonical_payload,
    metric.digest_rows,
    metric.review_rows
  from dataset_metrics metric
),
digest_manifest_rows as (
  select pg_catalog.jsonb_build_array(
    'cnyos-observation-dataset-digest/v1',
    digest.dataset_name,
    digest.row_count,
    digest.payload_bytes,
    digest.payload_sha256
  ) as row_json
  from dataset_digests digest
),
digest_manifest as (
  select
    pg_catalog.count(*)::bigint as row_count,
    pg_catalog.string_agg(
      row_json::text,
      E'\n' order by row_json::text collate "C"
    ) || E'\n' as canonical_payload,
    pg_catalog.jsonb_agg(
      row_json order by row_json::text collate "C"
    ) as review_rows
  from digest_manifest_rows
),
review_dataset_object as (
  select pg_catalog.jsonb_object_agg(
    digest.dataset_name,
    pg_catalog.jsonb_build_object(
      'row_count', digest.row_count,
      'payload_bytes', digest.payload_bytes,
      'payload_sha256', digest.payload_sha256,
      'canonical_payload', digest.canonical_payload,
      'canonical_line_format', 'one positional jsonb digest row plus LF',
      'digest_row_schema',
        'cnyos-observation-positional-digest-row/v1',
      'digest_rows', digest.digest_rows,
      'review_rows', digest.review_rows
    ) order by digest.dataset_name collate "C"
  ) as value
  from dataset_digests digest
)
select pg_catalog.jsonb_build_object(
  'artifact_schema', 'cnyos-public-routine-acl-observation/v2',
  'status', 'CNYOS_PUBLIC_ROUTINE_INVENTORY_OBSERVED',
  'authorization', false,
  'production_eligible', false,
  'source_metadata', pg_catalog.jsonb_build_object(
    'source_revision', parameters.source_revision,
    'project_label', parameters.project_label,
    'artifact_path',
      'supabase/manual/public_routine_acl_inventory_read_only.sql',
    'operator_supplied_metadata_only', true,
    'target_authorization_claimed', false
  ),
  'observed_server', pg_catalog.jsonb_build_object(
    'current_database', pg_catalog.current_database(),
    'session_user', session_user,
    'current_user', current_user,
    'system_identifier', (
      select control.system_identifier::text
      from pg_catalog.pg_control_system() control
    ),
    'server_version', pg_catalog.current_setting('server_version'),
    'server_version_num',
      pg_catalog.current_setting('server_version_num'),
    'server_encoding', pg_catalog.current_setting('server_encoding'),
    'captured_at', pg_catalog.transaction_timestamp()
  ),
  'observation_transaction', pg_catalog.jsonb_build_object(
    'transaction_isolation',
      pg_catalog.current_setting('transaction_isolation'),
    'transaction_read_only',
      pg_catalog.current_setting('transaction_read_only'),
    'search_path', pg_catalog.current_setting('search_path'),
    'output_gucs', pg_catalog.jsonb_build_object(
      'client_encoding', pg_catalog.current_setting('client_encoding'),
      'timezone', pg_catalog.current_setting('TimeZone'),
      'datestyle', pg_catalog.current_setting('DateStyle'),
      'intervalstyle', pg_catalog.current_setting('IntervalStyle'),
      'extra_float_digits',
        pg_catalog.current_setting('extra_float_digits'),
      'bytea_output', pg_catalog.current_setting('bytea_output'),
      'quote_all_identifiers',
        pg_catalog.current_setting('quote_all_identifiers'),
      'standard_conforming_strings',
        pg_catalog.current_setting('standard_conforming_strings'),
      'lc_monetary', pg_catalog.current_setting('lc_monetary'),
      'lc_numeric', pg_catalog.current_setting('lc_numeric'),
      'lc_time', pg_catalog.current_setting('lc_time')
    ),
    'catalog_lock_mode', 'ACCESS SHARE',
    'catalog_lock_limit',
      'read-only transactions cannot take write-conflicting catalog locks',
    'rollback_required_before_output', true,
    'advisory_unlock_required_before_output', true
  ),
  'public_routine_sections', pg_catalog.jsonb_build_object(
    'all', pg_catalog.jsonb_build_array(
      'public_routines.all.semantic',
      'public_routines.all.raw_acl',
      'public_routines.all.effective_access'
    ),
    'non_extension_application', pg_catalog.jsonb_build_array(
      'public_routines.non_extension_application.semantic',
      'public_routines.non_extension_application.raw_acl',
      'public_routines.non_extension_application.effective_access'
    ),
    'extension_members', pg_catalog.jsonb_build_array(
      'public_routines.extension_members.semantic',
      'public_routines.extension_members.raw_acl',
      'public_routines.extension_members.effective_access',
      'extensions.membership_dependencies'
    )
  ),
  'public_schema_datasets', pg_catalog.jsonb_build_array(
    'public_schema.raw_acl',
    'public_schema.effective_access'
  ),
  'runtime_role_graph_datasets', pg_catalog.jsonb_build_array(
    'runtime_role_graph.anchors',
    'runtime_role_graph.nodes',
    'runtime_role_graph.edges',
    'runtime_role_graph.connected_routine_effective_diagnostics',
    'runtime_role_graph.connected_schema_effective_diagnostics'
  ),
  'database_role_setting_dataset',
    'database_role_settings.current_database_and_global',
  'current_database_security_dataset',
    'current_database.security',
  'persistent_schema_security_dataset',
    'schemas.all_non_temporary.security',
  'function_default_acl_datasets', pg_catalog.jsonb_build_array(
    'function_default_acl.global_and_public_schema',
    'function_default_acl.future_public_execute'
  ),
  'routine_binding_datasets', pg_catalog.jsonb_build_array(
    'trigger_bindings.all_non_internal',
    'event_trigger_bindings.all'
  ),
  'unresolved_acl_identity_dataset',
    'acl_identity.unresolved_nonzero_oids',
  'review_datasets', review_dataset_object.value,
  'composite_digest', pg_catalog.jsonb_build_object(
    'row_count', digest_manifest.row_count,
    'payload_bytes',
      pg_catalog.octet_length(digest_manifest.canonical_payload),
    'payload_sha256', pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(digest_manifest.canonical_payload, 'UTF8')
      ),
      'hex'
    ),
    'canonical_payload', digest_manifest.canonical_payload,
    'canonical_line_format', 'ordered dataset digest jsonb rows plus LF',
    'review_rows', digest_manifest.review_rows
  )
)::text as cnyos_public_routine_acl_observation
from parameters
cross join review_dataset_object
cross join digest_manifest
\gset
-- CNYOS_OBSERVATION_CAPTURE_END

rollback;

select pg_catalog.pg_advisory_unlock(202608302100::bigint)
  as cnyos_observation_lock_released
\gset
\if :cnyos_observation_lock_released
select not exists (
  select 1
  from pg_catalog.pg_locks lock_row
  where lock_row.locktype = 'advisory'
    and lock_row.pid = pg_catalog.pg_backend_pid()
    and lock_row.granted
    and lock_row.classid::bigint = (202608302100::bigint >> 32)
    and lock_row.objid::bigint =
        (202608302100::bigint & 4294967295::bigint)
    and lock_row.objsubid = 1
) as cnyos_observation_lock_fully_released
\gset
\if :cnyos_observation_lock_fully_released
select (
  :'cnyos_public_routine_acl_observation'::pg_catalog.jsonb ||
  pg_catalog.jsonb_build_object(
    'observation_transaction_rolled_back', true,
    'advisory_lock_released', true
  )
)
  as public_routine_acl_observation;
\else
do $cnyos_observation_unlock_abort$
begin
  raise exception 'CNYOS_PUBLIC_ROUTINE_OBSERVATION_ADVISORY_UNLOCK_FAILED';
end
$cnyos_observation_unlock_abort$;
\endif
\else
do $cnyos_observation_unlock_abort$
begin
  raise exception 'CNYOS_PUBLIC_ROUTINE_OBSERVATION_ADVISORY_UNLOCK_FAILED';
end
$cnyos_observation_unlock_abort$;
\endif

\unset cnyos_observation_probe_xid
\unset cnyos_observation_existing_transaction
\unset cnyos_observation_metadata_valid
\unset cnyos_observation_lock_unheld
\unset cnyos_observation_lock_acquired
\unset cnyos_observation_lock_released
\unset cnyos_observation_lock_fully_released
\unset cnyos_public_routine_acl_observation
