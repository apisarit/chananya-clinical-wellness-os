# CNYOS Production Operations Runbook

This runbook defines the minimum operational controls required before CNYOS can admit real patient data. It is a release-gate document, not evidence that the controls are already active.

## 1. Operating principle

CNYOS fails closed. A successful build, deploy, login, synthetic journey or database migration does not by itself authorize real patient data.

Production admission requires all pre-deployment gates to pass for one exact release commit, production promotion approval, exact commit/tree deployment, and the separate post-deploy production attestation.

If an incident creates doubt about tenant isolation, patient identity, prescription/dispensing integrity, authorization, backup recoverability or release provenance, the affected workload must be treated as unsafe until evidence establishes otherwise.

## 2. Accountable operational roles

The production roster must name a real person and an alternate for each role before the operations release gate can pass:

- Incident Commander — owns severity, containment, coordination, timeline and closure decision.
- Platform/Infrastructure Owner — owns Netlify, Supabase, deployment provenance, runtime errors and rollback execution.
- Clinical Safety Owner — owns patient-identity, prescription, dispensing, clinical workflow and unsafe-care assessment.
- Privacy/Data Owner — owns suspected exposure, tenant-boundary incidents, evidence preservation and PDPA/privacy escalation.
- Clinic/Business Owner — owns clinic communications, service suspension decisions and business continuity.

One person may cover more than one role for a small operation, but every role must have a named primary and alternate. A release cannot pass with placeholders such as TBD or unassigned.

## 3. Severity model

### SEV-0 — Immediate safety, privacy or integrity risk

Examples include suspected cross-tenant access, unauthorized patient access, wrong-patient identity binding, unauthorized prescription/dispensing, material clinical-data corruption, leaked privileged credential, or a failed restore/integrity check during a real incident.

Required response: page the Incident Commander and relevant safety/data owners immediately; block affected real-data admission or suspend the affected tenant; preserve evidence; do not perform destructive cleanup before evidence capture. Target human acknowledgement is 15 minutes or less while the service is admitting real patient data.

### SEV-1 — Major production outage or control failure

Examples include widespread login failure, database unavailability, critical workflow outage, repeated function failures, scheduled backup failure beyond the defined recovery objective, LINE operational messaging failure that materially affects clinical operations, or a production deployment whose provenance cannot be established.

Required response: page the Incident Commander and Platform Owner; contain the affected function or tenant; evaluate rollback; communicate operational impact. Target acknowledgement is 30 minutes or less while the affected service is open for clinical use.

### SEV-2 — Degraded service without immediate safety/data risk

Examples include isolated UI degradation, non-critical reporting issues, or a recoverable external-provider slowdown. Required response: create a tracked incident, define an owner and resolution deadline, and escalate if severity changes.

## 4. Minimum production monitoring

The operations gate cannot pass until monitoring is active and a retained test proves that alerts reach the accountable roster.

At minimum monitor:

1. Public HTTPS availability and TLS for the intended CNYOS production origin.
2. Exact deployed commit/tree provenance and unexpected deployment change.
3. Netlify Function 5xx/error rate and abnormal latency for clinical/auth/Owner/backup/LINE boundaries that are enabled.
4. Supabase database/API availability, authentication failures and abnormal connection/resource pressure.
5. Tenant authorization and Owner subscription enforcement failures, especially any cross-tenant or suspended-tenant access anomaly.
6. Scheduled backup last-success time, manifest completion, destination, encryption metadata and failure state.
7. Restore-drill evidence age and whether the current backup format remains restorable.
8. LINE webhook/dispatcher failures, retry exhaustion and dead-letter/backlog state when LINE is enabled.
9. Security-relevant authentication, service-role and authorization anomalies without logging PHI or reusable credentials.
10. Capacity/cost thresholds that could suspend or materially degrade Netlify, Supabase, storage or other enabled runtime providers.

Monitoring must not store raw patient content, raw LINE identifiers, access tokens, service-role keys or other reusable secrets in alert payloads.

## 5. Alert routing and evidence

Before release, retain:

