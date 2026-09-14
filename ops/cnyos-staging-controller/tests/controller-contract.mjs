import assert from 'node:assert/strict';
import { createPublicKey } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXPECTED_FUNCTION_NAMES,
  FUNCTIONS_REQUIRING_NO_SCHEDULE_OR_CUSTOM_ROUTE,
  POLICY,
  REQUIRED_SCHEDULES,
  assertControllerRuntime,
  canonicalIsoTimestamp,
  exactSha256,
  minimumFutureTimestamp,
  portableRelativePath,
  readFileBounded,
  readRegularFileStable,
  recentCanonicalTimestamp,
  safeOrigin,
  sha256,
  walkRegularFiles
} from '../scripts/policy.mjs';
import {
  assertFunctionMetadata,
  parseDeployReceipt,
  strictDraftAccessToken,
  verifyDraftStaticFiles
} from '../scripts/netlify-evidence.mjs';
import {
  assertDistinctOpaquePrincipalSubjects,
  sameGitHubLogin
} from '../scripts/verify-authorization.mjs';
import {
  ACTIVATION_PAIRS,
  ACTIVATION_TESTS,
  CLOSED_WORLD_SCRIPT_INVENTORY,
  CLOSED_WORLD_TEST_INVENTORY,
  REQUIRED_ACTIVATION_PREREQUISITES
} from '../scripts/run-activation-contracts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFile(path.join(root, relative), 'utf8');

const [release, watchdog, authorization, producer, netlify, finalizer, rollbackAttestation,
  readme, lockRaw, packageRaw, activationRunner] =
  await Promise.all([
    read('workflow/cnyos-staging-controller.template.yml'),
    read('workflow/cnyos-staging-rollback-watchdog.template.yml'),
    read('scripts/verify-authorization.mjs'),
    read('scripts/create-producer-bundle.mjs'),
    read('scripts/netlify-evidence.mjs'),
    read('scripts/finalize-evidence.mjs'),
    read('scripts/verify-rollback-attestation-deposit.mjs'),
    read('README.md'),
    read('package-lock.json'),
    read('package.json'),
    read('scripts/run-activation-contracts.mjs')
  ]);

assert.equal(POLICY.controller.repository, 'apisarit/cnyos-staging-deployment-control');
assert.equal(POLICY.controller.protectedRef, 'refs/heads/main');
assert.equal(POLICY.controller.releaseWorkflowPath, '.github/workflows/cnyos-staging-release.yml');
assert.equal(POLICY.controller.rollbackWorkflowPath,
  '.github/workflows/cnyos-staging-rollback-watchdog.yml');
assert.equal(POLICY.target.netlifySiteId, '7da5e39e-580d-44f1-8623-605313e2fb2b');
assert.equal(POLICY.target.supabaseProjectRef, 'hsmnjwxurlmsizndjlun');
assert.equal(POLICY.productionAuthorization, false);
assert.equal(POLICY.realPatientDataAuthorized, false);
assert.equal(Object.isFrozen(POLICY), true);
assert.equal(Object.isFrozen(POLICY.target), true);
assert.equal(Object.isFrozen(POLICY.externalReconciliationBroker), true);
assert.equal(Object.isFrozen(POLICY.draftLifecycleBroker), true);
assert.equal(Object.isFrozen(POLICY.rollbackPrincipalMembershipBroker), true);
assert.equal(Object.isFrozen(POLICY.rollbackAttestationBroker), true);
assert.equal(POLICY.rollbackAttestationBroker.maximumReceiptAgeMinutes, 10);
assert.equal(POLICY.rollbackAttestationBroker.minimumRetentionDays, 365);
assert.equal(POLICY.databaseEvidence.maximumAgeMinutes, 30);
const inventoryBaseline = POLICY.databaseEvidence.inventoryBaseline;
assert.equal(inventoryBaseline.schemaVersion, 1);
assert.equal(inventoryBaseline.observerSchemaVersion, 2);
assert.equal(inventoryBaseline.supabaseProjectRef, POLICY.target.supabaseProjectRef);
assert.equal(inventoryBaseline.databaseSystemIdentifier, POLICY.target.databaseSystemIdentifier);
assert.equal(inventoryBaseline.sha256, sha256(JSON.stringify({
  schemaVersion: inventoryBaseline.schemaVersion,
  baselineId: inventoryBaseline.baselineId,
  observerSchemaVersion: inventoryBaseline.observerSchemaVersion,
  supabaseProjectRef: inventoryBaseline.supabaseProjectRef,
  databaseSystemIdentifier: inventoryBaseline.databaseSystemIdentifier,
  counts: inventoryBaseline.counts
})));
if (/^__/.test(POLICY.externalReconciliationBroker.policySha256)) {
  assert.throws(
    () => exactSha256(POLICY.externalReconciliationBroker.policySha256,
      'CNYOS_CONTROLLER_RECONCILIATION_BROKER_POLICY_INVALID'),
    /CNYOS_CONTROLLER_RECONCILIATION_BROKER_POLICY_INVALID/
  );
} else {
  assert.equal(exactSha256(POLICY.externalReconciliationBroker.policySha256,
    'CNYOS_CONTROLLER_RECONCILIATION_BROKER_POLICY_INVALID'),
  POLICY.externalReconciliationBroker.policySha256);
}

const trustPlaceholder = value => /^__[A-Z0-9_]+__$/.test(String(value || ''));
function assertPinnedBrokerTrustBoundary(name, value, operationDomain) {
  const exactKeys = [
    'maximumEvidenceAgeMinutes', 'maximumResponseBytes', 'oidcAudience',
    'operationDomain', 'operationPath', 'origin', 'policyId', 'policySha256',
    'signingKeyId', 'signingKeySpkiSha256', 'signingPublicKeyPem'
  ];
  assert.deepEqual(Object.keys(value).sort(), exactKeys, `${name} closed schema`);
  assert.equal(Object.isFrozen(value), true, `${name} frozen`);
  assert.equal(value.operationDomain, operationDomain, `${name} operation domain`);
  assert.equal(value.maximumEvidenceAgeMinutes, 10, `${name} maximum evidence age`);
  assert.equal(value.maximumResponseBytes, 65536, `${name} maximum response bytes`);

  const pinnedFields = [
    'origin', 'operationPath', 'policyId', 'policySha256', 'signingKeyId',
    'signingPublicKeyPem', 'signingKeySpkiSha256', 'oidcAudience'
  ];
  const placeholderStates = pinnedFields.map(field => trustPlaceholder(value[field]));
  assert.ok(placeholderStates.every(state => state === placeholderStates[0]),
    `${name} must be wholly bootstrap or wholly activated`);
  if (placeholderStates[0]) return;

  assert.equal(safeOrigin(value.origin, `${name}:origin`), value.origin, `${name} exact origin`);
  assert.match(value.operationPath, /^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]+$/,
    `${name} operation path`);
  assert.doesNotMatch(value.operationPath, /(?:^|\/)\.{1,2}(?:\/|$)|\/\//,
    `${name} canonical operation path`);
  const operationUrl = new URL(value.operationPath, value.origin);
  assert.equal(operationUrl.origin, value.origin, `${name} path origin`);
  assert.equal(operationUrl.pathname, value.operationPath, `${name} exact operation path`);
  assert.equal(operationUrl.search, '', `${name} operation query`);
  assert.equal(operationUrl.hash, '', `${name} operation fragment`);
  assert.match(value.policyId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/,
    `${name} policy id`);
  assert.equal(exactSha256(value.policySha256, `${name}:policySha256`), value.policySha256);
  assert.match(value.signingKeyId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/,
    `${name} signing key id`);
  let publicKey;
  assert.doesNotThrow(() => { publicKey = createPublicKey(value.signingPublicKeyPem); },
    `${name} public key parse`);
  assert.equal(publicKey.type, 'public', `${name} public key type`);
  assert.equal(publicKey.asymmetricKeyType, 'ed25519', `${name} Ed25519 key`);
  assert.equal(publicKey.export({ type: 'spki', format: 'pem' }), value.signingPublicKeyPem,
    `${name} canonical public PEM`);
  assert.equal(
    sha256(publicKey.export({ type: 'spki', format: 'der' })),
    exactSha256(value.signingKeySpkiSha256, `${name}:signingKeySpkiSha256`),
    `${name} SPKI digest`
  );
  const oidcAudience = new URL(value.oidcAudience);
  assert.equal(oidcAudience.protocol, 'https:', `${name} HTTPS OIDC audience`);
  assert.equal(oidcAudience.username, '', `${name} OIDC audience username`);
  assert.equal(oidcAudience.password, '', `${name} OIDC audience password`);
  assert.equal(oidcAudience.hash, '', `${name} OIDC audience fragment`);
  assert.equal(oidcAudience.href, value.oidcAudience, `${name} canonical OIDC audience`);
}

