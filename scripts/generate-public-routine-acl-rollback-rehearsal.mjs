import { createHash } from 'node:crypto';

export const CHANANYA_ACL_REHEARSAL_PROFILE = Object.freeze({
  candidateRelativePath:
    'supabase/manual/202609080900_close_complete_public_routine_acl_candidate.sql',
  // Updated only after the candidate's exact bytes complete independent review.
  candidateSha256:
    '2f374ca556a1f98f46ec179b2e8143d56c7f900d7d1812e2dc7f5e23439e4acf',
  psqlClientSha256:
    '36ea3a9f3c4a08c03df6fc62a88d290eab7bcdbe3cc96577dac374d455eacdb9',
  sslRootCertificateSha256:
    '700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7',
  sslRootCertificatePath:
    '/Users/apisaritnirutsaprada/Documents/Codex/2026-09-06/con/.cnyos-secure/supabase-ca.crt',
  serviceFileSha256:
    '5437b34f9b5f8b2f486a32969f0ab38dfe3b46d26d68280d2e572cce94477fee',
  evidenceSourceRevision: '831543c2d1ed36b2d8242cc82af23c83e019e7a7',
  projectLabel: 'chananya-staging',
  projectRef: 'hsmnjwxurlmsizndjlun',
  deploymentId: 'chananya-clinical-staging',
  environment: 'staging',
  systemIdentifier: '7666007964130682852',
  databaseName: 'postgres',
  databaseUser: 'postgres',
  clinicId: '00000000-0000-4000-8000-00000000a001',
  clinicCode: 'CHANANYA-STG',
  serviceName: 'chananya-staging-direct',
  directHost: 'db.hsmnjwxurlmsizndjlun.supabase.co',
  directHostAddress: '13.215.229.141',
  directPort: '5432',
  serviceApplicationName: 'cnyos-pr36-acl-observer',
  applicationName: 'cnyos-pr36-acl-rollback-rehearsal',
  protectedFileOwnerUid: 502,
  requireSsl: true,
  acknowledgement:
    'I_ACKNOWLEDGE_ROLLBACK_ONLY_CHANANYA_STAGING_ACL_REHEARSAL',
  publicRoutineCount: 147,
  securityDefinerCount: 141,
  triggerCount: 173,
  eventTriggerCount: 7
});

export const ACL_REHEARSAL_FAILURE_MODES = Object.freeze([
  'none',
  'after-mutation'
]);

export const ACL_RELEASE_BLOCKERS = Object.freeze([
  'CNYOS_COMPLETE_ACL_REMEDIATION_NOT_AUTHORIZED',
  'CNYOS_COMPLETE_ACL_SUPABASE_ADMIN_DEFAULT_EXCEPTION_NOT_ACCEPTED',
  'CNYOS_COMPLETE_ACL_SECURITY_DEFINER_PATH_PLAN_NOT_APPROVED',
  'CNYOS_COMPLETE_ACL_LEDGER_AND_FULL_147_141_NATIVE_REHEARSAL_INCOMPLETE',
  'CNYOS_COMPLETE_ACL_HOSTED_CONCURRENCY_AND_FRESH_OBSERVER_NOT_APPROVED'
]);

const sha256Pattern = /^[0-9a-f]{64}$/;
const sourceRevisionPattern = /^[0-9a-f]{40}$/;

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function replaceExactly(source, needle, replacement, count, label) {
  const observed = source.split(needle).length - 1;
  if (observed !== count) {
    throw new Error(`${label} occurrence count changed: expected ${count}, got ${observed}`);
  }
  return source.split(needle).join(replacement);
}

