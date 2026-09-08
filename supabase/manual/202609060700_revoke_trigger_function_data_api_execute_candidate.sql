-- This manual candidate is a psql program, not migration-runner SQL. It must
-- begin in a fresh direct psql session so its COMMIT can never commit unrelated
-- caller work. A later ordered migration must use a separately reviewed,
-- migration-native transaction envelope; do not copy this wrapper into it.

\set ON_ERROR_STOP 1
\set ON_ERROR_ROLLBACK off
\unset cnyos_acl_candidate_probe_xid
\unset cnyos_acl_candidate_existing_transaction

\if :AUTOCOMMIT
\else
\warn 'CNYOS ACL candidate requires psql AUTOCOMMIT=on; rolling back and refusing execution'
rollback;
do $cnyos_acl_psql_preflight_abort$
begin
  raise exception 'CNYOS_ACL_CANDIDATE_PSQL_AUTOCOMMIT_REQUIRED';
end
$cnyos_acl_psql_preflight_abort$;
\endif

set search_path = pg_catalog, pg_temp;

-- Adjacent top-level XIDs distinguish a fresh AUTOCOMMIT session from an
-- included file running inside a caller transaction. On detection the caller
-- transaction is rolled back before the abort, so the tail COMMIT is unreachable
-- with pre-existing caller writes.
select pg_catalog.pg_current_xact_id()::text as cnyos_acl_candidate_probe_xid
\gset
select (
  pg_catalog.pg_current_xact_id()::text = :'cnyos_acl_candidate_probe_xid'
) as cnyos_acl_candidate_existing_transaction
\gset
\if :cnyos_acl_candidate_existing_transaction
\warn 'CNYOS ACL candidate detected and rolled back an existing transaction; refusing execution'
rollback;
do $cnyos_acl_psql_preflight_abort$
begin
  raise exception 'CNYOS_ACL_CANDIDATE_PSQL_EXISTING_TRANSACTION_REFUSED';
end
$cnyos_acl_psql_preflight_abort$;
\endif

-- CNYOS_ACL_SQL_ACQUISITION_BEGIN
do $cnyos_acl_interlock$
begin
  if exists (
    select 1
    from pg_catalog.pg_locks lock_row
    where lock_row.locktype = 'advisory'
      and lock_row.pid = pg_catalog.pg_backend_pid()
      and lock_row.granted
      and lock_row.classid::bigint = (202608302100::bigint >> 32)
      and lock_row.objid::bigint =
          (202608302100::bigint & 4294967295::bigint)
      and lock_row.objsubid = 1
  ) then
    raise exception 'CNYOS_ACL_CANDIDATE_ADVISORY_INTERLOCK_ALREADY_HELD';
  end if;
  if not pg_catalog.pg_try_advisory_lock(202608302100::bigint) then
    raise exception 'CNYOS_ACL_CANDIDATE_ADVISORY_INTERLOCK_BUSY';
  end if;
end
$cnyos_acl_interlock$;

begin isolation level repeatable read read write;
set local search_path = pg_catalog, pg_temp;
set local timezone = 'UTC';
set local datestyle = 'ISO, YMD';
set local intervalstyle = 'postgres';
set local extra_float_digits = 3;
set local bytea_output = 'hex';
set local quote_all_identifiers = off;
set local standard_conforming_strings = on;
lock table pg_catalog.pg_proc, pg_catalog.pg_namespace,
  pg_catalog.pg_trigger, pg_catalog.pg_class, pg_catalog.pg_attribute,
  pg_catalog.pg_constraint, pg_catalog.pg_authid, pg_catalog.pg_auth_members,
  pg_catalog.pg_type, pg_catalog.pg_language, pg_catalog.pg_operator,
  pg_catalog.pg_collation
  in share mode;
lock table public.clinics in share mode;
lock table supabase_migrations.schema_migrations in share mode;
lock table supabase_migrations.cnyos_migration_ledger_repair_receipts in share mode;

