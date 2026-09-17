# CNYOS version index

[version-index.json](../version-index.json) identifies the current application
version and the files belonging to the staff-membership UAT recovery candidate.

| Item | Version | Meaning |
| --- | --- | --- |
| Application/package | `3.5.0-preview.7` | Existing package and lockfile version; unchanged |
| Staff-membership UAT helper | `1.0.0-candidate.2` | Checkpoint/recovery follow-up, not a deployed release |
| Version-index schema | `1` | Format of this catalogue |
| UAT closure-confirmation schema | `1` | Receipt-bound completion of the membership test, not a clinical encounter |

The helper exports `MEMBERSHIP_PROOF_VERSION`. Its successful closure
confirmation carries the component version, validated OFF/ON request IDs and
state versions. The confirmation's `requestId` is the existing ON/restore
request ID, not a new database operation or a replay authorization. Failed or
unconfirmed proof execution must not emit a verified closure.

Run `npm run check:version-index` to check the package/lockfile versions,
component export, indexed paths, copyright placeholder and non-authorizing
metadata. The membership-recovery check also runs this contract.

This is a version/path catalogue, **not a cryptographic source manifest**.
Equal version strings do not prove equal source bytes. Exact reviewed Git
commit/tree, actual artifact hashes and retained run-specific receipts are
still required by the existing release protocol. The native test checkpoint was
captured from an uncommitted working tree based on `9de6cd2`; that base commit
does not include this follow-up. Resolve the current checkout's actual Git SHA
for any subsequent review or run rather than relabelling the historical result.

Copyright-holder confirmation is pending; see [COPYRIGHT.md](../COPYRIGHT.md).
No licence, third-party notice, application release version, readiness gate,
or production policy has been changed. The indexed native fixture now covers
bounded PostgreSQL multi-session behavior; see
[its checkpoint](STAGING_MEMBERSHIP_NATIVE_RECOVERY.md). Protected cross-process
runner recovery, the complete deployed database graph and live staging remain
separate work.

The `1.0.0-candidate.2` follow-up adds the local persistent journal adapter,
checkpoint/recovery tests and [integration boundary](STAGING_MEMBERSHIP_JOURNAL.md).
Its recovery result includes the original ON `requestId` but deliberately has
`freshUatEvidence: false` and no verified closure. Original native SQL results
are not re-labelled as a test of this newer helper or journal.
