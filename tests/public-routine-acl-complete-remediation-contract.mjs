import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidatePath = path.join(
  root,
  'supabase',
  'manual',
  '202609080900_close_complete_public_routine_acl_candidate.sql'
);
const dispositionPath = path.join(
  root,
  'security',
  'chananya-staging-public-routine-acl-disposition-831543c.json'
);
const nativeE2ePath = path.join(
  root,
  'tests',
  'public-routine-acl-complete-remediation-psql-e2e.mjs'
);
const [sql, dispositionSource, nativeE2eSource] = await Promise.all([
  fs.readFile(candidatePath, 'utf8'),
  fs.readFile(dispositionPath, 'utf8'),
  fs.readFile(nativeE2ePath, 'utf8')
]);
const disposition = JSON.parse(dispositionSource);

function extractSqlArray(variableName) {
  const match = sql.match(new RegExp(
    `${variableName} constant text\\[\\] := array\\[([\\s\\S]*?)\\]::text\\[\\];`
  ));
  assert.ok(match, `${variableName} declaration missing`);
  const values = [];
  const literal = /'((?:''|[^'])*)'/g;
  for (const item of match[1].matchAll(literal)) {
    values.push(item[1].replaceAll("''", "'"));
  }
  return values;
}

assert.equal(disposition.artifact_schema, 'cnyos-public-routine-acl-disposition/v1');
assert.equal(disposition.status, 'CLASSIFIED_COMPLETE_NOT_AUTHORIZED');
assert.equal(disposition.classification_complete, true);
assert.ok(
  Object.values(disposition.authorization_flags).every(value => value === false),
  'classification artifact must not convey authorization'
);

const categoryVariables = {
  authenticated_only: 'v_authenticated_only',
  authenticated_and_service: 'v_authenticated_and_service',
  service_only: 'v_service_only',
  owner_only_ordinary: 'v_owner_only_ordinary',
  owner_only_trigger: 'v_owner_only_trigger',
  owner_only_event_trigger: 'v_owner_only_event_trigger'
};
const extracted = {};
for (const [category, variable] of Object.entries(categoryVariables)) {
  extracted[category] = extractSqlArray(variable);
  assert.deepEqual(
    extracted[category],
    disposition.routine_dispositions[category],
    `${category} must be embedded verbatim in classified order`
  );
}

assert.deepEqual(
  Object.fromEntries(Object.entries(extracted).map(([key, values]) => [key, values.length])),
  {
    authenticated_only: 23,
    authenticated_and_service: 47,
    service_only: 28,
    owner_only_ordinary: 25,
    owner_only_trigger: 23,
    owner_only_event_trigger: 1
  }
);
const authenticated = [
  ...extracted.authenticated_only,
  ...extracted.authenticated_and_service
];
const service = [
  ...extracted.authenticated_and_service,
  ...extracted.service_only
];
const ownerOnly = [
  ...extracted.owner_only_ordinary,
  ...extracted.owner_only_trigger,
  ...extracted.owner_only_event_trigger
];
const all = Object.values(extracted).flat();
assert.equal(authenticated.length, 70);
assert.equal(service.length, 75);
assert.equal(ownerOnly.length, 49);
assert.equal(all.length, 147);
assert.equal(new Set(all).size, 147, 'six disposition categories must be disjoint');
assert.deepEqual(disposition.derived_expected_access, {
  public: 0,
  anon: 0,
  authenticated: 70,
  service_role: 75,
  owner_only: 49,
  total_routines: 147
});

