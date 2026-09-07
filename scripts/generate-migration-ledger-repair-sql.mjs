import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTenantConfig } from './generate-tenant-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stagingMarker = /(?:^|[-_.])(staging|stage|nonprod|test)(?:$|[-_.])/i;
const migrationName = /^(\d{12,14})_([a-z0-9_]+)\.sql$/i;
const immutableMigrationHashes = new Map([
  [
    '202608311800_owner_subscription_control.sql',
    'f4a00ed5595d710cb2c66107e7f1071fdb2179adfa3fff6b9a690a88556f8c43'
  ]
]);

export const MIGRATION_LEDGER_ACL_PHASE_STRICT = 'strict-post-remediation';
export const MIGRATION_LEDGER_ACL_PHASE_CHANANYA_PRE_RECONCILIATION =
  'chananya-pre-reconciliation';

const migrationLedgerRepairAuthorizationBlocker =
  'CNYOS_LEDGER_REPAIR_INDEPENDENT_REVIEW_AND_AUTHORIZATION_REQUIRED: classified live ACL evidence is complete, but independent security review and explicit ledger repair authorization are required before any ledger repair';

const compareCanonicalTuple = (left, right) => {
  const leftKey = left.join('\t');
  const rightKey = right.join('\t');
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
};

// Retained only to keep the generic strict-post-remediation schema guard
// executable against the historical migration fixture. It is not exported or
// presented as Chananya live evidence.
const legacyStrictBrowserRpcAclExceptions = [
  ['anon', 'public.book_clinic_appointment(uuid,uuid,text,text,text)'],
  ['anon', 'public.cancel_clinic_appointment(uuid,text)'],
  ['anon', 'public.clinical_financial_handoffs_healthcheck()'],
  ['anon', 'public.create_approval_task(text,text,text,text,text,text,uuid,timestamptz,jsonb)'],
  ['anon', 'public.current_user_role()'],
  ['anon', 'public.decide_approval_task(uuid,text,text)'],
  ['anon', 'public.department_persistence_healthcheck()'],
  ['anon', 'public.is_admin_or_super()'],
  ['anon', 'public.is_appointment_operator()'],
  ['anon', 'public.is_appointment_practitioner()'],
  ['anon', 'public.is_clinic_admin()'],
  ['anon', 'public.is_practitioner()'],
  ['anon', 'public.is_reception_or_admin()'],
  ['anon', 'public.prescription_dispensing_healthcheck()'],
  ['anon', 'public.production_execution_healthcheck()'],
  ['anon', 'public.quality_release_healthcheck()'],
  ['anon', 'public.set_clinic_appointment_status(uuid,text,text)'],
  ['service_role', 'public.book_clinic_appointment(uuid,uuid,text,text,text)'],
  ['service_role', 'public.cancel_clinic_appointment(uuid,text)'],
  ['service_role', 'public.create_approval_task(text,text,text,text,text,text,uuid,timestamptz,jsonb)'],
  ['service_role', 'public.decide_approval_task(uuid,text,text)'],
  ['service_role', 'public.set_clinic_appointment_status(uuid,text,text)']
].sort(compareCanonicalTuple);

const serializeBrowserRpcAclTuples = tuples => tuples
  .map(([grantee, procedureSignature]) =>
    `${grantee}\t${procedureSignature}\tEXECUTE\tfalse\towner`)
  .join('\n') + '\n';

const chananyaPreReconciliationTriggerInventory = [
  ['public.apply_stock_movement()', 'postgres', 'search_path=public', true, 1],
  ['public.assign_audit_clinic()', 'postgres', 'search_path=public', false, 1],
  ['public.assign_inventory_lot_clinic()', 'postgres', 'search_path=public', true, 1],
  ['public.assign_patient_child_clinic()', 'postgres', 'search_path=public', false, 2],
  ['public.assign_patient_clinic()', 'postgres', 'search_path=public', false, 1],
  ['public.assign_pharmacy_allocation_clinic()', 'postgres', 'search_path=public', true, 1],
  ['public.assign_pharmacy_item_clinic()', 'postgres', 'search_path=public', true, 1],
  ['public.assign_pharmacy_sale_clinic()', 'postgres', 'search_path=public', true, 1],
  ['public.assign_product_clinic()', 'postgres', 'search_path=public', true, 1],
  ['public.assign_stock_movement_clinic()', 'postgres', 'search_path=public', true, 1],
  ['public.enforce_active_subscription_tenant_write()', 'postgres', 'search_path=pg_catalog, public', true, 17],
  ['public.enforce_authenticated_subscription_statement_write()', 'postgres', 'search_path=pg_catalog, public', true, 87],
  ['public.enforce_patient_registry_write()', 'postgres', 'search_path=public', true, 2],
  ['public.enforce_prescription_item_product_tenant()', 'postgres', 'search_path=public', true, 1],
  ['public.enqueue_line_oa_from_appointment()', 'postgres', 'search_path=public', true, 1],
  ['public.guard_owner_subscription_forward_only()', 'postgres', 'search_path=pg_catalog, public', true, 1],
  ['public.handle_new_user()', 'postgres', 'search_path=public', true, 1],
  ['public.prevent_encounter_clinical_evidence_delete()', 'postgres', 'search_path=pg_catalog', true, 1],
  ['public.prevent_locked_clinical_record_mutation()', 'postgres', 'search_path=public', true, 8],
  ['public.reject_append_only_mutation()', 'postgres', 'search_path=pg_catalog', true, 8],
  ['public.set_body_pain_point_updated_at()', 'postgres', 'search_path=public', false, 1],
  ['public.set_updated_at()', 'postgres', '', false, 28],
  ['public.withdraw_line_oa_on_identity_revoke()', 'postgres', 'search_path=public', true, 1]
];

const triggerProceduresWithoutNonOwnerAcl = new Set([
  'public.enforce_active_subscription_tenant_write()',
  'public.enforce_authenticated_subscription_statement_write()',
  'public.enqueue_line_oa_from_appointment()',
  'public.guard_owner_subscription_forward_only()',
  'public.prevent_encounter_clinical_evidence_delete()',
  'public.reject_append_only_mutation()',
  'public.withdraw_line_oa_on_identity_revoke()'
]);
const triggerProceduresWithoutPublicAcl = new Set([
  'public.apply_stock_movement()',
  'public.enforce_prescription_item_product_tenant()'
]);
const chananyaPreReconciliationTriggerAclTuples =
  chananyaPreReconciliationTriggerInventory.flatMap(([procedureSignature]) => {
    if (triggerProceduresWithoutNonOwnerAcl.has(procedureSignature)) return [];
    const grantees = triggerProceduresWithoutPublicAcl.has(procedureSignature)
      ? ['anon', 'authenticated', 'service_role']
      : ['PUBLIC', 'anon', 'authenticated', 'service_role'];
    return grantees.map(grantee => [grantee, procedureSignature]);
  }).sort(compareCanonicalTuple);

const serializeTriggerInventory = inventory => inventory
  .map(([procedureSignature, owner, searchPath, securityDefiner, bindingCount]) =>
    `${procedureSignature}\t${owner}\t${searchPath}\t${securityDefiner}\t${bindingCount}`)
  .join('\n') + '\n';

const legacyStrictTriggerGuardManifest = Object.freeze({
  observedAt: '2026-09-06T15:42:59.875869Z',
  inventorySha256: '4ff91cbb4fca03b8f7f2d0eaa6dc47b198ea7ce592a1d624d5b72bc273558a0d',
  aclTupleSha256: 'bd0391e6a7f6a06797fde1d9f9e90e2a475cf2679b298f86b7b8492980a39b11',
  serverMajor: 17,
  serverEncoding: 'UTF8',
  allowedFunctionSchema: 'public',
  expectedOwnerRole: 'postgres',
  relationScope: 'all public relations, auth.users, and every binding to a public function',
  functionSemanticObservedAt: '2026-09-06T16:47:15.312545Z',
  functionSemanticCount: 23,
  functionSemanticPreReconciliationPayloadBytes: 21183,
  functionSemanticPreReconciliationSha256:
    '4c92389f247e80c27c63721eff19f321ed538c8e70d616df5aa36e193cb2eb0b',
  functionSemanticStrictPayloadBytes: 21213,
  functionSemanticStrictSha256:
    '07535c64e7607d8cc9bc34b197a40e3923f4f56df84262d041d56541b1890737',
  functionSemanticSerialization:
    'cnyos-trigger-function/v1 positional JSON including names, arguments/result, owner, language, executable flags/costs, support, defaults, body/binary/sqlbody and config; bytewise ordered; LF joined with one final LF',
  bindingObservedAt: '2026-09-06T16:47:15.312545Z',
  bindingCount: 168,
  bindingPayloadBytes: 46998,
  bindingSha256: '9430970d3b25cbe3d5d4ab704740e62ce5a6864d9a804a732ed6f8919523fe54',
  bindingSerialization:
    'cnyos-trigger-binding/v1 positional JSON including relation/function names, trigger mode/type/update columns/args/WHEN/transition tables and semantic constraint/index/parent references; bytewise ordered; LF joined with one final LF',
  triggerInventory: Object.freeze(
    chananyaPreReconciliationTriggerInventory.map(row => Object.freeze([...row]))
  ),
  aclTuples: Object.freeze(
    chananyaPreReconciliationTriggerAclTuples.map(row => Object.freeze([...row]))
  )
});

if (createHash('sha256').update(serializeTriggerInventory(
  chananyaPreReconciliationTriggerInventory
)).digest('hex') !== legacyStrictTriggerGuardManifest.inventorySha256) {
  throw new Error('Chananya pre-reconciliation trigger inventory SHA-256 mismatch');
}
if (createHash('sha256').update(serializeBrowserRpcAclTuples(
  chananyaPreReconciliationTriggerAclTuples
)).digest('hex') !== legacyStrictTriggerGuardManifest.aclTupleSha256) {
  throw new Error('Chananya pre-reconciliation trigger ACL SHA-256 mismatch');
}

// Public only so disposable PostgreSQL E2E fixtures can materialize the
// historical repository-derived strict state. This is deliberately separate
// from the classified live Chananya manifest and is never live evidence or an
// authorization record.
export const REPOSITORY_STRICT_ACL_FIXTURE_MANIFEST = Object.freeze({
  provenance: 'repository-derived-disposable-test-fixture-not-live-evidence',
  browserRpcAclTuples: Object.freeze(
    legacyStrictBrowserRpcAclExceptions.map(row => Object.freeze([...row]))
  ),
  triggerInventory: legacyStrictTriggerGuardManifest.triggerInventory,
  triggerAclTuples: legacyStrictTriggerGuardManifest.aclTuples
});

const reviewedMigrationManifestSha256 =
  'b21bf64a89aaa01cf757a14c74dcbd02caa5c7dfb6e43bc2215bbd70291a1e0a';
const reviewedMigrationManifestCount = 45;
export const CHANANYA_REVIEWED_SYSTEM_IDENTIFIER = '7666007964130682852';

const classifiedDispositionPath = path.join(
  root,
  'security',
  'chananya-staging-public-routine-acl-disposition-831543c.json'
);
const classifiedDispositionBytes = fs.readFileSync(classifiedDispositionPath);
const classifiedDispositionRawSha256 = createHash('sha256')
  .update(classifiedDispositionBytes)
  .digest('hex');
if (classifiedDispositionRawSha256 !==
    '0f5979a9f64a9600fa3083703fcd0937487772dffdfa93370aabb6ca28e41400') {
  throw new Error('Chananya classified disposition artifact SHA-256 mismatch');
}
const classifiedDisposition = JSON.parse(classifiedDispositionBytes.toString('utf8'));
const requiredDispositionCategories = [
  'authenticated_only',
  'authenticated_and_service',
  'service_only',
  'owner_only_ordinary',
  'owner_only_trigger',
  'owner_only_event_trigger'
];
const requiredDispositionCounts = [23, 47, 28, 25, 23, 1];
if (classifiedDisposition.artifact_schema !==
      'cnyos-public-routine-acl-disposition/v1' ||
    classifiedDisposition.schema_version !== 1 ||
    classifiedDisposition.status !== 'CLASSIFIED_COMPLETE_NOT_AUTHORIZED' ||
    classifiedDisposition.classification_complete !== true ||
    Object.values(classifiedDisposition.authorization_flags ?? {})
      .some(value => value !== false) ||
    Object.keys(classifiedDisposition.routine_dispositions ?? {}).sort().join('\n') !==
      [...requiredDispositionCategories].sort().join('\n') ||
    requiredDispositionCategories.some((category, index) =>
      !Array.isArray(classifiedDisposition.routine_dispositions[category]) ||
      classifiedDisposition.routine_dispositions[category].length !==
        requiredDispositionCounts[index])) {
  throw new Error('Chananya classified disposition artifact contract mismatch');
}
const classifiedRoutineSignatures = requiredDispositionCategories.flatMap(
  category => classifiedDisposition.routine_dispositions[category]
);
if (classifiedRoutineSignatures.length !== 147 ||
    new Set(classifiedRoutineSignatures).size !== 147 ||
    classifiedRoutineSignatures.some(signature =>
      typeof signature !== 'string' || !signature.startsWith('public.'))) {
  throw new Error('Chananya classified routine disposition is not an exact 147-routine set');
}
const dispositionSource = classifiedDisposition.source;
if (dispositionSource.source_revision !==
      '831543c2d1ed36b2d8242cc82af23c83e019e7a7' ||
    dispositionSource.observer_raw_sha256 !==
      '235a2c612c78367e4c2beff0243b4bc624fd6107fbdc39b1f9c0af8ae4ace27e' ||
    dispositionSource.observer_source_sql_sha256 !==
      '46a226f7ab7f0d3ee4f6062c1bc223dcdbee351d7640f86592e3614cb261a777' ||
    dispositionSource.observation_composite_sha256 !==
      '9a555548d810ec5bed2dc86591651ca144941687c3fd34cf8d0828708ebb9efe' ||
    dispositionSource.system_identifier !== CHANANYA_REVIEWED_SYSTEM_IDENTIFIER ||
    dispositionSource.project_label !== 'chananya-staging' ||
    dispositionSource.project_ref !== 'hsmnjwxurlmsizndjlun' ||
    classifiedDisposition.canonical_disposition_digest?.entry_count !== 327 ||
    classifiedDisposition.canonical_disposition_digest?.payload_sha256 !==
      'b64789650acf4dd435d7cd41e114fac6c71b35d995cf78b2ce954ad8b571d343') {
  throw new Error('Chananya classified disposition source binding mismatch');
}

const completeAclCandidatePath = path.join(
  root,
  'supabase',
  'manual',
  '202609080900_close_complete_public_routine_acl_candidate.sql'
);
const completeAclCandidateSource = fs.readFileSync(completeAclCandidatePath, 'utf8');
const completeAclCandidateSha256 = createHash('sha256')
  .update(completeAclCandidateSource)
  .digest('hex');
if (completeAclCandidateSha256 !==
    '2f374ca556a1f98f46ec179b2e8143d56c7f900d7d1812e2dc7f5e23439e4acf') {
  throw new Error('Chananya complete ACL candidate source SHA-256 mismatch');
}
const reviewedPathPlanMatch = completeAclCandidateSource.match(
  /v_reviewed_path_plan constant jsonb := \$cnyos_reviewed_path_plan\$\s*([\s\S]*?)\s*\$cnyos_reviewed_path_plan\$::jsonb;/
);
if (!reviewedPathPlanMatch) {
  throw new Error('Chananya complete ACL candidate path plan is missing');
}
const reviewedSecurityDefinerPathPlan = JSON.parse(reviewedPathPlanMatch[1]);
const reviewedPathPlanSha256 = createHash('sha256')
  .update(JSON.stringify(reviewedSecurityDefinerPathPlan))
  .digest('hex');
if (reviewedSecurityDefinerPathPlan.length !== 141 ||
    new Set(reviewedSecurityDefinerPathPlan.map(row => row.signature)).size !== 141 ||
    reviewedPathPlanSha256 !==
      'dd948f4f7f6baa535d26446aaba64aba3b7e79cfe2c4e2c63a2c83ee0fd0d2bb' ||
    reviewedSecurityDefinerPathPlan.some(row =>
      !classifiedRoutineSignatures.includes(row.signature) ||
      !/^[0-9a-f]{64}$/.test(row.definition_sha256) ||
      !['plpgsql', 'sql'].includes(row.language) ||
      ![
        'search_path=public',
        'search_path=pg_catalog, public',
        'search_path=pg_catalog'
      ].includes(row.pre_config) ||
      row.target_config !== (row.pre_config === 'search_path=pg_catalog'
        ? 'search_path=pg_catalog, pg_temp'
        : 'search_path=pg_catalog, public, pg_temp'))) {
  throw new Error('Chananya SECURITY DEFINER path plan contract mismatch');
}
const triggerRelationPlanMatch = completeAclCandidateSource.match(
  /v_trigger_relations constant text\[\] := array\[\s*([\s\S]*?)\s*\]::text\[\];/
);
if (!triggerRelationPlanMatch) {
  throw new Error('Chananya complete ACL candidate trigger-relation lock plan is missing');
}
const reviewedTriggerRelationLockPlan = triggerRelationPlanMatch[1]
  .split('\n')
  .map(line => line.trim())
  .filter(Boolean)
  .map((line, index, lines) => {
    const match = line.match(/^'([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)'(,?)$/);
    if (!match || (index < lines.length - 1 ? match[2] !== ',' : match[2] !== '')) {
      throw new Error('Chananya complete ACL candidate trigger-relation lock plan is malformed');
    }
    return match[1];
  });
const serializeTriggerRelationLockPlan = relations => relations.join('\n') + '\n';
const reviewedTriggerRelationLockPlanPayload = serializeTriggerRelationLockPlan(
  reviewedTriggerRelationLockPlan
);
const reviewedTriggerRelationLockPlanSha256 = createHash('sha256')
  .update(reviewedTriggerRelationLockPlanPayload)
  .digest('hex');
if (reviewedTriggerRelationLockPlan.length !== 91 ||
    new Set(reviewedTriggerRelationLockPlan).size !== 91 ||
    Buffer.byteLength(reviewedTriggerRelationLockPlanPayload) !== 2400 ||
    reviewedTriggerRelationLockPlanSha256 !==
      '65cc5e93f3ef618e4fe77e535f908f630d4e4a5ac5a5857c7f92172b19eb3611' ||
    !completeAclCandidateSource.includes(
      "raise exception 'CNYOS_COMPLETE_ACL_HOSTED_CONCURRENCY_AND_FRESH_OBSERVER_NOT_APPROVED';"
    )) {
  throw new Error('Chananya complete ACL candidate hosted-concurrency contract mismatch');
}
const stableBindingGuardStart = completeAclCandidateSource.indexOf(
  '  -- Recompute stable, OID-independent semantic digests'
);
const stableBindingGuardEnd = completeAclCandidateSource.indexOf(
  '  select array_agg(signature order by signature collate "C") into v_actual',
  stableBindingGuardStart
);
if (stableBindingGuardStart < 0 || stableBindingGuardEnd <= stableBindingGuardStart) {
  throw new Error('Chananya complete ACL stable-binding guard is missing');
}
const classifiedStableBindingGuardSql = completeAclCandidateSource.slice(
  stableBindingGuardStart,
  stableBindingGuardEnd
);
if (createHash('sha256').update(classifiedStableBindingGuardSql).digest('hex') !==
    '51940b5f142653d6a9f2d482244df62b816adf627005154444d56bd86a5ee53e') {
  throw new Error('Chananya complete ACL stable-binding guard SHA-256 mismatch');
}

const triggerBindingIdentityRows = classifiedDisposition.trigger_bindings.map(row => [
  row.relation_schema,
  row.relation_name,
  row.trigger_name,
  row.function_signature
]);
const eventBindingIdentityRows = classifiedDisposition.event_trigger_bindings.map(row => [
  row.event_trigger_name,
  row.event,
  row.function_signature
]);
if (triggerBindingIdentityRows.length !== 173 || eventBindingIdentityRows.length !== 7 ||
    dispositionSource.binding_datasets.trigger_bindings_all_non_internal.row_count !== 173 ||
    dispositionSource.binding_datasets.trigger_bindings_all_non_internal.payload_sha256 !==
      '2f5ffa09ed5a895733d4ba6418ae0a69ab190d3a6718bde73e17dc73118fd15d' ||
    dispositionSource.binding_datasets.event_trigger_bindings_all.row_count !== 7 ||
    dispositionSource.binding_datasets.event_trigger_bindings_all.payload_sha256 !==
      'b0ba455cb69e75488c4c50229a387e4859c201581921c96737a313961ba6c799') {
  throw new Error('Chananya classified binding disposition contract mismatch');
}
const dispositionTriggerRelations = [...new Set(
  classifiedDisposition.trigger_bindings.map(
    row => `${row.relation_schema}.${row.relation_name}`
  )
)].sort();
if (JSON.stringify(reviewedTriggerRelationLockPlan) !==
    JSON.stringify(dispositionTriggerRelations)) {
  throw new Error(
    'Chananya complete ACL candidate trigger-relation lock plan does not match disposition'
  );
}

const freezeStringArray = values => Object.freeze([...values]);
const routineDispositions = Object.freeze(Object.fromEntries(
  requiredDispositionCategories.map(category => [
    category,
    freezeStringArray(classifiedDisposition.routine_dispositions[category])
  ])
));
export const CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST = Object.freeze({
  evidenceScope: 'classified-complete-live-public-routine-inventory-not-authorized',
  liveCallableAclInventoryComplete: true,
  classificationCoverageComplete: true,
  authorization: false,
  independentSecurityReviewComplete: false,
  ledgerReconciliationAuthorized: false,
  hostedConcurrencyProtocolApproved: false,
  hostedTriggerRelationLockPlanRehearsed: false,
  freshPostCommitObserverRequired: true,
  freshPostCommitObserverCompleted: false,
  projectRef: 'hsmnjwxurlmsizndjlun',
  databaseOrigin: 'https://hsmnjwxurlmsizndjlun.supabase.co',
  deploymentId: 'chananya-clinical-staging',
  clinicCode: 'CHANANYA-STG',
  clinicId: '00000000-0000-4000-8000-00000000a001',
  observationSourceRevision: dispositionSource.source_revision,
  observerRawSha256: dispositionSource.observer_raw_sha256,
  observerSourceSqlSha256: dispositionSource.observer_source_sql_sha256,
  observationCompositeSha256: dispositionSource.observation_composite_sha256,
  dispositionArtifactSha256: classifiedDispositionRawSha256,
  dispositionPayloadSha256:
    classifiedDisposition.canonical_disposition_digest.payload_sha256,
  completeAclCandidateSha256,
  ledgerTargetBaseline: Object.freeze({
    artifactSchema: 'cnyos-ledger-target-baseline/v1',
    externalEvidenceSha256:
      'e2bacfb9fd36612a3a0ba86dc8260d6421952d867c412b6bd9db1afd91ff1418',
    chananyaObservedMigrationCount: 32,
    authorization: false,
    jitarsaAuthorization: false
  }),
  routineCount: 147,
  routineDispositions,
  desiredEffectiveExecute: Object.freeze({
    ...classifiedDisposition.derived_expected_access
  }),
  currentRawAclMatrix: Object.freeze({
    rowCount: 456,
    payloadBytes: 57491,
    sha256: '693b6b931332fb6c5e5fdb92b93115ee15a219734a0334fbce3823f746fda5b0'
  }),
  currentEffectiveAccessMatrix: Object.freeze({
    rowCount: 588,
    payloadBytes: 55755,
    sha256: '73ff6f9c56fb3dc302ea647b1d2c36b8c7451445d73c1463fb25dc7bd9b9ed80'
  }),
  desiredEffectiveAccessMatrix: Object.freeze({
    rowCount: 588,
    payloadBytes: 43292,
    sha256: '64fbbc346858d040cc5b9a187af5da544cd460392a27ea8e2dc418cb7ede9bec'
  }),
  securityDefinerPathPlan: Object.freeze({
    count: 141,
    sha256: reviewedPathPlanSha256,
    pathDistribution: Object.freeze({
      'search_path=public': 73,
      'search_path=pg_catalog, public': 65,
      'search_path=pg_catalog': 3
    }),
    rows: Object.freeze(reviewedSecurityDefinerPathPlan.map(row => Object.freeze({ ...row })))
  }),
  postToggleDefaultAclBaseline: Object.freeze({
    artifactSchema: 'cnyos-post-toggle-default-acl-observation/v1',
    externalEvidenceSha256:
      '1be7efa81a459ad950b1dba8602eb6e0d76c4f6f4185ba616c91fa52e3fe144a',
    capturedAt: '2026-09-07T21:12:57.689224Z',
    creatorRoles: Object.freeze(['pg_database_owner', 'postgres', 'supabase_admin']),
    globalFunctionRows: 0,
    publicSchemaFunctionRows: 2,
    expandedTupleCount: 5,
    managedSupabaseAdminExceptionAccepted: false,
    hostedPostgresSuperuser: false,
    protectedCatalogShareLockSupported: false
  })
});

export const CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST = Object.freeze({
  serverMajor: 17,
  serverEncoding: 'UTF8',
  allowedFunctionSchema: 'public',
  expectedOwnerRole: 'postgres',
  triggerHandlerCount: routineDispositions.owner_only_trigger.length,
  eventTriggerHandlerCount: routineDispositions.owner_only_event_trigger.length,
  triggerBindingCount: 173,
  triggerBindingDatasetSha256:
    dispositionSource.binding_datasets.trigger_bindings_all_non_internal.payload_sha256,
  triggerBindingIdentityPayloadBytes: 20227,
  triggerBindingIdentitySha256:
    'e4a98936ece8103d851ea4d7708c73686c74713afd6ea8baad2885db4f831435',
  triggerBindingStablePayloadBytes: 198158,
  triggerBindingStableSha256:
    'aa777a86a6ade0616080eb5b41680f2d4dadc0e4a686acc71459d80bd380fea6',
  triggerRelationLockPlanCount: reviewedTriggerRelationLockPlan.length,
  triggerRelationLockPlanPayloadBytes:
    Buffer.byteLength(reviewedTriggerRelationLockPlanPayload),
  triggerRelationLockPlanSha256: reviewedTriggerRelationLockPlanSha256,
  eventTriggerBindingCount: 7,
  eventTriggerBindingDatasetSha256:
    dispositionSource.binding_datasets.event_trigger_bindings_all.payload_sha256,
  eventTriggerBindingIdentityPayloadBytes: 458,
  eventTriggerBindingIdentitySha256:
    'c246db450dba7fe6d7f8901d935c5a04e3558fac9be11a2670c5044d5546d04f',
  eventTriggerBindingStablePayloadBytes: 5122,
  eventTriggerBindingStableSha256:
    'cbabdf241e6d6634759fd20c94ef98c4f939458397532671c1e38265b51ddddf',
  triggerHandlerSignatures: routineDispositions.owner_only_trigger,
  eventTriggerHandlerSignatures: routineDispositions.owner_only_event_trigger
});

const chananyaPreReconciliationKnownEvidencePayload = {
  schemaVersion: 4,
  evidenceScope: CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.evidenceScope,
  projectRef: CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.projectRef,
  systemIdentifier: CHANANYA_REVIEWED_SYSTEM_IDENTIFIER,
  observationSourceRevision:
    CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.observationSourceRevision,
  observerRawSha256: CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.observerRawSha256,
  observerSourceSqlSha256:
    CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.observerSourceSqlSha256,
  observationCompositeSha256:
    CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.observationCompositeSha256,
  dispositionArtifactSha256:
    CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.dispositionArtifactSha256,
  dispositionPayloadSha256:
    CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.dispositionPayloadSha256,
  completeAclCandidateSha256:
    CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.completeAclCandidateSha256,
  ledgerTargetBaselineEvidenceSha256:
    CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.ledgerTargetBaseline
      .externalEvidenceSha256,
  routineCount: CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.routineCount,
  pathPlanSha256:
    CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.securityDefinerPathPlan.sha256,
  postToggleDefaultAclEvidenceSha256:
    CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.postToggleDefaultAclBaseline
      .externalEvidenceSha256,
  triggerBindingDatasetSha256:
    CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.triggerBindingDatasetSha256,
  eventTriggerBindingDatasetSha256:
    CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.eventTriggerBindingDatasetSha256,
  triggerRelationLockPlanSha256:
    CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.triggerRelationLockPlanSha256,
  migrationManifestSha256: reviewedMigrationManifestSha256
};
export const CHANANYA_PRE_RECONCILIATION_KNOWN_EVIDENCE_BUNDLE = Object.freeze({
  ...chananyaPreReconciliationKnownEvidencePayload,
  authorization: false,
  independentSecurityReviewComplete: false,
  hostedConcurrencyProtocolApproved: false,
  hostedTriggerRelationLockPlanRehearsed: false,
  freshPostCommitObserverRequired: true,
  freshPostCommitObserverCompleted: false,
  liveCallableAclInventoryComplete: true,
  sha256: createHash('sha256')
    .update(JSON.stringify(chananyaPreReconciliationKnownEvidencePayload))
    .digest('hex')
});

// This debt is derived from the ordered repository migration. The CREATE
// FUNCTION default leaves PUBLIC EXECUTE in place and the migration adds a
// direct authenticated grant. Keep the provenance separate so a repository
// inference can never be misreported as a live staging fact.
const createClinicalTreatmentSessionSignature =
  'public.create_clinical_treatment_session(uuid,text[],text,boolean,text,text,smallint,smallint,text,text)';
const repositoryDerivedClinicalTreatmentSessionAclPayload = {
  schemaVersion: 1,
  provenance: 'repository-derived-not-live-observed',
  derivation:
    'ordered migration CREATE FUNCTION default PUBLIC EXECUTE plus explicit authenticated GRANT',
  sourceMigration: '202608252110_stabilize_treatment_sessions.sql',
  sourceMigrationSha256:
    '93b28aaa7cab2430e1b5eb86e387f75c75a3e61dc0538d42ae4bcb6fcc5a40be',
  procedureSignature: createClinicalTreatmentSessionSignature,
  semanticContract: {
    owner: 'postgres',
    language: 'plpgsql',
    kind: 'f',
    security: 'invoker',
    searchPath: 'search_path=public',
    resultType: 'public.clinical_treatment_sessions',
    returnsSet: false,
    volatility: 'v',
    parallel: 'u',
    isStrict: false,
    leakproof: false,
    argumentCount: 10,
    defaultArgumentCount: 9,
    normalizedBodyPayloadBytes: 1431,
    normalizedBodySha256:
      'cb43d26f1df8eb76c1bf7451eccbbb007538928c8de73bbcbe00321d252182fc'
  },
  preReconciliationAcl: {
    directOwnerGrantedNonGrantableExecuteGrantees: ['PUBLIC', 'authenticated'],
    effectiveRuntimeExecuteRoles: ['anon', 'authenticated', 'service_role']
  },
  strictPostRemediationAcl: {
    directOwnerGrantedNonGrantableExecuteGrantees: ['authenticated'],
    effectiveRuntimeExecuteRoles: ['authenticated'],
    deniedRuntimeExecuteRoles: ['anon', 'service_role']
  }
};

export const REPOSITORY_DERIVED_CLINICAL_TREATMENT_SESSION_ACL_MANIFEST =
  Object.freeze({
    ...repositoryDerivedClinicalTreatmentSessionAclPayload,
    sha256: createHash('sha256')
      .update(JSON.stringify(repositoryDerivedClinicalTreatmentSessionAclPayload))
      .digest('hex')
  });

const requiredRelations = [
  'public.profiles',
  'public.audit_logs',
  'public.patients',
  'public.products',
  'public.inventory_lots',
  'public.encounters',
  'public.payments',
  'public.production_orders',
  'public.pharmacy_counter_sales',
  'public.approval_tasks',
  'public.clinical_examination_findings',
  'public.clinic_appointments',
  'public.sen_line_master',
  'public.ttm_diagnostic_knowledge',
  'public.ttm_opd_histories',
  'public.clinical_record_audit_events',
  'public.ttm_sources',
  'public.clinics',
  'public.clinic_memberships',
  'public.patient_user_links',
  'public.practitioner_schedules',
  'public.appointment_events',
  'public.patient_identity_links',
  'public.backup_export_runs',
  'public.approval_actions',
  'public.line_oa_contacts',
  'public.line_oa_notification_preferences',
  'public.line_oa_webhook_events',
  'public.line_oa_notification_outbox',
  'public.line_oa_delivery_events',
  'public.line_oa_gateway_contact_states',
  'public.line_oa_gateway_webhook_events',
  'public.clinic_subscription_control_events',
  'public.clinic_drive_backup_destinations',
  'public.clinic_drive_destination_events',
  'public.owner_control_historical_replay_guard',
  'public.user_access_summary',
  'public.admin_task_summary',
  'public.v_clinical_herbal_traceability',
  'public.available_practitioner_schedules',
  'public.v_ttm_foundation_graph'
];

const requiredFunctions = [
  'has_role',
  'dispense_pharmacy_counter_sale',
  'current_access_context',
  'save_ttm_diagnosis_atomic',
  'create_clinical_treatment_session',
  'sign_clinical_record_complete',
  'unlock_clinical_record_for_amendment',
  'hybrid_patient_identity_healthcheck',
  'clinical_financial_handoffs_healthcheck',
  'department_persistence_healthcheck',
  'production_execution_healthcheck',
  'quality_release_healthcheck',
  'clinical_outcomes_summary',
  'prescription_dispensing_healthcheck',
  'backup_restore_contract_healthcheck',
  'export_clinic_backup_domain',
  'export_clinic_backup_domain_v20260831',
  'export_clinic_backup_domain_v20260829',
  'export_clinic_backup_domain_v20260828',
  'verify_clinic_restore_trace',
  'verify_clinic_restore_trace_v20260831',
  'verify_clinic_restore_trace_v20260829',
  'verify_clinic_restore_trace_v20260828',
  'begin_backup_export_run',
  'get_exact_backup_restore_source',
  'line_oa_operational_healthcheck',
  'finalize_line_oa_webhook_event',
  'line_oa_webhook_evidence',
  'list_owner_subscription_clinics',
  'set_clinic_subscription_state',
  'set_clinic_subscription_state_v20260901',
  'guard_owner_subscription_forward_only',
  'reject_append_only_mutation',
  'assert_clinic_subscription_active',
  'prepare_line_subscription_off_exception',
  'enforce_active_subscription_tenant_write',
  'enforce_authenticated_subscription_statement_write',
  'is_clinic_admin',
  'is_reception_or_admin',
  'is_practitioner',
  'is_appointment_operator',
  'is_appointment_practitioner',
  'book_clinic_appointment',
  'cancel_clinic_appointment',
  'set_clinic_appointment_status',
  'is_admin_or_super',
  'current_user_role',
  'create_approval_task',
  'decide_approval_task',
  'consume_patient_identity_rate_limit_for_clinic',
  'complete_patient_line_link_for_clinic',
  'list_line_linked_patients_for_clinic',
  'issue_patient_qr_for_subject_in_clinic',
  'queue_line_oa_appointment_notification',
  'set_line_oa_notification_preference_for_subject',
  'complete_patient_line_link_with_oa_consent',
  'list_line_oa_notification_preferences_for_subject',
  'claim_line_oa_webhook_event',
  'finish_line_oa_webhook_event',
  'claim_line_oa_notification_batch',
  'finish_line_oa_notification',
  'register_line_oa_webhook_event_for_clinic',
  'line_oa_queue_notification_v20260829',
  'line_oa_set_preference_v20260829',
  'line_oa_complete_link_consent_v20260829',
  'line_oa_list_preferences_v20260829',
  'line_oa_claim_webhook_v20260829',
  'line_oa_finish_webhook_v20260829',
  'line_oa_claim_batch_v20260829',
  'line_oa_finish_notification_v20260829',
  'line_oa_register_gateway_v20260829',
  'list_owner_drive_assignments',
  'get_clinic_drive_backup_destination',
  'set_clinic_drive_assignment'
];

