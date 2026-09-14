import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/production-post-deploy-smoke.yml'), 'utf8');
const readiness = JSON.parse(fs.readFileSync(path.join(root, 'release-readiness.json'), 'utf8'));

assert.equal(readiness.notificationPolicy?.trackerIssue, 11);
assert.equal(readiness.notificationPolicy?.recipient, 'apisarit');
assert.equal(readiness.notificationPolicy?.notifyOnlyAfterSuccessfulPostDeployAttestation, true);
assert.equal(readiness.notificationPolicy?.requiresSuccessfulPromotionAndDeploymentForSameCommit, true);
assert.equal(readiness.notificationPolicy?.idempotentCompletionMarker, 'cnyos-production-complete');

assert.match(workflow, /permissions:\s*\n\s+actions:\s*read\s*\n\s+contents:\s*read\s*\n\s+issues:\s*write/,
  'post-deploy workflow needs the minimum actions-read/issues-write permissions');
assert.match(workflow, /Require trusted default branch and exact checkout/);
assert.match(workflow, /test "\$GITHUB_REF" = "refs\/heads\/\$DEFAULT_BRANCH"/);
assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/);
assert.match(workflow, /actions\/github-script@v9/g);
assert.match(workflow, /production-promotion-gate\.yml/);
assert.match(workflow, /production-netlify-deploy\.yml/);
assert.match(workflow, /run\.head_sha === sha && run\.conclusion === 'success'/);
assert.match(workflow, /notifyOnlyAfterSuccessfulPostDeployAttestation/);
assert.match(workflow, /requiresSuccessfulPromotionAndDeploymentForSameCommit/);
assert.match(workflow, /idempotentCompletionMarker/);
assert.match(workflow, /github\.paginate\(github\.rest\.issues\.listComments/);
assert.match(workflow, /github\.rest\.issues\.createComment/);
assert.match(workflow, /github\.rest\.issues\.update/);
assert.match(workflow, /state:\s*'closed'/);
assert.match(workflow, /state_reason:\s*'completed'/);
assert.match(workflow, /@\$\{recipient\}/, 'completion comment must mention the configured owner');
assert.match(workflow, /same commit/, 'completion comment must state exact-commit chain semantics');

const chainIndex = workflow.indexOf('Require successful promotion and deployment for the exact commit');
const publicAttestationIndex = workflow.indexOf('Attest deployed public runtime against selected commit');
const artifactIndex = workflow.indexOf('Retain post-deploy production evidence');
const notifyIndex = workflow.indexOf('Notify owner and close the production-gate tracker');
assert.ok(chainIndex >= 0 && chainIndex < publicAttestationIndex, 'release-chain proof must run before public attestation');
assert.ok(publicAttestationIndex < artifactIndex, 'public attestation must run before evidence retention');
assert.ok(artifactIndex < notifyIndex, 'owner notification must be the final success-only step');

for (const script of workflow.matchAll(/with:\s*\n\s+script:\s*\|\s*\n([\s\S]*?)(?=\n\s{6}- name:|\s*$)/g)) {
  assert.doesNotMatch(script[1], /\$\{\{/,
    'GitHub expressions must be passed through env instead of interpolated into JavaScript');
}
assert.equal((workflow.match(/Notify owner and close the production-gate tracker/g) || []).length, 1,
  'completion notification must have one idempotent source');

console.log('Production completion notification contract passed: exact-commit promotion + deploy + public attestation precede one owner notification');
