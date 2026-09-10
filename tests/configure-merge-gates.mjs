import test from 'node:test';
import assert from 'node:assert/strict';
import { configure, makeClient, planPolicy, readPolicy, REPOSITORY, REQUIRED_CHECKS } from '../scripts/configure-merge-gates.mjs';

const root = `/repos/${REPOSITORY}`;
const protectionPath = `${root}/branches/main/protection`;
const base = () => ({
  url: protectionPath,
  required_status_checks: {
    strict: true, contexts: [REQUIRED_CHECKS[1]], checks: [{ context: REQUIRED_CHECKS[1], app_id: 15368 }],
  },
  required_pull_request_reviews: {
    dismiss_stale_reviews: true, require_code_owner_reviews: false,
    require_last_push_approval: true, required_approving_review_count: 1,
  },
  required_signatures: { enabled: false }, enforce_admins: { enabled: true },
  required_linear_history: { enabled: false }, allow_force_pushes: { enabled: false },
  allow_deletions: { enabled: false }, block_creations: { enabled: false },
  required_conversation_resolution: { enabled: false }, lock_branch: { enabled: false }, allow_fork_syncing: { enabled: false },
});
function response(plan, signatures = false) {
  const copy = structuredClone(plan);
  copy.required_status_checks.contexts = [...new Set(copy.required_status_checks.checks.map(check => check.context))];
  for (const [key, value] of Object.entries(copy)) if (typeof value === 'boolean') copy[key] = { enabled: value };
  for (const restrictions of [copy.restrictions, copy.required_pull_request_reviews?.dismissal_restrictions,
    copy.required_pull_request_reviews?.bypass_pull_request_allowances]) {
    if (restrictions) for (const type of ['users', 'teams', 'apps']) {
      restrictions[type] = restrictions[type].map(name => type === 'users' ? { login: name } : { slug: name });
    }
  }
  copy.required_signatures = { enabled: signatures };
  return copy;
}
function fixture({ protection = base(), failure, afterPut, concurrent } = {}) {
  let reads = 0;
  const state = { protection, autoMerge: false, calls: [] };
  const request = async (method, path, body) => {
    state.calls.push({ method, path, body: structuredClone(body) });
    const fail = failure?.(method, path, state);
    if (fail) throw Object.assign(new Error('Simulated GitHub failure'), { status: fail });
    if (path === root && method === 'GET') return { full_name: REPOSITORY, default_branch: 'main', permissions: { admin: true }, allow_auto_merge: state.autoMerge };
    if (path === `${root}/branches/main`) return { protected: protection !== null, commit: { sha: 'abc123' } };
    if (path.includes('/check-runs')) return { check_runs: [{ name: REQUIRED_CHECKS[1], app: { slug: 'github-actions', id: 15368 } }] };
    if (path === protectionPath && method === 'GET') {
      reads += 1;
      if (reads === 2 && concurrent) state.protection = concurrent(structuredClone(state.protection));
      if (state.protection === null) throw Object.assign(new Error('Unprotected'), { status: 404 });
      return structuredClone(state.protection);
    }
    if (path === protectionPath && method === 'PUT') {
      state.protection = response(body, state.protection?.required_signatures.enabled ?? false);
      afterPut?.(state.protection);
      return structuredClone(state.protection);
    }
    if (path === root && method === 'PATCH') { state.autoMerge = body.allow_auto_merge; return {}; }
    throw new Error(`Unexpected request: ${method} ${path}`);
  };
  return { request, state };
}
const writes = state => state.calls.filter(call => call.method !== 'GET');

test('planning is read-only and retains the existing Actions-bound required check', async () => {
  const { request, state } = fixture();
  const result = await configure({ request });
  assert.equal(result.applied, false);
  assert.deepEqual(writes(state), []);
  assert.deepEqual(result.protection.required_status_checks.checks, [
    { context: REQUIRED_CHECKS[1], app_id: 15368 }, { context: REQUIRED_CHECKS[0], app_id: 15368 },
  ]);
});

test('apply verifies protection before enabling repository auto-merge and never mutates PRs', async () => {
  const { request, state } = fixture();
  assert.equal((await configure({ request, apply: true })).applied, true);
  assert.deepEqual(writes(state).map(call => [call.method, call.path]), [['PUT', protectionPath], ['PATCH', root]]);
  const putIndex = state.calls.findIndex(call => call.method === 'PUT');
  // Regression for the live API's oneOf validation: contexts + checks => 422.
  assert.equal('contexts' in state.calls[putIndex].body.required_status_checks, false);
  assert.equal(state.calls[putIndex].body.required_status_checks.checks.length, 2);
  assert.equal(state.calls[putIndex + 1].path, protectionPath);
  assert.equal(state.calls[putIndex + 1].method, 'GET');
  assert.equal(state.protection.required_conversation_resolution.enabled, true);
  assert.equal(state.autoMerge, true);
});