const requiredSecurityDefiners = [
  'save_ttm_diagnosis_atomic',
  'backup_restore_contract_healthcheck',
  'export_clinic_backup_domain',
  'export_clinic_backup_domain_v20260831',
  'export_clinic_backup_domain_v20260829',
  'export_clinic_backup_domain_v20260828',
  'verify_clinic_restore_trace',
  'verify_clinic_restore_trace_v20260831',
  'verify_clinic_restore_trace_v20260829',
  'verify_clinic_restore_trace_v20260828',
  'begin_backup_export_run',
  'get_exact_backup_restore_source',
  'line_oa_operational_healthcheck',
  'finalize_line_oa_webhook_event',
  'line_oa_webhook_evidence',
  'list_owner_subscription_clinics',
  'set_clinic_subscription_state',
  'set_clinic_subscription_state_v20260901',
  'guard_owner_subscription_forward_only',
  'reject_append_only_mutation',
  'assert_clinic_subscription_active',
  'prepare_line_subscription_off_exception',
  'enforce_active_subscription_tenant_write',
  'enforce_authenticated_subscription_statement_write',
  'is_clinic_admin',
  'is_reception_or_admin',
  'is_practitioner',
  'is_appointment_operator',
  'is_appointment_practitioner',
  'book_clinic_appointment',
  'cancel_clinic_appointment',
  'set_clinic_appointment_status',
  'is_admin_or_super',
  'current_user_role',
  'create_approval_task',
  'decide_approval_task',
  'sign_clinical_record_complete',
  'unlock_clinical_record_for_amendment',
  'clinical_financial_handoffs_healthcheck',
  'department_persistence_healthcheck',
  'production_execution_healthcheck',
  'quality_release_healthcheck',
  'prescription_dispensing_healthcheck',
  'consume_patient_identity_rate_limit_for_clinic',
  'complete_patient_line_link_for_clinic',
  'list_line_linked_patients_for_clinic',
  'issue_patient_qr_for_subject_in_clinic',
  'queue_line_oa_appointment_notification',
  'set_line_oa_notification_preference_for_subject',
  'complete_patient_line_link_with_oa_consent',
  'list_line_oa_notification_preferences_for_subject',
  'claim_line_oa_webhook_event',
  'finish_line_oa_webhook_event',
  'claim_line_oa_notification_batch',
  'finish_line_oa_notification',
  'register_line_oa_webhook_event_for_clinic',
  'line_oa_queue_notification_v20260829',
  'line_oa_set_preference_v20260829',
  'line_oa_complete_link_consent_v20260829',
  'line_oa_list_preferences_v20260829',
  'line_oa_claim_webhook_v20260829',
  'line_oa_finish_webhook_v20260829',
  'line_oa_claim_batch_v20260829',
  'line_oa_finish_notification_v20260829',
  'line_oa_register_gateway_v20260829',
  'list_owner_drive_assignments',
  'get_clinic_drive_backup_destination',
  'set_clinic_drive_assignment'
];

const requiredSecurityDefinerProcedures = [
  'public.backup_restore_contract_healthcheck()',
  'public.export_clinic_backup_domain(uuid,text)',
  'public.export_clinic_backup_domain_v20260831(uuid,text)',
  'public.export_clinic_backup_domain_v20260829(uuid,text)',
  'public.export_clinic_backup_domain_v20260828(uuid,text)',
  'public.verify_clinic_restore_trace(uuid)',
  'public.verify_clinic_restore_trace_v20260831(uuid)',
  'public.verify_clinic_restore_trace_v20260829(uuid)',
  'public.verify_clinic_restore_trace_v20260828(uuid)',
  'public.begin_backup_export_run(uuid,timestamptz,text)',
  'public.get_exact_backup_restore_source(text,timestamptz,text)',
  'public.line_oa_operational_healthcheck()',
  'public.finalize_line_oa_webhook_event(text,text,text,text,text)',
  'public.line_oa_webhook_evidence(timestamptz)',
  'public.list_owner_subscription_clinics()',
  'public.set_clinic_subscription_state(uuid,uuid,text,boolean,bigint,text,uuid,text)',
  'public.set_clinic_subscription_state_v20260901(uuid,uuid,text,boolean,bigint,text,uuid,text)',
  'public.guard_owner_subscription_forward_only()',
  'public.reject_append_only_mutation()',
  'public.assert_clinic_subscription_active(uuid)',
  'public.prepare_line_subscription_off_exception(uuid,text)',
  'public.enforce_active_subscription_tenant_write()',
  'public.enforce_authenticated_subscription_statement_write()',
  'public.is_clinic_admin()',
  'public.is_reception_or_admin()',
  'public.is_practitioner()',
  'public.is_appointment_operator()',
  'public.is_appointment_practitioner()',
  'public.book_clinic_appointment(uuid,uuid,text,text,text)',
  'public.cancel_clinic_appointment(uuid,text)',
  'public.set_clinic_appointment_status(uuid,text,text)',
  'public.is_admin_or_super()',
  'public.current_user_role()',
  'public.create_approval_task(text,text,text,text,text,text,uuid,timestamptz,jsonb)',
  'public.decide_approval_task(uuid,text,text)',
  'public.sign_clinical_record_complete(uuid,text,text,text)',
  'public.unlock_clinical_record_for_amendment(uuid,text)',
  'public.consume_patient_identity_rate_limit_for_clinic(uuid,text,integer,integer)',
  'public.complete_patient_line_link_for_clinic(uuid,text,text,text,boolean)',
  'public.list_line_linked_patients_for_clinic(uuid,text)',
  'public.issue_patient_qr_for_subject_in_clinic(uuid,text,uuid,text,text,timestamptz)',
  'public.queue_line_oa_appointment_notification(uuid,text,timestamptz,timestamptz,text)',
  'public.set_line_oa_notification_preference_for_subject(text,uuid,uuid,text,text,text,boolean)',
  'public.complete_patient_line_link_with_oa_consent(text,text,text,boolean,uuid,text,text,text)',
  'public.list_line_oa_notification_preferences_for_subject(text,uuid,text,text,text)',
  'public.claim_line_oa_webhook_event(uuid,text,text,text,text,text,timestamptz,boolean,text,text,text,text,text,text,text,jsonb)',
  'public.finish_line_oa_webhook_event(uuid,text,text,text,text,text,text,boolean)',
  'public.claim_line_oa_notification_batch(uuid,text,text,text,text,integer)',
  'public.finish_line_oa_notification(uuid,text,text,integer,text,text)',
  'public.register_line_oa_webhook_event_for_clinic(uuid,text,text,text,text,text,timestamptz,boolean,text)',
  'public.line_oa_queue_notification_v20260829(uuid,text,timestamptz,timestamptz,text)',
  'public.line_oa_set_preference_v20260829(text,uuid,uuid,text,text,text,boolean)',
  'public.line_oa_complete_link_consent_v20260829(text,text,text,boolean,uuid,text,text,text)',
  'public.line_oa_list_preferences_v20260829(text,uuid,text,text,text)',
  'public.line_oa_claim_webhook_v20260829(uuid,text,text,text,text,text,timestamptz,boolean,text,text,text,text,text,text,text,jsonb)',
  'public.line_oa_finish_webhook_v20260829(uuid,text,text,text,text,text,text,boolean)',
  'public.line_oa_claim_batch_v20260829(uuid,text,text,text,text,integer)',
  'public.line_oa_finish_notification_v20260829(uuid,text,text,integer,text,text)',
  'public.line_oa_register_gateway_v20260829(text,text,text,text,text,timestamptz,boolean,text)',
  'public.list_owner_drive_assignments()',
  'public.get_clinic_drive_backup_destination(uuid,text)',
  'public.set_clinic_drive_assignment(uuid,uuid,text,text,text,text,text,text,text,bigint,text,uuid,text)'
];

const requiredProcedures = [
  createClinicalTreatmentSessionSignature,
  ...requiredSecurityDefinerProcedures
];

const requiredRlsRelations = [
  'public.patient_user_links',
  'public.practitioner_schedules',
  'public.clinic_appointments',
  'public.appointment_events',
  'public.approval_tasks',
  'public.approval_actions',
  'public.clinic_drive_backup_destinations',
  'public.clinic_drive_destination_events',
  'public.owner_control_historical_replay_guard'
];

const requiredTenantPolicies = [
  [
    'public.practitioner_schedules', 'practitioner_schedules_read', 'r',
    "((clinic_id=current_clinic_id())and((booking_status='open'::text)or(practitioner_id=auth.uid())oris_reception_or_admin()))",
    ''
  ],
  [
    'public.practitioner_schedules', 'practitioner_schedules_manage_own', '*',
    '((clinic_id=current_clinic_id())and((practitioner_id=auth.uid())oris_clinic_admin()))',
    '((clinic_id=current_clinic_id())and((practitioner_id=auth.uid())oris_clinic_admin()))'
  ],
  [
    'public.patient_user_links', 'patient_user_links_own', 'r',
    '((exists(select1frompatientspwhere((p.id=patient_user_links.patient_id)and(p.clinic_id=current_clinic_id()))))and((user_id=auth.uid())oris_clinic_admin()))',
    ''
  ],
  [
    'public.patient_user_links', 'patient_user_links_manage', '*',
    '(is_clinic_admin()and(exists(select1frompatientspwhere((p.id=patient_user_links.patient_id)and(p.clinic_id=current_clinic_id())))))',
    '(is_clinic_admin()and(exists(select1frompatientspwhere((p.id=patient_user_links.patient_id)and(p.clinic_id=current_clinic_id())))))'
  ],
  [
    'public.clinic_appointments', 'clinic_appointments_staff_read', 'r',
    '((clinic_id=current_clinic_id())and(is_reception_or_admin()or(practitioner_id=auth.uid())or(exists(select1frompatient_user_linkslwhere((l.patient_id=clinic_appointments.patient_id)and(l.user_id=auth.uid())andl.active)))))',
    ''
  ],
  [
    'public.appointment_events', 'appointment_events_read', 'r',
    '((clinic_id=current_clinic_id())and(is_clinic_admin()or(exists(select1fromclinic_appointmentsawhere((a.id=appointment_events.appointment_id)and(a.clinic_id=appointment_events.clinic_id)and(a.practitioner_id=auth.uid()))))))',
    ''
  ],
  [
    'public.approval_tasks', 'approval_tasks_read_participant', 'r',
    '((clinic_id=current_clinic_id())and(is_admin_or_super()or(requested_by=auth.uid())or(assigned_to=auth.uid())))',
    ''
  ],
  [
    'public.approval_actions', 'approval_actions_read_participant', 'r',
    '((clinic_id=current_clinic_id())and(is_admin_or_super()or(exists(select1fromapproval_taskstwhere((t.id=approval_actions.task_id)and(t.clinic_id=approval_actions.clinic_id)and((t.requested_by=auth.uid())or(t.assigned_to=auth.uid())))))))',
    ''
  ]
];

const requiredForceRlsRelations = [
  'public.owner_control_historical_replay_guard'
];

const ownerDriveClosedRelations = [
  'public.clinic_drive_backup_destinations',
  'public.clinic_drive_destination_events'
];

const ownerReplayGuardClosedRelations = [
  'public.owner_control_historical_replay_guard'
];

const requiredAppendOnlyTriggers = [
  [
    'public.appointment_events',
    'trg_appointment_events_append_only'
  ],
  [
    'public.approval_actions',
    'trg_approval_actions_append_only'
  ],
  [
    'public.clinic_drive_destination_events',
    'trg_clinic_drive_destination_events_append_only'
  ],
  [
    'public.clinic_subscription_control_events',
    'trg_clinic_subscription_control_events_append_only'
  ]
];

const ownerDriveServiceRoleOnlyProcedures = [
  'public.list_owner_drive_assignments()',
  'public.get_clinic_drive_backup_destination(uuid,text)',
  'public.set_clinic_drive_assignment(uuid,uuid,text,text,text,text,text,text,text,bigint,text,uuid,text)'
];

const ownerSubscriptionServiceRoleOnlyProcedures = [
  'public.list_owner_subscription_clinics()',
  'public.set_clinic_subscription_state(uuid,uuid,text,boolean,bigint,text,uuid,text)'
];

const ownerSubscriptionClosedProcedures = [
  'public.set_clinic_subscription_state_v20260901(uuid,uuid,text,boolean,bigint,text,uuid,text)',
  'public.guard_owner_subscription_forward_only()'
];

const appendOnlyClosedProcedures = [
  'public.reject_append_only_mutation()'
];

const backupRestoreServiceRoleOnlyProcedures = [
  'public.export_clinic_backup_domain(uuid,text)',
  'public.verify_clinic_restore_trace(uuid)',
  'public.begin_backup_export_run(uuid,timestamptz,text)',
  'public.get_exact_backup_restore_source(text,timestamptz,text)'
];

const backupArchiveClosedProcedures = [
  'public.export_clinic_backup_domain_v20260831(uuid,text)',
  'public.export_clinic_backup_domain_v20260829(uuid,text)',
  'public.export_clinic_backup_domain_v20260828(uuid,text)',
  'public.verify_clinic_restore_trace_v20260831(uuid)',
  'public.verify_clinic_restore_trace_v20260829(uuid)',
  'public.verify_clinic_restore_trace_v20260828(uuid)'
];

const lineGatewayServiceRoleOnlyProcedures = [
  'public.finalize_line_oa_webhook_event(text,text,text,text,text)',
  'public.line_oa_webhook_evidence(timestamptz)'
];

const lineGatewayExactBodyContracts = [
  [
    'public.finalize_line_oa_webhook_event(text,text,text,text,text)',
    `begin if auth.role() is distinct from 'service_role' then raise exception 'service_role_required'; end if; if p_provider_channel_hash !~ '^[0-9a-f]{64}$' or p_event_id_hash !~ '^[0-9a-f]{64}$' or p_processing_status not in ('processed', 'ignored', 'failed') or p_reply_status not in ('sent', 'not_applicable', 'failed') or ( p_error_code is not null and p_error_code !~ '^[a-z][a-z0-9_]{2,80}$' ) then raise exception 'line_oa_finalization_invalid'; end if; update public.line_oa_gateway_webhook_events set processing_status = p_processing_status, reply_status = p_reply_status, error_code = p_error_code, processed_at = pg_catalog.now() where provider_channel_hash = p_provider_channel_hash and event_id_hash = p_event_id_hash and processing_status = 'processing'; return found; end;`
  ],
  [
    'public.line_oa_webhook_evidence(timestamptz)',
    `begin if auth.role() is distinct from 'service_role' then raise exception 'service_role_required'; end if; return query select pg_catalog.count(*)::bigint, pg_catalog.count(*) filter ( where e.processing_status in ('processed', 'ignored') )::bigint, pg_catalog.count(*) filter ( where e.processing_status = 'failed' )::bigint, pg_catalog.count(*) filter ( where e.reply_status = 'sent' )::bigint, pg_catalog.max(e.created_at) from public.line_oa_gateway_webhook_events e where e.created_at >= greatest( coalesce(p_since, pg_catalog.now() - interval '1 hour'), pg_catalog.now() - interval '7 days' ); end;`
  ]
];

const lineOperationalHealthcheckProcedure = 'public.line_oa_operational_healthcheck()';
const lineOperationalHealthcheckExactBody = `select true, (select count(*) from public.line_oa_contacts c where c.clinic_id=public.current_clinic_id()), (select count(*) from public.line_oa_notification_preferences p where p.clinic_id=public.current_clinic_id() and p.operational_enabled), (select count(*) from public.line_oa_notification_outbox o where o.clinic_id=public.current_clinic_id() and o.status in ('pending','retry','sending')), (select count(*) from public.line_oa_notification_outbox o where o.clinic_id=public.current_clinic_id() and o.status='dead') where auth.role()='service_role' or public.is_super_admin();`;

const lineArchiveClosedProcedures = [
  'public.line_oa_queue_notification_v20260829(uuid,text,timestamptz,timestamptz,text)',
  'public.line_oa_set_preference_v20260829(text,uuid,uuid,text,text,text,boolean)',
  'public.line_oa_complete_link_consent_v20260829(text,text,text,boolean,uuid,text,text,text)',
  'public.line_oa_list_preferences_v20260829(text,uuid,text,text,text)',
  'public.line_oa_claim_webhook_v20260829(uuid,text,text,text,text,text,timestamptz,boolean,text,text,text,text,text,text,text,jsonb)',
  'public.line_oa_finish_webhook_v20260829(uuid,text,text,text,text,text,text,boolean)',
  'public.line_oa_claim_batch_v20260829(uuid,text,text,text,text,integer)',
  'public.line_oa_finish_notification_v20260829(uuid,text,text,integer,text,text)',
  'public.line_oa_register_gateway_v20260829(text,text,text,text,text,timestamptz,boolean,text)'
];

const archiveClosedProcedures = [
  ...backupArchiveClosedProcedures,
  ...lineArchiveClosedProcedures
];

const archiveOwnerPairs = [
  ['public.export_clinic_backup_domain_v20260831(uuid,text)', 'public.export_clinic_backup_domain(uuid,text)'],
  ['public.export_clinic_backup_domain_v20260829(uuid,text)', 'public.export_clinic_backup_domain(uuid,text)'],
  ['public.export_clinic_backup_domain_v20260828(uuid,text)', 'public.export_clinic_backup_domain(uuid,text)'],
  ['public.verify_clinic_restore_trace_v20260831(uuid)', 'public.verify_clinic_restore_trace(uuid)'],
  ['public.verify_clinic_restore_trace_v20260829(uuid)', 'public.verify_clinic_restore_trace(uuid)'],
  ['public.verify_clinic_restore_trace_v20260828(uuid)', 'public.verify_clinic_restore_trace(uuid)'],
  ['public.line_oa_queue_notification_v20260829(uuid,text,timestamptz,timestamptz,text)', 'public.queue_line_oa_appointment_notification(uuid,text,timestamptz,timestamptz,text)'],
  ['public.line_oa_set_preference_v20260829(text,uuid,uuid,text,text,text,boolean)', 'public.set_line_oa_notification_preference_for_subject(text,uuid,uuid,text,text,text,boolean)'],
  ['public.line_oa_complete_link_consent_v20260829(text,text,text,boolean,uuid,text,text,text)', 'public.complete_patient_line_link_with_oa_consent(text,text,text,boolean,uuid,text,text,text)'],
  ['public.line_oa_list_preferences_v20260829(text,uuid,text,text,text)', 'public.list_line_oa_notification_preferences_for_subject(text,uuid,text,text,text)'],
  ['public.line_oa_claim_webhook_v20260829(uuid,text,text,text,text,text,timestamptz,boolean,text,text,text,text,text,text,text,jsonb)', 'public.claim_line_oa_webhook_event(uuid,text,text,text,text,text,timestamptz,boolean,text,text,text,text,text,text,text,jsonb)'],
  ['public.line_oa_finish_webhook_v20260829(uuid,text,text,text,text,text,text,boolean)', 'public.finish_line_oa_webhook_event(uuid,text,text,text,text,text,text,boolean)'],
  ['public.line_oa_claim_batch_v20260829(uuid,text,text,text,text,integer)', 'public.claim_line_oa_notification_batch(uuid,text,text,text,text,integer)'],
  ['public.line_oa_finish_notification_v20260829(uuid,text,text,integer,text,text)', 'public.finish_line_oa_notification(uuid,text,text,integer,text,text)'],
  ['public.line_oa_register_gateway_v20260829(text,text,text,text,text,timestamptz,boolean,text)', 'public.register_line_oa_webhook_event_for_clinic(uuid,text,text,text,text,text,timestamptz,boolean,text)']
];

const subscriptionKillSwitchServiceRoleOnlyProcedures = [
  'public.assert_clinic_subscription_active(uuid)',
  'public.consume_patient_identity_rate_limit_for_clinic(uuid,text,integer,integer)',
  'public.complete_patient_line_link_for_clinic(uuid,text,text,text,boolean)',
  'public.list_line_linked_patients_for_clinic(uuid,text)',
  'public.issue_patient_qr_for_subject_in_clinic(uuid,text,uuid,text,text,timestamptz)',
  'public.set_line_oa_notification_preference_for_subject(text,uuid,uuid,text,text,text,boolean)',
  'public.complete_patient_line_link_with_oa_consent(text,text,text,boolean,uuid,text,text,text)',
  'public.list_line_oa_notification_preferences_for_subject(text,uuid,text,text,text)',
  'public.claim_line_oa_webhook_event(uuid,text,text,text,text,text,timestamptz,boolean,text,text,text,text,text,text,text,jsonb)',
  'public.finish_line_oa_webhook_event(uuid,text,text,text,text,text,text,boolean)',
  'public.claim_line_oa_notification_batch(uuid,text,text,text,text,integer)',
  'public.finish_line_oa_notification(uuid,text,text,integer,text,text)',
  'public.register_line_oa_webhook_event_for_clinic(uuid,text,text,text,text,text,timestamptz,boolean,text)'
];

const exactServiceRoleOnlyProcedures = [...new Set([
  ...ownerDriveServiceRoleOnlyProcedures,
  ...ownerSubscriptionServiceRoleOnlyProcedures,
  ...backupRestoreServiceRoleOnlyProcedures,
  ...lineGatewayServiceRoleOnlyProcedures,
  ...subscriptionKillSwitchServiceRoleOnlyProcedures
])];

const subscriptionKillSwitchAuthenticatedAndServiceProcedures = [
  'public.is_clinic_admin()',
  'public.is_reception_or_admin()',
  'public.is_practitioner()',
  'public.is_appointment_operator()',
  'public.is_appointment_practitioner()',
  'public.is_admin_or_super()',
  'public.current_user_role()',
  'public.clinical_financial_handoffs_healthcheck()',
  'public.department_persistence_healthcheck()',
  'public.production_execution_healthcheck()',
  'public.quality_release_healthcheck()',
  'public.prescription_dispensing_healthcheck()'
];

const subscriptionKillSwitchAuthenticatedOnlyProcedures = [
  'public.book_clinic_appointment(uuid,uuid,text,text,text)',
  'public.cancel_clinic_appointment(uuid,text)',
  'public.set_clinic_appointment_status(uuid,text,text)',
  'public.create_approval_task(text,text,text,text,text,text,uuid,timestamptz,jsonb)',
  'public.decide_approval_task(uuid,text,text)',
  'public.sign_clinical_record_complete(uuid,text,text,text)',
  'public.unlock_clinical_record_for_amendment(uuid,text)'
];

const subscriptionKillSwitchBrowserProcedures = [
  ...subscriptionKillSwitchAuthenticatedAndServiceProcedures,
  ...subscriptionKillSwitchAuthenticatedOnlyProcedures
];

const subscriptionKillSwitchBrowserProcedureGrants = [
  ...subscriptionKillSwitchBrowserProcedures.map(procedureSignature => [
    procedureSignature,
    'authenticated'
  ]),
  ...subscriptionKillSwitchAuthenticatedAndServiceProcedures.map(procedureSignature => [
    procedureSignature,
    'service_role'
  ])
];

// Exact callable SECURITY DEFINER inventory for the reviewed 45-migration
// chain. Trigger/event-trigger functions are intentionally excluded because
// PostgreSQL cannot invoke them as ordinary RPCs and fourteen historical trigger
// functions retain their default PUBLIC catalog ACL.
const callableSecurityDefinerAuthenticatedOnlyProcedures = [
  'public.admin_assign_staff_role(uuid,text,text)',
  'public.admin_set_staff_membership_active(uuid,boolean,text)',
  'public.book_clinic_appointment(uuid,uuid,text,text,text)',
  'public.cancel_clinic_appointment(uuid,text)',
  'public.clinical_outcomes_summary(timestamptz,timestamptz)',
  'public.confirm_patient_qr(uuid,boolean,text,jsonb)',
  'public.create_approval_task(text,text,text,text,text,text,uuid,timestamptz,jsonb)',
  'public.current_access_context()',
  'public.decide_approval_task(uuid,text,text)',
  'public.hybrid_patient_identity_healthcheck()',
  'public.issue_patient_line_link_code(uuid,text,text,boolean)',
  'public.list_patient_identity_links(uuid)',
  'public.resolve_patient_qr(text,text)',
  'public.revoke_patient_identity_link(uuid,text)',
  'public.search_clinical_outcomes(text,timestamptz,timestamptz,integer,integer)',
  'public.search_patients_for_checkin(text)',
  'public.set_clinic_appointment_status(uuid,text,text)',
  'public.sign_clinical_record_complete(uuid,text,text,text)',
  'public.start_manual_patient_encounter(uuid,text,boolean,text,text,jsonb)',
  'public.super_admin_set_system_role(uuid,text,text)',
  'public.unlock_clinical_record_for_amendment(uuid,text)',
  'public.upsert_patient_registration(uuid,text,text,text,text,text,date,text,text,text,text,text)'
];

const callableSecurityDefinerServiceRoleOnlyProcedures = [
  'public.assert_clinic_subscription_active(uuid)',
  'public.begin_backup_export_run(uuid,timestamptz,text)',
  'public.claim_line_oa_notification_batch(uuid,text,text,text,text,integer)',
  'public.claim_line_oa_webhook_event(uuid,text,text,text,text,text,timestamptz,boolean,text,text,text,text,text,text,text,jsonb)',
  'public.complete_backup_export_run(uuid,text,jsonb,jsonb,text)',
  'public.complete_patient_line_link_for_clinic(uuid,text,text,text,boolean)',
  'public.complete_patient_line_link_with_oa_consent(text,text,text,boolean,uuid,text,text,text)',
  'public.consume_patient_identity_rate_limit_for_clinic(uuid,text,integer,integer)',
  'public.export_clinic_backup_domain(uuid,text)',
  'public.finalize_line_oa_webhook_event(text,text,text,text,text)',
  'public.finish_line_oa_notification(uuid,text,text,integer,text,text)',
  'public.finish_line_oa_webhook_event(uuid,text,text,text,text,text,text,boolean)',
  'public.get_clinic_drive_backup_destination(uuid,text)',
  'public.get_exact_backup_restore_source(text,timestamptz,text)',
  'public.issue_patient_qr_for_subject_in_clinic(uuid,text,uuid,text,text,timestamptz)',
  'public.line_oa_webhook_evidence(timestamptz)',
  'public.list_backup_export_clinics()',
  'public.list_line_linked_patients_for_clinic(uuid,text)',
  'public.list_line_oa_notification_preferences_for_subject(text,uuid,text,text,text)',
  'public.list_owner_drive_assignments()',
  'public.list_owner_subscription_clinics()',
  'public.register_line_oa_webhook_event_for_clinic(uuid,text,text,text,text,text,timestamptz,boolean,text)',
  'public.reject_production_order(uuid,text,text)',
  'public.release_production_order(uuid,text,text,text,numeric,numeric,numeric)',
  'public.set_clinic_drive_assignment(uuid,uuid,text,text,text,text,text,text,text,bigint,text,uuid,text)',
  'public.set_clinic_subscription_state(uuid,uuid,text,boolean,bigint,text,uuid,text)',
  'public.set_line_oa_notification_preference_for_subject(text,uuid,uuid,text,text,text,boolean)',
  'public.verify_clinic_restore_trace(uuid)'
];

const callableSecurityDefinerAuthenticatedAndServiceProcedures = [
  'public.backup_restore_contract_healthcheck()',
  'public.can_access_encounter(uuid)',
  'public.can_access_invoice(uuid)',
  'public.can_access_patient(uuid)',
  'public.can_access_prescription(uuid)',
  'public.clinical_financial_handoffs_healthcheck()',
  'public.commit_production_import(uuid)',
  'public.complete_production_order(uuid,numeric,numeric,numeric)',
  'public.create_atomic_prescription_handoff(uuid,uuid,text,jsonb)',
  'public.create_pharmacy_counter_sale(uuid,text,text,text,text,text,text,text,text)',
  'public.create_production_request(uuid,uuid,uuid,numeric,text,timestamptz,text,text)',
  'public.current_clinic_id()',
  'public.current_department_role()',
  'public.current_user_role()',
  'public.department_can(text)',
  'public.department_persistence_healthcheck()',
  'public.dispense_pharmacy_counter_sale(uuid)',
  'public.has_role(text[])',
  'public.is_admin_or_super()',
  'public.is_appointment_operator()',
  'public.is_appointment_practitioner()',
  'public.is_clinic_admin()',
  'public.is_clinic_member(uuid,text[])',
  'public.is_practitioner()',
  'public.is_reception_or_admin()',
  'public.is_super_admin()',
  'public.issue_atomic_dispensing_invoice(uuid,numeric,numeric)',
  'public.issue_production_materials_fefo(uuid)',
  'public.line_oa_operational_healthcheck()',
  'public.open_production_order(uuid,uuid,numeric)',
  'public.prescription_dispensing_healthcheck()',
  'public.production_execution_healthcheck()',
  'public.quality_reject_production_order(uuid,text,text)',
  'public.quality_release_healthcheck()',
  'public.quality_release_production_order(uuid,text,text,text,numeric,numeric,numeric)',
  'public.record_atomic_invoice_payment(uuid,uuid,numeric,text,text)',
  'public.remove_pharmacy_counter_sale_item(uuid)',
  'public.save_ttm_diagnosis_atomic(uuid,text,text,text,text,text,text,text,text[],text,text,text,text,text,text,text,text,text,text,text,text,boolean,text)',
  'public.set_product_master_active(uuid,boolean,text)',
  'public.stage_production_import(text,text,text,jsonb)',
  'public.transition_atomic_prescription_dispensing(uuid,text,jsonb,text)',
  'public.transition_pharmacy_counter_sale(uuid,text,text)',
  'public.upsert_pharmacy_counter_sale_item(uuid,uuid,uuid,numeric,numeric,text,text,text,text)',
  'public.upsert_product_master(uuid,text,text,text,text,text,text,text,text,numeric,numeric,numeric,numeric)',
  'public.upsert_production_formula(uuid,text,text,text,uuid,numeric,text,numeric,integer,text,text)',
  'public.upsert_production_formula_component(uuid,uuid,uuid,integer,numeric,text,text,text)',
  'public.upsert_supplier_master(uuid,text,text,text,text,text,text)'
];

const callableSecurityDefinerOwnerOnlyProcedures = [
  'public.apply_initial_encounter_intake(uuid,jsonb)',
  'public.complete_patient_line_link(text,text,text,boolean)',
  'public.consume_patient_identity_rate_limit(text,integer,integer)',
  'public.export_clinic_backup_domain_v20260828(uuid,text)',
  'public.export_clinic_backup_domain_v20260829(uuid,text)',
  'public.export_clinic_backup_domain_v20260831(uuid,text)',
  'public.issue_patient_qr_for_subject(text,uuid,text,text,timestamptz)',
  'public.line_oa_claim_batch_v20260829(uuid,text,text,text,text,integer)',
  'public.line_oa_claim_webhook_v20260829(uuid,text,text,text,text,text,timestamptz,boolean,text,text,text,text,text,text,text,jsonb)',
  'public.line_oa_complete_link_consent_v20260829(text,text,text,boolean,uuid,text,text,text)',
  'public.line_oa_finish_notification_v20260829(uuid,text,text,integer,text,text)',
  'public.line_oa_finish_webhook_v20260829(uuid,text,text,text,text,text,text,boolean)',
  'public.line_oa_list_preferences_v20260829(text,uuid,text,text,text)',
  'public.line_oa_queue_notification_v20260829(uuid,text,timestamptz,timestamptz,text)',
  'public.line_oa_register_gateway_v20260829(text,text,text,text,text,timestamptz,boolean,text)',
  'public.line_oa_set_preference_v20260829(text,uuid,uuid,text,text,text,boolean)',
  'public.list_line_linked_patients(text)',
  'public.next_clinic_counter(uuid,text)',
  'public.next_encounter_number()',
  'public.prepare_line_subscription_off_exception(uuid,text)',
  'public.queue_line_oa_appointment_notification(uuid,text,timestamptz,timestamptz,text)',
  'public.set_clinic_subscription_state_v20260901(uuid,uuid,text,boolean,bigint,text,uuid,text)',
  'public.verify_clinic_restore_trace_v20260828(uuid)',
  'public.verify_clinic_restore_trace_v20260829(uuid)',
  'public.verify_clinic_restore_trace_v20260831(uuid)',
];

const callableSecurityDefinerProcedures = [...new Set([
  ...callableSecurityDefinerAuthenticatedOnlyProcedures,
  ...callableSecurityDefinerServiceRoleOnlyProcedures,
  ...callableSecurityDefinerAuthenticatedAndServiceProcedures,
  ...callableSecurityDefinerOwnerOnlyProcedures
])];

const callableSecurityDefinerProcedureGrants = [
  ...callableSecurityDefinerAuthenticatedOnlyProcedures.map(procedureSignature => [
    procedureSignature,
    'authenticated'
  ]),
  ...callableSecurityDefinerServiceRoleOnlyProcedures.map(procedureSignature => [
    procedureSignature,
    'service_role'
  ]),
  ...callableSecurityDefinerAuthenticatedAndServiceProcedures.flatMap(procedureSignature => [
    [procedureSignature, 'authenticated'],
    [procedureSignature, 'service_role']
  ])
];

const authenticatedCrudRelations = [
  'public.body_pain_points',
  'public.clinical_examination_findings',
  'public.clinical_followup_notes',
  'public.clinical_treatment_plans',
  'public.clinical_treatment_sessions',
  'public.ttm_concept_terms',
  'public.ttm_diagnostic_contexts',
  'public.ttm_encounter_concepts',
  'public.ttm_opd_histories',
  'public.ttm_structured_diagnoses'
];

const authenticatedCrudServiceControlPlaneRelations = [
  'public.ttm_concept_relations',
  'public.ttm_concepts',
  'public.ttm_sources'
];

const authenticatedCrudServiceReadMaintainRelations = [
  'public.appointments',
  'public.barthel_assessments',
  'public.followups',
  'public.intermediate_care_assessments',
  'public.pain_assessments',
  'public.pain_markers',
  'public.price_list_items',
  'public.price_lists',
  'public.services',
  'public.treatment_orders',
  'public.treatment_sessions',
  'public.vital_signs'
];

const authenticatedReadOnlyRelations = [
  'public.admin_task_summary',
  'public.appointment_events',
  'public.approval_actions',
  'public.approval_tasks',
  'public.available_practitioner_schedules',
  'public.clinic_appointments',
  'public.clinic_specialties',
  'public.clinical_record_audit_events',
  'public.clinics',
  'public.encounter_identity_verifications',
  'public.finished_goods_receipts',
  'public.formula_components',
  'public.formulas',
  'public.import_batches',
  'public.import_rows',
  'public.patient_identity_events',
  'public.patient_user_links',
  'public.pharmacy_counter_allocations',
  'public.pharmacy_counter_sale_items',
  'public.pharmacy_counter_sales',
  'public.practitioner_schedules',
  'public.practitioner_specialties',
  'public.production_material_issues',
  'public.production_orders',
  'public.production_qc',
  'public.production_requests',
  'public.user_access_summary',
  'public.v_clinical_herbal_traceability',
  'public.v_ttm_foundation_coverage',
  'public.v_ttm_foundation_graph'
];

const authenticatedReadServiceReadMaintainRelations = [
  'public.backup_export_runs',
  'public.dispensing_items',
  'public.dispensing_orders',
  'public.encounters',
  'public.invoice_items',
  'public.invoices',
  'public.patient_allergies',
  'public.patients',
  'public.payments',
  'public.prescription_items',
  'public.prescriptions',
  'public.products',
  'public.stock_movements',
  'public.suppliers'
];

const exactPublicRelationAclGrants = [
  ...authenticatedCrudRelations.flatMap(relationName =>
    ['DELETE','INSERT','SELECT','UPDATE'].map(privilege => [relationName,'authenticated',privilege])
  ),
  ...authenticatedCrudServiceControlPlaneRelations.flatMap(relationName => [
    ...['DELETE','INSERT','SELECT','UPDATE'].map(privilege => [relationName,'authenticated',privilege]),
    ...['INSERT','SELECT','UPDATE'].map(privilege => [relationName,'service_role',privilege])
  ]),
  ...authenticatedCrudServiceReadMaintainRelations.flatMap(relationName => [
    ...['DELETE','INSERT','SELECT','UPDATE'].map(privilege => [relationName,'authenticated',privilege]),
    ...['MAINTAIN','SELECT'].map(privilege => [relationName,'service_role',privilege])
  ]),
  ...['DELETE','INSERT','SELECT','UPDATE'].map(privilege => [
    'public.sen_line_master','authenticated',privilege
  ]),
  ['public.sen_line_master','service_role','SELECT'],
  ...['INSERT','SELECT','UPDATE'].map(privilege => [
    'public.clinical_record_signoffs','authenticated',privilege
  ]),
  ...authenticatedReadOnlyRelations.map(relationName => [
    relationName,'authenticated','SELECT'
  ]),
  ['public.inventory_lots','authenticated','SELECT'],
  ...['INSERT','MAINTAIN','SELECT'].map(privilege => [
    'public.inventory_lots','service_role',privilege
  ]),
  ['public.audit_logs','authenticated','SELECT'],
  ...['INSERT','SELECT'].map(privilege => ['public.audit_logs','service_role',privilege]),
  ...['public.clinic_memberships','public.profiles','public.ttm_diagnostic_knowledge'].flatMap(
    relationName => [
      [relationName,'authenticated','SELECT'],
      ...['INSERT','SELECT','UPDATE'].map(privilege => [relationName,'service_role',privilege])
    ]
  ),
  ...authenticatedReadServiceReadMaintainRelations.flatMap(relationName => [
    [relationName,'authenticated','SELECT'],
    ...['MAINTAIN','SELECT'].map(privilege => [relationName,'service_role',privilege])
  ]),
  ['public.clinic_subscription_control_events','service_role','SELECT'],
  ['public.patient_qr_sessions','service_role','SELECT'],
  ['public.patient_qr_sessions','service_role','UPDATE']
];

