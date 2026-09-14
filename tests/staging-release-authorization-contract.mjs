import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CNYOS_ACL_CANDIDATE_SHA256,
  CNYOS_STAGING_RELEASE_CONTROLLER,
  CNYOS_STAGING_RELEASE_TARGET,
  REQUIRED_SECURITY_REVIEW_AREAS,
  computeFunctionInputDigests,
  computeStaticArtifactDigests,
  parseStagingReleaseAttestation,
  validateStagingReleaseAttestation,
  validateStagingReleaseSignatures,
  verifyStagingReleaseAuthorization
} from '../scripts/verify-staging-release-authorization.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const commit = 'a'.repeat(40);
const tree = 'b'.repeat(40);
const evidenceHash = 'c'.repeat(64);
const workflowCommit = 'd'.repeat(40);
const staticArtifactSha256 = 'e'.repeat(64);
const runtimeManifestSha256 = 'f'.repeat(64);
const functionInputManifestSha256 = '1'.repeat(64);
const functionInputTreeSha256 = '2'.repeat(64);
const controllerRunId = '9876543210';
const rollbackBaselineDeployId = '0123456789abcdef01234567';
const controllerNonce = `cnyos-staging-v1.${Buffer.alloc(32, 0x5a).toString('base64url')}`;
const now = new Date('2026-09-08T02:00:00.000Z');