test('preserves stronger reviews, signatures, app bindings, push restrictions, and bypass/dismissal lists', async () => {
  const protection = base();
  protection.required_signatures.enabled = true;
  protection.required_linear_history.enabled = true;
  protection.required_pull_request_reviews.required_approving_review_count = 3;
  protection.required_pull_request_reviews.require_code_owner_reviews = true;
  const actors = { users: [{ login: 'owner' }], teams: [{ slug: 'security' }], apps: [{ slug: 'release-bot' }] };
  protection.restrictions = actors;
  protection.required_pull_request_reviews.dismissal_restrictions = actors;
  protection.required_pull_request_reviews.bypass_pull_request_allowances = actors;
  protection.required_status_checks.contexts.push('Security scan');
  protection.required_status_checks.checks.push({ context: 'Security scan', app_id: 22 });
  const { request, state } = fixture({ protection });
  await configure({ request, apply: true });
  const body = writes(state)[0].body;
  assert.equal(body.required_pull_request_reviews.required_approving_review_count, 3);
  assert.equal(body.required_pull_request_reviews.require_code_owner_reviews, true);
  assert.equal(body.required_linear_history, true);
  assert.deepEqual(body.restrictions, { users: ['owner'], teams: ['security'], apps: ['release-bot'] });
  assert.deepEqual(body.required_pull_request_reviews.dismissal_restrictions, body.restrictions);
  assert.deepEqual(body.required_pull_request_reviews.bypass_pull_request_allowances, body.restrictions);
  assert.ok(body.required_status_checks.checks.some(check => check.context === 'Security scan' && check.app_id === 22));
  assert.equal('required_signatures' in body, false);
  assert.equal(state.protection.required_signatures.enabled, true);
});

for (const status of [403, 404, 500]) test(`protection GET ${status} on a protected branch cannot authorize replacement`, async () => {
  const { request, state } = fixture({ failure: (method, path) => method === 'GET' && path === protectionPath ? status : null });
  await assert.rejects(configure({ request, apply: true }));
  assert.deepEqual(writes(state), []);
});

test('can create protection only when main explicitly reports unprotected', async () => {
  const { request, state } = fixture({ protection: null });
  await configure({ request, apply: true });
  assert.equal(state.protection.required_pull_request_reviews.required_approving_review_count, 1);
  assert.equal(state.protection.enforce_admins.enabled, true);
});

test('unknown protection fields abort instead of being discarded by PUT', async () => {
  const protection = { ...base(), required_deployments: ['production'] };
  const { request, state } = fixture({ protection });
  await assert.rejects(configure({ request, apply: true }), /Unsupported protection field/);
  assert.deepEqual(writes(state), []);
});

test('detects concurrent admin edits before writing', async () => {
  const { request, state } = fixture({ concurrent: policy => {
    policy.required_pull_request_reviews.required_approving_review_count = 4;
    return policy;
  } });
  await assert.rejects(configure({ request, apply: true }), /changed during planning/);
  assert.deepEqual(writes(state), []);
});

for (const [name, afterPut] of [
  ['reviews', policy => { policy.required_pull_request_reviews.required_approving_review_count = 0; }],
  ['strict checks', policy => { policy.required_status_checks.strict = false; }],
  ['last push', policy => { policy.required_pull_request_reviews.require_last_push_approval = false; }],
  ['admin enforcement', policy => { policy.enforce_admins.enabled = false; }],
  ['signature changes', policy => { policy.required_signatures.enabled = true; }],
  ['check app binding', policy => { policy.required_status_checks.checks[0].app_id = 99; }],
]) test(`readback mismatch in ${name} never enables auto-merge`, async () => {
  const { request, state } = fixture({ afterPut });
  await assert.rejects(configure({ request, apply: true }), /readback differs/);
  assert.equal(state.autoMerge, false);
  assert.equal(writes(state).length, 1);
});

test('failed protection write never enables auto-merge', async () => {
  const { request, state } = fixture({ failure: method => method === 'PUT' ? 422 : null });
  await assert.rejects(configure({ request, apply: true }));
  assert.equal(state.autoMerge, false);
  assert.ok(!state.calls.some(call => call.method === 'PATCH'));
});

test('failed auto-merge update leaves the verified protection in place and reports failure', async () => {
  const { request, state } = fixture({ failure: method => method === 'PATCH' ? 403 : null });
  await assert.rejects(configure({ request, apply: true }));
  assert.equal(state.protection.required_conversation_resolution.enabled, true);
  assert.equal(state.autoMerge, false);
});

test('app binding must come from existing GitHub Actions evidence', () => {
  assert.throws(() => planPolicy(base(), -1), /Verified GitHub Actions/);
  assert.throws(() => planPolicy(base(), undefined), /Verified GitHub Actions/);
});

test('readPolicy faithfully reports weak controls; it never repairs readback values', () => {
  const policy = base();
  policy.enforce_admins.enabled = false;
  policy.required_pull_request_reviews.required_approving_review_count = 0;
  assert.equal(readPolicy(policy).enforce_admins, false);
  assert.equal(readPolicy(policy).required_pull_request_reviews.required_approving_review_count, 0);
});

test('client requires explicit admin credential and omits API error bodies from logs', async () => {
  assert.throws(() => makeClient(''), /no GITHUB_TOKEN fallback/);
  const request = makeClient('fixture-secret', async (url, options) => {
    assert.ok(url.startsWith('https://api.github.com/repos/'));
    assert.equal(options.redirect, 'error');
    return { ok: false, status: 403, json: () => ({ message: 'fixture-secret' }) };
  });
  await assert.rejects(request('GET', protectionPath), error => error.status === 403 && !error.message.includes('fixture-secret'));
});