-- This reviewed source is deliberately inert until an independent reviewer
-- checks the complete live public-routine raw/effective ACL manifest. The
-- unconditional gate is the first executable statement of the sole mutation
-- DO below, making every REVOKE structurally unreachable even if a client
-- recovers from the statement error through a savepoint.
-- Strict promotion is additionally blocked until the live observer classifies
-- extension-owned public routines and the project's default function ACLs;
-- this candidate deliberately makes no default-ACL mutation.

-- ============================================================
-- TRIGGER FUNCTION DATA API EXECUTE CLOSURE — MIGRATION CANDIDATE
--
-- Do not apply until the target project's migration ledger has been reconciled
-- with the 45-file repository manifest. PostgreSQL invokes trigger functions
-- through trigger bindings; they are implementation details, not supported
-- browser/service RPC endpoints.
--
-- This manual proposal is deliberately nonportable. Before running it, an
-- operator must set the transaction-external session GUCs checked below. The
-- authorization value is an execution interlock: it is not endpoint
-- attestation, change approval, or a security sign-off. The server system ID,
-- exact reconciled ledger evidence, and clinic row are independent checks.
--
-- No target is authorized by this revision: its unconditional live-manifest
-- gate makes it structurally inert. The Chananya pins below are projected
-- scaffolding for a later exact-live-manifest review, not permission to apply.
-- Jitarsa must be reconciled independently. A later ordered-migration PR must
-- deliberately promote/adapt these guards for each reconciled target; copying
-- this token or treating this proposal as Jitarsa approval is invalid.
--
-- The two snapshots below bind this candidate to the reviewed PostgreSQL 17,
-- UTF8 Chananya observation. The reviewed scope is relation-centric: every
-- noninternal trigger on a public relation, auth.users, or any relation whose
-- trigger function is public. A function outside public is always rejected if
-- one of those bindings brings it into scope.
-- ============================================================

do $$
declare
  v_function record;
  v_authorization text;
  v_system_identifier text;
  v_ledger_count bigint;
  v_ledger_manifest_count bigint;
  v_ledger_manifest_payload text;
  v_guard_stage integer;
  v_expected_semantic_bytes bigint;
  v_expected_semantic_sha256 text;
  v_missing text;
  v_trigger_function_count bigint;
  v_trigger_function_payload text;
  v_trigger_binding_count bigint;
  v_trigger_binding_payload text;