function validAttestation() {
  return {
    schemaVersion: 2,
    evidenceType: 'cnyos_staging_release_authorization',
    authorizedForStagingDeployment: true,
    productionAuthorization: false,
    realPatientDataAuthorized: false,
    signatureKeyIds: {
      independentSecurityReviewer: 'cnyos-staging-security-reviewer-ed25519-2026-09',
      managedPlatformRiskOwner: 'cnyos-staging-risk-owner-ed25519-2026-09'
    },
    controller: {
      ...CNYOS_STAGING_RELEASE_CONTROLLER,
      workflowCommit,
      runId: controllerRunId,
      runAttempt: 1,
      nonce: controllerNonce,
      issuedAt: '2026-09-08T01:45:00.000Z',
      expiresAt: '2026-09-08T02:10:00.000Z',
      rollbackBaselineDeployId,
      staticArtifactSha256,
      runtimeManifestSha256,
      functionInputManifestSha256,
      functionInputTreeSha256
    },
    source: { commit, tree },
    aclCandidateSha256: CNYOS_ACL_CANDIDATE_SHA256,
    target: { ...CNYOS_STAGING_RELEASE_TARGET },
    exactHeadCi: {
      status: 'passed',
      conclusion: 'success',
      workflowName: 'CI',
      runUrl: 'https://github.com/apisarit/chananya-clinical-wellness-os/actions/runs/123456789',
      sourceCommit: commit,
      sourceTree: tree,
      postgresMajor: 17,
      unresolvedBlockers: 0,
      completedAt: '2026-09-08T00:00:00.000Z',
      evidenceSha256: evidenceHash,
      evidenceReference: 'protected-ci-artifact:exact-head'
    },
    independentSecurityReview: {
      status: 'passed',
      verdict: 'approved',
      sourceCommit: commit,
      sourceTree: tree,
      candidateSha256: CNYOS_ACL_CANDIDATE_SHA256,
      reviewerName: 'Independent Security Reviewer',
      reviewerRole: 'Database security reviewer',
      reviewerGitHubLogin: 'security-reviewer',
      reviewedAt: '2026-09-08T00:00:00.000Z',
      evidenceSha256: evidenceHash,
      evidenceReference: 'protected-review-record:pr36-security',
      areas: REQUIRED_SECURITY_REVIEW_AREAS.map(id => ({
        id,
        verdict: 'passed',
        findingDisposition: 'Reviewed with no unresolved blocker'
      }))
    },
    managedPlatformException: {
      status: 'accepted',
      ownerName: 'Chananya Staging Risk Owner',
      ownerRole: 'System owner',
      ownerGitHubLogin: 'apisarit',
      projectRef: CNYOS_STAGING_RELEASE_TARGET.supabaseProjectRef,
      databaseSystemIdentifier: CNYOS_STAGING_RELEASE_TARGET.databaseSystemIdentifier,
      scope: 'supabase_admin function defaults for public only',
      currentPublicOwnership: {
        routines: 0,
        relations: 0,
        types: 0,
        evidenceSha256: evidenceHash,
        evidenceReference: 'protected-observer:managed-ownership-zero'
      },
      runtimeSetRole: {
        runtimeAndUntrustedCannotSetRoleToReviewedCreators: true,
        evidenceSha256: evidenceHash,
        evidenceReference: 'protected-observer:set-role-edges'
      },
      rationale: 'Accept the narrow managed-host default privilege exception for staging testing.',
      acceptedAt: '2026-09-08T00:30:00.000Z',
      nextReviewAt: '2026-09-15T00:30:00.000Z',
      expiresAt: '2026-10-08T00:30:00.000Z',
      driftCheckOwner: 'Security operations',
      providerEscalationReference: 'SUPABASE-SUPPORT-REFERENCE-2026-09',
      blockOnAnyReviewedDrift: true
    },
    rollbackRehearsal: {
      status: 'passed',
      sourceCommit: commit,
      completedAt: '2026-09-08T01:30:00.000Z',
      maintenanceWindowStatus: 'completed',
      maintenanceWindowReference: 'chananya-staging-window-2026-09-08',
      quiescenceVerified: true,
      quiescenceEvidenceSha256: evidenceHash,
      quiescenceEvidenceReference: 'protected-rehearsal:quiescence',
      normalRollback: {
        status: 'passed',
        receipt: 'ACL_CATALOG_ROLLBACK_VERIFIED',
        evidenceSha256: evidenceHash,
        evidenceReference: 'protected-rehearsal:normal-rollback'
      },
      injectedFailure: {
        status: 'passed',
        exitWasNonzero: true,
        postStateEqual: true,
        evidenceSha256: evidenceHash,
        evidenceReference: 'protected-rehearsal:injected-failure'
      },
      freshPostObserver: {
        status: 'passed',
        observedAt: '2026-09-08T01:35:00.000Z',
        datasetCount: 25,
        publicRoutineCount: 147,
        securityDefinerCount: 141,
        triggerCount: 173,
        eventTriggerCount: 7,
        evidenceSha256: evidenceHash,
        evidenceReference: 'protected-observer:fresh-post-rehearsal'
      }
    },
    migrationPromotion: {
      status: 'passed',
      promotionPullRequest: 'https://github.com/apisarit/chananya-clinical-wellness-os/pull/39',
      pr36RemainsDraftAndUnapproved: true,
      releaseCandidateCommit: commit,
      orderedMigrationChainAppliedToChananyaStaging: true,
      migrationApplyEvidenceSha256: evidenceHash,
      migrationApplyEvidenceReference: 'protected-migration:chananya-apply',
      preDeploymentAuthenticatedRegressionStatus: 'passed',
      preDeploymentAuthenticatedRegressionEvidenceSha256: evidenceHash,
      preDeploymentAuthenticatedRegressionEvidenceReference: 'protected-regression:pre-deploy',
      chananyaLedger: {
        status: 'reconciled',
        evidenceSha256: evidenceHash,
        evidenceReference: 'protected-ledger:chananya'
      },
      jitarsaLedger: {
        status: 'independently_reconciled',
        evidenceSha256: evidenceHash,
        evidenceReference: 'protected-ledger:jitarsa'
      }
    },
    strictPostRemediation: {
      status: 'passed',
      sourceCommit: commit,
      sourceTree: tree,
      projectRef: CNYOS_STAGING_RELEASE_TARGET.supabaseProjectRef,
      databaseSystemIdentifier: CNYOS_STAGING_RELEASE_TARGET.databaseSystemIdentifier,
      durableAclRemediationApplied: true,
      verifiedAt: '2026-09-08T01:40:00.000Z',
      unresolvedBlockers: 0,
      verificationSql: {
        status: 'passed',
        readOnlyEnforced: true,
        evidenceSha256: evidenceHash,
        evidenceReference: 'protected-post-remediation:verification-sql'
      },
      securityAdvisor: {
        status: 'passed',
        unresolvedErrors: 0,
        evidenceSha256: evidenceHash,
        evidenceReference: 'protected-post-remediation:security-advisor'
      },
      negativeBrowserRpcChecks: {
        status: 'passed',
        evidenceSha256: evidenceHash,
        evidenceReference: 'protected-post-remediation:negative-rpc'
      },
      crossTenantChecks: {
        status: 'passed',
        evidenceSha256: evidenceHash,
        evidenceReference: 'protected-post-remediation:cross-tenant'
      }
    },
    authorization: {
      decision: 'authorize_cnyos_staging_deployment',
      reference: 'cnyos-staging-release-authorization-2026-09-08',
      authorizedByName: 'Chananya Staging Risk Owner',
      authorizedByRole: 'System owner',
      authorizedByGitHubLogin: 'apisarit',
      authorizedAt: '2026-09-08T01:45:00.000Z',
      expiresAt: '2026-09-08T02:10:00.000Z'
    }
  };
}

