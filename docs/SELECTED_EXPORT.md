# Selected export (separate from backup)

This is a controlled export primitive, not the database backup path. The
transactional source remains Supabase PostgreSQL. The export contract accepts
an explicit allowlisted dataset and at most 100 selected IDs, and produces
CSV or JSON with fixed columns. Arbitrary table names, columns, destinations,
credentials and raw LINE payloads are not accepted.

The current implementation is intentionally local/pure and does not upload to
Google Drive or NAS. In the Operations patient registry, `admin` and
`super_admin` can select up to 100 visible patients and download CSV or JSON.
The rows were already returned through the logged-in Supabase client and are
projected to the fixed allowlist before the browser creates a download; no new
database read or external request is made by the export action. Google Drive
backup remains encrypted `.cdb.json.enc` output; the NAS field remains
configuration-only until a separately reviewed connector is implemented.

Before creating either file, the controller requires a known current clinic,
exactly one loaded row for each selected ID, and an exact clinic match on every
selected row. Missing rows, missing clinic IDs, foreign-clinic rows and duplicate
IDs reject the whole download; no partial file or first-match selection is used.
This guards ambiguous or stale browser data. It is NOT a replacement for server
authorization/RLS, a fresh permission check, or a durable export-audit receipt.

Run the contract test with:

```bash
node tests/selected-export-contract.mjs
```

An isolated browser regression is available as `node tests/selected-export-browser.mjs`
(set `CNYOS_TEST_BROWSER_PATH` when using an installed Chrome). It uses actual
registry HTML/controller and synthetic rows, blocks outbound requests, and reads
the downloaded CSV/JSON files to verify selection, allowlisted fields, encoding
and refusal of partial selections. It does not verify hosted authentication or
spreadsheet import behavior.
It also injects missing/foreign clinic and duplicate-row cases and verifies that
they produce a user-visible refusal without another download.

## Guarded server-preparation proposal (2026-09-27)

`supabase/manual/selected_patient_export_audit_candidate.sql` adds a private,
ungranted technical proposal, not an activated migration or replacement for the
current browser action. Its unconditional review exception prevents installation.
It seeds no export permissions and grants no runtime schema, table or function
access. Owner/Super Admin status alone does not authorize this proposed boundary.

In a disposable test installation, explicitly permitted active clinic members
request 1–100 distinct patient IDs and CSV/JSON format. The routine derives actor
and clinic, checks the existing subscription boundary, reads the fixed patient
projection from the database and rejects the entire selection if any ID is
unavailable in that clinic. The response contains rows and a server-generated
preparation receipt. A failed audit insert aborts the response transaction.
Each new preparation receives a new receipt, even for the same selection.

The private metadata history contains actor, clinic, selected IDs, format, policy
reference and time, but no copied patient body, credentials or clinical text.
Selected IDs are still sensitive metadata. Permission changes retain old/new
state and database-session provenance; absent authenticated actor remains null,
not a fabricated approver. These are technical events, not approval decisions.
The event means **server prepared data**, not browser received/saved it or a
recipient received it. Direct database transactions can still roll back; an API
activation must prove commit-before-success and handle lost responses honestly.

`tests/selected-export-audit-candidate.mjs` executes the full migration fixture
and test-only candidate installation. It covers source refusal/no grants,
explicit permission and revocation, current values, fixed columns, bounds,
duplicates/null/multidimensional arrays, both tenant directions, inactive
membership, subscription OFF/ON, immutable history, and injected audit-storage
failure rolling back permission changes/refusing preparation. This is PGlite
evidence, not native concurrent authorization testing or hosted API acceptance.

Native follow-up: `npm run check:selected-export-native` passed against local
PostgreSQL 17 image
`sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24`.
The disposable container has no network, published ports or host mounts and is
removed in `finally`. The test observes actual lock waits through independent
connections for both orderings of permission revocation, membership disable and
subscription OFF versus preparation. Revoke-first denies with no result rows or
preparation event. Preparation-first holds revocation until its transaction ends;
a fresh observer then matches the committed receipt, and later requests fail.
An explicit rollback removes the preparation event even when SQL already returned
a result inside that transaction. The test also demonstrates that direct patient
SELECT still succeeds without creating these events: universal access auditing
is explicitly not achieved. This completes these local race checks, not hosted
Data API commit/delivery, production backup coverage or release authorization.

`npm run check:selected-export-restore` also passed a native `pg_dump` /
`pg_restore` round trip into a separate database in the isolated container.
Before dumping, the harness revokes the synthetic permission and removes its
temporary execution/schema grants. It compares all three private tables,
effective runtime ACL/RLS, routine definitions/owners, constraints and immutable
trigger bindings after restore. The restored revoked permission still denies
preparation even after target-only test execution grants; attempts to rewrite
history fail. A test-only explicit regrant then appends a new permission event
and preparation event while the original source snapshot stays unchanged.

This proves recovery of the state captured in that synthetic dump. It does not
reconcile revocations issued **after** a backup, bootstrap roles into a fresh
cluster, encrypt/upload/retrieve a Drive or NAS backup, verify managed PITR or
establish RPO/RTO. An opt-in application-domain contract `2026-09-27.3` now
includes the three private export tables; the default backup version is unchanged.
Its SQL candidate `selected_export_backup_candidate.sql` remains unconditionally
blocked pending review. Local tests cover tenant-filtered SQL exports, encrypted
round trips, 17 content hashes, missing-table rejection and cross-tenant/corrupt
history rejection. Worker tests use mocked Drive/RPC adapters, not provider uploads.
Permission history carries typed clinic/subject identifiers for safe filtering.
The native restore harness now installs these guarded candidates only in its
disposable database, exports/encrypts all four domains, and reconciles all 17
content hashes against the database restored from `pg_dump`. A deliberately
changed audit payload with unchanged row counts is rejected, then rolled back.
This is encrypted-set reconciliation with a native dump restore, not restoration
by importing JSON, provider retrieval or reconciliation of post-backup revocations.
Those operational requirements remain open. The test emits the synthetic dump and candidate SHA-256
values without persisting patient bodies in its output.

Before activation: accountable purpose/permission/retention/audit-reader policy,
independent SECURITY DEFINER review, hosted authorization/commit behavior, approved
backup/restore coverage, exact migration packaging, API/UI wiring and session
failure/read-back tests remain necessary. Existing direct reads/downloads have
not been revoked, and this proposal does not establish universal read auditing
or complete DSAR coverage. No live data or production access was changed.

The database-function boundary follows the explicit privilege/search-path
considerations in [Supabase's function documentation](https://supabase.com/docs/guides/database/functions).

## CSV boundary and limitations

Both exporters prefix potentially formula-like cells with an apostrophe, including
leading tab/CR/LF, whitespace-prefixed formula markers and full-width markers.
CSV delimiter/quote/newline escaping remains separate. Tests execute both actual
implementations and require identical output; JSON projections preserve original
values. This is output encoding, not a change to clinical or identity records.

Do not describe this as universal spreadsheet protection: spreadsheet imports
and subsequent save/reopen can alter escaping. For lossless machine transfer use
JSON, and never enable formulas/macros from untrusted exports. See the
[OWASP CSV injection limitations](https://community.owasp.org/attacks/CSV_Injection).
These patient/encounter row exports are not a complete DSAR package: prescriptions,
financial history, consent and other patient-linked records require separately
defined authorized coverage and completeness evidence.
