import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildPublicRoutineAclManifest,
  COMPACT_MANIFEST_SCHEMA,
  COMPLETE_CLASSIFIED_MANIFEST_STATUS,
  EXPECTED_OBSERVATION_DATASET_NAMES,
  INCOMPLETE_MANIFEST_STATUS,
  serializePublicRoutineAclManifest
} from '../scripts/generate-public-routine-acl-manifest.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generatorPath = path.join(
  root,
  'scripts/generate-public-routine-acl-manifest.mjs'
);
const POSITIONAL_ROW_SCHEMA = 'cnyos-observation-positional-digest-row/v1';
const DATASET_ROW_SCHEMA = 'cnyos-observation-dataset-digest/v1';
const DISPOSITION_PAYLOAD_SCHEMA =
  'cnyos-public-routine-acl-disposition-payload/v1';
const DISPOSITION_CANONICAL_FORMAT =
  'one compact positional JSON payload including terminal LF';
const PUBLIC_HANDLER_DISPOSITION =
  'preserve_and_harden_public_handler_owner_only';
const PLATFORM_HANDLER_DISPOSITION = 'preserve_platform_managed_binding';
const routineCategories = [
  'authenticated_only',
  'authenticated_and_service',
  'service_only',
  'owner_only_ordinary',
  'owner_only_trigger',
  'owner_only_event_trigger'
];
const bodySentinel = 'RESTRICTED_FUNCTION_BODY_SENTINEL';
const credentialSentinel = 'RESTRICTED_CREDENTIAL_SENTINEL';
const timestampSentinel = '2026-09-08T01:02:03.456789+00:00';
const sourceSql = Buffer.from(`
begin isolation level repeatable read read only;
select 'cnyos-public-routine-acl-observation/v2';
select 'CNYOS_PUBLIC_ROUTINE_INVENTORY_OBSERVED';
select 'review_datasets';
select 'composite_digest';
rollback;
select pg_catalog.pg_advisory_unlock(202608302100::bigint);
`, 'utf8');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function createDatasetFromRows(name, reviewRows, { sort = true } = {}) {
  let rows = reviewRows.map(reviewRow => {
    const fields = Object.entries(reviewRow).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0
    );
    return { reviewRow, digestRow: [POSITIONAL_ROW_SCHEMA, name, fields] };
  });
  if (sort) {
    rows = rows.sort((left, right) => Buffer.compare(
      Buffer.from(JSON.stringify(left.digestRow), 'utf8'),
      Buffer.from(JSON.stringify(right.digestRow), 'utf8')
    ));
  }
  const digestRows = rows.map(row => row.digestRow);
  const canonicalPayload = digestRows.map(row => JSON.stringify(row)).join('\n') + '\n';
  return {
    row_count: rows.length,
    digest_rows: digestRows,
    review_rows: rows.map(row => row.reviewRow),
    payload_bytes: Buffer.byteLength(canonicalPayload, 'utf8'),
    payload_sha256: sha256(Buffer.from(canonicalPayload, 'utf8')),
    canonical_payload: canonicalPayload,
    digest_row_schema: POSITIONAL_ROW_SCHEMA,
    canonical_line_format: 'one positional jsonb digest row plus LF'
  };
}

function createDataset(name) {
  return createDatasetFromRows(name, [{
    row_schema: 'cnyos-contract-sensitive-row/v1',
    dataset_name: name,
    function_definition: bodySentinel,
    credential: credentialSentinel
  }]);
}

function refreshComposite(observation) {
  const compositeRows = EXPECTED_OBSERVATION_DATASET_NAMES.map(name => {
    const dataset = observation.review_datasets[name];
    return [
      DATASET_ROW_SCHEMA,
      name,
      dataset.row_count,
      dataset.payload_bytes,
      dataset.payload_sha256
    ];
  });
  const compositePayload = compositeRows.map(row => JSON.stringify(row)).join('\n') + '\n';
  observation.composite_digest = {
    row_count: compositeRows.length,
    payload_bytes: Buffer.byteLength(compositePayload, 'utf8'),
    payload_sha256: sha256(Buffer.from(compositePayload, 'utf8')),
    canonical_payload: compositePayload,
    canonical_line_format: 'ordered dataset digest jsonb rows plus LF',
    review_rows: compositeRows
  };
}