function fakeGit(status = '') {
  return args => {
    const command = args.join(' ');
    if (command === 'rev-parse HEAD') return commit;
    if (command === 'rev-parse HEAD^{tree}') return tree;
    if (command === 'status --porcelain=v1 --untracked-files=all') return status;
    throw new Error(`UNEXPECTED_GIT_${command}`);
  };
}

const repositoryFunctionInputs = computeFunctionInputDigests(root);
assert.match(repositoryFunctionInputs.functionInputManifestSha256, /^[0-9a-f]{64}$/);
assert.match(repositoryFunctionInputs.functionInputTreeSha256, /^[0-9a-f]{64}$/);

const staticFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cnyos-static-digest-'));
try {
  const dist = path.join(staticFixtureRoot, 'dist');
  fs.mkdirSync(dist);
  const appBytes = Buffer.from('console.log("bound");\n');
  fs.writeFileSync(path.join(dist, 'app.js'), appBytes);
  const runtimeManifest = {
    schemaVersion: 2,
    generatedAt: '2026-09-08T01:00:00.000Z',
    fileCount: 1,
    files: ['app.js'],
    integrityAlgorithm: 'sha256',
    integrity: [{
      path: 'app.js',
      size: appBytes.byteLength,
      sha256: createHash('sha256').update(appBytes).digest('hex')
    }]
  };
  fs.writeFileSync(
    path.join(dist, 'runtime-publish-manifest.json'),
    `${JSON.stringify(runtimeManifest, null, 2)}\n`
  );
  const computed = computeStaticArtifactDigests(staticFixtureRoot);
  assert.match(computed.staticArtifactSha256, /^[0-9a-f]{64}$/);
  assert.match(computed.runtimeManifestSha256, /^[0-9a-f]{64}$/);
  fs.appendFileSync(path.join(dist, 'app.js'), 'tamper');
  assert.throws(
    () => computeStaticArtifactDigests(staticFixtureRoot),
    /RUNTIME_MANIFEST_INVALID/
  );
} finally {
  fs.rmSync(staticFixtureRoot, { recursive: true, force: true });
}

