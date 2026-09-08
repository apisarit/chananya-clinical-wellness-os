# CNYOS staging protected-controller bootstrap

This directory is a dormant bootstrap package. Nothing here is an active GitHub
workflow, and nothing in this package authorizes a deployment. Copy it into a
**separate deployment-control repository** only after the controls below have
been established. Do not activate it from a pull-request branch of the CNYOS
application repository.

The separation is mandatory: the CNYOS `main` branch automatically publishes to
Netlify, while a candidate branch must not define the workflow or scripts that
receive deployment and database credentials. PR #36 remains draft and
unapproved. This package neither merges it nor grants Production access.

## Activation status: blocked by design

The templates contain an unconditional bootstrap stop. Do not change its state
until every placeholder Action SHA is pinned and all controller-owned scripts
and contracts named by the bootstrap job exist and pass. In particular, this
package intentionally does **not** claim that a normal Netlify deploy token can
prove or enforce any of these controls:

- deterministic, source-reproducible, dependency-lock-bound Function archives;
- a hermetic independent rebuild and byte comparison for the static site;
- a private draft URL and automatic deletion/revocation of every rejected draft;
- a controller-owned draft access boundary that consumes its bearer credential
  and forwards no Authorization header, cookie, or redirect to candidate routing;
- an independent, server-enforced, compare-and-swap publish lease that excludes
  Netlify Git, UI, build-hook, and other publishers;
- authenticated rollback artifacts immune to same-run artifact-name poisoning;
- an immutable rollback-attestation broker deposit, made before any Netlify
  credential is used, that retains the raw signed recovery inputs out of band;
- a separate staging-only rollback principal and a noninteractive rollback
  Environment; or
- controller-owned authenticated synthetic UAT, public scheduled-Function route
  denial, and closed-world runtime capability validation; or
- removal or broker-enforced denial of every legacy Git, UI, preview, build-hook,
  token, and workflow publisher that can mutate the same Netlify site; or
- cryptographically verified, pinned trust boundaries for every external
  publish/reconciliation, draft-lifecycle, and rollback-membership broker client;
  or
- a fresh live GitHub release-state proof that PR #36 remains open, draft,
  unmerged, and unapproved and that a separate ordered-migration staging
  promotion proposal exactly matches the signed authorization.

Those are activation prerequisites, not risk acceptances. The draft lifecycle
must persist an external write-ahead intent before the first Netlify mutation and
must reconcile a runner loss by controller run ID: restore an owned current
deploy, delete or revoke every non-current draft, and release any publisher
lease. If any prerequisite is unavailable, the draft must not be created and the
controller must remain blocked.

## Security boundary

The controller's default branch, workflow templates, policy, scripts, dependency
lock, and approver trust roots are part of one protected control plane. Configure
all of the following before removing the template's bootstrap stop:

1. Create a separate controller repository with branch protection, CODEOWNERS,
   two-person review, signed commits, no force pushes, and no administrator
   bypass. Put the copied workflow on its protected default branch.
2. Create a `cnyos-staging-publish` GitHub Environment. Allow deployment only
   from the controller's protected default branch, require independent approval,
   prevent self-review, and do not permit administrator bypass.
3. Use a dedicated Netlify identity whose complete accessible-site inventory is
   exactly `7da5e39e-580d-44f1-8623-605313e2fb2b` (`cnyos`). It must not belong
   to a team or role that can reach Chananya Production. If this cannot be
   demonstrated, the controller stays blocked.
   Use a different subject and token for rollback; equality between the publish
   and rollback subjects is a hard failure.
   A normal Netlify personal access token is not a documented deploy-only
   credential: a Developer is over-capable, while the documented Publisher role
   does not establish API/CLI deployment authority. Therefore the template must
   remain blocked until an independently reviewed authority broker can freshly
   attest the subject, role, absence of owner/team/configuration capability, the
   exact one-site inventory, and denial of every alternate publisher. Signed
   booleans and `/user` plus `/sites` responses alone are insufficient.