function createObservation() {
  const reviewDatasets = {};
  for (const name of [...EXPECTED_OBSERVATION_DATASET_NAMES].reverse()) {
    reviewDatasets[name] = createDataset(name);
  }
  const observation = {
    status: 'CNYOS_PUBLIC_ROUTINE_INVENTORY_OBSERVED',
    authorization: false,
    artifact_schema: 'cnyos-public-routine-acl-observation/v2',
    observed_server: {
      captured_at: timestampSentinel,
      current_user: credentialSentinel,
      session_user: credentialSentinel,
      server_version: '17.6',
      server_encoding: 'UTF8',
      current_database: 'restricted-database-name',
      system_identifier: '7666007964130682852',
      server_version_num: '170006'
    },
    review_datasets: reviewDatasets,
    source_metadata: {
      artifact_path: 'supabase/manual/public_routine_acl_inventory_read_only.sql',
      project_label: 'contract-test',
      source_revision: '0123456789012345678901234567890123456789',
      target_authorization_claimed: false,
      operator_supplied_metadata_only: true
    },
    composite_digest: null,
    production_eligible: false,
    advisory_lock_released: true,
    public_schema_datasets: [
      'public_schema.raw_acl',
      'public_schema.effective_access'
    ],
    observation_transaction: {
      output_gucs: {
        lc_time: 'C',
        timezone: 'UTC',
        datestyle: 'ISO, YMD',
        lc_numeric: 'C',
        lc_monetary: 'C',
        bytea_output: 'hex',
        intervalstyle: 'postgres',
        client_encoding: 'UTF8',
        extra_float_digits: '3',
        quote_all_identifiers: 'off',
        standard_conforming_strings: 'on'
      },
      search_path: 'pg_catalog, pg_temp',
      catalog_lock_mode: 'ACCESS SHARE',
      catalog_lock_limit:
        'read-only transactions cannot take write-conflicting catalog locks',
      transaction_isolation: 'repeatable read',
      transaction_read_only: 'on',
      rollback_required_before_output: true,
      advisory_unlock_required_before_output: true
    },
    public_routine_sections: {
      all: [
        'public_routines.all.semantic',
        'public_routines.all.raw_acl',
        'public_routines.all.effective_access'
      ],
      extension_members: [
        'public_routines.extension_members.semantic',
        'public_routines.extension_members.raw_acl',
        'public_routines.extension_members.effective_access',
        'extensions.membership_dependencies'
      ],
      non_extension_application: [
        'public_routines.non_extension_application.semantic',
        'public_routines.non_extension_application.raw_acl',
        'public_routines.non_extension_application.effective_access'
      ]
    },
    routine_binding_datasets: [
      'trigger_bindings.all_non_internal',
      'event_trigger_bindings.all'
    ],
    runtime_role_graph_datasets: [
      'runtime_role_graph.anchors',
      'runtime_role_graph.nodes',
      'runtime_role_graph.edges',
      'runtime_role_graph.connected_routine_effective_diagnostics',
      'runtime_role_graph.connected_schema_effective_diagnostics'
    ],
    database_role_setting_dataset:
      'database_role_settings.current_database_and_global',
    function_default_acl_datasets: [
      'function_default_acl.global_and_public_schema',
      'function_default_acl.future_public_execute'
    ],
    unresolved_acl_identity_dataset: 'acl_identity.unresolved_nonzero_oids',
    current_database_security_dataset: 'current_database.security',
    persistent_schema_security_dataset: 'schemas.all_non_temporary.security',
    observation_transaction_rolled_back: true
  };
  refreshComposite(observation);
  return observation;
}

function encodeObservation(observation) {
  return Buffer.from(`${JSON.stringify(observation)}\n`, 'utf8');
}

function createClassifiableObservation() {
  const observation = createObservation();
  const semanticDatasetName = 'public_routines.all.semantic';
  observation.review_datasets[semanticDatasetName] = createDatasetFromRows(
    semanticDatasetName,
    [
      ['public.authenticated_only_probe()', true, false, false, 'void'],
      ['public.authenticated_service_probe()', true, false, false, 'void'],
      ['public.service_only_probe()', true, false, false, 'void'],
      ['public.owner_only_probe()', true, false, false, 'void'],
      ['public.trigger_probe()', false, true, false, 'trigger'],
      ['public.event_trigger_probe()', false, false, true, 'event_trigger']
    ].map(([
      signature,
      dataApiCandidate,
      returnsTrigger,
      returnsEventTrigger,
      resultType
    ]) => ({
      row_schema: 'cnyos-public-routine-semantic/v1',
      signature,
      classification: 'non_extension_application',
      data_api_candidate: dataApiCandidate,
      returns_trigger: returnsTrigger,
      returns_event_trigger: returnsEventTrigger,
      result_schema: 'pg_catalog',
      result_type: resultType
    }))
  );

  const triggerDatasetName = 'trigger_bindings.all_non_internal';
  observation.review_datasets[triggerDatasetName] = createDatasetFromRows(
    triggerDatasetName,
    [
      {
        row_schema: 'cnyos-trigger-binding/v1',
        relation_schema: 'public',
        relation_name: 'appointments',
        trigger_name: 'appointments_audit',
        function_signature: 'public.audit_appointment()'
      },
      {
        row_schema: 'cnyos-trigger-binding/v1',
        relation_schema: 'storage',
        relation_name: 'objects',
        trigger_name: 'objects_cleanup',
        function_signature: 'storage.cleanup_objects()'
      }
    ]
  );

  const eventDatasetName = 'event_trigger_bindings.all';
  observation.review_datasets[eventDatasetName] = createDatasetFromRows(
    eventDatasetName,
    [
      {
        row_schema: 'cnyos-event-trigger-binding/v1',
        event_trigger_name: 'ddl_audit',
        event: 'ddl_command_end',
        function_signature: 'public.audit_ddl()'
      },
      {
        row_schema: 'cnyos-event-trigger-binding/v1',
        event_trigger_name: 'drop_cleanup',
        event: 'sql_drop',
        function_signature: 'extensions.cleanup_dropped_extensions()'
      }
    ]
  );
  refreshComposite(observation);
  return observation;
}

