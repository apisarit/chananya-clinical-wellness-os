# Automated CNYOS production environment setup

This helper validates and configures three site variables and three required secrets using an owner/admin's authenticated GitHub CLI. It does not deploy, create credentials, fabricate approvals, modify protection rules, or change the existing release gate.

## Current configuration finding

On 5 September 2026, the CNYOS Netlify project was configured with `CLINICAL_OS_STAGING_DEPLOYMENT=true`, `STAGING_ONLY`, and tenant `CHANANYA-STG`. Its public Netlify URL is not evidence of clinical production readiness. The current staging tenant configuration must not be copied into the production secret. Verify the intended production database and clinic separately.

## Plan without access or writes

```sh
npm run setup:production-environment
```

This prints the fixed CNYOS site variables and missing input names. It does not use GitHub, Netlify, or a database and does not expose secret values.

## Inspect protection before collecting release inputs

From a checkout of the reviewed `main` commit, an owner/admin can run:

```sh
npm run setup:production-environment -- --verify-protection
```

This performs authenticated GitHub reads only. It requires no Netlify token,
tenant configuration or release attestation. It cannot be combined with
`--apply`, `--config` or `--attestation`. It prints a redacted, timestamped control
snapshot for the exact `main` commit, or a constant blocking error code. An
inaccessible endpoint is a blocker, never an assumption that protection exists.

The same preflight runs before the first configuration write in apply mode:

- `main` must be protected and require the up-to-date
  `Source + PostgreSQL + release evidence` check from the GitHub Actions app
  (`15368`). A context accepting any publisher is insufficient.
- At least one approving review, stale-approval dismissal, approval of the latest
  push by another person, and no review-bypass allowances are required.
- Branch restrictions must apply to administrators, with force pushes and
  deletion disabled.
- Production requires prevention of self-review and at least one explicit user
  reviewer whose stable GitHub identity differs from both the authenticated
  administrator and, for a personal repository, its owner. Team-only,
  owner-only and caller-only reviewer lists fail because the environment
  response alone cannot prove an independently actionable approver. Its
  deployment policy must allow protected branches or contain exactly one custom
  rule for the `main` branch. Wildcards, tags, extra rules and incomplete lists
  fail.
- The remote `main` SHA is checked again after reading protection controls.

This implementation verifies classic branch-protection API fields. A ruleset-only
configuration is not automatically treated as equivalent. Independently inspect
ruleset/bypass actors, reviewer permissions and environment administrator-bypass
settings; this REST snapshot does not establish those controls. Protected-branches
mode allows other protected branches, so the production workflows' exact default
branch checks must remain enforced. No protection snapshot passes the production
gate or replaces actual CI, review and operational evidence.

## Apply with an authenticated owner

Use a clean checkout of the final reviewed `main` commit. GitHub CLI must already be authenticated as a repository administrator on `github.com`, with permission to manage production environment variables and secrets. This is a separate capability from a connector that only reads source or reruns Actions.

Provide:

1. A valid Netlify deploy token in the process environment variable `NETLIFY_AUTH_TOKEN`, supplied by your existing credential manager. Do not put it in command arguments or source files.
2. A private JSON file containing the verified production tenant config, including its actual production database, clinic identity, branding and `https://cnyos.netlify.app` auth origin.
3. A private JSON file containing genuine external approval and evidence for all 16 release gates, matching that exact commit. Follow `docs/RELEASE_GATE_RECOVERY.md`; an unapproved draft is rejected.

Inspect a plan with those input files, then apply:

```sh
npm run setup:production-environment -- --config /secure/cnyos-production.json --attestation /secure/cnyos-approved-release.json
npm run setup:production-environment -- --config /secure/cnyos-production.json --attestation /secure/cnyos-approved-release.json --apply
```

Before any write, the helper validates all inputs and runs the protection preflight above. If any check fails, it writes nothing. It never adds or relaxes these controls itself.

Approval validation checks the supplied record's fields, gate statuses and commit binding. It does not independently perform the 16 operational reviews or verify every referenced evidence artifact. Those reviews remain the accountable reviewers' responsibility.

The destination is fixed to `apisarit/chananya-clinical-wellness-os`, environment `production`. It writes three variables, then the Netlify token and tenant config, and stores the validated approval last. Values are passed through stdin to GitHub CLI; the CLI encrypts secrets before upload. API/CLI output and error text are not echoed. A mid-write failure reports only completed key names and the failed key; earlier successful writes are not rolled back because previous secret values cannot be recovered. Correct the cause and repeat the same reviewed setup.

After setup succeeds, use the existing protected production workflow. Its dependency, build, exact artifact, and post-deployment checks still run. Setup success is not deployment success or permission to admit real patient data. If `main` changes, obtain and validate approval for the new final commit.

References: [GitHub secret set](https://cli.github.com/manual/gh_secret_set), [GitHub variable set](https://cli.github.com/manual/gh_variable_set), [branch protection API](https://docs.github.com/en/rest/branches/branch-protection), [environment protection API](https://docs.github.com/en/rest/deployments/environments).