for (const pin of [
  disposition.source.source_revision,
  disposition.source.observer_raw_sha256,
  disposition.source.observer_source_sql_sha256,
  disposition.source.observation_composite_sha256,
  disposition.source.system_identifier,
  disposition.source.project_label,
  disposition.source.project_ref
]) {
  assert.ok(sql.includes(pin), `candidate is missing evidence pin ${pin}`);
}
assert.deepEqual(disposition.source.binding_datasets, {
  trigger_bindings_all_non_internal: {
    dataset_name: 'trigger_bindings.all_non_internal',
    payload_sha256: '2f5ffa09ed5a895733d4ba6418ae0a69ab190d3a6718bde73e17dc73118fd15d',
    row_count: 173,
    canonical_row_sha256_input: 'exact canonical evidence row including terminal LF'
  },
  event_trigger_bindings_all: {
    dataset_name: 'event_trigger_bindings.all',
    payload_sha256: 'b0ba455cb69e75488c4c50229a387e4859c201581921c96737a313961ba6c799',
    row_count: 7,
    canonical_row_sha256_input: 'exact canonical evidence row including terminal LF'
  }
});
for (const digest of [
  disposition.source.binding_datasets.trigger_bindings_all_non_internal.payload_sha256,
  disposition.source.binding_datasets.event_trigger_bindings_all.payload_sha256,
  'aa777a86a6ade0616080eb5b41680f2d4dadc0e4a686acc71459d80bd380fea6',
  'cbabdf241e6d6634759fd20c94ef98c4f939458397532671c1e38265b51ddddf'
]) {
  assert.ok(sql.includes(digest), `candidate is missing binding digest ${digest}`);
}

assert.match(sql, /^-- This manual candidate is a psql program/m);
assert.match(sql, /^\\set ON_ERROR_STOP 1$/m);
assert.match(sql, /^\\set ON_ERROR_ROLLBACK off$/m);
assert.match(sql, /CNYOS_COMPLETE_ACL_PSQL_AUTOCOMMIT_REQUIRED/);
assert.match(sql, /CNYOS_COMPLETE_ACL_PSQL_EXISTING_TRANSACTION_REFUSED/);
assert.match(sql, /begin isolation level repeatable read read write;/);
assert.match(sql, /pg_catalog\.pg_try_advisory_lock\(202608302100::bigint\)/);
assert.equal(
  (sql.match(/pg_catalog\.pg_advisory_unlock\(202608302100::bigint\)/g) || []).length,
  2,
  'candidate needs exception and successful-tail unlocks'
);
assert.equal(
  (sql.match(/lock_row\.pid = pg_catalog\.pg_backend_pid\(\)/g) || []).length,
  2,
  'candidate must check same-session lock state before acquire and after release'
);

const mutationMarker = sql.indexOf('-- CNYOS_COMPLETE_ACL_MUTATION_BEGIN');
assert.ok(mutationMarker > 0, 'mutation marker missing');
const blockers = [
  'CNYOS_COMPLETE_ACL_REMEDIATION_NOT_AUTHORIZED',
  'CNYOS_COMPLETE_ACL_SUPABASE_ADMIN_DEFAULT_EXCEPTION_NOT_ACCEPTED',
  'CNYOS_COMPLETE_ACL_SECURITY_DEFINER_PATH_PLAN_NOT_APPROVED',
  'CNYOS_COMPLETE_ACL_LEDGER_AND_FULL_147_141_NATIVE_REHEARSAL_INCOMPLETE',
  'CNYOS_COMPLETE_ACL_HOSTED_CONCURRENCY_AND_FRESH_OBSERVER_NOT_APPROVED'
];
const policyBlock = sql.match(
  /do \$cnyos_complete_acl_policy_blockers\$\n([\s\S]*?)\n\$cnyos_complete_acl_policy_blockers\$;/
);
assert.ok(policyBlock, 'separate pre-BEGIN policy-blocker DO is missing');
for (const blocker of blockers) {
  const index = sql.indexOf(`raise exception '${blocker}'`);
  assert.ok(index > 0 && index < mutationMarker, `${blocker} must precede mutation`);
  assert.equal(
    (sql.match(new RegExp(blocker,'g')) || []).length,
    1,
    `${blocker} must have one unambiguous policy gate`
  );
  assert.ok(
    policyBlock[1].includes(`raise exception '${blocker}'`),
    `${blocker} must stay in the separate policy-blocker DO`
  );
}
const candidateBody = sql.match(
  /do \$cnyos_complete_acl_candidate\$[\s\S]*?\nbegin\n([\s\S]*?)\n  if current_setting\('transaction_read_only'\)/
);
assert.ok(candidateBody, 'sole remediation DO block not found');
assert.match(
  candidateBody[1].trimStart(),
  /^-- Prove the static statement above succeeded as an exact closed set/,
  'the enableable candidate body must begin with its relation-lock proof'
);
assert.doesNotMatch(
  sql,
  /lock table pg_catalog\./i,
  'hosted non-super postgres must not request unsupported system-catalog locks'
);