const valid = validAttestation();
assert.deepEqual(parseStagingReleaseAttestation(JSON.stringify(valid)), valid);
assert.throws(() => parseStagingReleaseAttestation(''), /ATTESTATION_JSON_REQUIRED/);
assert.throws(() => parseStagingReleaseAttestation('{broken'), /ATTESTATION_JSON_INVALID/);
assert.equal(validateStagingReleaseAttestation(valid, commit, tree, { now }), true);
const reviewerKeys = generateKeyPairSync('ed25519');
const riskOwnerKeys = generateKeyPairSync('ed25519');
const unusedReviewerKeys = generateKeyPairSync('ed25519');
const rawValid = JSON.stringify(valid);
const reviewerSignature = sign(null, Buffer.from(rawValid), reviewerKeys.privateKey).toString('base64');
const riskOwnerSignature = sign(null, Buffer.from(rawValid), riskOwnerKeys.privateKey).toString('base64');
const keyRecord = (id, role, githubAccount, ownerName, publicKey) => ({
  id,
  role,
  githubLogin: githubAccount,
  ownerName,
  publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
  spkiSha256: createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex')
});
const approverRegistry = {
  schemaVersion: 1,
  environment: 'cnyos-staging',
  keys: [
    keyRecord(
      valid.signatureKeyIds.independentSecurityReviewer,
      'independent_security_reviewer',
      valid.independentSecurityReview.reviewerGitHubLogin,
      valid.independentSecurityReview.reviewerName,
      reviewerKeys.publicKey
    ),
    keyRecord(
      valid.signatureKeyIds.managedPlatformRiskOwner,
      'managed_platform_risk_owner',
      valid.managedPlatformException.ownerGitHubLogin,
      valid.managedPlatformException.ownerName,
      riskOwnerKeys.publicKey
    )
  ]
};
assert.deepEqual(
  validateStagingReleaseSignatures(rawValid, valid, {
    independentSecurityReviewer: reviewerSignature,
    managedPlatformRiskOwner: riskOwnerSignature
  }, approverRegistry).reviewerKeyId,
  valid.signatureKeyIds.independentSecurityReviewer
);
const privatePemRegistry = {
  ...approverRegistry,
  keys: approverRegistry.keys.map((record, index) => index === 0 ? {
    ...record,
    publicKeyPem: reviewerKeys.privateKey.export({ type: 'pkcs8', format: 'pem' })
  } : record)
};
assert.throws(
  () => validateStagingReleaseSignatures(rawValid, valid, {
    independentSecurityReviewer: reviewerSignature,
    managedPlatformRiskOwner: riskOwnerSignature
  }, privatePemRegistry),
  /APPROVER_REGISTRY_INVALID/
);
const unusedPrivatePemRegistry = {
  ...approverRegistry,
  keys: [
    ...approverRegistry.keys,
    {
      ...keyRecord(
        'unused-reviewer-key',
        'independent_security_reviewer',
        'unused-reviewer',
        'Unused security reviewer',
        unusedReviewerKeys.publicKey
      ),
      publicKeyPem: unusedReviewerKeys.privateKey.export({ type: 'pkcs8', format: 'pem' })
    }
  ]
};
assert.throws(
  () => validateStagingReleaseSignatures(rawValid, valid, {
    independentSecurityReviewer: reviewerSignature,
    managedPlatformRiskOwner: riskOwnerSignature
  }, unusedPrivatePemRegistry),
  /APPROVER_REGISTRY_INVALID/
);
const unusedDuplicateFingerprintRegistry = {
  ...approverRegistry,
  keys: [
    ...approverRegistry.keys,
    keyRecord(
      'unused-duplicate-reviewer-key',
      'independent_security_reviewer',
      'unused-duplicate-reviewer',
      'Unused duplicate security reviewer',
      reviewerKeys.publicKey
    )
  ]
};
assert.throws(
  () => validateStagingReleaseSignatures(rawValid, valid, {
    independentSecurityReviewer: reviewerSignature,
    managedPlatformRiskOwner: riskOwnerSignature
  }, unusedDuplicateFingerprintRegistry),
  /APPROVER_REGISTRY_INVALID/
);
assert.throws(
  () => validateStagingReleaseSignatures(rawValid, valid, {
    independentSecurityReviewer: reviewerSignature,
    managedPlatformRiskOwner: riskOwnerSignature
  }, { ...approverRegistry, unexpected: 'not-allowed' }),
  /APPROVER_REGISTRY_INVALID/
);
assert.throws(
  () => validateStagingReleaseSignatures(rawValid, valid, {
    independentSecurityReviewer: reviewerSignature,
    managedPlatformRiskOwner: riskOwnerSignature
  }, {
    ...approverRegistry,
    keys: approverRegistry.keys.map((record, index) => index === 0
      ? { ...record, unexpected: 'not-allowed' }
      : record)
  }),
  /APPROVER_REGISTRY_INVALID/
);
assert.throws(
  () => validateStagingReleaseSignatures(`${rawValid} `, valid, {
    independentSecurityReviewer: reviewerSignature,
    managedPlatformRiskOwner: riskOwnerSignature
  }, approverRegistry),
  /SIGNATURE_INVALID/
);
const controllerTamper = {
  ...valid,
  controller: { ...valid.controller, runId: '9876543211' }
};
assert.throws(
  () => validateStagingReleaseSignatures(JSON.stringify(controllerTamper), controllerTamper, {
    independentSecurityReviewer: reviewerSignature,
    managedPlatformRiskOwner: riskOwnerSignature
  }, approverRegistry),
  /SIGNATURE_INVALID/
);
assert.throws(
  () => validateStagingReleaseSignatures(rawValid, valid, {
    independentSecurityReviewer: reviewerSignature,
    managedPlatformRiskOwner: riskOwnerSignature
  }, { ...approverRegistry, keys: [] }),
  /KEY_NOT_PINNED/
);