const exactPublicSequenceAclGrants = [
  ['public.audit_logs_id_seq','authenticated','SELECT'],
  ['public.audit_logs_id_seq','authenticated','USAGE'],
  ['public.audit_logs_id_seq','service_role','USAGE']
];

const publicViewRelations = new Set([
  'public.admin_task_summary',
  'public.available_practitioner_schedules',
  'public.user_access_summary',
  'public.v_clinical_herbal_traceability',
  'public.v_ttm_foundation_coverage',
  'public.v_ttm_foundation_graph'
]);

const exactPublicRelationAndSequenceAclTuples = [
  ...exactPublicRelationAclGrants.map(([relationName,grantee,privilege]) => [
    relationName,
    publicViewRelations.has(relationName) ? 'v' : 'r',
    grantee,
    privilege
  ]),
  ...exactPublicSequenceAclGrants.map(([relationName,grantee,privilege]) => [
    relationName,
    'S',
    grantee,
    privilege
  ])
];

const expectedRuntimeRoleSecurityAttributes = [
  // role, superuser, create-role, create-db, login, replication, bypass-RLS
  ['anon',false,false,false,false,false,false],
  ['authenticated',false,false,false,false,false,false],
  ['service_role',false,false,false,false,false,true],
  ['authenticator',false,false,false,true,false,false]
];

const runtimeJwtRoles = ['anon','authenticated','service_role'];

const exactPublicSchemaAclGrants = [
  ['PUBLIC','USAGE'],
  ['authenticated','USAGE'],
  ['service_role','USAGE']
];

if (callableSecurityDefinerProcedures.length !== 122 ||
    callableSecurityDefinerProcedureGrants.length !== 144 ||
    exactPublicRelationAclGrants.length !== 235 ||
    exactPublicSequenceAclGrants.length !== 3 ||
    exactPublicRelationAndSequenceAclTuples.length !== 238) {
  throw new Error('Reviewed public ACL inventory cardinality changed');
}

const subscriptionKillSwitchClosedProcedures = [
  'public.prepare_line_subscription_off_exception(uuid,text)',
  'public.enforce_active_subscription_tenant_write()',
  'public.enforce_authenticated_subscription_statement_write()',
  'public.queue_line_oa_appointment_notification(uuid,text,timestamptz,timestamptz,text)',
  'public.consume_patient_identity_rate_limit(text,integer,integer)',
  'public.complete_patient_line_link(text,text,text,boolean)',
  'public.list_line_linked_patients(text)',
  'public.issue_patient_qr_for_subject(text,uuid,text,text,timestamptz)',
  'public.line_oa_queue_notification_v20260829(uuid,text,timestamptz,timestamptz,text)',
  'public.line_oa_set_preference_v20260829(text,uuid,uuid,text,text,text,boolean)',
  'public.line_oa_complete_link_consent_v20260829(text,text,text,boolean,uuid,text,text,text)',
  'public.line_oa_list_preferences_v20260829(text,uuid,text,text,text)',
  'public.line_oa_claim_webhook_v20260829(uuid,text,text,text,text,text,timestamptz,boolean,text,text,text,text,text,text,text,jsonb)',
  'public.line_oa_finish_webhook_v20260829(uuid,text,text,text,text,text,text,boolean)',
  'public.line_oa_claim_batch_v20260829(uuid,text,text,text,text,integer)',
  'public.line_oa_finish_notification_v20260829(uuid,text,text,integer,text,text)',
  'public.line_oa_register_gateway_v20260829(text,text,text,text,text,timestamptz,boolean,text)'
];

const sensitiveClosedProcedures = [...new Set([
  ...appendOnlyClosedProcedures,
  ...ownerSubscriptionClosedProcedures,
  ...subscriptionKillSwitchClosedProcedures,
  ...archiveClosedProcedures
])];

const sensitiveOwnedProcedures = [...new Set([
  ...sensitiveClosedProcedures,
  ...exactServiceRoleOnlyProcedures,
  lineOperationalHealthcheckProcedure
])];

const sensitiveClosedRelations = [...new Set([
  ...ownerDriveClosedRelations,
  ...ownerReplayGuardClosedRelations
])];

const subscriptionKillSwitchHardenedProcedures = [...new Set([
  ...subscriptionKillSwitchServiceRoleOnlyProcedures,
  ...subscriptionKillSwitchBrowserProcedures,
  'public.prepare_line_subscription_off_exception(uuid,text)',
  'public.enforce_active_subscription_tenant_write()',
  'public.enforce_authenticated_subscription_statement_write()',
  'public.queue_line_oa_appointment_notification(uuid,text,timestamptz,timestamptz,text)'
])];

const hardenedSearchPathProcedures = [...new Set([
  ...ownerDriveServiceRoleOnlyProcedures,
  ...backupRestoreServiceRoleOnlyProcedures,
  ...archiveClosedProcedures,
  ...lineGatewayServiceRoleOnlyProcedures,
  ...subscriptionKillSwitchHardenedProcedures,
  'public.backup_restore_contract_healthcheck()',
  ...ownerSubscriptionServiceRoleOnlyProcedures,
  ...ownerSubscriptionClosedProcedures
])];

const activeSubscriptionWriteRelations = [
  'public.clinic_memberships',
  'public.audit_logs',
  'public.inventory_lots',
  'public.practitioner_schedules',
  'public.clinic_appointments',
  'public.appointment_events',
  'public.approval_tasks',
  'public.approval_actions',
  'public.patient_identity_link_requests',
  'public.patient_identity_links',
  'public.patient_qr_sessions',
  'public.patient_identity_events',
  'public.line_oa_contacts',
  'public.line_oa_notification_preferences',
  'public.line_oa_webhook_events',
  'public.line_oa_notification_outbox',
  'public.line_oa_delivery_events'
];

const serviceRoleDmlWithoutSubscriptionGuardAllowlist = [
  'public.profiles',
  'public.ttm_sources',
  'public.ttm_concepts',
  'public.ttm_concept_relations',
  'public.ttm_diagnostic_knowledge'
];

const exactServiceRoleDmlPrivileges = [
  ['public.audit_logs', 'INSERT'],
  ['public.clinic_memberships', 'INSERT'],
  ['public.clinic_memberships', 'UPDATE'],
  ['public.inventory_lots', 'INSERT'],
  ['public.patient_qr_sessions', 'UPDATE'],
  ['public.profiles', 'INSERT'],
  ['public.profiles', 'UPDATE'],
  ['public.ttm_sources', 'INSERT'],
  ['public.ttm_sources', 'UPDATE'],
  ['public.ttm_concepts', 'INSERT'],
  ['public.ttm_concepts', 'UPDATE'],
  ['public.ttm_concept_relations', 'INSERT'],
  ['public.ttm_concept_relations', 'UPDATE'],
  ['public.ttm_diagnostic_knowledge', 'INSERT'],
  ['public.ttm_diagnostic_knowledge', 'UPDATE']
];

const requiredNotNullUuidColumns = [
  'practitioner_schedules.clinic_id',
  'clinic_appointments.clinic_id',
  'appointment_events.clinic_id',
  'approval_tasks.clinic_id',
  'approval_actions.clinic_id'
];

const requiredTenantForeignKeys = [
  [
    'public.practitioner_schedules', 'practitioner_schedules_clinic_id_fkey',
    'public.clinics', 'clinic_id', 'id', 'r'
  ],
  [
    'public.clinic_appointments', 'clinic_appointments_schedule_clinic_fkey',
    'public.practitioner_schedules', 'schedule_id,clinic_id', 'id,clinic_id', 'r'
  ],
  [
    'public.clinic_appointments', 'clinic_appointments_patient_clinic_fkey',
    'public.patients', 'patient_id,clinic_id', 'id,clinic_id', 'r'
  ],
  [
    'public.appointment_events', 'appointment_events_appointment_clinic_fkey',
    'public.clinic_appointments', 'appointment_id,clinic_id', 'id,clinic_id', 'c'
  ],
  [
    'public.approval_tasks', 'approval_tasks_clinic_id_fkey',
    'public.clinics', 'clinic_id', 'id', 'r'
  ],
  [
    'public.approval_actions', 'approval_actions_task_clinic_fkey',
    'public.approval_tasks', 'task_id,clinic_id', 'id,clinic_id', 'c'
  ]
];

const requiredColumns = [
  'body_pain_points.side',
  'body_pain_points.body_region',
  'body_pain_points.sen_line_code',
  'body_pain_points.point_label',
  'body_pain_points.pain_pattern_code',
  'body_pain_points.updated_at',
  'profiles.system_role',
  'patients.clinic_id',
  'encounters.clinic_id',
  'products.clinic_id',
  'inventory_lots.clinic_id',
  'line_oa_webhook_events.locked_until',
  'line_oa_notification_outbox.next_attempt_at',
  'line_oa_gateway_webhook_events.last_attempt_at',
  'clinics.subscription_state',
  'clinics.subscription_version',
  'clinic_subscription_control_events.expected_version',
  'practitioner_schedules.clinic_id',
  'clinic_appointments.clinic_id',
  'appointment_events.clinic_id',
  'approval_tasks.clinic_id',
  'approval_actions.clinic_id',
  'clinic_drive_backup_destinations.environment',
  'clinic_drive_backup_destinations.patients_folder_id',
  'clinic_drive_backup_destinations.products_folder_id',
  'clinic_drive_backup_destinations.pharmacy_folder_id',
  'clinic_drive_backup_destinations.transactions_folder_id',
  'clinic_drive_backup_destinations.manifests_folder_id',
  'clinic_drive_backup_destinations.version',
  'clinic_drive_destination_events.request_id',
  'clinic_drive_destination_events.assignment_version',
  'clinic_drive_destination_events.previous_assignment',
  'clinic_drive_destination_events.new_assignment',
  'owner_control_historical_replay_guard.protected_migration',
  'owner_control_historical_replay_guard.historical_sha256'
];

const lineOffExceptionCleanupFingerprint = [
  'exception when others then',
  "perform pg_catalog.set_config('cnyos.subscription_off_exception','',true);",
  "perform pg_catalog.set_config('cnyos.subscription_off_exception_clinic','',true);",
  'raise;',
  'end;',
  "perform pg_catalog.set_config('cnyos.subscription_off_exception','',true);",
  "perform pg_catalog.set_config('cnyos.subscription_off_exception_clinic','',true);"
].join(' ');

const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const sqlArray = values => `array[${values.map(quote).join(',')}]::text[]`;
const sqlRows = rows => rows.map(row => `(${row.map(quote).join(',')})`).join(',');
const canonicalCatalogOutputGucSql = [
  "set local timezone = 'UTC';",
  "set local datestyle = 'ISO, YMD';",
  "set local intervalstyle = 'postgres';",
  'set local extra_float_digits = 3;',
  "set local bytea_output = 'hex';",
  'set local quote_all_identifiers = off;',
  'set local standard_conforming_strings = on;'
].join('\n') + '\n';
const migrationManifestSha256 = entries => createHash('sha256')
  .update(entries.map(({ version, name, sha256 }) =>
    `${version}\t${name}\t${sha256}`).join('\n') + '\n')
  .digest('hex');

const triggerScopePredicateSql = ({
  triggerAlias,
  relationAlias,
  relationNamespaceAlias,
  functionNamespaceAlias
}) => `not ${triggerAlias}.tgisinternal
    and (
      ${relationNamespaceAlias}.nspname='public'
      or (
        ${relationNamespaceAlias}.nspname='auth'
        and ${relationAlias}.relname='users'
      )
      or ${functionNamespaceAlias}.nspname='public'
    )`;

function buildTriggerSemanticAndBindingGuardSql({
  expectedSemanticPayloadBytes,
  expectedSemanticSha256
}) {
  const scope = triggerScopePredicateSql({
    triggerAlias: 'trigger',
    relationAlias: 'relation',
    relationNamespaceAlias: 'relation_namespace',
    functionNamespaceAlias: 'function_namespace'
  });
  const manifest = legacyStrictTriggerGuardManifest;

  return `  if current_setting('server_version_num')::integer / 10000 <>
      ${manifest.serverMajor} then
    raise exception 'STAGING_TRIGGER_SERVER_MAJOR_INVALID: %',
      current_setting('server_version_num');
  end if;
  if current_setting('server_encoding') <> ${quote(manifest.serverEncoding)} then
    raise exception 'STAGING_TRIGGER_SERVER_ENCODING_INVALID: %',
      current_setting('server_encoding');
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
  where ${scope}
    and function_namespace.nspname <> ${quote(manifest.allowedFunctionSchema)};
  if v_missing is not null then
    raise exception 'STAGING_TRIGGER_FUNCTION_SCHEMA_INVALID: %', v_missing;
  end if;

  select count(*)::bigint,
    coalesce(string_agg(semantic_row,E'\\n' order by semantic_row collate "C"),'') || E'\\n'
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
        and ${triggerScopePredicateSql({
          triggerAlias: 'trigger',
          relationAlias: 'relation',
          relationNamespaceAlias: 'relation_namespace',
          functionNamespaceAlias: 'bound_function_namespace'
        })}
    )
  ) reviewed_trigger_functions;
  if v_trigger_function_count <> ${manifest.functionSemanticCount}
     or octet_length(v_trigger_function_payload) <> ${expectedSemanticPayloadBytes}
     or encode(sha256(convert_to(v_trigger_function_payload,'UTF8')),'hex') <>
        ${quote(expectedSemanticSha256)} then
    raise exception 'STAGING_TRIGGER_FUNCTION_SEMANTICS_INVALID: count=%, bytes=%, sha256=%',
      v_trigger_function_count,octet_length(v_trigger_function_payload),
      encode(sha256(convert_to(v_trigger_function_payload,'UTF8')),'hex');
  end if;

  select count(*)::bigint,
    coalesce(string_agg(binding_row,E'\\n' order by binding_row collate "C"),'') || E'\\n'
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
    where ${scope}
  ) reviewed_trigger_bindings;
  if v_trigger_binding_count <> ${manifest.bindingCount}
     or octet_length(v_trigger_binding_payload) <> ${manifest.bindingPayloadBytes}
     or encode(sha256(convert_to(v_trigger_binding_payload,'UTF8')),'hex') <>
        ${quote(manifest.bindingSha256)} then
    raise exception 'STAGING_TRIGGER_BINDING_SNAPSHOT_INVALID: count=%, bytes=%, sha256=%',
      v_trigger_binding_count,octet_length(v_trigger_binding_payload),
      encode(sha256(convert_to(v_trigger_binding_payload,'UTF8')),'hex');
  end if;

`;
}

function buildClassifiedCompleteAclGuardSql() {
  const manifest = CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST;
  const triggerManifest = CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST;
  const desiredAuthenticated = [
    ...manifest.routineDispositions.authenticated_only,
    ...manifest.routineDispositions.authenticated_and_service
  ];
  const desiredService = [
    ...manifest.routineDispositions.authenticated_and_service,
    ...manifest.routineDispositions.service_only
  ];

  return `  if current_setting('server_version_num')::integer / 10000 <>
      ${triggerManifest.serverMajor} then
    raise exception 'CNYOS_CLASSIFIED_ACL_SERVER_MAJOR_INVALID: %',
      current_setting('server_version_num');
  end if;
  if current_setting('server_encoding') <> ${quote(triggerManifest.serverEncoding)} then
    raise exception 'CNYOS_CLASSIFIED_ACL_SERVER_ENCODING_INVALID: %',
      current_setting('server_encoding');
  end if;

  select array_agg(signature order by signature collate "C") into v_acl_actual
  from (
    select namespace.nspname || '.' || procedure.proname ||
      pg_catalog.regexp_replace(
        procedure.oid::pg_catalog.regprocedure::text,'^[^(]+',''
      ) signature
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace on namespace.oid=procedure.pronamespace
    where namespace.nspname='public'
  ) actual;
  select array_agg(signature order by signature collate "C") into v_acl_expected
  from unnest(v_acl_all_routines) item(signature);
  if cardinality(v_acl_all_routines)<>147
     or (select count(distinct signature) from unnest(v_acl_all_routines) item(signature))<>147
     or v_acl_actual is distinct from v_acl_expected then
    raise exception 'CNYOS_CLASSIFIED_ACL_PUBLIC_ROUTINE_SET_INVALID';
  end if;

  select string_agg(item.signature, ', ' order by item.signature collate "C")
  into v_missing
  from unnest(v_acl_all_routines) item(signature)
  left join pg_catalog.pg_proc procedure
    on procedure.oid=pg_catalog.to_regprocedure(item.signature)
  left join pg_catalog.pg_roles owner_role on owner_role.oid=procedure.proowner
  where owner_role.rolname is distinct from 'postgres'
     or procedure.prokind is distinct from 'f'
     or exists (
       select 1 from pg_catalog.pg_depend dependency
       where dependency.classid='pg_catalog.pg_proc'::pg_catalog.regclass
         and dependency.objid=procedure.oid
         and dependency.refclassid='pg_catalog.pg_extension'::pg_catalog.regclass
         and dependency.deptype='e'
     );
  if v_missing is not null then
    raise exception 'CNYOS_CLASSIFIED_ACL_OWNER_KIND_OR_EXTENSION_INVALID: %',v_missing;
  end if;

  if exists (
    select 1 from unnest(v_acl_trigger_handlers) item(signature)
    join pg_catalog.pg_proc procedure
      on procedure.oid=pg_catalog.to_regprocedure(item.signature)
    where procedure.prorettype<>'pg_catalog.trigger'::pg_catalog.regtype
  ) or exists (
    select 1 from unnest(v_acl_event_handlers) item(signature)
    join pg_catalog.pg_proc procedure
      on procedure.oid=pg_catalog.to_regprocedure(item.signature)
    where procedure.prorettype<>'pg_catalog.event_trigger'::pg_catalog.regtype
  ) then
    raise exception 'CNYOS_CLASSIFIED_ACL_HANDLER_CLASSIFICATION_INVALID';
  end if;

  with acl_rows as (
    select concat_ws(E'\\t',
      namespace.nspname || '.' || procedure.proname || pg_catalog.regexp_replace(
        procedure.oid::pg_catalog.regprocedure::text,'^[^(]+',''
      ),
      owner_role.rolname,
      case when procedure.proacl is null then 'true' else 'false' end,
      coalesce(grantee_role.rolname,'PUBLIC'),
      coalesce(grantor_role.rolname,'PUBLIC'),
      acl.privilege_type,
      case when acl.is_grantable then 'true' else 'false' end,
      case when procedure.proacl is null
        then 'implicit_hard_wired_function_default'
        else 'explicit_pg_proc_proacl' end
    ) acl_row
    from unnest(v_acl_all_routines) item(signature)
    join pg_catalog.pg_proc procedure
      on procedure.oid=pg_catalog.to_regprocedure(item.signature)
    join pg_catalog.pg_namespace namespace on namespace.oid=procedure.pronamespace
    join pg_catalog.pg_roles owner_role on owner_role.oid=procedure.proowner
    cross join lateral pg_catalog.aclexplode(coalesce(
      procedure.proacl,pg_catalog.acldefault('f',procedure.proowner)
    )) acl
    left join pg_catalog.pg_roles grantee_role
      on acl.grantee<>0 and grantee_role.oid=acl.grantee
    left join pg_catalog.pg_roles grantor_role
      on acl.grantor<>0 and grantor_role.oid=acl.grantor
  ), metric as (
    select count(*)::bigint row_count,
      coalesce(string_agg(acl_row,E'\\n' order by acl_row collate "C"),'') || E'\\n'
        payload
    from acl_rows
  )
  select row_count,payload into v_acl_row_count,v_acl_payload from metric;
  if v_acl_row_count<>${manifest.currentRawAclMatrix.rowCount}
     or octet_length(v_acl_payload)<>${manifest.currentRawAclMatrix.payloadBytes}
     or encode(sha256(convert_to(v_acl_payload,'UTF8')),'hex')<>
        ${quote(manifest.currentRawAclMatrix.sha256)} then
    raise exception 'CNYOS_CLASSIFIED_ACL_CURRENT_RAW_MATRIX_INVALID: count=%, bytes=%, sha256=%',
      v_acl_row_count,octet_length(v_acl_payload),
      encode(sha256(convert_to(v_acl_payload,'UTF8')),'hex');
  end if;

  with required_roles(role_name,is_public) as (values
    ('PUBLIC'::text,true),('anon'::text,false),
    ('authenticated'::text,false),('service_role'::text,false)
  ), runtime_roles as (
    select required.role_name,required.is_public,
      case when required.is_public then 0::oid else role_row.oid end role_oid,
      required.is_public or role_row.oid is not null role_exists
    from required_roles required
    left join pg_catalog.pg_roles role_row
      on not required.is_public and role_row.rolname=required.role_name
  ), public_privileges as (
    select
      coalesce(bool_or(acl.privilege_type='USAGE')
        filter (where acl.grantee=0),false) schema_usage
    from pg_catalog.pg_namespace namespace
    left join lateral pg_catalog.aclexplode(coalesce(
      namespace.nspacl,pg_catalog.acldefault('n',namespace.nspowner)
    )) acl on true
    where namespace.nspname='public'
  ), access_rows as (
    select concat_ws(E'\\t',
      namespace.nspname || '.' || procedure.proname || pg_catalog.regexp_replace(
        procedure.oid::pg_catalog.regprocedure::text,'^[^(]+',''
      ),
      runtime.role_name,
      case when runtime.role_exists then 'true' else 'false' end,
      case when access_value.schema_usage then 'true' else 'false' end,
      case when access_value.function_execute then 'true' else 'false' end,
      case when access_value.function_grantable then 'true' else 'false' end,
      case when access_value.schema_usage and access_value.function_execute
        then 'true' else 'false' end
    ) access_row
    from unnest(v_acl_all_routines) item(signature)
    join pg_catalog.pg_proc procedure
      on procedure.oid=pg_catalog.to_regprocedure(item.signature)
    join pg_catalog.pg_namespace namespace on namespace.oid=procedure.pronamespace
    cross join runtime_roles runtime
    cross join public_privileges
    cross join lateral (
      select
        case when runtime.is_public then public_privileges.schema_usage
          when runtime.role_exists then pg_catalog.has_schema_privilege(
            runtime.role_oid,procedure.pronamespace,'USAGE'
          ) else false end schema_usage,
        case when runtime.is_public then exists (
          select 1 from pg_catalog.aclexplode(coalesce(
            procedure.proacl,pg_catalog.acldefault('f',procedure.proowner)
          )) public_acl
          where public_acl.grantee=0 and public_acl.privilege_type='EXECUTE'
        ) when runtime.role_exists then pg_catalog.has_function_privilege(
          runtime.role_oid,procedure.oid,'EXECUTE'
        ) else false end function_execute,
        case when runtime.is_public then exists (
          select 1 from pg_catalog.aclexplode(coalesce(
            procedure.proacl,pg_catalog.acldefault('f',procedure.proowner)
          )) public_acl
          where public_acl.grantee=0 and public_acl.privilege_type='EXECUTE'
            and public_acl.is_grantable
        ) when runtime.role_exists then pg_catalog.has_function_privilege(
          runtime.role_oid,procedure.oid,'EXECUTE WITH GRANT OPTION'
        ) else false end function_grantable
    ) access_value
  ), metric as (
    select count(*)::bigint row_count,
      coalesce(string_agg(access_row,E'\\n' order by access_row collate "C"),'') || E'\\n'
        payload
    from access_rows
  )
  select row_count,payload into v_acl_row_count,v_acl_payload from metric;
  if v_acl_row_count<>${manifest.currentEffectiveAccessMatrix.rowCount}
     or octet_length(v_acl_payload)<>${manifest.currentEffectiveAccessMatrix.payloadBytes}
     or encode(sha256(convert_to(v_acl_payload,'UTF8')),'hex')<>
        ${quote(manifest.currentEffectiveAccessMatrix.sha256)} then
    raise exception 'CNYOS_CLASSIFIED_ACL_CURRENT_EFFECTIVE_MATRIX_INVALID: count=%, bytes=%, sha256=%',
      v_acl_row_count,octet_length(v_acl_payload),
      encode(sha256(convert_to(v_acl_payload,'UTF8')),'hex');
  end if;

  with desired_rows as (
    select concat_ws(E'\\t',item.signature,runtime.role_name,
      case
        when runtime.role_name='authenticated'
          and item.signature=any(${sqlArray(desiredAuthenticated)}) then 'true'
        when runtime.role_name='service_role'
          and item.signature=any(${sqlArray(desiredService)}) then 'true'
        else 'false'
      end
    ) desired_row
    from unnest(v_acl_all_routines) item(signature)
    cross join (values ('PUBLIC'),('anon'),('authenticated'),('service_role'))
      runtime(role_name)
  ), metric as (
    select count(*)::bigint row_count,
      coalesce(string_agg(desired_row,E'\\n' order by desired_row collate "C"),'') || E'\\n'
        payload
    from desired_rows
  )
  select row_count,payload into v_acl_row_count,v_acl_payload from metric;
  if v_acl_row_count<>${manifest.desiredEffectiveAccessMatrix.rowCount}
     or octet_length(v_acl_payload)<>${manifest.desiredEffectiveAccessMatrix.payloadBytes}
     or encode(sha256(convert_to(v_acl_payload,'UTF8')),'hex')<>
        ${quote(manifest.desiredEffectiveAccessMatrix.sha256)} then
    raise exception 'CNYOS_CLASSIFIED_ACL_DESIRED_MATRIX_INVALID';
  end if;

  select count(*)::bigint,
    coalesce(string_agg(binding_row,E'\\n' order by binding_row collate "C"),'') || E'\\n'
  into v_acl_row_count,v_acl_payload
  from (
    select concat_ws(E'\\t',relation_namespace.nspname,relation.relname,
      trigger_row.tgname,function_namespace.nspname || '.' || procedure.proname ||
      pg_catalog.regexp_replace(
        procedure.oid::pg_catalog.regprocedure::text,'^[^(]+',''
      )
    ) binding_row
    from pg_catalog.pg_trigger trigger_row
    join pg_catalog.pg_class relation on relation.oid=trigger_row.tgrelid
    join pg_catalog.pg_namespace relation_namespace
      on relation_namespace.oid=relation.relnamespace
    join pg_catalog.pg_proc procedure on procedure.oid=trigger_row.tgfoid
    join pg_catalog.pg_namespace function_namespace
      on function_namespace.oid=procedure.pronamespace
    where not trigger_row.tgisinternal
  ) bindings;
  if v_acl_row_count<>${triggerManifest.triggerBindingCount}
     or octet_length(v_acl_payload)<>
        ${triggerManifest.triggerBindingIdentityPayloadBytes}
     or encode(sha256(convert_to(v_acl_payload,'UTF8')),'hex')<>
        ${quote(triggerManifest.triggerBindingIdentitySha256)}
     or exists (
       select 1
       from pg_catalog.pg_trigger trigger_row
       join pg_catalog.pg_class relation on relation.oid=trigger_row.tgrelid
       join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
       where not trigger_row.tgisinternal
         and (trigger_row.tgenabled<>'O' or relation.relpersistence='t'
           or namespace.nspname like 'pg_temp\\_%' escape '\\')
     ) then
    raise exception 'CNYOS_CLASSIFIED_ACL_TRIGGER_BINDING_IDENTITY_INVALID: count=%, bytes=%, sha256=%',
      v_acl_row_count,octet_length(v_acl_payload),
      encode(sha256(convert_to(v_acl_payload,'UTF8')),'hex');
  end if;

  select count(*)::bigint,
    coalesce(string_agg(binding_row,E'\\n' order by binding_row collate "C"),'') || E'\\n'
  into v_acl_row_count,v_acl_payload
  from (
    select concat_ws(E'\\t',event_row.evtname,event_row.evtevent,
      function_namespace.nspname || '.' || procedure.proname ||
      pg_catalog.regexp_replace(
        procedure.oid::pg_catalog.regprocedure::text,'^[^(]+',''
      )
    ) binding_row
    from pg_catalog.pg_event_trigger event_row
    join pg_catalog.pg_proc procedure on procedure.oid=event_row.evtfoid
    join pg_catalog.pg_namespace function_namespace
      on function_namespace.oid=procedure.pronamespace
  ) bindings;
  if v_acl_row_count<>${triggerManifest.eventTriggerBindingCount}
     or octet_length(v_acl_payload)<>
        ${triggerManifest.eventTriggerBindingIdentityPayloadBytes}
     or encode(sha256(convert_to(v_acl_payload,'UTF8')),'hex')<>
        ${quote(triggerManifest.eventTriggerBindingIdentitySha256)}
     or exists (
       select 1 from pg_catalog.pg_event_trigger event_row
       where event_row.evtenabled<>'O'
     ) then
    raise exception 'CNYOS_CLASSIFIED_ACL_EVENT_BINDING_IDENTITY_INVALID: count=%, bytes=%, sha256=%',
      v_acl_row_count,octet_length(v_acl_payload),
      encode(sha256(convert_to(v_acl_payload,'UTF8')),'hex');
  end if;

${classifiedStableBindingGuardSql}
  select array_agg(signature order by signature collate "C") into v_acl_actual
  from (
    select distinct function_namespace.nspname || '.' || procedure.proname ||
      pg_catalog.regexp_replace(
        procedure.oid::pg_catalog.regprocedure::text,'^[^(]+',''
      ) signature
    from pg_catalog.pg_trigger trigger_row
    join pg_catalog.pg_proc procedure on procedure.oid=trigger_row.tgfoid
    join pg_catalog.pg_namespace function_namespace
      on function_namespace.oid=procedure.pronamespace
    where not trigger_row.tgisinternal and function_namespace.nspname='public'
  ) handlers;
  select array_agg(signature order by signature collate "C") into v_acl_expected
  from unnest(v_acl_trigger_handlers) item(signature);
  if v_acl_actual is distinct from v_acl_expected then
    raise exception 'CNYOS_CLASSIFIED_ACL_PUBLIC_TRIGGER_HANDLER_SET_INVALID';
  end if;
  select array_agg(signature order by signature collate "C") into v_acl_actual
  from (
    select distinct function_namespace.nspname || '.' || procedure.proname ||
      pg_catalog.regexp_replace(
        procedure.oid::pg_catalog.regprocedure::text,'^[^(]+',''
      ) signature
    from pg_catalog.pg_event_trigger event_row
    join pg_catalog.pg_proc procedure on procedure.oid=event_row.evtfoid
    join pg_catalog.pg_namespace function_namespace
      on function_namespace.oid=procedure.pronamespace
    where function_namespace.nspname='public'
  ) handlers;
  if v_acl_actual is distinct from v_acl_event_handlers then
    raise exception 'CNYOS_CLASSIFIED_ACL_PUBLIC_EVENT_HANDLER_SET_INVALID';
  end if;

  select array_agg(namespace.nspname || '.' || procedure.proname ||
    pg_catalog.regexp_replace(
      procedure.oid::pg_catalog.regprocedure::text,'^[^(]+',''
    )
    order by namespace.nspname collate "C",procedure.proname collate "C",
      procedure.oid::pg_catalog.regprocedure::text collate "C")
  into v_acl_actual
  from pg_catalog.pg_proc procedure
  join pg_catalog.pg_namespace namespace on namespace.oid=procedure.pronamespace
  where namespace.nspname='public' and procedure.prosecdef;
  select array_agg(plan.signature order by plan.signature collate "C")
  into v_acl_expected
  from pg_catalog.jsonb_to_recordset(v_acl_path_plan) plan(signature text);
  if pg_catalog.jsonb_array_length(v_acl_path_plan)<>141
     or (select count(distinct plan.signature)
         from pg_catalog.jsonb_to_recordset(v_acl_path_plan) plan(signature text))<>141
     or v_acl_actual is distinct from v_acl_expected
     or exists (
       select 1
       from pg_catalog.jsonb_to_recordset(v_acl_path_plan) reviewed(
         signature text,definition_sha256 text,language text,
         pre_config text,target_config text
       )
       left join pg_catalog.pg_proc procedure
         on procedure.oid=pg_catalog.to_regprocedure(reviewed.signature)
       left join pg_catalog.pg_roles owner_role on owner_role.oid=procedure.proowner
       left join pg_catalog.pg_language language on language.oid=procedure.prolang
       where procedure.oid is null or not procedure.prosecdef
          or owner_role.rolname is distinct from 'postgres'
          or language.lanname is distinct from reviewed.language
          or coalesce(pg_catalog.array_to_string(procedure.proconfig,','),'')
               is distinct from reviewed.pre_config
          or pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
               pg_catalog.pg_get_functiondef(procedure.oid),'UTF8'
             )),'hex') is distinct from reviewed.definition_sha256
          or reviewed.target_config is distinct from
             case when reviewed.pre_config='search_path=pg_catalog'
               then 'search_path=pg_catalog, pg_temp'
               else 'search_path=pg_catalog, public, pg_temp' end
     ) then
    raise exception 'CNYOS_CLASSIFIED_ACL_SECURITY_DEFINER_PATH_OR_DEFINITION_INVALID';
  end if;

  if (select datdba from pg_catalog.pg_database where datname=current_database())<>
       (select oid from pg_catalog.pg_roles where rolname='postgres')
     or (select nspowner from pg_catalog.pg_namespace where nspname='public')<>
       (select oid from pg_catalog.pg_roles where rolname='pg_database_owner')
     or not exists (
       select 1 from pg_catalog.pg_roles role_row
       where role_row.rolname='supabase_admin'
         and role_row.rolcanlogin and role_row.rolsuper
     )
     or exists (
       select 1 from (values ('anon'),('authenticated'),('service_role'),('authenticator'))
         runtime(role_name)
       where pg_catalog.has_schema_privilege(runtime.role_name,'public','CREATE')
          or pg_catalog.pg_has_role(runtime.role_name,'supabase_admin','SET')
     )
     or exists (
       select 1 from (values
         ('pg_database_owner',false,false),
         ('postgres',true,false),
         ('supabase_admin',true,true)
       ) expected(role_name,can_login,is_super)
       left join pg_catalog.pg_roles role_row on role_row.rolname=expected.role_name
       where role_row.oid is null
          or role_row.rolcanlogin is distinct from expected.can_login
          or role_row.rolsuper is distinct from expected.is_super
     )
     or exists (
       select 1 from (values ('pg_database_owner'),('postgres'))
         mutable_creator(role_name)
       left join pg_catalog.pg_roles role_row
         on role_row.rolname=mutable_creator.role_name
       where role_row.oid is null
          or not pg_catalog.has_schema_privilege(role_row.oid,'public','CREATE')
          or (mutable_creator.role_name<>session_user
            and not pg_catalog.pg_has_role(session_user,role_row.oid,'SET'))
     )
     or exists (
       select 1 from pg_catalog.pg_class relation
       join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
       join pg_catalog.pg_roles owner_role on owner_role.oid=relation.relowner
       where namespace.nspname='public' and owner_role.rolname='supabase_admin'
     )
     or exists (
       select 1 from pg_catalog.pg_type type_row
       join pg_catalog.pg_namespace namespace on namespace.oid=type_row.typnamespace
       join pg_catalog.pg_roles owner_role on owner_role.oid=type_row.typowner
       where namespace.nspname='public' and owner_role.rolname='supabase_admin'
     ) then
    raise exception 'CNYOS_CLASSIFIED_ACL_ROLE_SCHEMA_MANAGED_EXCEPTION_INVALID';
  end if;
  select array_agg(role_row.rolname order by role_row.rolname collate "C")
  into v_acl_actual
  from pg_catalog.pg_roles role_row
  where pg_catalog.has_schema_privilege(role_row.oid,'public','CREATE');
  if v_acl_actual is distinct from array['pg_database_owner','postgres','supabase_admin']::text[]
     or exists (
       select 1 from pg_catalog.pg_namespace namespace
       cross join lateral pg_catalog.aclexplode(coalesce(
         namespace.nspacl,pg_catalog.acldefault('n',namespace.nspowner)
       )) acl
       where namespace.nspname='public' and acl.grantee=0
         and acl.privilege_type='CREATE'
     )
     or exists (
       select 1 from (values ('PUBLIC'),('anon'),('authenticated'),('service_role'))
         runtime(role_name)
       where case when runtime.role_name='PUBLIC' then not exists (
         select 1 from pg_catalog.pg_namespace namespace
         cross join lateral pg_catalog.aclexplode(coalesce(
           namespace.nspacl,pg_catalog.acldefault('n',namespace.nspowner)
         )) acl
         where namespace.nspname='public' and acl.grantee=0
           and acl.privilege_type='USAGE'
       ) else not pg_catalog.has_schema_privilege(runtime.role_name,'public','USAGE') end
     )
     or exists (
       select 1 from (values ('PUBLIC'),('anon'),('authenticated'),('service_role'))
         runtime(role_name)
       where case when runtime.role_name='PUBLIC' then not exists (
         select 1 from pg_catalog.pg_database database
         cross join lateral pg_catalog.aclexplode(coalesce(
           database.datacl,pg_catalog.acldefault('d',database.datdba)
         )) acl
         where database.datname=current_database() and acl.grantee=0
           and acl.privilege_type='TEMPORARY'
       ) else not pg_catalog.has_database_privilege(
         runtime.role_name,current_database(),'TEMPORARY'
       ) end
     ) then
    raise exception 'CNYOS_CLASSIFIED_ACL_ROLE_SCHEMA_TEMP_BASELINE_INVALID';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_roles candidate_role
    cross join unnest(array['pg_database_owner','postgres','supabase_admin']::text[])
      creator_name(role_name)
    join pg_catalog.pg_roles creator_role
      on creator_role.rolname=creator_name.role_name
    where (candidate_role.rolcanlogin
        or candidate_role.rolname in
          ('anon','authenticated','service_role','authenticator'))
      and candidate_role.rolname not in ('postgres','supabase_admin')
      and pg_catalog.pg_has_role(candidate_role.oid,creator_role.oid,'SET')
  ) then
    raise exception 'CNYOS_CLASSIFIED_ACL_UNTRUSTED_CREATOR_SET_REACHABILITY_INVALID';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_default_acl defaults
    join pg_catalog.pg_roles creator on creator.oid=defaults.defaclrole
    where creator.rolname=any(array['pg_database_owner','postgres','supabase_admin']::text[])
      and defaults.defaclobjtype='f' and defaults.defaclnamespace=0
  ) or (select count(*)
    from pg_catalog.pg_default_acl defaults
    join pg_catalog.pg_roles creator on creator.oid=defaults.defaclrole
    join pg_catalog.pg_namespace namespace on namespace.oid=defaults.defaclnamespace
    where creator.rolname=any(array['pg_database_owner','postgres','supabase_admin']::text[])
      and defaults.defaclobjtype='f' and namespace.nspname='public')<>2
  or exists (
    select 1
    from pg_catalog.pg_default_acl defaults
    join pg_catalog.pg_roles creator on creator.oid=defaults.defaclrole
    join pg_catalog.pg_namespace namespace on namespace.oid=defaults.defaclnamespace
    cross join lateral pg_catalog.aclexplode(defaults.defaclacl) acl
    left join pg_catalog.pg_roles grantee on grantee.oid=acl.grantee
    left join pg_catalog.pg_roles grantor on grantor.oid=acl.grantor
    where creator.rolname=any(array['pg_database_owner','postgres','supabase_admin']::text[])
      and defaults.defaclobjtype='f' and namespace.nspname='public'
      and (acl.privilege_type<>'EXECUTE' or acl.is_grantable
        or grantor.rolname<>creator.rolname or not exists (
          select 1 from (values
            ('postgres','postgres'),
            ('supabase_admin','postgres'),('supabase_admin','anon'),
            ('supabase_admin','authenticated'),('supabase_admin','service_role')
          ) expected(creator_name,grantee_name)
          where expected.creator_name=creator.rolname
            and expected.grantee_name=grantee.rolname
        ))
  ) or exists (
    select 1 from (values
      ('postgres','postgres'),
      ('supabase_admin','postgres'),('supabase_admin','anon'),
      ('supabase_admin','authenticated'),('supabase_admin','service_role')
    ) expected(creator_name,grantee_name)
    where not exists (
      select 1
      from pg_catalog.pg_default_acl defaults
      join pg_catalog.pg_roles creator on creator.oid=defaults.defaclrole
      join pg_catalog.pg_namespace namespace on namespace.oid=defaults.defaclnamespace
      cross join lateral pg_catalog.aclexplode(defaults.defaclacl) acl
      join pg_catalog.pg_roles grantee on grantee.oid=acl.grantee
      join pg_catalog.pg_roles grantor on grantor.oid=acl.grantor
      where creator.rolname=expected.creator_name
        and grantee.rolname=expected.grantee_name
        and grantor.rolname=expected.creator_name
        and defaults.defaclobjtype='f' and namespace.nspname='public'
        and acl.privilege_type='EXECUTE' and not acl.is_grantable
    )
  ) then
    raise exception 'CNYOS_CLASSIFIED_ACL_POST_TOGGLE_DEFAULT_BASELINE_INVALID';
  end if;

  -- Hosted Chananya postgres is intentionally non-super and cannot LOCK the
  -- protected catalogs in SHARE mode. This verifier therefore relies on its
  -- repeatable-read snapshot; mutation stays blocked pending a separately
  -- reviewed hosted-like serialization design and native rehearsal.
  if (select rolsuper from pg_catalog.pg_roles where rolname=current_user) then
    raise exception 'CNYOS_CLASSIFIED_ACL_HOSTED_NON_SUPER_PROFILE_REQUIRED';
  end if;

`;
}

