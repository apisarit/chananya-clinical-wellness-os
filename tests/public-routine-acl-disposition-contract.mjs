import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dispositionPath = fileURLToPath(
  new URL(
    "../security/chananya-staging-public-routine-acl-disposition-831543c.json",
    import.meta.url,
  ),
);
const serialized = readFileSync(dispositionPath, "utf8");
const disposition = JSON.parse(serialized);

assert.equal(
  disposition.artifact_schema,
  "cnyos-public-routine-acl-disposition/v1",
);
assert.equal(disposition.status, "CLASSIFIED_COMPLETE_NOT_AUTHORIZED");
assert.equal(disposition.classification_complete, true);

assert.deepEqual(disposition.source, {
  observation_artifact_schema: "cnyos-public-routine-acl-observation/v2",
  source_revision: "831543c2d1ed36b2d8242cc82af23c83e019e7a7",
  observer_raw_sha256:
    "235a2c612c78367e4c2beff0243b4bc624fd6107fbdc39b1f9c0af8ae4ace27e",
  observer_source_sql_sha256:
    "46a226f7ab7f0d3ee4f6062c1bc223dcdbee351d7640f86592e3614cb261a777",
  observation_composite_sha256:
    "9a555548d810ec5bed2dc86591651ca144941687c3fd34cf8d0828708ebb9efe",
  system_identifier: "7666007964130682852",
  project_label: "chananya-staging",
  project_ref: "hsmnjwxurlmsizndjlun",
  binding_datasets: {
    trigger_bindings_all_non_internal: {
      dataset_name: "trigger_bindings.all_non_internal",
      payload_sha256:
        "2f5ffa09ed5a895733d4ba6418ae0a69ab190d3a6718bde73e17dc73118fd15d",
      row_count: 173,
      canonical_row_sha256_input:
        "exact canonical evidence row including terminal LF",
    },
    event_trigger_bindings_all: {
      dataset_name: "event_trigger_bindings.all",
      payload_sha256:
        "b0ba455cb69e75488c4c50229a387e4859c201581921c96737a313961ba6c799",
      row_count: 7,
      canonical_row_sha256_input:
        "exact canonical evidence row including terminal LF",
    },
  },
});

const expectedFlagNames = [
  "reviewer_sign_off",
  "approval",
  "execution",
  "acl_execution",
  "default_acl_execution",
  "search_path_execution",
  "migration_execution",
  "ledger_reconciliation",
  "staging_deploy",
  "production_deploy",
  "merge",
  "production_eligible",
];
assert.deepEqual(Object.keys(disposition.authorization_flags), expectedFlagNames);
for (const [flag, value] of Object.entries(disposition.authorization_flags)) {
  assert.equal(value, false, `${flag} must remain false`);
}

const expectedCategoryCounts = {
  authenticated_only: 23,
  authenticated_and_service: 47,
  service_only: 28,
  owner_only_ordinary: 25,
  owner_only_trigger: 23,
  owner_only_event_trigger: 1,
};
assert.deepEqual(
  Object.keys(disposition.routine_dispositions),
  Object.keys(expectedCategoryCounts),
);

const allSignatures = [];
for (const [category, expectedCount] of Object.entries(expectedCategoryCounts)) {
  const signatures = disposition.routine_dispositions[category];
  assert.equal(signatures.length, expectedCount, `${category} count`);
  assert.deepEqual(
    signatures,
    [...signatures].sort(),
    `${category} signatures must be sorted`,
  );
  for (const signature of signatures) {
    assert.match(
      signature,
      /^public\.[a-z0-9_]+\([^)]*\)$/,
      `${category} contains a non-canonical signature`,
    );
  }
  allSignatures.push(...signatures);
}

assert.equal(allSignatures.length, 147);
assert.equal(new Set(allSignatures).size, 147, "signatures must be unique");

