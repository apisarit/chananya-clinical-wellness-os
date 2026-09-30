# Recover a blocked production release

`PRODUCTION_RELEASE_ATTESTATION_JSON_REQUIRED` means the process running the gate did not receive the approval record. A local failure does not establish whether the GitHub production environment contains that secret. Source-controlled pending gate statuses also do not establish that live reviews failed: the source policy intentionally stays fail closed.

## Prepare the exact candidate

After this release-alignment change is merged, a successful **push-to-default-branch**
`Release candidate contracts` run produces `release-handoff-<full-SHA>-<run-id>`.
Use that artifact's `release-context.json` as the single selection record for
promotion, deployment, and post-deploy verification. It contains the final merged
commit/tree and the matching dispatch inputs for all three stages. The adjacent
`attestation-draft.json` remains **unapproved**, with every operational gate pending.
PR runs do not generate a final-main approval handoff; their head-SHA evidence is
candidate evidence only. A new merge produces a new handoff, not rewritten history.

Each protected release workflow now requires `release_commit`. A secretless
preflight checks that it equals the selected workflow SHA and checked-out HEAD on
the default branch **before** requesting production-environment approval. If main
advanced since the handoff, stop and use the new final-main handoff; do not reuse
the old approval or edit its SHA. Old historical workflow runs retain their old
workflow code: do not rerun them to release a newer commit.

This preflight detects selection mistakes; it cannot read or validate a protected
environment secret before approval. A stale protected attestation still needs a
genuine reviewer decision for the selected release and an authorized record update.
No SHA check, environment protection, operational gate or post-deploy requirement
is bypassed by the new handoff.

For a manual draft using the existing verifier:

Check out the final merged `main` commit. Run:

```sh
npm run prepare:production-approval
```

This writes `artifacts/production-gate/attestation-draft.json` with the full current commit on every gate, `approvedForProduction: false`, pending statuses and empty evidence. It also writes a redacted gate report. Preparation succeeds as a file-generation operation; it does **not** pass the production gate. The command refuses to overwrite an existing draft. Use a separate `RELEASE_GATE_EVIDENCE_DIR` for a new review.

When using an explicit `EXPECTED_RELEASE_COMMIT`, it must match both the checked-out `HEAD` and `GITHUB_SHA` when present. A merge creates a new commit even when the tree is unchanged. Prepare approval for the final merge commit, not the earlier PR head, and retain evidence against that commit.

## Supply actual approval evidence

The accountable reviewers must complete all 16 required gates listed in `release-readiness.json` and retain their evidence. Fill in each gate's artifact reference, verifier and timestamp, and mark it passed only after its review succeeds. Complete the release approval reference, approver and timestamp, then set `approvedForProduction: true` only for the approved release. Placeholder references and reviewers are rejected. Keep `realPatientDataAdmission` set to `blocked_pending_post_deploy_attestation`.

Repository/environment protection can be inspected before collecting credentials
or approval records: run `npm run setup:production-environment -- --verify-protection`
as an authenticated repository owner/admin on the reviewed `main` checkout. This
read-only preflight checks required CI, review enforcement and observable
production environment controls, including an explicit reviewer distinct from
the authenticated administrator and personal repository owner. Follow
`PRODUCTION_ENVIRONMENT_SETUP.md` for
the remaining independent protection checks; the snapshot is not release approval.

Store the completed record as the `PRODUCTION_RELEASE_ATTESTATION_JSON` secret in the GitHub `production` environment. Do not commit the completed record, edit the source policy to approve itself, or treat contract tests as operational review evidence. Protection and approval controls on that environment must be verified as required by `docs/PRODUCTION_MILESTONE_STACK.md`.

## Run the protected workflows

Run `Production promotion gate` on the final `main` commit with `release_commit`
from the handoff and its existing confirmation. Use the **same full SHA** for
`Exact CNYOS production deploy` and `Production post-deploy attestation`. Do not
substitute a PR head or a mutable branch name for this input. The gate runs before
dependency installation and retains its report even on failure. The Actions job
summary lists all missing or invalid evidence without printing secret contents.

For `Exact CNYOS production deploy`, configure these existing production-environment values:

| Kind | Name |
| --- | --- |
| Secret | `PRODUCTION_RELEASE_ATTESTATION_JSON` |
| Secret | `NETLIFY_AUTH_TOKEN` |
| Secret | `CLINICAL_OS_PRODUCTION_CONFIG_JSON` |
| Variable | `PRODUCTION_NETLIFY_SITE_ID` |
| Variable | `PRODUCTION_SITE_URL` |
| Variable | `PRODUCTION_SITE_HOST` |

The workflow maps the site variables to `NETLIFY_SITE_ID` and `EXPECTED_PRODUCTION_HOST`. Its preflight reports missing configuration together, then the existing dependency, contract, production-build, artifact and post-deploy checks still have to pass. The full deployment includes the Luopan page and existing clinical functions; a partial upload is not a supported replacement for the current site.

Real patient data remains blocked until the separate post-deploy attestation and operational admission requirements are satisfied. The report's `approval_validated` status means the supplied approval record passed validation; it is not itself evidence that the site deployed or that live reviews were performed.