function replacePolicyBlockerDo(source, replacement) {
  const startMarker = 'do $cnyos_complete_acl_policy_blockers$\nbegin\n';
  const endMarker = 'end\n$cnyos_complete_acl_policy_blockers$;';
  const startCount = source.split(startMarker).length - 1;
  const endCount = source.split(endMarker).length - 1;
  if (startCount !== 1 || endCount !== 1) {
    throw new Error(
      'Source candidate must contain exactly one standalone policy-blocker DO'
    );
  }
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start) + endMarker.length;
  const blockerDo = source.slice(start, end);
  for (const blocker of ACL_RELEASE_BLOCKERS) {
    const statement = `raise exception '${blocker}';`;
    if (blockerDo.split(statement).length - 1 !== 1) {
      throw new Error(`Standalone policy-blocker DO changed: ${blocker}`);
    }
  }
  if ((blockerDo.match(/\braise\s+exception\b/gimu) || []).length !==
      ACL_RELEASE_BLOCKERS.length) {
    throw new Error('Standalone policy-blocker DO has an unexpected exception path');
  }
  return source.slice(0, start) + replacement + source.slice(end);
}

function assertProfile(profile) {
  for (const key of [
    'candidateRelativePath',
    'candidateSha256',
    'psqlClientSha256',
    'sslRootCertificateSha256',
    'sslRootCertificatePath',
    'serviceFileSha256',
    'evidenceSourceRevision',
    'projectLabel',
    'projectRef',
    'deploymentId',
    'environment',
    'systemIdentifier',
    'databaseName',
    'databaseUser',
    'clinicId',
    'clinicCode',
    'serviceName',
    'directHost',
    'directHostAddress',
    'directPort',
    'serviceApplicationName',
    'applicationName',
    'acknowledgement'
  ]) {
    if (!profile[key] || typeof profile[key] !== 'string') {
      throw new Error(`ACL rehearsal profile ${key} is required`);
    }
  }
  for (const [label, digest] of [
    ['candidate', profile.candidateSha256],
    ['psql client', profile.psqlClientSha256],
    ['SSL root certificate', profile.sslRootCertificateSha256],
    ['service file', profile.serviceFileSha256]
  ]) {
    if (!sha256Pattern.test(digest)) {
      throw new Error(
        `ACL rehearsal ${label} SHA-256 must be lowercase hexadecimal`
      );
    }
  }
  if (!sourceRevisionPattern.test(profile.evidenceSourceRevision)) {
    throw new Error('ACL rehearsal evidence source revision must be 40 lowercase hex');
  }
  if (!/^\d+$/.test(profile.systemIdentifier)) {
    throw new Error('ACL rehearsal system identifier must be decimal');
  }
  if (profile.environment !== 'staging') {
    throw new Error('ACL rehearsal profile must target staging');
  }
  if (typeof profile.requireSsl !== 'boolean') {
    throw new Error('ACL rehearsal TLS requirement must be boolean');
  }
  if (!Number.isSafeInteger(profile.protectedFileOwnerUid) ||
      profile.protectedFileOwnerUid < 0) {
    throw new Error('ACL rehearsal protected-file owner UID must be a nonnegative integer');
  }
}

function buildTransactionClinicIdentityRecheck(profile) {
  return `  -- Revalidate the Chananya staging clinic only after the exact
  -- 91-relation ShareLock proof and inside the explicit read-write transaction.
  -- public.clinics is one of those locked relations, so the identity cannot
  -- change between this check and the proposed mutation.
  if pg_catalog.to_regclass('public.clinics') is null
     or (select pg_catalog.count(*) from public.clinics) <> 1
     or not exists (
       select 1
       from public.clinics clinic
       where clinic.id=${sqlLiteral(profile.clinicId)}::uuid
         and clinic.code=${sqlLiteral(profile.clinicCode)}
         and clinic.active
     ) then
    raise exception
      'CNYOS_COMPLETE_ACL_REHEARSAL_TRANSACTION_CLINIC_IDENTITY_INVALID';
  end if;`;
}