const triggerRelations = [...new Set(disposition.trigger_bindings.map(
  binding => `${binding.relation_schema}.${binding.relation_name}`
))].sort();
assert.equal(triggerRelations.length, 91);
assert.deepEqual(extractSqlArray('v_trigger_relations'), triggerRelations);
const staticLock = sql.match(
  /lock table only\n([\s\S]*?)\nin share mode nowait;/gi
);
assert.equal(staticLock?.length, 1, 'candidate must contain one static relation lock');
const staticLockBody = staticLock[0].match(
  /^lock table only\n([\s\S]*?)\nin share mode nowait;$/i
);
assert.ok(staticLockBody, 'static relation lock shape changed');
const lockedRelations = staticLockBody[1]
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);
assert.deepEqual(
  lockedRelations,
  triggerRelations,
  'static ONLY/SHARE/NOWAIT lock must name the exact 91 C-sorted relations'
);
assert.equal(new Set(lockedRelations).size, 91);
assert.doesNotMatch(sql, /lock table %I\.%I/i);
assert.doesNotMatch(sql, /foreach v_relation in array/i);
assert.match(sql, /CNYOS_COMPLETE_ACL_TRIGGER_RELATION_SET_INVALID/);
const relationLock = sql.indexOf(staticLock[0]);
const transactionBeginText = 'begin isolation level repeatable read read write;';
const transactionBegin = sql.indexOf(transactionBeginText);
const advisoryAcquire = sql.indexOf(
  'pg_catalog.pg_try_advisory_lock(202608302100::bigint)'
);
const policyBlockStart = sql.indexOf('do $cnyos_complete_acl_policy_blockers$');
const policyBlockEnd = sql.indexOf('$cnyos_complete_acl_policy_blockers$;') +
  '$cnyos_complete_acl_policy_blockers$;'.length;
assert.ok(
  policyBlockStart > 0 && policyBlockEnd < advisoryAcquire &&
    advisoryAcquire < transactionBegin && transactionBegin < relationLock,
  'the unconditional policy DO must abort before advisory/relation locks and BEGIN'
);
const beforeStaticLock = sql.slice(
  transactionBegin + transactionBeginText.length,
  relationLock
);
const beforeStaticLockWithoutComments = beforeStaticLock
  .replace(/^\s*--.*$/gm,'')
  .trim();
assert.match(
  beforeStaticLockWithoutComments,
  /^(?:set local [^;\n]+;\s*)+$/,
  'only non-query SET LOCAL statements may precede the static lock after BEGIN'
);
assert.doesNotMatch(
  beforeStaticLockWithoutComments,
  /\b(?:select|with|do|values|insert|update|delete|merge|call|copy|alter|create|drop|grant|revoke|lock)\b/i,
  'no snapshot-bearing or mutating statement may precede the static lock'
);
const firstTransactionPrecondition = sql.indexOf(
  "if current_setting('transaction_read_only')"
);
const relationLockProof = sql.indexOf(
  'select pg_catalog.array_agg(relation.oid order by relation.oid)'
);
assert.ok(
  relationLock < relationLockProof &&
    relationLockProof < firstTransactionPrecondition &&
    firstTransactionPrecondition < mutationMarker,
  'the exact trigger-relation lock and its proof must precede preconditions/mutation'
);
assert.match(
  candidateBody[1],
  /pg_catalog\.unnest\(v_trigger_relations\)[\s\S]*?relation\.relkind='r'/,
  'lock proof must resolve every reviewed name to an ordinary table'
);
assert.match(candidateBody[1], /lock_row\.locktype='relation'/);
assert.match(
  candidateBody[1],
  /lock_row\.pid=pg_catalog\.pg_backend_pid\(\)/
);
assert.match(candidateBody[1], /lock_row\.mode='ShareLock'/);
assert.match(candidateBody[1], /lock_row\.granted/);
assert.match(
  candidateBody[1],
  /cardinality\(v_expected_relation_oids\),0[\s\S]*?<>91/
);
assert.match(
  candidateBody[1],
  /cardinality\(v_locked_relation_oids\),0[\s\S]*?<>91/
);
assert.match(
  candidateBody[1],
  /v_locked_relation_oids is distinct from v_expected_relation_oids/
);
assert.match(
  candidateBody[1],
  /CNYOS_COMPLETE_ACL_TRIGGER_RELATION_LOCK_SET_INVALID/
);

