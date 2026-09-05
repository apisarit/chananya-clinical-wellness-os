# Automated CNYOS production environment setup

The production workflow failed because its GitHub environment supplied none of the three site variables or three required secrets. This helper configures those six values using an owner/admin's authenticated GitHub CLI. It does not deploy, create credentials, fabricate approvals, modify protection rules, or change the existing release gate.

## Current configuration finding

On 5 September 2026, the CNYOS Netlify project was configured with `CLINICAL_OS_STAGING_DEPLOYMENT=true`, `STAGING_ONLY`, and tenant `CHANANYA-STG`. Its public Netlify URL is not evidence of clinical production readiness. The current staging tenant configuration must not be copied into the production secret. Verify the intended production database and clinic separately.

## Plan without access or writes

```sh
npm run setup:production-environment
```

This prints the fixed CNYOS site variables and missing input names. It does not use GitHub, Netlify, or a database and does not expose secret values.

## Apply with an authenticated owner

Use a clean checkout of the final reviewed `main` commit. GitHub CLI must already be authenticated as a repository administrator on `github.com`, with permission to manage production environment variables and secrets. This is a separate capability from a connector that only reads source or reruns Actions.

Provide:

1. A valid Netlify deploy token in the process environment variable `NETLIFY_AUTH_TOKEN`, supplied by your existing credential manager. Do not put it in command arguments or source files.
2. A private JSON file containing the verified production tenant config, including its actual production database, clinic identity, branding and `https://cnyos.netlify.app` auth origin.
3. A private JSON file containing genuine external approval and evidence for all ten release gates, matching that exact commit. Follow `docs/RELEASE_GATE_RECOVERY.md`; an unapproved draft is rejected.

Inspect a plan with those input files, then apply:

```sh
npm run setup:production-environment -- --config /secure/cnyos-production.json --attestation /secure/cnyos-approved-release.json
npm run setup:production-environment -- --config /secure/cnyos-production.json --attestation /secure/cnyos-approved-release.json --apply
```

Before any write, the helper validates all inputs and verifies remote `main`, repository administrator access, main branch protection, required production reviewers, and a deployment branch policy. If any check fails, it writes nothing. It never adds or relaxes these controls itself.

The destination is fixed to `apisarit/chananya-clinical-wellness-os`, environment `production`. It writes three variables, then the Netlify token and tenant config, and stores the validated approval last. Values are passed through stdin to GitHub CLI; the CLI encrypts secrets before upload. API/CLI output and error text are not echoed. A mid-write failure reports only completed key names and the failed key; earlier successful writes are not rolled back because previous secret values cannot be recovered. Correct the cause and repeat the same reviewed setup.

After setup succeeds, use the existing protected production workflow. Its dependency, build, exact artifact, and post-deployment checks still run. Setup success is not deployment success or permission to admit real patient data. If `main` changes, obtain and validate approval for the new final commit.

References: [GitHub secret set](https://cli.github.com/manual/gh_secret_set), [GitHub variable set](https://cli.github.com/manual/gh_variable_set), [GitHub environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).