function canonicalRowsWithHashes(dataset) {
  const lines = dataset.canonical_payload.slice(0, -1).split('\n');
  return dataset.review_rows.map((reviewRow, index) => ({
    reviewRow,
    canonicalRowSha256: sha256(Buffer.from(`${lines[index]}\n`, 'utf8'))
  }));
}

function refreshDispositionDigest(disposition) {
  const routineEntries = routineCategories.flatMap(category =>
    disposition.routine_dispositions[category].map(signature => [category, signature])
  );
  const triggerEntries = disposition.trigger_bindings.map(entry => [
    entry.relation_schema,
    entry.relation_name,
    entry.trigger_name,
    entry.function_signature,
    entry.canonical_row_sha256,
    entry.disposition
  ]);
  const eventTriggerEntries = disposition.event_trigger_bindings.map(entry => [
    entry.event_trigger_name,
    entry.event,
    entry.function_signature,
    entry.canonical_row_sha256,
    entry.disposition
  ]);
  const payload = `${JSON.stringify([
    DISPOSITION_PAYLOAD_SCHEMA,
    routineEntries,
    triggerEntries,
    eventTriggerEntries
  ])}\n`;
  disposition.canonical_disposition_digest = {
    payload_schema: DISPOSITION_PAYLOAD_SCHEMA,
    canonical_format: DISPOSITION_CANONICAL_FORMAT,
    entry_count:
      routineEntries.length + triggerEntries.length + eventTriggerEntries.length,
    payload_sha256: sha256(Buffer.from(payload, 'utf8'))
  };
}

function createDisposition(observation, sql = sourceSql) {
  const rawEvidence = encodeObservation(observation);
  const triggerDataset =
    observation.review_datasets['trigger_bindings.all_non_internal'];
  const eventTriggerDataset =
    observation.review_datasets['event_trigger_bindings.all'];
  const triggerBindings = canonicalRowsWithHashes(triggerDataset)
    .map(({ reviewRow, canonicalRowSha256 }) => ({
      relation_schema: reviewRow.relation_schema,
      relation_name: reviewRow.relation_name,
      trigger_name: reviewRow.trigger_name,
      function_signature: reviewRow.function_signature,
      canonical_row_sha256: canonicalRowSha256,
      disposition: reviewRow.function_signature.startsWith('public.')
        ? PUBLIC_HANDLER_DISPOSITION
        : PLATFORM_HANDLER_DISPOSITION
    }))
    .sort((left, right) => {
      const leftIdentity = [
        left.relation_schema,
        left.relation_name,
        left.trigger_name,
        left.function_signature
      ].join('\u0000');
      const rightIdentity = [
        right.relation_schema,
        right.relation_name,
        right.trigger_name,
        right.function_signature
      ].join('\u0000');
      return leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0;
    });
  const eventTriggerBindings = canonicalRowsWithHashes(eventTriggerDataset)
    .map(({ reviewRow, canonicalRowSha256 }) => ({
      event_trigger_name: reviewRow.event_trigger_name,
      event: reviewRow.event,
      function_signature: reviewRow.function_signature,
      canonical_row_sha256: canonicalRowSha256,
      disposition: reviewRow.function_signature.startsWith('public.')
        ? PUBLIC_HANDLER_DISPOSITION
        : PLATFORM_HANDLER_DISPOSITION
    }))
    .sort((left, right) => {
      const leftIdentity = [
        left.event_trigger_name,
        left.event,
        left.function_signature
      ].join('\u0000');
      const rightIdentity = [
        right.event_trigger_name,
        right.event,
        right.function_signature
      ].join('\u0000');
      return leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0;
    });

  const disposition = {
    schema_version: 1,
    artifact_schema: 'cnyos-public-routine-acl-disposition/v1',
    status: 'CLASSIFIED_COMPLETE_NOT_AUTHORIZED',
    source: {
      observation_artifact_schema: observation.artifact_schema,
      source_revision: observation.source_metadata.source_revision,
      observer_raw_sha256: sha256(rawEvidence),
      observer_source_sql_sha256: sha256(sql),
      observation_composite_sha256: observation.composite_digest.payload_sha256,
      system_identifier: observation.observed_server.system_identifier,
      project_label: observation.source_metadata.project_label,
      project_ref: 'abcdefghijklmnopqrst',
      binding_datasets: {
        trigger_bindings_all_non_internal: {
          dataset_name: 'trigger_bindings.all_non_internal',
          payload_sha256: triggerDataset.payload_sha256,
          row_count: triggerDataset.row_count,
          canonical_row_sha256_input:
            'exact canonical evidence row including terminal LF'
        },
        event_trigger_bindings_all: {
          dataset_name: 'event_trigger_bindings.all',
          payload_sha256: eventTriggerDataset.payload_sha256,
          row_count: eventTriggerDataset.row_count,
          canonical_row_sha256_input:
            'exact canonical evidence row including terminal LF'
        }
      }
    },
    classification_complete: true,
    authorization_flags: {
      reviewer_sign_off: false,
      approval: false,
      execution: false,
      acl_execution: false,
      default_acl_execution: false,
      search_path_execution: false,
      migration_execution: false,
      ledger_reconciliation: false,
      staging_deploy: false,
      production_deploy: false,
      merge: false,
      production_eligible: false
    },
    derived_expected_access: {
      public: 0,
      anon: 0,
      authenticated: 2,
      service_role: 2,
      owner_only: 3,
      total_routines: 6
    },
    routine_dispositions: {
      authenticated_only: ['public.authenticated_only_probe()'],
      authenticated_and_service: ['public.authenticated_service_probe()'],
      service_only: ['public.service_only_probe()'],
      owner_only_ordinary: ['public.owner_only_probe()'],
      owner_only_trigger: ['public.trigger_probe()'],
      owner_only_event_trigger: ['public.event_trigger_probe()']
    },
    trigger_bindings: triggerBindings,
    event_trigger_bindings: eventTriggerBindings,
    canonical_disposition_digest: null
  };
  refreshDispositionDigest(disposition);
  return disposition;
}