function buildRehearsalPreamble({ profile, sourceRevision, failureMode }) {
  const psqlInputs = {
    cnyos_complete_acl_rehearsal_ack: profile.acknowledgement,
    cnyos_complete_acl_rehearsal_source_revision: sourceRevision,
    cnyos_complete_acl_rehearsal_candidate_sha256: profile.candidateSha256,
    cnyos_complete_acl_rehearsal_project_ref: profile.projectRef,
    cnyos_complete_acl_rehearsal_failure_mode: failureMode
  };
  const predicates = Object.entries(psqlInputs).map(([name, expected]) =>
    `    :'${name}' = ${sqlLiteral(expected)}`
  ).join('\n    and ');
  const presenceChecks = Object.keys(psqlInputs).map(name =>
    `\\if :{?${name}}\n\\else\n` +
    `do $cnyos_complete_acl_rehearsal_input_abort$\n` +
    `begin\n` +
    `  raise exception 'CNYOS_COMPLETE_ACL_REHEARSAL_INPUT_REQUIRED: ${name}';\n` +
    `end\n` +
    `$cnyos_complete_acl_rehearsal_input_abort$;\n` +
    `\\endif`
  ).join('\n');

  return `${presenceChecks}
\\unset cnyos_complete_acl_rehearsal_session_read_only
select current_setting('transaction_read_only')='on'
  as cnyos_complete_acl_rehearsal_session_read_only
\\gset
\\if :cnyos_complete_acl_rehearsal_session_read_only
\\else
do $cnyos_complete_acl_rehearsal_read_only_abort$
begin
  raise exception 'CNYOS_COMPLETE_ACL_REHEARSAL_SESSION_READ_ONLY_REQUIRED';
end
$cnyos_complete_acl_rehearsal_read_only_abort$;
\\endif
\\unset cnyos_complete_acl_rehearsal_inputs_valid
select (
${predicates}
) as cnyos_complete_acl_rehearsal_inputs_valid
\\gset
\\if :cnyos_complete_acl_rehearsal_inputs_valid
\\else
do $cnyos_complete_acl_rehearsal_input_abort$
begin
  raise exception 'CNYOS_COMPLETE_ACL_REHEARSAL_INPUT_INVALID';
end
$cnyos_complete_acl_rehearsal_input_abort$;
\\endif

-- Outside the one explicit candidate transaction, every automatically opened
-- transaction in this session is read-only. The candidate's BEGIN READ WRITE
-- is necessary for its proposed DDL and is replaced with ROLLBACK at the tail.
set session characteristics as transaction read only;
select pg_catalog.set_config(
  'cnyos.complete_acl_target_project_ref',${sqlLiteral(profile.projectRef)},false
) as cnyos_complete_acl_rehearsal_project_ref_set
\\gset
select pg_catalog.set_config(
  'cnyos.complete_acl_target_environment',${sqlLiteral(profile.environment)},false
) as cnyos_complete_acl_rehearsal_environment_set
\\gset
select pg_catalog.set_config(
  'cnyos.complete_acl_rehearsal_mode','rollback-only',false
) as cnyos_complete_acl_rehearsal_mode_set
\\gset
select pg_catalog.set_config(
  'cnyos.complete_acl_rehearsal_source_revision',${sqlLiteral(sourceRevision)},false
) as cnyos_complete_acl_rehearsal_source_revision_set
\\gset
select pg_catalog.set_config(
  'cnyos.complete_acl_rehearsal_candidate_sha256',${sqlLiteral(profile.candidateSha256)},false
) as cnyos_complete_acl_rehearsal_candidate_sha256_set
\\gset
select pg_catalog.set_config(
  'cnyos.complete_acl_rehearsal_failure_mode',
  :'cnyos_complete_acl_rehearsal_failure_mode',false
) as cnyos_complete_acl_rehearsal_failure_mode_set
\\gset
`;
}

