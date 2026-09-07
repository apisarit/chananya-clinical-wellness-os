# PR #36 independent review and artifact handling

Status: pending independent approval and complete live-manifest reconciliation.
This checklist is not an approval, a receipt, or authorization to run live SQL.
The successful discovery observation was made from
`21c12683e8be06d7b42f3491274d6bb5104d6825` on 2026-09-08. Its independent
classification found a P0 anonymous clinical-write exposure and proved that
the two current candidates cannot reach their asserted global ACL matrix. The
observer is now being extended to include every non-internal trigger binding
and every event-trigger binding; that source change needs new exact-head CI and
reviewer assessment before another live read-only run. Follow the
[staging runbook](AUTHENTICATED_STAGING_RUNBOOK.md) for the full execution protocol.

The classified discovery summary is
[Chananya staging public-routine ACL observation — 2026-09-08](security/CHANANYA_STAGING_PUBLIC_ROUTINE_ACL_OBSERVATION_2026-09-08.md).
It is evidence of blockers, not security sign-off.

## Changes to review

| Source | Mutations behind the current unconditional refusal |
| --- | --- |
| `supabase/manual/202609060700_revoke_trigger_function_data_api_execute_candidate.sql` | Revoke all function privileges from `PUBLIC`, `anon`, `authenticated`, and `service_role` on public-schema functions bound to non-internal triggers. Set `public.set_updated_at()` search_path to `pg_catalog, public`. Review the actual function-schema predicate; it does not select arbitrary non-public functions merely because their trigger table is public. |
| `supabase/manual/202609060710_close_browser_rpc_acl_drift_candidate.sql` | Revoke `PUBLIC` and `anon` privileges on the 20 entries of `v_browser_signatures`; also revoke `service_role` on the eight entries of `v_browser_write_signatures`. Preserve the asserted authenticated/service-role matrix. No default ACL changes. |
| `scripts/generate-migration-ledger-repair-sql.mjs` | Generate an inert repair program whose blocked write path initializes/reconciles migration-ledger rows and records a durable repair receipt. This changes migration history, not application schema replay. It must not be treated as an ordinary application migration. |

The generator accepts positional tenant-config and ACL-phase arguments, not
`--manifest`. It currently **successfully generates blocked SQL**; the refusal
occurs when that SQL executes. A fabricated missing-manifest CLI test does not
test this guard. Tests remove blockers only in disposable fixture copies.

## Reviewer checklist

- [ ] Record reviewed source SHA, reviewer identity, date, scope and verdict.
  Author-account AI commentary is not an independent approving review.
- [ ] Review all three sources above: exact signatures/owners, inherited and
  effective grants, target identity, ledger invariants, unconditional blockers,
  transaction failure paths, receipt validation and post-commit proof.
- [ ] Check exact-head source contracts and native PostgreSQL 17 observer,
  candidate, verifier and repair harnesses. Confirm rollback, durable-state and
  advisory-lock assertions; do not infer them from a matching exception alone.
- [ ] After design review and exact-head CI, collect the read-only observation
  using the runbook's direct-session protocol. Independently classify every live
  routine, extension, raw/effective ACL, role edge, schema, default ACL,
  database-role setting, current-database ACL/owner, non-internal trigger
  binding and event-trigger binding. For every bound handler, review its body,
  security mode, local `search_path`, owner role context, handler-schema and
  all-schema trust state, direct language catalog/ACL, and temporary/dynamic
  path flags.
- [ ] Bind the reviewed complete manifest in a later commit; repeat independent
  review and exact-head CI. Current subset-verifier success is not authorization.
- [ ] Establish the runbook's tenant-specific prerequisites before any future
  enabled ledger recovery. Reconcile Chananya and Jitarsa independently. Do not
  invent receipt JSON: only the validated committed receipt/proof protocol counts.
- [ ] Obtain security and operations acceptance with protected evidence links.
  Promote ACL changes only in a later migration-native change; never copy a psql
  wrapper into the ordered migration chain. Production release remains separate.

## Evidence and command examples

Use a reviewed clean checkout. Retain blob IDs with `git ls-tree -r HEAD --
supabase/manual scripts/generate-migration-ledger-repair-sql.mjs
scripts/generate-migration-ledger-verification-sql.mjs .github/workflows/ci.yml`.
Store live evidence outside the repository and CI upload directories with access
limited to reviewers. Keep raw bytes, SHA-256, exit code, stderr, source SHA,
target verification and reviewer decision. A reformatted JSON hash is not the
observer's embedded canonical dataset digest; retain these separately.

The following is a Bash example for an approved observer run, not permission to
run it. Configure a reviewed direct staging endpoint, TLS verification/trusted
CA and credentials out of band (for example libpq service/passfile settings).
The reader must satisfy the runbook's catalog/RLS visibility requirements;
an arbitrary minimal account is not sufficient.

