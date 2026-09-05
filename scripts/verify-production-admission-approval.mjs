import process from 'node:process';
import {
  assertSuspended,
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

async function verifyProductionAdmissionApproval({ env = process.env } = {}) {
  if (env.CNYOS_PRODUCTION_ADMISSION_APPROVAL_ACK !== 'VERIFY_REAL_DATA_ADMISSION_APPROVAL') {
    throw new Error('CNYOS_PRODUCTION_ADMISSION_APPROVAL_ACK_REQUIRED');
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
  const subscription = assertSuspended(await listExactSubscription(target, serviceRoleKey));
  if (subscription.version !== attestation.expectedSubscriptionVersion) {
    throw new Error('PRODUCTION_ADMISSION_SUBSCRIPTION_VERSION_MISMATCH');
  }
  const evidence = {
    schemaVersion: 1,
    evidenceType: 'production_real_patient_data_admission_approval',
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
    subscriptionVersion: subscription.version,
    postDeployArtifact: attestation.postDeployArtifact,
    postDeployVerifiedAt: attestation.postDeployVerifiedAt,
    monitoringArtifact: attestation.monitoringArtifact,
    monitoringVerifiedAt: attestation.monitoringVerifiedAt,
    approvalReference: attestation.approvalReference,
    approvedAt: attestation.approvedAt,
    approvedBy: attestation.approvedBy,
    requiredRuntimeUnlock: {
      CNYOS_REAL_DATA_ADMISSION_ENABLED: 'true',
      CNYOS_REAL_DATA_ADMISSION_RELEASE_COMMIT: source.commit,
      CNYOS_REAL_DATA_ADMISSION_APPROVAL_REFERENCE: attestation.approvalReference
    },
    nextAction: 'Apply the exact runtime unlock to the intended production Netlify site, then use Owner Control to enable this tenant with the same approval reference in the audited reason. Run final admission verification immediately afterwards.'
  };
  const destination = await writeEvidence(requiredEnv('PRODUCTION_ADMISSION_APPROVAL_EVIDENCE_PATH', env), evidence);
  process.stdout.write(`Production admission approval verified for ${target.clinicCode}; tenant remains suspended at version ${subscription.version}; evidence: ${destination}\n`);
  return evidence;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  verifyProductionAdmissionApproval().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

export { verifyProductionAdmissionApproval };