export function loadMigrationEntries(cwd = root) {
  const directory = path.join(cwd, 'supabase', 'migrations');
  const entries = fs.readdirSync(directory)
    .filter(file => file.endsWith('.sql'))
    .sort()
    .map(file => {
      const parsed = file.match(migrationName);
      if (!parsed) throw new Error(`Migration filename is not canonical: ${file}`);
      const source = fs.readFileSync(path.join(directory, file), 'utf8');
      return {
        version: parsed[1],
        name: parsed[2],
        file,
        sha256: createHash('sha256').update(source).digest('hex')
      };
    });
  if (!entries.length) throw new Error('No ordered Supabase migrations were found');
  if (new Set(entries.map(entry => entry.version)).size !== entries.length) {
    throw new Error('Migration versions must be unique');
  }
  return entries;
}

export function buildMigrationLedgerRepairSql(options) {
  return buildMigrationLedgerSql({ ...options, verificationOnly: false });
}

// Catalog verification reuses the fail-closed schema and privilege guards but
// never includes application healthchecks or ledger writes.
export function buildMigrationLedgerSchemaGuardSql(options) {
  return buildMigrationLedgerSql({ ...options, verificationOnly: true });
}

export function isExactReviewedChananyaStagingTarget(target) {
  const databaseUrl = new URL(target.database.url);
  const manifest = CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST;
  return databaseUrl.hostname === `${manifest.projectRef}.supabase.co` &&
    databaseUrl.origin === manifest.databaseOrigin &&
    target.database.url === manifest.databaseOrigin &&
    target.deploymentId === manifest.deploymentId &&
    target.tenant.expectedClinicCode === manifest.clinicCode &&
    target.tenant.expectedClinicId === manifest.clinicId;
}

function resolveMigrationLedgerAclPhase(target, requestedPhase = MIGRATION_LEDGER_ACL_PHASE_STRICT) {
  if (![
    MIGRATION_LEDGER_ACL_PHASE_STRICT,
    MIGRATION_LEDGER_ACL_PHASE_CHANANYA_PRE_RECONCILIATION
  ].includes(requestedPhase)) {
    throw new Error(`Unsupported migration-ledger ACL phase: ${requestedPhase}`);
  }
  if (requestedPhase === MIGRATION_LEDGER_ACL_PHASE_STRICT) return requestedPhase;

  if (!isExactReviewedChananyaStagingTarget(target)) {
    throw new Error(
      'Chananya pre-reconciliation ACL phase is restricted to the exact reviewed staging target'
    );
  }
  return requestedPhase;
}

