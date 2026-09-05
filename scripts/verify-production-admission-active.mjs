import process from 'node:process';
import {
  assertActive,
  currentSource,
  listExactSubscription,
  loadProductionTarget,
  parseAdmissionAttestation,
  readPublicDeploymentEvidence,
  requiredEnv,
  validateAdmissionAttestation,
  verifyNetlifyPublishedDeploy,
  writeEvidence
} from './production-admission-support.mjs';

async function verifyProductionAdmissionActive({ env = process.env } = {}) {
  if (env.CNYOS_PRODUCTION_ADMISSION_VERIFY_ACK !== 'VERIFY_CNYOS_REAL_PATIENT_DATA_ACTIVE') {
    throw new Error('CNYOS_PRODUCTION_ADMISSION_VERIFY_ACK_REQUIRED');
  }
  const source = currentSource({ env });
  const target = loadProductionTarget(env);
  const origin = new URL(requiredEnv('PRODUCTION_SITE_URL', env)).origin;
  if (new URL(origin).hostname.toLowerCase() !== requiredEnv('PRODUCTION_SITE_HOST', env).toLowerCase()) {
    throw new Error('PRODUCTION_ADMISSION_SITE_HOST_MISMATCH');
  }
  const attestation = validateAdmissionAttestation(
    parseAdmissionAttestation(requiredEnv('PRODUCTION_ADMISSION_ATTESTATION_JSON', env)),
    { source, target, origin }
  );
  const netlify = await verifyNetlifyPublishedDeploy(attestation, env);
  const publicEvidence = await readPublicDeploymentEvidence(
    requiredEnv('PRODUCTION_PUBLIC_DEPLOYMENT_EVIDENCE_PATH', env),
    { source, origin }
  );
  if (publicEvidence.deploymentId && publicEvidence.deploymentId !== attestation.netlifyDeployId) {
    throw new Error('PRODUCTION_ADMISSION_PUBLIC_DEPLOY_ID_MISMATCH');
  }
  const serviceRoleKey = requiredEnv('PRODUCTION_SUPABASE_SERVICE_ROLE_KEY', env);
  const subscription = assertActive(await listExactSubscription(target, serviceRoleKey));
  const expectedVersion = attestation.expectedSubscriptionVersion + 1;
  if (subscription.version !== expectedVersion) throw new Error('PRODUCTION_ADMISSION_ACTIVE_VERSION_MISMATCH');
  const expectedOwnerEmail = requiredEnv('PRODUCTION_ADMISSION_EXPECTED_OWNER_EMAIL', env).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(expectedOwnerEmail)) throw new Error('PRODUCTION_ADMISSION_EXPECTED_OWNER_EMAIL_INVALID');
  if (String(subscription.changedBy || '').toLowerCase() !== expectedOwnerEmail) {
    throw new Error('PRODUCTION_ADMISSION_OWNER_AUDIT_MISMATCH');
  }
  if (!String(subscription.changeReason || '').includes(attestation.approvalReference)) {
    throw new Error('PRODUCTION_ADMISSION_APPROVAL_REFERENCE_AUDIT_MISMATCH');
  }
  if (Date.parse(subscription.changedAt) < Date.parse(attestation.approvedAt)) {
    throw new Error('PRODUCTION_ADMISSION_ACTIVATION_PREDATES_APPROVAL');
  }
  const evidence = {
    schemaVersion: 1,
    evidenceType: 'production_real_patient_data_admission',
    verifiedAt: new Date().toISOString(),
    releaseCommit: source.commit,
    releaseTree: source.tree,
    productionOrigin: origin,
    netlifySiteId: netlify.siteId,
    netlifyDeployId: netlify.deployId,
    clinicId: target.clinicId,
    clinicCode: target.clinicCode,
    databaseProjectRef: target.projectRef,
    subscriptionState: subscription.state,
    subscriptionEnabled: subscription.enabled,
    subscriptionVersion: subscription.version,
    changedAt: subscription.changedAt,
    changedBy: subscription.changedBy,
    changeReason: subscription.changeReason,
    postDeployArtifact: attestation.postDeployArtifact,
    postDeployVerifiedAt: attestation.postDeployVerifiedAt,
    monitoringArtifact: attestation.monitoringArtifact,
    monitoringVerifiedAt: attestation.monitoringVerifiedAt,
    approvalReference: attestation.approvalReference,
    approvedAt: attestation.approvedAt,
    approvedBy: attestation.approvedBy,
    realPatientDataAdmission: 'active_and_verified'
  };
  const destination = await writeEvidence(requiredEnv('PRODUCTION_ADMISSION_EVIDENCE_PATH', env), evidence);
  process.stdout.write(`Production real-patient-data admission verified ACTIVE for ${target.clinicCode} at version ${subscription.version}; evidence: ${destination}\n`);
  return evidence;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  verifyProductionAdmissionActive().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

export { verifyProductionAdmissionActive };