function buildBlockerReplacement({ profile, sourceRevision, failureMode }) {
  const bypassed = ACL_RELEASE_BLOCKERS.map(blocker =>
    `  -- rollback-only rehearsal bypassed source blocker: ${blocker}`
  ).join('\n');
  return `do $cnyos_complete_acl_rehearsal_policy_gate$
declare
  v_system_identifier text;
begin
  -- The source candidate retains all five unconditional policy blockers.
  -- This exact-SHA derivative bypasses them only inside a rollback-only
  -- rehearsal whose generated program has no executable COMMIT statement.
${bypassed}
  if coalesce(current_setting(
       'cnyos.complete_acl_rehearsal_mode',true
     ),'') <> 'rollback-only'
     or coalesce(current_setting(
       'cnyos.complete_acl_rehearsal_source_revision',true
     ),'') <> ${sqlLiteral(sourceRevision)}
     or coalesce(current_setting(
       'cnyos.complete_acl_rehearsal_candidate_sha256',true
     ),'') <> ${sqlLiteral(profile.candidateSha256)}
     or coalesce(current_setting(
       'cnyos.complete_acl_target_project_ref',true
     ),'') <> ${sqlLiteral(profile.projectRef)}
     or coalesce(current_setting(
       'cnyos.complete_acl_target_environment',true
     ),'') <> ${sqlLiteral(profile.environment)}
     or coalesce(current_setting(
       'cnyos.complete_acl_rehearsal_failure_mode',true
     ),'') <> ${sqlLiteral(failureMode)} then
    raise exception 'CNYOS_COMPLETE_ACL_REHEARSAL_INTERLOCK_INVALID';
  end if;
  select system_identifier::text into v_system_identifier
  from pg_catalog.pg_control_system();
  if current_database()<>${sqlLiteral(profile.databaseName)}
     or session_user<>${sqlLiteral(profile.databaseUser)}
     or current_user<>${sqlLiteral(profile.databaseUser)}
     or current_setting('server_version_num')::integer / 10000 <> 17
     or current_setting('server_encoding')<>'UTF8'
     or current_setting('application_name')<>${sqlLiteral(profile.applicationName)}
     or pg_catalog.host(pg_catalog.inet_server_addr())<>${sqlLiteral(profile.directHostAddress)}
     or v_system_identifier<>${sqlLiteral(profile.systemIdentifier)}
     ${profile.requireSsl ? `or not coalesce((
       select ssl from pg_catalog.pg_stat_ssl
       where pid=pg_catalog.pg_backend_pid()
     ),false)` : ''} then
    raise exception 'CNYOS_COMPLETE_ACL_REHEARSAL_PRELOCK_TARGET_INVALID';
  end if;
  if pg_catalog.to_regclass('public.clinics') is null
     or (select pg_catalog.count(*) from public.clinics) <> 1
     or not exists (
       select 1
       from public.clinics clinic
       where clinic.id=${sqlLiteral(profile.clinicId)}::uuid
         and clinic.code=${sqlLiteral(profile.clinicCode)}
         and clinic.active
  ) then
    raise exception 'CNYOS_COMPLETE_ACL_REHEARSAL_CLINIC_IDENTITY_INVALID';
  end if;
end
$cnyos_complete_acl_rehearsal_policy_gate$;`;
}

function buildFailureInjection() {
  return `  if coalesce(current_setting(
       'cnyos.complete_acl_rehearsal_failure_mode',true
     ),'') = 'after-mutation' then
    raise exception
      'CNYOS_COMPLETE_ACL_REHEARSAL_INJECTED_FAILURE_AFTER_MUTATION';
  elsif coalesce(current_setting(
       'cnyos.complete_acl_rehearsal_failure_mode',true
     ),'') <> 'none' then
    raise exception 'CNYOS_COMPLETE_ACL_REHEARSAL_FAILURE_MODE_INVALID';
  end if;`;
}

