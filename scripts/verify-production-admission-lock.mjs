import process from 'node:process';
import {
  assertSuspended,
  currentSource,
  listExactSubscription,
  loadProductionTarget,
  requiredEnv,
  writeEvidence
} from './production-admission-support.mjs';

async function verifyAdmissionLock({ env = process.env } = {}) {
  if (env.CNYOS_PRODUCTION_ADMISSION_LOCK_ACK !== 'VERIFY_SUSPENDED_TENANT') {
    throw new Error('CNYOS_PRODUCTION_ADMISSION_LOCK_ACK_REQUIRED');
  }
  const source = currentSource({ env });
  const target = loadProductionTarget(env);
  const serviceRoleKey = requiredEnv('PRODUCTION_SUPABASE_SERVICE_ROLE_KEY', env);
  const subscription = assertSuspended(await listExactSubscription(target, serviceRoleKey));
  const evidence = {
    schemaVersion: 1,
    evidenceType: 'production_database_admission_lock',
    verifiedAt: new Date().toISOString(),
    releaseCommit: source.commit,
    releaseTree: source.tree,
    databaseProjectRef: target.projectRef,
    databaseOrigin: target.databaseOrigin,
    clinicId: target.clinicId,
    clinicCode: target.clinicCode,
    subscriptionState: subscription.state,
    subscriptionEnabled: subscription.enabled,
    subscriptionVersion: subscription.version,
    suspensionChangedAt: subscription.changedAt,
    suspensionChangedBy: subscription.changedBy,
    suspensionReason: subscription.changeReason
  };
  const file = requiredEnv('PRODUCTION_ADMISSION_LOCK_EVIDENCE_PATH', env);
  const destination = await writeEvidence(file, evidence);
  process.stdout.write(`Production admission lock verified for ${target.clinicCode}: suspended at version ${subscription.version}; evidence: ${destination}\n`);
  return evidence;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  verifyAdmissionLock().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

export { verifyAdmissionLock };
