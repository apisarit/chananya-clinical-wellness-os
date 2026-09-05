import assert from 'node:assert/strict';
import { referenceUrl, normalizeResults } from '../evidence-view.mjs';
import { createEvidenceController } from '../evidence-page.mjs';

assert.equal(referenceUrl('pubmed', '12345678'), 'https://pubmed.ncbi.nlm.nih.gov/12345678/');
assert.equal(referenceUrl('clinicaltrials', 'NCT00001234'), 'https://clinicaltrials.gov/study/NCT00001234');
assert.equal(referenceUrl('dailymed', '00000000-0000-0000-0000-000000000001'), 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=00000000-0000-0000-0000-000000000001');
for (const id of ['javascript:alert(1)', '../1234', '1234?redirect=evil', '<img src=x>', 1234]) assert.equal(referenceUrl('pubmed', id), null);
assert.throws(() => normalizeResults({ ok: true, source: 'dailymed', results: [] }, 'pubmed'));
assert.throws(() => normalizeResults({ ok: true, source: '__proto__', results: [] }, '__proto__'));
const payload = { ok: true, source: 'pubmed', retrievedAt: '2026-09-05T00:00:00Z', results: [{ id: '1234', title: '<img src=x onerror=alert(1)>', url: 'https://evil.invalid/', detail: '<script>alert(1)</script>' }] };
assert.equal(normalizeResults(payload, 'pubmed')[0].url, 'https://pubmed.ncbi.nlm.nih.gov/1234/');
assert.equal(normalizeResults({ ...payload, results: [...payload.results, { id: '../123', title: 'bad' }] }, 'pubmed').length, 1);

class Element {
  constructor() { this.value = ''; this.children = []; this.handlers = {}; this.attributes = {}; this.disabled = true; this.classList = { add() {}, remove() {} }; }
  addEventListener(name, handler) { this.handlers[name] = handler; }
  setAttribute(key, value) { this.attributes[key] = value; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  set innerHTML(_) { throw new Error('Untrusted result HTML must never be parsed'); }
}

function fixture({ allowed = true, session = { user: { id: 'user' }, access_token: 'test-token' }, fetchImpl, signOut = async () => ({}) } = {}) {
  const elements = new Map();
  const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); }, createElement() { return new Element(); } };
  document.getElementById('evidence-source').value = 'pubmed';
  document.getElementById('evidence-query').value = 'curcumin';
  let authListener;
  let token = session;
  const redirects = [];
  const calls = [];
  const runtime = {
    getSession: async () => token,
    getProfile: async () => ({}),
    can: () => allowed,
    getDb: () => ({ auth: { onAuthStateChange(listener) { authListener = listener; return { data: { subscription: { unsubscribe() {} } } }; }, signOut } })
  };
  const controller = createEvidenceController({ document, runtime, location: { replace(path) { redirects.push(path); } }, fetchImpl: fetchImpl || (async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200, json: async () => payload }; }) });
  return { controller, elements, calls, redirects, revoke() { token = null; authListener('SIGNED_OUT', null); }, setSession(value) { token = value; } };
}

const normal = fixture();
await normal.controller.init();
assert.equal(normal.calls.length, 0, 'Opening the page never searches automatically');
await normal.controller.search();
assert.equal(normal.calls.length, 1);
assert.equal(normal.calls[0].url, '/api/evidence-search');
assert.deepEqual(JSON.parse(normal.calls[0].opts.body), { source: 'pubmed', query: 'curcumin' });
assert.equal(normal.calls[0].opts.headers.Authorization, 'Bearer test-token');
assert.equal(normal.calls[0].opts.cache, 'no-store');
const card = normal.elements.get('evidence-results').children[0];
assert.equal(card.children[1].textContent, payload.results[0].title, 'Provider markup is rendered only as text');
assert.equal(card.children[3].href, 'https://pubmed.ncbi.nlm.nih.gov/1234/');
assert.equal(card.children[3].rel, 'noopener noreferrer');
normal.revoke();
assert.equal(normal.elements.get('evidence-results').children.length, 0, 'Logout erases results');
assert.equal(normal.elements.get('evidence-query').value, '');
assert.equal(normal.redirects.at(-1), '/login.html');

const denied = fixture({ allowed: false });
await denied.controller.init();
await denied.controller.search();
assert.equal(denied.calls.length, 0, 'Missing capability never dispatches a search');

const expired = fixture();
await expired.controller.init();
expired.setSession(null);
await expired.controller.search();
assert.equal(expired.calls.length, 0, 'Expired session is checked again before each search');

let resolveFetch;
const stale = fixture({ fetchImpl: () => new Promise(resolve => { resolveFetch = resolve; }) });
await stale.controller.init();
const pending = stale.controller.search();
await new Promise(resolve => setImmediate(resolve));
stale.revoke();
resolveFetch({ ok: true, status: 200, json: async () => payload });
await pending;
assert.equal(stale.elements.get('evidence-results').children.length, 0, 'Late network response cannot restore results after logout');

const off = fixture({ fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ ok: false, code: 'SUBSCRIPTION_DISABLED' }) }) });
await off.controller.init();
await off.controller.search();
assert.equal(off.elements.get('evidence-submit').disabled, true, 'Server-side OFF response disables further local dispatch');
assert.equal(off.elements.get('evidence-results').children.length, 0);

const restored = fixture();
await restored.controller.init();
restored.controller.dispose();
await restored.controller.init();
assert.equal(restored.elements.get('evidence-submit').disabled, false, 'History restore revalidates session before re-enabling search');
await restored.controller.search();
assert.equal(restored.calls.length, 1);
restored.revoke();
assert.equal(restored.elements.get('evidence-results').children.length, 0, 'History restore re-registers logout listener');

const logoutFailure = fixture({ signOut: async () => { throw new Error('network failed'); } });
await logoutFailure.controller.init();
await logoutFailure.elements.get('logout').handlers.click();
assert.match(logoutFailure.elements.get('evidence-status').textContent, /ออกจากระบบไม่สำเร็จ/);
assert.equal(logoutFailure.redirects.length, 0, 'Failed logout never claims sign-out succeeded');
console.log('Evidence UI: canonical citations, text-only output, permission/session denial, stale responses, history restore and logout failure passed');