assert.doesNotMatch(
  sql,
  /pg_get_function_identity_arguments/,
  'signature comparisons must not include PostgreSQL argument names'
);
assert.equal(
  (sql.match(
    /pg_catalog\.replace\(\s*pg_catalog\.oidvectortypes\(procedure\.proargtypes\),', ',','\s*\)/g
  ) || []).length,
  6,
  'all six catalog signature labels must use the type-only proargtypes expression'
);

assert.match(
  sql,
  /revoke all privileges on function %s from public, anon, authenticated, service_role/
);
assert.match(sql, /grant execute on function %s to authenticated/);
assert.match(sql, /grant execute on function %s to service_role/);
assert.doesNotMatch(sql, /grant execute on function %s to (?:public|anon)/i);
assert.match(sql, /array_to_string\(v_all,', '\)/);
assert.match(sql, /array_to_string\(v_authenticated,', '\)/);
assert.match(sql, /array_to_string\(v_service,', '\)/);
assert.doesNotMatch(sql, /foreach v_signature in array/);
assert.match(sql, /CNYOS_COMPLETE_ACL_ANON_EXECUTE_REMAINS/);
assert.match(sql, /CNYOS_COMPLETE_ACL_AUTHENTICATED_EXECUTE_SET_INVALID/);
assert.match(sql, /CNYOS_COMPLETE_ACL_SERVICE_EXECUTE_SET_INVALID/);
assert.match(sql, /<> 145/);
assert.match(sql, /CNYOS_COMPLETE_ACL_RAW_POSTCONDITION_INVALID/);