function encodeDisposition(disposition) {
  return Buffer.from(`${JSON.stringify(disposition, null, 2)}\n`, 'utf8');
}

function build(
  observation = createObservation(),
  sql = sourceSql,
  disposition
) {
  return buildPublicRoutineAclManifest({
    observerEvidenceBytes: encodeObservation(observation),
    observerSourceSqlBytes: sql,
    dispositionBytes: disposition === undefined
      ? undefined
      : encodeDisposition(disposition)
  });
}

function expectInvalid(mutator, pattern) {
  const observation = createObservation();
  mutator(observation);
  assert.throws(() => build(observation), pattern);
}

function expectInvalidDisposition(mutator, pattern) {
  const observation = createClassifiableObservation();
  const disposition = createDisposition(observation);
  mutator(disposition, observation);
  assert.throws(() => build(observation, sourceSql, disposition), pattern);
}

const observation = createObservation();
const rawEvidence = encodeObservation(observation);
const first = buildPublicRoutineAclManifest({
  observerEvidenceBytes: rawEvidence,
  observerSourceSqlBytes: sourceSql
});
const second = buildPublicRoutineAclManifest({
  observerEvidenceBytes: rawEvidence,
  observerSourceSqlBytes: sourceSql
});

assert.deepEqual(first, second, 'identical byte inputs must produce identical manifests');
assert.equal(first.manifest_schema, COMPACT_MANIFEST_SCHEMA);
assert.equal(first.status, INCOMPLETE_MANIFEST_STATUS);
assert.equal(first.manifest_complete, false);
assert.equal(first.classification_coverage_complete, false);
assert.equal(first.evidence_authenticity_verified, false);
assert.equal(first.target_identity_verified, false);
assert.equal(first.independent_review_complete, false);
assert.equal(first.authorization, false);
assert.equal(first.closed_world_verification_authorized, false);
assert.equal(first.acl_remediation_authorized, false);
assert.equal(first.ledger_reconciliation_authorized, false);
assert.equal(first.live_sql_authorized, false);
assert.equal(first.merge_authorized, false);
assert.equal(first.deployment_authorized, false);
assert.equal(first.production_eligible, false);
assert.equal(first.source.observer_raw_sha256, sha256(rawEvidence));
assert.equal(first.source.observer_source_sql_sha256, sha256(sourceSql));
assert.equal(first.source.source_revision, observation.source_metadata.source_revision);
assert.equal(first.source.operator_supplied_metadata_only, true);
assert.equal(first.source.target_authorization_claimed, false);
assert.equal(first.system.system_identifier, observation.observed_server.system_identifier);
assert.equal(first.observer_reported_properties.transaction_read_only, true);
assert.equal(first.observer_reported_properties.transaction_rolled_back, true);
assert.equal(first.observer_reported_properties.advisory_lock_released, true);
assert.equal(Object.isFrozen(first), true);
assert.equal(Object.isFrozen(first.source), true);
assert.equal(first.dataset_count, 25);
assert.deepEqual(Object.keys(first.datasets), EXPECTED_OBSERVATION_DATASET_NAMES);
assert.equal(first.composite_digest.payload_sha256, observation.composite_digest.payload_sha256);
assert.deepEqual(first.disposition_gate, {
  required: true,
  routine_dispositions: { required: 1, supplied: 0, complete: false },
  trigger_binding_dispositions: { required: 1, supplied: 0, complete: false },
  event_trigger_binding_dispositions: { required: 1, supplied: 0, complete: false },
  every_routine_and_binding_disposition_supplied: false
});

const serialized = serializePublicRoutineAclManifest(first);
assert.equal(serialized.endsWith('\n'), true);
assert.equal(serialized, serializePublicRoutineAclManifest(second));
for (const forbidden of [
  '"canonical_payload":',
  '"digest_rows":',
  '"review_rows":',
  '"function_definition":',
  bodySentinel,
  credentialSentinel,
  timestampSentinel,
  '"captured_at":',
  '"current_user":',
  '"session_user":',
  '"current_database":'
]) {
  assert.equal(serialized.includes(forbidden), false, `manifest leaks ${forbidden}`);
}
assert.throws(
  () => serializePublicRoutineAclManifest({ ...first }),
  /immutable result of validated evidence/
);