4. Review and commit this package's `package-lock.json`, then pin every GitHub
   Action in the templates to a full commit SHA. The publisher
   runs only the locally installed `netlify` binary; it never uses `npx`,
   `npm exec --yes`, a tag, or a runtime package install while holding a token.
   Replace `__AUDITED_NETLIFY_CLI_VERSION__` in the policy and workflow only
   after adding that exact CLI release to the lock and obtaining a clean
   high/critical dependency audit plus an independent candidate-input
   reachability review. At the 2026-09-08 checkpoint, the current official
   `netlify-cli` 27.5.0 lock reported ten high-severity transitive advisories,
   including vulnerable TOML parsing and Sharp/libvips paths, so it was removed
   from this bootstrap lock and is not authorized for credentialed execution.
5. Commit the approver public-key registry as a reviewed trust root in the
   protected controller repository; do not supply it as a sibling Environment
   secret. Keep the two Ed25519 private keys with different people. A Jaoball
   approval of PR #38 is not PR #36 security review.
6. Port every credentialed verifier, including authenticated UAT, static
   reproducibility, draft-boundary canary, runtime-capability proof, and
   scheduled-route denial, into reviewed controller-owned code. Candidate scripts
   may run only in the unprivileged producer. Until all ports and their activation
   contracts exist and pass, this bootstrap proves no live deployment gate.
7. Bind an immutable external reconciliation-broker policy/version into the
   signed authorization and durable draft intent. The broker, not code from the
   failed candidate or a later controller revision, owns recovery. It must reject
   a new publish while any earlier run remains unreconciled.
8. Provision the separately administered rollback-attestation broker and pin its
   exact HTTPS origin, policy digest, OIDC audience, Ed25519 receipt key ID, and
   SPKI digest in `controller-policy.json`. Before preflight, the controller must
   deposit the canonical authorization, both detached authorization signatures,
   and exact known-good bytes. Only the broker-signed sanitized receipt and its
   validation evidence may enter GitHub artifacts. The deposit client and its
   adversarial contract are intentionally absent, so activation remains blocked.
9. Replace every field in `externalReconciliationBroker`, `draftLifecycleBroker`,
   and `rollbackPrincipalMembershipBroker` atomically with independently reviewed
   trust values. The cross-cutting `external-broker-trust-boundaries` activation
   contract must then prove every client uses only the exact HTTPS origin and
   operation path/domain, disables redirects, verifies a bounded canonical
   Ed25519-signed response against the pinned key ID and SPKI digest, binds the
   policy, controller run/ref/attempt/nonce, source, artifact, staging site, and
   operation, rejects stale/replayed/conflicting state with compare-and-swap where
   mutation occurs, and permits no credential forwarding or serialization.
10. Implement the intentionally missing `live-github-release-boundary` script and
    adversarial contract in controller-owned code. It must query GitHub immediately
    before any Netlify credential is exposed or mutation occurs and again before
    promotion, using a read-only identity isolated from deployment and database
    secrets. Its fresh exact-run evidence must prove PR #36 is open, draft,
    unmerged, and unapproved and bind the independently reviewed, separate ordered-
    migration staging promotion PR/ref/state to the signed source authorization.
    The resulting evidence must be hash-bound through preflight and final evidence.
    Merging PR #36 or using application `main` as a staging gate is prohibited
    because that branch automatically deploys Production. Until this design,
    implementation, evidence binding, and contract exist, activation stays blocked.

## Two-phase release

The first job is an unprivileged producer. It checks out a full candidate commit
SHA, runs locked checks/builds with no Netlify token, Supabase service-role key,
database password, signing key, or Environment secret, then calls
`create-producer-bundle.mjs`. The resulting manifest binds:

- controller run ID, attempt one, and a 32-byte-or-longer nonce;
- exact candidate commit and tree;
- every byte under `dist/`;
- every tracked Function source byte and Git object under
  `netlify/functions/`;
- every controller-produced self-contained Function archive and the exact
  reviewed dependency-lock digest; and
- a deterministic aggregate artifact digest.

After the producer finishes, the independent security reviewer and managed
platform risk owner sign the exact authorization JSON for that controller run,
nonce, source tree, producer-manifest digest, artifact digest, prior known-good
deploy, and fixed staging targets. Only then may the protected Environment
release secrets to a fresh publisher job.