- monitoring configuration or exported rule identifiers;
- the named primary/alternate roster and escalation path;
- one successful alert-delivery test for SEV-0/SEV-1 routing;
- evidence that alerts include environment, tenant/site identifier when relevant, timestamp, failing control and evidence reference without PHI;
- evidence that the alert path works outside the affected application itself.

A dashboard without tested alert delivery is not sufficient.

## 6. Containment order

Use the least destructive control that reliably stops unsafe activity:

1. Block new real-patient-data admission where the release/admission gate supports it.
2. Suspend the affected tenant with Owner Control when the incident is tenant-scoped and subscription enforcement is still trustworthy.
3. Disable the affected integration or workflow boundary when isolation is proven and the remaining system can operate safely.
4. Roll back the application to the last exact commit/tree that has retained production evidence when a release regression is suspected.
5. If authorization, provenance or data integrity cannot be trusted, take the affected clinical workload out of service rather than operating in an uncertain state.

Do not use a client-side UI toggle as the only containment control for an authorization or data-isolation incident.

## 7. Rollback rule

Rollback is allowed only to a known artifact/commit with retained provenance. The rollback record must capture:

- incident/change reference;
- from-commit and from-tree;
- target commit and target tree;
- Netlify deploy ID or equivalent immutable deployment reference;
- database migration compatibility decision;
- whether database rollback is required, prohibited or replaced by forward repair;
- accountable approver;
- start/end timestamps and post-rollback smoke evidence.

Never assume application rollback automatically reverses database migrations. Destructive database rollback requires its own reviewed recovery plan and evidence.

## 8. Backup and recovery during an incident

Google Drive encrypted export and managed database backup/PITR are separate controls. An export manifest is not proof that the managed database can be restored, and a managed database backup is not a substitute for the encrypted off-site evidence set.

For a recovery event:

1. Freeze the exact source backup slot and evidence references.
2. Restore into an isolated target unless the reviewed emergency procedure explicitly requires another method.
3. Verify record counts, digests, tenant boundaries and at least one complete clinical chain required by the restore contract.
4. Record measured RPO and RTO.
5. Obtain clinical/data approval before reconnecting a restored environment to real clinical work.

## 9. Security and privacy incident handling

For suspected exposure or credential compromise:

- preserve deployment, authentication and authorization evidence;
- rotate/revoke affected credentials through the provider rather than recording new secrets in tickets or chat;
- identify affected tenant/environment/time window using metadata that does not unnecessarily reproduce patient content;
- involve the Privacy/Data Owner and applicable legal reviewer;
- keep the affected release/admission gate closed until containment and review are complete.

This runbook does not determine statutory notification obligations. Applicable legal/privacy reviewers must make that determination from the actual incident facts.

## 10. Clinical-safety reopening criteria

After a SEV-0/SEV-1 incident affecting clinical workflows, real-data admission may reopen only when:

- the cause and containment are documented;
- tenant/auth/patient-identity boundaries relevant to the incident are reverified;
- prescription/dispensing or other affected clinical-chain integrity is reverified;
- the active deployment commit/tree is attested;
- backup/recovery state is known and acceptable;
- the Incident Commander and required Clinical Safety / Privacy / Platform owners record approval.

## 11. Required operations-gate artifact

`operational_monitoring_incident_response` may be changed to `passed` only when one retained artifact set tied to the exact release commit contains:

- monitoring rule/export references;
- named primary/alternate roster;
- successful alert-delivery test evidence;
- incident severity/escalation acknowledgement;
- rollback procedure plus at least one non-production rollback or deployment-recovery drill;
- backup-alert and recovery-objective evidence;
- verification timestamp and accountable verifier.

The artifact must use the same exact release commit required by `release-readiness.json`. A runbook alone is not evidence that operations are active.

## 12. Post-deploy observation before real-data admission

After the approved exact commit/tree is deployed and before real patient data is admitted:

1. Run the Production post-deploy attestation.
2. Confirm monitoring sees the new deploy ID/commit and no unexpected production deploy occurred.
3. Confirm critical alert routes remain armed.
4. Confirm database, auth and enabled integration health.
5. Confirm the current backup schedule and destination are active.
6. Retain the post-deploy evidence and only then complete the real-data admission decision.

If any item is unverifiable, admission remains blocked.