const derived = {
  public: 0,
  anon: 0,
  authenticated:
    expectedCategoryCounts.authenticated_only +
    expectedCategoryCounts.authenticated_and_service,
  service_role:
    expectedCategoryCounts.service_only +
    expectedCategoryCounts.authenticated_and_service,
  owner_only:
    expectedCategoryCounts.owner_only_ordinary +
    expectedCategoryCounts.owner_only_trigger +
    expectedCategoryCounts.owner_only_event_trigger,
  total_routines: allSignatures.length,
};
assert.deepEqual(derived, {
  public: 0,
  anon: 0,
  authenticated: 70,
  service_role: 75,
  owner_only: 49,
  total_routines: 147,
});
assert.deepEqual(disposition.derived_expected_access, derived);

assert.ok(
  disposition.routine_dispositions.owner_only_ordinary.includes(
    "public.apply_initial_encounter_intake(uuid,jsonb)",
  ),
  "apply_initial_encounter_intake must remain owner-only",
);
assert.deepEqual(disposition.routine_dispositions.owner_only_event_trigger, [
  "public.rls_auto_enable()",
]);

const ascii = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const sha256Pattern = /^[0-9a-f]{64}$/;
const allowedDispositions = new Set([
  "preserve_and_harden_public_handler_owner_only",
  "preserve_platform_managed_binding",
]);

assert.equal(disposition.trigger_bindings.length, 173);
const triggerIdentityKeys = [];
const triggerRowHashes = [];
const triggerHandlerCounts = { public: 0, storage: 0, realtime: 0 };
for (const entry of disposition.trigger_bindings) {
  assert.deepEqual(Object.keys(entry), [
    "relation_schema",
    "relation_name",
    "trigger_name",
    "function_signature",
    "canonical_row_sha256",
    "disposition",
  ]);
  assert.match(entry.relation_schema, /^[a-z_][a-z0-9_]*$/);
  assert.match(entry.relation_name, /^[a-z_][a-z0-9_]*$/);
  assert.ok(entry.trigger_name.length > 0);
  assert.match(
    entry.function_signature,
    /^(?:public|storage|realtime)\.[a-z0-9_]+\([^)]*\)$/,
  );
  assert.match(entry.canonical_row_sha256, sha256Pattern);
  assert.ok(allowedDispositions.has(entry.disposition));
  assert.ok(
    ["auth", "public", "storage", "realtime"].includes(
      entry.relation_schema,
    ),
    `unexpected trigger relation schema: ${entry.relation_schema}`,
  );

  const handlerSchema = entry.function_signature.slice(
    0,
    entry.function_signature.indexOf("."),
  );
  triggerHandlerCounts[handlerSchema] += 1;
  assert.equal(
    entry.disposition,
    handlerSchema === "public"
      ? "preserve_and_harden_public_handler_owner_only"
      : "preserve_platform_managed_binding",
  );
  triggerIdentityKeys.push(
    [
      entry.relation_schema,
      entry.relation_name,
      entry.trigger_name,
      entry.function_signature,
    ].join("\u0000"),
  );
  triggerRowHashes.push(entry.canonical_row_sha256);
}
assert.deepEqual(triggerHandlerCounts, {
  public: 168,
  storage: 4,
  realtime: 1,
});
assert.equal(new Set(triggerIdentityKeys).size, 173);
assert.equal(new Set(triggerRowHashes).size, 173);
assert.deepEqual(triggerIdentityKeys, [...triggerIdentityKeys].sort(ascii));

