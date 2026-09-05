import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evidenceConfiguration, handleEvidenceSearch, normalizeEvidenceQuery, searchEvidence } from '../netlify/functions/_shared/evidence-search.mjs';

const origin = 'https://synthetic-evidence-staging.netlify.app';
const project = 'abcdefghijklmnopqrst';
const userId = '00000000-0000-4000-8000-000000000111';
const clinicId = '00000000-0000-4000-8000-00000000a001';
const siteId = '00000000-0000-4000-8000-000000000222';
const jwt = claims => `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic_signature`;
const token = jwt({ role: 'authenticated', sub: userId, iss: `https://${project}.supabase.co/auth/v1`, exp: Math.floor(Date.now() / 1000) + 3600 });
const publicKey = 'sb_publishable_' + 'a'.repeat(30);
const env = {
  CNYOS_EVIDENCE_ENABLED: 'true', CNYOS_EVIDENCE_PUBMED_ENABLED: 'true', SUPABASE_URL: `https://${project}.supabase.co`, SUPABASE_PUBLISHABLE_KEY: publicKey,
  CNYOS_OWNER_EXPECTED_PROJECT_REF: project, CNYOS_RUNTIME_EXPECTED_CLINIC_ID: clinicId,
  CNYOS_OWNER_EXPECTED_NETLIFY_SITE_ID: siteId, CNYOS_OWNER_EXPECTED_SITE_ORIGIN: origin
};
const context = { site: { id: siteId, url: origin }, deploy: { id: 'synthetic_deploy_000001', context: 'production', published: true } };
const active = [{ clinic_id: clinicId, clinic_role: 'practitioner', system_role: 'staff', effective_role: 'practitioner', ready: true }];
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const request = (body = { source: 'pubmed', query: 'turmeric' }, headers = {}, method = 'POST') => new Request(`${origin}/api/evidence-search`, {
  method, headers: { Origin: origin, 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
  ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {})
});
const trial = { studies: [{ protocolSection: { identificationModule: { nctId: 'NCT01234567', briefTitle: 'Synthetic research registry entry' }, statusModule: { overallStatus: 'COMPLETED', lastUpdatePostDateStruct: { date: '2026-01-01' } } } }], totalCount: 1 };
const label = { data: [{ setid: '00000000-0000-4000-8000-000000000333', title: 'Synthetic label', published_date: 'Jan 01, 2026' }], metadata: { total_elements: '1' } };
let passed = 0;
async function test(name, run) {
  try { await run(); passed += 1; }
  catch (error) { error.message = `${name}: ${error.message}`; throw error; }
}

function mocks({ access = active, userStatus = 200, secondAccess, upstreamStatus = 200 } = {}) {
  const calls = [];
  let accessCalls = 0;
  return {
    calls,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      const parsed = new URL(url);
      if (parsed.hostname === `${project}.supabase.co`) {
        assert.equal(options.headers.apikey, publicKey);
        assert.equal(options.headers.Authorization, `Bearer ${token}`);
        if (parsed.pathname === '/auth/v1/user') return response({ id: userId }, userStatus);
        assert.equal(parsed.pathname, '/rest/v1/rpc/current_access_context');
        assert.equal(options.method, 'POST');
        assert.equal(options.body, '{}');
        accessCalls += 1;
        return response(accessCalls > 1 && secondAccess !== undefined ? secondAccess : access);
      }
      assert.equal(options.headers.Authorization, undefined, 'User JWT must not leave Supabase');
      assert.equal(options.headers.apikey, undefined, 'Public API key must not leave Supabase');
      if (upstreamStatus !== 200) return response({ private_message: 'not public' }, upstreamStatus);
      if (parsed.pathname.endsWith('/esearch.fcgi')) return response({ esearchresult: { idlist: ['12345678'], count: '1' } });
      if (parsed.pathname.endsWith('/esummary.fcgi')) return response({ result: { '12345678': { uid: '12345678', title: 'Synthetic <i>reference</i>', pubdate: '2026 Jan', fulljournalname: 'Synthetic Journal', source: 'Syn J' } } });
      if (parsed.hostname === 'clinicaltrials.gov') return response(trial);
      if (parsed.hostname === 'dailymed.nlm.nih.gov') return response(label);
      throw new Error('Unexpected outbound URL');
    }
  };
}
async function handle(req = request(), { config = {}, runtime = context, ...mockOptions } = {}) {
  const mock = mocks(mockOptions);
  const reply = await handleEvidenceSearch(req, runtime, { getEnv: name => ({ ...env, ...config })[name] || '', fetchImpl: mock.fetchImpl });
  assert.match(reply.headers.get('Cache-Control'), /no-store/);
  assert.equal(reply.headers.get('Access-Control-Allow-Origin'), null);
  return { status: reply.status, body: await reply.json(), calls: mock.calls };
}

