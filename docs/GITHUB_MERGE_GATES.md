# GitHub merge gates

`test.yml` publishes **Run Automated Tests** for PRs targeting `main`, including
Draft PRs, and merge groups. It runs the installer regression tests and the actual
CNYOS command, `npm run check`. The existing **Source + PostgreSQL + release
evidence** workflow remains required. Passing tests never submits a review,
changes a Draft to Ready, or enables auto-merge on a PR.

The installer enables repository auto-merge only after saving and reading back
main protection: both checks bound to GitHub Actions, at least one approval,
stale-approval dismissal, approval of the latest push, up-to-date checks,
conversation resolution, and administrator enforcement. Existing stronger
requirements and application bindings are retained. Unknown policy fields stop
the installer for review; signature requirements are verified but not modified.

## One-time installation

1. Review and merge the workflow PR through the existing independent review gate.
   `workflow_dispatch` becomes available only once its file exists on the default
   branch. This PR does not authorize merging the security remediation in PR #36.
2. In Settings → Environments, create **repository-admin**. Set deployment
   branches and tags to **Selected branches and tags** and add **branch main only**.
   Do this **before adding any credential**. Add required environment reviewers
   if your administrator policy requires them.
3. Add environment secret **REPOSITORY_ADMIN_TOKEN** using a short-lived
   fine-grained PAT selecting **only this repository**, with **Administration:
   read and write**, **Contents: read**, and **Checks: read**. Never add an admin
   token as a repository-wide secret or a PR workflow credential.
4. Actions → **Configure merge gates** → Run workflow on **main**, initially
   leaving **apply** unchecked. Review the proposed settings, then run with
   **apply** checked. Do not edit repository protection concurrently: GitHub's
   settings API has no transaction spanning these updates.
5. Verify Settings → General → Allow auto-merge and Settings → Branches → main.
   Both named checks must be required, with at least one independent review.
   A failed run may have saved protection before a later API error; inspect the
   settings and rerun, without weakening protection to recover.

An administrator can also invoke `node scripts/configure-merge-gates.mjs` locally
with the same credential supplied securely as `REPOSITORY_ADMIN_TOKEN` (plan),
then add `--apply` to save. No credential should be pasted into a command, chat,
log, or repository file. The target repository and branch are fixed in the script.

Enabling the repository setting does not enable auto-merge for every PR. After
the required independent review and readiness decision, a maintainer can enable
auto-merge on an eligible PR; GitHub still waits for all requirements. **PR #36
stays Draft until its separately required security and ledger reviews complete.**

## Independent reviewer

The local Astra skill/configuration does not install a GitHub review bot. This
change installs test and repository gates, not a model-backed reviewer service.
`GITHUB_BOT_TOKEN` is not used. A future reviewer service must review the current
commit as a separate authorized actor and submit a real review; it must not
approve because tests passed, approve its own PR, or reuse the administration
credential. Restrict its separate token to this repository and the permissions
its review implementation needs (Pull requests write, plus Contents read when
reading code). The Actions `pull-requests: write` declaration does not change
the permissions of a PAT stored in secrets.

## References

- [GitHub branch-protection API](https://docs.github.com/en/rest/branches/branch-protection)
- [Repository auto-merge setting](https://docs.github.com/en/rest/repos/repos#update-a-repository)
- [Manual workflow execution](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)
- [Deployment environments and secrets](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)

API behavior was checked against GitHub documentation on 2026-09-10. Automated
tests use mock API responses and do not mutate a remote repository.
