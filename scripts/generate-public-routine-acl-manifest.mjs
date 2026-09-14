import { createHash } from 'node:crypto';
import { constants as fileConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual, TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';

export const OBSERVATION_SCHEMA = 'cnyos-public-routine-acl-observation/v2';
export const OBSERVATION_STATUS = 'CNYOS_PUBLIC_ROUTINE_INVENTORY_OBSERVED';
export const COMPACT_MANIFEST_SCHEMA =
  'cnyos-public-routine-acl-compact-manifest/v1';
export const INCOMPLETE_MANIFEST_STATUS =
  'CNYOS_PUBLIC_ROUTINE_ACL_MANIFEST_INCOMPLETE_NOT_AUTHORIZED';
export const COMPLETE_CLASSIFIED_MANIFEST_STATUS =
  'CNYOS_PUBLIC_ROUTINE_ACL_MANIFEST_CLASSIFIED_COMPLETE_NOT_AUTHORIZED';

const DATASET_DIGEST_ROW_SCHEMA = 'cnyos-observation-dataset-digest/v1';
const POSITIONAL_DIGEST_ROW_SCHEMA =
  'cnyos-observation-positional-digest-row/v1';
const EXPECTED_ARTIFACT_PATH =
  'supabase/manual/public_routine_acl_inventory_read_only.sql';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_REVISION_PATTERN = /^[0-9a-f]{40}$/;
const PROJECT_LABEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const MAX_OBSERVER_EVIDENCE_BYTES = 128 * 1024 * 1024;
const MAX_OBSERVER_SOURCE_SQL_BYTES = 8 * 1024 * 1024;
const MAX_DISPOSITION_BYTES = 4 * 1024 * 1024;
const JSON_NUMBER_TOKEN = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const BUILT_MANIFESTS = new WeakSet();
const DISPOSITION_SCHEMA = 'cnyos-public-routine-acl-disposition/v1';
const DISPOSITION_STATUS = 'CLASSIFIED_COMPLETE_NOT_AUTHORIZED';
const DISPOSITION_PAYLOAD_SCHEMA =
  'cnyos-public-routine-acl-disposition-payload/v1';
const DISPOSITION_CANONICAL_FORMAT =
  'one compact positional JSON payload including terminal LF';
const BINDING_ROW_SHA_INPUT =
  'exact canonical evidence row including terminal LF';
const PUBLIC_HANDLER_DISPOSITION =
  'preserve_and_harden_public_handler_owner_only';
const PLATFORM_HANDLER_DISPOSITION = 'preserve_platform_managed_binding';

const ROUTINE_DISPOSITION_CATEGORIES = Object.freeze([
  'authenticated_only',
  'authenticated_and_service',
  'service_only',
  'owner_only_ordinary',
  'owner_only_trigger',
  'owner_only_event_trigger'
]);

const DISPOSITION_AUTHORIZATION_FLAGS = Object.freeze([
  'reviewer_sign_off',
  'approval',
  'execution',
  'acl_execution',
  'default_acl_execution',
  'search_path_execution',
  'migration_execution',
  'ledger_reconciliation',
  'staging_deploy',
  'production_deploy',
  'merge',
  'production_eligible'
]);

export const EXPECTED_OBSERVATION_DATASET_NAMES = Object.freeze([
  'acl_identity.unresolved_nonzero_oids',
  'current_database.security',
  'database_role_settings.current_database_and_global',
  'event_trigger_bindings.all',
  'extensions.membership_dependencies',
  'function_default_acl.future_public_execute',
  'function_default_acl.global_and_public_schema',
  'public_routines.all.effective_access',
  'public_routines.all.raw_acl',
  'public_routines.all.semantic',
  'public_routines.extension_members.effective_access',
  'public_routines.extension_members.raw_acl',
  'public_routines.extension_members.semantic',
  'public_routines.non_extension_application.effective_access',
  'public_routines.non_extension_application.raw_acl',
  'public_routines.non_extension_application.semantic',
  'public_schema.effective_access',
  'public_schema.raw_acl',
  'runtime_role_graph.anchors',
  'runtime_role_graph.connected_routine_effective_diagnostics',
  'runtime_role_graph.connected_schema_effective_diagnostics',
  'runtime_role_graph.edges',
  'runtime_role_graph.nodes',
  'schemas.all_non_temporary.security',
  'trigger_bindings.all_non_internal'
]);

const EXPECTED_TOP_LEVEL_KEYS = Object.freeze([
  'advisory_lock_released',
  'artifact_schema',
  'authorization',
  'composite_digest',
  'current_database_security_dataset',
  'database_role_setting_dataset',
  'function_default_acl_datasets',
  'observation_transaction',
  'observation_transaction_rolled_back',
  'observed_server',
  'persistent_schema_security_dataset',
  'production_eligible',
  'public_routine_sections',
  'public_schema_datasets',
  'review_datasets',
  'routine_binding_datasets',
  'runtime_role_graph_datasets',
  'source_metadata',
  'status',
  'unresolved_acl_identity_dataset'
]);

const EXPECTED_DATASET_KEYS = Object.freeze([
  'canonical_line_format',
  'canonical_payload',
  'digest_row_schema',
  'digest_rows',
  'payload_bytes',
  'payload_sha256',
  'review_rows',
  'row_count'
]);

const EXPECTED_COMPOSITE_KEYS = Object.freeze([
  'canonical_line_format',
  'canonical_payload',
  'payload_bytes',
  'payload_sha256',
  'review_rows',
  'row_count'
]);

const EXPECTED_SOURCE_METADATA_KEYS = Object.freeze([
  'artifact_path',
  'operator_supplied_metadata_only',
  'project_label',
  'source_revision',
  'target_authorization_claimed'
]);

const EXPECTED_SERVER_KEYS = Object.freeze([
  'captured_at',
  'current_database',
  'current_user',
  'server_encoding',
  'server_version',
  'server_version_num',
  'session_user',
  'system_identifier'
]);

const EXPECTED_TRANSACTION_KEYS = Object.freeze([
  'advisory_unlock_required_before_output',
  'catalog_lock_limit',
  'catalog_lock_mode',
  'output_gucs',
  'rollback_required_before_output',
  'search_path',
  'transaction_isolation',
  'transaction_read_only'
]);

const EXPECTED_OUTPUT_GUCS = Object.freeze({
  bytea_output: 'hex',
  client_encoding: 'UTF8',
  datestyle: 'ISO, YMD',
  extra_float_digits: '3',
  intervalstyle: 'postgres',
  lc_monetary: 'C',
  lc_numeric: 'C',
  lc_time: 'C',
  quote_all_identifiers: 'off',
  standard_conforming_strings: 'on',
  timezone: 'UTC'
});

const EXPECTED_PUBLIC_ROUTINE_SECTIONS = Object.freeze({
  all: Object.freeze([
    'public_routines.all.semantic',
    'public_routines.all.raw_acl',
    'public_routines.all.effective_access'
  ]),
  extension_members: Object.freeze([
    'public_routines.extension_members.semantic',
    'public_routines.extension_members.raw_acl',
    'public_routines.extension_members.effective_access',
    'extensions.membership_dependencies'
  ]),
  non_extension_application: Object.freeze([
    'public_routines.non_extension_application.semantic',
    'public_routines.non_extension_application.raw_acl',
    'public_routines.non_extension_application.effective_access'
  ])
});

const EXPECTED_PUBLIC_SCHEMA_DATASETS = Object.freeze([
  'public_schema.raw_acl',
  'public_schema.effective_access'
]);

const EXPECTED_RUNTIME_ROLE_GRAPH_DATASETS = Object.freeze([
  'runtime_role_graph.anchors',
  'runtime_role_graph.nodes',
  'runtime_role_graph.edges',
  'runtime_role_graph.connected_routine_effective_diagnostics',
  'runtime_role_graph.connected_schema_effective_diagnostics'
]);

const EXPECTED_FUNCTION_DEFAULT_ACL_DATASETS = Object.freeze([
  'function_default_acl.global_and_public_schema',
  'function_default_acl.future_public_execute'
]);

const EXPECTED_ROUTINE_BINDING_DATASETS = Object.freeze([
  'trigger_bindings.all_non_internal',
  'event_trigger_bindings.all'
]);

const REQUIRED_SOURCE_SQL_MARKERS = Object.freeze([
  'begin isolation level repeatable read read only;',
  "'cnyos-public-routine-acl-observation/v2'",
  "'CNYOS_PUBLIC_ROUTINE_INVENTORY_OBSERVED'",
  "'review_datasets'",
  "'composite_digest'",
  'rollback;',
  'pg_catalog.pg_advisory_unlock(202608302100::bigint)'
]);

const EXPECTED_DISPOSITION_KEYS = Object.freeze([
  'schema_version',
  'artifact_schema',
  'status',
  'source',
  'classification_complete',
  'authorization_flags',
  'derived_expected_access',
  'routine_dispositions',
  'trigger_bindings',
  'event_trigger_bindings',
  'canonical_disposition_digest'
]);

const EXPECTED_DISPOSITION_SOURCE_KEYS = Object.freeze([
  'observation_artifact_schema',
  'source_revision',
  'observer_raw_sha256',
  'observer_source_sql_sha256',
  'observation_composite_sha256',
  'system_identifier',
  'project_label',
  'project_ref',
  'binding_datasets'
]);

const EXPECTED_BINDING_DATASET_KEYS = Object.freeze([
  'dataset_name',
  'payload_sha256',
  'row_count',
  'canonical_row_sha256_input'
]);

const EXPECTED_DERIVED_ACCESS_KEYS = Object.freeze([
  'public',
  'anon',
  'authenticated',
  'service_role',
  'owner_only',
  'total_routines'
]);

const EXPECTED_TRIGGER_DISPOSITION_KEYS = Object.freeze([
  'relation_schema',
  'relation_name',
  'trigger_name',
  'function_signature',
  'canonical_row_sha256',
  'disposition'
]);

const EXPECTED_EVENT_TRIGGER_DISPOSITION_KEYS = Object.freeze([
  'event_trigger_name',
  'event',
  'function_signature',
  'canonical_row_sha256',
  'disposition'
]);

const EXPECTED_CANONICAL_DISPOSITION_DIGEST_KEYS = Object.freeze([
  'payload_schema',
  'canonical_format',
  'entry_count',
  'payload_sha256'
]);

function invalid(label) {
  throw new Error(`CNYOS public-routine ACL evidence is invalid: ${label}`);
}

function requireCondition(condition, label) {
  if (!condition) invalid(label);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertExactKeys(value, expectedKeys, label) {
  requireCondition(isPlainObject(value), `${label} must be an object`);
  const actualKeys = Object.keys(value).sort(compareAscii);
  const sortedExpectedKeys = [...expectedKeys].sort(compareAscii);
  requireCondition(
    isDeepStrictEqual(actualKeys, sortedExpectedKeys),
    `${label} has missing or unexpected fields`
  );
}

function assertExactKeyOrder(value, expectedKeys, label) {
  assertExactKeys(value, expectedKeys, label);
  requireCondition(
    isDeepStrictEqual(Object.keys(value), [...expectedKeys]),
    `${label} fields are out of order`
  );
}

function assertExactValue(actual, expected, label) {
  requireCondition(isDeepStrictEqual(actual, expected), `${label} does not match`);
}

function assertNonemptyString(value, label) {
  requireCondition(typeof value === 'string' && value.length > 0, `${label} is invalid`);
  requireCondition(!/[\u0000-\u001f\u007f]/u.test(value), `${label} is invalid`);
}

function assertBoundedString(value, label, maximumLength = 512) {
  assertNonemptyString(value, label);
  requireCondition(value.length <= maximumLength, `${label} is too long`);
}

function assertSafeInteger(value, label) {
  requireCondition(
    Number.isSafeInteger(value) && value >= 0,
    `${label} must be a non-negative safe integer`
  );
}

function assertSha256(value, label) {
  requireCondition(typeof value === 'string' && SHA256_PATTERN.test(value), `${label} is invalid`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizeBytes(value, label, maximumBytes) {
  requireCondition(
    Buffer.isBuffer(value) || value instanceof Uint8Array,
    `${label} must be bytes`
  );
  const bytes = Buffer.from(value);
  requireCondition(bytes.length <= maximumBytes, `${label} exceeds the size limit`);
  return bytes;
}

function decodeUtf8(bytes, label) {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    invalid(`${label} is not valid UTF-8`);
  }
}

function assertNoDuplicateObjectKeys(jsonText, label) {
  let cursor = 0;

  function failJson() {
    invalid(`${label} is malformed JSON`);
  }

  function skipWhitespace() {
    while (
      cursor < jsonText.length &&
      (jsonText[cursor] === ' ' ||
        jsonText[cursor] === '\n' ||
        jsonText[cursor] === '\r' ||
        jsonText[cursor] === '\t')
    ) {
      cursor += 1;
    }
  }

  function scanString(decode) {
    if (jsonText[cursor] !== '"') failJson();
    const start = cursor;
    cursor += 1;
    while (cursor < jsonText.length) {
      const character = jsonText[cursor];
      if (character === '"') {
        cursor += 1;
        if (!decode) return undefined;
        try {
          return JSON.parse(jsonText.slice(start, cursor));
        } catch {
          failJson();
        }
      }
      if (character === '\\') {
        cursor += 1;
        if (cursor >= jsonText.length) failJson();
        if (jsonText[cursor] === 'u') {
          const escape = jsonText.slice(cursor + 1, cursor + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(escape)) failJson();
          cursor += 5;
        } else {
          if (!/["\\/bfnrt]/.test(jsonText[cursor])) failJson();
          cursor += 1;
        }
        continue;
      }
      if (character.charCodeAt(0) <= 0x1f) failJson();
      cursor += 1;
    }
    failJson();
  }

  function scanNumber() {
    JSON_NUMBER_TOKEN.lastIndex = cursor;
    const match = JSON_NUMBER_TOKEN.exec(jsonText);
    if (!match) failJson();
    const token = match[0];
    requireCondition(
      !/[.eE]/.test(token) && Number.isSafeInteger(Number(token)),
      `${label} contains a non-integral or unsafe JSON number`
    );
    cursor = JSON_NUMBER_TOKEN.lastIndex;
  }

  function scanValue(depth) {
    if (depth > 128) invalid(`${label} exceeds the maximum JSON nesting depth`);
    skipWhitespace();
    const character = jsonText[cursor];
    if (character === '{') {
      cursor += 1;
      skipWhitespace();
      if (jsonText[cursor] === '}') {
        cursor += 1;
        return;
      }
      const keys = new Set();
      while (cursor < jsonText.length) {
        skipWhitespace();
        const key = scanString(true);
        if (keys.has(key)) invalid(`${label} contains a duplicate object key`);
        keys.add(key);
        skipWhitespace();
        if (jsonText[cursor] !== ':') failJson();
        cursor += 1;
        scanValue(depth + 1);
        skipWhitespace();
        if (jsonText[cursor] === '}') {
          cursor += 1;
          return;
        }
        if (jsonText[cursor] !== ',') failJson();
        cursor += 1;
      }
      failJson();
    }
    if (character === '[') {
      cursor += 1;
      skipWhitespace();
      if (jsonText[cursor] === ']') {
        cursor += 1;
        return;
      }
      while (cursor < jsonText.length) {
        scanValue(depth + 1);
        skipWhitespace();
        if (jsonText[cursor] === ']') {
          cursor += 1;
          return;
        }
        if (jsonText[cursor] !== ',') failJson();
        cursor += 1;
      }
      failJson();
    }
    if (character === '"') {
      scanString(false);
      return;
    }
    if (character === '-' || (character >= '0' && character <= '9')) {
      scanNumber();
      return;
    }
    for (const literal of ['true', 'false', 'null']) {
      if (jsonText.startsWith(literal, cursor)) {
        cursor += literal.length;
        return;
      }
    }
    failJson();
  }

  try {
    scanValue(0);
    skipWhitespace();
    if (cursor !== jsonText.length) failJson();
  } catch (error) {
    if (error instanceof RangeError) {
      invalid(`${label} exceeds the maximum JSON nesting depth`);
    }
    throw error;
  }
}

function parseSingleRecord(rawEvidenceBytes) {
  const rawEvidence = normalizeBytes(
    rawEvidenceBytes,
    'raw observer evidence',
    MAX_OBSERVER_EVIDENCE_BYTES
  );
  requireCondition(rawEvidence.length > 1, 'raw observer evidence is empty');
  const text = decodeUtf8(rawEvidence, 'raw observer evidence');
  requireCondition(!text.startsWith('\uFEFF'), 'raw observer evidence has a byte-order mark');
  requireCondition(!text.includes('\r'), 'raw observer evidence must use LF only');
  requireCondition(text.endsWith('\n'), 'raw observer evidence must end with one LF');
  requireCondition(
    text.indexOf('\n') === text.length - 1,
    'raw observer evidence must contain exactly one JSON record'
  );
  const jsonText = text.slice(0, -1);
  requireCondition(
    jsonText.startsWith('{') && jsonText.endsWith('}'),
    'raw observer evidence must be one JSON object'
  );
  assertNoDuplicateObjectKeys(jsonText, 'raw observer evidence');
  try {
    return { observation: JSON.parse(jsonText), rawEvidence };
  } catch {
    invalid('raw observer evidence is malformed JSON');
  }
}

function parseDispositionDocument(dispositionBytes) {
  const rawDisposition = normalizeBytes(
    dispositionBytes,
    'ACL disposition document',
    MAX_DISPOSITION_BYTES
  );
  requireCondition(rawDisposition.length > 1, 'ACL disposition document is empty');
  const text = decodeUtf8(rawDisposition, 'ACL disposition document');
  requireCondition(!text.startsWith('\uFEFF'), 'ACL disposition document has a byte-order mark');
  requireCondition(!text.includes('\r'), 'ACL disposition document must use LF only');
  requireCondition(text.endsWith('\n'), 'ACL disposition document must end with one LF');
  const jsonText = text.slice(0, -1);
  requireCondition(
    jsonText.startsWith('{') && jsonText.endsWith('}'),
    'ACL disposition document must contain one JSON object with no trailing whitespace'
  );
  assertNoDuplicateObjectKeys(jsonText, 'ACL disposition document');
  try {
    return { disposition: JSON.parse(jsonText), rawDisposition };
  } catch {
    invalid('ACL disposition document is malformed JSON');
  }
}

function validateSourceSql(sourceSqlBytes) {
  const sourceSql = normalizeBytes(
    sourceSqlBytes,
    'observer source SQL',
    MAX_OBSERVER_SOURCE_SQL_BYTES
  );
  requireCondition(sourceSql.length > 0, 'observer source SQL is empty');
  const sourceText = decodeUtf8(sourceSql, 'observer source SQL');
  requireCondition(!sourceText.includes('\u0000'), 'observer source SQL contains a NUL byte');
  for (const marker of REQUIRED_SOURCE_SQL_MARKERS) {
    requireCondition(sourceText.includes(marker), 'observer source SQL marker is missing');
  }
  return sourceSql;
}

function validateSourceMetadata(sourceMetadata) {
  assertExactKeys(sourceMetadata, EXPECTED_SOURCE_METADATA_KEYS, 'source metadata');
  assertExactValue(sourceMetadata.artifact_path, EXPECTED_ARTIFACT_PATH, 'source artifact path');
  requireCondition(
    typeof sourceMetadata.source_revision === 'string' &&
      SOURCE_REVISION_PATTERN.test(sourceMetadata.source_revision),
    'source revision is invalid'
  );
  requireCondition(
    typeof sourceMetadata.project_label === 'string' &&
      PROJECT_LABEL_PATTERN.test(sourceMetadata.project_label),
    'source project label is invalid'
  );
  assertExactValue(
    sourceMetadata.operator_supplied_metadata_only,
    true,
    'operator-supplied metadata flag'
  );
  assertExactValue(
    sourceMetadata.target_authorization_claimed,
    false,
    'target authorization claim'
  );
}

function validateObservedServer(observedServer) {
  assertExactKeys(observedServer, EXPECTED_SERVER_KEYS, 'observed server');
  assertNonemptyString(observedServer.current_database, 'observed current database');
  assertNonemptyString(observedServer.session_user, 'observed session user');
  assertNonemptyString(observedServer.current_user, 'observed current user');
  assertExactValue(observedServer.server_encoding, 'UTF8', 'server encoding');
  requireCondition(
    typeof observedServer.server_version_num === 'string' &&
      /^17[0-9]{4}$/.test(observedServer.server_version_num),
    'server version number must identify PostgreSQL 17'
  );
  requireCondition(
    typeof observedServer.server_version === 'string' &&
      /^17(?:\.|$)/.test(observedServer.server_version),
    'server version must identify PostgreSQL 17'
  );
  requireCondition(
    typeof observedServer.system_identifier === 'string' &&
      /^[1-9][0-9]{0,19}$/.test(observedServer.system_identifier),
    'system identifier is invalid'
  );
  try {
    const systemIdentifier = BigInt(observedServer.system_identifier);
    requireCondition(
      systemIdentifier <= 18446744073709551615n,
      'system identifier is outside the unsigned 64-bit range'
    );
  } catch {
    invalid('system identifier is invalid');
  }
  requireCondition(
    typeof observedServer.captured_at === 'string' &&
      /^\d{4}-\d{2}-\d{2}T/.test(observedServer.captured_at) &&
      Number.isFinite(Date.parse(observedServer.captured_at)),
    'capture timestamp is invalid'
  );
}

function validateObservationTransaction(transaction) {
  assertExactKeys(transaction, EXPECTED_TRANSACTION_KEYS, 'observation transaction');
  assertExactValue(
    transaction.transaction_isolation,
    'repeatable read',
    'observation transaction isolation'
  );
  assertExactValue(transaction.transaction_read_only, 'on', 'observation read-only mode');
  assertExactValue(transaction.search_path, 'pg_catalog, pg_temp', 'observation search path');
  assertExactValue(transaction.catalog_lock_mode, 'ACCESS SHARE', 'catalog lock mode');
  assertExactValue(
    transaction.catalog_lock_limit,
    'read-only transactions cannot take write-conflicting catalog locks',
    'catalog lock limit'
  );
  assertExactValue(
    transaction.rollback_required_before_output,
    true,
    'rollback-before-output requirement'
  );
  assertExactValue(
    transaction.advisory_unlock_required_before_output,
    true,
    'unlock-before-output requirement'
  );
  assertExactKeys(
    transaction.output_gucs,
    Object.keys(EXPECTED_OUTPUT_GUCS),
    'observation output GUCs'
  );
  assertExactValue(transaction.output_gucs, EXPECTED_OUTPUT_GUCS, 'observation output GUCs');
}

function validateDataset(datasetName, dataset) {
  assertExactKeys(dataset, EXPECTED_DATASET_KEYS, `dataset ${datasetName}`);
  assertSafeInteger(dataset.row_count, `dataset ${datasetName} row count`);
  assertSafeInteger(dataset.payload_bytes, `dataset ${datasetName} payload bytes`);
  assertSha256(dataset.payload_sha256, `dataset ${datasetName} payload SHA-256`);
  assertExactValue(
    dataset.digest_row_schema,
    POSITIONAL_DIGEST_ROW_SCHEMA,
    `dataset ${datasetName} digest-row schema`
  );
  assertExactValue(
    dataset.canonical_line_format,
    'one positional jsonb digest row plus LF',
    `dataset ${datasetName} canonical-line format`
  );
  requireCondition(
    typeof dataset.canonical_payload === 'string',
    `dataset ${datasetName} canonical payload must be a string`
  );
  requireCondition(
    !dataset.canonical_payload.includes('\r'),
    `dataset ${datasetName} canonical payload must use LF only`
  );
  requireCondition(Array.isArray(dataset.digest_rows), `dataset ${datasetName} digest rows missing`);
  requireCondition(Array.isArray(dataset.review_rows), `dataset ${datasetName} review rows missing`);
  assertExactValue(
    Buffer.byteLength(dataset.canonical_payload, 'utf8'),
    dataset.payload_bytes,
    `dataset ${datasetName} payload byte count`
  );
  assertExactValue(
    sha256(Buffer.from(dataset.canonical_payload, 'utf8')),
    dataset.payload_sha256,
    `dataset ${datasetName} payload SHA-256`
  );
  requireCondition(
    dataset.digest_rows.length === dataset.row_count &&
      dataset.review_rows.length === dataset.row_count,
    `dataset ${datasetName} row count does not match its rows`
  );

  let parsedDigestRows = [];
  if (dataset.row_count === 0) {
    assertExactValue(dataset.canonical_payload, '', `dataset ${datasetName} empty payload`);
  } else {
    requireCondition(
      dataset.canonical_payload.endsWith('\n'),
      `dataset ${datasetName} canonical payload must end with LF`
    );
    const lines = dataset.canonical_payload.slice(0, -1).split('\n');
    requireCondition(
      lines.length === dataset.row_count,
      `dataset ${datasetName} canonical line count does not match`
    );
    for (let index = 1; index < lines.length; index += 1) {
      requireCondition(
        Buffer.compare(
          Buffer.from(lines[index - 1], 'utf8'),
          Buffer.from(lines[index], 'utf8')
        ) <= 0,
        `dataset ${datasetName} canonical row order is invalid`
      );
    }
    try {
      parsedDigestRows = lines.map(line => {
        assertNoDuplicateObjectKeys(line, `dataset ${datasetName} canonical row`);
        return JSON.parse(line);
      });
    } catch {
      invalid(`dataset ${datasetName} canonical payload has malformed JSON rows`);
    }
  }
  assertExactValue(
    parsedDigestRows,
    dataset.digest_rows,
    `dataset ${datasetName} canonical payload rows`
  );

  for (let index = 0; index < dataset.row_count; index += 1) {
    const digestRow = dataset.digest_rows[index];
    requireCondition(
      Array.isArray(digestRow) && digestRow.length === 3,
      `dataset ${datasetName} digest row ${index} has invalid shape`
    );
    assertExactValue(
      digestRow[0],
      POSITIONAL_DIGEST_ROW_SCHEMA,
      `dataset ${datasetName} digest row ${index} schema`
    );
    assertExactValue(
      digestRow[1],
      datasetName,
      `dataset ${datasetName} digest row ${index} name`
    );
    requireCondition(
      Array.isArray(digestRow[2]),
      `dataset ${datasetName} digest row ${index} fields are invalid`
    );
    const fieldNames = [];
    for (const field of digestRow[2]) {
      requireCondition(
        Array.isArray(field) && field.length === 2 && typeof field[0] === 'string',
        `dataset ${datasetName} digest row ${index} field is invalid`
      );
      fieldNames.push(field[0]);
    }
    requireCondition(
      new Set(fieldNames).size === fieldNames.length,
      `dataset ${datasetName} digest row ${index} repeats a field`
    );
    assertExactValue(
      fieldNames,
      [...fieldNames].sort(compareAscii),
      `dataset ${datasetName} digest row ${index} field order`
    );
    requireCondition(
      isPlainObject(dataset.review_rows[index]),
      `dataset ${datasetName} review row ${index} must be an object`
    );
    assertExactValue(
      Object.fromEntries(digestRow[2]),
      dataset.review_rows[index],
      `dataset ${datasetName} review row ${index}`
    );
  }

  return {
    row_count: dataset.row_count,
    payload_bytes: dataset.payload_bytes,
    payload_sha256: dataset.payload_sha256
  };
}

function validateDatasetTopology(observation) {
  assertExactValue(
    observation.public_routine_sections,
    EXPECTED_PUBLIC_ROUTINE_SECTIONS,
    'public-routine dataset sections'
  );
  assertExactValue(
    observation.public_schema_datasets,
    EXPECTED_PUBLIC_SCHEMA_DATASETS,
    'public-schema datasets'
  );
  assertExactValue(
    observation.runtime_role_graph_datasets,
    EXPECTED_RUNTIME_ROLE_GRAPH_DATASETS,
    'runtime-role graph datasets'
  );
  assertExactValue(
    observation.database_role_setting_dataset,
    'database_role_settings.current_database_and_global',
    'database-role setting dataset'
  );
  assertExactValue(
    observation.current_database_security_dataset,
    'current_database.security',
    'current-database security dataset'
  );
  assertExactValue(
    observation.persistent_schema_security_dataset,
    'schemas.all_non_temporary.security',
    'persistent-schema security dataset'
  );
  assertExactValue(
    observation.function_default_acl_datasets,
    EXPECTED_FUNCTION_DEFAULT_ACL_DATASETS,
    'function default-ACL datasets'
  );
  assertExactValue(
    observation.routine_binding_datasets,
    EXPECTED_ROUTINE_BINDING_DATASETS,
    'routine-binding datasets'
  );
  assertExactValue(
    observation.unresolved_acl_identity_dataset,
    'acl_identity.unresolved_nonzero_oids',
    'unresolved ACL-identity dataset'
  );
}

function validateCompositeDigest(composite, compactDatasets) {
  assertExactKeys(composite, EXPECTED_COMPOSITE_KEYS, 'composite digest');
  assertSafeInteger(composite.row_count, 'composite digest row count');
  assertSafeInteger(composite.payload_bytes, 'composite digest payload bytes');
  assertSha256(composite.payload_sha256, 'composite digest payload SHA-256');
  assertExactValue(
    composite.canonical_line_format,
    'ordered dataset digest jsonb rows plus LF',
    'composite digest canonical-line format'
  );
  requireCondition(
    typeof composite.canonical_payload === 'string' &&
      composite.canonical_payload.endsWith('\n'),
    'composite digest canonical payload must end with LF'
  );
  requireCondition(
    !composite.canonical_payload.includes('\r'),
    'composite digest canonical payload must use LF only'
  );
  requireCondition(Array.isArray(composite.review_rows), 'composite digest review rows missing');
  assertExactValue(
    composite.row_count,
    EXPECTED_OBSERVATION_DATASET_NAMES.length,
    'composite digest row count'
  );
  assertExactValue(
    composite.review_rows.length,
    composite.row_count,
    'composite digest review-row count'
  );
  assertExactValue(
    Buffer.byteLength(composite.canonical_payload, 'utf8'),
    composite.payload_bytes,
    'composite digest payload byte count'
  );
  assertExactValue(
    sha256(Buffer.from(composite.canonical_payload, 'utf8')),
    composite.payload_sha256,
    'composite digest payload SHA-256'
  );

  let parsedRows;
  try {
    parsedRows = composite.canonical_payload.slice(0, -1)
      .split('\n')
      .map(line => {
        assertNoDuplicateObjectKeys(line, 'composite digest canonical row');
        return JSON.parse(line);
      });
  } catch {
    invalid('composite digest canonical payload has malformed JSON rows');
  }
  assertExactValue(parsedRows, composite.review_rows, 'composite digest canonical rows');

  const expectedRows = EXPECTED_OBSERVATION_DATASET_NAMES.map(datasetName => {
    const dataset = compactDatasets[datasetName];
    return [
      DATASET_DIGEST_ROW_SCHEMA,
      datasetName,
      dataset.row_count,
      dataset.payload_bytes,
      dataset.payload_sha256
    ];
  });
  assertExactValue(composite.review_rows, expectedRows, 'composite digest dataset bindings');

  return {
    row_count: composite.row_count,
    payload_bytes: composite.payload_bytes,
    payload_sha256: composite.payload_sha256
  };
}

function canonicalEvidenceRows(dataset) {
  const canonicalLines = dataset.canonical_payload === ''
    ? []
    : dataset.canonical_payload.slice(0, -1).split('\n');
  return dataset.review_rows.map((reviewRow, index) => ({
    reviewRow,
    canonicalRowSha256: sha256(Buffer.from(`${canonicalLines[index]}\n`, 'utf8'))
  }));
}

function assertSortedUniqueStrings(values, label) {
  requireCondition(Array.isArray(values), `${label} must be an array`);
  for (const value of values) assertBoundedString(value, `${label} entry`, 1024);
  requireCondition(new Set(values).size === values.length, `${label} contains duplicates`);
  assertExactValue(values, [...values].sort(compareAscii), `${label} ordering`);
}

function validateDispositionAuthorizationFlags(flags) {
  assertExactKeys(flags, DISPOSITION_AUTHORIZATION_FLAGS, 'disposition authorization flags');
  for (const flag of DISPOSITION_AUTHORIZATION_FLAGS) {
    assertExactValue(flags[flag], false, `disposition authorization flag ${flag}`);
  }
}

function validateDispositionBindingDataset({
  binding,
  label,
  expectedDatasetName,
  observedDataset
}) {
  assertExactKeys(binding, EXPECTED_BINDING_DATASET_KEYS, label);
  assertExactValue(binding.dataset_name, expectedDatasetName, `${label} name`);
  assertExactValue(
    binding.payload_sha256,
    observedDataset.payload_sha256,
    `${label} payload SHA-256`
  );
  assertExactValue(binding.row_count, observedDataset.row_count, `${label} row count`);
  assertExactValue(
    binding.canonical_row_sha256_input,
    BINDING_ROW_SHA_INPUT,
    `${label} canonical-row hash input`
  );
}

function validateRoutineCategoryPairing(category, semanticRow) {
  assertExactValue(
    semanticRow.classification,
    'non_extension_application',
    `routine ${category} semantic classification`
  );
  requireCondition(
    typeof semanticRow.data_api_candidate === 'boolean' &&
      typeof semanticRow.returns_trigger === 'boolean' &&
      typeof semanticRow.returns_event_trigger === 'boolean',
    `routine ${category} semantic flags are invalid`
  );

  if (category === 'owner_only_trigger') {
    requireCondition(
      semanticRow.data_api_candidate === false &&
        semanticRow.returns_trigger === true &&
        semanticRow.returns_event_trigger === false &&
        semanticRow.result_schema === 'pg_catalog' &&
        semanticRow.result_type === 'trigger',
      'owner-only trigger disposition does not identify a trigger routine'
    );
    return;
  }
  if (category === 'owner_only_event_trigger') {
    requireCondition(
      semanticRow.data_api_candidate === false &&
        semanticRow.returns_trigger === false &&
        semanticRow.returns_event_trigger === true &&
        semanticRow.result_schema === 'pg_catalog' &&
        semanticRow.result_type === 'event_trigger',
      'owner-only event-trigger disposition does not identify an event-trigger routine'
    );
    return;
  }
  requireCondition(
    semanticRow.data_api_candidate === true &&
      semanticRow.returns_trigger === false &&
      semanticRow.returns_event_trigger === false,
    `routine disposition category ${category} requires an ordinary Data API candidate`
  );
}

function validateRoutineDispositions(routineDispositions, semanticDataset) {
  assertExactKeyOrder(
    routineDispositions,
    ROUTINE_DISPOSITION_CATEGORIES,
    'routine dispositions'
  );

  const semanticRows = new Map();
  for (const row of semanticDataset.review_rows) {
    requireCondition(isPlainObject(row), 'routine semantic evidence row must be an object');
    assertBoundedString(row.signature, 'routine semantic signature', 1024);
    requireCondition(
      /^public\.[a-z0-9_]+\([^\u0000-\u001f)]*\)$/.test(row.signature),
      'routine semantic signature is not canonical'
    );
    requireCondition(!semanticRows.has(row.signature), 'routine semantic signatures are not unique');
    semanticRows.set(row.signature, row);
  }
  assertExactValue(
    semanticRows.size,
    semanticDataset.row_count,
    'routine semantic signature count'
  );

  const suppliedSignatures = new Set();
  const categoryCounts = {};
  const routineEntries = [];
  for (const category of ROUTINE_DISPOSITION_CATEGORIES) {
    const signatures = routineDispositions[category];
    assertSortedUniqueStrings(signatures, `routine disposition category ${category}`);
    categoryCounts[category] = signatures.length;
    for (const signature of signatures) {
      requireCondition(
        semanticRows.has(signature),
        `routine disposition category ${category} contains an unknown signature`
      );
      requireCondition(
        !suppliedSignatures.has(signature),
        'routine disposition signatures are duplicated across categories'
      );
      suppliedSignatures.add(signature);
      validateRoutineCategoryPairing(category, semanticRows.get(signature));
      routineEntries.push([category, signature]);
    }
  }
  assertExactValue(
    suppliedSignatures.size,
    semanticRows.size,
    'routine disposition coverage'
  );

  const derivedExpectedAccess = {
    public: 0,
    anon: 0,
    authenticated:
      categoryCounts.authenticated_only +
      categoryCounts.authenticated_and_service,
    service_role:
      categoryCounts.service_only +
      categoryCounts.authenticated_and_service,
    owner_only:
      categoryCounts.owner_only_ordinary +
      categoryCounts.owner_only_trigger +
      categoryCounts.owner_only_event_trigger,
    total_routines: suppliedSignatures.size
  };
  return { categoryCounts, derivedExpectedAccess, routineEntries };
}

function assertSimpleIdentifier(value, label, { lowercase = false } = {}) {
  assertBoundedString(value, label, 128);
  const pattern = lowercase
    ? /^[a-z_][a-z0-9_]*$/
    : /^[A-Za-z_][A-Za-z0-9_]*$/;
  requireCondition(pattern.test(value), `${label} is not a bounded identifier`);
}

function handlerSchema(functionSignature, allowedSchemas, label) {
  assertBoundedString(functionSignature, label, 1024);
  const schema = functionSignature.slice(0, functionSignature.indexOf('.'));
  requireCondition(
    allowedSchemas.includes(schema) &&
      new RegExp(`^(?:${allowedSchemas.join('|')})\\.[a-z0-9_]+\\([^\\u0000-\\u001f)]*\\)$`)
        .test(functionSignature),
    `${label} is outside the allowed handler schemas`
  );
  return schema;
}

function triggerIdentity(value) {
  return [
    value.relation_schema,
    value.relation_name,
    value.trigger_name,
    value.function_signature
  ].join('\u0000');
}

function eventTriggerIdentity(value) {
  return [
    value.event_trigger_name,
    value.event,
    value.function_signature
  ].join('\u0000');
}

function expectedBindingDisposition(schema) {
  return schema === 'public'
    ? PUBLIC_HANDLER_DISPOSITION
    : PLATFORM_HANDLER_DISPOSITION;
}

function validateTriggerDispositions(entries, triggerDataset) {
  requireCondition(Array.isArray(entries), 'trigger dispositions must be an array');
  assertExactValue(entries.length, triggerDataset.row_count, 'trigger disposition count');

  const evidenceByIdentity = new Map();
  const evidenceRowHashes = new Set();
  for (const { reviewRow, canonicalRowSha256 } of canonicalEvidenceRows(triggerDataset)) {
    requireCondition(isPlainObject(reviewRow), 'trigger evidence row must be an object');
    assertSimpleIdentifier(reviewRow.relation_schema, 'trigger evidence relation schema', {
      lowercase: true
    });
    assertSimpleIdentifier(reviewRow.relation_name, 'trigger evidence relation name', {
      lowercase: true
    });
    assertBoundedString(reviewRow.trigger_name, 'trigger evidence name', 128);
    handlerSchema(
      reviewRow.function_signature,
      ['public', 'storage', 'realtime'],
      'trigger evidence function signature'
    );
    const identity = triggerIdentity(reviewRow);
    requireCondition(!evidenceByIdentity.has(identity), 'trigger evidence identities are not unique');
    requireCondition(
      !evidenceRowHashes.has(canonicalRowSha256),
      'trigger evidence canonical-row hashes are not unique'
    );
    evidenceByIdentity.set(identity, { canonicalRowSha256, reviewRow });
    evidenceRowHashes.add(canonicalRowSha256);
  }

  const suppliedIdentities = [];
  const suppliedIdentitySet = new Set();
  const suppliedHashes = new Set();
  const digestEntries = [];
  for (const entry of entries) {
    assertExactKeyOrder(entry, EXPECTED_TRIGGER_DISPOSITION_KEYS, 'trigger disposition entry');
    assertSimpleIdentifier(entry.relation_schema, 'trigger disposition relation schema', {
      lowercase: true
    });
    requireCondition(
      ['auth', 'public', 'storage', 'realtime'].includes(entry.relation_schema),
      'trigger disposition relation schema is outside the v1 boundary'
    );
    assertSimpleIdentifier(entry.relation_name, 'trigger disposition relation name', {
      lowercase: true
    });
    assertBoundedString(entry.trigger_name, 'trigger disposition name', 128);
    const schema = handlerSchema(
      entry.function_signature,
      ['public', 'storage', 'realtime'],
      'trigger disposition function signature'
    );
    assertSha256(entry.canonical_row_sha256, 'trigger disposition canonical-row SHA-256');
    assertExactValue(
      entry.disposition,
      expectedBindingDisposition(schema),
      'trigger disposition and handler-schema pairing'
    );
    const identity = triggerIdentity(entry);
    requireCondition(
      evidenceByIdentity.has(identity),
      'trigger disposition contains an unknown stable identity'
    );
    const evidence = evidenceByIdentity.get(identity);
    assertExactValue(
      entry.canonical_row_sha256,
      evidence.canonicalRowSha256,
      'trigger disposition canonical-row SHA-256'
    );
    requireCondition(
      !suppliedIdentitySet.has(identity),
      'trigger dispositions contain a duplicate stable identity'
    );
    requireCondition(
      !suppliedHashes.has(entry.canonical_row_sha256),
      'trigger dispositions contain a duplicate canonical-row SHA-256'
    );
    suppliedIdentities.push(identity);
    suppliedIdentitySet.add(identity);
    suppliedHashes.add(entry.canonical_row_sha256);
    digestEntries.push([
      entry.relation_schema,
      entry.relation_name,
      entry.trigger_name,
      entry.function_signature,
      entry.canonical_row_sha256,
      entry.disposition
    ]);
  }
  assertExactValue(
    suppliedIdentities,
    [...suppliedIdentities].sort(compareAscii),
    'trigger disposition stable-identity ordering'
  );
  assertExactValue(
    suppliedIdentities.length,
    evidenceByIdentity.size,
    'trigger disposition coverage'
  );
  return digestEntries;
}

function validateEventTriggerDispositions(entries, eventTriggerDataset) {
  requireCondition(Array.isArray(entries), 'event-trigger dispositions must be an array');
  assertExactValue(
    entries.length,
    eventTriggerDataset.row_count,
    'event-trigger disposition count'
  );

  const evidenceByIdentity = new Map();
  const evidenceRowHashes = new Set();
  for (const { reviewRow, canonicalRowSha256 } of canonicalEvidenceRows(eventTriggerDataset)) {
    requireCondition(isPlainObject(reviewRow), 'event-trigger evidence row must be an object');
    assertSimpleIdentifier(reviewRow.event_trigger_name, 'event-trigger evidence name', {
      lowercase: true
    });
    requireCondition(
      ['ddl_command_end', 'sql_drop'].includes(reviewRow.event),
      'event-trigger evidence event is outside the v1 boundary'
    );
    handlerSchema(
      reviewRow.function_signature,
      ['public', 'extensions'],
      'event-trigger evidence function signature'
    );
    const identity = eventTriggerIdentity(reviewRow);
    requireCondition(
      !evidenceByIdentity.has(identity),
      'event-trigger evidence identities are not unique'
    );
    requireCondition(
      !evidenceRowHashes.has(canonicalRowSha256),
      'event-trigger evidence canonical-row hashes are not unique'
    );
    evidenceByIdentity.set(identity, { canonicalRowSha256, reviewRow });
    evidenceRowHashes.add(canonicalRowSha256);
  }

  const suppliedIdentities = [];
  const suppliedIdentitySet = new Set();
  const suppliedHashes = new Set();
  const digestEntries = [];
  for (const entry of entries) {
    assertExactKeyOrder(
      entry,
      EXPECTED_EVENT_TRIGGER_DISPOSITION_KEYS,
      'event-trigger disposition entry'
    );
    assertSimpleIdentifier(entry.event_trigger_name, 'event-trigger disposition name', {
      lowercase: true
    });
    requireCondition(
      ['ddl_command_end', 'sql_drop'].includes(entry.event),
      'event-trigger disposition event is outside the v1 boundary'
    );
    const schema = handlerSchema(
      entry.function_signature,
      ['public', 'extensions'],
      'event-trigger disposition function signature'
    );
    assertSha256(
      entry.canonical_row_sha256,
      'event-trigger disposition canonical-row SHA-256'
    );
    assertExactValue(
      entry.disposition,
      expectedBindingDisposition(schema),
      'event-trigger disposition and handler-schema pairing'
    );
    const identity = eventTriggerIdentity(entry);
    requireCondition(
      evidenceByIdentity.has(identity),
      'event-trigger disposition contains an unknown stable identity'
    );
    const evidence = evidenceByIdentity.get(identity);
    assertExactValue(
      entry.canonical_row_sha256,
      evidence.canonicalRowSha256,
      'event-trigger disposition canonical-row SHA-256'
    );
    requireCondition(
      !suppliedIdentitySet.has(identity),
      'event-trigger dispositions contain a duplicate stable identity'
    );
    requireCondition(
      !suppliedHashes.has(entry.canonical_row_sha256),
      'event-trigger dispositions contain a duplicate canonical-row SHA-256'
    );
    suppliedIdentities.push(identity);
    suppliedIdentitySet.add(identity);
    suppliedHashes.add(entry.canonical_row_sha256);
    digestEntries.push([
      entry.event_trigger_name,
      entry.event,
      entry.function_signature,
      entry.canonical_row_sha256,
      entry.disposition
    ]);
  }
  assertExactValue(
    suppliedIdentities,
    [...suppliedIdentities].sort(compareAscii),
    'event-trigger disposition stable-identity ordering'
  );
  assertExactValue(
    suppliedIdentities.length,
    evidenceByIdentity.size,
    'event-trigger disposition coverage'
  );
  return digestEntries;
}

function validateDispositionDocument({
  dispositionBytes,
  observation,
  observerRawSha256,
  observerSourceSqlSha256
}) {
  const { disposition, rawDisposition } = parseDispositionDocument(dispositionBytes);
  assertExactKeys(disposition, EXPECTED_DISPOSITION_KEYS, 'ACL disposition document');
  assertExactValue(disposition.schema_version, 1, 'ACL disposition schema version');
  assertExactValue(disposition.artifact_schema, DISPOSITION_SCHEMA, 'ACL disposition schema');
  assertExactValue(disposition.status, DISPOSITION_STATUS, 'ACL disposition status');
  assertExactValue(
    disposition.classification_complete,
    true,
    'ACL disposition classification-complete flag'
  );
  validateDispositionAuthorizationFlags(disposition.authorization_flags);

  const source = disposition.source;
  assertExactKeys(source, EXPECTED_DISPOSITION_SOURCE_KEYS, 'ACL disposition source');
  assertExactValue(
    source.observation_artifact_schema,
    observation.artifact_schema,
    'ACL disposition observation schema binding'
  );
  assertExactValue(
    source.source_revision,
    observation.source_metadata.source_revision,
    'ACL disposition source revision binding'
  );
  assertExactValue(
    source.observer_raw_sha256,
    observerRawSha256,
    'ACL disposition raw-observer SHA-256 binding'
  );
  assertExactValue(
    source.observer_source_sql_sha256,
    observerSourceSqlSha256,
    'ACL disposition source-SQL SHA-256 binding'
  );
  assertExactValue(
    source.observation_composite_sha256,
    observation.composite_digest.payload_sha256,
    'ACL disposition composite SHA-256 binding'
  );
  assertExactValue(
    source.system_identifier,
    observation.observed_server.system_identifier,
    'ACL disposition system-identifier binding'
  );
  assertExactValue(
    source.project_label,
    observation.source_metadata.project_label,
    'ACL disposition project-label binding'
  );
  requireCondition(
    typeof source.project_ref === 'string' && /^[a-z0-9]{20}$/.test(source.project_ref),
    'ACL disposition project reference is invalid'
  );
  assertExactKeys(
    source.binding_datasets,
    ['trigger_bindings_all_non_internal', 'event_trigger_bindings_all'],
    'ACL disposition binding datasets'
  );
  validateDispositionBindingDataset({
    binding: source.binding_datasets.trigger_bindings_all_non_internal,
    label: 'ACL disposition trigger-binding dataset',
    expectedDatasetName: 'trigger_bindings.all_non_internal',
    observedDataset: observation.review_datasets['trigger_bindings.all_non_internal']
  });
  validateDispositionBindingDataset({
    binding: source.binding_datasets.event_trigger_bindings_all,
    label: 'ACL disposition event-trigger dataset',
    expectedDatasetName: 'event_trigger_bindings.all',
    observedDataset: observation.review_datasets['event_trigger_bindings.all']
  });

  const routine = validateRoutineDispositions(
    disposition.routine_dispositions,
    observation.review_datasets['public_routines.all.semantic']
  );
  assertExactKeys(
    disposition.derived_expected_access,
    EXPECTED_DERIVED_ACCESS_KEYS,
    'ACL disposition derived expected access'
  );
  for (const key of EXPECTED_DERIVED_ACCESS_KEYS) {
    assertSafeInteger(
      disposition.derived_expected_access[key],
      `ACL disposition derived expected access ${key}`
    );
  }
  assertExactValue(
    disposition.derived_expected_access,
    routine.derivedExpectedAccess,
    'ACL disposition derived expected access'
  );

  const triggerEntries = validateTriggerDispositions(
    disposition.trigger_bindings,
    observation.review_datasets['trigger_bindings.all_non_internal']
  );
  const eventTriggerEntries = validateEventTriggerDispositions(
    disposition.event_trigger_bindings,
    observation.review_datasets['event_trigger_bindings.all']
  );
  const canonicalPayload = `${JSON.stringify([
    DISPOSITION_PAYLOAD_SCHEMA,
    routine.routineEntries,
    triggerEntries,
    eventTriggerEntries
  ])}\n`;
  const entryCount =
    routine.routineEntries.length + triggerEntries.length + eventTriggerEntries.length;
  assertExactKeys(
    disposition.canonical_disposition_digest,
    EXPECTED_CANONICAL_DISPOSITION_DIGEST_KEYS,
    'canonical ACL disposition digest'
  );
  assertExactValue(
    disposition.canonical_disposition_digest.payload_schema,
    DISPOSITION_PAYLOAD_SCHEMA,
    'canonical ACL disposition payload schema'
  );
  assertExactValue(
    disposition.canonical_disposition_digest.canonical_format,
    DISPOSITION_CANONICAL_FORMAT,
    'canonical ACL disposition format'
  );
  assertExactValue(
    disposition.canonical_disposition_digest.entry_count,
    entryCount,
    'canonical ACL disposition entry count'
  );
  assertExactValue(
    disposition.canonical_disposition_digest.payload_sha256,
    sha256(Buffer.from(canonicalPayload, 'utf8')),
    'canonical ACL disposition SHA-256'
  );

  return {
    disposition_document_sha256: sha256(rawDisposition),
    source_binding: {
      artifact_schema: disposition.artifact_schema,
      source_revision: source.source_revision,
      observer_raw_sha256: source.observer_raw_sha256,
      observer_source_sql_sha256: source.observer_source_sql_sha256,
      observation_composite_sha256: source.observation_composite_sha256,
      system_identifier: source.system_identifier,
      project_label: source.project_label,
      project_ref: source.project_ref,
      trigger_binding_dataset_sha256:
        source.binding_datasets.trigger_bindings_all_non_internal.payload_sha256,
      event_trigger_binding_dataset_sha256:
        source.binding_datasets.event_trigger_bindings_all.payload_sha256
    },
    category_counts: routine.categoryCounts,
    derived_expected_access: routine.derivedExpectedAccess,
    routine_count: routine.routineEntries.length,
    trigger_binding_count: triggerEntries.length,
    event_trigger_binding_count: eventTriggerEntries.length,
    canonical_disposition_digest: {
      payload_schema: DISPOSITION_PAYLOAD_SCHEMA,
      canonical_format: DISPOSITION_CANONICAL_FORMAT,
      entry_count: entryCount,
      payload_sha256: disposition.canonical_disposition_digest.payload_sha256
    }
  };
}

export function buildPublicRoutineAclManifest({
  observerEvidenceBytes,
  observerSourceSqlBytes,
  dispositionBytes
}) {
  const { observation, rawEvidence } = parseSingleRecord(observerEvidenceBytes);
  const sourceSql = validateSourceSql(observerSourceSqlBytes);

  assertExactKeys(observation, EXPECTED_TOP_LEVEL_KEYS, 'observer evidence');
  assertExactValue(observation.artifact_schema, OBSERVATION_SCHEMA, 'observer artifact schema');
  assertExactValue(observation.status, OBSERVATION_STATUS, 'observer status');
  assertExactValue(observation.authorization, false, 'observer authorization');
  assertExactValue(observation.production_eligible, false, 'observer production eligibility');
  assertExactValue(
    observation.observation_transaction_rolled_back,
    true,
    'observer rollback evidence'
  );
  assertExactValue(
    observation.advisory_lock_released,
    true,
    'observer advisory-lock release evidence'
  );
  validateSourceMetadata(observation.source_metadata);
  validateObservedServer(observation.observed_server);
  validateObservationTransaction(observation.observation_transaction);
  validateDatasetTopology(observation);

  assertExactKeys(
    observation.review_datasets,
    EXPECTED_OBSERVATION_DATASET_NAMES,
    'review datasets'
  );
  const datasets = {};
  for (const datasetName of EXPECTED_OBSERVATION_DATASET_NAMES) {
    datasets[datasetName] = validateDataset(
      datasetName,
      observation.review_datasets[datasetName]
    );
  }
  const compositeDigest = validateCompositeDigest(observation.composite_digest, datasets);
  const observerRawSha256 = sha256(rawEvidence);
  const observerSourceSqlSha256 = sha256(sourceSql);
  const validatedDisposition = dispositionBytes === undefined
    ? undefined
    : validateDispositionDocument({
        dispositionBytes,
        observation,
        observerRawSha256,
        observerSourceSqlSha256
      });

  const routineDispositionCount =
    datasets['public_routines.all.semantic'].row_count;
  const triggerBindingDispositionCount =
    datasets['trigger_bindings.all_non_internal'].row_count;
  const eventTriggerBindingDispositionCount =
    datasets['event_trigger_bindings.all'].row_count;
  const classificationCoverageComplete = validatedDisposition !== undefined;

  const dispositionGate = validatedDisposition === undefined
    ? {
        required: true,
        routine_dispositions: {
          required: routineDispositionCount,
          supplied: 0,
          complete: false
        },
        trigger_binding_dispositions: {
          required: triggerBindingDispositionCount,
          supplied: 0,
          complete: false
        },
        event_trigger_binding_dispositions: {
          required: eventTriggerBindingDispositionCount,
          supplied: 0,
          complete: false
        },
        every_routine_and_binding_disposition_supplied: false
      }
    : {
        required: true,
        disposition_document_sha256:
          validatedDisposition.disposition_document_sha256,
        source_binding: validatedDisposition.source_binding,
        routine_dispositions: {
          required: routineDispositionCount,
          supplied: validatedDisposition.routine_count,
          complete: true,
          category_counts: validatedDisposition.category_counts
        },
        trigger_binding_dispositions: {
          required: triggerBindingDispositionCount,
          supplied: validatedDisposition.trigger_binding_count,
          complete: true
        },
        event_trigger_binding_dispositions: {
          required: eventTriggerBindingDispositionCount,
          supplied: validatedDisposition.event_trigger_binding_count,
          complete: true
        },
        derived_expected_access: validatedDisposition.derived_expected_access,
        canonical_disposition_digest:
          validatedDisposition.canonical_disposition_digest,
        every_routine_and_binding_disposition_supplied: true
      };

  const manifest = {
    manifest_schema: COMPACT_MANIFEST_SCHEMA,
    status: classificationCoverageComplete
      ? COMPLETE_CLASSIFIED_MANIFEST_STATUS
      : INCOMPLETE_MANIFEST_STATUS,
    manifest_complete: classificationCoverageComplete,
    classification_coverage_complete: classificationCoverageComplete,
    evidence_authenticity_verified: false,
    target_identity_verified: false,
    independent_review_complete: false,
    authorization: false,
    closed_world_verification_authorized: false,
    acl_remediation_authorized: false,
    ledger_reconciliation_authorized: false,
    live_sql_authorized: false,
    merge_authorized: false,
    deployment_authorized: false,
    production_eligible: false,
    source: {
      observer_artifact_schema: observation.artifact_schema,
      observer_status: observation.status,
      observer_raw_sha256: observerRawSha256,
      observer_source_sql_sha256: observerSourceSqlSha256,
      source_revision: observation.source_metadata.source_revision,
      project_label: observation.source_metadata.project_label,
      artifact_path: observation.source_metadata.artifact_path,
      operator_supplied_metadata_only:
        observation.source_metadata.operator_supplied_metadata_only,
      target_authorization_claimed:
        observation.source_metadata.target_authorization_claimed
    },
    system: {
      system_identifier: observation.observed_server.system_identifier,
      server_version: observation.observed_server.server_version,
      server_version_num: observation.observed_server.server_version_num,
      server_encoding: observation.observed_server.server_encoding
    },
    observer_reported_properties: {
      transaction_isolation: observation.observation_transaction.transaction_isolation,
      transaction_read_only: true,
      transaction_rolled_back: observation.observation_transaction_rolled_back,
      advisory_lock_released: observation.advisory_lock_released
    },
    dataset_count: EXPECTED_OBSERVATION_DATASET_NAMES.length,
    datasets,
    composite_digest: compositeDigest,
    disposition_gate: dispositionGate
  };
  deepFreeze(manifest);
  BUILT_MANIFESTS.add(manifest);
  return manifest;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function serializePublicRoutineAclManifest(manifest) {
  requireCondition(
    isPlainObject(manifest) && BUILT_MANIFESTS.has(manifest) && Object.isFrozen(manifest),
    'compact manifest must be the immutable result of validated evidence'
  );
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function readBoundedRegularFile(filePath, label, maximumBytes) {
  requireCondition(
    Number.isInteger(fileConstants.O_NOFOLLOW) &&
      fileConstants.O_NOFOLLOW > 0 &&
      Number.isInteger(fileConstants.O_NONBLOCK) &&
      fileConstants.O_NONBLOCK > 0,
    `${label} cannot be opened with safe file-type controls`
  );
  let handle;
  try {
    handle = await fs.open(
      filePath,
      fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW | fileConstants.O_NONBLOCK
    );
  } catch {
    invalid(`${label} must be a regular file`);
  }
  try {
    const metadata = await handle.stat();
    requireCondition(metadata.isFile(), `${label} must be a regular file`);
    requireCondition(metadata.size <= maximumBytes, `${label} exceeds the size limit`);
    const bytes = Buffer.alloc(metadata.size + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const result = await handle.read(
        bytes,
        bytesRead,
        bytes.length - bytesRead,
        null
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    requireCondition(bytesRead <= metadata.size, `${label} changed while it was read`);
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function main() {
  const [, , observerPath, sourceSqlPath, dispositionPath, ...extraArguments] = process.argv;
  if (!observerPath || !sourceSqlPath || extraArguments.length > 0) {
    throw new Error(
      'Usage: node scripts/generate-public-routine-acl-manifest.mjs ' +
        '<observer-v2.json> <observer-source.sql> [disposition-v1.json]'
    );
  }
  const [observerEvidenceBytes, observerSourceSqlBytes, dispositionBytes] = await Promise.all([
    readBoundedRegularFile(
      observerPath,
      'raw observer evidence',
      MAX_OBSERVER_EVIDENCE_BYTES
    ),
    readBoundedRegularFile(
      sourceSqlPath,
      'observer source SQL',
      MAX_OBSERVER_SOURCE_SQL_BYTES
    ),
    dispositionPath === undefined
      ? Promise.resolve(undefined)
      : readBoundedRegularFile(
          dispositionPath,
          'ACL disposition document',
          MAX_DISPOSITION_BYTES
        )
  ]);
  const manifest = buildPublicRoutineAclManifest({
    observerEvidenceBytes,
    observerSourceSqlBytes,
    dispositionBytes
  });
  process.stdout.write(serializePublicRoutineAclManifest(manifest));
}

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