assert.equal(disposition.event_trigger_bindings.length, 7);
const eventIdentityKeys = [];
const eventRowHashes = [];
const eventHandlerCounts = { public: 0, extensions: 0 };
for (const entry of disposition.event_trigger_bindings) {
  assert.deepEqual(Object.keys(entry), [
    "event_trigger_name",
    "event",
    "function_signature",
    "canonical_row_sha256",
    "disposition",
  ]);
  assert.match(entry.event_trigger_name, /^[a-z_][a-z0-9_]*$/);
  assert.ok(["ddl_command_end", "sql_drop"].includes(entry.event));
  assert.match(
    entry.function_signature,
    /^(?:public|extensions)\.[a-z0-9_]+\([^)]*\)$/,
  );
  assert.match(entry.canonical_row_sha256, sha256Pattern);
  assert.ok(allowedDispositions.has(entry.disposition));

  const handlerSchema = entry.function_signature.slice(
    0,
    entry.function_signature.indexOf("."),
  );
  eventHandlerCounts[handlerSchema] += 1;
  assert.equal(
    entry.disposition,
    handlerSchema === "public"
      ? "preserve_and_harden_public_handler_owner_only"
      : "preserve_platform_managed_binding",
  );
  eventIdentityKeys.push(
    [
      entry.event_trigger_name,
      entry.event,
      entry.function_signature,
    ].join("\u0000"),
  );
  eventRowHashes.push(entry.canonical_row_sha256);
}
assert.deepEqual(eventHandlerCounts, { public: 1, extensions: 6 });
assert.equal(new Set(eventIdentityKeys).size, 7);
assert.equal(new Set(eventRowHashes).size, 7);
assert.deepEqual(eventIdentityKeys, [...eventIdentityKeys].sort(ascii));

const routineEntries = Object.entries(disposition.routine_dispositions).flatMap(
  ([category, signatures]) =>
    signatures.map((signature) => [category, signature]),
);
const triggerEntries = disposition.trigger_bindings.map((entry) => [
  entry.relation_schema,
  entry.relation_name,
  entry.trigger_name,
  entry.function_signature,
  entry.canonical_row_sha256,
  entry.disposition,
]);
const eventEntries = disposition.event_trigger_bindings.map((entry) => [
  entry.event_trigger_name,
  entry.event,
  entry.function_signature,
  entry.canonical_row_sha256,
  entry.disposition,
]);
const payloadSchema =
  "cnyos-public-routine-acl-disposition-payload/v1";
const canonicalDispositionPayload =
  JSON.stringify([payloadSchema, routineEntries, triggerEntries, eventEntries]) +
  "\n";
const calculatedDispositionSha256 = createHash("sha256")
  .update(canonicalDispositionPayload, "utf8")
  .digest("hex");
assert.deepEqual(disposition.canonical_disposition_digest, {
  payload_schema: payloadSchema,
  canonical_format:
    "one compact positional JSON payload including terminal LF",
  entry_count: 327,
  payload_sha256:
    "b64789650acf4dd435d7cd41e114fac6c71b35d995cf78b2ce954ad8b571d343",
});
assert.equal(
  calculatedDispositionSha256,
  disposition.canonical_disposition_digest.payload_sha256,
);

const serializedFieldNames = new Set();
const collectFieldNames = (value) => {
  if (Array.isArray(value)) {
    value.forEach(collectFieldNames);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [field, child] of Object.entries(value)) {
    serializedFieldNames.add(field.toLowerCase());
    collectFieldNames(child);
  }
};
collectFieldNames(disposition);

for (const forbiddenField of [
  "function_definition",
  "definition",
  "canonical_payload",
  "review_rows",
  "function_oid",
  "routine_oid",
  "trigger_oid",
  "event_trigger_oid",
  "relation_oid",
  "owner_oid",
  "arguments_hex",
  "handler_semantics_and_raw_acl",
  "captured_at",
  "current_user",
  "session_user",
  "current_database",
  "password",
  "credential",
  "secret",
]) {
  assert.equal(
    serializedFieldNames.has(forbiddenField),
    false,
    `disposition must not embed ${forbiddenField}`,
  );
}
assert.doesNotMatch(
  serialized,
  /\d{4}-\d{2}-\d{2}[tT ]\d{2}:\d{2}/,
  "disposition must not embed timestamps",
);

console.log(
  "public routine ACL disposition contract passed: 147 routines, 173 triggers, 7 event triggers; authenticated=70, service_role=75, owner_only=49",
);
