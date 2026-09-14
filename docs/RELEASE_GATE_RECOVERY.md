# Recover a blocked production release

`PRODUCTION_RELEASE_ATTESTATION_JSON_REQUIRED` means the process running the gate did not receive the approval record. A local failure does not establish whether the GitHub production environment contains that secret. Source-controlled pending gate statuses also do not establish that live reviews failed: the source policy intentionally stays fail closed.

## Prepare the exact candidate

Check out the final merged `main` commit. Run:

```sh
npm run prepare:production-approval
```

This writes `artifacts/production-gate/attestation-draft.json` with the full current commit on every gate, `approvedForProduction: false`, pending statuses and empty evidence. It also writes a redacted gate report. Preparation succeeds as a file-generation operation; it does **not** pass the production gate. The command refuses to overwrite an existing draft. Use a separate `RELEASE_GATE_EVIDENCE_DIR` for a new review.

When using an explicit `EXPECTED_RELEASE_COMMIT`, it must match both the checked-out `HEAD` and `GITHUB_SHA` when present. A merge creates a new commit even when the tree is unchanged. Prepare approval for the final merge commit, not the earlier PR head, and retain evidence against that commit.

## Supply actual approval evidence

The accountable reviewers must complete the ten required gates listed in `release-readiness.json` and retain their evidence. Fill in each gate's artifact reference, verifier and timestamp, and mark it passed only after its review succeeds. Complete the release approval reference, approver and timestamp, then set `approvedForProduction: true` only for the approved release. Placeholder references and reviewers are rejected. Keep `realPatientDataAdmission` set to `blocked_pending_post_deploy_attestation`.

Store the completed record as the `PRODUCTION_RELEASE_ATTESTATION_JSON` secret in the GitHub `production` environment. Do not commit the completed record, edit the source policy to approve itself, or treat contract tests as operational review evidence. Protection and approval controls on that environment must be verified as required by `docs/PRODUCTION_MILESTONE_STACK.md`.

## Run the protected workflows

Run `Production promotion gate` on the final `main` commit with its existing confirmation. The gate runs before dependency installation and retains its report even on failure. The Actions job summary lists all missing or invalid evidence without printing secret contents.

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