const classifiedObservation = createClassifiableObservation();
const disposition = createDisposition(classifiedObservation);
const dispositionBytes = encodeDisposition(disposition);
const classifiedManifest = buildPublicRoutineAclManifest({
  observerEvidenceBytes: encodeObservation(classifiedObservation),
  observerSourceSqlBytes: sourceSql,
  dispositionBytes
});
assert.equal(classifiedManifest.status, COMPLETE_CLASSIFIED_MANIFEST_STATUS);
assert.equal(classifiedManifest.manifest_complete, true);
assert.equal(classifiedManifest.classification_coverage_complete, true);
for (const flag of [
  'evidence_authenticity_verified',
  'target_identity_verified',
  'independent_review_complete',
  'authorization',
  'closed_world_verification_authorized',
  'acl_remediation_authorized',
  'ledger_reconciliation_authorized',
  'live_sql_authorized',
  'merge_authorized',
  'deployment_authorized',
  'production_eligible'
]) {
  assert.equal(classifiedManifest[flag], false, `${flag} must remain false`);
}
assert.equal(
  classifiedManifest.disposition_gate.disposition_document_sha256,
  sha256(dispositionBytes)
);
assert.deepEqual(classifiedManifest.disposition_gate.routine_dispositions, {
  required: 6,
  supplied: 6,
  complete: true,
  category_counts: {
    authenticated_only: 1,
    authenticated_and_service: 1,
    service_only: 1,
    owner_only_ordinary: 1,
    owner_only_trigger: 1,
    owner_only_event_trigger: 1
  }
});
assert.deepEqual(
  classifiedManifest.disposition_gate.trigger_binding_dispositions,
  { required: 2, supplied: 2, complete: true }
);
assert.deepEqual(
  classifiedManifest.disposition_gate.event_trigger_binding_dispositions,
  { required: 2, supplied: 2, complete: true }
);
assert.equal(
  classifiedManifest.disposition_gate.every_routine_and_binding_disposition_supplied,
  true
);
assert.deepEqual(
  classifiedManifest.disposition_gate.derived_expected_access,
  disposition.derived_expected_access
);
assert.deepEqual(
  classifiedManifest.disposition_gate.canonical_disposition_digest,
  disposition.canonical_disposition_digest
);
assert.equal(
  classifiedManifest.disposition_gate.source_binding.observer_raw_sha256,
  sha256(encodeObservation(classifiedObservation))
);
assert.equal(
  classifiedManifest.disposition_gate.source_binding.observer_source_sql_sha256,
  sha256(sourceSql)
);
assert.equal(
  classifiedManifest.disposition_gate.source_binding.observation_composite_sha256,
  classifiedObservation.composite_digest.payload_sha256
);
const classifiedSerialized = serializePublicRoutineAclManifest(classifiedManifest);
for (const forbidden of [
  'public.authenticated_only_probe()',
  'public.audit_appointment()',
  'appointments_audit',
  'ddl_audit',
  'cnyos-public-routine-semantic/v1',
  'cnyos-trigger-binding/v1',
  'cnyos-event-trigger-binding/v1',
  'canonical_row_sha256'
]) {
  assert.equal(
    classifiedSerialized.includes(forbidden),
    false,
    `classified manifest leaks disposition or evidence entry ${forbidden}`
  );
}