assert.deepEqual(extractSqlArray('v_observed_default_creators'), [
  'pg_database_owner',
  'postgres',
  'supabase_admin'
]);
assert.deepEqual(extractSqlArray('v_mutable_default_creators'), [
  'pg_database_owner',
  'postgres'
]);
assert.match(
  sql,
  /alter default privileges for role %I revoke execute on functions from public, anon, authenticated, service_role/
);
assert.match(
  sql,
  /alter default privileges for role %I in schema public revoke execute on functions from public, anon, authenticated, service_role/
);
assert.match(sql, /pg_catalog\.pg_has_role\(session_user,role_row\.oid,'SET'\)/);
assert.match(sql, /CNYOS_COMPLETE_ACL_PUBLIC_CREATE_CLOSED_WORLD_INVALID/);
assert.match(
  sql,
  /has_schema_privilege\(role_row\.oid,'public','CREATE'\)/
);
assert.match(sql, /v_actual is distinct from v_observed_default_creators/);
assert.match(
  sql,
  /namespace\.nspname='public'[\s\S]*?acl\.grantee=0 and acl\.privilege_type='CREATE'/
);
for (const roleTuple of [
  "('pg_database_owner',false,false)",
  "('postgres',true,false)",
  "('supabase_admin',true,true)"
]) {
  assert.ok(sql.includes(roleTuple), `CREATE baseline missing ${roleTuple}`);
}
assert.match(
  sql,
  /CNYOS_COMPLETE_ACL_UNTRUSTED_CREATOR_SET_REACHABILITY_INVALID/
);
assert.match(
  sql,
  /candidate_role\.rolcanlogin[\s\S]*?candidate_role\.rolname in[\s\S]*?'anon'[\s\S]*?'authenticated'[\s\S]*?'service_role'[\s\S]*?'authenticator'/
);
assert.match(
  sql,
  /pg_has_role\([\s\S]*?candidate_role\.oid,creator_role\.oid,'SET'[\s\S]*?\)/
);
assert.match(
  sql,
  /candidate_role\.rolname not in \('postgres','supabase_admin'\)/
);
assert.match(sql, /rolname='pg_database_owner'/);
assert.ok(sql.includes("'supabase_admin'"));
assert.match(sql, /foreach v_creator in array v_mutable_default_creators loop/);
assert.match(sql, /CNYOS_COMPLETE_ACL_HOSTED_MANAGED_EXCEPTION_BASELINE_INVALID/);
assert.ok(sql.includes(
  '1be7efa81a459ad950b1dba8602eb6e0d76c4f6f4185ba616c91fa52e3fe144a'
));
assert.match(sql, /CNYOS_COMPLETE_ACL_SUPABASE_ADMIN_DEFAULT_CHANGED/);
assert.match(sql, /v_supabase_admin_defaults_after is distinct from/);
const authorityCheck = sql.indexOf('CNYOS_COMPLETE_ACL_DEFAULT_CREATOR_AUTHORITY_INVALID');
const closedWorldCreateCheck = sql.indexOf(
  'CNYOS_COMPLETE_ACL_PUBLIC_CREATE_CLOSED_WORLD_INVALID'
);
const setReachabilityCheck = sql.indexOf(
  'CNYOS_COMPLETE_ACL_UNTRUSTED_CREATOR_SET_REACHABILITY_INVALID'
);
const managedBaselineCheck = sql.indexOf(
  'CNYOS_COMPLETE_ACL_MANAGED_DEFAULT_BASELINE_INVALID'
);
assert.ok(
  authorityCheck > 0 && authorityCheck < mutationMarker,
  'managed creator authority must fail before every default-ACL mutation'
);
assert.ok(
  closedWorldCreateCheck > authorityCheck && closedWorldCreateCheck < mutationMarker,
  'the exact effective public CREATE set must be pinned before every mutation'
);
assert.ok(
  setReachabilityCheck > closedWorldCreateCheck &&
    setReachabilityCheck < managedBaselineCheck,
  'SET-only creator reachability must be rejected before mutation'
);
assert.ok(
  managedBaselineCheck > setReachabilityCheck && managedBaselineCheck < mutationMarker,
  'fresh managed default-ACL baseline must be exact and pre-mutation'
);
for (const expectedTuple of [
  "('postgres','postgres')",
  "('supabase_admin','postgres')",
  "('supabase_admin','anon')",
  "('supabase_admin','authenticated')",
  "('supabase_admin','service_role')"
]) {
  assert.ok(sql.includes(expectedTuple), `managed baseline missing ${expectedTuple}`);
}
assert.match(sql, /CNYOS_COMPLETE_ACL_DEFAULT_ACL_POSTCONDITION_INVALID/);
const defaultAclPostcondition = sql.slice(
  sql.indexOf('-- All creator-global defaults must now explicitly suppress'),
  sql.indexOf("raise exception 'CNYOS_COMPLETE_ACL_DEFAULT_ACL_POSTCONDITION_INVALID'")
);
assert.equal(
  (defaultAclPostcondition.match(/defaults\.defaclobjtype='f'/g) || []).length,
  2,
  'both global and public-schema postconditions must ignore unrelated table/sequence defaults'
);