`verify-authorization.mjs` requires two distinct pinned Ed25519 public keys in
canonical SPKI form, rejects private-key PEM input, retains no raw signatures or
raw authorization/known-good payloads, and requires a maximum 30-minute
authorization lifetime, the dispatching risk owner, attempt one, a
protected controller ref, an exact artifact re-hash, a staging-only principal
proof, the three required PR #36 SQL-security review areas, explicit acceptance
of the Function-byte provenance limitation, and an exact known-good rollback
target. A new GitHub run cannot replay the packet because the signed run ID and
nonce must match.

## Protected configuration

Repository variables may contain only browser-public staging configuration used
by the producer. Never put an admin password, service-role key, Netlify token, or
signing key in a producer variable.

The `cnyos-staging-publish` Environment supplies these secrets only to trusted
controller steps:

| Secret | Purpose |
| --- | --- |
| `CNYOS_STAGING_NETLIFY_AUTH_TOKEN` | Proposed staging-only Netlify principal; unusable until the external authority boundary proves a provider-supported least-privilege model |
| `CNYOS_CONTROLLER_AUTHORIZATION_JSON` | Exact signed run/artifact authorization |
| `CNYOS_CONTROLLER_SECURITY_SIGNATURE_BASE64` | Independent reviewer signature |
| `CNYOS_CONTROLLER_RISK_OWNER_SIGNATURE_BASE64` | Named risk-owner signature |
| `CNYOS_STAGING_DRAFT_ACCESS_BOUNDARY_TOKEN` | Opaque bearer accepted only by the separate reviewed draft-access boundary; never send it to, or reuse it as a credential for, a candidate Netlify origin |
| `CNYOS_STAGING_SUPABASE_SERVICE_ROLE_KEY` | Server-only key for controller-owned synthetic UAT |
| `CNYOS_STAGING_TEST_PASSWORD` | Password for synthetic staging identities only |

The protected repository variable `CNYOS_PRIVATE_DRAFT_ACCESS_BOUNDARY_URL`
must equal the exact reviewed origin pinned in `controller-policy.json`. The
boundary policy ID and SHA-256 are signed release inputs. The boundary must use a
fixed site/deploy target, reject redirects, return only response bytes, and prove
with a candidate-Function canary that it forwarded no bearer, Authorization
header, or cookie. A request from the controller directly to a candidate origin
with this credential is prohibited.

`CNYOS_NETLIFY_AUTHORITY_BROKER_URL` must identify a separately administered
attestation service whose reviewed policy ID and SHA-256 exactly match
`controller-policy.json`; its origin and Ed25519 signing-key SPKI fingerprint
must also be pinned there. Immediately before preflight it must issue a maximum
10-minute, exact-run proof of the live principal role/capabilities, staging-only
site inventory, same-site Production conflict resolution, and closed alternate
publisher inventory. Missing, stale, self-issued, or mismatched evidence blocks
the draft.

`CNYOS_NETLIFY_PUBLISH_BROKER_URL`, `CNYOS_DRAFT_LIFECYCLE_BROKER_URL`, and
`CNYOS_NETLIFY_PRINCIPAL_MEMBERSHIP_BROKER_URL` are untrusted configuration until
each exactly equals the HTTPS URL formed from its corresponding policy `origin`
and `operationPath`. The protected policy also pins a fixed operation domain,
policy ID/SHA-256, canonical Ed25519 public key, key ID/SPKI SHA-256, OIDC
audience, ten-minute evidence ceiling, and response-size ceiling. Broker clients
must reject redirects and noncanonical, unsigned, stale, replayed, cross-run,
cross-source, cross-artifact, cross-site, or wrong-operation responses. A client
running beside a Netlify token must prove it performs no credential forwarding or
serialization; merely keeping a token out of the broker URL is insufficient.