function buildSuccessReceipt({ profile, sourceRevision }) {
  const receipt = {
    artifact_schema: 'cnyos-public-routine-acl-rollback-rehearsal-sql/v1',
    status: 'CNYOS_COMPLETE_ACL_REHEARSAL_ROLLED_BACK',
    source_revision: sourceRevision,
    evidence_source_revision: profile.evidenceSourceRevision,
    candidate_sha256: profile.candidateSha256,
    project_label: profile.projectLabel,
    project_ref: profile.projectRef,
    deployment_id: profile.deploymentId,
    environment: profile.environment,
    expected_system_identifier: profile.systemIdentifier,
    expected_database: profile.databaseName,
    expected_user: profile.databaseUser,
    rollback_only: true,
    commit_allowed: false,
    authorization: false,
    independent_post_run_comparison_required: true,
    production_eligible: false
  };
  return `
\\if :{?cnyos_complete_acl_rehearsal_rollback_command_reached}
\\else
do $cnyos_complete_acl_rehearsal_tail_abort$
begin
  raise exception 'CNYOS_COMPLETE_ACL_REHEARSAL_ROLLBACK_NOT_REACHED';
end
$cnyos_complete_acl_rehearsal_tail_abort$;
\\endif
\\unset cnyos_complete_acl_rehearsal_tail_valid
select (
  current_setting('transaction_read_only')='on'
  and not exists (
    select 1
    from pg_catalog.pg_locks lock_row
    where lock_row.locktype='advisory'
      and lock_row.pid=pg_catalog.pg_backend_pid()
      and lock_row.granted
      and lock_row.classid::bigint=(202608302100::bigint >> 32)
      and lock_row.objid::bigint=(202608302100::bigint & 4294967295::bigint)
      and lock_row.objsubid=1
  )
) as cnyos_complete_acl_rehearsal_tail_valid
\\gset
\\if :cnyos_complete_acl_rehearsal_tail_valid
select ${sqlLiteral(JSON.stringify(receipt))}::jsonb::text;
\\else
do $cnyos_complete_acl_rehearsal_tail_abort$
begin
  raise exception 'CNYOS_COMPLETE_ACL_REHEARSAL_TAIL_INVALID';
end
$cnyos_complete_acl_rehearsal_tail_abort$;
\\endif
\\unset cnyos_complete_acl_rehearsal_inputs_valid
\\unset cnyos_complete_acl_rehearsal_session_read_only
\\unset cnyos_complete_acl_rehearsal_tail_valid
\\unset cnyos_complete_acl_rehearsal_rollback_command_reached
`;
}

