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
  pg_catalog.pg_aggregate
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
    ('function_default_acl.global_and_public_schema'::text),
    ('function_default_acl.future_public_execute'::text),
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
  select 'function_default_acl.global_and_public_schema', row_json
  from function_default_acl_rows
  union all
  select 'function_default_acl.future_public_execute', row_json
  from function_default_acl_future_public_rows
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
  'artifact_schema', 'cnyos-public-routine-acl-observation/v1',
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
        pg_catalog.current_setting('standard_conforming_strings')
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
  'function_default_acl_datasets', pg_catalog.jsonb_build_array(
    'function_default_acl.global_and_public_schema',
    'function_default_acl.future_public_execute'
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
