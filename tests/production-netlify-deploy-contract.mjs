import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const workflow = read('.github/workflows/production-netlify-deploy.yml');
const artifactVerifier = read('scripts/verify-production-build-artifact.mjs');
const netlifyEvidence = read('scripts/netlify-production-deploy-evidence.mjs');

assert.match(workflow, /on:\s*\n\s*workflow_dispatch:/, 'production deployment must be manual workflow_dispatch only');
assert.doesNotMatch(workflow, /\n\s*(?:push|pull_request|schedule|issue_comment):/, 'production deployment must not gain automatic triggers');
assert.match(workflow, /environment:\s*production/, 'production deployment must use the protected production environment');
assert.match(workflow, /DEPLOY_CNYOS_PRODUCTION/, 'production deployment must require explicit confirmation');
assert.match(workflow, /test "\$GITHUB_REF" = "refs\/heads\/\$DEFAULT_BRANCH"/, 'deployment must reject non-default-branch refs');
assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/, 'deployment must verify exact checkout');
assert.match(workflow, /PRODUCTION_NETLIFY_SITE_ID/, 'production site ID must come from environment configuration');
assert.match(workflow, /secrets\.NETLIFY_AUTH_TOKEN/, 'Netlify auth token must come from a secret');
assert.match(workflow, /CLINICAL_OS_PRODUCTION_CONFIG_JSON/, 'production tenant config must come from the protected environment');
assert.doesNotMatch(workflow, /7da5e39e-580d-44f1-8623-605313e2fb2b/, 'production site ID must not be hard-coded into source');

const promotionIndex = workflow.indexOf('npm run verify:production-promotion');
const buildIndex = workflow.indexOf('npm run build');
const artifactIndex = workflow.indexOf('verify-production-build-artifact.mjs');
const snapshotIndex = workflow.indexOf('netlify-production-deploy-evidence.mjs snapshot');
const deployIndex = workflow.indexOf('netlify deploy');
const netlifyVerifyIndex = workflow.indexOf('netlify-production-deploy-evidence.mjs verify');
const publicVerifyIndex = workflow.indexOf('npm run verify:public-deployment');
assert.ok(promotionIndex >= 0 && promotionIndex < buildIndex, 'promotion gate must pass before production build');
assert.ok(buildIndex < artifactIndex && artifactIndex < snapshotIndex && snapshotIndex < deployIndex, 'artifact verification and rollback snapshot must happen before deployment');
assert.ok(deployIndex < netlifyVerifyIndex && netlifyVerifyIndex < publicVerifyIndex, 'published deploy and public surface must be attested after deployment');

assert.match(workflow, /netlify-cli@27\.5\.0/, 'Netlify CLI must be pinned to an exact reviewed version');
assert.match(workflow, /--prod\s*\\/, 'deployment must explicitly publish to production');
assert.match(workflow, /--no-build\s*\\/, 'CLI must upload the already-verified artifact rather than rebuild it');
assert.match(workflow, /--dir=dist/, 'deployment must upload only the restricted dist surface');
assert.match(workflow, /--functions=netlify\/functions/, 'production functions must be bundled from the explicit function directory');
assert.match(workflow, /--context=production/, 'Netlify deployment must use production context');
assert.match(workflow, /--skip-functions-cache/, 'production function bundles must not reuse a stale function cache');
assert.doesNotMatch(workflow, /--prod-if-unlocked/, 'production deployment must fail rather than silently fall back to draft');
assert.doesNotMatch(workflow, /--trigger/, 'production deployment must not trigger an unbound remote build');
assert.match(workflow, /retention-days:\s*365/, 'production deployment evidence must be retained for 365 days');

assert.match(artifactVerifier, /HEAD\^\{tree\}/, 'production artifact verifier must derive the exact Git tree');
assert.match(artifactVerifier, /deploy\?\.source\?\.commit, expectedCommit/, 'production artifact verifier must bind the manifest commit');
assert.match(artifactVerifier, /deploy\?\.source\?\.tree, tree/, 'production artifact verifier must bind the manifest tree');
assert.match(artifactVerifier, /deploy\?\.build\?\.context, 'production'/, 'production artifact verifier must reject non-production context');
assert.match(artifactVerifier, /previewLocked, false/, 'production artifact verifier must reject preview-locked artifacts');
assert.match(artifactVerifier, /databaseLocked, false/, 'production artifact verifier must reject database-locked artifacts');

assert.match(netlifyEvidence, /https:\/\/api\.netlify\.com\/api\/v1/, 'deployment evidence must query the official Netlify API');
assert.match(netlifyEvidence, /Authorization: `Bearer \$\{token\}`/, 'Netlify API must authenticate through the secret token');
assert.match(netlifyEvidence, /previousPublishedDeploy/, 'pre-deploy rollback evidence must capture the previous published deploy');
assert.match(netlifyEvidence, /published\.id, deployId/, 'post-deploy evidence must verify the CLI deploy is currently published');
assert.match(netlifyEvidence, /published\.context, 'production'/, 'post-deploy evidence must require production context');
assert.match(netlifyEvidence, /expectedCommit\.slice\(0, 12\)/, 'published deploy title must identify the release commit');
assert.doesNotMatch(netlifyEvidence, /console\.(?:log|error)\([^\n]*(?:NETLIFY_AUTH_TOKEN|token)/, 'deployment evidence code must not print the Netlify token');

console.log('Exact Netlify production deploy contract passed: manual gated build, fixed site, rollback evidence and post-deploy attestation');