const rejects = (transform, pattern) => {
  const candidate = transform(validAttestation());
  assert.throws(
    () => validateStagingReleaseAttestation(candidate, commit, tree, { now }),
    pattern
  );
};

rejects(value => ({ ...value, authorizedForStagingDeployment: false }), /ATTESTATION_INVALID/);
rejects(value => ({ ...value, schemaVersion: 1 }), /ATTESTATION_INVALID/);
rejects(value => ({ ...value, productionAuthorization: true }), /ATTESTATION_INVALID/);
rejects(value => ({
  ...value,
  controller: { ...value.controller, repository: 'attacker/repository' }
}), /CONTROLLER_INVALID/);
rejects(value => ({
  ...value,
  controller: { ...value.controller, workflowCommit: '0'.repeat(39) }
}), /CONTROLLER_INVALID/);
rejects(value => ({
  ...value,
  controller: { ...value.controller, runAttempt: 2 }
}), /CONTROLLER_INVALID/);
rejects(value => ({
  ...value,
  controller: { ...value.controller, nonce: 'cnyos-staging-v1.not-random' }
}), /CONTROLLER_NONCE_INVALID/);
rejects(value => ({
  ...value,
  controller: {
    ...value.controller,
    nonce: `cnyos-staging-v1.${Buffer.alloc(32).toString('base64url')}`
  }
}), /CONTROLLER_NONCE_INVALID/);
rejects(value => ({
  ...value,
  controller: { ...value.controller, issuedAt: '2026-09-08T01:45:00Z' },
  authorization: { ...value.authorization, authorizedAt: '2026-09-08T01:45:00Z' }
}), /CONTROLLER_DATE_INVALID/);
rejects(value => ({
  ...value,
  controller: {
    ...value.controller,
    issuedAt: '2026-09-08T01:00:00.000Z',
    expiresAt: '2026-09-08T02:10:00.000Z'
  },
  authorization: {
    ...value.authorization,
    authorizedAt: '2026-09-08T01:00:00.000Z',
    expiresAt: '2026-09-08T02:10:00.000Z'
  }
}), /CONTROLLER_EXPIRED/);
rejects(value => ({
  ...value,
  controller: { ...value.controller, expiresAt: '2026-09-08T01:59:59.000Z' },
  authorization: { ...value.authorization, expiresAt: '2026-09-08T01:59:59.000Z' }
}), /CONTROLLER_EXPIRED/);
rejects(value => ({
  ...value,
  controller: { ...value.controller, issuedAt: '2026-09-08T02:00:01.000Z' },
  authorization: { ...value.authorization, authorizedAt: '2026-09-08T02:00:01.000Z' }
}), /CONTROLLER_EXPIRED/);
rejects(value => ({
  ...value,
  authorization: { ...value.authorization, authorizedAt: '2026-09-08T01:46:00.000Z' }
}), /AUTHORIZATION_EXPIRED/);
rejects(value => ({
  ...value,
  controller: { ...value.controller, staticArtifactSha256: '0'.repeat(63) }
}), /CONTROLLER_INVALID/);
rejects(value => ({
  ...value,
  controller: { ...value.controller, rollbackBaselineDeployId: '0'.repeat(23) }
}), /CONTROLLER_INVALID/);
rejects(value => ({ ...value, source: { ...value.source, commit: 'd'.repeat(40) } }), /SOURCE_MISMATCH/);
rejects(value => ({
  ...value,
  exactHeadCi: { ...value.exactHeadCi, conclusion: 'failure' }
}), /EXACT_HEAD_CI_INVALID/);
rejects(value => ({
  ...value,
  independentSecurityReview: {
    ...value.independentSecurityReview,
    areas: value.independentSecurityReview.areas.slice(1)
  }
}), /REVIEW_AREAS_INCOMPLETE/);
rejects(value => ({
  ...value,
  independentSecurityReview: {
    ...value.independentSecurityReview,
    reviewerGitHubLogin: value.managedPlatformException.ownerGitHubLogin
  }
}), /REVIEWER_CONFLICT/);
rejects(value => ({
  ...value,
  independentSecurityReview: {
    ...value.independentSecurityReview,
    reviewerGitHubLogin: value.managedPlatformException.ownerGitHubLogin.toUpperCase()
  }
}), /REVIEWER_CONFLICT/);
rejects(value => ({
  ...value,
  managedPlatformException: {
    ...value.managedPlatformException,
    currentPublicOwnership: {
      ...value.managedPlatformException.currentPublicOwnership,
      routines: 1
    }
  }
}), /OWNERSHIP_NOT_ZERO/);
rejects(value => ({
  ...value,
  managedPlatformException: {
    ...value.managedPlatformException,
    runtimeSetRole: {
      ...value.managedPlatformException.runtimeSetRole,
      runtimeAndUntrustedCannotSetRoleToReviewedCreators: false
    }
  }
}), /SET_ROLE_NOT_PROVED/);
rejects(value => ({
  ...value,
  managedPlatformException: {
    ...value.managedPlatformException,
    expiresAt: '2026-09-08T01:30:00.000Z'
  }
}), /EXCEPTION_EXPIRED/);
rejects(value => ({
  ...value,
  rollbackRehearsal: {
    ...value.rollbackRehearsal,
    injectedFailure: { ...value.rollbackRehearsal.injectedFailure, postStateEqual: false }
  }
}), /ROLLBACK_REHEARSAL_INVALID/);
rejects(value => ({
  ...value,
  rollbackRehearsal: {
    ...value.rollbackRehearsal,
    completedAt: '2026-09-08T01:29:59.000Z'
  }
}), /ROLLBACK_REHEARSAL_STALE/);
rejects(value => ({
  ...value,
  rollbackRehearsal: {
    ...value.rollbackRehearsal,
    freshPostObserver: {
      ...value.rollbackRehearsal.freshPostObserver,
      observedAt: 'not-a-date'
    }
  }
}), /ROLLBACK_REHEARSAL_STALE/);
rejects(value => ({
  ...value,
  migrationPromotion: { ...value.migrationPromotion, promotionPullRequest: 'https://github.com/apisarit/chananya-clinical-wellness-os/pull/36' }
}), /MIGRATION_PROMOTION_INVALID/);
rejects(value => ({
  ...value,
  strictPostRemediation: {
    ...value.strictPostRemediation,
    negativeBrowserRpcChecks: {
      ...value.strictPostRemediation.negativeBrowserRpcChecks,
      status: 'failed'
    }
  }
}), /STRICT_POST_REMEDIATION_INVALID/);
rejects(value => ({
  ...value,
  strictPostRemediation: {
    ...value.strictPostRemediation,
    verifiedAt: '2026-09-08T01:29:59.000Z'
  }
}), /STRICT_POST_REMEDIATION_INVALID/);
rejects(value => ({
  ...value,
  independentSecurityReview: {
    ...value.independentSecurityReview,
    reviewedAt: '2026-09-09T00:00:00.000Z'
  }
}), /INDEPENDENT_SECURITY_REVIEW_INVALID/);
rejects(value => ({
  ...value,
  managedPlatformException: {
    ...value.managedPlatformException,
    nextReviewAt: '2026-09-08T01:00:00.000Z'
  }
}), /EXCEPTION_EXPIRED/);
rejects(value => ({
  ...value,
  authorization: {
    ...value.authorization,
    authorizedAt: '2026-09-09T00:00:00.000Z'
  }
}), /AUTHORIZATION_EXPIRED/);
rejects(value => ({
  ...value,
  migrationPromotion: { ...value.migrationPromotion, jitarsaLedger: { status: 'reconciled', evidenceSha256: evidenceHash } }
}), /MIGRATION_PROMOTION_INVALID/);

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cnyos-staging-release-authorization-'));
try {
  const evidencePath = path.join(cwd, 'authorization.json');
  const env = {
    EXPECTED_STAGING_SOURCE_COMMIT: commit,
    CLINICAL_OS_SOURCE_TREE: tree,
    GITHUB_SHA: workflowCommit,
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_RUN_ID: controllerRunId,
    GITHUB_REPOSITORY: CNYOS_STAGING_RELEASE_CONTROLLER.repository,
    GITHUB_EVENT_NAME: CNYOS_STAGING_RELEASE_CONTROLLER.eventName,
    GITHUB_WORKFLOW_REF:
      `${CNYOS_STAGING_RELEASE_CONTROLLER.repository}/` +
      `${CNYOS_STAGING_RELEASE_CONTROLLER.workflowPath}@` +
      CNYOS_STAGING_RELEASE_CONTROLLER.workflowRef,
    GITHUB_REF: CNYOS_STAGING_RELEASE_CONTROLLER.workflowRef,
    GITHUB_REF_TYPE: 'branch',
    GITHUB_REF_PROTECTED: 'true',
    GITHUB_WORKFLOW_SHA: workflowCommit,
    GITHUB_ACTOR: 'apisarit',
    GITHUB_TRIGGERING_ACTOR: 'apisarit',
    CNYOS_STAGING_RELEASE_ATTESTATION_JSON: rawValid,
    CNYOS_STAGING_SECURITY_REVIEW_SIGNATURE_BASE64: reviewerSignature,
    CNYOS_STAGING_RISK_OWNER_SIGNATURE_BASE64: riskOwnerSignature,
    CNYOS_STAGING_RELEASE_APPROVER_KEY_REGISTRY_JSON: JSON.stringify(approverRegistry),
    STAGING_RELEASE_AUTHORIZATION_EVIDENCE_PATH: evidencePath
  };
  const verifierDependencies = {
    cwd,
    gitImpl: fakeGit(),
    candidateBytesImpl: () => fs.readFileSync(path.join(
      root,
      'supabase/manual/202609080900_close_complete_public_routine_acl_candidate.sql'
    )),
    staticArtifactDigestsImpl: () => ({ staticArtifactSha256, runtimeManifestSha256 }),
    functionInputDigestsImpl: () => ({
      functionInputManifestSha256,
      functionInputTreeSha256
    }),
    now: () => now
  };
  const result = verifyStagingReleaseAuthorization({
    env,
    ...verifierDependencies
  });
  assert.equal(result.evidence.schemaVersion, 2);
  assert.equal(result.evidence.status, 'authorized');
  assert.equal(result.evidence.productionAuthorization, false);
  assert.equal(result.evidence.sourceCommit, commit);
  assert.equal(result.evidence.target.netlifySiteId, CNYOS_STAGING_RELEASE_TARGET.netlifySiteId);
  assert.equal(result.evidence.controllerWorkflowCommit, workflowCommit);
  assert.equal(result.evidence.controllerWorkflowRef, 'refs/heads/main');
  assert.equal(result.evidence.controllerRunId, controllerRunId);
  assert.equal(result.evidence.controllerRunAttempt, 1);
  assert.equal(result.evidence.rollbackBaselineDeployId, rollbackBaselineDeployId);
  assert.equal(result.evidence.staticArtifactSha256, staticArtifactSha256);
  assert.equal(result.evidence.runtimeManifestSha256, runtimeManifestSha256);
  assert.equal(result.evidence.functionInputManifestSha256, functionInputManifestSha256);
  assert.equal(result.evidence.functionInputTreeSha256, functionInputTreeSha256);
  assert.equal(result.evidence.namedRiskOwnerGitHubLogin, 'apisarit');
  assert.equal(result.evidence.independentReviewerGitHubLogin, 'security-reviewer');
  assert.match(result.evidence.attestationSha256, /^[0-9a-f]{64}$/);
  assert.match(result.evidence.controllerNonceSha256, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(evidencePath).mode & 0o777, 0o600);
  const serialized = fs.readFileSync(evidencePath, 'utf8');
  assert.doesNotMatch(serialized, /Accept the narrow managed-host/);
  assert.doesNotMatch(serialized, /SUPABASE-SUPPORT-REFERENCE/);
  assert.doesNotMatch(serialized, /Chananya Staging Risk Owner/);
  assert.doesNotMatch(serialized, /Independent Security Reviewer/);
  assert.doesNotMatch(serialized, /Database security reviewer/);
  assert.doesNotMatch(serialized, /protected-(?:review|observer|rehearsal|migration|regression)/);
  assert.doesNotMatch(serialized, new RegExp(controllerNonce.replaceAll('.', '\\.')));
  assert.doesNotMatch(serialized, new RegExp(reviewerSignature.slice(0, 24)));
  assert.doesNotMatch(serialized, /BEGIN PUBLIC KEY/);
  assert.equal(result.evidence.authorizationReference, undefined);
  assert.equal(result.evidence.namedRiskOwner, undefined);
  assert.equal(result.evidence.namedRiskOwnerRole, undefined);
  assert.equal(result.evidence.independentReviewer, undefined);
  assert.equal(result.evidence.exactHeadCiRunUrl, undefined);
  assert.equal(result.evidence.promotionPullRequest, undefined);
  assert.equal(result.evidence.target.netlifyOrigin, CNYOS_STAGING_RELEASE_TARGET.netlifyOrigin);
  assert.equal(result.evidence.target.clinicCode, CNYOS_STAGING_RELEASE_TARGET.clinicCode);

  assert.throws(() => verifyStagingReleaseAuthorization({
    env: { ...env, GITHUB_RUN_ATTEMPT: '2' },
    ...verifierDependencies
  }), /REPLAY_NOT_ALLOWED/);
  assert.throws(() => verifyStagingReleaseAuthorization({
    env: { ...env, GITHUB_RUN_ID: '9876543211' },
    ...verifierDependencies
  }), /CONTROLLER_MISMATCH/);
  assert.throws(() => verifyStagingReleaseAuthorization({
    env: { ...env, GITHUB_WORKFLOW_SHA: '9'.repeat(40) },
    ...verifierDependencies
  }), /CONTROLLER_MISMATCH/);
  assert.throws(() => verifyStagingReleaseAuthorization({
    env: { ...env, GITHUB_SHA: '9'.repeat(40) },
    ...verifierDependencies
  }), /CONTROLLER_MISMATCH/);
  assert.throws(() => verifyStagingReleaseAuthorization({
    env: { ...env, GITHUB_REPOSITORY: 'attacker/repository' },
    ...verifierDependencies
  }), /CONTROLLER_MISMATCH/);
  assert.throws(() => verifyStagingReleaseAuthorization({
    env: { ...env, GITHUB_REF_PROTECTED: 'false' },
    ...verifierDependencies
  }), /CONTROLLER_MISMATCH/);
  assert.throws(() => verifyStagingReleaseAuthorization({
    env: { ...env, GITHUB_TRIGGERING_ACTOR: 'other-operator' },
    ...verifierDependencies
  }), /REPLAY_NOT_ALLOWED/);
  assert.throws(() => verifyStagingReleaseAuthorization({
    env: { ...env, GITHUB_ACTOR: 'other-operator', GITHUB_TRIGGERING_ACTOR: 'other-operator' },
    ...verifierDependencies
  }), /ACTOR_NOT_NAMED_RISK_OWNER/);
  assert.throws(() => verifyStagingReleaseAuthorization({
    env,
    ...verifierDependencies,
    staticArtifactDigestsImpl: () => ({
      staticArtifactSha256: '9'.repeat(64),
      runtimeManifestSha256
    })
  }), /STATIC_ARTIFACT_DIGEST_MISMATCH/);
  assert.throws(() => verifyStagingReleaseAuthorization({
    env,
    ...verifierDependencies,
    functionInputDigestsImpl: () => ({
      functionInputManifestSha256,
      functionInputTreeSha256: '9'.repeat(64)
    })
  }), /FUNCTION_INPUT_DIGEST_MISMATCH/);
  assert.throws(() => verifyStagingReleaseAuthorization({
    env: { ...env, CNYOS_STAGING_RELEASE_APPROVER_KEY_REGISTRY_JSON: '' },
    ...verifierDependencies
  }), /APPROVER_REGISTRY_INVALID/);
  assert.throws(() => verifyStagingReleaseAuthorization({
    env,
    ...verifierDependencies,
    gitImpl: fakeGit(' M app.js'),
  }), /CHECKOUT_NOT_CLEAN/);
} finally {
  fs.rmSync(cwd, { recursive: true, force: true });
}

console.log('CNYOS staging release authorization contracts passed: protected exact-source review, exception, rollback, ledgers and promotion evidence');
