import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateTenantConfig } from './generate-tenant-config.mjs';
import { validateProductionAttestation } from './verify-production-promotion.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const target = Object.freeze({
  repository: 'apisarit/chananya-clinical-wellness-os',
  environment: 'production',
  siteId: '7da5e39e-580d-44f1-8623-605313e2fb2b',
  origin: 'https://cnyos.netlify.app',
  hostname: 'cnyos.netlify.app'
});
export const variables = Object.freeze({
  PRODUCTION_NETLIFY_SITE_ID: target.siteId,
  PRODUCTION_SITE_URL: target.origin,
  PRODUCTION_SITE_HOST: target.hostname
});

function requireCondition(condition, code) {
  if (!condition) throw new Error(code);
}

// Validate every supplied value before an API write. Never print input values.
export function prepareSetup({ commit, token, config, attestation, readiness, stagingConfig }) {
  const blockers = [];
  const requireInput = (value, code) => { if (!value) blockers.push(code); };
  requireInput(/^[a-f0-9]{40}$/i.test(commit || ''), 'EXACT_COMMIT_REQUIRED');
  requireInput(token, 'NETLIFY_AUTH_TOKEN_REQUIRED');
  requireInput(config, 'PRODUCTION_TENANT_CONFIG_REQUIRED');
  requireInput(attestation, 'EXACT_COMMIT_ATTESTATION_REQUIRED');
  if (token && (!/^\S{20,}$/.test(token) || /REPLACE|PLACEHOLDER|TODO/i.test(token))) {
    blockers.push('NETLIFY_AUTH_TOKEN_INVALID');
  }
  if (config) {
    try {
      const normalized = validateTenantConfig(config);
      requireCondition(!/REPLACE_WITH|PLACEHOLDER|YOUR_[A-Z]/i.test(normalized.database.publishableKey), 'PLACEHOLDER_DATABASE_KEY_REJECTED');
      requireCondition(normalized.auth.redirectOrigin === target.origin, 'TENANT_ORIGIN_MISMATCH');
      requireCondition(!/(?:^|[-_.])(staging|stage|stg|nonprod|test)(?:$|[-_.])/i.test(normalized.deploymentId), 'STAGING_TENANT_REJECTED');
      requireCondition(!/(?:^|[-_.])(staging|stage|stg|nonprod|test)(?:$|[-_.])/i.test(normalized.tenant.expectedClinicCode), 'STAGING_CLINIC_REJECTED');
      requireCondition(normalized.database.url !== stagingConfig.database.url, 'STAGING_DATABASE_REJECTED');
      requireCondition(normalized.tenant.expectedClinicId !== stagingConfig.tenant.expectedClinicId, 'STAGING_CLINIC_ID_REJECTED');
    } catch {
      blockers.push('PRODUCTION_TENANT_CONFIG_INVALID_OR_STAGING');
    }
  }
  if (attestation) {
    try { validateProductionAttestation(readiness, attestation, commit); }
    catch { blockers.push('PRODUCTION_ATTESTATION_NOT_ACCEPTED'); }
  }
  return {
    commit,
    blockers,
    variables,
    secrets: {
      NETLIFY_AUTH_TOKEN: token,
      CLINICAL_OS_PRODUCTION_CONFIG_JSON: config ? JSON.stringify(config) : null,
      PRODUCTION_RELEASE_ATTESTATION_JSON: attestation ? JSON.stringify(attestation) : null
    }
  };
}

export function publicPlan(plan) {
  return {
    mode: 'plan',
    repository: target.repository,
    environment: target.environment,
    releaseCommit: plan.commit,
    status: plan.blockers.length ? 'blocked' : 'inputs_validated',
    variables: plan.variables,
    secretNames: Object.keys(plan.secrets),
    blockers: plan.blockers,
    note: 'Plan only. No credentials, configuration, approval evidence or deployment have been written.'
  };
}

function gh(args, input) {
  const result = spawnSync('gh', args, {
    cwd: root,
    input,
    encoding: 'utf8',
    timeout: 45000,
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_HOST: 'github.com', GH_DEBUG: '' }
  });
  // stdout/stderr can contain credentials or account data. Never forward them.
  requireCondition(!result.error && result.status === 0, 'GITHUB_CLI_ACTION_FAILED');
  return result.stdout;
}