const invokerTriggerHandlers = new Set([
  'public.assign_audit_clinic()',
  'public.assign_patient_child_clinic()',
  'public.assign_patient_clinic()',
  'public.set_body_pain_point_updated_at()',
  'public.set_updated_at()'
]);
const planMatch = sql.match(
  /v_reviewed_path_plan constant jsonb := \$cnyos_reviewed_path_plan\$\n([\s\S]*?)\n  \$cnyos_reviewed_path_plan\$::jsonb;/
);
assert.ok(planMatch, 'exact SECURITY DEFINER path plan is missing');
const pathRows = JSON.parse(planMatch[1].replace(/^  /gm, ''));
assert.equal(pathRows.length, 141);
assert.equal(new Set(pathRows.map(row => row.signature)).size, 141);
assert.ok(pathRows.every(row => all.includes(row.signature)));
assert.equal(
  createHash('sha256').update(JSON.stringify(pathRows)).digest('hex'),
  'dd948f4f7f6baa535d26446aaba64aba3b7e79cfe2c4e2c63a2c83ee0fd0d2bb'
);
assert.deepEqual(
  Object.fromEntries([...new Set(pathRows.map(row => row.pre_config))].map(
    config => [config,pathRows.filter(row => row.pre_config===config).length]
  )),
  {
    'search_path=public': 73,
    'search_path=pg_catalog, public': 65,
    'search_path=pg_catalog': 3
  }
);
assert.deepEqual(
  Object.fromEntries([...new Set(pathRows.map(row => row.language))].map(
    language => [language,pathRows.filter(row => row.language===language).length]
  )),
  { plpgsql: 111, sql: 30 }
);
for (const row of pathRows) {
  assert.deepEqual(Object.keys(row), [
    'signature','definition_sha256','language','pre_config','target_config'
  ]);
  assert.match(row.definition_sha256, /^[0-9a-f]{64}$/);
  assert.ok(
    ['search_path=public', 'search_path=pg_catalog, public', 'search_path=pg_catalog']
      .includes(row.pre_config),
    `${row.signature} unexpected live-v2 path`
  );
  assert.match(row.target_config, /^search_path=pg_catalog(?:, public)?, pg_temp$/);
}
assert.equal(
  pathRows.filter(row => extracted.owner_only_trigger.includes(row.signature)).length,
  18
);
assert.ok([...invokerTriggerHandlers].every(signature =>
  !pathRows.some(row => row.signature===signature)
));
assert.equal(
  pathRows.filter(row => extracted.owner_only_event_trigger.includes(row.signature)).length,
  1
);

const nonSecurityDefinerDefinitionHashes = new Map(Object.entries({
  'public.create_clinical_treatment_session(uuid,text[],text,boolean,text,text,smallint,smallint,text,text)':
    'cf4c4bc482e7c871012cc6b748e9651a67ff6b4ada61d70b31f65020761ef4db',
  'public.assign_audit_clinic()':
    'd3902c2eb91cf465cd4cc8c945864ccadccd5525f7a8e54d2968873a254824dc',
  'public.assign_patient_child_clinic()':
    'b2f2320b8baf70fca0d24c1754958bd8d2b56f18a72e3a2ada536e32f2449ac0',
  'public.assign_patient_clinic()':
    '072a56af2ef951f612fcfe9b9914d6f1e22ce334229e4619f0bc7501137afeff',
  'public.set_body_pain_point_updated_at()':
    '9c587f1c35ac96472cfba84e3025a84de8e6fd31b2fe4ff5f2b7ac8bb51ce88f',
  'public.set_updated_at()':
    'f997b8d1324bf2112ffa7829fdc5f0ee799caf56a1cbef9a9d34fcc09ffb764c'
}));
assert.equal(nonSecurityDefinerDefinitionHashes.size, 6);
const allDefinitionHashes = new Map(pathRows.map(
  row => [row.signature,row.definition_sha256]
));
for (const [signature, digest] of nonSecurityDefinerDefinitionHashes) {
  assert.ok(!allDefinitionHashes.has(signature));
  allDefinitionHashes.set(signature,digest);
}
assert.equal(allDefinitionHashes.size, 147);
assert.deepEqual([...allDefinitionHashes.keys()].sort(), [...all].sort());
const encodeStableComponent = value =>
  `V${Buffer.from(value,'utf8').toString('hex')}`;