expectInvalidDisposition(
  value => { value.source.observer_raw_sha256 = '0'.repeat(64); },
  /raw-observer SHA-256 binding/
);
expectInvalidDisposition(
  value => { value.source.observer_source_sql_sha256 = '0'.repeat(64); },
  /source-SQL SHA-256 binding/
);
expectInvalidDisposition(
  value => { value.source.source_revision = 'f'.repeat(40); },
  /source revision binding/
);
expectInvalidDisposition(
  value => { value.source.system_identifier = '1'; },
  /system-identifier binding/
);
expectInvalidDisposition(
  value => { value.schema_version = '1'; },
  /schema version/
);
expectInvalidDisposition(
  value => { value.unexpected = false; },
  /ACL disposition document has missing or unexpected fields/
);
expectInvalidDisposition(
  value => { delete value.source.observation_composite_sha256; },
  /source has missing or unexpected fields/
);
expectInvalidDisposition(
  value => { value.source.unexpected = false; },
  /source has missing or unexpected fields/
);
expectInvalidDisposition(
  value => { value.classification_complete = false; },
  /classification-complete flag/
);
expectInvalidDisposition(
  value => { value.authorization_flags.execution = true; },
  /authorization flag execution/
);
expectInvalidDisposition(
  value => {
    value.routine_dispositions.authenticated_only = [];
    refreshDispositionDigest(value);
  },
  /routine disposition coverage/
);
expectInvalidDisposition(
  value => {
    value.routine_dispositions.authenticated_only.push('public.unknown_probe()');
    value.routine_dispositions.authenticated_only.sort();
    refreshDispositionDigest(value);
  },
  /unknown signature/
);
expectInvalidDisposition(
  value => {
    value.routine_dispositions.service_only.push('public.authenticated_only_probe()');
    value.routine_dispositions.service_only.sort();
    refreshDispositionDigest(value);
  },
  /duplicated across categories/
);
expectInvalidDisposition(
  value => {
    value.routine_dispositions.owner_only_trigger = [];
    value.routine_dispositions.owner_only_ordinary.push('public.trigger_probe()');
    value.routine_dispositions.owner_only_ordinary.sort();
    value.derived_expected_access.owner_only = 3;
    refreshDispositionDigest(value);
  },
  /owner_only_ordinary requires an ordinary Data API candidate/
);
expectInvalidDisposition(
  value => {
    value.trigger_bindings.pop();
    refreshDispositionDigest(value);
  },
  /trigger disposition count/
);
expectInvalidDisposition(
  value => {
    value.trigger_bindings.push({ ...value.trigger_bindings[0] });
    refreshDispositionDigest(value);
  },
  /trigger disposition count/
);
expectInvalidDisposition(
  value => {
    value.trigger_bindings[1] = { ...value.trigger_bindings[0] };
    refreshDispositionDigest(value);
  },
  /duplicate stable identity/
);
expectInvalidDisposition(
  value => {
    const publicBinding = value.trigger_bindings.find(entry =>
      entry.function_signature.startsWith('public.')
    );
    publicBinding.disposition = PLATFORM_HANDLER_DISPOSITION;
    refreshDispositionDigest(value);
  },
  /trigger disposition and handler-schema pairing/
);
expectInvalidDisposition(
  value => {
    value.source.binding_datasets.trigger_bindings_all_non_internal.payload_sha256 =
      '0'.repeat(64);
  },
  /trigger-binding dataset payload SHA-256/
);
expectInvalidDisposition(
  value => {
    value.event_trigger_bindings[0].canonical_row_sha256 = 'f'.repeat(64);
    refreshDispositionDigest(value);
  },
  /event-trigger disposition canonical-row SHA-256 does not match/
);
expectInvalidDisposition(
  value => {
    const firstHash = value.trigger_bindings[0].canonical_row_sha256;
    value.trigger_bindings[0].canonical_row_sha256 =
      value.trigger_bindings[1].canonical_row_sha256;
    value.trigger_bindings[1].canonical_row_sha256 = firstHash;
    refreshDispositionDigest(value);
  },
  /trigger disposition canonical-row SHA-256 does not match/
);
expectInvalidDisposition(
  value => {
    value.canonical_disposition_digest.payload_sha256 = 'a'.repeat(64);
  },
  /canonical ACL disposition SHA-256/
);

{
  const mutatedObservation = createClassifiableObservation();
  const staleDisposition = createDisposition(mutatedObservation);
  const triggerDatasetName = 'trigger_bindings.all_non_internal';
  const changedRows = mutatedObservation.review_datasets[triggerDatasetName].review_rows
    .map(row => ({ ...row }));
  changedRows[0].evidence_only_change = 'changed-without-changing-stable-identity';
  mutatedObservation.review_datasets[triggerDatasetName] = createDatasetFromRows(
    triggerDatasetName,
    changedRows
  );
  refreshComposite(mutatedObservation);
  staleDisposition.source.observer_raw_sha256 =
    sha256(encodeObservation(mutatedObservation));
  staleDisposition.source.observation_composite_sha256 =
    mutatedObservation.composite_digest.payload_sha256;
  staleDisposition.source.binding_datasets.trigger_bindings_all_non_internal.payload_sha256 =
    mutatedObservation.review_datasets[triggerDatasetName].payload_sha256;
  assert.throws(
    () => build(mutatedObservation, sourceSql, staleDisposition),
    /trigger disposition canonical-row SHA-256 does not match/
  );
}

assert.throws(
  () => buildPublicRoutineAclManifest({
    observerEvidenceBytes: encodeObservation(classifiedObservation),
    observerSourceSqlBytes: sourceSql,
    dispositionBytes: Buffer.from(
      encodeDisposition(disposition)
        .toString('utf8')
        .replace('"schema_version": 1,', '"schema_version": 1,\n  "schema_version": 1,'),
      'utf8'
    )
  }),
  /duplicate object key/
);
assert.throws(
  () => buildPublicRoutineAclManifest({
    observerEvidenceBytes: encodeObservation(classifiedObservation),
    observerSourceSqlBytes: sourceSql,
    dispositionBytes: Buffer.from(JSON.stringify(disposition), 'utf8')
  }),
  /ACL disposition document must end with one LF/
);
assert.throws(
  () => buildPublicRoutineAclManifest({
    observerEvidenceBytes: encodeObservation(classifiedObservation),
    observerSourceSqlBytes: sourceSql,
    dispositionBytes: Buffer.from(`${JSON.stringify(disposition)}\r\n`, 'utf8')
  }),
  /ACL disposition document must use LF only/
);
assert.throws(
  () => buildPublicRoutineAclManifest({
    observerEvidenceBytes: encodeObservation(classifiedObservation),
    observerSourceSqlBytes: sourceSql,
    dispositionBytes: Buffer.concat([
      encodeDisposition(disposition),
      Buffer.alloc(4 * 1024 * 1024)
    ])
  }),
  /ACL disposition document exceeds the size limit/
);

