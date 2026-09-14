import { pathToFileURL } from 'node:url';

export const REPOSITORY = 'apisarit/chananya-clinical-wellness-os';
export const REQUIRED_CHECKS = ['Run Automated Tests', 'Source + PostgreSQL + release evidence'];
const root = `/repos/${REPOSITORY}`;
const protectionPath = `${root}/branches/main/protection`;
const flagNames = ['required_linear_history', 'allow_force_pushes', 'allow_deletions',
  'block_creations', 'required_conversation_resolution', 'lock_branch', 'allow_fork_syncing'];

function keys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unsupported ${label} field: ${key}`);
  }
}

function actors(value) {
  if (value == null) return null;
  keys(value, ['url', 'users_url', 'teams_url', 'apps_url', 'users', 'teams', 'apps'], 'actor restriction');
  return Object.fromEntries(['users', 'teams', 'apps'].map(type => {
    if (!Array.isArray(value[type])) throw new Error(`Missing ${type} restriction list`);
    return [type, value[type].map(actor => {
      const name = type === 'users' ? actor.login : actor.slug;
      if (typeof name !== 'string' || !name) throw new Error('Invalid restriction actor');
      return name;
    })];
  }));
}

function enabled(value, label) {
  if (value == null) return false;
  if (typeof value.enabled !== 'boolean') throw new Error(`Invalid ${label} flag`);
  return value.enabled;
}

// Normalize GET-only metadata away WITHOUT strengthening any observed value.
// Unknown policy fields abort instead of disappearing from a replacement PUT.
export function readPolicy(value) {
  if (value == null) return null;
  keys(value, ['url', 'required_status_checks', 'required_pull_request_reviews', 'required_signatures',
    'enforce_admins', 'restrictions', ...flagNames], 'protection');
  const result = { enforce_admins: enabled(value.enforce_admins, 'enforce_admins'),
    restrictions: actors(value.restrictions), required_status_checks: null, required_pull_request_reviews: null };
  for (const name of flagNames) result[name] = enabled(value[name], name);
  if (value.required_status_checks) {
    const status = value.required_status_checks;
    keys(status, ['url', 'contexts_url', 'strict', 'contexts', 'checks', 'enforcement_level'], 'status checks');
    if (typeof status.strict !== 'boolean' || !Array.isArray(status.contexts) || !Array.isArray(status.checks)) {
      throw new Error('Unsupported status-check representation');
    }
    const checks = status.checks.map(check => {
      keys(check, ['context', 'app_id'], 'check');
      if (typeof check.context !== 'string' || !check.context ||
          !(check.app_id == null || Number.isInteger(check.app_id))) throw new Error('Invalid check binding');
      return { context: check.context, app_id: check.app_id ?? -1 };
    });
    for (const context of status.contexts) {
      if (typeof context !== 'string' || !context) throw new Error('Invalid status context');
      if (!checks.some(check => check.context === context)) throw new Error('Missing status check binding');
    }
    result.required_status_checks = { strict: status.strict, contexts: [...new Set(checks.map(check => check.context))], checks };
  }
  if (value.required_pull_request_reviews) {
    const review = value.required_pull_request_reviews;
    keys(review, ['url', 'dismissal_restrictions', 'bypass_pull_request_allowances', 'dismiss_stale_reviews',
      'require_code_owner_reviews', 'require_last_push_approval', 'required_approving_review_count'], 'review');
    const copy = {};
    for (const name of ['dismiss_stale_reviews', 'require_code_owner_reviews', 'require_last_push_approval']) {
      if (typeof review[name] !== 'boolean') throw new Error(`Missing review flag ${name}`);
      copy[name] = review[name];
    }
    if (!Number.isInteger(review.required_approving_review_count) || review.required_approving_review_count < 0 ||
        review.required_approving_review_count > 6) throw new Error('Invalid review count');
    copy.required_approving_review_count = review.required_approving_review_count;
    for (const name of ['dismissal_restrictions', 'bypass_pull_request_allowances']) {
      if (review[name] != null) copy[name] = actors(review[name]);
    }
    result.required_pull_request_reviews = copy;
  }
  return result;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export function planPolicy(before, actionsAppId) {
  if (!Number.isInteger(actionsAppId) || actionsAppId < 1) throw new Error('Verified GitHub Actions app binding required');
  const plan = structuredClone(readPolicy(before) ?? {
    restrictions: null, required_status_checks: null, required_pull_request_reviews: null,
    ...Object.fromEntries(flagNames.map(name => [name, false])),
  });
  plan.enforce_admins = true;
  plan.required_conversation_resolution = true;
  plan.required_pull_request_reviews = {
    require_code_owner_reviews: false,
    ...plan.required_pull_request_reviews,
    dismiss_stale_reviews: true,
    require_last_push_approval: true,
    required_approving_review_count: Math.max(1, plan.required_pull_request_reviews?.required_approving_review_count ?? 0),
  };
  const checks = plan.required_status_checks?.checks ?? [];
  for (const context of REQUIRED_CHECKS) {
    if (!checks.some(check => check.context === context && check.app_id === actionsAppId)) {
      checks.push({ context, app_id: actionsAppId });
    }
  }
  plan.required_status_checks = { strict: true, contexts: [...new Set(checks.map(check => check.context))], checks };
  return plan;
}

export function makeClient(token, fetchImpl = fetch) {
  if (!token) throw new Error('REPOSITORY_ADMIN_TOKEN is required; no GITHUB_TOKEN fallback is allowed');
  return async (method, path, body) => {
    const response = await fetchImpl(`https://api.github.com${path}`, {
      method, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2026-03-10', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20000), redirect: 'error',
    });
    if (!response.ok) {
      const error = new Error(`GitHub ${method} ${path} returned HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.status === 204 ? null : response.json();
  };
}

export async function configure({ request, apply = false }) {
  const repository = await request('GET', root);
  if (repository.full_name !== REPOSITORY || repository.default_branch !== 'main' || !repository.permissions?.admin) {
    throw new Error('Expected repository, default main branch and administrator access are required');
  }
  const branch = await request('GET', `${root}/branches/main`);
  let before;
  try { before = await request('GET', protectionPath); }
  catch (error) {
    if (error.status !== 404 || branch.protected !== false) throw error;
    before = null;
  }
  // Discover the Actions application from existing CI on main, not user input.
  const runs = await request('GET', `${root}/commits/${encodeURIComponent(branch.commit.sha)}/check-runs?per_page=100`);
  const actions = runs.check_runs?.find(run => run.name === REQUIRED_CHECKS[1] && run.app?.slug === 'github-actions');
  if (!actions) throw new Error('The existing source-contract check from GitHub Actions must have run on main');
  const plan = planPolicy(before, actions.app.id);
  if (!apply) return { applied: false, repository: REPOSITORY, branch: 'main', protection: plan, allow_auto_merge: true };
  // Detect an intervening administrator edit before replacing policy. The API
  // has no transactional compare-and-swap; do not edit settings concurrently.
  let latest;
  try { latest = await request('GET', protectionPath); }
  catch (error) {
    if (error.status !== 404 || before !== null) throw error;
    latest = null;
  }
  if (!same(readPolicy(before), readPolicy(latest)) ||
      enabled(before?.required_signatures, 'signatures') !== enabled(latest?.required_signatures, 'signatures')) {
    throw new Error('Protection changed during planning; inspect and rerun');
  }
  const payload = structuredClone(plan);
  // The 2026-03-10 API accepts either contexts OR checks, not both. Use checks
  // so application bindings survive; GET returns both representations.
  delete payload.required_status_checks.contexts;
  await request('PUT', protectionPath, payload);
  const saved = await request('GET', protectionPath);
  if (!same(readPolicy(saved), plan) ||
      enabled(saved.required_signatures, 'signatures') !== enabled(before?.required_signatures, 'signatures')) {
    throw new Error('Protection readback differs from plan; auto-merge was not enabled by this run');
  }
  await request('PATCH', root, { allow_auto_merge: true });
  const final = await request('GET', root);
  if (final.allow_auto_merge !== true) throw new Error('Could not verify repository auto-merge; protection was already applied');
  return { applied: true, repository: REPOSITORY, branch: 'main', required_checks: REQUIRED_CHECKS,
    minimum_approvals: plan.required_pull_request_reviews.required_approving_review_count, allow_auto_merge: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== '--apply')) throw new Error('Usage: node scripts/configure-merge-gates.mjs [--apply]');
    if (process.env.GITHUB_ACTIONS === 'true' && (process.env.GITHUB_REPOSITORY !== REPOSITORY ||
        process.env.GITHUB_REF !== 'refs/heads/main' || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch')) {
      throw new Error('Actions execution requires a manual dispatch on the trusted main branch');
    }
    const result = await configure({ request: makeClient(process.env.REPOSITORY_ADMIN_TOKEN), apply: args.includes('--apply') });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