export function applySetup(plan, run = gh) {
  requireCondition(plan.blockers.length === 0, 'SETUP_INPUTS_BLOCKED');
  const base = `repos/${target.repository}`;
  const read = endpoint => {
    try { return JSON.parse(run(['api', '--hostname', 'github.com', endpoint])); }
    catch { throw new Error('GITHUB_PREFLIGHT_READ_FAILED'); }
  };
  run(['auth', 'status', '--hostname', 'github.com']);
  const repository = read(base);
  requireCondition(repository.permissions?.admin === true, 'GITHUB_REPOSITORY_ADMIN_REQUIRED');
  requireCondition(repository.default_branch === 'main', 'DEFAULT_BRANCH_MISMATCH');
  const branch = read(`${base}/branches/main`);
  requireCondition(branch.commit?.sha === plan.commit, 'REMOTE_MAIN_COMMIT_MISMATCH');
  requireCondition(branch.protected === true, 'MAIN_BRANCH_PROTECTION_REQUIRED');
  const environment = read(`${base}/environments/${target.environment}`);
  requireCondition(environment.name === target.environment, 'PRODUCTION_ENVIRONMENT_REQUIRED');
  requireCondition(environment.protection_rules?.some(rule => rule.type === 'required_reviewers' && rule.reviewers?.length > 0), 'PRODUCTION_REVIEWER_PROTECTION_REQUIRED');
  requireCondition(environment.deployment_branch_policy?.protected_branches || environment.deployment_branch_policy?.custom_branch_policies, 'PRODUCTION_BRANCH_POLICY_REQUIRED');
  if (environment.deployment_branch_policy.custom_branch_policies) {
    const policy = read(`${base}/environments/${target.environment}/deployment-branch-policies`);
    requireCondition(policy.branch_policies?.some(rule => rule.name === 'main' && (!rule.type || rule.type === 'branch')), 'PRODUCTION_MAIN_BRANCH_RULE_REQUIRED');
  }

  const completed = [];
  const write = (kind, name, value) => {
    try {
      // Secret values travel only on stdin. gh encrypts secrets before upload.
      run([kind, 'set', name, '--repo', target.repository, '--env', target.environment], value);
      completed.push(name);
    } catch {
      const error = new Error('GITHUB_SETUP_WRITE_FAILED');
      error.completedKeys = [...completed];
      error.failedKey = name;
      throw error;
    }
  };
  for (const [name, value] of Object.entries(plan.variables)) write('variable', name, value);
  // Store the already-validated approval last. Never manufacture or modify it.
  for (const [name, value] of Object.entries(plan.secrets)) write('secret', name, value);
  return {
    mode: 'apply', status: 'configured', repository: target.repository,
    environment: target.environment, releaseCommit: plan.commit, completedKeys: completed,
    deploymentStarted: false,
    note: 'Configuration saved. The existing protected production workflow still performs release checks.'
  };
}

export function parseArgs(args) {
  const options = { apply: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--apply') { requireCondition(!options.apply, 'DUPLICATE_ARGUMENT'); options.apply = true; }
    else if (arg === '--config' || arg === '--attestation') {
      const key = arg.slice(2);
      requireCondition(!options[key] && args[i + 1] && !args[i + 1].startsWith('--'), 'INPUT_FILE_ARGUMENT_REQUIRED');
      options[key] = path.resolve(args[++i]);
    } else throw new Error('UNKNOWN_SETUP_ARGUMENT');
  }
  return options;
}

function readJson(filename) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch { throw new Error('SETUP_JSON_FILE_UNREADABLE_OR_INVALID'); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const gitResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
    requireCondition(gitResult.status === 0, 'GIT_CHECKOUT_REQUIRED');
    if (options.apply) {
      const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' });
      requireCondition(status.status === 0 && !status.stdout.trim(), 'CLEAN_TRACKED_CHECKOUT_REQUIRED');
    }
    const plan = prepareSetup({
      commit: gitResult.stdout.trim(),
      token: (process.env.NETLIFY_AUTH_TOKEN || '').trim(),
      config: options.config ? readJson(options.config) : null,
      attestation: options.attestation ? readJson(options.attestation) : null,
      readiness: readJson(path.join(root, 'release-readiness.json')),
      stagingConfig: readJson(path.join(root, 'config/tenant.cnyos-staging.json'))
    });
    process.stdout.write(`${JSON.stringify(options.apply ? applySetup(plan) : publicPlan(plan), null, 2)}\n`);
  } catch (error) {
    // Only our constant error codes and fixed key names are exposed.
    const code = /^[A-Z_]+$/.test(error.message || '') ? error.message : 'PRODUCTION_SETUP_FAILED';
    process.stderr.write(`${JSON.stringify({ status: 'failed', code, completedKeys: error.completedKeys || [], failedKey: error.failedKey || null })}\n`);
    process.exitCode = 1;
  }
}