```bash
set -euo pipefail
umask 077
: "${CNYOS_EVIDENCE_DIR:?Set a secure evidence directory outside the checkout}"
mkdir -p "$CNYOS_EVIDENCE_DIR"
CNYOS_REVIEW_SHA=$(git rev-parse HEAD)
if psql -X --quiet --no-align --tuples-only \
  --set=ON_ERROR_STOP=1 --set=AUTOCOMMIT=on \
  --set=cnyos_observation_source_revision="$CNYOS_REVIEW_SHA" \
  --set=cnyos_observation_project_label=chananya-staging \
  --file=supabase/manual/public_routine_acl_inventory_read_only.sql \
  > "$CNYOS_EVIDENCE_DIR/observer.json" \
  2> "$CNYOS_EVIDENCE_DIR/observer.stderr"; then
  printf '0\n' > "$CNYOS_EVIDENCE_DIR/observer.exit-code"
else
  CNYOS_OBSERVER_EXIT=$?
  printf '%s\n' "$CNYOS_OBSERVER_EXIT" > "$CNYOS_EVIDENCE_DIR/observer.exit-code"
  exit "$CNYOS_OBSERVER_EXIT"
fi
jq -se 'length == 1 and (.[0] | .status == "CNYOS_PUBLIC_ROUTINE_INVENTORY_OBSERVED" and .authorization == false and .production_eligible == false)' \
  "$CNYOS_EVIDENCE_DIR/observer.json"
shasum -a 256 "$CNYOS_EVIDENCE_DIR/observer.json" \
  > "$CNYOS_EVIDENCE_DIR/observer.json.sha256"
```

Validate the complete record against the runbook, not just this basic JSON check.
The observer emits evidence after rollback and unlock; quiet output need not
include transaction command tags. Transaction IDs change by design during the
fresh-session probe. A txid comparison or schema-only dump cannot prove absence
of row, sequence, ACL or receipt mutation; use the disposable behavioral harness.
Never suppress a real execution failure with `|| true` or mix stderr into JSON.

For **offline generation only**, the actual verifier CLI is:

```bash
CLINICAL_OS_SOURCE_COMMIT="$(git rev-parse HEAD)" \
  node scripts/generate-migration-ledger-verification-sql.mjs \
  config/tenant.cnyos-staging.json chananya-pre-reconciliation \
  > "$CNYOS_EVIDENCE_DIR/verification-only.sql"
```

The current result is a known-subset, non-authorizing diagnostic. Live execution
of a complete-manifest verifier must wait for the later reviewed implementation
specified in the runbook. Do not set authorization GUCs to bypass a refusal.

## Artifact audit

GitHub metadata for [run 34087679381](https://github.com/apisarit/chananya-clinical-wellness-os/actions/runs/34087679381)
at the inspected SHA lists the following unexpired artifacts. Both expire on
2026-12-06 (approximately 90 days). Contents below are mapped from workflow and
generator source; archive bytes have not been independently inspected here.

| Artifact prefix | ID | Expected contents |
| --- | --- | --- |
| `migration-ledger-` | `10005792909` | Two verification SQL files, one guarded repair SQL file, the read-only observer SQL, and `SHA256SUMS`. |
| `release-contracts-` | `10005807505` | `exact-commit.json`: source/tree hashes, workflow provenance, migration/package hashes and verification command. It is not itself proof that tests passed. |

These generators use checked-in source/configuration; they do not query a live
database. The CI service uses a disposable PostgreSQL fixture. The SQL embeds
already-published identity checks and blockers, not database credentials.
Generated SQL is therefore not automatically a credential exposure or a reason
to rotate keys. An actual secret or patient-data finding requires incident handling.

CI now explicitly allowlists four source-only SQL files (three generated and one
checked-in observer copy), plus `SHA256SUMS` and
`exact-commit.json` instead of uploading their whole directories. This limits
accidental inclusion of future transcripts/observations; it is not a content
redactor. Review generator changes before adding new upload paths. Keep required
evidence uploads failing on missing files and retain the existing 90-day source
audit window; do not weaken them with `continue-on-error` or optional uploads.

GitHub allows [signed-in users with repository read access to download artifacts](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts).
This repository is public; Actions is not a restricted store for live observations,
credentials, patient data or reconciliation receipts. Put such evidence in an
approved restricted store and publish only vetted summaries/hashes. Adding a
symmetric secret to PR CI is unnecessary for the source-only bundle.

Other uploads still require an operations content review: staging/LINE/platform
workflows request 90 days; production promotion, production deploy, post-deploy
and isolated restore workflows request 365 days. GitHub's documented [public
repository maximum is 90 days](https://docs.github.com/en/organizations/managing-organization-settings/configuring-the-retention-period-for-github-actions-artifacts-and-logs-in-your-organization).
Those declarations do not establish one-year retention. Operations must approve
a durable restricted audit destination if one year is required; this PR does not
shorten the separate release audit policy or certify those archives as safe.

For an authorized archive inspection, use `gh api
repos/apisarit/chananya-clinical-wellness-os/actions/runs/34087679381/artifacts`
to list metadata and `gh run download 34087679381 --repo
apisarit/chananya-clinical-wellness-os --dir /secure/review/pr36` to download.
The CLI extracts archives into directories; a second unzip is unnecessary.
Compare artifact digests and internal checksums and record findings before approval.