const definitionStableRows = [...allDefinitionHashes].map(([signature,digest]) =>
  [
    'cnyos-public-routine-definition-stable/v1',signature,digest
  ].map(encodeStableComponent).join(':')
).sort();
const definitionStablePayload = `${definitionStableRows.join('\n')}\n`;
assert.equal(Buffer.byteLength(definitionStablePayload), 48546);
assert.equal(
  createHash('sha256').update(definitionStablePayload).digest('hex'),
  'b5e54fb23207a99e8ebb8367b32f7d4ef7eeb53b6f5d3e29ea7c543497ba55d2'
);
assert.match(sql, /v_routine_definition_stable_bytes<>48546/);
assert.ok(sql.includes(
  'b5e54fb23207a99e8ebb8367b32f7d4ef7eeb53b6f5d3e29ea7c543497ba55d2'
));
assert.ok(sql.includes(
  'bb9d4c6ce985507814d2cc271e436bd9768eeba6332facabbcc3f11a37e783fa'
));
assert.match(sql, /CNYOS_COMPLETE_ACL_ROUTINE_DEFINITION_STABLE_DIGEST_INVALID/);
assert.ok(
  sql.indexOf('CNYOS_COMPLETE_ACL_ROUTINE_DEFINITION_STABLE_DIGEST_INVALID') <
    mutationMarker,
  'the all-147 routine definition digest must be enforced before mutation'
);
assert.match(sql, /pg_catalog\.pg_get_functiondef\(procedure\.oid\)/);
assert.match(sql, /procedure\.proconfig=array\[v_path\.pre_config\]::text\[\]/);
assert.match(sql, /to_jsonb\(procedure\)-'proacl'-'proconfig'/);
assert.match(sql, /CNYOS_COMPLETE_ACL_UNREVIEWED_SEARCH_PATH_CHANGED/);
assert.match(sql, /CNYOS_COMPLETE_ACL_SECURITY_DEFINER_PATH_SET_INVALID/);

const mutationSection = sql.slice(
  mutationMarker,
  sql.indexOf('-- CNYOS_COMPLETE_ACL_MUTATION_END')
);
assert.match(
  mutationSection,
  /alter function %s set search_path to %s/
);
assert.match(mutationSection, /jsonb_to_recordset\(v_reviewed_path_plan\)/);

assert.match(sql, /v_trigger_count <> 173/);
assert.match(sql, /v_event_trigger_count <> 7/);
assert.match(sql, /v_trigger_stable_bytes<>198158/);
assert.match(sql, /v_event_trigger_stable_bytes<>5122/);
assert.match(sql, /CNYOS_COMPLETE_ACL_TRIGGER_BINDING_STABLE_DIGEST_INVALID/);
assert.match(sql, /CNYOS_COMPLETE_ACL_EVENT_TRIGGER_STABLE_DIGEST_INVALID/);
assert.ok(
  sql.indexOf('CNYOS_COMPLETE_ACL_TRIGGER_BINDING_STABLE_DIGEST_INVALID') <
    mutationMarker
);
assert.ok(
  sql.indexOf('CNYOS_COMPLETE_ACL_EVENT_TRIGGER_STABLE_DIGEST_INVALID') <
    mutationMarker
);
assert.match(sql, /trigger_row\.tgenabled <> 'O'/);
assert.match(sql, /event_row\.evtenabled <> 'O'/);
assert.match(sql, /relation\.relpersistence='t'/);
assert.match(sql, /namespace\.nspname like 'pg_temp\\_%'/);
assert.match(sql, /to_jsonb\(trigger_row\)/);
assert.match(sql, /to_jsonb\(event_row\)/);
assert.match(
  sql,
  /v_trigger_bindings_after is distinct from v_trigger_bindings_before/
);
assert.match(sql, /v_event_bindings_after is distinct from v_event_bindings_before/);
assert.match(sql, /CNYOS_COMPLETE_ACL_BINDINGS_CHANGED/);

function classifiedBindingDigest(triggerBindings, eventBindings) {
  const rows = [
    ...triggerBindings.map(entry => [
      'trigger',entry.relation_schema,entry.relation_name,entry.trigger_name,
      entry.function_signature,entry.canonical_row_sha256
    ]),
    ...eventBindings.map(entry => [
      'event',entry.event_trigger_name,entry.event,entry.function_signature,
      entry.canonical_row_sha256
    ])
  ].map(row => JSON.stringify(row)).sort();
  return createHash('sha256').update(`${rows.join('\n')}\n`).digest('hex');
}
const classifiedDigest = classifiedBindingDigest(
  disposition.trigger_bindings,
  disposition.event_trigger_bindings
);
const swappedRelation = structuredClone(disposition.trigger_bindings);
[swappedRelation[0].relation_name,swappedRelation[1].relation_name] =
  [swappedRelation[1].relation_name,swappedRelation[0].relation_name];