export function buildPublicRoutineAclRollbackRehearsalSql({
  candidateSource,
  sourceRevision,
  failureMode = 'none',
  profile = CHANANYA_ACL_REHEARSAL_PROFILE
}) {
  assertProfile(profile);
  if (!sourceRevisionPattern.test(sourceRevision)) {
    throw new Error('ACL rehearsal source revision must be 40 lowercase hex');
  }
  if (!ACL_REHEARSAL_FAILURE_MODES.includes(failureMode)) {
    throw new Error(`Unsupported ACL rehearsal failure mode: ${failureMode}`);
  }
  if (typeof candidateSource !== 'string' || candidateSource.length === 0) {
    throw new Error('ACL rehearsal candidate source is required');
  }
  const observedSha256 = sha256(Buffer.from(candidateSource, 'utf8'));
  if (observedSha256 !== profile.candidateSha256) {
    throw new Error(
      `ACL rehearsal candidate SHA-256 mismatch: expected ${profile.candidateSha256}, ` +
      `got ${observedSha256}`
    );
  }
  for (const pin of [
    profile.evidenceSourceRevision,
    profile.projectLabel,
    profile.projectRef,
    profile.systemIdentifier
  ]) {
    if (!candidateSource.includes(pin)) {
      throw new Error(`ACL rehearsal candidate is missing target/evidence pin ${pin}`);
    }
  }

  let sql = replacePolicyBlockerDo(
    candidateSource,
    buildBlockerReplacement({ profile, sourceRevision, failureMode })
  );

  const searchPathAnchor = 'set search_path = pg_catalog, pg_temp;\n';
  sql = replaceExactly(
    sql,
    searchPathAnchor,
    `${buildRehearsalPreamble({
      profile,
      sourceRevision,
      failureMode
    })}${searchPathAnchor}`,
    1,
    'rehearsal preamble anchor'
  );
  const relationLockProofTail = `        pg_catalog.cardinality(v_locked_relation_oids),0
      );
  end if;

  if current_setting('transaction_read_only') <> 'off'`;
  sql = replaceExactly(
    sql,
    relationLockProofTail,
    `        pg_catalog.cardinality(v_locked_relation_oids),0
      );
  end if;

${buildTransactionClinicIdentityRecheck(profile)}

  if current_setting('transaction_read_only') <> 'off'`,
    1,
    'post-lock clinic identity anchor'
  );
  const mutationEnd = '  -- CNYOS_COMPLETE_ACL_MUTATION_END';
  sql = replaceExactly(
    sql,
    mutationEnd,
    `${mutationEnd}\n${buildFailureInjection()}`,
    1,
    'mutation-end failure injection anchor'
  );
  sql = replaceExactly(
    sql,
    '\ncommit;\n',
    '\n\\set cnyos_complete_acl_rehearsal_rollback_command_reached 1\nrollback;\n',
    1,
    'candidate transaction terminator'
  );
  sql += buildSuccessReceipt({ profile, sourceRevision });

  if (/^\s*commit\s*;/imu.test(sql)) {
    throw new Error('Generated ACL rehearsal contains an executable COMMIT');
  }
  if (/^\s*\\(?:gexec|include|ir)\b/imu.test(sql)) {
    throw new Error('Generated ACL rehearsal contains an unsafe psql meta-command');
  }
  const readWriteStarts = sql.match(
    /^\s*begin\s+isolation\s+level\s+repeatable\s+read\s+read\s+write\s*;/gimu
  ) || [];
  if (readWriteStarts.length !== 1) {
    throw new Error(
      `Generated ACL rehearsal must contain one explicit read-write transaction; ` +
      `got ${readWriteStarts.length}`
    );
  }
  if (/^\s*set\s+(?:default_transaction_read_only\s*=\s*off|transaction\s+read\s+write)/imu.test(sql)) {
    throw new Error('Generated ACL rehearsal weakens read-only mode outside BEGIN');
  }
  if ((sql.match(/^\s*rollback\s*;/gimu) || []).length < 3) {
    throw new Error('Generated ACL rehearsal lost a mandatory rollback path');
  }
  return sql;
}

function buildDigestExpression(rowSource, orderExpression) {
  return `pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    coalesce(pg_catalog.string_agg(
      (${rowSource})::text,E'\\n' order by ${orderExpression}
    ),''),
    'UTF8'
  )),'hex')`;
}

