import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { PLATFORM_FEATURES, normalizePlatformLink, normalizePlatformPlan, resolvePlatformFeatures, platformPlanInput, platformPreflight } from '../platform-config.js';
import { handlePlatformConsole, platformTargets } from '../netlify/functions/platform-console.mts';
import { validatePreviewJob, canonicalPreviewAsset } from '../scripts/platform-preview-deploy.mjs';
import { buildNetlifyPublish } from '../scripts/build-netlify-publish.mjs';
import { validateTenantConfig, buildDeployManifest } from '../scripts/generate-tenant-config.mjs';

let count = 0;
const test = async (name, work) => { await work(); count++; console.log(`PASS ${name}`); };
const origin = 'https://synthetic-owner-staging.netlify.app';
const time = Date.parse('2026-09-06T02:00:00Z');
const owner = { id: '11111111-1111-4111-a111-111111111111', email: 'owner@example.com', email_confirmed_at: '2026-01-01', app_metadata: { provider: 'google', providers: ['google'] }, identities: [{ provider: 'google' }] };
const target = { key: 'example-staging', label: 'Example', siteId: '22222222-2222-4222-a222-222222222222', siteOrigin: 'https://example-staging.netlify.app', clinicId: '33333333-3333-4333-a333-333333333333', clinicCode: 'EXAMPLE-STG', projectRef: 'abcdefghijklmnopqrst', environment: 'staging', driveRootId: 'synthetic_folder_12345678' };
const input = { name: 'Synthetic Clinic', slug: 'synthetic-clinic', targetKey: target.key, site: target.siteOrigin, database: `https://${target.projectRef}.supabase.co`, drive: target.driveRootId, nas: '', features: ['u-synthesise'] };
const source = 'a'.repeat(40);
const tokenFor = (user = owner, timestamp = time / 1000) => `header.${Buffer.from(JSON.stringify({ sub: user.id, email: user.email, amr: [{ method: 'oauth', timestamp }] })).toString('base64url')}.verified-by-mocked-server`;
const settings = { CNYOS_OWNER_CONTROL_ENABLED: 'true', CNYOS_PLATFORM_CONTROL_ENABLED: 'true',
  CNYOS_OWNER_EXPECTED_PROJECT_REF: 'abcdefghijklmnopqrst', SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'synthetic-secret-never-return', CNYOS_OWNER_EMAILS: owner.email,
  CNYOS_PLATFORM_OWNER_USER_IDS: owner.id, CLINICAL_OS_SOURCE_COMMIT: source,
  CNYOS_OWNER_EXPECTED_NETLIFY_SITE_ID: '44444444-4444-4444-a444-444444444444', CNYOS_OWNER_EXPECTED_SITE_ORIGIN: origin,
  CNYOS_PLATFORM_TARGETS_JSON: JSON.stringify([target]), CNYOS_PLATFORM_GITHUB_TOKEN: 'synthetic-dispatch-secret-never-return' };
