# Manual SQL review artifacts

PR #36 remains pending independent security review and live manifest reconciliation.
Do not merge or execute its ACL candidates or generated ledger repair as a release
step. Their unconditional blockers must remain intact in this revision.

The public-routine observer is a separate read-only discovery program. A successful
observation does not authorize repair, migration promotion, or production use.
Use a fresh direct PostgreSQL 17 `psql -X --file=...` process only after the review
and target prerequisites in the [staging runbook](../../docs/AUTHENTICATED_STAGING_RUNBOOK.md).
Do not use SQL Editor, pooling, nested includes, or `--single-transaction`.

See the [PR #36 review checklist and artifact audit](../../docs/PR36_SECURITY_REVIEW.md)
for source scope, evidence handling, and corrected command examples. Historical
manual SQL files in this directory are not collectively authorized by this notice.