function buildMigrationLedgerSql({
  config,
  entries = loadMigrationEntries(),
  sourceRevision = '',
  verificationOnly,
  aclPhase = MIGRATION_LEDGER_ACL_PHASE_STRICT
}) {
  const target = validateTenantConfig(config);
  const targetDatabaseUrl = new URL(target.database.url);
  const targetProjectRef = targetDatabaseUrl.hostname.replace(/\.supabase\.co$/, '');
  if (!stagingMarker.test(target.deploymentId)) {
    throw new Error('Migration ledger recovery is restricted to a staging/non-production deployment');
  }
  if (!/(?:STG|STAGING|TEST|NONPROD)/i.test(target.tenant.expectedClinicCode)) {
    throw new Error('Migration ledger recovery requires an explicit staging clinic code');
  }
  if (!entries.length) throw new Error('Migration ledger recovery requires at least one migration');
  for (const entry of entries) {
    if (!/^\d{12,14}$/.test(entry.version) ||
        !/^[a-z0-9_]+$/i.test(entry.name) ||
        entry.file !== `${entry.version}_${entry.name}.sql` ||
        !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new Error(`Migration ledger entry is not canonical: ${entry.file || entry.version}`);
    }
  }
  if (new Set(entries.map(entry => entry.version)).size !== entries.length) {
    throw new Error('Migration ledger entry versions must be unique');
  }
  if (entries.some((entry, index) => index > 0 &&
      entries[index - 1].file >= entry.file)) {
    throw new Error('Migration ledger entries must be in strict canonical order');
  }
  for (const [file, sha256] of immutableMigrationHashes) {
    if (entries.find(entry => entry.file === file)?.sha256 !== sha256) {
      throw new Error(`Immutable historical migration SHA mismatch: ${file}`);
    }
  }

  const expectedRows = entries
    .map(entry => {
      const evidence = `-- recovered from supabase/migrations/${entry.file}; sha256=${entry.sha256}`;
      return `(${quote(entry.version)},${quote(entry.name)},${quote(entry.sha256)},${quote(evidence)})`;
    })
    .join(',\n      ');
  const inserts = entries
    .map(entry => {
      const evidence = `-- recovered from supabase/migrations/${entry.file}; sha256=${entry.sha256}`;
      return `(${quote(entry.version)},${quote(entry.name)},array[${quote(evidence)}]::text[])`;
    })
    .join(',\n  ');
  const revision = String(sourceRevision || '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error(
      `${verificationOnly ? 'Verification' : 'Migration ledger repair'} requires the full ` +
      '40-character artifact source revision'
    );
  }

  const resolvedAclPhase = resolveMigrationLedgerAclPhase(target, aclPhase);
  if (!verificationOnly && !isExactReviewedChananyaStagingTarget(target)) {
    throw new Error(
      'Migration ledger repair is restricted to the exact reviewed Chananya staging ' +
      'target until this tenant has an independent baseline'
    );
  }
  const isChananyaPreReconciliation =
    resolvedAclPhase === MIGRATION_LEDGER_ACL_PHASE_CHANANYA_PRE_RECONCILIATION;
  const clinicalTreatmentSessionAclContract = isChananyaPreReconciliation
    ? REPOSITORY_DERIVED_CLINICAL_TREATMENT_SESSION_ACL_MANIFEST.preReconciliationAcl
    : REPOSITORY_DERIVED_CLINICAL_TREATMENT_SESSION_ACL_MANIFEST.strictPostRemediationAcl;
  const clinicalTreatmentSessionDirectAclGrants =
    clinicalTreatmentSessionAclContract.directOwnerGrantedNonGrantableExecuteGrantees
      .map(grantee => [grantee]);
  const clinicalTreatmentSessionRuntimeAcl = runtimeJwtRoles.map(roleName => [
    roleName,
    clinicalTreatmentSessionAclContract.effectiveRuntimeExecuteRoles.includes(roleName)
  ]);
  if (
    entries.length !== reviewedMigrationManifestCount ||
    migrationManifestSha256(entries) !== reviewedMigrationManifestSha256
  ) {
    throw new Error(
      `${verificationOnly ? 'Migration ledger verification' : 'Migration ledger repair'} ` +
      'requires the exact reviewed 45-entry migration manifest'
    );
  }
  const transitionalBrowserRpcGrants = isChananyaPreReconciliation
    ? legacyStrictBrowserRpcAclExceptions
      .map(([grantee, procedureSignature]) => [procedureSignature, grantee])
    : [];
  const allowedSubscriptionBrowserProcedureGrants = [
    ...subscriptionKillSwitchBrowserProcedureGrants,
    ...transitionalBrowserRpcGrants
  ];
  const allowedCallableSecurityDefinerProcedureGrants = [
    ...callableSecurityDefinerProcedureGrants,
    ...transitionalBrowserRpcGrants
  ];
  const expectedTriggerInventory = isChananyaPreReconciliation
    ? legacyStrictTriggerGuardManifest.triggerInventory
    : legacyStrictTriggerGuardManifest.triggerInventory.map(row =>
      row[0] === 'public.set_updated_at()'
        ? [row[0], row[1], 'search_path=pg_catalog, public', row[3], row[4]]
        : [...row]);
  const expectedTriggerSemanticPayloadBytes = isChananyaPreReconciliation
    ? legacyStrictTriggerGuardManifest
      .functionSemanticPreReconciliationPayloadBytes
    : legacyStrictTriggerGuardManifest.functionSemanticStrictPayloadBytes;
  const expectedTriggerSemanticSha256 = isChananyaPreReconciliation
    ? legacyStrictTriggerGuardManifest.functionSemanticPreReconciliationSha256
    : legacyStrictTriggerGuardManifest.functionSemanticStrictSha256;
  const allowedTriggerProcedureGrants = isChananyaPreReconciliation
    ? legacyStrictTriggerGuardManifest.aclTuples
      .map(([grantee, procedureSignature]) => [procedureSignature, grantee])
    : [];
  const triggerAclMissingGuardSql = '';
  const triggerAclInvalidPredicate = 'true';
  const repairStatus = isChananyaPreReconciliation
    ? 'CNYOS_CHANANYA_CLASSIFIED_COMPLETE_LEDGER_REPAIR_NOT_AUTHORIZED'
    : 'CNYOS_STAGING_MIGRATION_LEDGER_RECONCILED';
  const repairEvidenceMarker = 'cnyos_migration_ledger_repair_evidence';
  const repairReceiptTable = 'cnyos_migration_ledger_repair_receipts';
  const expectedDatabaseName = 'postgres';
  const expectedDatabaseUser = 'postgres';
  const ledgerComment =
    'Canonical Supabase CLI migration history. Recovered only after staging schema fingerprint and empty-data guards passed.';
  const repairReceiptComment =
    'Committed CNYOS migration-ledger repair receipts. UUID and top-level XID replay guard; not migration provenance.';
  const repairReceiptCheckDefinitions = [
    [
      'cnyos_repair_receipt_gate_token_check',
      "CHECK (gate_token ~ '^[0-9a-f]{64}$'::text)"
    ],
    [
      'cnyos_repair_receipt_xid_check',
      "CHECK (repair_xid ~ '^[0-9]+$'::text)"
    ],
    [
      'cnyos_repair_receipt_evidence_check',
      "CHECK ((jsonb_typeof(evidence) = 'object'::text AND " +
        "(evidence ->> 'repair_gate_token'::text) = gate_token AND " +
        "(evidence ->> 'repair_run_nonce'::text) = run_nonce::text AND " +
        "(evidence ->> 'repair_transaction_xid'::text) = repair_xid) IS TRUE)"
    ]
  ];
  const repairRunNonceGuc = 'cnyos.migration_ledger_repair_run_nonce';
  const repairCommittedNonceGuc = 'cnyos.migration_ledger_repair_committed_nonce';
  const repairCommittedXidGuc = 'cnyos.migration_ledger_repair_committed_xid';
  const repairObservedHostGuc = 'cnyos.migration_ledger_repair_observed_psql_host';
  const repairObservedPortGuc = 'cnyos.migration_ledger_repair_observed_psql_port';
  const repairObservedUserGuc = 'cnyos.migration_ledger_repair_observed_psql_user';
  const repairObservedDatabaseGuc = 'cnyos.migration_ledger_repair_observed_psql_database';
  const expectedDatabaseHost = `db.${targetProjectRef}.supabase.co`;
  const repairGateToken = createHash('sha256').update([
    target.deploymentId,
    target.tenant.expectedClinicId,
    revision || 'not-supplied',
    resolvedAclPhase,
    migrationManifestSha256(entries)
  ].join('\n')).digest('hex');
  const repairAuthorizationBlockerSql =
    `  raise exception ${quote(migrationLedgerRepairAuthorizationBlocker)};\n`;
  const exactLedgerInvariantPredicate =
    `(select count(*) from supabase_migrations.schema_migrations) = ${entries.length}\n` +
    `    and not exists (\n` +
    `      select 1\n` +
    `      from supabase_migrations.schema_migrations actual\n` +
    `      left join (values\n        ${expectedRows}\n` +
    `      ) expected(version,name,sha256,evidence) on expected.version=actual.version\n` +
    `      where expected.version is null\n` +
    `    )\n` +
    `    and not exists (\n` +
    `      select 1\n` +
    `      from (values\n        ${expectedRows}\n` +
    `      ) expected(version,name,sha256,evidence)\n` +
    `      left join supabase_migrations.schema_migrations actual\n` +
    `        on actual.version=expected.version\n` +
    `      where actual.version is null\n` +
    `         or actual.name is distinct from expected.name\n` +
    `         or actual.statements is null\n` +
    `         or cardinality(actual.statements)=0\n` +
    `         or exists (\n` +
    `           select 1 from unnest(actual.statements) statement(value)\n` +
    `           where statement.value is null\n` +
    `         )\n` +
    `         or not exists (\n` +
    `           select 1 from unnest(coalesce(actual.statements,array[]::text[])) statement(value)\n` +
    `           where statement.value is not distinct from expected.evidence\n` +
    `         )\n` +
    `         or (\n` +
    `           select count(*)\n` +
    `           from unnest(coalesce(actual.statements,array[]::text[])) statement(value)\n` +
    `           where statement.value ~* '^[[:space:]]*-- recovered from supabase/migrations/[^;]+;[[:space:]]*sha256[[:space:]]*='\n` +
    `         ) <> 1\n` +
    `    )`;
  const verificationPsqlPreamble = verificationOnly ?
    `\\set ON_ERROR_STOP 1
\\set ON_ERROR_ROLLBACK off
\\unset cnyos_verification_probe_xid
\\unset cnyos_verification_existing_transaction
\\unset cnyos_verification_server_identity_ok
\\unset cnyos_verification_lock_released
\\if :AUTOCOMMIT
\\else
\\warn 'CNYOS staging verification requires psql AUTOCOMMIT=on; rolling back and refusing execution'
rollback;
do $cnyos_verification_psql_autocommit_abort$
begin
  raise exception 'CNYOS_STAGING_VERIFICATION_PSQL_AUTOCOMMIT_REQUIRED';
end
$cnyos_verification_psql_autocommit_abort$;
\\endif
set search_path = pg_catalog, pg_temp, public;
select (
  pg_catalog.current_database() = ${quote(expectedDatabaseName)}
  and session_user = ${quote(expectedDatabaseUser)}
  and current_user = ${quote(expectedDatabaseUser)}
) as cnyos_verification_server_identity_ok
\\gset
\\if :cnyos_verification_server_identity_ok
\\else
\\warn 'CNYOS staging verification requires server database/session_user/current_user postgres'
do $cnyos_verification_psql_identity_abort$
begin
  raise exception 'CNYOS_STAGING_VERIFICATION_SERVER_IDENTITY_REFUSED';
end
$cnyos_verification_psql_identity_abort$;
\\endif
select pg_catalog.pg_current_xact_id()::text as cnyos_verification_probe_xid
\\gset
\\unset cnyos_verification_existing_transaction
select (
  pg_catalog.pg_current_xact_id()::text = :'cnyos_verification_probe_xid'
) as cnyos_verification_existing_transaction
\\gset
\\if :cnyos_verification_existing_transaction
\\warn 'CNYOS staging verification detected and rolled back an existing transaction; refusing execution'
rollback;
do $cnyos_verification_psql_transaction_abort$
begin
  raise exception 'CNYOS_STAGING_VERIFICATION_PSQL_EXISTING_TRANSACTION_REFUSED';
end
$cnyos_verification_psql_transaction_abort$;
\\endif
select pg_catalog.pg_advisory_lock(202608302100::bigint);
` : '';
  const repairPsqlPreamble = verificationOnly ? '' :
    `\\set ON_ERROR_STOP 1
\\set ON_ERROR_ROLLBACK off
\\unset cnyos_repair_probe_xid
\\unset cnyos_repair_existing_transaction
\\unset cnyos_repair_session_nonce
\\unset cnyos_repair_committed_nonce
\\unset cnyos_repair_committed_xid
\\unset cnyos_repair_connection_ok
\\unset cnyos_repair_server_identity_ok
\\unset cnyos_repair_lock_unheld
\\unset cnyos_repair_lock_acquired
\\unset cnyos_repair_evidence
\\unset cnyos_repair_lock_released
\\unset cnyos_repair_lock_fully_released
\\unset cnyos_repair_run_nonce
\\if :AUTOCOMMIT
\\else
\\warn 'CNYOS ledger repair requires psql AUTOCOMMIT=on; rolling back and refusing execution'
rollback;
do $cnyos_psql_preflight_abort$
begin
  raise exception 'CNYOS_LEDGER_REPAIR_PSQL_AUTOCOMMIT_REQUIRED';
end
$cnyos_psql_preflight_abort$;
\\endif
set search_path = pg_catalog, pg_temp, public;
select (
  :'HOST' = ${quote(expectedDatabaseHost)}
  and :'PORT' = '5432'
  and :'USER' = 'postgres'
  and :'DBNAME' = 'postgres'
) as cnyos_repair_connection_ok
\\gset
\\if :cnyos_repair_connection_ok
\\else
\\warn 'CNYOS ledger repair requires the exact direct Chananya PostgreSQL endpoint db.${targetProjectRef}.supabase.co:5432, database postgres, user postgres'
do $cnyos_psql_connection_abort$
begin
  raise exception 'CNYOS_LEDGER_REPAIR_PSQL_CONNECTION_IDENTITY_REFUSED';
end
$cnyos_psql_connection_abort$;
\\endif
select (
  pg_catalog.current_database() = ${quote(expectedDatabaseName)}
  and session_user = ${quote(expectedDatabaseUser)}
  and current_user = ${quote(expectedDatabaseUser)}
) as cnyos_repair_server_identity_ok
\\gset
\\if :cnyos_repair_server_identity_ok
\\else
\\warn 'CNYOS ledger repair requires server database/session_user/current_user postgres'
do $cnyos_psql_server_identity_abort$
begin
  raise exception 'CNYOS_LEDGER_REPAIR_SERVER_IDENTITY_REFUSED';
end
$cnyos_psql_server_identity_abort$;
\\endif
select pg_catalog.pg_current_xact_id()::text as cnyos_repair_probe_xid
\\gset
\\unset cnyos_repair_existing_transaction
select (
  pg_catalog.pg_current_xact_id()::text = :'cnyos_repair_probe_xid'
) as cnyos_repair_existing_transaction
\\gset
\\if :cnyos_repair_existing_transaction
\\warn 'CNYOS ledger repair detected and rolled back an existing transaction; refusing execution'
rollback;
do $cnyos_psql_preflight_abort$
begin
  raise exception 'CNYOS_LEDGER_REPAIR_PSQL_EXISTING_TRANSACTION_REFUSED';
end
$cnyos_psql_preflight_abort$;
\\endif
select pg_catalog.gen_random_uuid()::text as cnyos_repair_run_nonce
\\gset
select pg_catalog.set_config(
  ${quote(repairRunNonceGuc)},
  :'cnyos_repair_run_nonce',
  false
) as cnyos_repair_session_nonce
\\gset
select pg_catalog.set_config(
  ${quote(repairCommittedNonceGuc)},
  '',
  false
) as cnyos_repair_committed_nonce
\\gset
select pg_catalog.set_config(
  ${quote(repairCommittedXidGuc)},
  '',
  false
) as cnyos_repair_committed_xid
\\gset
select pg_catalog.set_config(${quote(repairObservedHostGuc)},:'HOST',false),
  pg_catalog.set_config(${quote(repairObservedPortGuc)},:'PORT',false),
  pg_catalog.set_config(${quote(repairObservedUserGuc)},:'USER',false),
  pg_catalog.set_config(${quote(repairObservedDatabaseGuc)},:'DBNAME',false);
select not exists (
  select 1
  from pg_catalog.pg_locks
  where locktype='advisory' and pid=pg_catalog.pg_backend_pid() and granted
    and classid::bigint=(202608302100::bigint >> 32)
    and objid::bigint=(202608302100::bigint & 4294967295::bigint)
    and objsubid=1
) as cnyos_repair_lock_unheld
\\gset
\\if :cnyos_repair_lock_unheld
\\else
\\warn 'CNYOS ledger repair requires the advisory key to be unheld by this session'
do $cnyos_psql_lock_state_abort$
begin
  raise exception 'CNYOS_LEDGER_REPAIR_ADVISORY_LOCK_ALREADY_HELD';
end
$cnyos_psql_lock_state_abort$;
\\endif
select pg_catalog.pg_try_advisory_lock(202608302100::bigint) as cnyos_repair_lock_acquired
\\gset
\\if :cnyos_repair_lock_acquired
\\else
\\warn 'CNYOS ledger repair advisory key is busy; refusing rather than waiting'
do $cnyos_psql_lock_busy_abort$
begin
  raise exception 'CNYOS_LEDGER_REPAIR_ADVISORY_LOCK_BUSY';
end
$cnyos_psql_lock_busy_abort$;
\\endif
`;

  return verificationPsqlPreamble + repairPsqlPreamble + (verificationOnly
    ? `-- Generated read-only staging schema verification (${resolvedAclPhase}).\n`
    : `-- Generated one-time staging migration ledger recovery (${resolvedAclPhase}).\n`) +
    `-- Target: ${target.deploymentId} / ${target.tenant.expectedClinicCode}.\n` +
    `-- Source revision: ${revision || 'not-supplied'}; migration count: ${entries.length}.\n` +
    `-- ACL phase: ${resolvedAclPhase}.\n` +
    (isChananyaPreReconciliation
      ? `-- Classified-complete Chananya live evidence (not independently approved; not ledger-mutation authorization): bundle-sha256=${CHANANYA_PRE_RECONCILIATION_KNOWN_EVIDENCE_BUNDLE.sha256}; routine-count=${CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.routineCount}; observer-raw-sha256=${CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.observerRawSha256}; observer-sql-sha256=${CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.observerSourceSqlSha256}; observation-composite-sha256=${CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.observationCompositeSha256}; disposition-sha256=${CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.dispositionArtifactSha256}; disposition-payload-sha256=${CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.dispositionPayloadSha256}; candidate-sha256=${CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.completeAclCandidateSha256}; security-definer-path-count=${CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.securityDefinerPathPlan.count}; security-definer-path-sha256=${CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.securityDefinerPathPlan.sha256}; trigger-binding-count=${CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.triggerBindingCount}; trigger-binding-dataset-sha256=${CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.triggerBindingDatasetSha256}; trigger-relation-lock-count=${CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.triggerRelationLockPlanCount}; trigger-relation-lock-sha256=${CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.triggerRelationLockPlanSha256}; event-trigger-binding-count=${CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.eventTriggerBindingCount}; event-trigger-binding-dataset-sha256=${CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.eventTriggerBindingDatasetSha256}; post-toggle-default-acl-evidence-sha256=${CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.postToggleDefaultAclBaseline.externalEvidenceSha256}; ledger-target-baseline-evidence-sha256=${CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.ledgerTargetBaseline.externalEvidenceSha256}; evidence-source-revision=${CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.observationSourceRevision}.\n`
      : '') +
    `-- Repository-derived (not live-observed) clinical treatment session ACL manifest: sha256=${REPOSITORY_DERIVED_CLINICAL_TREATMENT_SESSION_ACL_MANIFEST.sha256}; source-migration=${REPOSITORY_DERIVED_CLINICAL_TREATMENT_SESSION_ACL_MANIFEST.sourceMigration}; source-sha256=${REPOSITORY_DERIVED_CLINICAL_TREATMENT_SESSION_ACL_MANIFEST.sourceMigrationSha256}.\n` +
    `-- Run only after every ordered migration's intended schema effect is present in the isolated, empty staging database and provenance has been reviewed.\n` +
    (verificationOnly
      ? `begin isolation level repeatable read read only;\n` +
        canonicalCatalogOutputGucSql +
        `set local statement_timeout = '60s';\n` +
        `set local lock_timeout = '5s';\n`
      : `begin isolation level repeatable read read write;\n` +
        canonicalCatalogOutputGucSql) +
    `set local search_path = pg_catalog, pg_temp, public;\n` +
    `do $ledger_guard$\n` +
    `declare\n` +
    `  v_missing text;\n` +
    `  v_function_body text;\n` +
    `  v_transactional_rows bigint;\n` +
    `  v_trigger_function_count bigint;\n` +
    `  v_trigger_function_payload text;\n` +
    `  v_trigger_binding_count bigint;\n` +
    `  v_trigger_binding_payload text;\n` +
    `  v_repair_xid text;\n` +
    `  v_observed_system_identifier text;\n` +
    `  v_observed_current_database text := pg_catalog.current_database();\n` +
    `  v_observed_session_user text := session_user;\n` +
    `  v_observed_current_user text := current_user;\n` +
    (isChananyaPreReconciliation
      ? `  v_acl_all_routines constant text[] := ${sqlArray(classifiedRoutineSignatures)};\n` +
        `  v_acl_trigger_handlers constant text[] := ${sqlArray(
          CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST
            .routineDispositions.owner_only_trigger
        )};\n` +
        `  v_acl_event_handlers constant text[] := ${sqlArray(
          CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST
            .routineDispositions.owner_only_event_trigger
        )};\n` +
        `  v_acl_path_plan constant jsonb := ${quote(
          JSON.stringify(reviewedSecurityDefinerPathPlan)
        )}::jsonb;\n` +
        `  v_acl_actual text[];\n` +
        `  v_acl_expected text[];\n` +
        `  v_acl_row_count bigint;\n` +
        `  v_acl_payload text;\n` +
        `  v_trigger_stable_bytes bigint;\n` +
        `  v_trigger_stable_sha256 text;\n` +
        `  v_event_trigger_stable_bytes bigint;\n` +
        `  v_event_trigger_stable_sha256 text;\n`
      : '') +
    `begin\n` +
    `  if v_observed_current_database is distinct from ${quote(expectedDatabaseName)}\n` +
    `     or v_observed_session_user is distinct from ${quote(expectedDatabaseUser)}\n` +
    `     or v_observed_current_user is distinct from ${quote(expectedDatabaseUser)} then\n` +
    `    raise exception '${verificationOnly ? 'CNYOS_STAGING_VERIFICATION' : 'CNYOS_LEDGER_REPAIR'}_SERVER_IDENTITY_REFUSED: expected database=% session_user=% current_user=%; observed database=% session_user=% current_user=%',\n` +
    `      ${quote(expectedDatabaseName)},${quote(expectedDatabaseUser)},${quote(expectedDatabaseUser)},\n` +
    `      coalesce(v_observed_current_database,'NULL'),coalesce(v_observed_session_user,'NULL'),\n` +
    `      coalesce(v_observed_current_user,'NULL');\n` +
    `  end if;\n` +
    (verificationOnly
      ? `  if current_setting('transaction_read_only') <> 'on' then\n` +
        `    raise exception 'STAGING_VERIFICATION_READ_ONLY_REQUIRED';\n` +
        `  end if;\n` +
        `  if current_setting('transaction_isolation') <> 'repeatable read' then\n` +
        `    raise exception 'STAGING_VERIFICATION_REPEATABLE_READ_REQUIRED';\n` +
        `  end if;\n` +
        `  if not exists (select 1 from pg_roles where rolname=current_user and (rolsuper or rolbypassrls)) then\n` +
        `    raise exception 'STAGING_VERIFICATION_CATALOG_READER_REQUIRED';\n` +
        `  end if;\n` +
        `  select system_identifier::text into v_observed_system_identifier\n` +
        `  from pg_catalog.pg_control_system();\n` +
        (isExactReviewedChananyaStagingTarget(target)
          ? `  if v_observed_system_identifier is distinct from ${quote(CHANANYA_REVIEWED_SYSTEM_IDENTIFIER)} then\n` +
            `    raise exception 'CNYOS_STAGING_VERIFICATION_WRONG_CLUSTER: observed system_identifier=%',\n` +
            `      coalesce(v_observed_system_identifier,'NULL');\n` +
            `  end if;\n`
          : '') +
        `  perform pg_catalog.pg_advisory_xact_lock(202608302100::bigint);\n`
      : `  if current_setting('transaction_read_only') <> 'off' then\n` +
        `    raise exception 'STAGING_LEDGER_REPAIR_READ_WRITE_REQUIRED';\n` +
        `  end if;\n` +
        `  if current_setting('transaction_isolation') <> 'repeatable read' then\n` +
        `    raise exception 'STAGING_LEDGER_REPAIR_REPEATABLE_READ_REQUIRED';\n` +
        `  end if;\n` +
        `  select system_identifier::text into v_observed_system_identifier\n` +
        `  from pg_catalog.pg_control_system();\n` +
        `  if v_observed_system_identifier is distinct from ${quote(CHANANYA_REVIEWED_SYSTEM_IDENTIFIER)} then\n` +
        `    raise exception 'CNYOS_LEDGER_REPAIR_WRONG_CLUSTER: observed system_identifier=%',\n` +
        `      coalesce(v_observed_system_identifier,'NULL');\n` +
        `  end if;\n` +
        repairAuthorizationBlockerSql +
        `  if coalesce(current_setting(${quote(repairRunNonceGuc)},true),'') !~\n` +
        `      '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then\n` +
        `    raise exception 'STAGING_LEDGER_REPAIR_RUN_NONCE_REQUIRED';\n` +
        `  end if;\n` +
        `  v_repair_xid := pg_catalog.pg_current_xact_id()::text;\n` +
        `  perform pg_catalog.pg_advisory_xact_lock(202608302100::bigint);\n` +
        `  execute 'drop table if exists pg_temp.${repairEvidenceMarker}';\n`) +
    (isChananyaPreReconciliation
      ? buildClassifiedCompleteAclGuardSql()
      : `  select string_agg(procedure_signature, ', ' order by procedure_signature) into v_missing\n` +
    `  from (values ${sqlRows(expectedTriggerInventory)}) expected(\n` +
    `    procedure_signature,expected_owner,expected_search_path,expected_security_definer,expected_binding_count\n` +
    `  )\n` +
    `  where not exists (\n` +
    `    select 1\n` +
    `    from pg_proc p\n` +
    `    join pg_namespace n on n.oid=p.pronamespace\n` +
    `    join pg_roles owner_role on owner_role.oid=p.proowner\n` +
    `    where p.oid=to_regprocedure(procedure_signature)\n` +
    `      and n.nspname='public' and p.prokind='f'\n` +
    `      and owner_role.rolname=expected_owner\n` +
    `      and p.prosecdef=expected_security_definer::boolean\n` +
    `      and coalesce(array_to_string(p.proconfig,','),'')=expected_search_path\n` +
    `      and (select count(*) from pg_trigger t where t.tgfoid=p.oid and not t.tgisinternal)=\n` +
    `          expected_binding_count::bigint\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_TRIGGER_FUNCTION_INVENTORY_OR_STATE_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',\n` +
    `    ', ' order by n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)\n` +
    `  ) into v_missing\n` +
    `  from pg_proc p\n` +
    `  join pg_namespace n on n.oid=p.pronamespace\n` +
    `  where n.nspname='public' and p.prokind='f'\n` +
    `    and exists (select 1 from pg_trigger t where t.tgfoid=p.oid and not t.tgisinternal)\n` +
    `    and not exists (\n` +
    `      select 1 from (values ${sqlRows(expectedTriggerInventory)}) expected(\n` +
    `        procedure_signature,expected_owner,expected_search_path,expected_security_definer,expected_binding_count\n` +
    `      ) where to_regprocedure(procedure_signature)=p.oid\n` +
    `    );\n` +
    `  if v_missing is not null then raise exception 'STAGING_TRIGGER_FUNCTION_INVENTORY_UNEXPECTED: %', v_missing; end if;\n` +
    `\n` +
    buildTriggerSemanticAndBindingGuardSql({
      expectedSemanticPayloadBytes: expectedTriggerSemanticPayloadBytes,
      expectedSemanticSha256: expectedTriggerSemanticSha256
    }) +
    triggerAclMissingGuardSql +
    `  select string_agg(\n` +
    `    p.oid::regprocedure::text || ' -> ' || coalesce(grantee.rolname,'PUBLIC') || ':' || acl.privilege_type,\n` +
    `    ', ' order by p.oid::regprocedure::text,coalesce(grantee.rolname,'PUBLIC'),acl.privilege_type\n` +
    `  ) into v_missing\n` +
    `  from pg_proc p\n` +
    `  join pg_namespace n on n.oid=p.pronamespace\n` +
    `  cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl\n` +
    `  left join pg_roles grantee on grantee.oid=acl.grantee\n` +
    `  where n.nspname='public' and p.prokind='f'\n` +
    `    and exists (select 1 from pg_trigger t where t.tgfoid=p.oid and not t.tgisinternal)\n` +
    `    and acl.grantee <> p.proowner\n` +
    `    and (${triggerAclInvalidPredicate});\n` +
    `  if v_missing is not null then raise exception 'STAGING_TRIGGER_FUNCTION_ACL_INVALID: %', v_missing; end if;\n` +
    `\n` +
    (isChananyaPreReconciliation ? '' :
      `  select string_agg(p.oid::regprocedure::text || ' -> ' || runtime_role, ', ' order by p.oid::regprocedure::text,runtime_role) into v_missing\n` +
      `  from pg_proc p\n` +
      `  join pg_namespace n on n.oid=p.pronamespace\n` +
      `  cross join unnest(array['anon','authenticated','service_role']::text[]) runtime(runtime_role)\n` +
      `  where n.nspname='public' and p.prokind='f'\n` +
      `    and exists (select 1 from pg_trigger t where t.tgfoid=p.oid and not t.tgisinternal)\n` +
      `    and has_function_privilege(runtime_role,p.oid,'EXECUTE');\n` +
      `  if v_missing is not null then raise exception 'STAGING_TRIGGER_FUNCTION_RUNTIME_EXECUTE_PRESENT: %', v_missing; end if;\n\n`)) +
    `  select string_agg(object_name, ', ' order by object_name) into v_missing\n` +
    `  from unnest(${sqlArray(requiredRelations)}) expected(object_name)\n` +
    `  where to_regclass(object_name) is null;\n` +
    `  if v_missing is not null then raise exception 'STAGING_SCHEMA_RELATIONS_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(function_name, ', ' order by function_name) into v_missing\n` +
    `  from unnest(${sqlArray(requiredFunctions)}) expected(function_name)\n` +
    `  where not exists (\n` +
    `    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace\n` +
    `    where n.nspname='public' and p.proname=function_name\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SCHEMA_FUNCTIONS_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature, ', ' order by procedure_signature) into v_missing\n` +
    `  from unnest(${sqlArray(requiredProcedures)}) expected(procedure_signature)\n` +
    `  where to_regprocedure(procedure_signature) is null;\n` +
    `  if v_missing is not null then raise exception 'STAGING_SCHEMA_PROCEDURES_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  if not exists (\n` +
    `    select 1\n` +
    `    from pg_proc p\n` +
    `    join pg_namespace function_namespace on function_namespace.oid=p.pronamespace\n` +
    `    join pg_roles owner_role on owner_role.oid=p.proowner\n` +
    `    join pg_language language on language.oid=p.prolang\n` +
    `    where p.oid=to_regprocedure(${quote(createClinicalTreatmentSessionSignature)})\n` +
    `      and function_namespace.nspname='public'\n` +
    `      and owner_role.rolname=${quote(REPOSITORY_DERIVED_CLINICAL_TREATMENT_SESSION_ACL_MANIFEST.semanticContract.owner)}\n` +
    `      and language.lanname=${quote(REPOSITORY_DERIVED_CLINICAL_TREATMENT_SESSION_ACL_MANIFEST.semanticContract.language)}\n` +
    `      and p.prokind=${quote(REPOSITORY_DERIVED_CLINICAL_TREATMENT_SESSION_ACL_MANIFEST.semanticContract.kind)}::\"char\"\n` +
    `      and not p.prosecdef and not p.proleakproof and not p.proisstrict\n` +
    `      and not p.proretset and p.provolatile='v' and p.proparallel='u'\n` +
    `      and p.prorettype=to_regtype(${quote(REPOSITORY_DERIVED_CLINICAL_TREATMENT_SESSION_ACL_MANIFEST.semanticContract.resultType)})\n` +
    `      and p.pronargs=${REPOSITORY_DERIVED_CLINICAL_TREATMENT_SESSION_ACL_MANIFEST.semanticContract.argumentCount}\n` +
    `      and p.pronargdefaults=${REPOSITORY_DERIVED_CLINICAL_TREATMENT_SESSION_ACL_MANIFEST.semanticContract.defaultArgumentCount}\n` +
    `      and p.proargmodes is null\n` +
    `      and p.proargnames=array[\n` +
    `        'p_encounter_id','p_treatment_modalities','p_treatment_detail',\n` +
    `        'p_procedure_referral','p_procedure_referral_detail','p_precautions',\n` +
    `        'p_pain_before','p_pain_after','p_outcome_summary','p_advice'\n` +
    `      ]::text[]\n` +
    `      and p.proconfig=array[${quote(REPOSITORY_DERIVED_CLINICAL_TREATMENT_SESSION_ACL_MANIFEST.semanticContract.searchPath)}]::text[]\n` +
    `      and octet_length(btrim(regexp_replace(lower(p.prosrc),'[[:space:]]+',' ','g')))=\n` +
    `          ${REPOSITORY_DERIVED_CLINICAL_TREATMENT_SESSION_ACL_MANIFEST.semanticContract.normalizedBodyPayloadBytes}\n` +
    `      and encode(sha256(convert_to(\n` +
    `        btrim(regexp_replace(lower(p.prosrc),'[[:space:]]+',' ','g')),\n` +
    `        'UTF8'\n` +
    `      )),'hex')=${quote(REPOSITORY_DERIVED_CLINICAL_TREATMENT_SESSION_ACL_MANIFEST.semanticContract.normalizedBodySha256)}\n` +
    `  ) then raise exception 'STAGING_CLINICAL_TREATMENT_SESSION_SEMANTIC_CONTRACT_INVALID'; end if;\n` +
    `\n` +
    `  select string_agg(expected_grantee, ', ' order by expected_grantee) into v_missing\n` +
    `  from (values ${sqlRows(clinicalTreatmentSessionDirectAclGrants)}) expected(expected_grantee)\n` +
    `  join pg_proc p on p.oid=to_regprocedure(${quote(createClinicalTreatmentSessionSignature)})\n` +
    `  where not exists (\n` +
    `    select 1\n` +
    `    from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl\n` +
    `    left join pg_roles granted_role on granted_role.oid=acl.grantee\n` +
    `    where coalesce(granted_role.rolname,'PUBLIC')=expected_grantee\n` +
    `      and acl.privilege_type='EXECUTE' and not acl.is_grantable\n` +
    `      and acl.grantor=p.proowner\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_CLINICAL_TREATMENT_SESSION_ACL_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(runtime_role, ', ' order by runtime_role) into v_missing\n` +
    `  from (values ${sqlRows(clinicalTreatmentSessionRuntimeAcl)}) expected(\n` +
    `    runtime_role,expected_execute\n` +
    `  )\n` +
    `  where has_function_privilege(\n` +
    `    runtime_role,${quote(createClinicalTreatmentSessionSignature)},'EXECUTE'\n` +
    `  ) is distinct from expected_execute::boolean;\n` +
    `  if v_missing is not null then raise exception 'STAGING_CLINICAL_TREATMENT_SESSION_RUNTIME_EXECUTE_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    coalesce(granted_role.rolname,'PUBLIC') || ':' || acl.privilege_type,\n` +
    `    ', ' order by coalesce(granted_role.rolname,'PUBLIC'),acl.privilege_type\n` +
    `  ) into v_missing\n` +
    `  from pg_proc p\n` +
    `  cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl\n` +
    `  left join pg_roles granted_role on granted_role.oid=acl.grantee\n` +
    `  where p.oid=to_regprocedure(${quote(createClinicalTreatmentSessionSignature)})\n` +
    `    and acl.grantee<>p.proowner\n` +
    `    and (\n` +
    `      acl.privilege_type<>'EXECUTE' or acl.is_grantable or acl.grantor<>p.proowner\n` +
    `      or not exists (\n` +
    `        select 1\n` +
    `        from (values ${sqlRows(clinicalTreatmentSessionDirectAclGrants)}) expected(expected_grantee)\n` +
    `        where expected_grantee=coalesce(granted_role.rolname,'PUBLIC')\n` +
    `      )\n` +
    `    );\n` +
    `  if v_missing is not null then raise exception 'STAGING_CLINICAL_TREATMENT_SESSION_ACL_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(column_ref, ', ' order by column_ref) into v_missing\n` +
    `  from unnest(${sqlArray(requiredColumns)}) expected(column_ref)\n` +
    `  where not exists (\n` +
    `    select 1 from information_schema.columns c\n` +
    `    where c.table_schema='public'\n` +
    `      and c.table_name=split_part(column_ref,'.',1)\n` +
    `      and c.column_name=split_part(column_ref,'.',2)\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SCHEMA_COLUMNS_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(column_ref, ', ' order by column_ref) into v_missing\n` +
    `  from unnest(${sqlArray(requiredNotNullUuidColumns)}) expected(column_ref)\n` +
    `  where not exists (\n` +
    `    select 1 from information_schema.columns c\n` +
    `    where c.table_schema='public'\n` +
    `      and c.table_name=split_part(column_ref,'.',1)\n` +
    `      and c.column_name=split_part(column_ref,'.',2)\n` +
    `      and c.data_type='uuid' and c.is_nullable='NO'\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SUBSCRIPTION_TENANT_COLUMNS_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(relation_name || ':' || constraint_name, ', ' order by relation_name,constraint_name) into v_missing\n` +
    `  from (values ${sqlRows(requiredTenantForeignKeys)}) expected(\n` +
    `    relation_name,constraint_name,referenced_relation,local_columns,referenced_columns,delete_action\n` +
    `  )\n` +
    `  where not exists (\n` +
    `    select 1 from pg_constraint c\n` +
    `    where c.conrelid=to_regclass(relation_name)\n` +
    `      and c.conname=constraint_name and c.contype='f' and c.convalidated\n` +
    `      and c.confrelid=to_regclass(referenced_relation)\n` +
    `      and c.confdeltype=delete_action::\"char\"\n` +
    `      and (\n` +
    `        select array_agg(a.attname::text order by key.ordinality)\n` +
    `        from unnest(c.conkey) with ordinality key(attnum,ordinality)\n` +
    `        join pg_attribute a on a.attrelid=c.conrelid and a.attnum=key.attnum\n` +
    `      )=string_to_array(local_columns,',')\n` +
    `      and (\n` +
    `        select array_agg(a.attname::text order by key.ordinality)\n` +
    `        from unnest(c.confkey) with ordinality key(attnum,ordinality)\n` +
    `        join pg_attribute a on a.attrelid=c.confrelid and a.attnum=key.attnum\n` +
    `      )=string_to_array(referenced_columns,',')\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SUBSCRIPTION_TENANT_FOREIGN_KEYS_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(function_name, ', ' order by function_name) into v_missing\n` +
    `  from unnest(${sqlArray(requiredSecurityDefiners)}) expected(function_name)\n` +
    `  where not exists (\n` +
    `    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace\n` +
    `    where n.nspname='public' and p.proname=function_name and p.prosecdef\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SECURITY_DEFINERS_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature, ', ' order by procedure_signature) into v_missing\n` +
    `  from unnest(${sqlArray(requiredSecurityDefinerProcedures)}) expected(procedure_signature)\n` +
    `  where not exists (\n` +
    `    select 1 from pg_proc p\n` +
    `    where p.oid=to_regprocedure(procedure_signature) and p.prosecdef\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_EXACT_SECURITY_DEFINERS_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(relation_name, ', ' order by relation_name) into v_missing\n` +
    `  from unnest(${sqlArray(requiredRlsRelations)}) expected(relation_name)\n` +
    `  where not exists (\n` +
    `    select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace\n` +
    `    where n.nspname=split_part(relation_name,'.',1)\n` +
    `      and c.relname=split_part(relation_name,'.',2) and c.relrowsecurity\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_OWNER_DRIVE_RLS_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(relation_name, ', ' order by relation_name) into v_missing\n` +
    `  from unnest(${sqlArray(requiredForceRlsRelations)}) expected(relation_name)\n` +
    `  where not exists (\n` +
    `    select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace\n` +
    `    where n.nspname=split_part(relation_name,'.',1)\n` +
    `      and c.relname=split_part(relation_name,'.',2) and c.relforcerowsecurity\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_OWNER_REPLAY_GUARD_FORCE_RLS_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(relation_name || ':' || policy_name, ', ' order by relation_name,policy_name) into v_missing\n` +
    `  from (values ${sqlRows(requiredTenantPolicies)}) expected(\n` +
    `    relation_name,policy_name,policy_command,exact_qual,exact_with_check\n` +
    `  )\n` +
    `  where not exists (\n` +
    `    select 1 from pg_policy p\n` +
    `    where p.polrelid=to_regclass(relation_name)\n` +
    `      and p.polname=policy_name and p.polpermissive\n` +
    `      and p.polcmd=policy_command::\"char\"\n` +
    `      and p.polroles=array[(select oid from pg_roles where rolname='authenticated')]\n` +
    `      and regexp_replace(lower(pg_get_expr(p.polqual,p.polrelid)),'[[:space:]]+','','g')=exact_qual\n` +
    `      and regexp_replace(lower(coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'')),'[[:space:]]+','','g')=exact_with_check\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SUBSCRIPTION_TENANT_POLICY_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    relation_name || ' -> ' || coalesce(grantee.rolname,'PUBLIC') || ':' || acl.privilege_type,\n` +
    `    ', ' order by relation_name,coalesce(grantee.rolname,'PUBLIC'),acl.privilege_type\n` +
    `  ) into v_missing\n` +
    `  from unnest(${sqlArray(ownerReplayGuardClosedRelations)}) expected(relation_name)\n` +
    `  join pg_class c on c.oid=to_regclass(relation_name)\n` +
    `  cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl\n` +
    `  left join pg_roles grantee on grantee.oid=acl.grantee\n` +
    `  where acl.grantee <> c.relowner;\n` +
    `  if v_missing is not null then raise exception 'STAGING_OWNER_REPLAY_GUARD_DIRECT_GRANTS_PRESENT: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    relation_name || '.' || a.attname || ' -> ' || coalesce(grantee.rolname,'PUBLIC') || ':' || acl.privilege_type,\n` +
    `    ', ' order by relation_name,a.attname,coalesce(grantee.rolname,'PUBLIC'),acl.privilege_type\n` +
    `  ) into v_missing\n` +
    `  from unnest(${sqlArray(ownerReplayGuardClosedRelations)}) expected(relation_name)\n` +
    `  join pg_class c on c.oid=to_regclass(relation_name)\n` +
    `  join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped\n` +
    `  cross join lateral aclexplode(coalesce(a.attacl,acldefault('c',c.relowner))) acl\n` +
    `  left join pg_roles grantee on grantee.oid=acl.grantee\n` +
    `  where acl.grantee <> c.relowner;\n` +
    `  if v_missing is not null then raise exception 'STAGING_OWNER_REPLAY_GUARD_DIRECT_GRANTS_PRESENT: %', v_missing; end if;\n` +
    `\n` +
    `  if exists (\n` +
    `    select 1 from pg_policies\n` +
    `    where schemaname='public' and tablename='owner_control_historical_replay_guard'\n` +
    `  ) then raise exception 'STAGING_OWNER_REPLAY_GUARD_POLICIES_PRESENT'; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    relation_name || ' -> ' || grantee || ':' || privilege,\n` +
    `    ', ' order by relation_name,grantee,privilege\n` +
    `  ) into v_missing\n` +
    `  from unnest(${sqlArray(ownerDriveClosedRelations)}) expected(relation_name)\n` +
    `  cross join unnest(array['anon','authenticated','service_role']::text[]) target(grantee)\n` +
    `  cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']::text[]) action(privilege)\n` +
    `  where has_table_privilege(grantee, relation_name, privilege)\n` +
    `     or case when privilege in ('SELECT','INSERT','UPDATE','REFERENCES')\n` +
    `       then has_any_column_privilege(grantee,relation_name,privilege)\n` +
    `       else false end;\n` +
    `  if v_missing is not null then raise exception 'STAGING_OWNER_DRIVE_DIRECT_GRANTS_PRESENT: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(relation_name || ' -> ' || owner_role.rolname, ', ' order by relation_name) into v_missing\n` +
    `  from unnest(${sqlArray(sensitiveClosedRelations)}) expected(relation_name)\n` +
    `  join pg_class c on c.oid=to_regclass(relation_name)\n` +
    `  join pg_roles owner_role on owner_role.oid=c.relowner\n` +
    `  where owner_role.rolname in ('anon','authenticated','service_role');\n` +
    `  if v_missing is not null then raise exception 'STAGING_SENSITIVE_CLOSED_RELATION_RUNTIME_OWNER: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(relation_name, ', ' order by relation_name) into v_missing\n` +
    `  from unnest(${sqlArray(sensitiveClosedRelations)}) expected(relation_name)\n` +
    `  join pg_class c on c.oid=to_regclass(relation_name)\n` +
    `  where c.relowner <> (select relowner from pg_class where oid=to_regclass('public.clinics'));\n` +
    `  if v_missing is not null then raise exception 'STAGING_SENSITIVE_RELATION_OWNER_MISMATCH: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature, ', ' order by procedure_signature) into v_missing\n` +
    `  from unnest(${sqlArray(ownerDriveServiceRoleOnlyProcedures)}) expected(procedure_signature)\n` +
    `  where not has_function_privilege('service_role', procedure_signature, 'EXECUTE');\n` +
    `  if v_missing is not null then raise exception 'STAGING_OWNER_DRIVE_SERVICE_ROLE_EXECUTE_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    procedure_signature || ' -> ' || grantee,\n` +
    `    ', ' order by procedure_signature,grantee\n` +
    `  ) into v_missing\n` +
    `  from unnest(${sqlArray(ownerDriveServiceRoleOnlyProcedures)}) expected(procedure_signature)\n` +
    `  cross join unnest(array['anon','authenticated']::text[]) target(grantee)\n` +
    `  where has_function_privilege(grantee, procedure_signature, 'EXECUTE');\n` +
    `  if v_missing is not null then raise exception 'STAGING_OWNER_DRIVE_BROWSER_EXECUTE_PRESENT: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature, ', ' order by procedure_signature) into v_missing\n` +
    `  from unnest(${sqlArray(ownerSubscriptionServiceRoleOnlyProcedures)}) expected(procedure_signature)\n` +
    `  where not has_function_privilege('service_role', procedure_signature, 'EXECUTE');\n` +
    `  if v_missing is not null then raise exception 'STAGING_OWNER_SUBSCRIPTION_SERVICE_ROLE_EXECUTE_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    procedure_signature || ' -> ' || grantee,\n` +
    `    ', ' order by procedure_signature,grantee\n` +
    `  ) into v_missing\n` +
    `  from unnest(${sqlArray(ownerSubscriptionServiceRoleOnlyProcedures)}) expected(procedure_signature)\n` +
    `  cross join unnest(array['anon','authenticated']::text[]) target(grantee)\n` +
    `  where has_function_privilege(grantee, procedure_signature, 'EXECUTE');\n` +
    `  if v_missing is not null then raise exception 'STAGING_OWNER_SUBSCRIPTION_BROWSER_EXECUTE_PRESENT: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(target.grantee, ', ' order by target.grantee) into v_missing\n` +
    `  from unnest(array['anon','authenticated','service_role']::text[]) target(grantee)\n` +
    `  where has_table_privilege(grantee, 'public.clinics', 'UPDATE')\n` +
    `     or has_any_column_privilege(grantee, 'public.clinics', 'UPDATE');\n` +
    `  if v_missing is not null then raise exception 'STAGING_OWNER_SUBSCRIPTION_DIRECT_UPDATE_PRESENT: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    procedure_signature || ' -> ' || coalesce(grantee.rolname,'PUBLIC') || ':' || acl.privilege_type,\n` +
    `    ', ' order by procedure_signature,coalesce(grantee.rolname,'PUBLIC'),acl.privilege_type\n` +
    `  ) into v_missing\n` +
    `  from unnest(${sqlArray(ownerSubscriptionClosedProcedures)}) expected(procedure_signature)\n` +
    `  join pg_proc p on p.oid=to_regprocedure(procedure_signature)\n` +
    `  cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl\n` +
    `  left join pg_roles grantee on grantee.oid=acl.grantee\n` +
    `  where acl.grantee <> p.proowner;\n` +
    `  if v_missing is not null then raise exception 'STAGING_OWNER_SUBSCRIPTION_INTERNAL_EXECUTE_PRESENT: %', v_missing; end if;\n` +
    `\n` +
    `  select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') into v_function_body\n` +
    `  from pg_proc p\n` +
    `  where p.oid=to_regprocedure('public.set_clinic_subscription_state(uuid,uuid,text,boolean,bigint,text,uuid,text)');\n` +
    `  if v_function_body is null\n` +
    `     or position('pg_catalog.set_config' in v_function_body)=0\n` +
    `     or position('cnyos.owner_subscription_forward_guard' in v_function_body)=0\n` +
    `     or position('service-role-rpc/v1' in v_function_body)=0\n` +
    `     or position('v_result := public.set_clinic_subscription_state_v20260901' in v_function_body)=0\n` +
    `     or position('return v_result' in v_function_body)=0\n` +
    `     or position('exception when others then' in v_function_body)=0\n` +
    `     or (\n` +
    `       length(v_function_body)-length(replace(v_function_body,'cnyos.owner_subscription_forward_guard',''))\n` +
    `     )/length('cnyos.owner_subscription_forward_guard') <> 3 then\n` +
    `    raise exception 'STAGING_OWNER_SUBSCRIPTION_FORWARD_WRAPPER_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') into v_function_body\n` +
    `  from pg_proc p\n` +
    `  where p.oid=to_regprocedure('public.set_clinic_subscription_state_v20260901(uuid,uuid,text,boolean,bigint,text,uuid,text)');\n` +
    `  if v_function_body is null\n` +
    `     or position('pg_catalog.pg_advisory_xact_lock' in v_function_body)=0\n` +
    `     or position('for update' in v_function_body)=0\n` +
    `     or position('v_existing.expected_version <> p_expected_version' in v_function_body)=0\n` +
    `     or position('subscription_version = p_expected_version' in v_function_body)=0\n` +
    `     or position('insert into public.clinic_subscription_control_events' in v_function_body)=0 then\n` +
    `    raise exception 'STAGING_OWNER_SUBSCRIPTION_CONCURRENCY_IMPLEMENTATION_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') into v_function_body\n` +
    `  from pg_proc p\n` +
    `  where p.oid=to_regprocedure('public.guard_owner_subscription_forward_only()');\n` +
    `  if v_function_body is null\n` +
    `     or position('auth.role() <> ''service_role''' in v_function_body)=0\n` +
    `     or position('pg_catalog.current_setting' in v_function_body)=0\n` +
    `     or position('cnyos.owner_subscription_forward_guard' in v_function_body)=0\n` +
    `     or position('service-role-rpc/v1' in v_function_body)=0\n` +
    `     or position('cnyos_owner_subscription_historical_replay_blocked' in v_function_body)=0 then\n` +
    `    raise exception 'STAGING_OWNER_SUBSCRIPTION_FORWARD_GUARD_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature, ', ' order by procedure_signature) into v_missing\n` +
    `  from unnest(${sqlArray(subscriptionKillSwitchServiceRoleOnlyProcedures)}) expected(procedure_signature)\n` +
    `  where not has_function_privilege('service_role', procedure_signature, 'EXECUTE');\n` +
    `  if v_missing is not null then raise exception 'STAGING_SUBSCRIPTION_KILL_SWITCH_SERVICE_EXECUTE_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    procedure_signature || ' -> ' || grantee,\n` +
    `    ', ' order by procedure_signature,grantee\n` +
    `  ) into v_missing\n` +
    `  from unnest(${sqlArray(subscriptionKillSwitchServiceRoleOnlyProcedures)}) expected(procedure_signature)\n` +
    `  cross join unnest(array['anon','authenticated']::text[]) target(grantee)\n` +
    `  where has_function_privilege(grantee, procedure_signature, 'EXECUTE');\n` +
    `  if v_missing is not null then raise exception 'STAGING_SUBSCRIPTION_KILL_SWITCH_BROWSER_EXECUTE_PRESENT: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature || ' -> ' || expected_grantee, ', ' order by procedure_signature,expected_grantee) into v_missing\n` +
    `  from (values ${sqlRows(allowedSubscriptionBrowserProcedureGrants)}) expected(procedure_signature,expected_grantee)\n` +
    `  join pg_proc p on p.oid=to_regprocedure(procedure_signature)\n` +
    `  where not exists (\n` +
    `    select 1\n` +
    `    from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl\n` +
    `    join pg_roles granted_role on granted_role.oid=acl.grantee\n` +
    `    where granted_role.rolname=expected_grantee\n` +
    `      and acl.privilege_type='EXECUTE' and not acl.is_grantable\n` +
    `      and acl.grantor=p.proowner\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SUBSCRIPTION_BROWSER_RPC_ACL_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    procedure_signature || ' -> ' || coalesce(grantee.rolname,'PUBLIC') || ':' || acl.privilege_type,\n` +
    `    ', ' order by procedure_signature,coalesce(grantee.rolname,'PUBLIC'),acl.privilege_type\n` +
    `  ) into v_missing\n` +
    `  from unnest(${sqlArray(subscriptionKillSwitchBrowserProcedures)}) expected_procedure(procedure_signature)\n` +
    `  join pg_proc p on p.oid=to_regprocedure(procedure_signature)\n` +
    `  cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl\n` +
    `  left join pg_roles grantee on grantee.oid=acl.grantee\n` +
    `  where acl.grantee <> p.proowner\n` +
    `    and (\n` +
    `      acl.privilege_type <> 'EXECUTE' or acl.is_grantable or acl.grantor <> p.proowner\n` +
    `      or not exists (\n` +
    `        select 1\n` +
    `        from (values ${sqlRows(allowedSubscriptionBrowserProcedureGrants)}) expected_grant(expected_signature,expected_grantee)\n` +
    `        where expected_signature=procedure_signature\n` +
    `          and expected_grantee=coalesce(grantee.rolname,'PUBLIC')\n` +
    `      )\n` +
    `    );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SUBSCRIPTION_BROWSER_RPC_ACL_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature, ', ' order by procedure_signature) into v_missing\n` +
    `  from unnest(${sqlArray(subscriptionKillSwitchBrowserProcedures)}) expected(procedure_signature)\n` +
    `  where not has_function_privilege('authenticated', procedure_signature, 'EXECUTE');\n` +
    `  if v_missing is not null then raise exception 'STAGING_SUBSCRIPTION_BROWSER_EXECUTE_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature, ', ' order by procedure_signature) into v_missing\n` +
    `  from unnest(${sqlArray(subscriptionKillSwitchBrowserProcedures)}) expected(procedure_signature)\n` +
    `  where has_function_privilege('anon', procedure_signature, 'EXECUTE')\n` +
    `    and not exists (\n` +
    `      select 1\n` +
    `      from (values ${sqlRows(allowedSubscriptionBrowserProcedureGrants)}) allowed(allowed_signature,allowed_grantee)\n` +
    `      where allowed_signature=procedure_signature and allowed_grantee='anon'\n` +
    `    );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SUBSCRIPTION_UNEXPECTED_ANON_EXECUTE_PRESENT: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature, ', ' order by procedure_signature) into v_missing\n` +
    `  from unnest(${sqlArray(subscriptionKillSwitchClosedProcedures)}) expected(procedure_signature)\n` +
    `  where to_regprocedure(procedure_signature) is null;\n` +
    `  if v_missing is not null then raise exception 'STAGING_SUBSCRIPTION_LEGACY_PROCEDURE_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    procedure_signature || ' -> ' || coalesce(grantee.rolname,'PUBLIC') || ':' || acl.privilege_type,\n` +
    `    ', ' order by procedure_signature,coalesce(grantee.rolname,'PUBLIC'),acl.privilege_type\n` +
    `  ) into v_missing\n` +
    `  from unnest(${sqlArray(subscriptionKillSwitchClosedProcedures)}) expected(procedure_signature)\n` +
    `  join pg_proc p on p.oid=to_regprocedure(procedure_signature)\n` +
    `  cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl\n` +
    `  left join pg_roles grantee on grantee.oid=acl.grantee\n` +
    `  where acl.grantee <> p.proowner;\n` +
    `  if v_missing is not null then raise exception 'STAGING_SUBSCRIPTION_LEGACY_EXECUTE_PRESENT: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    procedure_signature || ' -> ' || coalesce(grantee.rolname,'PUBLIC') || ':' || acl.privilege_type,\n` +
    `    ', ' order by procedure_signature,coalesce(grantee.rolname,'PUBLIC'),acl.privilege_type\n` +
    `  ) into v_missing\n` +
    `  from unnest(${sqlArray(archiveClosedProcedures)}) expected(procedure_signature)\n` +
    `  join pg_proc p on p.oid=to_regprocedure(procedure_signature)\n` +
    `  cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl\n` +
    `  left join pg_roles grantee on grantee.oid=acl.grantee\n` +
    `  where acl.grantee <> p.proowner;\n` +
    `  if v_missing is not null then raise exception 'STAGING_ARCHIVE_DELEGATE_EXECUTE_PRESENT: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(archive_signature || ' -> ' || wrapper_signature, ', ' order by archive_signature) into v_missing\n` +
    `  from (values ${sqlRows(archiveOwnerPairs)}) expected(archive_signature,wrapper_signature)\n` +
    `  join pg_proc archive_proc on archive_proc.oid=to_regprocedure(archive_signature)\n` +
    `  join pg_proc wrapper_proc on wrapper_proc.oid=to_regprocedure(wrapper_signature)\n` +
    `  join pg_roles archive_owner on archive_owner.oid=archive_proc.proowner\n` +
    `  where archive_proc.proowner <> wrapper_proc.proowner\n` +
    `     or archive_owner.rolname in ('anon','authenticated','service_role');\n` +
    `  if v_missing is not null then raise exception 'STAGING_ARCHIVE_DELEGATE_OWNER_MISMATCH: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature, ', ' order by procedure_signature) into v_missing\n` +
    `  from unnest(${sqlArray(lineGatewayServiceRoleOnlyProcedures)}) expected(procedure_signature)\n` +
    `  where not has_function_privilege('service_role', procedure_signature, 'EXECUTE');\n` +
    `  if v_missing is not null then raise exception 'STAGING_LINE_GATEWAY_SERVICE_ROLE_EXECUTE_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    procedure_signature || ' -> ' || coalesce(grantee.rolname,'PUBLIC') || ':' || acl.privilege_type,\n` +
    `    ', ' order by procedure_signature,coalesce(grantee.rolname,'PUBLIC'),acl.privilege_type\n` +
    `  ) into v_missing\n` +
    `  from unnest(${sqlArray(lineGatewayServiceRoleOnlyProcedures)}) expected(procedure_signature)\n` +
    `  join pg_proc p on p.oid=to_regprocedure(procedure_signature)\n` +
    `  cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl\n` +
    `  left join pg_roles grantee on grantee.oid=acl.grantee\n` +
    `  where acl.grantee <> p.proowner\n` +
    `    and coalesce(grantee.rolname,'PUBLIC') <> 'service_role';\n` +
    `  if v_missing is not null then raise exception 'STAGING_LINE_GATEWAY_NON_SERVICE_EXECUTE_PRESENT: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature || ' -> ' || grantee, ', ' order by procedure_signature,grantee) into v_missing\n` +
    `  from unnest(${sqlArray(lineGatewayServiceRoleOnlyProcedures)}) expected(procedure_signature)\n` +
    `  cross join unnest(array['anon','authenticated']::text[]) target(grantee)\n` +
    `  where has_function_privilege(grantee, procedure_signature, 'EXECUTE');\n` +
    `  if v_missing is not null then raise exception 'STAGING_LINE_GATEWAY_NON_SERVICE_EXECUTE_PRESENT: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature || ' -> ' || owner_role.rolname, ', ' order by procedure_signature) into v_missing\n` +
    `  from unnest(${sqlArray(sensitiveOwnedProcedures)}) expected(procedure_signature)\n` +
    `  join pg_proc p on p.oid=to_regprocedure(procedure_signature)\n` +
    `  join pg_roles owner_role on owner_role.oid=p.proowner\n` +
    `  where owner_role.rolname in ('anon','authenticated','service_role');\n` +
    `  if v_missing is not null then raise exception 'STAGING_SENSITIVE_CLOSED_PROCEDURE_RUNTIME_OWNER: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature, ', ' order by procedure_signature) into v_missing\n` +
    `  from unnest(${sqlArray(sensitiveOwnedProcedures)}) expected(procedure_signature)\n` +
    `  join pg_proc p on p.oid=to_regprocedure(procedure_signature)\n` +
    `  where p.proowner <> (select relowner from pg_class where oid=to_regclass('public.clinics'));\n` +
    `  if v_missing is not null then raise exception 'STAGING_SENSITIVE_PROCEDURE_OWNER_MISMATCH: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature, ', ' order by procedure_signature) into v_missing\n` +
    `  from unnest(${sqlArray(hardenedSearchPathProcedures)}) expected(procedure_signature)\n` +
    `  join pg_proc p on p.oid=to_regprocedure(procedure_signature)\n` +
    `  where not exists (\n` +
    `    select 1 from unnest(coalesce(p.proconfig,array[]::text[])) setting(value)\n` +
    `    where replace(lower(setting.value),' ','')='search_path=pg_catalog,public'\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SUBSCRIPTION_SECURITY_DEFINER_SEARCH_PATH_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature, ', ' order by procedure_signature) into v_missing\n` +
    `  from (values\n` +
    `    ('public.finalize_line_oa_webhook_event(text,text,text,text,text)','v',false,'bool'),\n` +
    `    ('public.line_oa_webhook_evidence(timestamptz)','s',true,'record')\n` +
    `  ) expected(procedure_signature,expected_volatility,expected_set,expected_result)\n` +
    `  where not exists (\n` +
    `    select 1 from pg_proc p join pg_type t on t.oid=p.prorettype\n` +
    `    where p.oid=to_regprocedure(procedure_signature) and p.prosecdef\n` +
    `      and p.provolatile=expected_volatility::\"char\"\n` +
    `      and p.proretset=expected_set and t.typname=expected_result\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_LINE_GATEWAY_CONTRACT_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature, ', ' order by procedure_signature) into v_missing\n` +
    `  from (values\n` +
    `    ('public.finalize_line_oa_webhook_event(text,text,text,text,text)','update public.line_oa_gateway_webhook_events','processing_status = ''processing'''),\n` +
    `    ('public.line_oa_webhook_evidence(timestamptz)','from public.line_oa_gateway_webhook_events','created_at >= greatest')\n` +
    `  ) expected(procedure_signature,required_token_one,required_token_two)\n` +
    `  join pg_proc p on p.oid=to_regprocedure(procedure_signature)\n` +
    `  cross join lateral (\n` +
    `    select btrim(regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g')) source\n` +
    `  ) body\n` +
    `  where position(\n` +
    `    'begin if auth.role() is distinct from ''service_role'' then raise exception ''service_role_required''; end if;'\n` +
    `    in body.source\n` +
    `  ) <> 1\n` +
    `     or position(required_token_one in body.source)=0\n` +
    `     or position(required_token_two in body.source)=0;\n` +
    `  if v_missing is not null then raise exception 'STAGING_LINE_GATEWAY_ROLE_GATE_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature, ', ' order by procedure_signature) into v_missing\n` +
    `  from (values ${sqlRows(lineGatewayExactBodyContracts)}) expected(procedure_signature,exact_body)\n` +
    `  join pg_proc p on p.oid=to_regprocedure(procedure_signature)\n` +
    `  cross join lateral (\n` +
    `    select btrim(regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g')) source\n` +
    `  ) body\n` +
    `  where body.source <> exact_body;\n` +
    `  if v_missing is not null then raise exception 'STAGING_LINE_GATEWAY_BODY_FINGERPRINT_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  if not exists (\n` +
    `    select 1 from pg_proc p\n` +
    `    join pg_language l on l.oid=p.prolang\n` +
    `    join pg_type t on t.oid=p.prorettype\n` +
    `    where p.oid=to_regprocedure(${quote(lineOperationalHealthcheckProcedure)})\n` +
    `      and p.prokind='f' and l.lanname='sql' and p.provolatile='s'\n` +
    `      and p.prosecdef and p.proretset and t.typname='record'\n` +
    `      and pg_get_function_result(p.oid)=\n` +
    `        'TABLE(ready boolean, contact_count bigint, consent_count bigint, pending_count bigint, dead_count bigint)'\n` +
    `      and cardinality(coalesce(p.proconfig,array[]::text[]))=1\n` +
    `      and replace(lower(p.proconfig[1]),' ','')='search_path=public'\n` +
    `  ) then raise exception 'STAGING_LINE_HEALTHCHECK_CONTRACT_INVALID'; end if;\n` +
    `\n` +
    `  select string_agg(target.grantee, ', ' order by target.grantee) into v_missing\n` +
    `  from unnest(array['authenticated','service_role']::text[]) target(grantee)\n` +
    `  where not exists (\n` +
    `    select 1 from pg_proc p\n` +
    `    cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl\n` +
    `    join pg_roles granted_role on granted_role.oid=acl.grantee\n` +
    `    where p.oid=to_regprocedure(${quote(lineOperationalHealthcheckProcedure)})\n` +
    `      and granted_role.rolname=target.grantee and acl.privilege_type='EXECUTE'\n` +
    `      and not acl.is_grantable and acl.grantor=p.proowner\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_LINE_HEALTHCHECK_EXECUTE_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  if has_function_privilege('anon', ${quote(lineOperationalHealthcheckProcedure)}, 'EXECUTE') then\n` +
    `    raise exception 'STAGING_LINE_HEALTHCHECK_ANON_EXECUTE_PRESENT';\n` +
    `  end if;\n` +
    `\n` +
    `  select string_agg(expected_grantee || ':' || expected_privilege, ', ' order by expected_grantee,expected_privilege) into v_missing\n` +
    `  from (values ${sqlRows(exactPublicSchemaAclGrants)}) expected(expected_grantee,expected_privilege)\n` +
    `  where not exists (\n` +
    `    select 1\n` +
    `    from pg_namespace public_schema\n` +
    `    cross join lateral aclexplode(coalesce(\n` +
    `      public_schema.nspacl,acldefault('n',public_schema.nspowner)\n` +
    `    )) acl\n` +
    `    left join pg_roles grantee on grantee.oid=acl.grantee\n` +
    `    where public_schema.nspname='public'\n` +
    `      and acl.grantee <> public_schema.nspowner\n` +
    `      and coalesce(grantee.rolname,'PUBLIC')=expected_grantee\n` +
    `      and acl.privilege_type=expected_privilege\n` +
    `      and not acl.is_grantable and acl.grantor=public_schema.nspowner\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_PUBLIC_SCHEMA_ACL_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(coalesce(grantee.rolname,'PUBLIC') || ':' || acl.privilege_type, ', ' order by coalesce(grantee.rolname,'PUBLIC'),acl.privilege_type) into v_missing\n` +
    `  from pg_proc p\n` +
    `  cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl\n` +
    `  left join pg_roles grantee on grantee.oid=acl.grantee\n` +
    `  where p.oid=to_regprocedure(${quote(lineOperationalHealthcheckProcedure)})\n` +
    `    and acl.grantee <> p.proowner\n` +
    `    and (\n` +
    `      coalesce(grantee.rolname,'PUBLIC') not in ('authenticated','service_role')\n` +
    `      or acl.privilege_type <> 'EXECUTE' or acl.is_grantable\n` +
    `      or acl.grantor <> p.proowner\n` +
    `    );\n` +
    `  if v_missing is not null then raise exception 'STAGING_LINE_HEALTHCHECK_UNEXPECTED_EXECUTE_PRESENT: %', v_missing; end if;\n` +
    `\n` +
    `  select btrim(regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g')) into v_function_body\n` +
    `  from pg_proc p where p.oid=to_regprocedure(${quote(lineOperationalHealthcheckProcedure)});\n` +
    `  if v_function_body is distinct from ${quote(lineOperationalHealthcheckExactBody)} then\n` +
    `    raise exception 'STAGING_LINE_HEALTHCHECK_BODY_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature, ', ' order by procedure_signature) into v_missing\n` +
    `  from unnest(${sqlArray(exactServiceRoleOnlyProcedures)}) expected(procedure_signature)\n` +
    `  join pg_proc p on p.oid=to_regprocedure(procedure_signature)\n` +
    `  where not exists (\n` +
    `    select 1\n` +
    `    from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl\n` +
    `    join pg_roles granted_role on granted_role.oid=acl.grantee\n` +
    `    where granted_role.rolname='service_role'\n` +
    `      and acl.privilege_type='EXECUTE' and not acl.is_grantable\n` +
    `      and acl.grantor=p.proowner\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SERVICE_RPC_EXACT_EXECUTE_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    procedure_signature || ' -> ' || coalesce(grantee.rolname,'PUBLIC') || ':' || acl.privilege_type,\n` +
    `    ', ' order by procedure_signature,coalesce(grantee.rolname,'PUBLIC'),acl.privilege_type\n` +
    `  ) into v_missing\n` +
    `  from unnest(${sqlArray(exactServiceRoleOnlyProcedures)}) expected(procedure_signature)\n` +
    `  join pg_proc p on p.oid=to_regprocedure(procedure_signature)\n` +
    `  cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl\n` +
    `  left join pg_roles grantee on grantee.oid=acl.grantee\n` +
    `  where acl.grantee <> p.proowner\n` +
    `    and (\n` +
    `      coalesce(grantee.rolname,'PUBLIC') <> 'service_role'\n` +
    `      or acl.privilege_type <> 'EXECUTE' or acl.is_grantable\n` +
    `      or acl.grantor <> p.proowner\n` +
    `    );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SERVICE_RPC_ACL_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature, ', ' order by procedure_signature) into v_missing\n` +
    `  from unnest(${sqlArray(subscriptionKillSwitchServiceRoleOnlyProcedures)}) expected(procedure_signature)\n` +
    `  join pg_proc p on p.oid=to_regprocedure(procedure_signature)\n` +
    `  cross join lateral (\n` +
    `    select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') source\n` +
    `  ) body\n` +
    `  where procedure_signature <> 'public.assert_clinic_subscription_active(uuid)'\n` +
    `    and (\n` +
    `      position('auth.role()' in body.source)=0\n` +
    `      or position('service_role' in body.source)=0\n` +
    `      or (\n` +
    `        position('assert_clinic_subscription_active' in body.source)=0\n` +
    `        and position('prepare_line_subscription_off_exception' in body.source)=0\n` +
    `      )\n` +
    `    );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SUBSCRIPTION_SERVICE_RPC_GATE_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(n.nspname || '.' || c.relname, ', ' order by n.nspname,c.relname) into v_missing\n` +
    `  from pg_class c\n` +
    `  join pg_namespace n on n.oid=c.relnamespace\n` +
    `  where n.nspname='public' and c.relkind in ('r','p')\n` +
    `    and not c.relrowsecurity\n` +
    `    and (\n` +
    `      has_table_privilege('authenticated',c.oid,'SELECT')\n` +
    `      or has_table_privilege('authenticated',c.oid,'INSERT')\n` +
    `      or has_table_privilege('authenticated',c.oid,'UPDATE')\n` +
    `      or has_table_privilege('authenticated',c.oid,'DELETE')\n` +
    `      or has_any_column_privilege('authenticated',c.oid,'SELECT')\n` +
    `      or has_any_column_privilege('authenticated',c.oid,'INSERT')\n` +
    `      or has_any_column_privilege('authenticated',c.oid,'UPDATE')\n` +
    `    );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SUBSCRIPTION_BROWSER_TABLE_WITHOUT_RLS: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(n.nspname || '.' || c.relname, ', ' order by n.nspname,c.relname) into v_missing\n` +
    `  from pg_class c\n` +
    `  join pg_namespace n on n.oid=c.relnamespace\n` +
    `  where n.nspname='public' and c.relkind in ('r','p') and c.relrowsecurity\n` +
    `    and (\n` +
    `      has_table_privilege('authenticated',c.oid,'SELECT')\n` +
    `      or has_table_privilege('authenticated',c.oid,'INSERT')\n` +
    `      or has_table_privilege('authenticated',c.oid,'UPDATE')\n` +
    `      or has_table_privilege('authenticated',c.oid,'DELETE')\n` +
    `      or has_any_column_privilege('authenticated',c.oid,'SELECT')\n` +
    `      or has_any_column_privilege('authenticated',c.oid,'INSERT')\n` +
    `      or has_any_column_privilege('authenticated',c.oid,'UPDATE')\n` +
    `    )\n` +
    `    and not exists (\n` +
    `      select 1 from pg_policy p\n` +
    `      where p.polrelid=c.oid\n` +
    `        and p.polname='cnyos_active_subscription_boundary'\n` +
    `        and not p.polpermissive and p.polcmd='*'\n` +
    `        and p.polroles=array[(select oid from pg_roles where rolname='authenticated')]\n` +
    `        and replace(lower(pg_get_expr(p.polqual,p.polrelid)),' ','')\n` +
    `          in ('(current_clinic_id()isnotnull)','(public.current_clinic_id()isnotnull)')\n` +
    `        and replace(lower(pg_get_expr(p.polwithcheck,p.polrelid)),' ','')\n` +
    `          in ('(current_clinic_id()isnotnull)','(public.current_clinic_id()isnotnull)')\n` +
    `    );\n` +
    `  if v_missing is not null then raise exception 'STAGING_ACTIVE_SUBSCRIPTION_BOUNDARY_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(n.nspname || '.' || c.relname, ', ' order by n.nspname,c.relname) into v_missing\n` +
    `  from pg_class c\n` +
    `  join pg_namespace n on n.oid=c.relnamespace\n` +
    `  where n.nspname='public' and c.relkind='v'\n` +
    `    and (has_table_privilege('authenticated',c.oid,'SELECT')\n` +
    `      or has_any_column_privilege('authenticated',c.oid,'SELECT'))\n` +
    `    and not coalesce(c.reloptions,array[]::text[]) @> array['security_invoker=true']::text[];\n` +
    `  if v_missing is not null then raise exception 'STAGING_BROWSER_VIEW_SECURITY_INVOKER_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(n.nspname || '.' || c.relname, ', ' order by n.nspname,c.relname) into v_missing\n` +
    `  from pg_class c\n` +
    `  join pg_namespace n on n.oid=c.relnamespace\n` +
    `  where n.nspname='public' and c.relkind in ('r','p')\n` +
    `    and not exists (\n` +
    `      select 1 from pg_trigger t\n` +
    `      where t.tgrelid=c.oid\n` +
    `        and t.tgname='trg_cnyos_authenticated_subscription_statement_write'\n` +
    `        and not t.tgisinternal and t.tgenabled='O' and t.tgtype=30\n` +
    `        and t.tgfoid=to_regprocedure('public.enforce_authenticated_subscription_statement_write()')\n` +
    `    );\n` +
    `  if v_missing is not null then raise exception 'STAGING_AUTHENTICATED_SUBSCRIPTION_STATEMENT_TRIGGER_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(relation_name, ', ' order by relation_name) into v_missing\n` +
    `  from unnest(${sqlArray(activeSubscriptionWriteRelations)}) expected(relation_name)\n` +
    `  where not exists (\n` +
    `    select 1 from pg_trigger t\n` +
    `    where t.tgrelid=to_regclass(relation_name)\n` +
    `      and t.tgname='trg_cnyos_active_subscription_write'\n` +
    `      and not t.tgisinternal and t.tgenabled='O' and t.tgtype=31\n` +
    `      and t.tgfoid=to_regprocedure('public.enforce_active_subscription_tenant_write()')\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_ACTIVE_SUBSCRIPTION_WRITE_TRIGGER_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(relation_name || ':' || privilege, ', ' order by relation_name,privilege) into v_missing\n` +
    `  from (values ${sqlRows(exactServiceRoleDmlPrivileges)}) expected(relation_name,privilege)\n` +
    `  where not exists (\n` +
    `    select 1 from pg_class c\n` +
    `    cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl\n` +
    `    join pg_roles granted_role on granted_role.oid=acl.grantee\n` +
    `    where c.oid=to_regclass(relation_name) and granted_role.rolname='service_role'\n` +
    `      and acl.privilege_type=privilege and not acl.is_grantable\n` +
    `      and acl.grantor=c.relowner\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SERVICE_ROLE_DML_PRIVILEGES_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(n.nspname || '.' || c.relname || ':' || acl.privilege_type, ', ' order by n.nspname,c.relname,acl.privilege_type) into v_missing\n` +
    `  from pg_class c\n` +
    `  join pg_namespace n on n.oid=c.relnamespace\n` +
    `  cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl\n` +
    `  join pg_roles grantee on grantee.oid=acl.grantee\n` +
    `  where n.nspname='public' and c.relkind in ('r','p')\n` +
    `    and grantee.rolname='service_role'\n` +
    `    and acl.privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')\n` +
    `    and (\n` +
    `      acl.is_grantable or acl.grantor <> c.relowner\n` +
    `      or not exists (\n` +
    `        select 1 from (values ${sqlRows(exactServiceRoleDmlPrivileges)}) expected(relation_name,privilege)\n` +
    `        where relation_name=n.nspname || '.' || c.relname\n` +
    `          and privilege=acl.privilege_type\n` +
    `      )\n` +
    `    );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SERVICE_ROLE_DML_ACL_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(n.nspname || '.' || c.relname || '.' || a.attname || ':' || acl.privilege_type, ', ' order by n.nspname,c.relname,a.attname,acl.privilege_type) into v_missing\n` +
    `  from pg_class c\n` +
    `  join pg_namespace n on n.oid=c.relnamespace\n` +
    `  join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped\n` +
    `  cross join lateral aclexplode(coalesce(a.attacl,acldefault('c',c.relowner))) acl\n` +
    `  join pg_roles grantee on grantee.oid=acl.grantee\n` +
    `  where n.nspname='public' and c.relkind in ('r','p')\n` +
    `    and grantee.rolname='service_role'\n` +
    `    and acl.privilege_type in ('INSERT','UPDATE');\n` +
    `  if v_missing is not null then raise exception 'STAGING_SERVICE_ROLE_COLUMN_DML_ACL_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(n.nspname || '.' || c.relname || ':' || action.privilege, ', ' order by n.nspname,c.relname,action.privilege) into v_missing\n` +
    `  from pg_class c\n` +
    `  join pg_namespace n on n.oid=c.relnamespace\n` +
    `  cross join unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']::text[]) action(privilege)\n` +
    `  where n.nspname='public' and c.relkind in ('r','p')\n` +
    `    and (\n` +
    `      has_table_privilege('service_role',c.oid,action.privilege)\n` +
    `      or (action.privilege in ('INSERT','UPDATE')\n` +
    `        and has_any_column_privilege('service_role',c.oid,action.privilege))\n` +
    `    )\n` +
    `    and not exists (\n` +
    `      select 1\n` +
    `      from (values ${sqlRows(exactServiceRoleDmlPrivileges)}) expected(relation_name,privilege)\n` +
    `      where relation_name=n.nspname || '.' || c.relname\n` +
    `        and privilege=action.privilege\n` +
    `    );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SERVICE_ROLE_DML_PRIVILEGES_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  if pg_get_serial_sequence('public.audit_logs','id') is null\n` +
    `     or not exists (\n` +
    `       select 1 from pg_class c\n` +
    `       cross join lateral aclexplode(coalesce(c.relacl,acldefault('s',c.relowner))) acl\n` +
    `       join pg_roles grantee on grantee.oid=acl.grantee\n` +
    `       where c.oid=pg_get_serial_sequence('public.audit_logs','id')::regclass\n` +
    `         and grantee.rolname='service_role' and acl.privilege_type='USAGE'\n` +
    `         and not acl.is_grantable and acl.grantor=c.relowner\n` +
    `     ) then\n` +
    `    raise exception 'STAGING_SERVICE_ROLE_AUDIT_SEQUENCE_USAGE_MISSING';\n` +
    `  end if;\n` +
    `\n` +
    `  select string_agg(n.nspname || '.' || c.relname || ':' || acl.privilege_type, ', ' order by n.nspname,c.relname,acl.privilege_type) into v_missing\n` +
    `  from pg_class c\n` +
    `  join pg_namespace n on n.oid=c.relnamespace\n` +
    `  cross join lateral aclexplode(coalesce(c.relacl,acldefault('s',c.relowner))) acl\n` +
    `  join pg_roles grantee on grantee.oid=acl.grantee\n` +
    `  where n.nspname='public' and c.relkind='S' and grantee.rolname='service_role'\n` +
    `    and (\n` +
    `      c.oid <> pg_get_serial_sequence('public.audit_logs','id')::regclass\n` +
    `      or acl.privilege_type <> 'USAGE' or acl.is_grantable\n` +
    `      or acl.grantor <> c.relowner\n` +
    `    );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SERVICE_ROLE_SEQUENCE_ACL_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(n.nspname || '.' || c.relname || ':' || action.privilege, ', ' order by n.nspname,c.relname,action.privilege) into v_missing\n` +
    `  from pg_class c\n` +
    `  join pg_namespace n on n.oid=c.relnamespace\n` +
    `  cross join unnest(array['USAGE','SELECT','UPDATE']::text[]) action(privilege)\n` +
    `  where n.nspname='public' and c.relkind='S'\n` +
    `    and has_sequence_privilege('service_role',c.oid,action.privilege)\n` +
    `    and not (\n` +
    `      c.oid=pg_get_serial_sequence('public.audit_logs','id')::regclass\n` +
    `      and action.privilege='USAGE'\n` +
    `    );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SERVICE_ROLE_SEQUENCE_PRIVILEGES_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(n.nspname || '.' || c.relname, ', ' order by n.nspname,c.relname) into v_missing\n` +
    `  from pg_class c\n` +
    `  join pg_namespace n on n.oid=c.relnamespace\n` +
    `  where n.nspname='public' and c.relkind in ('r','p')\n` +
    `    and not (n.nspname || '.' || c.relname = any(${sqlArray(serviceRoleDmlWithoutSubscriptionGuardAllowlist)}))\n` +
    `    and (\n` +
    `      has_table_privilege('service_role',c.oid,'INSERT')\n` +
    `      or has_table_privilege('service_role',c.oid,'UPDATE')\n` +
    `      or has_table_privilege('service_role',c.oid,'DELETE')\n` +
    `    )\n` +
    `    and not exists (\n` +
    `      select 1 from pg_trigger t\n` +
    `      where t.tgrelid=c.oid\n` +
    `        and t.tgname='trg_cnyos_active_subscription_write'\n` +
    `        and not t.tgisinternal and t.tgenabled='O' and t.tgtype=31\n` +
    `        and t.tgfoid=to_regprocedure('public.enforce_active_subscription_tenant_write()')\n` +
    `    );\n` +
    `  if v_missing is not null then raise exception 'STAGING_UNGUARDED_SERVICE_ROLE_DML_PRESENT: %', v_missing; end if;\n` +
    `\n` +
    `  select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') into v_function_body\n` +
    `  from pg_proc p where p.oid=to_regprocedure('public.current_clinic_id()');\n` +
    `  if v_function_body is null\n` +
    `     or position('join public.clinics' in v_function_body)=0\n` +
    `     or position('c.active' in v_function_body)=0\n` +
    `     or position('c.subscription_state = ''active''' in v_function_body)=0 then\n` +
    `    raise exception 'STAGING_CURRENT_CLINIC_SUBSCRIPTION_GATE_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') into v_function_body\n` +
    `  from pg_proc p where p.oid=to_regprocedure('public.current_department_role()');\n` +
    `  if v_function_body is null\n` +
    `     or position('join public.clinics' in v_function_body)=0\n` +
    `     or position('c.active' in v_function_body)=0\n` +
    `     or position('c.subscription_state = ''active''' in v_function_body)=0 then\n` +
    `    raise exception 'STAGING_CURRENT_DEPARTMENT_SUBSCRIPTION_GATE_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') into v_function_body\n` +
    `  from pg_proc p where p.oid=to_regprocedure('public.current_access_context()');\n` +
    `  if v_function_body is null\n` +
    `     or position('join public.clinics' in v_function_body)=0\n` +
    `     or position('c.active' in v_function_body)=0\n` +
    `     or position('c.subscription_state = ''active''' in v_function_body)=0 then\n` +
    `    raise exception 'STAGING_CURRENT_ACCESS_SUBSCRIPTION_GATE_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') into v_function_body\n` +
    `  from pg_proc p where p.oid=to_regprocedure('public.assert_clinic_subscription_active(uuid)');\n` +
    `  if not exists (\n` +
    `    select 1 from pg_proc p\n` +
    `    where p.oid=to_regprocedure('public.assert_clinic_subscription_active(uuid)')\n` +
    `      and p.provolatile='v'\n` +
    `  ) or v_function_body is null\n` +
    `     or position('auth.role()' in v_function_body)=0\n` +
    `     or position('service_role' in v_function_body)=0\n` +
    `     or position('for share' in v_function_body)=0\n` +
    `     or position('if not found then raise exception ''cnyos_clinic_not_found''' in v_function_body)=0\n` +
    `     or position('if not v_clinic.active or v_clinic.subscription_state <> ''active'' then' in v_function_body)=0\n` +
    `     or position('cnyos_subscription_suspended' in v_function_body)=0\n` +
    `     or position('public.current_clinic_id() is distinct from p_clinic_id' in v_function_body)=0\n` +
    `     or position('for share' in v_function_body)\n` +
    `        >= position('not v_clinic.active' in v_function_body) then\n` +
    `    raise exception 'STAGING_EXACT_CLINIC_SUBSCRIPTION_ASSERTION_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') into v_function_body\n` +
    `  from pg_proc p where p.oid=to_regprocedure('public.enforce_active_subscription_tenant_write()');\n` +
    `  if v_function_body is null\n` +
    `     or position('auth.role() is null' in v_function_body)=0\n` +
    `     or position('auth.uid() is null' in v_function_body)=0\n` +
    `     or v_function_body !~ 'session_user[[:space:]]*=[[:space:]]*current_user'\n` +
    `     or position('auth.role()=''service_role''' in v_function_body)=0\n` +
    `     or position('pg_catalog.current_setting' in v_function_body)=0\n` +
    `     or position('cnyos.subscription_off_exception' in v_function_body)=0\n` +
    `     or position('cnyos.subscription_off_exception_clinic' in v_function_body)=0\n` +
    `     or position('v_capability_clinic' in v_function_body)=0\n` +
    `     or position('coalesce(v_new_clinic,v_old_clinic)=v_capability_clinic' in v_function_body)=0\n` +
    `     or position('line-consent-withdrawal/v1' in v_function_body)=0\n` +
    `     or position('line-finish-webhook/v1' in v_function_body)=0\n` +
    `     or position('line-finish-notification/v1' in v_function_body)=0\n` +
    `     or position('line_oa_notification_preferences' in v_function_body)=0\n` +
    `     or position('line_oa_webhook_events' in v_function_body)=0\n` +
    `     or position('line_oa_notification_outbox' in v_function_body)=0\n` +
    `     or position('old.clinic_id' in v_function_body)=0\n` +
    `     or position('new.clinic_id' in v_function_body)=0\n` +
    `     or position('assert_clinic_subscription_active' in v_function_body)=0 then\n` +
    `    raise exception 'STAGING_ACTIVE_SUBSCRIPTION_WRITE_GUARD_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') into v_function_body\n` +
    `  from pg_proc p where p.oid=to_regprocedure('public.enforce_authenticated_subscription_statement_write()');\n` +
    `  if v_function_body is null\n` +
    `     or position('auth.role() is distinct from ''authenticated''' in v_function_body)=0\n` +
    `     or position('auth.uid() is null' in v_function_body)=0\n` +
    `     or position('v_clinic_id := public.current_clinic_id()' in v_function_body)=0\n` +
    `     or position('assert_clinic_subscription_active(v_clinic_id)' in v_function_body)=0 then\n` +
    `    raise exception 'STAGING_AUTHENTICATED_SUBSCRIPTION_STATEMENT_GUARD_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') into v_function_body\n` +
    `  from pg_proc p where p.oid=to_regprocedure('public.prepare_line_subscription_off_exception(uuid,text)');\n` +
    `  if v_function_body is null\n` +
    `     or position('auth.role()<>''service_role''' in v_function_body)=0\n` +
    `     or position('line-consent-withdrawal/v1' in v_function_body)=0\n` +
    `     or position('line-finish-webhook/v1' in v_function_body)=0\n` +
    `     or position('line-finish-notification/v1' in v_function_body)=0\n` +
    `     or position('for share' in v_function_body)=0\n` +
    `     or position('v_clinic.subscription_state=''active''' in v_function_body)=0\n` +
    `     or position('pg_catalog.set_config' in v_function_body)=0\n` +
    `     or position('cnyos.subscription_off_exception' in v_function_body)=0\n` +
    `     or position('cnyos.subscription_off_exception_clinic' in v_function_body)=0 then\n` +
    `    raise exception 'STAGING_LINE_OFF_EXCEPTION_CAPABILITY_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') into v_function_body\n` +
    `  from pg_proc p where p.oid=to_regprocedure(\n` +
    `    'public.set_line_oa_notification_preference_for_subject(text,uuid,uuid,text,text,text,boolean)'\n` +
    `  );\n` +
    `  if v_function_body is null\n` +
    `     or position('if p_enabled then' in v_function_body)=0\n` +
    `     or position('assert_clinic_subscription_active(p_clinic_id)' in v_function_body)=0\n` +
    `     or position('line-consent-withdrawal/v1' in v_function_body)=0\n` +
    `     or position('line_oa_set_preference_v20260829' in v_function_body)=0\n` +
    `     or position(${quote(lineOffExceptionCleanupFingerprint)} in v_function_body)=0 then\n` +
    `    raise exception 'STAGING_LINE_CONSENT_OFF_EXCEPTION_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') into v_function_body\n` +
    `  from pg_proc p where p.oid=to_regprocedure(\n` +
    `    'public.finish_line_oa_webhook_event(uuid,text,text,text,text,text,text,boolean)'\n` +
    `  );\n` +
    `  if v_function_body is null\n` +
    `     or position('processing_status=''processing''' in v_function_body)=0\n` +
    `     or position('for update' in v_function_body)=0\n` +
    `     or position('line-finish-webhook/v1' in v_function_body)=0\n` +
    `     or position('line_oa_finish_webhook_v20260829' in v_function_body)=0\n` +
    `     or position(${quote(lineOffExceptionCleanupFingerprint)} in v_function_body)=0 then\n` +
    `    raise exception 'STAGING_LINE_FINISH_WEBHOOK_OFF_EXCEPTION_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') into v_function_body\n` +
    `  from pg_proc p where p.oid=to_regprocedure(\n` +
    `    'public.finish_line_oa_notification(uuid,text,text,integer,text,text)'\n` +
    `  );\n` +
    `  if v_function_body is null\n` +
    `     or position('o.status=''sending''' in v_function_body)=0\n` +
    `     or position('o.locked_by=p_worker_id' in v_function_body)=0\n` +
    `     or position('for update' in v_function_body)=0\n` +
    `     or position('line-finish-notification/v1' in v_function_body)=0\n` +
    `     or position('line_oa_finish_notification_v20260829' in v_function_body)=0\n` +
    `     or position(${quote(lineOffExceptionCleanupFingerprint)} in v_function_body)=0 then\n` +
    `    raise exception 'STAGING_LINE_FINISH_NOTIFICATION_OFF_EXCEPTION_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',\n` +
    `    ', ' order by p.proname,pg_get_function_identity_arguments(p.oid)\n` +
    `  ) into v_missing\n` +
    `  from pg_proc p\n` +
    `  join pg_namespace n on n.oid=p.pronamespace\n` +
    `  join pg_type t on t.oid=p.prorettype\n` +
    `  where n.nspname='public' and p.prosecdef\n` +
    `    and t.typname not in ('trigger','event_trigger')\n` +
    `    and has_function_privilege('authenticated',p.oid,'EXECUTE')\n` +
    `    and not exists (\n` +
    `      select 1 from unnest(${sqlArray(exactServiceRoleOnlyProcedures)}) expected(procedure_signature)\n` +
    `      where to_regprocedure(procedure_signature)=p.oid\n` +
    `    )\n` +
    `    and p.proname not in ('current_clinic_id','current_department_role','current_access_context')\n` +
    `    and p.prosrc !~* 'current_clinic_id|is_clinic_member|department_can|has_role|can_access_|is_super_admin|assert_clinic_subscription_active';\n` +
    `  if v_missing is not null then raise exception 'STAGING_BROWSER_SECURITY_DEFINER_SUBSCRIPTION_GATE_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature, ', ' order by procedure_signature) into v_missing\n` +
    `  from unnest(${sqlArray(backupRestoreServiceRoleOnlyProcedures)}) expected(procedure_signature)\n` +
    `  where not has_function_privilege('service_role', procedure_signature, 'EXECUTE');\n` +
    `  if v_missing is not null then raise exception 'STAGING_BACKUP_RESTORE_SERVICE_ROLE_EXECUTE_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    procedure_signature || ' -> ' || grantee,\n` +
    `    ', ' order by procedure_signature,grantee\n` +
    `  ) into v_missing\n` +
    `  from unnest(${sqlArray(backupRestoreServiceRoleOnlyProcedures)}) expected(procedure_signature)\n` +
    `  cross join unnest(array['anon','authenticated']::text[]) target(grantee)\n` +
    `  where has_function_privilege(grantee, procedure_signature, 'EXECUTE');\n` +
    `  if v_missing is not null then raise exception 'STAGING_BACKUP_RESTORE_BROWSER_EXECUTE_PRESENT: %', v_missing; end if;\n` +
    `\n` +
    `  select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') into v_function_body\n` +
    `  from pg_proc p\n` +
    `  where p.oid=to_regprocedure('public.export_clinic_backup_domain(uuid,text)');\n` +
    `  if v_function_body is null\n` +
    `     or position('auth.role() <> ''service_role''' in v_function_body)=0\n` +
    `     or position('export_clinic_backup_domain_v20260831' in v_function_body)=0\n` +
    `     or position('p_domain = ''transactions''' in v_function_body)=0\n` +
    `     or position('clinic_drive_destination_events' in v_function_body)=0\n` +
    `     or position('2026-09-01.1' in v_function_body)=0 then\n` +
    `    raise exception 'STAGING_BACKUP_EXPORT_EVIDENCE_WRAPPER_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') into v_function_body\n` +
    `  from pg_proc p\n` +
    `  where p.oid=to_regprocedure('public.verify_clinic_restore_trace(uuid)');\n` +
    `  if v_function_body is null\n` +
    `     or position('auth.role() <> ''service_role''' in v_function_body)=0\n` +
    `     or position('verify_clinic_restore_trace_v20260831' in v_function_body)=0\n` +
    `     or position('clinic_drive_destination_events' in v_function_body)=0\n` +
    `     or position('2026-09-01.1' in v_function_body)=0 then\n` +
    `    raise exception 'STAGING_BACKUP_RESTORE_EVIDENCE_WRAPPER_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') into v_function_body\n` +
    `  from pg_proc p\n` +
    `  where p.oid=to_regprocedure('public.begin_backup_export_run(uuid,timestamptz,text)');\n` +
    `  if v_function_body is null\n` +
    `     or position('auth.role() <> ''service_role''' in v_function_body)=0\n` +
    `     or position('select * into v_clinic from public.clinics c where c.id = p_clinic_id for update' in v_function_body)=0\n` +
    `     or position('perform pg_catalog.pg_advisory_xact_lock' in v_function_body)=0\n` +
    `     or position('select * into v_run from public.backup_export_runs r' in v_function_body)=0\n` +
    `     or position('v_run.status = ''started''' in v_function_body)=0\n` +
    `     or position('interval ''30 minutes''' in v_function_body)=0\n` +
    `     or position('select * into v_clinic from public.clinics c where c.id = p_clinic_id for update' in v_function_body)\n` +
    `        >= position('perform pg_catalog.pg_advisory_xact_lock' in v_function_body)\n` +
    `     or position('perform pg_catalog.pg_advisory_xact_lock' in v_function_body)\n` +
    `        >= position('select * into v_run from public.backup_export_runs r' in v_function_body) then\n` +
    `    raise exception 'STAGING_BACKUP_RUN_LOCK_CONTRACT_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  if position('v_run.status in (''completed'', ''partial'', ''failed'')' in v_function_body)=0\n` +
    `     or position('v_request_id text := pg_catalog.btrim(p_request_id)' in v_function_body)=0\n` +
    `     or position('p_request_id is distinct from v_request_id' in v_function_body)=0\n` +
    `     or position('^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' in v_function_body)=0\n` +
    `     or position('backup_request_id_invalid' in v_function_body)=0\n` +
    `     or position('v_run.request_id is not distinct from v_request_id' in v_function_body)=0\n` +
    `     or position('or v_run.request_id is not distinct from v_request_id' in v_function_body)=0\n` +
    `     or position('update public.backup_export_runs' in v_function_body)=0\n` +
    `     or position('domain_counts = ''{}''::jsonb' in v_function_body)=0\n` +
    `     or position('object_manifest = ''[]''::jsonb' in v_function_body)=0\n` +
    `     or position('v_run.status in (''completed'', ''partial'', ''failed'')' in v_function_body)\n` +
    `        >= position('v_run.status = ''started''' in v_function_body)\n` +
    `     or position('v_run.status in (''completed'', ''partial'', ''failed'')' in v_function_body)\n` +
    `        >= position('update public.backup_export_runs' in v_function_body)\n` +
    `     or position('v_run.request_id is not distinct from v_request_id' in v_function_body)\n` +
    `        >= position('update public.backup_export_runs' in v_function_body) then\n` +
    `    raise exception 'STAGING_BACKUP_RUN_TERMINAL_REPLAY_CONTRACT_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') into v_function_body\n` +
    `  from pg_proc p\n` +
    `  where p.oid=to_regprocedure('public.set_clinic_drive_assignment(uuid,uuid,text,text,text,text,text,text,text,bigint,text,uuid,text)');\n` +
    `  if v_function_body is null\n` +
    `     or position('select * into v_clinic from public.clinics c where c.id = p_clinic_id for update' in v_function_body)=0\n` +
    `     or position('from public.backup_export_runs r where r.clinic_id = p_clinic_id and r.status = ''started'' and r.started_at > pg_catalog.now() - interval ''30 minutes''' in v_function_body)=0\n` +
    `     or position('raise exception ''cnyos_drive_backup_run_active''' in v_function_body)=0\n` +
    `     or position('select * into v_clinic from public.clinics c where c.id = p_clinic_id for update' in v_function_body)\n` +
    `        >= position('from public.backup_export_runs r where r.clinic_id = p_clinic_id' in v_function_body) then\n` +
    `    raise exception 'STAGING_BACKUP_DRIVE_LEASE_LOCK_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') into v_function_body\n` +
    `  from pg_proc p\n` +
    `  where p.oid=to_regprocedure('public.get_exact_backup_restore_source(text,timestamptz,text)');\n` +
    `  if v_function_body is null\n` +
    `     or position('auth.role() <> ''service_role''' in v_function_body)=0\n` +
    `     or position('r.status = ''completed''' in v_function_body)=0\n` +
    `     or position('r.destination = ''google_drive''' in v_function_body)=0\n` +
    `     or position('v_run.completed_at is null or v_run.error_code is not null' in v_function_body)=0\n` +
    `     or position('jsonb_array_length(v_run.object_manifest) <> 5' in v_function_body)=0\n` +
    `     or position('jsonb_object_keys(v_run.domain_counts)) <> 4' in v_function_body)=0\n` +
    `     or position('v_objects ? v_domain' in v_function_body)=0\n` +
    `     or position('v_file_id = any(v_file_ids) or v_folder_id = any(v_folder_ids)' in v_function_body)=0\n` +
    `     or position('restore_source_root_folder_mismatch' in v_function_body)=0\n` +
    `     or position('restore_source_assignment_version_mismatch' in v_function_body)=0\n` +
    `     or position('restore_source_file_name_mismatch' in v_function_body)=0\n` +
    `     or position('plaintext_sha256' in v_function_body)=0\n` +
    `     or position('ciphertext_sha256' in v_function_body)=0\n` +
    `     or position('key_id' in v_function_body)=0\n` +
    `     or position('restore_source_domain_evidence_invalid' in v_function_body)=0\n` +
    `     or position('v_objects ?& v_domains' in v_function_body)=0\n` +
    `     or position('chananya-exact-restore-source/v1' in v_function_body)=0 then\n` +
    `    raise exception 'STAGING_EXACT_RESTORE_SOURCE_CONTRACT_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  if to_regprocedure(\n` +
    `    'public.set_clinic_subscription_state(uuid,uuid,text,boolean,text,uuid,text)'\n` +
    `  ) is not null then\n` +
    `    raise exception 'STAGING_OWNER_SUBSCRIPTION_LEGACY_OVERLOAD_PRESENT';\n` +
    `  end if;\n` +
    `\n` +
    `  if not exists (\n` +
    `    select 1 from information_schema.columns c\n` +
    `    where c.table_schema='public'\n` +
    `      and c.table_name='clinic_subscription_control_events'\n` +
    `      and c.column_name='expected_version'\n` +
    `      and c.data_type='bigint'\n` +
    `      and c.is_nullable='NO'\n` +
    `  ) then raise exception 'STAGING_OWNER_SUBSCRIPTION_EXPECTED_VERSION_INVALID'; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    relation_name || ':' || trigger_name,\n` +
    `    ', ' order by relation_name,trigger_name\n` +
    `  ) into v_missing\n` +
    `  from (values ${sqlRows(requiredAppendOnlyTriggers)}) expected(relation_name,trigger_name)\n` +
    `  where not exists (\n` +
    `    select 1\n` +
    `    from pg_trigger t\n` +
    `    join pg_class c on c.oid=t.tgrelid\n` +
    `    join pg_namespace n on n.oid=c.relnamespace\n` +
    `    where n.nspname=split_part(relation_name,'.',1)\n` +
    `      and c.relname=split_part(relation_name,'.',2)\n` +
    `      and t.tgname=trigger_name\n` +
    `      and not t.tgisinternal and t.tgenabled='O' and t.tgtype=27\n` +
    `      and t.tgfoid=to_regprocedure('public.reject_append_only_mutation()')\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_APPEND_ONLY_TRIGGER_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select regexp_replace(lower(p.prosrc), '[[:space:]]+', ' ', 'g') into v_function_body\n` +
    `  from pg_proc p\n` +
    `  where p.oid=to_regprocedure('public.reject_append_only_mutation()');\n` +
    `  if not exists (\n` +
    `    select 1 from pg_proc p\n` +
    `    join pg_type t on t.oid=p.prorettype\n` +
    `    where p.oid=to_regprocedure('public.reject_append_only_mutation()')\n` +
    `      and p.prosecdef and p.provolatile='v' and t.typname='trigger'\n` +
    `      and exists (\n` +
    `        select 1 from unnest(coalesce(p.proconfig,array[]::text[])) setting(value)\n` +
    `        where replace(lower(setting.value),' ','')='search_path=pg_catalog'\n` +
    `      )\n` +
    `  ) or v_function_body is null\n` +
    `     or position('raise exception ''append_only_record_mutation_denied''' in v_function_body)=0\n` +
    `     or position('errcode = ''55000''' in v_function_body)=0\n` +
    `     or position('detail = tg_table_schema || ''.'' || tg_table_name' in v_function_body)=0\n` +
    `     or position('return' in v_function_body)>0 then\n` +
    `    raise exception 'STAGING_APPEND_ONLY_FUNCTION_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    procedure_signature || ' -> ' || coalesce(grantee.rolname,'PUBLIC') || ':' || acl.privilege_type,\n` +
    `    ', ' order by procedure_signature,coalesce(grantee.rolname,'PUBLIC'),acl.privilege_type\n` +
    `  ) into v_missing\n` +
    `  from unnest(${sqlArray(appendOnlyClosedProcedures)}) expected(procedure_signature)\n` +
    `  join pg_proc p on p.oid=to_regprocedure(procedure_signature)\n` +
    `  cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl\n` +
    `  left join pg_roles grantee on grantee.oid=acl.grantee\n` +
    `  where acl.grantee <> p.proowner;\n` +
    `  if v_missing is not null then raise exception 'STAGING_APPEND_ONLY_FUNCTION_EXECUTE_PRESENT: %', v_missing; end if;\n` +
    `\n` +
    `  if not exists (\n` +
    `    select 1\n` +
    `    from pg_trigger t\n` +
    `    where t.tgrelid=to_regclass('public.clinics')\n` +
    `      and t.tgname='trg_clinics_owner_subscription_forward_only'\n` +
    `      and not t.tgisinternal and t.tgenabled='O' and t.tgtype=18\n` +
    `      and t.tgfoid=to_regprocedure('public.guard_owner_subscription_forward_only()')\n` +
    `      and position('subscription_state' in lower(pg_get_triggerdef(t.oid)))>0\n` +
    `      and position('subscription_version' in lower(pg_get_triggerdef(t.oid)))>0\n` +
    `      and position('subscription_changed_at' in lower(pg_get_triggerdef(t.oid)))>0\n` +
    `      and position('subscription_changed_by' in lower(pg_get_triggerdef(t.oid)))>0\n` +
    `      and position('subscription_reason' in lower(pg_get_triggerdef(t.oid)))>0\n` +
    `  ) then raise exception 'STAGING_OWNER_SUBSCRIPTION_FORWARD_TRIGGER_INVALID'; end if;\n` +
    `\n` +
    `  select string_agg(n.nspname || '.' || c.relname || ' -> ' || owner_role.rolname, ', ' order by n.nspname,c.relname) into v_missing\n` +
    `  from pg_class c\n` +
    `  join pg_namespace n on n.oid=c.relnamespace\n` +
    `  join pg_roles owner_role on owner_role.oid=c.relowner\n` +
    `  where n.nspname='public' and c.relkind in ('r','p','v','m','f','S')\n` +
    `    and c.relowner <> (select relowner from pg_class where oid=to_regclass('public.clinics'));\n` +
    `  if v_missing is not null then raise exception 'STAGING_PUBLIC_RELATION_OWNER_MISMATCH: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    relation_name || '[' || expected_relkind || '] -> ' || expected_grantee || ':' || expected_privilege,\n` +
    `    ', ' order by relation_name,expected_grantee,expected_privilege\n` +
    `  ) into v_missing\n` +
    `  from (values ${sqlRows(exactPublicRelationAndSequenceAclTuples)}) expected(\n` +
    `    relation_name,expected_relkind,expected_grantee,expected_privilege\n` +
    `  )\n` +
    `  where not exists (\n` +
    `    select 1\n` +
    `    from pg_class c\n` +
    `    cross join lateral aclexplode(coalesce(\n` +
    `      c.relacl,\n` +
    `      acldefault((case when c.relkind='S' then 's' else 'r' end)::\"char\",c.relowner)\n` +
    `    )) acl\n` +
    `    join pg_roles granted_role on granted_role.oid=acl.grantee\n` +
    `    where c.oid=to_regclass(relation_name)\n` +
    `      and c.relkind=expected_relkind::\"char\"\n` +
    `      and granted_role.rolname=expected_grantee\n` +
    `      and acl.privilege_type=expected_privilege\n` +
    `      and not acl.is_grantable and acl.grantor=c.relowner\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_PUBLIC_RELATION_ACL_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    n.nspname || '.' || c.relname || '[' || c.relkind::text || '] -> ' || coalesce(grantee.rolname,'PUBLIC') || ':' || acl.privilege_type,\n` +
    `    ', ' order by n.nspname,c.relname,coalesce(grantee.rolname,'PUBLIC'),acl.privilege_type\n` +
    `  ) into v_missing\n` +
    `  from pg_class c\n` +
    `  join pg_namespace n on n.oid=c.relnamespace\n` +
    `  cross join lateral aclexplode(coalesce(\n` +
    `    c.relacl,\n` +
    `    acldefault((case when c.relkind='S' then 's' else 'r' end)::\"char\",c.relowner)\n` +
    `  )) acl\n` +
    `  left join pg_roles grantee on grantee.oid=acl.grantee\n` +
    `  where n.nspname='public' and c.relkind in ('r','p','v','m','f','S')\n` +
    `    and acl.grantee <> c.relowner\n` +
    `    and (\n` +
    `      acl.is_grantable or acl.grantor <> c.relowner\n` +
    `      or not exists (\n` +
    `        select 1\n` +
    `        from (values ${sqlRows(exactPublicRelationAndSequenceAclTuples)}) expected(\n` +
    `          relation_name,expected_relkind,expected_grantee,expected_privilege\n` +
    `        )\n` +
    `        where relation_name=n.nspname || '.' || c.relname\n` +
    `          and expected_relkind=c.relkind::text\n` +
    `          and expected_grantee=coalesce(grantee.rolname,'PUBLIC')\n` +
    `          and expected_privilege=acl.privilege_type\n` +
    `      )\n` +
    `    );\n` +
    `  if v_missing is not null then raise exception 'STAGING_PUBLIC_RELATION_ACL_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    n.nspname || '.' || c.relname || '.' || a.attname || ' -> ' || coalesce(grantee.rolname,'PUBLIC') || ':' || acl.privilege_type,\n` +
    `    ', ' order by n.nspname,c.relname,a.attname,coalesce(grantee.rolname,'PUBLIC'),acl.privilege_type\n` +
    `  ) into v_missing\n` +
    `  from pg_class c\n` +
    `  join pg_namespace n on n.oid=c.relnamespace\n` +
    `  join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped\n` +
    `  cross join lateral aclexplode(coalesce(a.attacl,acldefault('c',c.relowner))) acl\n` +
    `  left join pg_roles grantee on grantee.oid=acl.grantee\n` +
    `  where n.nspname='public' and c.relkind in ('r','p','v','m','f')\n` +
    `    and acl.grantee <> c.relowner;\n` +
    `  if v_missing is not null then raise exception 'STAGING_PUBLIC_COLUMN_ACL_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(p.oid::regprocedure::text || ' -> ' || owner_role.rolname, ', ' order by p.oid::regprocedure::text) into v_missing\n` +
    `  from pg_proc p\n` +
    `  join pg_namespace n on n.oid=p.pronamespace\n` +
    `  join pg_type result_type on result_type.oid=p.prorettype\n` +
    `  join pg_roles owner_role on owner_role.oid=p.proowner\n` +
    `  where n.nspname='public' and p.prosecdef\n` +
    `    and result_type.typname not in ('trigger','event_trigger')\n` +
    `    and p.proowner <> (select relowner from pg_class where oid=to_regclass('public.clinics'));\n` +
    `  if v_missing is not null then raise exception 'STAGING_PUBLIC_CALLABLE_SECURITY_DEFINER_OWNER_MISMATCH: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature, ', ' order by procedure_signature) into v_missing\n` +
    `  from unnest(${sqlArray(callableSecurityDefinerProcedures)}) expected(procedure_signature)\n` +
    `  where not exists (\n` +
    `    select 1\n` +
    `    from pg_proc p\n` +
    `    join pg_namespace n on n.oid=p.pronamespace\n` +
    `    join pg_type result_type on result_type.oid=p.prorettype\n` +
    `    where p.oid=to_regprocedure(procedure_signature)\n` +
    `      and n.nspname='public' and p.prosecdef\n` +
    `      and result_type.typname not in ('trigger','event_trigger')\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_PUBLIC_CALLABLE_SECURITY_DEFINER_INVENTORY_INVALID: missing %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',\n` +
    `    ', ' order by n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)\n` +
    `  ) into v_missing\n` +
    `  from pg_proc p\n` +
    `  join pg_namespace n on n.oid=p.pronamespace\n` +
    `  join pg_type result_type on result_type.oid=p.prorettype\n` +
    `  where n.nspname='public' and p.prosecdef\n` +
    `    and result_type.typname not in ('trigger','event_trigger')\n` +
    `    and not exists (\n` +
    `      select 1\n` +
    `      from unnest(${sqlArray(callableSecurityDefinerProcedures)}) expected(procedure_signature)\n` +
    `      where to_regprocedure(procedure_signature)=p.oid\n` +
    `    );\n` +
    `  if v_missing is not null then raise exception 'STAGING_PUBLIC_CALLABLE_SECURITY_DEFINER_INVENTORY_INVALID: unexpected %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(procedure_signature || ' -> ' || expected_grantee, ', ' order by procedure_signature,expected_grantee) into v_missing\n` +
    `  from (values ${sqlRows(allowedCallableSecurityDefinerProcedureGrants)}) expected(procedure_signature,expected_grantee)\n` +
    `  join pg_proc p on p.oid=to_regprocedure(procedure_signature)\n` +
    `  where not exists (\n` +
    `    select 1\n` +
    `    from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl\n` +
    `    join pg_roles granted_role on granted_role.oid=acl.grantee\n` +
    `    where granted_role.rolname=expected_grantee\n` +
    `      and acl.privilege_type='EXECUTE' and not acl.is_grantable\n` +
    `      and acl.grantor=p.proowner\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_PUBLIC_CALLABLE_SECURITY_DEFINER_ACL_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(\n` +
    `    p.oid::regprocedure::text || ' -> ' || coalesce(grantee.rolname,'PUBLIC') || ':' || acl.privilege_type,\n` +
    `    ', ' order by p.oid::regprocedure::text,coalesce(grantee.rolname,'PUBLIC'),acl.privilege_type\n` +
    `  ) into v_missing\n` +
    `  from pg_proc p\n` +
    `  join pg_namespace n on n.oid=p.pronamespace\n` +
    `  join pg_type result_type on result_type.oid=p.prorettype\n` +
    `  cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl\n` +
    `  left join pg_roles grantee on grantee.oid=acl.grantee\n` +
    `  where n.nspname='public' and p.prosecdef\n` +
    `    and result_type.typname not in ('trigger','event_trigger')\n` +
    `    and acl.grantee <> p.proowner\n` +
    `    and (\n` +
    `      acl.privilege_type <> 'EXECUTE' or acl.is_grantable or acl.grantor <> p.proowner\n` +
    `      or not exists (\n` +
    `        select 1\n` +
    `        from (values ${sqlRows(allowedCallableSecurityDefinerProcedureGrants)}) expected(\n` +
    `          procedure_signature,expected_grantee\n` +
    `        )\n` +
    `        where to_regprocedure(procedure_signature)=p.oid\n` +
    `          and expected_grantee=coalesce(grantee.rolname,'PUBLIC')\n` +
    `      )\n` +
    `    );\n` +
    `  if v_missing is not null then raise exception 'STAGING_PUBLIC_CALLABLE_SECURITY_DEFINER_ACL_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(expected.role_name, ', ' order by expected.role_name) into v_missing\n` +
    `  from (values ${sqlRows(expectedRuntimeRoleSecurityAttributes)}) expected(\n` +
    `    role_name,expected_super,expected_create_role,expected_create_db,\n` +
    `    expected_login,expected_replication,expected_bypass_rls\n` +
    `  )\n` +
    `  left join pg_roles role_state on role_state.rolname=expected.role_name\n` +
    `  where role_state.oid is null\n` +
    `     or role_state.rolsuper is distinct from expected.expected_super::boolean\n` +
    `     or role_state.rolcreaterole is distinct from expected.expected_create_role::boolean\n` +
    `     or role_state.rolcreatedb is distinct from expected.expected_create_db::boolean\n` +
    `     or role_state.rolcanlogin is distinct from expected.expected_login::boolean\n` +
    `     or role_state.rolreplication is distinct from expected.expected_replication::boolean\n` +
    `     or role_state.rolbypassrls is distinct from expected.expected_bypass_rls::boolean\n` +
    `     or (expected.role_name='authenticator' and role_state.rolinherit);\n` +
    `  if v_missing is not null then raise exception 'STAGING_RUNTIME_ROLE_ATTRIBUTES_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  if not exists (\n` +
    `    select 1\n` +
    `    from pg_namespace public_schema\n` +
    `    where public_schema.nspname='public'\n` +
    `      and public_schema.nspowner in (\n` +
    `        (select relowner from pg_class where oid=to_regclass('public.clinics')),\n` +
    `        (select oid from pg_roles where rolname='pg_database_owner')\n` +
    `      )\n` +
    `  ) then raise exception 'STAGING_PUBLIC_SCHEMA_OWNER_INVALID'; end if;\n` +
    `\n` +
    `  select string_agg(coalesce(grantee.rolname,'PUBLIC') || ':' || acl.privilege_type, ', ' order by coalesce(grantee.rolname,'PUBLIC'),acl.privilege_type) into v_missing\n` +
    `  from pg_namespace public_schema\n` +
    `  cross join lateral aclexplode(coalesce(\n` +
    `    public_schema.nspacl,acldefault('n',public_schema.nspowner)\n` +
    `  )) acl\n` +
    `  left join pg_roles grantee on grantee.oid=acl.grantee\n` +
    `  where public_schema.nspname='public' and acl.grantee <> public_schema.nspowner\n` +
    `    and (\n` +
    `      acl.is_grantable or acl.grantor <> public_schema.nspowner\n` +
    `      or not exists (\n` +
    `        select 1\n` +
    `        from (values ${sqlRows(exactPublicSchemaAclGrants)}) expected(\n` +
    `          expected_grantee,expected_privilege\n` +
    `        )\n` +
    `        where expected_grantee=coalesce(grantee.rolname,'PUBLIC')\n` +
    `          and expected_privilege=acl.privilege_type\n` +
    `      )\n` +
    `    );\n` +
    `  if v_missing is not null then raise exception 'STAGING_PUBLIC_SCHEMA_ACL_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(runtime_role, ', ' order by runtime_role) into v_missing\n` +
    `  from unnest(${sqlArray(runtimeJwtRoles)}) expected(runtime_role)\n` +
    `  where not has_schema_privilege(runtime_role,'public','USAGE')\n` +
    `     or has_schema_privilege(runtime_role,'public','CREATE');\n` +
    `  if v_missing is not null then raise exception 'STAGING_PUBLIC_SCHEMA_RUNTIME_PRIVILEGES_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(runtime_role, ', ' order by runtime_role) into v_missing\n` +
    `  from unnest(${sqlArray(runtimeJwtRoles)}) expected(runtime_role)\n` +
    `  where not exists (\n` +
    `    select 1\n` +
    `    from pg_auth_members membership\n` +
    `    join pg_roles granted_role on granted_role.oid=membership.roleid\n` +
    `    join pg_roles member_role on member_role.oid=membership.member\n` +
    `    where granted_role.rolname=runtime_role\n` +
    `      and member_role.rolname='authenticator'\n` +
    `      and not membership.admin_option\n` +
    `      and not coalesce(\n` +
    `        (to_jsonb(membership)->>'inherit_option')::boolean,\n` +
    `        member_role.rolinherit\n` +
    `      )\n` +
    `      and coalesce((to_jsonb(membership)->>'set_option')::boolean,true)\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_RUNTIME_ROLE_MEMBERSHIP_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(granted_role.rolname || ' -> ' || member_role.rolname, ', ' order by granted_role.rolname,member_role.rolname) into v_missing\n` +
    `  from pg_auth_members membership\n` +
    `  join pg_roles granted_role on granted_role.oid=membership.roleid\n` +
    `  join pg_roles member_role on member_role.oid=membership.member\n` +
    `  where (\n` +
    `    granted_role.rolname in ('anon','authenticated','service_role','authenticator')\n` +
    `    or member_role.rolname in ('anon','authenticated','service_role','authenticator')\n` +
    `  )\n` +
    `    and not (\n` +
    `      granted_role.rolname in ('anon','authenticated','service_role')\n` +
    `      and member_role.rolname='authenticator'\n` +
    `      and not membership.admin_option\n` +
    `      and not member_role.rolsuper\n` +
    `      and not member_role.rolbypassrls\n` +
    `      and not member_role.rolcreaterole\n` +
    `      and not coalesce(\n` +
    `        (to_jsonb(membership)->>'inherit_option')::boolean,\n` +
    `        member_role.rolinherit\n` +
    `      )\n` +
    `      and coalesce((to_jsonb(membership)->>'set_option')::boolean,true)\n` +
    `    );\n` +
    `  if v_missing is not null then raise exception 'STAGING_RUNTIME_ROLE_MEMBERSHIP_INVALID: %', v_missing; end if;\n` +
    `\n` +
    `  if not exists (\n` +
    `    select 1 from public.owner_control_historical_replay_guard\n` +
    `    where singleton\n` +
    `      and protected_migration='202608311800_owner_subscription_control'\n` +
    `      and historical_sha256='f4a00ed5595d710cb2c66107e7f1071fdb2179adfa3fff6b9a690a88556f8c43'\n` +
    `  ) then raise exception 'STAGING_OWNER_REPLAY_GUARD_ROW_MISSING'; end if;\n` +
    `\n` +
    `  if not exists (\n` +
    `    select 1 from public.clinics\n` +
    `    where id=${quote(target.tenant.expectedClinicId)}::uuid\n` +
    `      and code=${quote(target.tenant.expectedClinicCode)} and active and subscription_state='active'\n` +
    `  ) then raise exception 'STAGING_CLINIC_MISMATCH'; end if;\n` +
    `  if not exists (\n` +
    `    select 1 from public.clinic_memberships m\n` +
    `    join public.profiles p on p.id=m.profile_id\n` +
    `    where m.clinic_id=${quote(target.tenant.expectedClinicId)}::uuid\n` +
    `      and m.active and p.system_role='super_admin'\n` +
    `  ) then raise exception 'STAGING_ACTIVE_MEMBERSHIP_REQUIRED'; end if;\n` +
    `  if not exists (select 1 from public.profiles where system_role='super_admin') then\n` +
    `    raise exception 'STAGING_SUPER_ADMIN_REQUIRED';\n` +
    `  end if;\n` +
    (verificationOnly ? '' : `  perform set_config(\n` +
    `    'request.jwt.claim.sub',\n` +
    `    (select m.profile_id::text from public.clinic_memberships m\n` +
    `     join public.profiles p on p.id=m.profile_id\n` +
    `     where m.clinic_id=${quote(target.tenant.expectedClinicId)}::uuid\n` +
    `       and m.active and p.system_role='super_admin'\n` +
    `     order by m.is_primary desc,m.joined_at limit 1),\n` +
    `    true\n` +
    `  );\n` +
    `  perform set_config('request.jwt.claim.role','authenticated',true);\n`) +
    `\n` +
    `  select (select count(*) from public.patients)\n` +
    `       + (select count(*) from public.encounters)\n` +
    `       + (select count(*) from public.invoices)\n` +
    `       + (select count(*) from public.payments)\n` +
    `  into v_transactional_rows;\n` +
    `  if v_transactional_rows <> 0 then\n` +
    `    raise exception 'STAGING_LEDGER_RECOVERY_REQUIRES_EMPTY_TRANSACTIONAL_DATA: %', v_transactional_rows;\n` +
    `  end if;\n` +
    `\n` +
    `  if not exists (select 1 from pg_policies where schemaname='public' and tablename='products' and policyname='products_read_staff') then\n` +
    `    raise exception 'STAGING_PRODUCTS_READ_POLICY_MISSING';\n` +
    `  end if;\n` +
    `  if not exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='line_oa_webhook_events' and c.relrowsecurity) then\n` +
    `    raise exception 'STAGING_LINE_OA_OPERATIONAL_RLS_MISSING';\n` +
    `  end if;\n` +
    `  if not exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='line_oa_gateway_webhook_events' and c.relrowsecurity) then\n` +
    `    raise exception 'STAGING_LINE_OA_GATEWAY_RLS_MISSING';\n` +
    `  end if;\n` +
    `  if not exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='clinic_subscription_control_events' and c.relrowsecurity) then\n` +
    `    raise exception 'STAGING_OWNER_SUBSCRIPTION_RLS_MISSING';\n` +
    `  end if;\n` +
    `\n` +
    (verificationOnly ? '' : `  if not exists (select 1 from public.hybrid_patient_identity_healthcheck() where ready) then raise exception 'HYBRID_IDENTITY_HEALTHCHECK_FAILED'; end if;\n` +
    `  if not exists (select 1 from public.clinical_financial_handoffs_healthcheck() where ready) then raise exception 'CLINICAL_HANDOFF_HEALTHCHECK_FAILED'; end if;\n` +
    `  if not exists (select 1 from public.department_persistence_healthcheck() where ready) then raise exception 'DEPARTMENT_PERSISTENCE_HEALTHCHECK_FAILED'; end if;\n` +
    `  if not exists (select 1 from public.production_execution_healthcheck() where ready) then raise exception 'PRODUCTION_EXECUTION_HEALTHCHECK_FAILED'; end if;\n` +
    `  if not exists (select 1 from public.quality_release_healthcheck() where ready) then raise exception 'QUALITY_RELEASE_HEALTHCHECK_FAILED'; end if;\n` +
    `  if not exists (select 1 from public.prescription_dispensing_healthcheck() where ready) then raise exception 'PRESCRIPTION_DISPENSING_HEALTHCHECK_FAILED'; end if;\n` +
    `  if not exists (\n` +
    `    select 1 from public.backup_restore_contract_healthcheck()\n` +
    `    where ready\n` +
    `      and schema_version='2026-09-01.1'\n` +
    `      and domain_count=4\n` +
    `      and patient_table_count=31\n` +
    `      and product_table_count=16\n` +
    `      and pharmacy_table_count=7\n` +
    `      and transaction_table_count=12\n` +
    `      and managed_database_restore_required\n` +
    `  ) then raise exception 'BACKUP_RESTORE_CONTRACT_MISMATCH'; end if;\n` +
    `  if not exists (select 1 from public.line_oa_operational_healthcheck() where ready) then raise exception 'LINE_OA_OPERATIONAL_HEALTHCHECK_FAILED'; end if;\n` +
    `  execute 'create temporary table ${repairEvidenceMarker} (gate_token text not null, run_nonce uuid not null, repair_xid text not null, evidence jsonb, primary key (gate_token,run_nonce,repair_xid)) on commit drop';\n` +
    `  execute 'insert into pg_temp.${repairEvidenceMarker}(gate_token,run_nonce,repair_xid,evidence) values ($1,$2,$3,null)'\n` +
    `    using ${quote(repairGateToken)},current_setting(${quote(repairRunNonceGuc)})::uuid,v_repair_xid;\n`) +
    `end\n` +
    `$ledger_guard$;\n` +
    `\n` +
    (verificationOnly ? '' : `do $ledger_repair$\n` +
    `declare\n` +
    `  v_run_nonce uuid;\n` +
    `  v_repair_xid text;\n` +
    `  v_observed_system_identifier text;\n` +
    `  v_observed_current_database text;\n` +
    `  v_observed_session_user text;\n` +
    `  v_observed_current_user text;\n` +
    `begin\n` +
    repairAuthorizationBlockerSql +
    `  v_run_nonce := current_setting(${quote(repairRunNonceGuc)})::uuid;\n` +
    `  v_repair_xid := pg_catalog.pg_current_xact_id()::text;\n` +
    `  v_observed_current_database := pg_catalog.current_database();\n` +
    `  v_observed_session_user := session_user;\n` +
    `  v_observed_current_user := current_user;\n` +
    `  if v_observed_current_database is distinct from ${quote(expectedDatabaseName)}\n` +
    `     or v_observed_session_user is distinct from ${quote(expectedDatabaseUser)}\n` +
    `     or v_observed_current_user is distinct from ${quote(expectedDatabaseUser)} then\n` +
    `    raise exception 'CNYOS_LEDGER_REPAIR_SERVER_IDENTITY_REFUSED: expected database=% session_user=% current_user=%; observed database=% session_user=% current_user=%',\n` +
    `      ${quote(expectedDatabaseName)},${quote(expectedDatabaseUser)},${quote(expectedDatabaseUser)},\n` +
    `      coalesce(v_observed_current_database,'NULL'),coalesce(v_observed_session_user,'NULL'),\n` +
    `      coalesce(v_observed_current_user,'NULL');\n` +
    `  end if;\n` +
    `  select system_identifier::text into v_observed_system_identifier\n` +
    `  from pg_catalog.pg_control_system();\n` +
    `  if v_observed_system_identifier is distinct from ${quote(CHANANYA_REVIEWED_SYSTEM_IDENTIFIER)} then\n` +
    `    raise exception 'CNYOS_LEDGER_REPAIR_WRONG_CLUSTER: observed system_identifier=%',\n` +
    `      coalesce(v_observed_system_identifier,'NULL');\n` +
    `  end if;\n` +
    `  if to_regclass('pg_temp.${repairEvidenceMarker}') is null or not exists (\n` +
    `    select 1 from pg_temp.${repairEvidenceMarker}\n` +
    `    where gate_token=${quote(repairGateToken)} and run_nonce=v_run_nonce\n` +
    `      and repair_xid=v_repair_xid and evidence is null\n` +
    `  ) then raise exception 'STAGING_LEDGER_REPAIR_GUARD_REQUIRED'; end if;\n` +
    `  execute 'create schema if not exists supabase_migrations';\n` +
    `  execute 'create table if not exists supabase_migrations.schema_migrations (version text not null primary key)';\n` +
    `  execute 'alter table supabase_migrations.schema_migrations add column if not exists statements text[]';\n` +
    `  execute 'alter table supabase_migrations.schema_migrations add column if not exists name text';\n` +
    `  execute 'create table if not exists supabase_migrations.${repairReceiptTable} (` +
    `run_nonce uuid not null primary key, gate_token text not null, repair_xid text not null, ` +
    `evidence jsonb not null, committed_at timestamptz not null default pg_catalog.clock_timestamp(), ` +
    `unique (gate_token,repair_xid), ` +
    `constraint cnyos_repair_receipt_gate_token_check check (gate_token ~ ''^[0-9a-f]{64}$''), ` +
    `constraint cnyos_repair_receipt_xid_check check (repair_xid ~ ''^[0-9]+$''), ` +
    `constraint cnyos_repair_receipt_evidence_check check (` +
    `(pg_catalog.jsonb_typeof(evidence)=''object'' and ` +
    `evidence->>''repair_gate_token''=gate_token and ` +
    `evidence->>''repair_run_nonce''=run_nonce::text and ` +
    `evidence->>''repair_transaction_xid''=repair_xid) is true))';\n` +
    `  execute ${quote(`comment on table supabase_migrations.schema_migrations is ${quote(ledgerComment)}`)};\n` +
    `  execute ${quote(`comment on table supabase_migrations.${repairReceiptTable} is ${quote(repairReceiptComment)}`)};\n` +
    `  execute 'revoke all on schema supabase_migrations from public,anon,authenticated,service_role';\n` +
    `  execute 'revoke all on table supabase_migrations.schema_migrations from public,anon,authenticated,service_role';\n` +
    `  execute 'revoke all on table supabase_migrations.${repairReceiptTable} from public,anon,authenticated,service_role';\n` +
    `  execute 'lock table only supabase_migrations.schema_migrations in access exclusive mode';\n` +
    `  execute 'lock table only supabase_migrations.${repairReceiptTable} in access exclusive mode';\n` +
    `  if not exists (\n` +
    `    select 1 from pg_catalog.pg_namespace namespace\n` +
    `    join pg_catalog.pg_roles owner_role on owner_role.oid=namespace.nspowner\n` +
    `    where namespace.nspname='supabase_migrations'\n` +
    `      and owner_role.rolname=${quote(expectedDatabaseUser)}\n` +
    `      and not exists (\n` +
    `        select 1 from pg_catalog.aclexplode(coalesce(\n` +
    `          namespace.nspacl,pg_catalog.acldefault('n',namespace.nspowner)\n` +
    `        )) acl where acl.grantee<>namespace.nspowner\n` +
    `      )\n` +
    `  ) then raise exception 'CNYOS_LEDGER_REPAIR_SCHEMA_SECURITY_INVALID'; end if;\n` +
    `  if not exists (\n` +
    `    select 1 from pg_catalog.pg_class relation\n` +
    `    join pg_catalog.pg_roles owner_role on owner_role.oid=relation.relowner\n` +
    `    where relation.oid='supabase_migrations.schema_migrations'::regclass\n` +
    `      and relation.relkind='r' and relation.relpersistence='p'\n` +
    `      and not relation.relispartition and not relation.relrowsecurity\n` +
    `      and not relation.relforcerowsecurity and relation.relreplident='d'\n` +
    `      and owner_role.rolname=${quote(expectedDatabaseUser)}\n` +
    `      and pg_catalog.obj_description(relation.oid,'pg_class')=${quote(ledgerComment)}\n` +
    `      and not exists (\n` +
    `        select 1 from pg_catalog.aclexplode(coalesce(\n` +
    `          relation.relacl,pg_catalog.acldefault('r',relation.relowner)\n` +
    `        )) acl where acl.grantee<>relation.relowner\n` +
    `      )\n` +
    `      and not exists (select 1 from pg_catalog.pg_inherits where inhrelid=relation.oid or inhparent=relation.oid)\n` +
    `      and not exists (select 1 from pg_catalog.pg_policy where polrelid=relation.oid)\n` +
    `  ) then raise exception 'CNYOS_LEDGER_REPAIR_LEDGER_SECURITY_INVALID'; end if;\n` +
    `  if (\n` +
    `    select count(*) from pg_catalog.pg_attribute attribute\n` +
    `    where attribute.attrelid='supabase_migrations.schema_migrations'::regclass\n` +
    `      and attribute.attnum>0\n` +
    `  ) <> 3 or (\n` +
    `    select count(*)\n` +
    `    from pg_catalog.pg_attribute attribute\n` +
    `    join pg_catalog.pg_type type_definition on type_definition.oid=attribute.atttypid\n` +
    `    left join pg_catalog.pg_attrdef column_default\n` +
    `      on column_default.adrelid=attribute.attrelid and column_default.adnum=attribute.attnum\n` +
    `    where attribute.attrelid='supabase_migrations.schema_migrations'::regclass\n` +
    `      and attribute.attnum>0 and not attribute.attisdropped\n` +
    `      and attribute.atttypmod=-1\n` +
    `      and attribute.attislocal and attribute.attinhcount=0\n` +
    `      and attribute.attidentity='' and attribute.attgenerated=''\n` +
    `      and not attribute.atthasmissing and attribute.attacl is null\n` +
    `      and attribute.attcollation=type_definition.typcollation\n` +
    `      and not attribute.atthasdef and column_default.oid is null\n` +
    `      and ((attribute.attnum=1 and attribute.attname='version' and attribute.attndims=0\n` +
    `            and attribute.atttypid='pg_catalog.text'::regtype and attribute.attnotnull)\n` +
    `        or (attribute.attnum=2 and attribute.attname='statements' and attribute.attndims=1\n` +
    `            and attribute.atttypid='pg_catalog.text[]'::regtype and not attribute.attnotnull)\n` +
    `        or (attribute.attnum=3 and attribute.attname='name' and attribute.attndims=0\n` +
    `            and attribute.atttypid='pg_catalog.text'::regtype and not attribute.attnotnull))\n` +
    `  ) <> 3 or exists (\n` +
    `    select 1 from pg_catalog.pg_attrdef\n` +
    `    where adrelid='supabase_migrations.schema_migrations'::regclass\n` +
    `  ) then raise exception 'CNYOS_LEDGER_REPAIR_LEDGER_SHAPE_INVALID'; end if;\n` +
    `  if not exists (\n` +
    `    select 1 from pg_catalog.pg_constraint constraint_definition\n` +
    `    join pg_catalog.pg_index index_definition on index_definition.indexrelid=constraint_definition.conindid\n` +
    `    join pg_catalog.pg_class index_relation on index_relation.oid=index_definition.indexrelid\n` +
    `    join pg_catalog.pg_am index_method on index_method.oid=index_relation.relam\n` +
    `    where constraint_definition.conrelid='supabase_migrations.schema_migrations'::regclass\n` +
    `      and constraint_definition.contype='p' and not constraint_definition.condeferrable\n` +
    `      and not constraint_definition.condeferred and constraint_definition.convalidated\n` +
    `      and constraint_definition.conislocal and constraint_definition.coninhcount=0\n` +
    `      and pg_catalog.pg_get_constraintdef(constraint_definition.oid,true)='PRIMARY KEY (version)'\n` +
    `      and (select array_agg(attribute.attname order by key_column.ordinality)\n` +
    `           from unnest(constraint_definition.conkey) with ordinality key_column(attnum,ordinality)\n` +
    `           join pg_catalog.pg_attribute attribute on attribute.attrelid=constraint_definition.conrelid\n` +
    `             and attribute.attnum=key_column.attnum)=array['version']::name[]\n` +
    `      and index_method.amname='btree' and index_definition.indisunique\n` +
    `      and index_definition.indisprimary and index_definition.indisvalid\n` +
    `      and index_definition.indisready and index_definition.indislive\n` +
    `      and index_definition.indimmediate and index_definition.indexprs is null\n` +
    `      and index_definition.indpred is null and index_definition.indnkeyatts=1\n` +
    `      and index_definition.indnatts=1\n` +
    `  ) or (select count(*) from pg_catalog.pg_constraint\n` +
    `        where conrelid='supabase_migrations.schema_migrations'::regclass) <> 1\n` +
    `    or (select count(*) from pg_catalog.pg_index\n` +
    `        where indrelid='supabase_migrations.schema_migrations'::regclass) <> 1 then\n` +
    `    raise exception 'CNYOS_LEDGER_REPAIR_LEDGER_CONSTRAINT_INVALID';\n` +
    `  end if;\n` +
    `  if not exists (\n` +
    `    select 1 from pg_catalog.pg_class relation\n` +
    `    join pg_catalog.pg_roles owner_role on owner_role.oid=relation.relowner\n` +
    `    where relation.oid=${quote(`supabase_migrations.${repairReceiptTable}`)}::regclass\n` +
    `      and relation.relkind='r' and relation.relpersistence='p'\n` +
    `      and not relation.relispartition and not relation.relrowsecurity\n` +
    `      and not relation.relforcerowsecurity and relation.relreplident='d'\n` +
    `      and owner_role.rolname=${quote(expectedDatabaseUser)}\n` +
    `      and pg_catalog.obj_description(relation.oid,'pg_class')=${quote(repairReceiptComment)}\n` +
    `      and not exists (\n` +
    `        select 1 from pg_catalog.aclexplode(coalesce(\n` +
    `          relation.relacl,pg_catalog.acldefault('r',relation.relowner)\n` +
    `        )) acl where acl.grantee<>relation.relowner\n` +
    `      )\n` +
    `      and not exists (select 1 from pg_catalog.pg_inherits where inhrelid=relation.oid or inhparent=relation.oid)\n` +
    `      and not exists (select 1 from pg_catalog.pg_policy where polrelid=relation.oid)\n` +
    `  ) then raise exception 'CNYOS_LEDGER_REPAIR_RECEIPT_SECURITY_INVALID'; end if;\n` +
    `  if (\n` +
    `    select count(*) from pg_catalog.pg_attribute attribute\n` +
    `    where attribute.attrelid=${quote(`supabase_migrations.${repairReceiptTable}`)}::regclass\n` +
    `      and attribute.attnum>0\n` +
    `  ) <> 5 or (\n` +
    `    select count(*)\n` +
    `    from pg_catalog.pg_attribute attribute\n` +
    `    join pg_catalog.pg_type type_definition on type_definition.oid=attribute.atttypid\n` +
    `    left join pg_catalog.pg_attrdef column_default\n` +
    `      on column_default.adrelid=attribute.attrelid and column_default.adnum=attribute.attnum\n` +
    `    where attribute.attrelid=${quote(`supabase_migrations.${repairReceiptTable}`)}::regclass\n` +
    `      and attribute.attnum>0 and not attribute.attisdropped\n` +
    `      and attribute.atttypmod=-1 and attribute.attndims=0\n` +
    `      and attribute.attislocal and attribute.attinhcount=0\n` +
    `      and attribute.attidentity='' and attribute.attgenerated=''\n` +
    `      and not attribute.atthasmissing and attribute.attacl is null\n` +
    `      and attribute.attcollation=type_definition.typcollation\n` +
    `      and ((attribute.attnum=1 and attribute.attname='run_nonce'\n` +
    `            and attribute.atttypid='pg_catalog.uuid'::regtype and attribute.attnotnull\n` +
    `            and not attribute.atthasdef and column_default.oid is null)\n` +
    `        or (attribute.attnum=2 and attribute.attname='gate_token'\n` +
    `            and attribute.atttypid='pg_catalog.text'::regtype and attribute.attnotnull\n` +
    `            and not attribute.atthasdef and column_default.oid is null)\n` +
    `        or (attribute.attnum=3 and attribute.attname='repair_xid'\n` +
    `            and attribute.atttypid='pg_catalog.text'::regtype and attribute.attnotnull\n` +
    `            and not attribute.atthasdef and column_default.oid is null)\n` +
    `        or (attribute.attnum=4 and attribute.attname='evidence'\n` +
    `            and attribute.atttypid='pg_catalog.jsonb'::regtype and attribute.attnotnull\n` +
    `            and not attribute.atthasdef and column_default.oid is null)\n` +
    `        or (attribute.attnum=5 and attribute.attname='committed_at'\n` +
    `            and attribute.atttypid='pg_catalog.timestamptz'::regtype and attribute.attnotnull\n` +
    `            and attribute.atthasdef and column_default.oid is not null\n` +
    `            and pg_catalog.pg_get_expr(column_default.adbin,column_default.adrelid,true)='clock_timestamp()'))\n` +
    `  ) <> 5 or (\n` +
    `    select count(*) from pg_catalog.pg_attrdef\n` +
    `    where adrelid=${quote(`supabase_migrations.${repairReceiptTable}`)}::regclass\n` +
    `      and adnum=5 and pg_catalog.pg_get_expr(adbin,adrelid,true)='clock_timestamp()'\n` +
    `  ) <> 1 or (\n` +
    `    select count(*) from pg_catalog.pg_attrdef\n` +
    `    where adrelid=${quote(`supabase_migrations.${repairReceiptTable}`)}::regclass\n` +
    `  ) <> 1 then raise exception 'CNYOS_LEDGER_REPAIR_RECEIPT_SHAPE_INVALID'; end if;\n` +
    `  if exists (\n` +
    `    select 1 from pg_catalog.pg_class relation\n` +
    `    where relation.oid in (\n` +
    `      'supabase_migrations.schema_migrations'::regclass,\n` +
    `      ${quote(`supabase_migrations.${repairReceiptTable}`)}::regclass\n` +
    `    ) and (relation.relhastriggers or relation.relhasrules\n` +
    `      or exists (select 1 from pg_catalog.pg_trigger where tgrelid=relation.oid)\n` +
    `      or exists (select 1 from pg_catalog.pg_rewrite where ev_class=relation.oid))\n` +
    `  ) then raise exception 'CNYOS_LEDGER_REPAIR_RELATION_HOOK_INVALID'; end if;\n` +
    `  if not exists (\n` +
    `    select 1 from pg_catalog.pg_constraint constraint_definition\n` +
    `    where constraint_definition.conrelid=${quote(`supabase_migrations.${repairReceiptTable}`)}::regclass\n` +
    `      and constraint_definition.contype='p'\n` +
    `      and not constraint_definition.condeferrable\n` +
    `      and not constraint_definition.condeferred\n` +
    `      and constraint_definition.convalidated\n` +
    `      and constraint_definition.conislocal\n` +
    `      and constraint_definition.coninhcount=0\n` +
    `      and pg_catalog.pg_get_constraintdef(constraint_definition.oid,true)='PRIMARY KEY (run_nonce)'\n` +
    `      and (select array_agg(attribute.attname order by key_column.ordinality)\n` +
    `           from unnest(constraint_definition.conkey) with ordinality key_column(attnum,ordinality)\n` +
    `           join pg_catalog.pg_attribute attribute\n` +
    `             on attribute.attrelid=constraint_definition.conrelid and attribute.attnum=key_column.attnum\n` +
    `      )=array['run_nonce']::name[]\n` +
    `  ) or not exists (\n` +
    `    select 1 from pg_catalog.pg_constraint constraint_definition\n` +
    `    where constraint_definition.conrelid=${quote(`supabase_migrations.${repairReceiptTable}`)}::regclass\n` +
    `      and constraint_definition.contype='u'\n` +
    `      and not constraint_definition.condeferrable\n` +
    `      and not constraint_definition.condeferred\n` +
    `      and constraint_definition.convalidated\n` +
    `      and constraint_definition.conislocal\n` +
    `      and constraint_definition.coninhcount=0\n` +
    `      and pg_catalog.pg_get_constraintdef(constraint_definition.oid,true)='UNIQUE (gate_token, repair_xid)'\n` +
    `      and (select array_agg(attribute.attname order by key_column.ordinality)\n` +
    `           from unnest(constraint_definition.conkey) with ordinality key_column(attnum,ordinality)\n` +
    `           join pg_catalog.pg_attribute attribute\n` +
    `             on attribute.attrelid=constraint_definition.conrelid and attribute.attnum=key_column.attnum\n` +
    `      )=array['gate_token','repair_xid']::name[]\n` +
    `  ) or (\n` +
    `    select count(*)\n` +
    `    from (values ${sqlRows(repairReceiptCheckDefinitions)}) expected(\n` +
    `      constraint_name,constraint_definition\n` +
    `    )\n` +
    `    join pg_catalog.pg_constraint actual\n` +
    `      on actual.conrelid=${quote(`supabase_migrations.${repairReceiptTable}`)}::regclass\n` +
    `     and actual.conname=expected.constraint_name\n` +
    `     and actual.contype='c'\n` +
    `     and actual.convalidated\n` +
    `     and not actual.condeferrable\n` +
    `     and not actual.condeferred\n` +
    `     and actual.conislocal\n` +
    `     and actual.coninhcount=0\n` +
    `     and not actual.connoinherit\n` +
    `     and pg_catalog.pg_get_constraintdef(actual.oid,true)=expected.constraint_definition\n` +
    `  ) <> ${repairReceiptCheckDefinitions.length} or (\n` +
    `    select count(*) from pg_catalog.pg_constraint constraint_definition\n` +
    `    where constraint_definition.conrelid=${quote(`supabase_migrations.${repairReceiptTable}`)}::regclass\n` +
    `      and constraint_definition.contype='c'\n` +
    `  ) <> ${repairReceiptCheckDefinitions.length} or (\n` +
    `    select count(*) from pg_catalog.pg_constraint constraint_definition\n` +
    `    where constraint_definition.conrelid=${quote(`supabase_migrations.${repairReceiptTable}`)}::regclass\n` +
    `  ) <> ${repairReceiptCheckDefinitions.length + 2} or (\n` +
    `    select count(*) from pg_catalog.pg_index index_definition\n` +
    `    where index_definition.indrelid=${quote(`supabase_migrations.${repairReceiptTable}`)}::regclass\n` +
    `  ) <> 2 or (\n` +
    `    select count(*)\n` +
    `    from pg_catalog.pg_constraint constraint_definition\n` +
    `    join pg_catalog.pg_index index_definition on index_definition.indexrelid=constraint_definition.conindid\n` +
    `    join pg_catalog.pg_class index_relation on index_relation.oid=index_definition.indexrelid\n` +
    `    join pg_catalog.pg_am index_method on index_method.oid=index_relation.relam\n` +
    `    where constraint_definition.conrelid=${quote(`supabase_migrations.${repairReceiptTable}`)}::regclass\n` +
    `      and constraint_definition.contype in ('p','u') and index_method.amname='btree'\n` +
    `      and index_definition.indisunique and index_definition.indisvalid\n` +
    `      and index_definition.indisready and index_definition.indislive\n` +
    `      and index_definition.indimmediate and index_definition.indexprs is null\n` +
    `      and index_definition.indpred is null\n` +
    `      and ((constraint_definition.contype='p' and index_definition.indisprimary\n` +
    `            and index_definition.indnkeyatts=1 and index_definition.indnatts=1)\n` +
    `        or (constraint_definition.contype='u' and not index_definition.indisprimary\n` +
    `            and index_definition.indnkeyatts=2 and index_definition.indnatts=2))\n` +
    `  ) <> 2 then\n` +
    `    raise exception 'CNYOS_LEDGER_REPAIR_RECEIPT_CONSTRAINT_INVALID';\n` +
    `  end if;\n` +
    `  if exists (\n` +
    `    select 1 from supabase_migrations.${repairReceiptTable}\n` +
    `    where run_nonce=v_run_nonce\n` +
    `  ) then raise exception 'CNYOS_LEDGER_REPAIR_NONCE_REPLAY'; end if;\n` +
    `\n` +
    `  if exists (\n` +
    `    select 1\n` +
    `    from supabase_migrations.schema_migrations actual\n` +
    `    left join (values\n      ${expectedRows}\n` +
    `    ) expected(version,name,sha256,evidence) on expected.version=actual.version\n` +
    `    where expected.version is null\n` +
    `       or (actual.name is not null and actual.name is distinct from expected.name)\n` +
    `  ) then raise exception 'MIGRATION_LEDGER_CONFLICT'; end if;\n` +
    `  if exists (\n` +
    `    select 1\n` +
    `    from supabase_migrations.schema_migrations actual\n` +
    `    join (values\n      ${expectedRows}\n` +
    `    ) expected(version,name,sha256,expected_evidence) on expected.version=actual.version\n` +
    `    cross join lateral unnest(coalesce(actual.statements,array[]::text[])) evidence(statement)\n` +
    `    where evidence.statement ~* '^[[:space:]]*-- recovered from supabase/migrations/[^;]+;[[:space:]]*sha256[[:space:]]*='\n` +
    `      and (\n` +
    `        substring(evidence.statement from '^[[:space:]]*-- recovered from supabase/migrations/[^;]+;[[:space:]]*sha256[[:space:]]*=[[:space:]]*([0-9A-Fa-f]{64})[[:space:]]*$') is null\n` +
    `        or lower(substring(evidence.statement from '^[[:space:]]*-- recovered from supabase/migrations/[^;]+;[[:space:]]*sha256[[:space:]]*=[[:space:]]*([0-9A-Fa-f]{64})[[:space:]]*$')) <> expected.sha256\n` +
    `      )\n` +
    `  ) then raise exception 'MIGRATION_LEDGER_SHA256_CONFLICT'; end if;\n` +
    `\n` +
    `insert into supabase_migrations.schema_migrations as ledger(version,name,statements) values\n  ${inserts}\n` +
    `on conflict (version) do update set\n` +
    `  name=excluded.name,\n` +
    `  statements=(\n` +
    `    select coalesce(\n` +
    `      array_agg(evidence.statement order by evidence.ordinality) filter (\n` +
    `        where evidence.statement !~* '^[[:space:]]*-- recovered from supabase/migrations/[^;]+;[[:space:]]*sha256[[:space:]]*='\n` +
    `      ),\n` +
    `      array[]::text[]\n` +
    `    ) || excluded.statements\n` +
    `    from unnest(coalesce(ledger.statements,array[]::text[]))\n` +
    `      with ordinality evidence(statement,ordinality)\n` +
    `  );\n` +
    `\n` +
    `set constraints all immediate;\n` +
    `  if (${exactLedgerInvariantPredicate}) is not true then\n` +
    `    raise exception 'MIGRATION_LEDGER_EXACT_INVARIANT_INVALID';\n` +
    `  end if;\n` +
    `\n` +
    `update pg_temp.${repairEvidenceMarker}\n` +
    `set evidence=(\n` +
    `  select pg_catalog.jsonb_build_object(\n` +
    `    'status',${quote(repairStatus)},\n` +
    `    'expected_deployment_id',${quote(target.deploymentId)},\n` +
    `    'expected_project_ref',${quote(targetProjectRef)},\n` +
    `    'expected_database_origin',${quote(targetDatabaseUrl.origin)},\n` +
    `    'expected_database_host',${quote(expectedDatabaseHost)},\n` +
    `    'expected_current_database',${quote(expectedDatabaseName)},\n` +
    `    'expected_session_user',${quote(expectedDatabaseUser)},\n` +
    `    'expected_current_user',${quote(expectedDatabaseUser)},\n` +
    `    'expected_system_identifier',${quote(CHANANYA_REVIEWED_SYSTEM_IDENTIFIER)},\n` +
    `    'observed_system_identifier',v_observed_system_identifier,\n` +
    `    'observed_psql_host',current_setting(${quote(repairObservedHostGuc)}),\n` +
    `    'observed_psql_port',current_setting(${quote(repairObservedPortGuc)}),\n` +
    `    'observed_psql_user',current_setting(${quote(repairObservedUserGuc)}),\n` +
    `    'observed_psql_database',current_setting(${quote(repairObservedDatabaseGuc)}),\n` +
    `    'observed_server_address',pg_catalog.inet_server_addr()::text,\n` +
    `    'observed_server_port',pg_catalog.inet_server_port(),\n` +
    `    'observed_current_database',v_observed_current_database,\n` +
    `    'observed_session_user',v_observed_session_user,\n` +
    `    'observed_current_user',v_observed_current_user,\n` +
    `    'observed_ssl',(select ssl from pg_catalog.pg_stat_ssl where pid=pg_catalog.pg_backend_pid()),\n` +
    `    'observed_ssl_version',(select version from pg_catalog.pg_stat_ssl where pid=pg_catalog.pg_backend_pid()),\n` +
    `    'observed_ssl_cipher',(select cipher from pg_catalog.pg_stat_ssl where pid=pg_catalog.pg_backend_pid()),\n` +
    `    'expected_clinic_code',${quote(target.tenant.expectedClinicCode)},\n` +
    `    'expected_clinic_id',${quote(target.tenant.expectedClinicId)},\n` +
    `    'acl_phase',${quote(resolvedAclPhase)},\n` +
    `    'repair_gate_token',${quote(repairGateToken)},\n` +
    `    'repair_run_nonce',v_run_nonce,\n` +
    `    'repair_transaction_xid',v_repair_xid,\n` +
    `    'trigger_server_major',${CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.serverMajor},\n` +
    `    'trigger_server_encoding',${quote(CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.serverEncoding)},\n` +
    (isChananyaPreReconciliation
      ? `    'classified_public_routine_count',${CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.routineCount},\n` +
        `    'security_definer_path_plan_count',${CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.securityDefinerPathPlan.count},\n` +
        `    'security_definer_path_plan_sha256',${quote(CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.securityDefinerPathPlan.sha256)},\n` +
        `    'trigger_binding_count',${CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.triggerBindingCount},\n` +
        `    'trigger_binding_dataset_sha256',${quote(CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.triggerBindingDatasetSha256)},\n` +
        `    'trigger_relation_lock_plan_count',${CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.triggerRelationLockPlanCount},\n` +
        `    'trigger_relation_lock_plan_payload_bytes',${CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.triggerRelationLockPlanPayloadBytes},\n` +
        `    'trigger_relation_lock_plan_sha256',${quote(CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.triggerRelationLockPlanSha256)},\n` +
        `    'event_trigger_binding_count',${CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.eventTriggerBindingCount},\n` +
        `    'event_trigger_binding_dataset_sha256',${quote(CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.eventTriggerBindingDatasetSha256)}\n`
      : `    'trigger_function_semantic_count',${legacyStrictTriggerGuardManifest.functionSemanticCount},\n` +
        `    'trigger_function_semantic_payload_bytes',${expectedTriggerSemanticPayloadBytes},\n` +
        `    'trigger_function_semantic_sha256',${quote(expectedTriggerSemanticSha256)},\n` +
        `    'trigger_binding_count',${legacyStrictTriggerGuardManifest.bindingCount},\n` +
        `    'trigger_binding_payload_bytes',${legacyStrictTriggerGuardManifest.bindingPayloadBytes},\n` +
        `    'trigger_binding_sha256',${quote(legacyStrictTriggerGuardManifest.bindingSha256)}\n`) +
    `  ) || pg_catalog.jsonb_build_object(\n` +
    `    'ledger_reconciled',${isChananyaPreReconciliation ? 'false' : 'true'},\n` +
    `    'acl_remediation_pending',${isChananyaPreReconciliation ? 'true' : 'false'},\n` +
    `    'browser_rpc_acl_remediation_pending',${isChananyaPreReconciliation ? 'true' : 'false'},\n` +
    `    'trigger_function_acl_remediation_pending',${isChananyaPreReconciliation ? 'true' : 'false'},\n` +
    `    'repository_derived_treatment_session_acl_manifest_sha256',${quote(REPOSITORY_DERIVED_CLINICAL_TREATMENT_SESSION_ACL_MANIFEST.sha256)},\n` +
    `    'repository_derived_treatment_session_acl_provenance',${quote(REPOSITORY_DERIVED_CLINICAL_TREATMENT_SESSION_ACL_MANIFEST.provenance)},\n` +
    `    'repository_derived_treatment_session_public_execute_debt_pending',${isChananyaPreReconciliation ? 'true' : 'false'},\n` +
    `    'production_eligible',false,\n` +
    (isChananyaPreReconciliation
      ? `    'authorization',false,\n` +
        `    'classification_coverage_complete',true,\n` +
        `    'live_callable_acl_inventory_complete',true,\n` +
        `    'independent_security_review_complete',false,\n` +
        `    'ledger_reconciliation_authorized',false,\n` +
        `    'managed_supabase_admin_exception_accepted',false,\n` +
        `    'security_definer_path_plan_approved',false,\n` +
        `    'hosted_concurrency_protocol_approved',false,\n` +
        `    'hosted_trigger_relation_lock_plan_rehearsed',false,\n` +
        `    'fresh_post_commit_observer_required',true,\n` +
        `    'fresh_post_commit_observer_completed',false,\n` +
        `    'ledger_reconciliation_blocked_pending_independent_review_and_authorization',true,\n` +
        `    'reviewed_pre_reconciliation_evidence_bundle_sha256',${quote(CHANANYA_PRE_RECONCILIATION_KNOWN_EVIDENCE_BUNDLE.sha256)},\n` +
        `    'observer_raw_sha256',${quote(CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.observerRawSha256)},\n` +
        `    'observer_source_sql_sha256',${quote(CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.observerSourceSqlSha256)},\n` +
        `    'observation_composite_sha256',${quote(CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.observationCompositeSha256)},\n` +
        `    'disposition_artifact_sha256',${quote(CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.dispositionArtifactSha256)},\n` +
        `    'disposition_payload_sha256',${quote(CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.dispositionPayloadSha256)},\n` +
        `    'complete_acl_candidate_sha256',${quote(CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.completeAclCandidateSha256)},\n` +
        `    'post_toggle_default_acl_evidence_sha256',${quote(CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.postToggleDefaultAclBaseline.externalEvidenceSha256)},\n` +
        `    'ledger_target_baseline_evidence_sha256',${quote(CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.ledgerTargetBaseline.externalEvidenceSha256)},\n`
      : '') +
    `    'migration_manifest_sha256',${quote(migrationManifestSha256(entries))},\n` +
    `    'migration_count',count(*),\n` +
    `    'first_version',min(version),\n` +
    `    'last_version',max(version),\n` +
    `    'source_revision',${quote(revision || 'not-supplied')}\n` +
    `  )\n` +
    `  from supabase_migrations.schema_migrations\n` +
    `)\n` +
    `where gate_token=${quote(repairGateToken)} and run_nonce=v_run_nonce\n` +
    `  and repair_xid=v_repair_xid and evidence is null;\n` +
    `if not found then raise exception 'STAGING_LEDGER_REPAIR_EVIDENCE_MARKER_MISSING'; end if;\n` +
    `insert into supabase_migrations.${repairReceiptTable}(run_nonce,gate_token,repair_xid,evidence)\n` +
    `select run_nonce,gate_token,repair_xid,evidence\n` +
    `from pg_temp.${repairEvidenceMarker}\n` +
    `where gate_token=${quote(repairGateToken)} and run_nonce=v_run_nonce\n` +
    `  and repair_xid=v_repair_xid\n` +
    `  and evidence->>'repair_gate_token'=gate_token\n` +
    `  and evidence->>'repair_run_nonce'=run_nonce::text\n` +
    `  and evidence->>'repair_transaction_xid'=repair_xid;\n` +
    `if not found then raise exception 'CNYOS_LEDGER_REPAIR_RECEIPT_INSERT_FAILED'; end if;\n` +
    `set constraints all immediate;\n` +
    `if (${exactLedgerInvariantPredicate}) is not true then\n` +
    `  raise exception 'CNYOS_LEDGER_REPAIR_POST_RECEIPT_LEDGER_INVALID';\n` +
    `end if;\n` +
    `if not exists (\n` +
    `  select 1 from supabase_migrations.${repairReceiptTable} receipt\n` +
    `  where receipt.run_nonce=v_run_nonce and receipt.gate_token=${quote(repairGateToken)}\n` +
    `    and receipt.repair_xid=v_repair_xid and receipt.committed_at is not null\n` +
    `    and (pg_catalog.jsonb_typeof(receipt.evidence)='object'\n` +
    `      and receipt.evidence->>'repair_gate_token'=receipt.gate_token\n` +
    `      and receipt.evidence->>'repair_run_nonce'=receipt.run_nonce::text\n` +
    `      and receipt.evidence->>'repair_transaction_xid'=receipt.repair_xid) is true\n` +
    `) then raise exception 'CNYOS_LEDGER_REPAIR_RECEIPT_INSERT_INVALID'; end if;\n` +
    `perform set_config(${quote(repairCommittedNonceGuc)},v_run_nonce::text,false);\n` +
    `perform set_config(${quote(repairCommittedXidGuc)},v_repair_xid,false);\n` +
    `end\n` +
    `$ledger_repair$;\n` +
    `commit;\n` +
    `begin isolation level repeatable read read only;\n` +
    canonicalCatalogOutputGucSql +
    `set local search_path = pg_catalog, pg_temp, public;\n` +
    `set local statement_timeout = '60s';\n` +
    `set local lock_timeout = '5s';\n` +
    `lock table only supabase_migrations.schema_migrations in share mode;\n` +
    `lock table only supabase_migrations.${repairReceiptTable} in share mode;\n` +
    `\\unset cnyos_repair_evidence\n` +
    `select case when count(*)=1 then min(receipt.evidence::text) end as cnyos_repair_evidence\n` +
    `from supabase_migrations.${repairReceiptTable} receipt\n` +
    `where receipt.gate_token=${quote(repairGateToken)}\n` +
    `  and receipt.run_nonce=:'cnyos_repair_run_nonce'::uuid\n` +
    `  and receipt.repair_xid=coalesce(current_setting(${quote(repairCommittedXidGuc)},true),'')\n` +
    `  and receipt.committed_at is not null\n` +
    `  and (coalesce(current_setting(${quote(repairCommittedNonceGuc)},true),'')=\n` +
    `        :'cnyos_repair_run_nonce'\n` +
    `    and pg_catalog.current_database()=${quote(expectedDatabaseName)}\n` +
    `    and session_user=${quote(expectedDatabaseUser)}\n` +
    `    and current_user=${quote(expectedDatabaseUser)}\n` +
    `    and current_setting('transaction_read_only')='on'\n` +
    `    and current_setting('transaction_isolation')='repeatable read'\n` +
    `    and pg_catalog.jsonb_typeof(receipt.evidence)='object'\n` +
    `    and receipt.evidence->>'repair_gate_token'=receipt.gate_token\n` +
    `    and receipt.evidence->>'repair_run_nonce'=receipt.run_nonce::text\n` +
    `    and receipt.evidence->>'repair_transaction_xid'=receipt.repair_xid\n` +
    `    and receipt.evidence->>'status'=${quote(repairStatus)}\n` +
    `    and receipt.evidence->>'expected_current_database'=${quote(expectedDatabaseName)}\n` +
    `    and receipt.evidence->>'expected_session_user'=${quote(expectedDatabaseUser)}\n` +
    `    and receipt.evidence->>'expected_current_user'=${quote(expectedDatabaseUser)}\n` +
    `    and receipt.evidence->>'observed_current_database'=${quote(expectedDatabaseName)}\n` +
    `    and receipt.evidence->>'observed_session_user'=${quote(expectedDatabaseUser)}\n` +
    `    and receipt.evidence->>'observed_current_user'=${quote(expectedDatabaseUser)}\n` +
    `    and receipt.evidence->>'expected_system_identifier'=${quote(CHANANYA_REVIEWED_SYSTEM_IDENTIFIER)}\n` +
    `    and receipt.evidence->>'observed_system_identifier'=${quote(CHANANYA_REVIEWED_SYSTEM_IDENTIFIER)}\n` +
    `    and receipt.evidence->>'migration_manifest_sha256'=${quote(migrationManifestSha256(entries))}\n` +
    `    and receipt.evidence->>'migration_count'=${quote(entries.length)}\n` +
    `    and receipt.evidence->>'first_version'=${quote(entries[0].version)}\n` +
    `    and receipt.evidence->>'last_version'=${quote(entries.at(-1).version)}\n` +
    `    and receipt.evidence->>'source_revision'=${quote(revision)}\n` +
    `    and receipt.evidence->>'repository_derived_treatment_session_acl_manifest_sha256'=\n` +
    `        ${quote(REPOSITORY_DERIVED_CLINICAL_TREATMENT_SESSION_ACL_MANIFEST.sha256)}\n` +
    `    and receipt.evidence->>'repository_derived_treatment_session_acl_provenance'=\n` +
    `        ${quote(REPOSITORY_DERIVED_CLINICAL_TREATMENT_SESSION_ACL_MANIFEST.provenance)}\n` +
    `    and receipt.evidence->>'repository_derived_treatment_session_public_execute_debt_pending'=\n` +
    `        ${quote(isChananyaPreReconciliation)}\n` +
    (isChananyaPreReconciliation
      ? `    and receipt.evidence->>'authorization'='false'\n` +
        `    and receipt.evidence->>'classification_coverage_complete'='true'\n` +
        `    and receipt.evidence->>'live_callable_acl_inventory_complete'='true'\n` +
        `    and receipt.evidence->>'independent_security_review_complete'='false'\n` +
        `    and receipt.evidence->>'ledger_reconciliation_authorized'='false'\n` +
        `    and receipt.evidence->>'hosted_concurrency_protocol_approved'='false'\n` +
        `    and receipt.evidence->>'hosted_trigger_relation_lock_plan_rehearsed'='false'\n` +
        `    and receipt.evidence->>'fresh_post_commit_observer_required'='true'\n` +
        `    and receipt.evidence->>'fresh_post_commit_observer_completed'='false'\n` +
        `    and receipt.evidence->>'ledger_reconciliation_blocked_pending_independent_review_and_authorization'='true'\n`
      : '') +
    `    and receipt.evidence->>'ledger_reconciled'=${quote(!isChananyaPreReconciliation)}\n` +
    `    and receipt.evidence->>'production_eligible'='false') is true\n` +
    `  and (${exactLedgerInvariantPredicate}) is true\n` +
    `\\gset\n` +
    `\\if :{?cnyos_repair_evidence}\n` +
    `rollback;\n` +
    `\\unset cnyos_repair_lock_released\n` +
    `select pg_catalog.pg_advisory_unlock(202608302100::bigint) as cnyos_repair_lock_released\n` +
    `\\gset\n` +
    `\\if :cnyos_repair_lock_released\n` +
    `\\unset cnyos_repair_lock_fully_released\n` +
    `select not exists (\n` +
    `  select 1\n` +
    `  from pg_catalog.pg_locks\n` +
    `  where locktype='advisory' and pid=pg_catalog.pg_backend_pid() and granted\n` +
    `    and classid::bigint=(202608302100::bigint >> 32)\n` +
    `    and objid::bigint=(202608302100::bigint & 4294967295::bigint)\n` +
    `    and objsubid=1\n` +
    `) as cnyos_repair_lock_fully_released\n` +
    `\\gset\n` +
    `\\if :cnyos_repair_lock_fully_released\n` +
    `select :'cnyos_repair_evidence'::jsonb as migration_ledger_evidence;\n` +
    `\\else\n` +
    `\\warn 'CNYOS ledger repair advisory key remains held after unlock'\n` +
    `do $cnyos_psql_unlock_abort$\n` +
    `begin\n` +
    `  raise exception 'CNYOS_LEDGER_REPAIR_ADVISORY_UNLOCK_FAILED';\n` +
    `end\n` +
    `$cnyos_psql_unlock_abort$;\n` +
    `\\endif\n` +
    `\\else\n` +
    `\\warn 'CNYOS ledger repair session advisory lock was not released'\n` +
    `do $cnyos_psql_unlock_abort$\n` +
    `begin\n` +
    `  raise exception 'CNYOS_LEDGER_REPAIR_ADVISORY_UNLOCK_FAILED';\n` +
    `end\n` +
    `$cnyos_psql_unlock_abort$;\n` +
    `\\endif\n` +
    `\\else\n` +
    `rollback;\n` +
    `\\unset cnyos_repair_lock_released\n` +
    `select pg_catalog.pg_advisory_unlock(202608302100::bigint) as cnyos_repair_lock_released\n` +
    `\\gset\n` +
    `\\unset cnyos_repair_lock_fully_released\n` +
    `select (\n` +
    `  :'cnyos_repair_lock_released'::boolean and not exists (\n` +
    `    select 1\n` +
    `    from pg_catalog.pg_locks\n` +
    `    where locktype='advisory' and pid=pg_catalog.pg_backend_pid() and granted\n` +
    `      and classid::bigint=(202608302100::bigint >> 32)\n` +
    `      and objid::bigint=(202608302100::bigint & 4294967295::bigint)\n` +
    `      and objsubid=1\n` +
    `  )\n` +
    `) as cnyos_repair_lock_fully_released\n` +
    `\\gset\n` +
    `\\if :cnyos_repair_lock_fully_released\n` +
    `\\warn 'CNYOS ledger repair committed state failed durable proof'\n` +
    `do $cnyos_psql_commit_proof_abort$\n` +
    `begin\n` +
    `  raise exception 'CNYOS_LEDGER_REPAIR_COMMIT_PROOF_FAILED';\n` +
    `end\n` +
    `$cnyos_psql_commit_proof_abort$;\n` +
    `\\else\n` +
    `\\warn 'CNYOS ledger repair advisory key was not fully released after proof failure'\n` +
    `do $cnyos_psql_unlock_abort$\n` +
    `begin\n` +
    `  raise exception 'CNYOS_LEDGER_REPAIR_ADVISORY_UNLOCK_FAILED';\n` +
    `end\n` +
    `$cnyos_psql_unlock_abort$;\n` +
    `\\endif\n` +
    `\\endif\n` +
    `\\unset cnyos_repair_probe_xid\n` +
    `\\unset cnyos_repair_existing_transaction\n` +
    `\\unset cnyos_repair_session_nonce\n` +
    `\\unset cnyos_repair_committed_nonce\n` +
    `\\unset cnyos_repair_committed_xid\n` +
    `\\unset cnyos_repair_connection_ok\n` +
    `\\unset cnyos_repair_server_identity_ok\n` +
    `\\unset cnyos_repair_lock_unheld\n` +
    `\\unset cnyos_repair_lock_acquired\n` +
    `\\unset cnyos_repair_lock_released\n` +
    `\\unset cnyos_repair_lock_fully_released\n` +
    `\\unset cnyos_repair_evidence\n` +
    `\\unset cnyos_repair_run_nonce\n`);
}

function main() {
  const source = process.argv[2] || process.env.CLINICAL_OS_TENANT_CONFIG_PATH;
  if (!source) {
    throw new Error('Pass an explicit staging tenant config path');
  }
  const configPath = path.resolve(root, source);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  process.stdout.write(buildMigrationLedgerRepairSql({
    config,
    entries: loadMigrationEntries(root),
    sourceRevision: process.env.CLINICAL_OS_SOURCE_COMMIT || '',
    aclPhase: process.argv[3] || process.env.CNYOS_MIGRATION_LEDGER_ACL_PHASE ||
      MIGRATION_LEDGER_ACL_PHASE_STRICT
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