`CNYOS_ROLLBACK_ATTESTATION_BROKER_URL` must resolve to the exact origin pinned
in `rollbackAttestationBroker`. Its write endpoint authenticates the protected
controller by OIDC, accepts one immutable deposit per exact repository/ref/
workflow/run/attempt/nonce, rejects conflicting overwrites, and retains the raw
recovery inputs for at least the policy retention period. Its signed receipt
binds the controller and candidate identities, full producer artifact hashes,
fixed staging target, prior deploy, authorization/registry/known-good hashes,
both authorization key IDs and signature hashes, and the external reconciliation
policy. Broker unavailability, redirect, stale receipt, wrong signing key,
insufficient retention, or a missing deposit blocks preflight and therefore
blocks every Netlify mutation.

The separate, noninteractive `cnyos-staging-rollback` Environment supplies only
the recovery credential:

| Secret | Purpose |
| --- | --- |
| `CNYOS_STAGING_NETLIFY_ROLLBACK_TOKEN` | Separate staging-only, noninteractive rollback principal |

Never copy the rollback token into the publish Environment, and never configure
both tokens for the same Netlify subject.

The key registry has this shape:

```json
{
  "schemaVersion": 1,
  "environment": "cnyos-staging",
  "keys": [
    {
      "id": "unique-key-id",
      "role": "independent_security_reviewer",
      "githubLogin": "reviewer-login",
      "ownerName": "Reviewer name",
      "publicKeyPem": "-----BEGIN PUBLIC KEY-----...",
      "spkiSha256": "64-lowercase-hex"
    }
  ]
}
```

The second record uses role `managed_platform_risk_owner`. Store the real file as
`ops/cnyos-staging-controller/approver-registry.json` on the protected controller
branch. The signed authorization must also bind the exact controller repository,
workflow path, and commit; candidate SHA is data only.

## Publish and rollback contract

Before mutation, the controller must persist a preflight artifact that proves:

- a fresh external authority attestation re-proves role/capability and all
  publisher-exclusion facts instead of trusting only the signed packet;
- the token can list exactly the one fixed staging site;
- site ID, name, and canonical origin are exact;
- `BACKUP_ENABLED=false` in the published Functions context, an exact active
  deploy created after that setting, and runtime fail-closed behavior for the
  daily backup, recovery scheduler, and background worker;
- the signed prior deploy is still current, ready, belongs to the site, and is a
  known-good rollback target; and
- authorization and producer-bundle digests match.

The only permitted sequence is live rollback-readiness proof -> draft -> reviewed
boundary canary -> immutable draft verification through that boundary -> control
file behavior verification -> private-draft lifecycle proof -> independent
exclusive-publisher lease -> revalidation of the exact rollback-readiness and
draft-gate digests within the broker's ten-minute window -> promotion of that
exact deploy ID -> post-promotion
closed-world file/API byte and Function/schedule verification -> public GET and
malformed-POST denial on both immutable and canonical origins -> synthetic UAT ->
final exact-current check -> atomic publisher-lease release receipt -> evidence
closure. `_headers` and `_redirects` are
Netlify control inputs rather than public files; verify their resulting behavior
on the immutable draft. When anonymous draft access is denied, only the separate
reviewed boundary may consume its access credential. Never use `netlify deploy
--prod` for the draft.

Every rejected pre-promotion draft must be deleted or access-revoked. A durable
external intent must make the draft discoverable even if the publisher exits
after Netlify accepts it but before a local receipt or job output is written.
Every post-promotion failure, cancellation, or timeout invokes reconciliation.
Rollback may
restore the signed prior deploy only when the current deploy is both the exact
receipt deploy **and** has the controller's exact run/nonce ownership marker. It
must first obtain the exact signed packet, both signatures, and known-good bytes
from the immutable rollback-attestation broker and match their SHA-256 values to
the sanitized GitHub verification bundle and protected public-key registry. Raw
authorization, signature, private-key, and known-good payloads must never be
uploaded as workflow artifacts. Before any mutation, the publisher must already
hold a fresh, broker-signed receipt proving that deposit. Recovery must retrieve
by the exact run/nonce and OIDC controller identity, hash-match every returned
raw byte sequence to that receipt and the sanitized bundle, and independently
repeat canonical schema, Ed25519 signature, registry, known-good, source,
artifact, and run-binding verification. Authorization expiry may be ignored only
for this recovery verification; scope and identity checks remain mandatory. It
must then retain that exact authenticated rollback-chain validation for 365 days
before or even when reconciliation fails, and verify privileged artifact
provenance and must never overwrite a different external deploy. A separate protected `workflow_run`
watchdog asks the immutable reconciliation broker to repeat all three effects
after the primary run ends: conditional rollback, rejected-draft cleanup, and
lease release. Its per-target-run concurrency key cannot be displaced by a newer
publish dispatch. Its `cnyos-staging-rollback` Environment must have no reviewer
or wait timer. Before that Environment's GitHub or Netlify recovery credentials
enter a step, the watchdog must independently repeat the release workflow's
protected-file, placeholder, locked-dependency, base-test, and closed-world
activation checks. Netlify or GitHub control-plane loss still requires a
separately reviewed manual restore runbook and alerting.

