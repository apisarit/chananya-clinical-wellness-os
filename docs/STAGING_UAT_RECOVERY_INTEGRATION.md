# Existing Owner UAT version-bound recovery integration

This candidate integrates only the existing subscription-proof remediation from
the sibling owner-uat-version-remediation worktree. The source worktree was
read-only; unrelated clinical UI, platform, NAS, handoff, and package changes
were not copied.

Provenance at integration: destination and source both pointed at commit
dc6c8c776909ed8a3280765d7232ed8eacba955c. The source was dirty with unrelated
user-owned changes, so this note records the worktree provenance rather than
claiming a clean source commit for the helper.

## Integration

- scripts/staging-subscription-proof.mjs is the candidate-side bounded helper.
  It sends the current p_expected_version CAS argument, performs the same
  request-id replay with a maximum of two attempts per mutation/replay phase,
  restores only from a
  confirmed OFF receipt, preserves the original role boundary, and refuses
  ambiguous recovery.
- scripts/verify-authenticated-staging.mjs now delegates the reversible
  subscription section to that helper. Existing activation and protected-runner
  guards remain unchanged.
- tests/staging-subscription-proof-contract.mjs is included as the synthetic
  helper contract. Existing staging-safety and owner-control contracts assert
  its isolation, verifier integration, and canonical receipt keyset.
- package.json adds only this helper contract to check.

## Checks and limits

Run locally without credentials or network:

    node tests/staging-subscription-proof-contract.mjs
    node tests/staging-safety-contract.mjs
    node --experimental-loader=./tests/plain-mts-loader.mjs tests/owner-control-contract.mjs

These are synthetic/static checks only. The candidate helper is not credentialed
controller code and does not provide durable crash/watchdog recovery. The
authenticated verifier remains non-activation-ready until the protected runner,
independent review, and live staging UAT gates are completed. Its pre-existing
account-disable flow also remains outside this subscription-only integration and
must not be treated as durable activation evidence.
