import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareProductionAttestation } from './verify-production-promotion.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA = /^[0-9a-f]{40}$/;
const STAGES = [
  { workflow: 'production-promotion-gate.yml', confirmation: 'PROMOTE_PRODUCTION' },
  { workflow: 'production-netlify-deploy.yml', confirmation: 'DEPLOY_CNYOS_PRODUCTION' },
  { workflow: 'production-post-deploy-smoke.yml', confirmation: 'VERIFY_DEPLOYED_PRODUCTION' }
];

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function fail(code) {
  throw new Error(code);
}

function branchName(env) {
  const branch = String(env.DEFAULT_BRANCH || '');
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith('/') || branch.endsWith('/') || branch.includes('..')) {
    fail('RELEASE_CONTEXT_INVALID_DEFAULT_BRANCH');
  }
  return branch;
}

function requiredSha(value, code) {
  const sha = String(value || '');
  if (!SHA.test(sha)) fail(code);
  return sha;
}

function validateCandidate(env, head = git('rev-parse', 'HEAD')) {
  const requested = requiredSha(env.REQUESTED_RELEASE_COMMIT, 'RELEASE_CONTEXT_REQUESTED_COMMIT_INVALID');
  const workflow = requiredSha(env.GITHUB_SHA, 'RELEASE_CONTEXT_GITHUB_SHA_INVALID');
  const branch = branchName(env);
  if (env.GITHUB_REF !== `refs/heads/${branch}`) fail('RELEASE_CONTEXT_REF_INVALID');
  if (workflow !== head) fail('RELEASE_CONTEXT_COMMIT_MISMATCH');
  if (requested !== workflow) fail(`RELEASE_CONTEXT_STALE_INPUT current=${workflow}`);
  return { commit: requested, branch, ref: `refs/heads/${branch}`, head };
}

function validateFinalPush(env, head = git('rev-parse', 'HEAD')) {
  const branch = branchName(env);
  if (env.GITHUB_EVENT_NAME !== 'push') fail('RELEASE_CONTEXT_EVENT_INVALID');
  if (env.GITHUB_REF !== `refs/heads/${branch}`) fail('RELEASE_CONTEXT_REF_INVALID');
  const workflow = requiredSha(env.GITHUB_SHA, 'RELEASE_CONTEXT_GITHUB_SHA_INVALID');
  if (workflow !== head) fail('RELEASE_CONTEXT_COMMIT_MISMATCH');
  if (git('status', '--porcelain', '--untracked-files=no')) fail('RELEASE_CONTEXT_TRACKED_STATE_DIRTY');
  return { commit: workflow, branch, ref: `refs/heads/${branch}`, head };
}

function outputDirectory(env) {
  const configured = env.RELEASE_HANDOFF_DIR || path.join(ROOT, 'artifacts', 'release-handoff');
  if (typeof configured !== 'string' || !configured.trim()) fail('RELEASE_CONTEXT_OUTPUT_INVALID');
  const directory = path.resolve(configured);
  const artifactsRoot = path.join(ROOT, 'artifacts');
  if (fs.existsSync(artifactsRoot) && fs.lstatSync(artifactsRoot).isSymbolicLink()) fail('RELEASE_CONTEXT_OUTPUT_INVALID');
  const relative = path.relative(artifactsRoot, directory);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) fail('RELEASE_CONTEXT_OUTPUT_INVALID');
  let cursor = artifactsRoot;
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) fail('RELEASE_CONTEXT_OUTPUT_INVALID');
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.statSync(directory);
  if (!stat.isDirectory()) fail('RELEASE_CONTEXT_OUTPUT_INVALID');
  return directory;
}

function exclusiveJson(directory, name, value) {
  const target = path.join(directory, name);
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return target;
}

function ciEvidenceRef(env) {
  const metadata = [env.GITHUB_SERVER_URL, env.GITHUB_REPOSITORY, env.GITHUB_RUN_ID].map(value => String(value || '').trim());
  if (metadata.every(Boolean)) {
    let server;
    try { server = new URL(metadata[0]); }
    catch { fail('RELEASE_CONTEXT_CI_METADATA_INVALID'); }
    if (server.protocol !== 'https:' || server.username || server.password || server.origin !== metadata[0]
      || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(metadata[1]) || !/^[1-9]\d*$/.test(metadata[2])) {
      fail('RELEASE_CONTEXT_CI_METADATA_INVALID');
    }
    return `${metadata[0]}/${metadata[1]}/actions/runs/${metadata[2]}`;
  }
  if (metadata.some(Boolean)) fail('RELEASE_CONTEXT_CI_METADATA_INVALID');
  return null;
}

export function verifyReleaseContext({ env = process.env, head = git('rev-parse', 'HEAD') } = {}) {
  const result = validateCandidate(env, head);
  process.stdout.write(`Release context verified for ${result.commit}.\n`);
  return result;
}

export function prepareReleaseContext({ env = process.env, head = git('rev-parse', 'HEAD'), readiness } = {}) {
  const identity = validateFinalPush(env, head);
  const policy = readiness || JSON.parse(fs.readFileSync(path.join(ROOT, 'release-readiness.json'), 'utf8'));
  const tree = git('rev-parse', `${identity.commit}^{tree}`);
  const handoff = {
    schemaVersion: 1,
    evidenceType: 'cnyos_release_context',
    artifactClassification: 'final-main-handoff',
    finalReleaseCommit: identity.commit,
    commit: identity.commit,
    tree,
    source: { event: 'push', ref: identity.ref, branch: identity.branch },
    ciEvidenceRef: ciEvidenceRef(env),
    productionApproval: 'pending_external_exact_commit_attestation',
    approvedForProduction: false,
    dispatchInputs: STAGES.map(stage => ({
      workflow: stage.workflow,
      ref: identity.branch,
      inputs: { release_commit: identity.commit, confirmation: stage.confirmation }
    }))
  };
  const directory = outputDirectory(env);
  if (['release-context.json', 'attestation-draft.json'].some(name => fs.existsSync(path.join(directory, name)))) {
    fail('RELEASE_CONTEXT_OUTPUT_EXISTS');
  }
  const draft = prepareProductionAttestation(policy, identity.commit);
  const contextPath = exclusiveJson(directory, 'release-context.json', handoff);
  const draftPath = exclusiveJson(directory, 'attestation-draft.json', draft);
  const summary = [
    `Release handoff prepared for ${identity.commit}.`,
    `Tree: ${tree}`,
    'Production attestation draft is pending and unapproved; preparation does not authorize promotion, deployment, or patient-data admission.',
    `Artifacts: ${path.basename(contextPath)}, ${path.basename(draftPath)}`
  ].join('\n') + '\n';
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  process.stdout.write(summary);
  return { ...handoff, directory, contextPath, draftPath };
}

export { validateCandidate, validateFinalPush, STAGES };

if (process.argv[1] && fs.existsSync(process.argv[1])
  && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const command = process.argv[2];
    if (command === 'verify') verifyReleaseContext();
    else if (command === 'prepare') prepareReleaseContext();
    else fail('Usage: node scripts/release-context.mjs verify|prepare');
  } catch (error) {
    const safe = /^(RELEASE_CONTEXT_|Usage:)/.test(String(error?.message)) ? error.message : 'RELEASE_CONTEXT_FAILED';
    process.stderr.write(`${safe}\n`);
    process.exitCode = 1;
  }
}