const context = { site: { id: settings.CNYOS_OWNER_EXPECTED_NETLIFY_SITE_ID, url: origin }, deploy: { id: 'deploy_synthetic_123', context: 'production', published: true } };
class MemoryStore {
  map = new Map(); version = 0;
  async get(key) { return structuredClone(this.map.get(key)?.data || null); }
  async getWithMetadata(key) { return structuredClone(this.map.get(key) || null); }
  async setJSON(key, data, opts = {}) {
    const old = this.map.get(key);
    if ((opts.onlyIfNew && old) || (opts.onlyIfMatch && old?.etag !== opts.onlyIfMatch)) return { modified: false };
    const etag = String(++this.version); this.map.set(key, { data: structuredClone(data), etag }); return { modified: true, etag };
  }
  async list() { return { blobs: [...this.map.keys()].map(key => ({ key })) }; }
}
function setup(overrides = {}) {
  let dispatches = 0, authCalls = 0, providerCalls = 0;
  const store = new MemoryStore();
  const deps = { getEnv: key => settings[key] || '', store, now: () => time,
    ownerRequest: async options => { authCalls++; assert.equal(options.resource, '/auth/v1/user'); return owner; },
    googleFetch: async () => { providerCalls++; throw new Error('UNEXPECTED_GOOGLE_REQUEST'); },
    githubFetch: async (url, options) => { assert.ok(url.startsWith('https://api.github.com/repos/apisarit/chananya-clinical-wellness-os/actions/workflows/platform-preview-deploy.yml'));
      assert.equal(options.redirect, 'error'); if (options.method === 'POST') { dispatches++; return new Response(null, { status: 204 }); }
      return Response.json({ workflow_runs: [] }); }, ...overrides };
  const call = async (body, opts = {}) => {
    const response = await handlePlatformConsole(new Request(`${opts.origin || origin}/api/platform-console${opts.query || ''}`, {
      method: body ? 'POST' : 'GET', headers: { Origin: opts.headerOrigin || opts.origin || origin, Authorization: `Bearer ${opts.token || tokenFor()}`, ...(opts.headers || {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }), opts.context || context, deps);
    const payload = await response.json(); const serialized = JSON.stringify(payload);
    assert.ok(!serialized.includes(settings.SUPABASE_SERVICE_ROLE_KEY)); assert.ok(!serialized.includes(settings.CNYOS_PLATFORM_GITHUB_TOKEN));
    return { status: response.status, payload };
  };
  return { store, call, deps, counts: () => ({ dispatches, authCalls, providerCalls }) };
}
const save = env => env.call({ action: 'save', requestId: randomUUID(), plan: input });
const deploy = (env, record, overrides = {}) => env.call({ action: 'deploy-preview', requestId: randomUUID(), planId: record.id, planHash: record.hash, confirmSlug: record.plan.slug, ...overrides });

await test('normalize Drive and Supabase copied links without requesting them', () => {
  assert.equal(normalizePlatformLink('drive', `https://drive.google.com/drive/u/0/folders/${target.driveRootId}?usp=sharing`).id, target.driveRootId);
  assert.equal(normalizePlatformLink('database', `https://supabase.com/dashboard/project/${target.projectRef}/settings/general`).url, input.database);
  assert.equal(normalizePlatformLink('nas', 'https://192.168.1.10/backups').requiresAgent, true);
  assert.equal(normalizePlatformLink('nas', ''), null);
});
for (const [kind, value] of [
  ['drive', 'https://drive.google.com.evil.example/drive/folders/synthetic_folder_12345678'],
  ['drive', 'https://drive.google.com/file/d/synthetic_file_123456/view'],
  ['database', 'https://abcdefghijklmnopqrst.supabase.co/rest/v1/patients'],
  ['database', 'postgres://user:password@host/db'], ['nas', 'https://user:password@nas.example.com/path'],
  ['nas', 'http://nas.example.com/path'], ['nas', 'https://nas.example.com/path?access_token=secret'],
  ['site', 'https://example-staging.netlify.app/api/owner-subscription'], ['site', 'https://example-staging.netlify.app.evil.example']
]) await test(`reject unsafe ${kind} input`, () => assert.throws(() => normalizePlatformLink(kind, value), /PLATFORM_/));
await test('resolve feature dependencies and reject unknown features', () => {
  assert.deepEqual(resolvePlatformFeatures(['quality']), ['core', 'knowledge', 'clinical', 'pharmacy', 'production', 'quality']);
  assert.throws(() => resolvePlatformFeatures(['backdoor']), /FEATURES_INVALID/);
  assert.throws(() => normalizePlatformPlan({ ...input, serviceRoleKey: 'secret' }), /UNKNOWN_FIELD_DENIED/);
});
await test('registry rejects duplicate database identities', () => {
  assert.throws(() => platformTargets(JSON.stringify([target, { ...target, key: 'second', siteId: randomUUID() }])), /REGISTRY_INVALID/);
});
await test('a pasted destination is pending until its connection is proven', () => {
  const result = platformPreflight(normalizePlatformPlan(input), [target], { dispatcherReady: true });
  assert.equal(result.canDeployPreview, true); assert.equal(result.canDeployProduction, false);
  assert.equal(result.checks.find(item => item.id === 'drive').status, 'pending');
  assert.equal(platformPreflight(normalizePlatformPlan({ ...input, database: 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co' }), [target], { dispatcherReady: true }).canDeployPreview, false);
});
await test('Google Owner plus pinned platform UUID can create and read an audited immutable plan', async () => {
  const app = setup(); const first = await save(app); assert.equal(first.status, 200);
  assert.equal(first.payload.record.plan.sourceCommit, source); assert.equal(first.payload.record.events[0].actor, owner.email);
  const list = await app.call(); assert.equal(list.payload.role, 'platform_owner'); assert.equal(list.payload.records.length, 1);
  const one = await app.call(null, { query: `?planId=${first.payload.record.id}` }); assert.equal(one.payload.record.hash, first.payload.record.hash);
});
await test('clinic super admin without a platform UUID cannot access plans', async () => {
  const user = { ...owner, id: randomUUID(), user_metadata: { role: 'platform_owner', system_role: 'super_admin' } };
  const app = setup({ ownerRequest: async () => user });
  assert.equal((await app.call(null, { token: tokenFor(user) })).status, 403); assert.equal(app.store.map.size, 0);
});
await test('preview, copied site and cross-origin requests fail before authentication', async () => {
  const app = setup();
  assert.equal((await app.call(null, { context: { ...context, deploy: { ...context.deploy, context: 'deploy-preview', published: false } } })).status, 403);
  assert.equal((await app.call(null, { origin: 'https://copied.netlify.app' })).status, 503);
  assert.equal((await app.call(null, { headerOrigin: 'https://evil.example' })).status, 403);
  assert.equal(app.counts().authCalls, 0);
});
await test('save retries are idempotent and a reused ID cannot overwrite a plan', async () => {
  const app = setup(), id = randomUUID(), body = { action: 'save', requestId: id, plan: input };
  const first = await app.call(body), second = await app.call(body);
  assert.deepEqual(second.payload.record, first.payload.record);
  assert.equal((await app.call({ ...body, plan: { ...input, name: 'Changed Name' } })).status, 409);
});
await test('recent owner confirmation dispatches only an exact stored preview plan', async () => {
  const app = setup(), saved = (await save(app)).payload.record;
  assert.equal((await deploy(app, saved, { confirmSlug: 'wrong' })).status, 409);
  assert.equal(app.counts().dispatches, 0);
  const result = await deploy(app, saved); assert.equal(result.status, 202); assert.equal(result.payload.record.deployment.state, 'queued');
  await deploy(app, saved); assert.equal(app.counts().dispatches, 1);
});
await test('stale Google sign-in cannot deploy', async () => {
  const app = setup(), record = (await save(app)).payload.record;
  const result = await app.call({ action: 'deploy-preview', requestId: randomUUID(), planId: record.id, planHash: record.hash, confirmSlug: record.plan.slug }, { token: tokenFor(owner, time / 1000 - 901) });
  assert.equal(result.payload.code, 'PLATFORM_RECENT_LOGIN_REQUIRED'); assert.equal(app.counts().dispatches, 0);
});
await test('concurrent clicks dispatch once using conditional storage', async () => {
  const app = setup(), record = (await save(app)).payload.record;
  await Promise.all([deploy(app, record), deploy(app, record)]); assert.equal(app.counts().dispatches, 1);
});
await test('unknown network outcome is retained and never retried automatically', async () => {
  let sent = 0; const app = setup({ githubFetch: async (url, options) => { if (options.method === 'POST') sent++; throw new Error(settings.CNYOS_PLATFORM_GITHUB_TOKEN); } });
  const record = (await save(app)).payload.record;
  assert.equal((await deploy(app, record)).payload.record.deployment.state, 'dispatch_unknown');
  await deploy(app, record); assert.equal(sent, 1);
});
await test('missing dispatcher still permits drafting without a fake successful deploy', async () => {
  const app = setup({ getEnv: key => key === 'CNYOS_PLATFORM_GITHUB_TOKEN' ? '' : settings[key] || '' });
  const first = await save(app); assert.equal(first.status, 200); assert.equal(first.payload.preflight.canDeployPreview, false);
  assert.equal((await deploy(app, first.payload.record)).status, 503); assert.equal(app.counts().dispatches, 0);
});
await test('changed source and production actions cannot bypass the release workflow', async () => {
  const app = setup(), record = (await save(app)).payload.record;
  app.deps.getEnv = key => key === 'CLINICAL_OS_SOURCE_COMMIT' ? 'b'.repeat(40) : settings[key] || '';
  assert.equal((await deploy(app, record)).payload.code, 'PLATFORM_SOURCE_CHANGED');
  assert.equal((await app.call({ action: 'deploy-production', requestId: randomUUID() })).status, 403);
});
await test('workflow validates immutable plan hash, source branch and independent target registry', () => {
  const plan = { ...normalizePlatformPlan(input), sourceCommit: source };
  const environment = { PLATFORM_PLAN_JSON: JSON.stringify(plan), PLATFORM_PLAN_SHA256: createHash('sha256').update(JSON.stringify(plan)).digest('hex'),
    PLATFORM_REQUEST_ID: randomUUID(), GITHUB_SHA: source, GITHUB_REF: 'refs/heads/main', NETLIFY_AUTH_TOKEN: 'synthetic', CNYOS_PLATFORM_PREVIEW_TARGETS_JSON: JSON.stringify([target]) };
  assert.equal(validatePreviewJob(environment).target.siteId, target.siteId);
  for (const override of [{ GITHUB_REF: 'refs/heads/evil' }, { GITHUB_SHA: 'b'.repeat(40) }, { PLATFORM_PLAN_SHA256: '0'.repeat(64) }, { CNYOS_PLATFORM_PREVIEW_TARGETS_JSON: '[]' }]) assert.throws(() => validatePreviewJob({ ...environment, ...override }), /PLATFORM_/);
});
await test('package build removes unselected pages and platform console from customer package', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'cnyos-platform-package-'));
  try {
    const files = ['index.html', 'login.html', 'auth-callback.html', 'app.js', 'app.css', 'auth-config.js', 'tenant-config.js', 'brand-config.js', 'platform-console.html', 'platform-config.js', 'owner-control.html', 'u-synthesise.js', ...PLATFORM_FEATURES.flatMap(item => item.pages.map(page => `${page}.html`))];
    for (const name of files) await fs.writeFile(path.join(fixture, name), 'synthetic');
    await fs.writeFile(path.join(fixture, 'deploy-manifest.json'), JSON.stringify({ package: { features: ['core', 'u-synthesise'] } }));
    const result = await buildNetlifyPublish({ cwd: fixture });
    assert.ok(result.files.includes('luopan.html')); assert.ok(result.files.includes('u-synthesise.js'));
    for (const name of ['clinical-v3.html', 'pharmacy.html', 'platform-console.html', 'platform-config.js', 'owner-control.html']) assert.ok(!result.files.includes(name));
  } finally { await fs.rm(fixture, { recursive: true, force: true }); }
});
await test('legacy tenant config keeps all features unless explicitly selected', async () => {
  const baseline = JSON.parse(await fs.readFile(new URL('../config/tenant.chananya.json', import.meta.url), 'utf8'));
  assert.equal(validateTenantConfig(baseline).features, undefined);
  const selected = validateTenantConfig({ ...baseline, features: ['u-synthesise'] });
  assert.deepEqual(buildDeployManifest(selected).package.features, ['core', 'u-synthesise']);
});
await test('HTML proof permits only observed Pretty URL aliasing and keeps code exact', () => {
  const source = '<a href="/owner-control.html">Owner</a>';
  const deployed = "<a href='/owner-control'>Owner</a>";
  assert.deepEqual(canonicalPreviewAsset('page.html', source), canonicalPreviewAsset('page.html', deployed));
  assert.notDeepEqual(canonicalPreviewAsset('page.html', source), canonicalPreviewAsset('page.html', deployed.replace('Owner', 'Changed')));
  assert.notDeepEqual(canonicalPreviewAsset('page.html', source), canonicalPreviewAsset('page.html', '<a href="/admin">Owner</a>'));
  assert.notDeepEqual(canonicalPreviewAsset('page.js', source), canonicalPreviewAsset('page.js', deployed));
});
console.log(`Platform Console: ${count} behavioral checks passed.`);