export function buildPublicRoutineAclStateSnapshotSql({
  profile = CHANANYA_ACL_REHEARSAL_PROFILE,
  requireSsl = true
} = {}) {
  assertProfile(profile);
  const routineDigest = buildDigestExpression(
    `pg_catalog.jsonb_build_array(
      namespace.nspname,procedure.proname,procedure.prokind::text,
      procedure.proargtypes::text,procedure.proallargtypes::text,
      procedure.proargmodes::text,procedure.proargnames::text,
      owner.rolname,procedure.proacl::text,procedure.prosecdef,
      procedure.proconfig,procedure.provolatile::text,procedure.proleakproof,
      procedure.prosrc
    )`,
    `namespace.nspname collate \"C\",procedure.proname collate \"C\",
      procedure.proargtypes::text collate \"C\"`
  );
  const defaultAclDigest = buildDigestExpression(
    `pg_catalog.jsonb_build_array(
      creator.rolname,coalesce(namespace.nspname,''),
      defaults.defaclobjtype::text,defaults.defaclacl::text
    )`,
    `creator.rolname collate \"C\",coalesce(namespace.nspname,'') collate \"C\",
      defaults.defaclobjtype::text collate \"C\"`
  );
  const triggerDigest = buildDigestExpression(
    `pg_catalog.jsonb_build_array(
      relation_namespace.nspname,relation.relname,trigger_row.tgname,
      function_namespace.nspname,procedure.proname,
      procedure.proargtypes::text,trigger_row.tgenabled::text,
      trigger_row.tgtype,trigger_row.tgattr::text,trigger_row.tgnargs,
      pg_catalog.encode(trigger_row.tgargs,'hex'),
      trigger_row.tgqual::text,trigger_row.tgdeferrable,
      trigger_row.tginitdeferred,trigger_row.tgoldtable,trigger_row.tgnewtable
    )`,
    `relation_namespace.nspname collate \"C\",relation.relname collate \"C\",
      trigger_row.tgname collate \"C\"`
  );
  const eventTriggerDigest = buildDigestExpression(
    `pg_catalog.jsonb_build_array(
      event_row.evtname,event_row.evtevent,event_row.evtenabled::text,
      event_row.evttags::text,owner.rolname,function_namespace.nspname,
      procedure.proname,procedure.proargtypes::text
    )`,
    `event_row.evtname collate \"C\"`
  );

  return `\\set ON_ERROR_STOP 1
\\set ON_ERROR_ROLLBACK off
\\if :AUTOCOMMIT
\\else
rollback;
do $cnyos_complete_acl_snapshot_abort$
begin
  raise exception 'CNYOS_COMPLETE_ACL_SNAPSHOT_AUTOCOMMIT_REQUIRED';
end
$cnyos_complete_acl_snapshot_abort$;
\\endif
set session characteristics as transaction read only;
begin isolation level repeatable read read only;
set local search_path=pg_catalog,pg_temp;
set local timezone='UTC';
set local datestyle='ISO, YMD';
set local intervalstyle='postgres';
set local extra_float_digits=3;
set local bytea_output='hex';
set local quote_all_identifiers=off;
set local standard_conforming_strings=on;
set local lc_monetary='C';
set local lc_numeric='C';
set local lc_time='C';
do $cnyos_complete_acl_snapshot_target$
declare
  v_system_identifier text;
begin
  select system_identifier::text into v_system_identifier
  from pg_catalog.pg_control_system();
  if current_database()<>${sqlLiteral(profile.databaseName)}
     or session_user<>${sqlLiteral(profile.databaseUser)}
     or current_user<>${sqlLiteral(profile.databaseUser)}
     or current_setting('server_version_num')::integer / 10000 <> 17
     or current_setting('server_encoding')<>'UTF8'
     or v_system_identifier<>${sqlLiteral(profile.systemIdentifier)}
     or current_setting('transaction_read_only')<>'on'
     or current_setting('transaction_isolation')<>'repeatable read'
     or current_setting('application_name')<>${sqlLiteral(profile.applicationName)}
     or pg_catalog.host(pg_catalog.inet_server_addr())<>${sqlLiteral(profile.directHostAddress)}
     ${requireSsl ? `or not coalesce((
       select ssl from pg_catalog.pg_stat_ssl
       where pid=pg_catalog.pg_backend_pid()
     ),false)` : ''} then
    raise exception 'CNYOS_COMPLETE_ACL_SNAPSHOT_TARGET_INVALID';
  end if;
  if pg_catalog.to_regclass('public.clinics') is null
     or (select pg_catalog.count(*) from public.clinics)<>1
     or not exists (
       select 1 from public.clinics clinic
       where clinic.id=${sqlLiteral(profile.clinicId)}::uuid
         and clinic.code=${sqlLiteral(profile.clinicCode)}
         and clinic.active
     ) then
    raise exception 'CNYOS_COMPLETE_ACL_SNAPSHOT_CLINIC_INVALID';
  end if;
  if (select pg_catalog.count(*)
      from pg_catalog.pg_proc procedure
      join pg_catalog.pg_namespace namespace
        on namespace.oid=procedure.pronamespace
      where namespace.nspname='public')<>${profile.publicRoutineCount}
     or (select pg_catalog.count(*)
         from pg_catalog.pg_proc procedure
         join pg_catalog.pg_namespace namespace
           on namespace.oid=procedure.pronamespace
         where namespace.nspname='public' and procedure.prosecdef)
        <>${profile.securityDefinerCount}
     or (select pg_catalog.count(*)
         from pg_catalog.pg_trigger where not tgisinternal)
        <>${profile.triggerCount}
     or (select pg_catalog.count(*) from pg_catalog.pg_event_trigger)
        <>${profile.eventTriggerCount} then
    raise exception 'CNYOS_COMPLETE_ACL_SNAPSHOT_CARDINALITY_INVALID';
  end if;
end
$cnyos_complete_acl_snapshot_target$;
\\unset cnyos_complete_acl_snapshot
select pg_catalog.jsonb_build_object(
  'artifact_schema','cnyos-public-routine-acl-state-snapshot/v1',
  'project_label',${sqlLiteral(profile.projectLabel)},
  'project_ref',${sqlLiteral(profile.projectRef)},
  'deployment_id',${sqlLiteral(profile.deploymentId)},
  'environment',${sqlLiteral(profile.environment)},
  'system_identifier',(
    select system_identifier::text from pg_catalog.pg_control_system()
  ),
  'current_database',current_database(),
  'session_user',session_user,
  'current_user',current_user,
  'server_version_num',current_setting('server_version_num'),
  'server_encoding',current_setting('server_encoding'),
  'server_address',pg_catalog.host(pg_catalog.inet_server_addr()),
  'ssl',coalesce((
    select ssl from pg_catalog.pg_stat_ssl
    where pid=pg_catalog.pg_backend_pid()
  ),false),
  'state',pg_catalog.jsonb_build_object(
    'public_routine_count',(
      select pg_catalog.count(*)
      from pg_catalog.pg_proc procedure
      join pg_catalog.pg_namespace namespace
        on namespace.oid=procedure.pronamespace
      where namespace.nspname='public'
    ),
    'public_routine_sha256',(
      select ${routineDigest}
      from pg_catalog.pg_proc procedure
      join pg_catalog.pg_namespace namespace
        on namespace.oid=procedure.pronamespace
      join pg_catalog.pg_roles owner on owner.oid=procedure.proowner
      where namespace.nspname='public'
    ),
    'function_default_acl_count',(
      select pg_catalog.count(*)
      from pg_catalog.pg_default_acl defaults
      where defaults.defaclobjtype='f'
    ),
    'function_default_acl_sha256',(
      select ${defaultAclDigest}
      from pg_catalog.pg_default_acl defaults
      join pg_catalog.pg_roles creator on creator.oid=defaults.defaclrole
      left join pg_catalog.pg_namespace namespace
        on namespace.oid=defaults.defaclnamespace
      where defaults.defaclobjtype='f'
    ),
    'trigger_count',(
      select pg_catalog.count(*)
      from pg_catalog.pg_trigger trigger_row
      where not trigger_row.tgisinternal
    ),
    'trigger_sha256',(
      select ${triggerDigest}
      from pg_catalog.pg_trigger trigger_row
      join pg_catalog.pg_class relation on relation.oid=trigger_row.tgrelid
      join pg_catalog.pg_namespace relation_namespace
        on relation_namespace.oid=relation.relnamespace
      join pg_catalog.pg_proc procedure on procedure.oid=trigger_row.tgfoid
      join pg_catalog.pg_namespace function_namespace
        on function_namespace.oid=procedure.pronamespace
      where not trigger_row.tgisinternal
    ),
    'event_trigger_count',(
      select pg_catalog.count(*) from pg_catalog.pg_event_trigger
    ),
    'event_trigger_sha256',(
      select ${eventTriggerDigest}
      from pg_catalog.pg_event_trigger event_row
      join pg_catalog.pg_roles owner on owner.oid=event_row.evtowner
      join pg_catalog.pg_proc procedure on procedure.oid=event_row.evtfoid
      join pg_catalog.pg_namespace function_namespace
        on function_namespace.oid=procedure.pronamespace
    )
  )
)::text as cnyos_complete_acl_snapshot
\\gset
rollback;
select :'cnyos_complete_acl_snapshot';
\\unset cnyos_complete_acl_snapshot
`;
}