begin
  raise exception 'CNYOS_TRIGGER_LIVE_PUBLIC_ROUTINE_MANIFEST_NOT_REVIEWED';

  if current_setting('transaction_read_only') <> 'off' then
    raise exception 'CNYOS_TRIGGER_CANDIDATE_READ_WRITE_REQUIRED';
  end if;
  if current_setting('transaction_isolation') <> 'repeatable read' then
    raise exception 'CNYOS_TRIGGER_CANDIDATE_ISOLATION_INVALID: %',
      current_setting('transaction_isolation');
  end if;
  if current_database() <> 'postgres'
     or session_user <> 'postgres' or current_user <> 'postgres' then
    raise exception
      'CNYOS_TRIGGER_CANDIDATE_DATABASE_IDENTITY_INVALID: database=%, session=%, current=%',
      current_database(),session_user,current_user;
  end if;

  v_authorization := coalesce(
    current_setting('cnyos.trigger_acl_candidate_authorization',true),''
  );
  if v_authorization = '' then
    raise exception 'CNYOS_TRIGGER_CANDIDATE_AUTHORIZATION_REQUIRED';
  end if;
  if v_authorization <>
     'chananya-staging-trigger-acl-candidate-202609060700-reconciled-45' then
    raise exception 'CNYOS_TRIGGER_CANDIDATE_AUTHORIZATION_INVALID';
  end if;

  select system_identifier::text into v_system_identifier
  from pg_control_system();

  if v_system_identifier <> '7666007964130682852' then
    raise exception 'CNYOS_TRIGGER_CANDIDATE_SYSTEM_IDENTIFIER_INVALID: %',
      v_system_identifier;
  end if;
  if coalesce(current_setting('cnyos.trigger_acl_target_project_ref',true),'') <>
       'hsmnjwxurlmsizndjlun'
     or coalesce(current_setting('cnyos.trigger_acl_target_deployment_id',true),'') <>
       'chananya-clinical-staging'
     or coalesce(current_setting('cnyos.trigger_acl_target_environment',true),'') <>
       'staging'
     or coalesce(current_setting('cnyos.trigger_acl_target_clinic_id',true),'') <>
       '00000000-0000-4000-8000-00000000a001'
     or coalesce(current_setting('cnyos.trigger_acl_target_clinic_code',true),'') <>
       'CHANANYA-STG' then
    raise exception 'CNYOS_TRIGGER_CANDIDATE_TARGET_MARKERS_INVALID';
  end if;

  if to_regclass('public.clinics') is null then
    raise exception 'CNYOS_TRIGGER_CANDIDATE_CLINIC_RELATION_MISSING';
  end if;
  if (select count(*) from public.clinics) <> 1
     or not exists (
       select 1 from public.clinics
       where id='00000000-0000-4000-8000-00000000a001'::uuid
         and code='CHANANYA-STG' and active
     ) then
    raise exception 'CNYOS_TRIGGER_CANDIDATE_CLINIC_INVALID';
  end if;

  if to_regclass('supabase_migrations.schema_migrations') is null then
    raise exception 'CNYOS_TRIGGER_CANDIDATE_LEDGER_MISSING';
  end if;
  if (
    select count(*)
    from information_schema.columns
    where table_schema='supabase_migrations'
      and table_name='schema_migrations'
      and (
        (column_name='version' and data_type='text')
        or (column_name='name' and data_type='text')
        or (column_name='statements' and data_type='ARRAY' and udt_name='_text')
      )
  ) <> 3 then
    raise exception 'CNYOS_TRIGGER_CANDIDATE_LEDGER_SHAPE_INVALID';
  end if;

  -- Reconciliation appends one exact filename/SHA marker as the final element
  -- of each statements array. Hashing the 45 canonical rows catches missing,
  -- extra, renamed, swapped/equal-count, reordered-marker, and hash drift.
  select count(*) into v_ledger_count
  from supabase_migrations.schema_migrations;
  select count(*)::bigint,
    coalesce(string_agg(
      manifest_row,E'\n' order by version collate "C"
    ),'') || E'\n'
  into v_ledger_manifest_count,v_ledger_manifest_payload
  from (
    select actual.version,
      actual.version || E'\t' || actual.name || E'\t' ||
        marker.sha256 as manifest_row
    from supabase_migrations.schema_migrations actual
    cross join lateral (
      select
        count(*) filter (
          where evidence.statement ~
            '^-- recovered from supabase/migrations/[0-9]{12,14}_[a-z0-9_]+[.]sql; sha256=[0-9a-f]{64}$'
        ) marker_count,
        min(evidence.statement) filter (
          where evidence.statement ~
            '^-- recovered from supabase/migrations/[0-9]{12,14}_[a-z0-9_]+[.]sql; sha256=[0-9a-f]{64}$'
        ) marker_text,
        min(evidence.ordinality) filter (
          where evidence.statement ~
            '^-- recovered from supabase/migrations/[0-9]{12,14}_[a-z0-9_]+[.]sql; sha256=[0-9a-f]{64}$'
        ) marker_ordinality,
        min(substring(evidence.statement from 'sha256=([0-9a-f]{64})$'))
          filter (
            where evidence.statement ~
              '^-- recovered from supabase/migrations/[0-9]{12,14}_[a-z0-9_]+[.]sql; sha256=[0-9a-f]{64}$'
          ) sha256
      from unnest(coalesce(actual.statements,array[]::text[]))
        with ordinality evidence(statement,ordinality)
    ) marker
    where actual.version is not null
      and actual.name is not null
      and marker.marker_count=1
      and marker.marker_ordinality=cardinality(actual.statements)
      and marker.marker_text=
        '-- recovered from supabase/migrations/' || actual.version || '_' ||
        actual.name || '.sql; sha256=' || marker.sha256
  ) canonical_ledger;
  if v_ledger_count <> 45
     or v_ledger_manifest_count <> 45
     or octet_length(v_ledger_manifest_payload) <> 4838
     or encode(sha256(convert_to(v_ledger_manifest_payload,'UTF8')),'hex') <>
       'b21bf64a89aaa01cf757a14c74dcbd02caa5c7dfb6e43bc2215bbd70291a1e0a' then
    raise exception
      'CNYOS_TRIGGER_CANDIDATE_LEDGER_MANIFEST_INVALID: rows=%, canonical=%, bytes=%, sha256=%',
      v_ledger_count,v_ledger_manifest_count,
      octet_length(v_ledger_manifest_payload),
      encode(sha256(convert_to(v_ledger_manifest_payload,'UTF8')),'hex');
  end if;

  if not exists (
    select 1
    from supabase_migrations.cnyos_migration_ledger_repair_receipts receipt
    where receipt.committed_at is not null
      and receipt.gate_token ~ '^[0-9a-f]{64}$'
      and receipt.repair_xid ~ '^[0-9]+$'
      and pg_catalog.jsonb_typeof(receipt.evidence)='object'
      and (receipt.evidence->>'repair_gate_token'=receipt.gate_token
        and receipt.evidence->>'repair_run_nonce'=receipt.run_nonce::text
        and receipt.evidence->>'repair_transaction_xid'=receipt.repair_xid
        and receipt.evidence->>'status'=
          'CNYOS_CHANANYA_STAGING_LEDGER_RECONCILED_BROWSER_RPC_AND_TRIGGER_REMEDIATIONS_PENDING'
        and receipt.evidence->>'expected_project_ref'=
          current_setting('cnyos.trigger_acl_target_project_ref')
        and receipt.evidence->>'expected_deployment_id'=
          current_setting('cnyos.trigger_acl_target_deployment_id')
        and receipt.evidence->>'expected_clinic_id'=
          current_setting('cnyos.trigger_acl_target_clinic_id')
        and receipt.evidence->>'expected_clinic_code'=
          current_setting('cnyos.trigger_acl_target_clinic_code')
        and receipt.evidence->>'expected_current_database'=current_database()
        and receipt.evidence->>'observed_current_database'=current_database()
        and receipt.evidence->>'expected_system_identifier'=v_system_identifier
        and receipt.evidence->>'observed_system_identifier'=v_system_identifier
        and receipt.evidence->>'acl_phase'='chananya-pre-reconciliation'
        and receipt.evidence->>'migration_manifest_sha256'=
          'b21bf64a89aaa01cf757a14c74dcbd02caa5c7dfb6e43bc2215bbd70291a1e0a'
        and receipt.evidence->>'migration_count'='45'
        and receipt.evidence->>'ledger_reconciled'='true'
        and receipt.evidence->>'acl_remediation_pending'='true'
        and receipt.evidence->>'browser_rpc_acl_remediation_pending'='true'
        and receipt.evidence->>'trigger_function_acl_remediation_pending'='true'
        and receipt.evidence->>'production_eligible'='false'
        and receipt.evidence->>'source_revision' ~ '^[0-9a-f]{40}$') is true
  ) then
    raise exception 'CNYOS_TRIGGER_CANDIDATE_DURABLE_LEDGER_RECEIPT_INVALID';
  end if;

  if current_setting('server_version_num')::integer / 10000 <> 17 then
    raise exception 'CNYOS_TRIGGER_SERVER_MAJOR_INVALID: %',
      current_setting('server_version_num');
  end if;
  if current_setting('server_encoding') <> 'UTF8' then
    raise exception 'CNYOS_TRIGGER_SERVER_ENCODING_INVALID: %',
      current_setting('server_encoding');
  end if;

  -- Stage 1 authenticates the exact pre-remediation observation. Stage 2
  -- authenticates the one intended semantic change and proves that no trigger
  -- binding moved while privileges and set_updated_at() were hardened.
  for v_guard_stage in 1..2 loop
    if v_guard_stage = 1 then
      v_expected_semantic_bytes := 21183;
      v_expected_semantic_sha256 :=
        '4c92389f247e80c27c63721eff19f321ed538c8e70d616df5aa36e193cb2eb0b';
    else
      v_expected_semantic_bytes := 21213;
      v_expected_semantic_sha256 :=
        '07535c64e7607d8cc9bc34b197a40e3923f4f56df84262d041d56541b1890737';
    end if;

    select string_agg(
      relation_namespace.nspname || '.' || relation.relname || ' -> ' ||
        function_namespace.nspname || '.' || procedure.proname || '(' ||
        pg_get_function_identity_arguments(procedure.oid) || ')',
      ', ' order by
        relation_namespace.nspname collate "C",
        relation.relname collate "C",
        function_namespace.nspname collate "C",
        procedure.proname collate "C",
        pg_get_function_identity_arguments(procedure.oid) collate "C"
    ) into v_missing
    from pg_trigger trigger
    join pg_class relation on relation.oid=trigger.tgrelid
    join pg_namespace relation_namespace on relation_namespace.oid=relation.relnamespace
    join pg_proc procedure on procedure.oid=trigger.tgfoid
    join pg_namespace function_namespace on function_namespace.oid=procedure.pronamespace
    where not trigger.tgisinternal
      and (
        relation_namespace.nspname='public'
        or (
          relation_namespace.nspname='auth'
          and relation.relname='users'
        )
        or function_namespace.nspname='public'
      )
      and function_namespace.nspname <> 'public';
    if v_missing is not null then
      raise exception 'CNYOS_TRIGGER_FUNCTION_SCHEMA_INVALID: %', v_missing;
    end if;

    select string_agg(
      function_namespace.nspname || '.' || procedure.proname || '(' ||
        pg_get_function_identity_arguments(procedure.oid) || ') -> ' ||
        owner_role.rolname,
      ', ' order by
        function_namespace.nspname collate "C",
        procedure.proname collate "C",
        pg_get_function_identity_arguments(procedure.oid) collate "C"
    ) into v_missing
    from pg_proc procedure
    join pg_namespace function_namespace on function_namespace.oid=procedure.pronamespace
    join pg_roles owner_role on owner_role.oid=procedure.proowner
    where owner_role.rolname <> 'postgres'
      and exists (
        select 1
        from pg_trigger trigger
        join pg_class relation on relation.oid=trigger.tgrelid
        join pg_namespace relation_namespace on relation_namespace.oid=relation.relnamespace
        join pg_proc bound_procedure on bound_procedure.oid=trigger.tgfoid
        join pg_namespace bound_function_namespace
          on bound_function_namespace.oid=bound_procedure.pronamespace
        where trigger.tgfoid=procedure.oid
          and not trigger.tgisinternal
          and (
            relation_namespace.nspname='public'
            or (
              relation_namespace.nspname='auth'
              and relation.relname='users'
            )
            or bound_function_namespace.nspname='public'
          )
      );
    if v_missing is not null then
      raise exception 'CNYOS_TRIGGER_FUNCTION_OWNER_INVALID: %', v_missing;
    end if;

    select count(*)::bigint,
      coalesce(string_agg(semantic_row,E'\n' order by semantic_row collate "C"),'') || E'\n'
    into v_trigger_function_count,v_trigger_function_payload
    from (
      select jsonb_build_array(
        'cnyos-trigger-function/v1',
        function_namespace.nspname,
        procedure.proname,
        pg_get_function_identity_arguments(procedure.oid),
        pg_get_function_arguments(procedure.oid),
        pg_get_function_result(procedure.oid),
        owner_role.rolname,
        language.lanname,
        procedure.prokind::text,
        procedure.prosecdef,
        procedure.proleakproof,
        procedure.proisstrict,
        procedure.proretset,
        procedure.provolatile::text,
        procedure.proparallel::text,
        procedure.procost::text,
        procedure.prorows::text,
        case when procedure.provariadic=0 then null
             else format_type(procedure.provariadic,null) end,
        case when procedure.prosupport=0 then null
             else support_namespace.nspname || '.' || support_function.proname || '(' ||
                  pg_get_function_identity_arguments(support_function.oid) || ')' end,
        procedure.pronargs,
        procedure.pronargdefaults,
        to_jsonb(procedure.proargmodes),
        to_jsonb(procedure.proargnames),
        (
          select jsonb_agg(format_type(argument_type,null) order by argument.ordinality)
          from unnest(procedure.proallargtypes) with ordinality
            argument(argument_type,ordinality)
        ),
        (
          select jsonb_agg(format_type(transform_type,null) order by transform.ordinality)
          from unnest(procedure.protrftypes) with ordinality
            transform(transform_type,ordinality)
        ),
        to_jsonb(procedure)->'proargdefaults',
        procedure.prosrc,
        procedure.probin,
        to_jsonb(procedure)->'prosqlbody',
        to_jsonb(procedure.proconfig)
      )::text semantic_row
      from pg_proc procedure
      join pg_namespace function_namespace on function_namespace.oid=procedure.pronamespace
      join pg_roles owner_role on owner_role.oid=procedure.proowner
      join pg_language language on language.oid=procedure.prolang
      left join pg_proc support_function on support_function.oid=procedure.prosupport
      left join pg_namespace support_namespace
        on support_namespace.oid=support_function.pronamespace
      where exists (
        select 1
        from pg_trigger trigger
        join pg_class relation on relation.oid=trigger.tgrelid
        join pg_namespace relation_namespace on relation_namespace.oid=relation.relnamespace
        join pg_proc bound_procedure on bound_procedure.oid=trigger.tgfoid
        join pg_namespace bound_function_namespace
          on bound_function_namespace.oid=bound_procedure.pronamespace
        where trigger.tgfoid=procedure.oid
          and not trigger.tgisinternal
          and (
            relation_namespace.nspname='public'
            or (
              relation_namespace.nspname='auth'
              and relation.relname='users'
            )
            or bound_function_namespace.nspname='public'
          )
      )
    ) reviewed_trigger_functions;
    if v_trigger_function_count <> 23
       or octet_length(v_trigger_function_payload) <> v_expected_semantic_bytes
       or encode(sha256(convert_to(v_trigger_function_payload,'UTF8')),'hex') <>
          v_expected_semantic_sha256 then
      raise exception 'CNYOS_TRIGGER_FUNCTION_SEMANTICS_INVALID: count=%, bytes=%, sha256=%',
        v_trigger_function_count,octet_length(v_trigger_function_payload),
        encode(sha256(convert_to(v_trigger_function_payload,'UTF8')),'hex');
    end if;

    select count(*)::bigint,
      coalesce(string_agg(binding_row,E'\n' order by binding_row collate "C"),'') || E'\n'
    into v_trigger_binding_count,v_trigger_binding_payload
    from (
      select jsonb_build_array(
        'cnyos-trigger-binding/v1',
        relation_namespace.nspname,
        relation.relname,
        relation.relkind::text,
        trigger.tgname,
        function_namespace.nspname,
        procedure.proname,
        pg_get_function_identity_arguments(procedure.oid),
        trigger.tgenabled::text,
        trigger.tgtype,
        (
          select jsonb_agg(attribute.attname order by selected.ordinality)
          from unnest(trigger.tgattr::smallint[]) with ordinality
            selected(attnum,ordinality)
          join pg_attribute attribute
            on attribute.attrelid=trigger.tgrelid and attribute.attnum=selected.attnum
        ),
        trigger.tgnargs,
        encode(trigger.tgargs,'hex'),
        trigger.tgdeferrable,
        trigger.tginitdeferred,
        pg_get_expr(trigger.tgqual,trigger.tgrelid,true),
        trigger.tgoldtable,
        trigger.tgnewtable,
        constraint_namespace.nspname,
        constraint_definition.conname,
        referenced_namespace.nspname,
        referenced_relation.relname,
        index_namespace.nspname,
        index_relation.relname,
        parent_namespace.nspname,
        parent_relation.relname,
        parent_trigger.tgname
      )::text binding_row
      from pg_trigger trigger
      join pg_class relation on relation.oid=trigger.tgrelid
      join pg_namespace relation_namespace on relation_namespace.oid=relation.relnamespace
      join pg_proc procedure on procedure.oid=trigger.tgfoid
      join pg_namespace function_namespace on function_namespace.oid=procedure.pronamespace
      left join pg_constraint constraint_definition
        on constraint_definition.oid=trigger.tgconstraint
      left join pg_namespace constraint_namespace
        on constraint_namespace.oid=constraint_definition.connamespace
      left join pg_class referenced_relation on referenced_relation.oid=trigger.tgconstrrelid
      left join pg_namespace referenced_namespace
        on referenced_namespace.oid=referenced_relation.relnamespace
      left join pg_class index_relation on index_relation.oid=trigger.tgconstrindid
      left join pg_namespace index_namespace on index_namespace.oid=index_relation.relnamespace
      left join pg_trigger parent_trigger on parent_trigger.oid=trigger.tgparentid
      left join pg_class parent_relation on parent_relation.oid=parent_trigger.tgrelid
      left join pg_namespace parent_namespace on parent_namespace.oid=parent_relation.relnamespace
      where not trigger.tgisinternal
        and (
          relation_namespace.nspname='public'
          or (
            relation_namespace.nspname='auth'
            and relation.relname='users'
          )
          or function_namespace.nspname='public'
        )
    ) reviewed_trigger_bindings;
    if v_trigger_binding_count <> 168
       or octet_length(v_trigger_binding_payload) <> 46998
       or encode(sha256(convert_to(v_trigger_binding_payload,'UTF8')),'hex') <>
          '9430970d3b25cbe3d5d4ab704740e62ce5a6864d9a804a732ed6f8919523fe54' then
      raise exception 'CNYOS_TRIGGER_BINDING_SNAPSHOT_INVALID: count=%, bytes=%, sha256=%',
        v_trigger_binding_count,octet_length(v_trigger_binding_payload),
        encode(sha256(convert_to(v_trigger_binding_payload,'UTF8')),'hex');
    end if;

    if v_guard_stage = 1 then
      for v_function in
        select
          procedure.oid,
          function_namespace.nspname,
          procedure.proname,
          pg_get_function_identity_arguments(procedure.oid) as identity_arguments
        from pg_proc procedure
        join pg_namespace function_namespace on function_namespace.oid=procedure.pronamespace
        where function_namespace.nspname='public'
          and procedure.prokind='f'
          and exists (
            select 1
            from pg_trigger trigger
            join pg_class relation on relation.oid=trigger.tgrelid
            join pg_namespace relation_namespace
              on relation_namespace.oid=relation.relnamespace
            join pg_proc bound_procedure on bound_procedure.oid=trigger.tgfoid
            join pg_namespace bound_function_namespace
              on bound_function_namespace.oid=bound_procedure.pronamespace
            where trigger.tgfoid=procedure.oid
              and not trigger.tgisinternal
              and (
                relation_namespace.nspname='public'
                or (
                  relation_namespace.nspname='auth'
                  and relation.relname='users'
                )
                or bound_function_namespace.nspname='public'
              )
          )
        order by procedure.oid::regprocedure::text
      loop
        execute format(
          'revoke all privileges on function %I.%I(%s) from public, anon, authenticated, service_role',
          v_function.nspname,
          v_function.proname,
          v_function.identity_arguments
        );
      end loop;

      alter function public.set_updated_at()
        set search_path = pg_catalog, public;
    end if;
  end loop;

  if exists (
    select 1
    from pg_proc procedure
    where exists (
      select 1
      from pg_trigger trigger
      join pg_class relation on relation.oid=trigger.tgrelid
      join pg_namespace relation_namespace on relation_namespace.oid=relation.relnamespace
      join pg_proc bound_procedure on bound_procedure.oid=trigger.tgfoid
      join pg_namespace bound_function_namespace
        on bound_function_namespace.oid=bound_procedure.pronamespace
      where trigger.tgfoid=procedure.oid
        and not trigger.tgisinternal
        and (
          relation_namespace.nspname='public'
          or (
            relation_namespace.nspname='auth'
            and relation.relname='users'
          )
          or bound_function_namespace.nspname='public'
        )
    )
      and (
        has_function_privilege('anon', procedure.oid, 'EXECUTE')
        or has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
        or has_function_privilege('service_role', procedure.oid, 'EXECUTE')
      )
  ) then
    raise exception 'CNYOS_TRIGGER_FUNCTION_RUNTIME_EXECUTE_PRESENT';
  end if;

  -- Trigger functions are internal implementation details. Do not leave a
  -- direct EXECUTE tuple for an unreviewed role even when none of the three
  -- Data API runtime roles currently inherits it.
  if exists (
    select 1
    from pg_proc procedure
    cross join lateral aclexplode(
      coalesce(procedure.proacl, acldefault('f', procedure.proowner))
    ) acl
    where exists (
      select 1
      from pg_trigger trigger
      join pg_class relation on relation.oid=trigger.tgrelid
      join pg_namespace relation_namespace on relation_namespace.oid=relation.relnamespace
      join pg_proc bound_procedure on bound_procedure.oid=trigger.tgfoid
      join pg_namespace bound_function_namespace
        on bound_function_namespace.oid=bound_procedure.pronamespace
      where trigger.tgfoid=procedure.oid
        and not trigger.tgisinternal
        and (
          relation_namespace.nspname='public'
          or (
            relation_namespace.nspname='auth'
            and relation.relname='users'
          )
          or bound_function_namespace.nspname='public'
        )
    )
      and acl.grantee <> procedure.proowner
  ) then
    raise exception 'CNYOS_TRIGGER_FUNCTION_NONOWNER_ACL_PRESENT';
  end if;

  if exists (
    select 1
    from pg_proc procedure
    join pg_namespace function_namespace on function_namespace.oid=procedure.pronamespace
    where function_namespace.nspname='public'
      and procedure.proname='set_updated_at'
      and pg_get_function_identity_arguments(procedure.oid)=''
      and coalesce(array_to_string(procedure.proconfig,','),'') <>
          'search_path=pg_catalog, public'
  ) then
    raise exception 'CNYOS_SET_UPDATED_AT_SEARCH_PATH_MUTABLE';
  end if;

  -- Deliberately emit no success-shaped output here. A deferred constraint can
  -- still reject COMMIT, so acceptance requires a zero-exit client transcript
  -- plus an independent post-commit inventory.
exception
  when others then
    perform pg_catalog.pg_advisory_unlock(202608302100::bigint);
    raise;
end $$;

commit;

do $cnyos_acl_interlock$
begin
  if not pg_catalog.pg_advisory_unlock(202608302100::bigint) then
    raise exception 'CNYOS_ACL_CANDIDATE_ADVISORY_INTERLOCK_RELEASE_FAILED';
  end if;
  if exists (
    select 1
    from pg_catalog.pg_locks lock_row
    where lock_row.locktype = 'advisory'
      and lock_row.pid = pg_catalog.pg_backend_pid()
      and lock_row.granted
      and lock_row.classid::bigint = (202608302100::bigint >> 32)
      and lock_row.objid::bigint =
          (202608302100::bigint & 4294967295::bigint)
      and lock_row.objsubid = 1
  ) then
    raise exception 'CNYOS_ACL_CANDIDATE_ADVISORY_INTERLOCK_RELEASE_FAILED';
  end if;
end
$cnyos_acl_interlock$;