const changedSource = Buffer.concat([sourceSql, Buffer.from('-- changed\n')]);
const changedSourceManifest = build(observation, changedSource);
assert.notEqual(
  changedSourceManifest.source.observer_source_sql_sha256,
  first.source.observer_source_sql_sha256,
  'source SQL byte changes must change the source binding'
);
assert.equal(
  changedSourceManifest.source.observer_raw_sha256,
  first.source.observer_raw_sha256,
  'source SQL changes must not change the raw-evidence binding'
);

expectInvalid(value => { value.artifact_schema = 'cnyos-public-routine-acl-observation/v1'; }, /artifact schema/);
expectInvalid(value => { value.status = 'CNYOS_PUBLIC_ROUTINE_INVENTORY_APPROVED'; }, /observer status/);
expectInvalid(value => { value.authorization = true; }, /observer authorization/);
expectInvalid(value => { value.production_eligible = true; }, /production eligibility/);
expectInvalid(value => { value.observation_transaction.transaction_read_only = 'off'; }, /read-only mode/);
expectInvalid(value => { value.observation_transaction.transaction_isolation = 'read committed'; }, /transaction isolation/);
expectInvalid(value => { value.observation_transaction_rolled_back = false; }, /rollback evidence/);
expectInvalid(value => { value.advisory_lock_released = false; }, /lock release evidence/);
expectInvalid(value => { value.source_metadata.source_revision = 'not-a-commit'; }, /source revision/);
expectInvalid(value => { value.source_metadata.project_label = 'bad label'; }, /project label/);
expectInvalid(value => { value.observed_server.system_identifier = '0'; }, /system identifier/);
expectInvalid(value => { value.observed_server.server_version_num = '160009'; }, /PostgreSQL 17/);
expectInvalid(value => { value.observed_server.server_encoding = 'LATIN1'; }, /server encoding/);
expectInvalid(value => { delete value.review_datasets['event_trigger_bindings.all']; }, /review datasets/);
expectInvalid(value => { value.review_datasets.unexpected = createDataset('unexpected'); }, /review datasets/);
expectInvalid(value => {
  value.review_datasets['public_routines.all.semantic'].payload_sha256 = '0'.repeat(64);
}, /payload SHA-256/);
expectInvalid(value => {
  value.review_datasets['public_routines.all.semantic'].payload_bytes += 1;
}, /payload byte count/);
expectInvalid(value => {
  value.review_datasets['public_routines.all.semantic'].digest_rows[0][1] = 'wrong-dataset';
}, /canonical payload rows/);
expectInvalid(value => {
  const dataset = value.review_datasets['public_routines.all.semantic'];
  dataset.digest_rows[0][2].reverse();
  dataset.canonical_payload = `${JSON.stringify(dataset.digest_rows[0])}\n`;
  dataset.payload_bytes = Buffer.byteLength(dataset.canonical_payload, 'utf8');
  dataset.payload_sha256 = sha256(Buffer.from(dataset.canonical_payload, 'utf8'));
}, /field order/);
expectInvalid(value => {
  const dataset = value.review_datasets['public_routines.all.semantic'];
  dataset.canonical_payload = `${JSON.stringify(dataset.digest_rows[0])}\r\n`;
  dataset.payload_bytes = Buffer.byteLength(dataset.canonical_payload, 'utf8');
  dataset.payload_sha256 = sha256(Buffer.from(dataset.canonical_payload, 'utf8'));
}, /canonical payload must use LF only/);
const unorderedObservation = createObservation();
const unorderedDatasetName = 'public_routines.all.semantic';
unorderedObservation.review_datasets[unorderedDatasetName] = createDatasetFromRows(
  unorderedDatasetName,
  [
    {
      row_schema: 'cnyos-contract-sensitive-row/v1',
      dataset_name: unorderedDatasetName,
      function_definition: 'Z-last-row',
      credential: credentialSentinel
    },
    {
      row_schema: 'cnyos-contract-sensitive-row/v1',
      dataset_name: unorderedDatasetName,
      function_definition: 'A-first-row',
      credential: credentialSentinel
    }
  ],
  { sort: false }
);
refreshComposite(unorderedObservation);
assert.throws(() => build(unorderedObservation), /canonical row order is invalid/);
expectInvalid(value => { value.composite_digest.payload_sha256 = 'f'.repeat(64); }, /composite digest payload SHA-256/);
expectInvalid(value => { value.composite_digest.review_rows[0][2] += 1; }, /composite digest canonical rows/);
expectInvalid(value => { value.unexpected = false; }, /observer evidence has missing or unexpected fields/);