assertPinnedBrokerTrustBoundary(
  'external publish/reconciliation broker',
  POLICY.externalReconciliationBroker,
  'cnyos_staging_publish_reconciliation'
);
assertPinnedBrokerTrustBoundary(
  'draft lifecycle broker',
  POLICY.draftLifecycleBroker,
  'cnyos_staging_draft_lifecycle'
);
assertPinnedBrokerTrustBoundary(
  'rollback principal membership broker',
  POLICY.rollbackPrincipalMembershipBroker,
  'cnyos_staging_rollback_principal_membership'
);
for (const [name, value] of Object.entries({
  BACKUP_ENABLED: 'false',
  CNYOS_PLATFORM_CONTROL_ENABLED: 'false',
  CNYOS_OWNER_DRIVE_ENABLED: 'false',
  RESTORE_SOURCE_API_ENABLED: 'false',
  GOOGLE_DRIVE_SERVICE_ACCOUNT_ALLOW_RESTORE_TEST_DIRECT_JSON: 'false',
  CNYOS_EVIDENCE_PUBMED_ENABLED: 'false',
  CNYOS_OWNER_CONTROL_ENABLED: 'false'
})) assert.equal(POLICY.functionEnvironment[name], value, name);
const PROTECTED_REQUIRED_SCHEDULES = Object.freeze({
  'database-backup': '0 20 * * *',
  'database-backup-recovery': '*/15 0-2,20-23 * * *'
});
assert.deepEqual(REQUIRED_SCHEDULES, PROTECTED_REQUIRED_SCHEDULES);
assert.deepEqual(FUNCTIONS_REQUIRING_NO_SCHEDULE_OR_CUSTOM_ROUTE,
  ['database-backup-background']);

const validFunctionMetadata = {
  available_functions: EXPECTED_FUNCTION_NAMES.map(name => ({ n: name })),
  function_schedules: Object.entries(REQUIRED_SCHEDULES).map(([name, cron]) => ({ name, cron })),
  functions_config: {}
};
assert.deepEqual(assertFunctionMetadata(validFunctionMetadata),
  Object.entries(REQUIRED_SCHEDULES).map(([name, cron]) => ({ name, cron })));
assert.throws(() => assertFunctionMetadata({
  ...validFunctionMetadata,
  available_functions: validFunctionMetadata.available_functions.map(item => item.n ===
    'database-backup-background' ? { ...item, ro: true } : item)
}), /CNYOS_CONTROLLER_BACKGROUND_FUNCTION_ROUTE_OR_SCHEDULE_PRESENT/);
assert.throws(() => assertFunctionMetadata({
  ...validFunctionMetadata,
  functions_config: {
    'database-backup-background': { routes: [{ pattern: '/unsafe-background-route' }] }
  }
}), /CNYOS_CONTROLLER_BACKGROUND_FUNCTION_ROUTE_OR_SCHEDULE_PRESENT/);
assert.throws(() => assertFunctionMetadata({
  ...validFunctionMetadata,
  function_schedules: [
    ...validFunctionMetadata.function_schedules,
    { name: 'database-backup-background', cron: '* * * * *' }
  ]
}), /CNYOS_CONTROLLER_FUNCTION_SCHEDULE_MISMATCH/);

const lock = JSON.parse(lockRaw);
const packageManifest = JSON.parse(packageRaw);
assert.equal(packageManifest.scripts.test,
  'node tests/controller-contract.mjs && node tests/uat-evidence-schema-contract.mjs');
assert.equal(packageManifest.scripts['test:activation'],
  'node scripts/run-activation-contracts.mjs');