Database rehearsal, quiescence, fresh-observer, and strict post-remediation
evidence must be canonical and no more than 30 minutes old when authorization is
validated. Exact catalog counts are not timeless constants: the signed packet
must also bind the reviewed baseline schema version and SHA-256. Any age,
baseline, or digest mismatch blocks the run.

The current application repository contains legacy Production and preview
workflows that can expose credentials to candidate-owned commands, and its
Production setup currently names the same Netlify site ID/origin as this staging
policy. This package does not edit or authorize those Production paths. Before
activation, signed deployment-boundary evidence and the independent publisher
broker must prove that the site is staging-only with no real patient data, that
the mapping conflict is resolved, and that every candidate-repository
Production/preview workflow and alternate credential is unable to publish to the
target. A documentation assertion or a hard-coded site ID is not enforcement;
failure to prove any item blocks the draft before its first mutation.

`CNYOS_OWNER_CONTROL_ENABLED` remains `false` in the releasable staging
configuration. Enabling it for a synthetic test would require a separately
reviewed ephemeral capability with enforced expiry and post-UAT revocation; this
bootstrap does not provide or authorize that capability.

Success evidence is fail-closed: missing files are errors, not warnings. UAT
evidence must bind all 11 provisioned identities, the access-context and
department checks, ten-route matrix, ten synthetic journeys, subscription OFF/ON
restoration, per-gate evidence hashes, and zero unresolved failures. The final
manifest directly re-hashes the pre-release reconciliation, authorization
verification bundle, rollback-attestation receipt and validation, live Netlify
authority proof, function-environment validation, backup-disable boundary,
runtime-capability boundary, rollback readiness, draft gate, durable draft
intent, private draft-access boundary, promotion attempt, and every subsequent
receipt through publisher-lease release. It also
cross-links source, run, nonce, artifact, authorization, preflight, new deploy,
current-deploy verification, Function metadata/process provenance,
draft-boundary canary, scheduled-route denial, and rollback target hashes.
Netlify does not expose independently
retrievable Function bundle bytes in the current design, so the evidence must
say `functionByteAttestationAvailable: false`; names, schedules, route denial,
clean source and a pinned publisher are process provenance, not a byte proof.

## Local, offline validation

From this directory:

```sh
npm test
```

The tests use temporary directories and static/mocked inputs. They do not connect
to GitHub, Netlify, Supabase, Google Drive, or a database. The workflow templates
deliberately contain pinned-SHA placeholders; the tests require the bootstrap
stop and every missing activation prerequisite to remain fail closed until an
independent controller review replaces them with passing implementations.
Activation also requires adversarial behavioral coverage of the producer,
producer verifier, and authorization verifier, plus a fresh external Netlify
authority-boundary contract. The deliberately absent
`external-broker-trust-boundaries` contract must exercise URL pinning, disabled
redirects, bounded canonical signature verification, exact run/ref/nonce/source/
artifact/site/operation binding, freshness, replay and compare-and-swap failure,
and no credential forwarding or serialization across every external broker
client. The rollback-attestation deposit client and its
contract must additionally prove no-deposit/no-draft, exact hash/run/nonce/OIDC
binding, conflict and replay handling, broker redirect/unavailability failure,
retention enforcement, and absence of raw inputs from logs, outputs, and
artifacts. Those contracts are intentionally absent here;
their absence is an activation failure, not a skipped test.