assert.throws(
  () => buildPublicRoutineAclManifest({
    observerEvidenceBytes: Buffer.from(JSON.stringify(createObservation()), 'utf8'),
    observerSourceSqlBytes: sourceSql
  }),
  /must end with one LF/
);
assert.throws(
  () => buildPublicRoutineAclManifest({
    observerEvidenceBytes: Buffer.from(`${JSON.stringify(createObservation())}\r\n`, 'utf8'),
    observerSourceSqlBytes: sourceSql
  }),
  /must use LF only/
);
assert.throws(
  () => buildPublicRoutineAclManifest({
    observerEvidenceBytes: Buffer.from('{}\n{}\n', 'utf8'),
    observerSourceSqlBytes: sourceSql
  }),
  /exactly one JSON record/
);
assert.throws(
  () => buildPublicRoutineAclManifest({
    observerEvidenceBytes: Buffer.from(
      '{"artifact_schema":"cnyos-public-routine-acl-observation/v1",' +
        '"artifact_schema":"cnyos-public-routine-acl-observation/v2"}\n',
      'utf8'
    ),
    observerSourceSqlBytes: sourceSql
  }),
  /duplicate object key/
);
assert.throws(
  () => buildPublicRoutineAclManifest({
    observerEvidenceBytes: Buffer.from(
      '{"outer":{"key":1,"\\u006bey":1}}\n',
      'utf8'
    ),
    observerSourceSqlBytes: sourceSql
  }),
  /duplicate object key/
);
assert.throws(
  () => buildPublicRoutineAclManifest({
    observerEvidenceBytes: Buffer.from(
      encodeObservation(createObservation())
        .toString('utf8')
        .replace('"row_count":1', '"row_count":9007199254740993'),
      'utf8'
    ),
    observerSourceSqlBytes: sourceSql
  }),
  /non-integral or unsafe JSON number/
);
assert.throws(
  () => buildPublicRoutineAclManifest({
    observerEvidenceBytes: rawEvidence,
    observerSourceSqlBytes: Buffer.alloc(0)
  }),
  /source SQL is empty/
);
assert.throws(
  () => buildPublicRoutineAclManifest({
    observerEvidenceBytes: rawEvidence,
    observerSourceSqlBytes: Buffer.from('select 1;\n')
  }),
  /source SQL marker is missing/
);

const temporaryDirectory = await fs.mkdtemp(
  path.join(os.tmpdir(), 'cnyos-public-routine-acl-manifest-')
);
try {
  const observerPath = path.join(temporaryDirectory, 'observer.json');
  const sourcePath = path.join(temporaryDirectory, 'observer.sql');
  const sourceSymlinkPath = path.join(temporaryDirectory, 'observer-link.sql');
  const classifiedObserverPath = path.join(temporaryDirectory, 'classified-observer.json');
  const dispositionPath = path.join(temporaryDirectory, 'disposition.json');
  const dispositionSymlinkPath = path.join(temporaryDirectory, 'disposition-link.json');
  await Promise.all([
    fs.writeFile(observerPath, rawEvidence),
    fs.writeFile(sourcePath, sourceSql),
    fs.writeFile(classifiedObserverPath, encodeObservation(classifiedObservation)),
    fs.writeFile(dispositionPath, dispositionBytes)
  ]);
  await Promise.all([
    fs.symlink(sourcePath, sourceSymlinkPath),
    fs.symlink(dispositionPath, dispositionSymlinkPath)
  ]);
  const cli = spawnSync(process.execPath, [generatorPath, observerPath, sourcePath], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stderr, '');
  assert.equal(cli.stdout, serialized);
  const symlinkCli = spawnSync(
    process.execPath,
    [generatorPath, observerPath, sourceSymlinkPath],
    { cwd: root, encoding: 'utf8' }
  );
  assert.notEqual(symlinkCli.status, 0);
  assert.match(symlinkCli.stderr, /observer source SQL must be a regular file/);

  const classifiedCli = spawnSync(
    process.execPath,
    [generatorPath, classifiedObserverPath, sourcePath, dispositionPath],
    { cwd: root, encoding: 'utf8' }
  );
  assert.equal(classifiedCli.status, 0, classifiedCli.stderr);
  assert.equal(classifiedCli.stderr, '');
  assert.equal(classifiedCli.stdout, classifiedSerialized);

  const dispositionSymlinkCli = spawnSync(
    process.execPath,
    [generatorPath, classifiedObserverPath, sourcePath, dispositionSymlinkPath],
    { cwd: root, encoding: 'utf8' }
  );
  assert.notEqual(dispositionSymlinkCli.status, 0);
  assert.match(
    dispositionSymlinkCli.stderr,
    /ACL disposition document must be a regular file/
  );

  const directoryCli = spawnSync(
    process.execPath,
    [generatorPath, classifiedObserverPath, sourcePath, temporaryDirectory],
    { cwd: root, encoding: 'utf8' }
  );
  assert.notEqual(directoryCli.status, 0);
  assert.match(directoryCli.stderr, /ACL disposition document must be a regular file/);
} finally {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
}

console.log(
  'Public-routine ACL compact-manifest contract passed: strict v2 validation, ' +
    '25 digest bindings, strict optional disposition coverage, redaction, ' +
    'deterministic output and fail-closed non-authorization gates.'
);