await test('authenticated PubMed lookup verifies access before and after source, returns citations', async () => {
  const r = await handle();
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.results[0].title, 'Synthetic reference');
  assert.equal(r.body.results[0].url, 'https://pubmed.ncbi.nlm.nih.gov/12345678/');
  assert.equal(r.body.source, 'pubmed');
  assert.equal(r.body.total, 1);
  assert.ok(Number.isFinite(Date.parse(r.body.retrievedAt)));
  assert.equal(r.calls.length, 5);
  assert.ok(r.calls.at(-1).url.endsWith('/current_access_context'));
});
await test('ClinicalTrials citations and date', async () => {
  const r = await handle(request({ source: 'clinicaltrials', query: 'turmeric' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.results[0].url, 'https://clinicaltrials.gov/study/NCT01234567');
  assert.equal(r.body.results[0].date, '2026-01-01');
  assert.equal(new URL(r.calls[2].url).searchParams.get('pageSize'), '5');
});
await test('DailyMed label reference', async () => {
  const r = await handle(request({ source: 'dailymed', query: 'aspirin' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 1);
  assert.match(r.body.results[0].url, /^https:\/\/dailymed.nlm.nih.gov\/dailymed\/drugInfo.cfm\?setid=/);
  assert.equal(new URL(r.calls[2].url).searchParams.get('pagesize'), '5');
});
await test('feature disabled by default, no external calls', async () => {
  const r = await handle(request(), { config: { CNYOS_EVIDENCE_ENABLED: '' } });
  assert.equal(r.status, 503); assert.equal(r.body.code, 'EVIDENCE_DISABLED'); assert.equal(r.calls.length, 0);
});
await test('PubMed remains separately disabled until upstream quota controls are ready', async () => {
  const r = await handle(request(), { config: { CNYOS_EVIDENCE_PUBMED_ENABLED: '' } });
  assert.equal(r.status, 503); assert.equal(r.body.code, 'EVIDENCE_PUBMED_DISABLED');
  assert.equal(r.calls.length, 2);
  assert.ok(r.calls.every(call => new URL(call.url).hostname === `${project}.supabase.co`));
  const trials = await handle(request({ source: 'clinicaltrials', query: 'turmeric' }), { config: { CNYOS_EVIDENCE_PUBMED_ENABLED: '' } });
  assert.equal(trials.status, 200);
});
await test('missing public key never falls back to elevated key', async () => {
  const r = await handle(request(), { config: { SUPABASE_PUBLISHABLE_KEY: '', SUPABASE_SERVICE_ROLE_KEY: 'elevated-key' } });
  assert.equal(r.status, 503); assert.equal(r.calls.length, 0);
});
await test('elevated key in public-key configuration is refused', async () => {
  for (const key of ['sb_secret_' + 'x'.repeat(40), jwt({ role: 'service_role', ref: project })]) {
    const r = await handle(request(), { config: { SUPABASE_PUBLISHABLE_KEY: key } });
    assert.equal(r.status, 503); assert.equal(r.calls.length, 0);
  }
});
await test('legacy anon key allowed only for exact project', () => {
  const config = evidenceConfiguration(name => ({ ...env, SUPABASE_PUBLISHABLE_KEY: '', SUPABASE_ANON_KEY: jwt({ role: 'anon', ref: project }) })[name] || '');
  assert.ok(config.publicKey);
  assert.throws(() => evidenceConfiguration(name => ({ ...env, SUPABASE_PUBLISHABLE_KEY: jwt({ role: 'anon', ref: 'otherproject' }) })[name] || ''), /NOT_CONFIGURED/);
});
await test('Supabase URL cannot be substituted or carry user-info/path/query', async () => {
  for (const url of [`https://${project}.supabase.co.attacker.example`, `https://${project}.supabase.co/auth/v1`, `https://${project}.supabase.co?target=evil`, `https://x@${project}.supabase.co`]) {
    const r = await handle(request(), { config: { SUPABASE_URL: url } });
    assert.equal(r.status, 503); assert.equal(r.calls.length, 0);
  }
});
await test('unpublished previews cannot use the live endpoint', async () => {
  const r = await handle(request(), { runtime: { ...context, deploy: { ...context.deploy, context: 'deploy-preview', published: false } } });
  assert.equal(r.status, 503); assert.equal(r.calls.length, 0);
});
await test('wrong Netlify site denied', async () => {
  const r = await handle(request(), { runtime: { ...context, site: { ...context.site, id: userId } } });
  assert.equal(r.status, 503); assert.equal(r.calls.length, 0);
});
await test('cross-origin and missing origin denied before auth', async () => {
  for (const Origin of ['https://attacker.example', 'null', '']) {
    const r = await handle(request(undefined, { Origin }));
    assert.equal(r.status, 403); assert.equal(r.calls.length, 0);
  }
});
await test('missing auth and forged non-JWT denied', async () => {
  for (const Authorization of ['', 'Bearer ' + 'a'.repeat(80)]) {
    const r = await handle(request(undefined, { Authorization }));
    assert.equal(r.status, 401); assert.equal(r.calls.length, 0);
  }
});
await test('expired/cross-project/elevated JWT claims denied', async () => {
  const base = { role: 'authenticated', sub: userId, iss: `${env.SUPABASE_URL}/auth/v1`, exp: Math.floor(Date.now() / 1000) + 3600 };
  for (const changes of [{ exp: 1 }, { role: 'service_role' }, { iss: 'https://elsewhere.supabase.co/auth/v1' }]) {
    const r = await handle(request(undefined, { Authorization: `Bearer ${jwt({ ...base, ...changes })}` }));
    assert.equal(r.status, 401); assert.equal(r.calls.length, 0);
  }
});
await test('Supabase rejects invalid token signature before any source fetch', async () => {
  const r = await handle(request(), { userStatus: 401 });
  assert.equal(r.status, 401); assert.equal(r.calls.length, 1);
});
await test('membership absent or subscription OFF denies provider requests', async () => {
  for (const access of [[], [{ ...active[0], ready: false }], [{ ...active[0], clinic_id: userId }]]) {
    const r = await handle(request(), { access });
    assert.equal(r.status, 403); assert.equal(r.body.code, 'EVIDENCE_ACCESS_DENIED'); assert.equal(r.calls.length, 2);
  }
});
await test('governance and unrelated departments cannot inherit underlying clinical role', async () => {
  for (const effective_role of ['admin', 'reception', 'quality', 'billing', 'viewer']) {
    const r = await handle(request(), { access: [{ ...active[0], effective_role }] });
    assert.equal(r.status, 403); assert.equal(r.body.code, 'EVIDENCE_CAPABILITY_DENIED'); assert.equal(r.calls.length, 2);
  }
});
await test('all knowledge_read roles admitted from database effective_role', async () => {
  for (const effective_role of ['super_admin', 'practitioner', 'doctor', 'pharmacy', 'production', 'inventory']) {
    const r = await handle(request(), { access: [{ ...active[0], effective_role }] });
    assert.equal(r.status, 200);
  }
});
await test('subscription OFF during provider fetch suppresses successful result', async () => {
  const r = await handle(request(), { secondAccess: [] });
  assert.equal(r.status, 403); assert.equal(r.body.results, undefined); assert.equal(r.calls.length, 5);
});
await test('wrong HTTP method/content type denied', async () => {
  assert.equal((await handle(request(undefined, {}, 'GET'))).status, 405);
  assert.equal((await handle(request(undefined, { 'Content-Type': 'text/plain' }))).status, 415);
});
await test('malformed, overlong and extra client-provided patient/tenant fields denied', async () => {
  for (const body of ['{', null, [], { source: 'pubmed', query: 'a' }, { source: 'pubmed', query: 'a'.repeat(161) }, { source: 'pubmed', query: 'turmeric', patientId: userId }, { source: 'pubmed', query: 'turmeric', clinicId }, { source: 'attacker', query: 'turmeric' }]) {
    const r = await handle(request(body));
    assert.equal(r.status, 400); assert.equal(r.calls.length, 0);
  }
  const r = await handle(request(' '.repeat(4096)));
  assert.equal(r.status, 400); assert.equal(r.calls.length, 0);
});
await test('URL/script/control-character queries are refused', () => {
  for (const query of ['https://attacker.example', 'www.attacker.example', '<script>one</script>', 'a\nb', 'test@example.com']) {
    assert.throws(() => normalizeEvidenceQuery({ source: 'pubmed', query }), /QUERY_INVALID/);
  }
});
await test('source failures are safe, busy status preserves retry semantics', async () => {
  for (const [upstreamStatus, status, code] of [[500, 502, 'EVIDENCE_SOURCE_UNAVAILABLE'], [429, 429, 'EVIDENCE_SOURCE_BUSY']]) {
    const r = await handle(request(), { upstreamStatus });
    assert.equal(r.status, status); assert.deepEqual(r.body, { ok: false, code });
  }
});
await test('zero results is success for all sources', async () => {
  for (const [source, payload] of [['pubmed', { esearchresult: { idlist: [], count: '0' } }], ['clinicaltrials', { studies: [], totalCount: 0 }], ['dailymed', { data: [], metadata: { total_elements: '0' } }]]) {
    const out = await searchEvidence({ source, query: 'synthetic-unmatched-query' }, { fetchImpl: async () => response(payload) });
    assert.deepEqual(out, { results: [], total: 0 });
  }
});
await test('source ID injection never becomes an outbound URL or citation', async () => {
  let calls = 0;
  const out = await searchEvidence({ source: 'pubmed', query: 'turmeric' }, { fetchImpl: async () => { calls += 1; return response({ esearchresult: { idlist: ['https://attacker.example', '1&api_key=x'], count: '2' } }); } });
  assert.equal(calls, 1); assert.deepEqual(out.results, []);
  const trials = await searchEvidence({ source: 'clinicaltrials', query: 'turmeric' }, { fetchImpl: async () => response({ studies: [{ protocolSection: { identificationModule: { nctId: 'https://attacker.example', briefTitle: 'bad' } } }] }) });
  assert.deepEqual(trials.results, []);
  const labels = await searchEvidence({ source: 'dailymed', query: 'aspirin' }, { fetchImpl: async () => response({ data: [{ setid: 'javascript:alert(1)', title: 'bad' }] }) });
  assert.deepEqual(labels.results, []);
});
await test('source response size, invalid JSON, timeout and redirects fail safely', async () => {
  for (const fetchImpl of [
    async () => new Response('x'.repeat(524_289), { headers: { 'Content-Type': 'application/json' } }),
    async () => new Response('not JSON', { headers: { 'Content-Type': 'application/json' } }),
    async () => new Response('<html>upstream outage</html>', { headers: { 'Content-Type': 'text/html' } }),
    async () => { throw new DOMException('timed out', 'TimeoutError'); },
    async (_url, options) => { assert.equal(options.redirect, 'error'); throw new TypeError('redirect blocked'); }
  ]) {
    await assert.rejects(searchEvidence({ source: 'dailymed', query: 'aspirin' }, { fetchImpl }), /EVIDENCE_SOURCE_UNAVAILABLE/);
  }
});
await test('Netlify wrapper has bounded rate rule and no sensitive runtime dependency', () => {
  const wrapper = fs.readFileSync(new URL('../netlify/functions/evidence-search.mts', import.meta.url), 'utf8');
  assert.match(wrapper, /path: '\/api\/evidence-search'/);
  assert.match(wrapper, /windowLimit: 12/);
  assert.match(wrapper, /windowSize: 60/);
  assert.match(wrapper, /aggregateBy: \['ip', 'domain'\]/);
  assert.match(wrapper, /Netlify\.env\.get/);
  const backend = fs.readFileSync(new URL('../netlify/functions/_shared/evidence-search.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(wrapper + backend, /SUPABASE_SERVICE_ROLE_KEY|OPENAI_API_KEY|console\.(?:log|error|warn)|process\.env/);
});

console.log(`Evidence search contract: ${passed} checks passed (synthetic auth/provider fixtures; no live credentials).`);