assert.doesNotMatch(packageManifest.scripts.test, /test:activation|run-activation-contracts/);
assert.equal(lock.lockfileVersion, 3);
assert.equal(lock.packages[''].dependencies['@netlify/blobs'], '10.7.13');
assert.equal(lock.packages[''].dependencies.qrcode, '1.5.4');
assert.equal(lock.packages[''].devDependencies, undefined);
if (POLICY.publishing.netlifyCliVersion === '__AUDITED_NETLIFY_CLI_VERSION__') {
  assert.equal(lock.packages['node_modules/netlify-cli'], undefined);
} else {
  assert.match(POLICY.publishing.netlifyCliVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(lock.packages['node_modules/netlify-cli']?.version,
    POLICY.publishing.netlifyCliVersion);
}

const protectedActivationPairs = [
  ['controller-function-bundle', ['scripts/controller-function-bundle.mjs'],
    'tests/controller-function-bundle-contract.mjs'],
  ['controller-authenticated-uat', ['scripts/controller-authenticated-uat.mjs'],
    'tests/controller-authenticated-uat-contract.mjs'],
  ['runtime-capability-boundary', ['scripts/verify-runtime-capability-boundary.mjs'],
    'tests/runtime-capability-boundary-contract.mjs'],
  ['live-netlify-authority-boundary',
    ['scripts/verify-live-netlify-authority-boundary.mjs'],
    'tests/live-netlify-authority-boundary-contract.mjs'],
  ['live-github-release-boundary',
    ['scripts/verify-live-github-release-boundary.mjs'],
    'tests/live-github-release-boundary-contract.mjs'],
  ['authorization-foundation-security', [],
    'tests/authorization-foundation-security-contract.mjs'],
  ['external-broker-trust-boundaries', [
    'scripts/verify-netlify-exclusive-publisher.mjs',
    'scripts/release-netlify-exclusive-publisher.mjs',
    'scripts/reconcile-netlify-release-state.mjs',
    'scripts/verify-private-draft-lifecycle.mjs',
    'scripts/create-netlify-draft-with-durable-intent.mjs',
    'scripts/cleanup-netlify-draft.mjs',
    'scripts/rollback-readiness.mjs'
  ], 'tests/external-broker-trust-boundaries-contract.mjs'],
  ['rollback-attestation-deposit', ['scripts/deposit-rollback-attestation.mjs'],
    'tests/rollback-attestation-deposit-contract.mjs'],
  ['netlify-control-file-behavior', ['scripts/verify-netlify-control-file-behavior.mjs'],
    'tests/netlify-control-file-behavior-contract.mjs'],
  ['netlify-exclusive-publisher', [
    'scripts/verify-netlify-exclusive-publisher.mjs',
    'scripts/release-netlify-exclusive-publisher.mjs'
  ], 'tests/netlify-exclusive-publisher-contract.mjs'],
  ['private-draft-lifecycle', ['scripts/verify-private-draft-lifecycle.mjs'],
    'tests/private-draft-lifecycle-contract.mjs'],
  ['draft-mutation-recovery', [
    'scripts/create-netlify-draft-with-durable-intent.mjs',
    'scripts/cleanup-netlify-draft.mjs'
  ], 'tests/draft-mutation-recovery-contract.mjs'],
  ['release-state-reconciliation', ['scripts/reconcile-netlify-release-state.mjs'],
    'tests/release-state-reconciliation-contract.mjs'],
  ['backup-disable-runtime-boundary', ['scripts/verify-backup-disable-runtime-boundary.mjs'],
    'tests/backup-disable-runtime-boundary-contract.mjs'],
  ['rollback-authorization-chain', ['scripts/verify-rollback-authorization-chain.mjs'],
    'tests/rollback-authorization-chain-contract.mjs'],
  ['rollback-principal-boundary', ['scripts/netlify-evidence.mjs'],
    'tests/rollback-principal-boundary-contract.mjs'],
  ['controller-static-reproducibility', ['scripts/controller-static-reproducibility.mjs'],
    'tests/controller-static-reproducibility-contract.mjs'],
  ['private-draft-access-boundary', ['scripts/private-draft-access-boundary.mjs'],
    'tests/private-draft-access-boundary-contract.mjs'],
  ['scheduled-function-route-denial', ['scripts/scheduled-function-route-denial.mjs'],
    'tests/scheduled-function-route-denial-contract.mjs'],
  ['rollback-readiness', ['scripts/rollback-readiness.mjs'],
    'tests/rollback-readiness-contract.mjs']
].map(([id, scripts, test]) => ({ id, scripts, test }));
assert.deepEqual(ACTIVATION_PAIRS, protectedActivationPairs);
for (const { id, test } of protectedActivationPairs) {
  const contract = ACTIVATION_TESTS.find(item => item.id === id);
  assert.equal(contract?.path, test);
  assert.equal(contract?.marker, `CNYOS activation contract ${id}: passed`);
}
const protectedFoundationScripts = [
  'create-producer-bundle.mjs',
  'finalize-evidence.mjs',
  'netlify-evidence.mjs',
  'policy.mjs',
  'run-activation-contracts.mjs',
  'validate-function-environment.mjs',
  'verify-authorization.mjs',
  'verify-producer-bundle.mjs',
  'verify-rollback-attestation-deposit.mjs'
];
assert.deepEqual(CLOSED_WORLD_SCRIPT_INVENTORY, [...new Set([
  ...protectedFoundationScripts,
  ...protectedActivationPairs.flatMap(pair => pair.scripts.map(item => path.posix.basename(item)))
])].sort());
assert.deepEqual(CLOSED_WORLD_TEST_INVENTORY, [
  'controller-contract.mjs',
  'uat-evidence-schema-contract.mjs',
  ...protectedActivationPairs.map(pair => path.posix.basename(pair.test))
].sort());
assert.equal(new Set(REQUIRED_ACTIVATION_PREREQUISITES).size,
  REQUIRED_ACTIVATION_PREREQUISITES.length);
assert.equal(new Set(CLOSED_WORLD_SCRIPT_INVENTORY).size,
  CLOSED_WORLD_SCRIPT_INVENTORY.length);
assert.equal(new Set(CLOSED_WORLD_TEST_INVENTORY).size,
  CLOSED_WORLD_TEST_INVENTORY.length);
assert.match(activationRunner, /await fs\.lstat\(absolutePath\)/);
assert.match(activationRunner,
  /!status\.isFile\(\) \|\| status\.isSymbolicLink\(\) \|\| status\.size < 1/);
assert.match(activationRunner, /assertClosedWorld\('scripts', CLOSED_WORLD_SCRIPT_INVENTORY\)/);
assert.match(activationRunner, /assertClosedWorld\('tests', CLOSED_WORLD_TEST_INVENTORY\)/);
assert.match(activationRunner, /env: credentialFreeEnvironment\(\)/);
assert.match(activationRunner, /stdio: \['ignore', 'pipe', 'pipe'\]/);
assert.doesNotMatch(activationRunner, /\.\.\.process\.env|process\.env\[/);
assert.match(activationRunner, /result\.stdout !== `\$\{contract\.marker\}\\n`/);
assert.match(activationRunner, /result\.stderr !== ''/);

const workflowActivationFiles = REQUIRED_ACTIVATION_PREREQUISITES.filter(
  relative => relative !== 'scripts/netlify-evidence.mjs'
);
for (const relative of workflowActivationFiles) {
  assert.match(release, new RegExp(`test -f ops/cnyos-staging-controller/${relative.replaceAll('.', '\\.')}`));
  assert.match(watchdog,
    new RegExp(`test -f ops/cnyos-staging-controller/${relative.replaceAll('.', '\\.')}`));
}
assert.match(release,
  /test -f ops\/cnyos-staging-controller\/tests\/uat-evidence-schema-contract\.mjs/);
assert.match(watchdog,
  /test -f ops\/cnyos-staging-controller\/tests\/uat-evidence-schema-contract\.mjs/);
assert.match(release, /for protected_file in/);
assert.match(release, /test ! -L "\$protected_file"/);
assert.match(watchdog, /for protected_file in/);
assert.match(watchdog, /test ! -L "\$protected_file"/);
assert.match(watchdog, /actions\/setup-node@__PINNED_SETUP_NODE_COMMIT_SHA__/);
assert.match(watchdog, /node-version: 24\.20\.0/);
assert.match(watchdog,
  /cache-dependency-path: ops\/cnyos-staging-controller\/package-lock\.json/);
function assertOrdered(source, terms, label) {
  let previous = -1;
  for (const term of terms) {
    const current = source.indexOf(term, previous + 1);
    assert.ok(current > previous, `${label}: ${term}`);
    previous = current;
  }
}
assertOrdered(release, [
  'npm test',
  'npm run test:activation'
], 'workflow activation test order');
assertOrdered(watchdog, [
  'Bootstrap stop — intentionally fail closed',
  'Check out protected watchdog',
  'Require the complete controller activation boundary',
  "! rg -n '__[A-Z_]+__|BLOCKED_UNTIL'",
  'Set up the protected watchdog test runtime',
  'npm ci --ignore-scripts',
  'npm test',
  'npm run test:activation',
  'Reconcile rollback, rejected drafts, and publisher lease for the failed run'
], 'watchdog complete activation boundary before recovery credentials');
assertOrdered(release, [
  'node ops/cnyos-staging-controller/scripts/verify-live-netlify-authority-boundary.mjs',
  'echo "evidence_sha256=$(sha256sum "$CNYOS_CONTROLLER_LIVE_NETLIFY_AUTHORITY_EVIDENCE_PATH"',
  'CNYOS_EXPECTED_LIVE_NETLIFY_AUTHORITY_EVIDENCE_SHA256: ${{ steps.live_authority.outputs.evidence_sha256 }}',
  'node ops/cnyos-staging-controller/scripts/netlify-evidence.mjs preflight'
], 'fresh live Netlify authority boundary order');
assert.ok(release.includes(
  'CNYOS_NETLIFY_AUTHORITY_BROKER_URL: ${{ vars.CNYOS_NETLIFY_AUTHORITY_BROKER_URL }}'
));
for (const required of [
  'CNYOS_STAGING_DRAFT_ACCESS_BOUNDARY_TOKEN: ${{ secrets.CNYOS_STAGING_DRAFT_ACCESS_BOUNDARY_TOKEN }}',
  'CNYOS_PRIVATE_DRAFT_ACCESS_BOUNDARY_URL: ${{ vars.CNYOS_PRIVATE_DRAFT_ACCESS_BOUNDARY_URL }}',
  'CNYOS_CONTROLLER_DRAFT_ACCESS_BOUNDARY_EVIDENCE_PATH: ${{ github.workspace }}/controller/release-chain/evidence/draft-access-boundary.json',
  'export CNYOS_EXPECTED_DRAFT_ACCESS_BOUNDARY_EVIDENCE_SHA256='
]) assert.ok(release.includes(required), required);
assertOrdered(release, [
  'node ops/cnyos-staging-controller/scripts/private-draft-access-boundary.mjs',
  'export CNYOS_EXPECTED_DRAFT_ACCESS_BOUNDARY_EVIDENCE_SHA256=',
  'node ops/cnyos-staging-controller/scripts/netlify-evidence.mjs verify-draft'
], 'private draft boundary order');
assertOrdered(release, [
  'node ops/cnyos-staging-controller/scripts/netlify-evidence.mjs verify-promoted',
  'node ops/cnyos-staging-controller/scripts/scheduled-function-route-denial.mjs',
  'echo "scheduled_route_denial_sha256=',
  'node ops/cnyos-staging-controller/scripts/controller-authenticated-uat.mjs'
], 'scheduled route denial order');
assertOrdered(release, [
  'node ops/cnyos-staging-controller/scripts/netlify-evidence.mjs verify-final-current',
  'node ops/cnyos-staging-controller/scripts/release-netlify-exclusive-publisher.mjs',
  'echo "publisher_release_sha256=',
  'node ops/cnyos-staging-controller/scripts/finalize-evidence.mjs'
], 'publisher release order');

function workflowStepSlice(name) {
  const marker = `      - name: ${name}`;
  const start = release.indexOf(marker);
  assert.notEqual(start, -1, `workflow step missing: ${name}`);
  const next = release.indexOf('\n      - name:', start + marker.length);
  return release.slice(start, next === -1 ? release.length : next);
}

function secretReferences(step) {
  const references = [...step.matchAll(/\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}/g)]
    .map(match => match[1])
    .sort();
  assert.equal((step.match(/\bsecrets\b/g) || []).length, references.length,
    'noncanonical or hidden secret expression');
  return references;
}

const promoteStep = workflowStepSlice('Promote only the receipt-bound draft');
const promotionAttemptStep = workflowStepSlice('Persist exact promotion attempt');
const authorizationStep = workflowStepSlice(
  'Validate exact-run signatures from protected Environment'
);
const depositStep = workflowStepSlice(
  'Deposit exact recovery inputs with the immutable attestation broker'
);
const attestationStep = workflowStepSlice(
  'Verify the broker-signed sanitized attestation receipt'
);
const liveAuthorityStep = workflowStepSlice(
  'Obtain a signed live publisher-boundary attestation without deployment credentials'
);
const preflightStep = workflowStepSlice(
  'Prove staging-only principal and capture signed rollback target'
);
const preflightUploadStep = workflowStepSlice(
  'Durably retain authorization and preflight before mutation'
);
const draftUploadStep = workflowStepSlice('Retain draft evidence');
const draftVerificationUploadStep = workflowStepSlice('Retain draft verification');
const verifyPromotedStep = workflowStepSlice(
  'Verify promoted bytes and deny scheduled Function routes'
);
const uatStep = workflowStepSlice(
  'Run synthetic authenticated UAT without publisher credentials'
);
const finalCurrentStep = workflowStepSlice('Recheck exact current deploy after UAT');
const releasePublisherStep = workflowStepSlice(
  'Atomically release the publisher lease after the final current check'
);
const finalizeStep = workflowStepSlice('Close the cross-linked evidence set without credentials');
const watchdogCredentialStepStart = watchdog.indexOf(
  '      - name: Reconcile rollback, rejected drafts, and publisher lease for the failed run'
);
assert.notEqual(watchdogCredentialStepStart, -1);
const watchdogCredentialStepEnd = watchdog.indexOf('\n      - name:',
  watchdogCredentialStepStart + 1);
const watchdogCredentialStep = watchdog.slice(
  watchdogCredentialStepStart,
  watchdogCredentialStepEnd === -1 ? watchdog.length : watchdogCredentialStepEnd
);
const watchdogBeforeCredentials = watchdog.slice(0, watchdogCredentialStepStart);
assert.doesNotMatch(watchdogBeforeCredentials, /\$\{\{\s*secrets\./);
assert.match(watchdogCredentialStep, /CNYOS_GITHUB_ACTIONS_READ_TOKEN: \$\{\{ github\.token \}\}/);
assert.deepEqual(secretReferences(watchdogCredentialStep), [
  'CNYOS_STAGING_NETLIFY_ROLLBACK_TOKEN'
]);

assert.deepEqual(secretReferences(liveAuthorityStep), []);
assert.match(liveAuthorityStep,
  /CNYOS_NETLIFY_AUTHORITY_BROKER_URL: \$\{\{ vars\.CNYOS_NETLIFY_AUTHORITY_BROKER_URL \}\}/);
assert.doesNotMatch(liveAuthorityStep,
  /CNYOS_STAGING_NETLIFY_AUTH_TOKEN|NETLIFY_AUTH_TOKEN|CNYOS_STAGING_SUPABASE_SERVICE_ROLE_KEY|CNYOS_STAGING_TEST_PASSWORD|CNYOS_STAGING_DRAFT_ACCESS_BOUNDARY_TOKEN/);

assert.deepEqual(secretReferences(authorizationStep), [
  'CNYOS_CONTROLLER_AUTHORIZATION_JSON',
  'CNYOS_CONTROLLER_RISK_OWNER_SIGNATURE_BASE64',
  'CNYOS_CONTROLLER_SECURITY_SIGNATURE_BASE64'
]);
assert.doesNotMatch(authorizationStep,
  /CNYOS_STAGING_NETLIFY_AUTH_TOKEN|NETLIFY_AUTH_TOKEN|CNYOS_STAGING_SUPABASE_SERVICE_ROLE_KEY|CNYOS_STAGING_TEST_PASSWORD|CNYOS_STAGING_DRAFT_ACCESS_BOUNDARY_TOKEN/);
assert.deepEqual(secretReferences(depositStep), [
  'CNYOS_CONTROLLER_AUTHORIZATION_JSON',
  'CNYOS_CONTROLLER_RISK_OWNER_SIGNATURE_BASE64',
  'CNYOS_CONTROLLER_SECURITY_SIGNATURE_BASE64'
]);
assert.match(depositStep,
  /CNYOS_ROLLBACK_ATTESTATION_BROKER_URL: \$\{\{ vars\.CNYOS_ROLLBACK_ATTESTATION_BROKER_URL \}\}/);
assert.match(depositStep, /deposit-rollback-attestation\.mjs/);
assert.doesNotMatch(depositStep,
  /CNYOS_STAGING_NETLIFY_AUTH_TOKEN|NETLIFY_AUTH_TOKEN|CNYOS_STAGING_SUPABASE_SERVICE_ROLE_KEY|CNYOS_STAGING_TEST_PASSWORD|CNYOS_STAGING_DRAFT_ACCESS_BOUNDARY_TOKEN/);
assert.deepEqual(secretReferences(attestationStep), []);
assert.match(attestationStep, /verify-rollback-attestation-deposit\.mjs/);
assert.doesNotMatch(attestationStep,
  /CNYOS_CONTROLLER_AUTHORIZATION_JSON|CNYOS_CONTROLLER_SECURITY_SIGNATURE_BASE64|CNYOS_CONTROLLER_RISK_OWNER_SIGNATURE_BASE64|CNYOS_STAGING_NETLIFY_AUTH_TOKEN|NETLIFY_AUTH_TOKEN|CNYOS_STAGING_SUPABASE_SERVICE_ROLE_KEY|CNYOS_STAGING_TEST_PASSWORD/);
assert.doesNotMatch(depositStep,
  /echo[^\r\n]*(?:CNYOS_CONTROLLER_AUTHORIZATION_JSON|CNYOS_CONTROLLER_SECURITY_SIGNATURE_BASE64|CNYOS_CONTROLLER_RISK_OWNER_SIGNATURE_BASE64)/);
for (const safeArtifact of [
  'authorization.json',
  'authorization-verification-bundle.json',
  'rollback-attestation-deposit-receipt.json',
  'rollback-attestation-deposit-validation.json',
  'preflight.json'
]) assert.match(preflightUploadStep, new RegExp(`release-chain/${safeArtifact.replaceAll('.', '\\.')}`));
assert.doesNotMatch(preflightUploadStep,
  /path:\s*\$\{\{ runner\.temp \}\}\/release-chain\/(?:\s|$)/m);
assert.doesNotMatch(preflightUploadStep,
  /authorization-raw|known-good|approver-registry|security-signature|risk-owner-signature|private-key/i);
assertOrdered(release, [
  'Validate exact-run signatures from protected Environment',
  'Deposit exact recovery inputs with the immutable attestation broker',
  'Verify the broker-signed sanitized attestation receipt',
  'Obtain a signed live publisher-boundary attestation without deployment credentials',
  'Prove staging-only principal and capture signed rollback target',
  'Durably retain authorization and preflight before mutation',
  'Create an unpromoted staging draft'
], 'rollback attestation deposit before mutation');
assert.deepEqual(secretReferences(preflightStep), ['CNYOS_STAGING_NETLIFY_AUTH_TOKEN']);
assert.doesNotMatch(preflightStep,
  /CNYOS_CONTROLLER_AUTHORIZATION_JSON|CNYOS_CONTROLLER_SECURITY_SIGNATURE_BASE64|CNYOS_CONTROLLER_RISK_OWNER_SIGNATURE_BASE64|CNYOS_STAGING_SUPABASE_SERVICE_ROLE_KEY|CNYOS_STAGING_TEST_PASSWORD|CNYOS_STAGING_DRAFT_ACCESS_BOUNDARY_TOKEN/);

for (const [name, step] of [
  ['promotion-attempt', promotionAttemptStep],
  ['promote', promoteStep],
  ['verify-promoted', verifyPromotedStep],
  ['final-current', finalCurrentStep]
]) {
  assert.deepEqual(secretReferences(step), ['CNYOS_STAGING_NETLIFY_AUTH_TOKEN'],
    `${name} secret boundary`);
  assert.match(step,
    /^\s+CNYOS_STAGING_NETLIFY_AUTH_TOKEN: \$\{\{ secrets\.CNYOS_STAGING_NETLIFY_AUTH_TOKEN \}\}$/m);
  assert.doesNotMatch(step, /^\s+NETLIFY_AUTH_TOKEN:/m);
  assert.doesNotMatch(step,
    /CNYOS_STAGING_SUPABASE_SERVICE_ROLE_KEY|CNYOS_STAGING_TEST_PASSWORD/);
}
for (const step of [promotionAttemptStep, promoteStep]) {
  assert.match(step,
    /CNYOS_EXPECTED_ROLLBACK_READINESS_EVIDENCE_SHA256: \$\{\{ needs\.rollback_readiness\.outputs\.evidence_sha256 \}\}/);
  assert.match(step,
    /CNYOS_EXPECTED_DRAFT_GATE_EVIDENCE_SHA256: \$\{\{ needs\.draft_deploy\.outputs\.draft_gate_sha256 \}\}/);
}
assert.deepEqual(secretReferences(uatStep), [
  'CNYOS_STAGING_SUPABASE_SERVICE_ROLE_KEY',
  'CNYOS_STAGING_TEST_PASSWORD'
]);
assert.match(uatStep,
  /^\s+CNYOS_STAGING_SUPABASE_SERVICE_ROLE_KEY: \$\{\{ secrets\.CNYOS_STAGING_SUPABASE_SERVICE_ROLE_KEY \}\}$/m);
assert.match(uatStep,
  /^\s+CNYOS_STAGING_TEST_PASSWORD: \$\{\{ secrets\.CNYOS_STAGING_TEST_PASSWORD \}\}$/m);
assert.doesNotMatch(uatStep, /CNYOS_STAGING_NETLIFY_AUTH_TOKEN|NETLIFY_AUTH_TOKEN/);
assert.match(uatStep,
  /CNYOS_EXPECTED_SCHEDULED_ROUTE_DENIAL_EVIDENCE_SHA256: \$\{\{ steps\.verify_promoted\.outputs\.scheduled_route_denial_sha256 \}\}/);

assert.deepEqual(secretReferences(releasePublisherStep), []);
assert.match(releasePublisherStep,
  /CNYOS_NETLIFY_PUBLISH_BROKER_URL: \$\{\{ vars\.CNYOS_NETLIFY_PUBLISH_BROKER_URL \}\}/);
assert.doesNotMatch(releasePublisherStep,
  /CNYOS_STAGING_NETLIFY_AUTH_TOKEN|NETLIFY_AUTH_TOKEN|CNYOS_STAGING_SUPABASE_SERVICE_ROLE_KEY|CNYOS_STAGING_TEST_PASSWORD/);
const promoteJob = release.slice(
  release.indexOf('\n  promote_and_validate:'),
  release.indexOf('\n  reconcile_failed_release:')
);
assert.match(promoteJob, /permissions:\n\s+contents: read\n\s+id-token: write/);
assert.match(promoteJob,
  /needs: \[produce, authorize_preflight, rollback_readiness, draft_deploy, verify_draft\]/);
assert.match(promoteJob,
  /name: Download exact rollback-readiness evidence[\s\S]{0,240}name: cnyos-rollback-readiness-\$\{\{ github\.run_id \}\}[\s\S]{0,160}path: controller\/release-chain\/evidence/);
assert.match(promoteJob,
  /name: Download exact preflight evidence[\s\S]{0,240}name: cnyos-preflight-\$\{\{ github\.run_id \}\}[\s\S]{0,160}path: controller\/release-chain\/evidence/);
for (const filename of [
  'pre-release-reconciliation.json',
  'authorization.json',
  'authorization-verification-bundle.json',
  'rollback-attestation-deposit-receipt.json',
  'rollback-attestation-deposit-validation.json',
  'live-netlify-authority-boundary.json',
  'function-environment.json',
  'backup-disable-runtime-boundary.json',
  'runtime-capability.json',
  'preflight.json'
]) assert.match(preflightUploadStep, new RegExp(`release-chain/${filename.replaceAll('.', '\\.')}`));
assert.match(draftUploadStep, /path: controller\/release-chain\/evidence\//);
for (const filename of [
  'draft-access-boundary.json',
  'draft-verification.json',
  'control-behavior.json',
  'private-draft.json'
]) assert.match(draftVerificationUploadStep, new RegExp(`evidence/${filename.replaceAll('.', '\\.')}`));

assert.deepEqual(secretReferences(finalizeStep), []);
assert.doesNotMatch(finalizeStep,
  /CNYOS_STAGING_NETLIFY_AUTH_TOKEN|NETLIFY_AUTH_TOKEN|CNYOS_STAGING_SUPABASE_SERVICE_ROLE_KEY|CNYOS_STAGING_TEST_PASSWORD|CNYOS_NETLIFY_PUBLISH_BROKER_URL/);
assert.match(finalizeStep,
  /CNYOS_EXPECTED_SCHEDULED_ROUTE_DENIAL_EVIDENCE_SHA256: \$\{\{ steps\.verify_promoted\.outputs\.scheduled_route_denial_sha256 \}\}/);
assert.match(finalizeStep,
  /CNYOS_EXPECTED_PUBLISHER_RELEASE_EVIDENCE_SHA256: \$\{\{ steps\.release_publisher\.outputs\.publisher_release_sha256 \}\}/);
assert.match(release, /CNYOS_CONTROLLER_BOOTSTRAP_STATE: BLOCKED_UNTIL_/);
assert.match(release, /test "\$CNYOS_CONTROLLER_BOOTSTRAP_STATE" = "REVIEWED_AND_ACTIVATED"/);
assert.match(readme, /Activation status: blocked by design/);
assert.match(readme, /external-broker-trust-boundaries/);
assert.match(readme, /live-github-release-boundary/);
assert.match(readme, /no credential forwarding or serialization/);
assert.match(release, /actions\/checkout@__PINNED_CHECKOUT_COMMIT_SHA__/);
assert.match(release, /actions\/upload-artifact@__PINNED_UPLOAD_ARTIFACT_COMMIT_SHA__/);
assert.match(release, /__AUDITED_NETLIFY_CLI_VERSION__/);
assert.doesNotMatch(release, /\bnetlify\b[^\n]*\bdeploy\b[^\n]*--prod(?:\s|$)/);
assert.match(release, /name: Create an unpromoted staging draft/);
assert.match(release, /Create a draft only after a durable external intent is acknowledged/);
assert.match(release, /netlify-evidence\.mjs verify-draft/);
assert.match(release, /verify-netlify-control-file-behavior\.mjs/);
assert.match(release, /verify-runtime-capability-boundary\.mjs/);
assert.match(release, /verify-private-draft-lifecycle\.mjs/);
assert.match(release, /verify-netlify-exclusive-publisher\.mjs/);
assert.match(release, /netlify-evidence\.mjs promote/);
assert.match(release, /netlify-evidence\.mjs verify-promoted/);
assert.match(release, /controller-authenticated-uat\.mjs/);
assert.match(release, /netlify-evidence\.mjs verify-final-current/);
assert.match(release, /finalize-evidence\.mjs/);
assert.match(release, /release-netlify-exclusive-publisher\.mjs/);
assert.match(release, /cleanup-netlify-draft\.mjs/);

const buildSlice = release.slice(release.indexOf('\n  build_candidate:'),
  release.indexOf('\n  produce:'));
const producerSlice = release.slice(release.indexOf('\n  produce:'),
  release.indexOf('\n  authorize_preflight:'));
for (const slice of [buildSlice, producerSlice]) {
  assert.doesNotMatch(slice, /^\s+environment:/m);
  assert.doesNotMatch(slice, /\$\{\{\s*secrets\./);
}
assert.match(producerSlice, /controller-function-bundle\.mjs/);
assert.match(producerSlice, /CNYOS_EXPECTED_FUNCTION_DEPENDENCY_LOCK_SHA256/);
assert.match(producerSlice,
  /CNYOS_REPRODUCED_STATIC_DIRECTORY: \$\{\{ runner\.temp \}\}\/cnyos-reproduced-static/);
assert.match(producer, /CNYOS_PRODUCER_REPRODUCED_STATIC_DIRECTORY_NOT_ISOLATED/);
assert.doesNotMatch(producerSlice,
  /CNYOS_REPRODUCED_STATIC_DIRECTORY:\s*\$\{\{ github\.workspace \}\}\/candidate\/dist/);
const reproduceStaticStep = workflowStepSlice(
  'Independently reproduce and compare the static artifact'
);
const createBundleStep = workflowStepSlice('Create controller-owned exact-byte bundle');
for (const step of [reproduceStaticStep, createBundleStep]) {
  assert.match(step,
    /CNYOS_REPRODUCED_STATIC_DIRECTORY: \$\{\{ runner\.temp \}\}\/cnyos-reproduced-static/);
  assert.doesNotMatch(step,
    /CNYOS_REPRODUCED_STATIC_DIRECTORY:\s*\$\{\{ github\.workspace \}\}|candidate\/dist/);
}
assert.match(reproduceStaticStep,
  /CNYOS_UNTRUSTED_STATIC_DIRECTORY: \$\{\{ runner\.temp \}\}\/cnyos-untrusted-static/);
assert.match(producer, /manifest\.dependencyLockSha256 !== expectedDependencyLockSha256/);
assert.match(producer, /CNYOS_PRODUCER_PRODUCTION_TARGET_MARKER_PRESENT/);
assert.match(producer, /payload\/netlify\/functions\/\$\{file\.relativePath\}/);

for (const phrase of [
  'postgresqlMajorVersion !== 17',
  "receipt !== 'ACL_CATALOG_ROLLBACK_VERIFIED'",
  'runtimeAndUntrustedCannotSetRoleToReviewedCreators !== true',
  'blockOnDefaultAclDrift !== true',
  'compareAndSwapOrEquivalentLockEnforced !== true',
  'functionBundleManifestSha256 !== manifest.functionBundleManifestSha256',
  "maintenanceWindowStatus !== 'completed'",
  'rehearsal.quiescenceVerified !== true',
  'baselineSha256 !== inventoryBaseline.sha256',
  "ownerControlScope !== 'disabled'",
  "executionAuthority !== 'external_rollback_reconciliation_broker'",
  'targetRunCannotSuppressReconciliation !== true',
  'watchdogRevisionCannotSuppressReconciliation !== true',
  'reconciliationBroker.enforcesDraftCleanup !== true',
  'reconciliationBroker.enforcesLeaseRelease !== true',
  "value.membershipRole !== 'Publisher'",
  'record.publicKeyPem !== canonicalPublicKeyPem',
  'principalWindow.expiresAt > expiresAt',
  'secretValuesSerialized: false',
  'authorizationPacketSha256: sha256(raw)'
]) assert.ok(authorization.includes(phrase), phrase);
assert.doesNotMatch(authorization, /authorizationJson: raw/);
assert.doesNotMatch(authorization, /knownGoodEvidenceJson:/);
assert.doesNotMatch(authorization, /signaturesBase64:/);

for (const phrase of [
  'raw !== JSON.stringify(value)',
  "receipt.evidenceType !== 'cnyos_staging_rollback_attestation_deposit_receipt'",
  'receipt.depositSemantics.conflictingOverwriteRejected !== true',
  'receipt.depositSemantics.identicalReplayReturnsOriginalReceipt !== true',
  'receipt.depositSemantics.rawPayloadArtifactExposure !== false',
  'receipt.retrievalBoundary.requiredControllerRunAttempt !== 1',
  'receipt.retrievalBoundary.requiredDispatchNonce !== expectedController.dispatchNonce',
  'receipt.retrievalBoundary.oidcControllerIdentityRequired !== true',
  'receipt.authorizationMaterial.knownGoodEvidenceSha256',
  'minimumFutureTimestamp(',
  '!crypto.verify(null, Buffer.from(statement), trust.publicKey, signature)',
  'secretValuesSerialized: false',
  'rawPayloadArtifactExposure: false'
]) assert.ok(rollbackAttestation.includes(phrase), phrase);
assert.doesNotMatch(rollbackAttestation,
  /authorizationJson\s*:|knownGoodEvidenceJson\s*:|signaturesBase64\s*:|privateKey/);
assert.match(netlify, /rollbackAttestationDepositEvidenceSha256/);
assert.match(netlify, /rollbackAttestationDepositReceiptSha256/);
assert.match(preflightStep,
  /CNYOS_EXPECTED_ROLLBACK_ATTESTATION_DEPOSIT_EVIDENCE_SHA256: \$\{\{ steps\.attestation\.outputs\.evidence_sha256 \}\}/);
assert.match(release,
  /authorization-verification-bundle\.json[^\r\n]*authorize_preflight\.outputs\.authorization_bundle_sha256/);
assert.match(release,
  /rollback-attestation-deposit-receipt\.json[^\r\n]*authorize_preflight\.outputs\.rollback_attestation_receipt_sha256/);
assert.match(release,
  /rollback-attestation-deposit-validation\.json[^\r\n]*authorize_preflight\.outputs\.rollback_attestation_evidence_sha256/);

assert.match(netlify, /expectedDraft: true/);
assert.match(netlify, /expectedDraft: false/);
assert.match(netlify, /!receiptOwnership \|\| !markerOwnership/);
assert.match(netlify, /authorizationSignaturesVerified !== true/);
assert.match(netlify, /CNYOS_CONTROLLER_RUNTIME_CAPABILITY_EVIDENCE_INVALID/);
assert.match(netlify, /CNYOS_CONTROLLER_LIVE_NETLIFY_AUTHORITY_BOUNDARY_INVALID/);
assert.match(netlify, /publisherInventoryLiveVerified !== true/);
assert.match(netlify, /liveNetlifyAuthorityBoundaryEvidenceSha256/);
assert.match(netlify, /CNYOS_CONTROLLER_BACKUP_DISABLE_EVIDENCE_PATH_REQUIRED/);
assert.match(netlify, /dailyBeforeConfigurationOrSupabase !== true/);
assert.match(netlify, /recoveryBeforeConfigurationOrSupabase !== true/);
assert.match(netlify, /backgroundBeforeConfigurationOrSupabase !== true/);
assert.match(netlify, /anonymousDraftAccessDenied !== true/);
assert.match(netlify, /Authorization: `Bearer \$\{accessToken\}`/);
assert.match(netlify, /await exactSiteInventory\(fetchImpl, token, preflight\.value\.rollbackNetlifyPrincipalSubject\)/);
assert.match(netlify, /verify-final-current/);
const rollbackFreshnessBlock = netlify.match(
  /function rollbackReadinessMaximumAgeMilliseconds\(\) \{([\s\S]*?)\n\}/
)?.[1];
assert.ok(rollbackFreshnessBlock, 'rollback-readiness freshness policy helper');
assert.match(rollbackFreshnessBlock,
  /POLICY\.rollbackPrincipalMembershipBroker\?\.maximumEvidenceAgeMinutes/);
assert.doesNotMatch(rollbackFreshnessBlock, /databaseEvidence/);
assert.match(netlify,
  /expiresAt\.getTime\(\) - verifiedAt\.getTime\(\) > maximumAge/);
assert.match(netlify, /expiresAt > authorizationExpiresAt/);
assert.match(netlify,
  /rollbackReadinessEvidenceSha256: recoveryChain\.rollbackReadiness\.sha256/);
assert.match(netlify, /draftGateEvidenceSha256: recoveryChain\.draftGate\.sha256/);
const promoteFunction = netlify.slice(
  netlify.indexOf('export async function promoteExactDraft'),
  netlify.indexOf('export async function verifyPromotedDeployment')
);
assertOrdered(promoteFunction, [
  'loadAndValidatePromotionRecoveryChain(',
  'const mutationAt = now()',
  'assertFreshPreflight(preflight.value, runtime, mutationAt)',
  'validateRollbackReadinessEvidence(recoveryChain.rollbackReadiness.value',
  'validatePromotionDraftGate(recoveryChain.draftGate.value',
  '/restore`'
], 'fresh rollback-readiness and draft-gate chain immediately before promotion');
assert.match(finalizer, /finalCurrentVerification/);
assert.match(finalizer, /CNYOS_FINAL_AUTHORIZATION_OR_PUBLISHER_LEASE_EXPIRED/);
for (const required of [
  'preReleaseReconciliation',
  'authorizationVerificationBundle',
  'rollbackAttestationDepositReceipt',
  'rollbackAttestationDepositValidation',
  'liveNetlifyAuthorityBoundary',
  'functionEnvironment',
  'backupDisableRuntimeBoundary',
  'runtimeCapabilityBoundary',
  'rollbackReadiness',
  'draftGate',
  'durableDraftIntent',
  'privateDraftAccessBoundary',
  'promotionAttempt'
]) assert.match(finalizer, new RegExp(`${required}: [A-Za-z]+\\.sha256`), required);
const expectedRetainedEvidenceKeys = [
  'producerManifest', 'preReleaseReconciliation', 'authorization',
  'authorizationVerificationBundle', 'rollbackAttestationDepositReceipt',
  'rollbackAttestationDepositValidation', 'liveNetlifyAuthorityBoundary',
  'functionEnvironment', 'backupDisableRuntimeBoundary', 'runtimeCapabilityBoundary',
  'preflight', 'rollbackReadiness', 'draftGate', 'durableDraftIntent', 'draftReceipt',
  'draftVerification', 'controlBehavior', 'privateDraftAccessBoundary',
  'privateDraftLifecycle', 'exclusivePublisherLease', 'promotionAttempt',
  'exactPromotion', 'postPromotionVerification', 'scheduledFunctionRouteDenial',
  'authenticatedUat', 'finalCurrentVerification', 'exclusivePublisherRelease'
];
const finalizerRetainedBlock = finalizer.match(
  /const retained = Object\.freeze\(\{([\s\S]*?)\n\s*\}\);/
)?.[1];
assert.ok(finalizerRetainedBlock, 'finalizer retained-evidence object');
assert.deepEqual(
  [...finalizerRetainedBlock.matchAll(/^\s+([A-Za-z][A-Za-z0-9]+):/gm)].map(match => match[1]),
  expectedRetainedEvidenceKeys,
  'finalizer retained-evidence keys'
);
const authorizationRetainedBlock = authorization.match(
  /assertExactKeys\(value\.retainedEvidenceSha256, \[([\s\S]*?)\n\s*\],\s*'CNYOS_CONTROLLER_KNOWN_GOOD_EVIDENCE_INVALID'\);/
)?.[1];
assert.ok(authorizationRetainedBlock, 'known-good retained-evidence allowlist');
assert.deepEqual(
  [...authorizationRetainedBlock.matchAll(/'([A-Za-z][A-Za-z0-9]+)'/g)].map(match => match[1]),
  expectedRetainedEvidenceKeys,
  'final evidence must remain reusable as the next known-good rollback record'
);
for (const [pathName, digestName] of [
  ['CNYOS_CONTROLLER_RECONCILIATION_EVIDENCE_PATH',
    'CNYOS_EXPECTED_RECONCILIATION_EVIDENCE_SHA256'],
  ['CNYOS_CONTROLLER_AUTHORIZATION_BUNDLE_PATH',
    'CNYOS_EXPECTED_AUTHORIZATION_BUNDLE_SHA256'],
  ['CNYOS_CONTROLLER_ROLLBACK_ATTESTATION_DEPOSIT_RECEIPT_PATH',
    'CNYOS_EXPECTED_ROLLBACK_ATTESTATION_DEPOSIT_RECEIPT_SHA256'],
  ['CNYOS_CONTROLLER_ROLLBACK_ATTESTATION_DEPOSIT_EVIDENCE_PATH',
    'CNYOS_EXPECTED_ROLLBACK_ATTESTATION_DEPOSIT_EVIDENCE_SHA256'],
  ['CNYOS_CONTROLLER_LIVE_NETLIFY_AUTHORITY_EVIDENCE_PATH',
    'CNYOS_EXPECTED_LIVE_NETLIFY_AUTHORITY_EVIDENCE_SHA256'],
  ['CNYOS_CONTROLLER_FUNCTION_ENV_EVIDENCE_PATH',
    'CNYOS_EXPECTED_FUNCTION_ENV_EVIDENCE_SHA256'],
  ['CNYOS_CONTROLLER_BACKUP_DISABLE_EVIDENCE_PATH',
    'CNYOS_EXPECTED_BACKUP_DISABLE_EVIDENCE_SHA256'],
  ['CNYOS_CONTROLLER_RUNTIME_CAPABILITY_EVIDENCE_PATH',
    'CNYOS_EXPECTED_RUNTIME_CAPABILITY_EVIDENCE_SHA256'],
  ['CNYOS_CONTROLLER_ROLLBACK_READINESS_EVIDENCE_PATH',
    'CNYOS_EXPECTED_ROLLBACK_READINESS_EVIDENCE_SHA256'],
  ['CNYOS_CONTROLLER_DRAFT_GATE_EVIDENCE_PATH',
    'CNYOS_EXPECTED_DRAFT_GATE_EVIDENCE_SHA256'],
  ['CNYOS_CONTROLLER_DRAFT_INTENT_EVIDENCE_PATH',
    'CNYOS_EXPECTED_DRAFT_INTENT_EVIDENCE_SHA256'],
  ['CNYOS_CONTROLLER_DRAFT_ACCESS_BOUNDARY_EVIDENCE_PATH',
    'CNYOS_EXPECTED_DRAFT_ACCESS_BOUNDARY_EVIDENCE_SHA256'],
  ['CNYOS_CONTROLLER_PUBLISH_ATTEMPT_EVIDENCE_PATH',
    'CNYOS_EXPECTED_PUBLISH_ATTEMPT_EVIDENCE_SHA256']
]) {
  assert.match(finalizer, new RegExp(`'${pathName}'[\\s\\S]{0,120}'${digestName}'`));
  assert.match(finalizeStep, new RegExp(`${pathName}:[\\s\\S]{0,240}${digestName}:`));
}
assert.match(finalizer,
  /draftVerification\.value\.privateDraftAccessBoundaryEvidenceSha256 !==\s*privateDraftAccessBoundary\.sha256/);
assert.match(finalizer,
  /preflight\.value\.functionEnvironmentEvidenceSha256 !== functionEnvironment\.sha256/);
assert.match(finalizer,
  /preflight\.value\.backupDisableEvidenceSha256 !== backupDisableRuntimeBoundary\.sha256/);
assert.match(finalizer,
  /preflight\.value\.runtimeCapabilityEvidenceSha256 !== runtimeCapabilityBoundary\.sha256/);
assert.match(finalizer,
  /promotionAttempt\.value\.rollbackReadinessEvidenceSha256 !== rollbackReadiness\.sha256/);
assert.match(finalizer,
  /promotionAttempt\.value\.draftGateEvidenceSha256 !== draftGate\.sha256/);
assert.match(finalizeStep,
  /CNYOS_EXPECTED_DRAFT_ACCESS_BOUNDARY_EVIDENCE_SHA256: \$\{\{ needs\.verify_draft\.outputs\.draft_access_boundary_sha256 \}\}/);
for (const [outputName, stepOutput] of [
  ['function_environment_sha256', 'function_environment_sha256'],
  ['backup_disable_sha256', 'backup_disable_sha256'],
  ['runtime_capability_sha256', 'runtime_capability_sha256']
]) {
  assert.match(release, new RegExp(`${outputName}: \\$\\{\\{ steps\\.preflight\\.outputs\\.${stepOutput} \\}\\}`));
  assert.match(release, new RegExp(`echo "${stepOutput}=\\$[A-Z_]+" >> "\\$GITHUB_OUTPUT"`));
}
assert.match(promoteJob,
  /name: Download exact draft verification[\s\S]{0,360}name: cnyos-draft-verification-\$\{\{ github\.run_id \}\}[\s\S]{0,240}path: controller\/release-chain\/evidence/);
for (const output of [
  'pre_release_reconciliation_sha256: ${{ steps.reconciliation.outputs.evidence_sha256 }}',
  'live_netlify_authority_sha256: ${{ steps.live_authority.outputs.evidence_sha256 }}',
  'draft_intent_sha256: ${{ steps.draft.outputs.draft_intent_sha256 }}'
]) assert.ok(release.includes(output), output);
assert.match(finalizer,
  /rollbackAttestationValidation\.value\.depositReceiptSha256 !==\s*rollbackAttestationReceipt\.sha256/);
assert.match(finalizer,
  /draftGate\.value\.rollbackReadinessEvidenceSha256 !== rollbackReadiness\.sha256/);
assert.match(finalizer,
  /promotion\.value\.promotionAttemptEvidenceSha256 !== promotionAttempt\.sha256/);

assert.match(release, /environment: cnyos-staging-rollback/);
assert.match(release, /CNYOS_STAGING_NETLIFY_ROLLBACK_TOKEN/);
assert.match(release,
  /verify-rollback-authorization-chain\.mjs[\s\S]*reconcile-netlify-release-state\.mjs recover-failed-run/);
assert.match(release,
  /name: Retain authenticated rollback-chain validation\n\s+if: \$\{\{ always\(\) && needs\.promote_and_validate\.outputs\.attempt_sha256 != '' \}\}[\s\S]{0,240}name: cnyos-rollback-chain-validation-\$\{\{ github\.run_id \}\}[\s\S]{0,160}path: \$\{\{ runner\.temp \}\}\/rollback-chain-validation\.json[\s\S]{0,120}if-no-files-found: error[\s\S]{0,100}retention-days: 365/);
assert.match(watchdog, /CNYOS_CONTROLLER_WORKFLOW_PATH: \.github\/workflows\/cnyos-staging-rollback-watchdog\.yml/);
assert.match(watchdog, /SOURCE_EVENT.*workflow_dispatch/s);
assert.match(watchdog, /git rev-parse HEAD/);
assert.match(watchdog, /reconcile-netlify-release-state\.mjs recover-workflow-run/);

const runtime = {
  GITHUB_REPOSITORY: POLICY.controller.repository,
  CNYOS_CONTROLLER_EXPECTED_REPOSITORY: POLICY.controller.repository,
  GITHUB_RUN_ID: '123456',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_REF_PROTECTED: 'true',
  CNYOS_CONTROLLER_PROTECTED_REF: POLICY.controller.protectedRef,
  GITHUB_REF: POLICY.controller.protectedRef,
  GITHUB_SHA: 'a'.repeat(40),
  CNYOS_CONTROLLER_WORKFLOW_PATH: POLICY.controller.releaseWorkflowPath,
  GITHUB_WORKFLOW_REF:
    `${POLICY.controller.repository}/${POLICY.controller.releaseWorkflowPath}@${POLICY.controller.protectedRef}`,
  GITHUB_ACTOR: 'apisarit',
  GITHUB_TRIGGERING_ACTOR: 'apisarit'
};
assert.equal(assertControllerRuntime(runtime).workflowPath, POLICY.controller.releaseWorkflowPath);
assert.equal(assertControllerRuntime({
  ...runtime,
  GITHUB_ACTOR: 'ApiSarit',
  GITHUB_TRIGGERING_ACTOR: 'apisarit'
}).actor, 'ApiSarit');
assert.throws(() => assertControllerRuntime({ ...runtime, GITHUB_WORKFLOW_REF:
  `${POLICY.controller.repository}/.github/workflows/evil.yml@${POLICY.controller.protectedRef}` }),
/CNYOS_CONTROLLER_WORKFLOW_REF_INVALID/);
assert.equal(sameGitHubLogin('Jaoball', 'jaoball'), true);
assert.equal(sameGitHubLogin('Jaoball', 'jaoball '), false);
assert.equal(sameGitHubLogin('bad_login', 'bad_login'), false);
assert.equal(sameGitHubLogin(123, '123'), false);
assert.doesNotThrow(() => assertDistinctOpaquePrincipalSubjects('principal-A', 'principal-a'));
assert.throws(
  () => assertDistinctOpaquePrincipalSubjects('principal-A', 'principal-A'),
  /CNYOS_CONTROLLER_NETLIFY_PRINCIPALS_NOT_DISTINCT/
);
assert.throws(
  () => assertDistinctOpaquePrincipalSubjects(' principal-A', 'principal-A'),
  /CNYOS_CONTROLLER_NETLIFY_PRINCIPALS_NOT_DISTINCT/
);

const referenceTime = new Date('2026-09-08T12:00:00.000Z');
assert.equal(
  canonicalIsoTimestamp('2026-09-08T11:59:59.999Z').toISOString(),
  '2026-09-08T11:59:59.999Z'
);
for (const invalid of [
  undefined,
  'junk',
  '2026-02-30T00:00:00.000Z',
  '2026-09-08T12:00:00Z',
  '2026-09-08T12:00:00.000+00:00',
  ' 2026-09-08T12:00:00.000Z'
]) assert.throws(() => canonicalIsoTimestamp(invalid), /TIMESTAMP_INVALID/);
assert.equal(
  minimumFutureTimestamp(
    '2026-09-08T12:45:00.000Z',
    referenceTime,
    45 * 60 * 1000
  ).toISOString(),
  '2026-09-08T12:45:00.000Z'
);
for (const invalidLease of [
  '2026-09-08T11:59:59.999Z',
  '2026-09-08T12:44:59.999Z',
  'not-a-lease'
]) assert.throws(
  () => minimumFutureTimestamp(invalidLease, referenceTime, 45 * 60 * 1000),
  /TIMESTAMP_INVALID/
);
assert.equal(
  recentCanonicalTimestamp(
    '2026-09-08T11:30:00.000Z',
    referenceTime,
    30 * 60 * 1000
  ).toISOString(),
  '2026-09-08T11:30:00.000Z'
);
for (const staleOrFuture of [
  '2026-09-08T11:29:59.999Z',
  '2026-09-08T12:00:00.001Z',
  'invalid'
]) assert.throws(
  () => recentCanonicalTimestamp(staleOrFuture, referenceTime, 30 * 60 * 1000),
  /TIMESTAMP_INVALID/
);
assert.equal(portableRelativePath('assets/app.js'), 'assets/app.js');
assert.throws(() => portableRelativePath('assets/e\u0301.js'), /ARTIFACT_PATH_INVALID/);

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'cnyos-controller-contract-'));
try {
  await fs.writeFile(path.join(temporary, 'target.txt'), 'a');
  await fs.symlink('target.txt', path.join(temporary, 'alias.txt'));
  await assert.rejects(walkRegularFiles(temporary), /ARTIFACT_SYMLINK_REJECTED/);
  await assert.rejects(
    readFileBounded(path.join(temporary, 'alias.txt'), 16, 'BOUNDARY_FILE_INVALID'),
    /BOUNDARY_FILE_INVALID/
  );
  assert.equal(
    (await readRegularFileStable(
      path.join(temporary, 'target.txt'),
      16,
      'BOUNDARY_FILE_INVALID'
    )).toString('utf8'),
    'a'
  );
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}

const deployId = '0123456789abcdef01234567';
assert.deepEqual(parseDeployReceipt({
  deploy_id: deployId,
  site_id: POLICY.target.netlifySiteId,
  site_name: POLICY.target.netlifySiteName,
  deploy_ssl_url: `https://${deployId}--${POLICY.target.netlifySiteName}.netlify.app`
}), {
  deployId,
  exactDeployOrigin: `https://${deployId}--${POLICY.target.netlifySiteName}.netlify.app`
});

const draftAccessToken = `draft-access-token.${'x'.repeat(32)}`;
assert.equal(strictDraftAccessToken(draftAccessToken), draftAccessToken);
for (const invalidToken of [undefined, '', 'short', `${'x'.repeat(31)}\n`, `token ${'x'.repeat(32)}`]) {
  assert.throws(() => strictDraftAccessToken(invalidToken),
    /CNYOS_CONTROLLER_DRAFT_ACCESS_TOKEN_INVALID/);
}
const draftFileBytes = Buffer.from('authenticated immutable draft bytes', 'utf8');
const draftBundle = {
  manifest: {
    files: [{
      path: 'payload/dist/index.html',
      size: draftFileBytes.byteLength,
      sha256: sha256(draftFileBytes)
    }]
  }
};
const draftOrigin = `https://${deployId}--${POLICY.target.netlifySiteName}.netlify.app`;
const draftBoundaryOrigin = 'https://cnyos-draft-reader.example.test';
const draftBoundaryPolicyId = 'cnyos-private-draft-access-v1';
const draftBoundaryPolicySha256 = 'd'.repeat(64);
let observedDraftRequest = null;
let observedDraftRequestCount = 0;
const draftStaticEvidence = await verifyDraftStaticFiles(
  async (url, options) => {
    observedDraftRequestCount += 1;
    observedDraftRequest = { url, options };
    return new Response(draftFileBytes, {
      status: 200,
      headers: {
        'x-cnyos-boundary-policy-id': draftBoundaryPolicyId,
        'x-cnyos-boundary-policy-sha256': draftBoundaryPolicySha256,
        'x-cnyos-upstream-authorization-forwarded': 'false',
        'x-cnyos-upstream-cookies-forwarded': 'false',
        'x-cnyos-upstream-redirect-followed': 'false'
      }
    });
  },
  draftBoundaryOrigin,
  draftOrigin,
  deployId,
  draftBundle,
  draftAccessToken,
  {
    controllerRunId: '123456',
    boundaryPolicyId: draftBoundaryPolicyId,
    boundaryPolicySha256: draftBoundaryPolicySha256
  }
);
assert.equal(observedDraftRequestCount, 1);
assert.equal(observedDraftRequest.url,
  `${draftBoundaryOrigin}/v1/read-netlify-draft-file`);
assert.equal(new URL(observedDraftRequest.url).origin, draftBoundaryOrigin);
assert.equal(observedDraftRequest.url.includes(draftOrigin), false);
assert.equal(observedDraftRequest.options.method, 'POST');
assert.equal(observedDraftRequest.options.redirect, 'error');
assert.equal(observedDraftRequest.options.headers.Authorization, `Bearer ${draftAccessToken}`);
assert.notEqual(observedDraftRequest.options.headers.Authorization, 'Bearer netlify-publish-token');
assert.equal(JSON.stringify(observedDraftRequest.options.headers).includes(draftOrigin), false);
const observedDraftRequestBody = JSON.parse(observedDraftRequest.options.body);
assert.equal(JSON.stringify(observedDraftRequestBody).includes(draftAccessToken), false);
assert.equal(observedDraftRequest.options.body.split(draftOrigin).length - 1, 1);
assert.deepEqual(observedDraftRequestBody, {
  schemaVersion: 1,
  operation: 'read_exact_netlify_draft_file',
  controllerRunId: '123456',
  netlifySiteId: POLICY.target.netlifySiteId,
  netlifyDeployId: deployId,
  exactDraftDeployOrigin: draftOrigin,
  path: '/index.html',
  expectedSize: draftFileBytes.byteLength,
  expectedSha256: sha256(draftFileBytes)
});
assert.equal(draftStaticEvidence.fileCount, 1);
assert.equal(JSON.stringify(draftStaticEvidence).includes(draftAccessToken), false);
await assert.rejects(
  verifyDraftStaticFiles(
    async () => new Response(draftFileBytes, { status: 200 }),
    draftBoundaryOrigin,
    'https://cnyos.netlify.app',
    deployId,
    draftBundle,
    draftAccessToken,
    {
      controllerRunId: '123456',
      boundaryPolicyId: draftBoundaryPolicyId,
      boundaryPolicySha256: draftBoundaryPolicySha256
    }
  ),
  /CNYOS_CONTROLLER_DRAFT_ORIGIN_INVALID/
);

process.stdout.write('CNYOS protected-controller offline contract: passed\n');