assert.notEqual(
  classifiedBindingDigest(swappedRelation,disposition.event_trigger_bindings),
  classifiedDigest,
  'same-count relation rebinding must change the classified digest'
);
const swappedTrigger = structuredClone(disposition.trigger_bindings);
[swappedTrigger[0].trigger_name,swappedTrigger[1].trigger_name] =
  [swappedTrigger[1].trigger_name,swappedTrigger[0].trigger_name];
assert.notEqual(
  classifiedBindingDigest(swappedTrigger,disposition.event_trigger_bindings),
  classifiedDigest,
  'same-count trigger swap must change the classified digest'
);
const changedCondition = structuredClone(disposition.trigger_bindings);
changedCondition[0].canonical_row_sha256 = '0'.repeat(64);
assert.notEqual(
  classifiedBindingDigest(changedCondition,disposition.event_trigger_bindings),
  classifiedDigest,
  'changed trigger definition/condition must change the classified digest'
);
const swappedEvent = structuredClone(disposition.event_trigger_bindings);
[swappedEvent[0].event_trigger_name,swappedEvent[1].event_trigger_name] =
  [swappedEvent[1].event_trigger_name,swappedEvent[0].event_trigger_name];
assert.notEqual(
  classifiedBindingDigest(disposition.trigger_bindings,swappedEvent),
  classifiedDigest,
  'same-count event-trigger swap must change the classified digest'
);
const changedEventHandler = structuredClone(disposition.event_trigger_bindings);
changedEventHandler[0].canonical_row_sha256 = 'f'.repeat(64);
assert.notEqual(
  classifiedBindingDigest(disposition.trigger_bindings,changedEventHandler),
  classifiedDigest,
  'changed event handler definition must change the classified digest'
);

for (const forbidden of [
  /CHECKS_PASSED/,
  /REMEDIATION_PASSED/,
  /\bREADY\b/,
  /production_eligible\s*=\s*true/i,
  /authorization\s*=\s*true/i
]) {
  assert.doesNotMatch(sql, forbidden, 'inert candidate must not emit success/authorization');
}
assert.match(
  sql,
  /independent post-commit observer would still be required/
);

assert.match(
  nativeE2eSource,
  /process\.env\.CNYOS_PG17_DISPOSABLE_ACK !== disposableAcknowledgement/,
  'destructive native E2E must require the exact disposable-cluster acknowledgement'
);
assert.match(
  nativeE2eSource,
  /I_ACKNOWLEDGE_DISPOSABLE_LOOPBACK_POSTGRESQL_17/,
  'destructive native E2E acknowledgement value changed'
);
assert.match(
  nativeE2eSource,
  /databaseHost !== '127\.0\.0\.1'/,
  'destructive native E2E must reject non-loopback PostgreSQL hosts'
);
assert.match(
  nativeE2eSource,
  /databaseUser !== 'postgres'/,
  'destructive native E2E must require the disposable postgres administrator'
);
assert.match(
  nativeE2eSource,
  /nativePsql && !path\.isAbsolute\(nativePsql\)/,
  'native psql override must be absolute'
);
assert.match(
  nativeE2eSource,
  /PGPASSFILE=\/e2e\/pgpass/,
  'Docker psql must consume a mounted passfile'
);
assert.match(
  nativeE2eSource,
  /mode: 0o600, flag: 'wx'/,
  'the native E2E passfile must be created exclusively at mode 0600'
);
assert.doesNotMatch(
  nativeE2eSource,
  /['"`]PGPASSWORD=/,
  'password material must never enter Docker argv'
);
assert.doesNotMatch(
  nativeE2eSource,
  /\bPGPASSWORD\s*:/,
  'password material must never enter the spawned native process environment'
);
assert.match(
  nativeE2eSource,
  /cnyos_complete_acl_e2e_\$\{randomUUID\(\)\.replaceAll\('-', ''\)\}/,
  'destructive native E2E must use a unique per-run database name'
);

console.log(
  'complete public-routine ACL remediation contract passed: ' +
  '147 exact routines; authenticated=70; service=75; owner-only=49; ' +
  'SECURITY DEFINER paths=141; type-only signatures=6; static locks=91; ' +
  'candidate remains blocked on managed-host, ' +
  'concurrency/fresh-observer, ledger, and full-rehearsal gates'
);
