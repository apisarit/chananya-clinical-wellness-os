import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Execute the actual controller. All identities, records, transport and DOM are synthetic.
const source = fs.readFileSync(new URL('../owner-control.js', import.meta.url), 'utf8');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };
class Element {
  constructor() {
    this.children = []; this.value = ''; this.disabled = false; this.attributes = new Map();
    this.listeners = new Map(); this.text = ''; const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
      toggle: (name, force) => { if (force ?? !classes.has(name)) classes.add(name); else classes.delete(name); }
    };
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent || '').join(''); }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.text = ''; this.children = [...items]; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(callback);
  }
  async dispatch(name, event = {}) {
    return Promise.all((this.listeners.get(name) || []).map(callback => callback({ preventDefault() {}, ...event })));
  }
  focus() {}
}
const userSession = (token = 'synthetic-token-a', id = 'synthetic-owner') => ({
  access_token: token, user: { id, email: 'owner@example.invalid' }
});
const clinics = [{ clinic_id: 'synthetic-clinic', clinic_code: 'TEST-STG', enabled: true, subscription_version: 2 }];
const folderKeys = ['patients', 'products', 'pharmacy', 'transactions', 'manifests'];
const drivePayload = {
  ok: true, environment: 'staging', deploymentId: 'synthetic-staging', projectRef: 'synthetic-project',
  serviceAccountEmail: 'synthetic@example.invalid', rootFolderId: 'synthetic-root',
  assignments: [{ clinic_id: 'synthetic-clinic', environment: 'staging', version: 1,
    folders: Object.fromEntries(folderKeys.map(key => [key, `synthetic-${key}`])) }]
};
const response = (payload, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });
function harness(options = {}) {
  const elements = new Map();
  const el = name => { if (!elements.has(name)) elements.set(name, new Element()); return elements.get(name); };
  el('owner-app').classList.add('hidden');
  const window = new Element(); const calls = []; const timeouts = []; const redirects = []; const storageWrites = []; let authCallback;
  const state = { session: userSession(), getSessionCalls: 0, ...options };
  const db = { auth: {
    getSession: () => { state.getSessionCalls++; return state.getSession ? state.getSession() : Promise.resolve({ data: { session: state.session } }); },
    onAuthStateChange: callback => { authCallback = callback; return { data: { subscription: { unsubscribe() {} } } }; },
    signOut: () => state.signOut ? state.signOut() : Promise.resolve({ error: null })
  } };
  window.ChananyaRuntime = { getDb: () => { if (state.runtimeFails) throw new Error('Runtime unavailable'); return db; } }; window.confirm = () => true;
  const context = vm.createContext({ window, document: { querySelector: s => el(s.slice(1)), createElement: () => new Element() },
    location: { replace: target => redirects.push(target) },
    sessionStorage: { setItem(key, value) {
      if (state.storageFails) throw new Error('Storage disabled');
      storageWrites.push([key, value]);
    } },
    fetch: async (url, init) => {
      calls.push({ url, ...init });
      if (state.fetch) return state.fetch(url, init, calls.length);
      return response(url === '/api/owner-drive' ? drivePayload : { ok: true, clinics });
    },
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000123' },
    AbortController, AbortSignal: { timeout: () => { const controller = new AbortController(); timeouts.push(controller); return controller.signal; } },
    setTimeout: () => 0, clearTimeout() {}, console
  });
  vm.runInContext(source, context, { filename: 'owner-control.js' });
  return { el, state, calls, timeouts, redirects, storageWrites, window,
    auth: (event, value) => { state.session = value; return authCallback(event, value); },
    submit: () => {
      el('owner-clinic').value = 'synthetic-clinic'; el('owner-confirm-code').value = 'TEST-STG';
      el('owner-reason').value = 'Synthetic regression test'; el('owner-state').value = 'off';
      return el('owner-control-form').dispatch('submit');
    }
  };
}
function assertCleared(h) {
  assert.equal(h.el('owner-app').classList.contains('hidden'), true);
  assert.equal(h.el('owner-email').textContent, '—');
  for (const id of ['owner-clinic-list', 'owner-clinic', 'owner-drive-clinic', 'owner-drive-current']) assert.equal(h.el(id).children.length, 0, id);
  for (const id of ['owner-confirm-code', 'owner-reason', 'owner-drive-confirm-code', 'owner-drive-reason', ...folderKeys.map(k => `owner-drive-${k}`)]) assert.equal(h.el(id).value, '', id);
  for (const id of ['owner-submit', 'owner-drive-submit', 'owner-drive-retry']) assert.equal(h.el(id).disabled, true, id);
  assert.equal(h.el('owner-toast').textContent, '');
  assert.equal(h.el('owner-drive-context-project').textContent, '—');
}
let passed = 0;
async function check(name, run) { await run(); passed++; console.log(`PASS ${name}`); }

await check('authorized bootstrap keeps subscription and Drive capabilities', async () => {
  const h = harness(); await flush();
  assert.equal(h.el('owner-app').classList.contains('hidden'), false);
  assert.equal(h.el('owner-clinic-list').children.length, 1);
  assert.equal(h.el('owner-drive-patients').value, 'synthetic-patients');
});
await check('token refresh callback is synchronous and subsequent request uses fresh token', async () => {
  const h = harness(); await flush(); const before = h.state.getSessionCalls;
  assert.equal(h.auth('TOKEN_REFRESHED', userSession('fresh-token')), undefined);
  assert.equal(h.state.getSessionCalls, before, 'auth callback must not call auth APIs');
  await h.el('owner-drive-retry').dispatch('click');
  assert.equal(h.calls.at(-1).headers.Authorization, 'Bearer fresh-token');
  assert.equal(h.calls.at(-1).cache, 'no-store');
});
await check('same-user SIGNED_IN does not wipe state or recursively call auth', async () => {
  const h = harness(); await flush(); const before = h.state.getSessionCalls;
  h.auth('SIGNED_IN', userSession());
  assert.equal(h.state.getSessionCalls, before); assert.equal(h.el('owner-clinic-list').children.length, 1);
});
await check('Owner requests use the latest SDK Google token without persisting another copy', async () => {
  const h = harness({ session: { ...userSession(), provider_token: 'synthetic-old-google-proof' } }); await flush();
  assert.equal(h.calls[0].headers['X-Owner-Google-Token'], 'synthetic-old-google-proof');
  assert.equal(h.calls[0].redirect, 'error', 'Never forward the Google credential through a redirect');
  h.state.session = { ...userSession('fresh-session'), provider_token: 'synthetic-fresh-google-proof' };
  await h.el('owner-drive-retry').dispatch('click');
  assert.equal(h.calls.at(-1).headers['X-Owner-Google-Token'], 'synthetic-fresh-google-proof');
  assert.deepEqual(h.storageWrites, []);
  h.auth('TOKEN_REFRESHED', userSession('refreshed-without-provider-token'));
  await h.el('owner-drive-retry').dispatch('click');
  assert.equal(h.calls.at(-1).headers['X-Owner-Google-Token'], undefined, 'Do not reuse a stale Google token after refresh');
});
await check('Google proof cannot survive account switching in an in-flight Owner request', async () => {
  const h = harness({ session: { ...userSession(), provider_token: 'synthetic-google-proof' } }); await flush();
  const pending = deferred(); h.state.getSession = () => pending.promise;
  const before = h.calls.length; const retry = h.el('owner-drive-retry').dispatch('click'); await flush();
  h.auth('SIGNED_IN', userSession('other-session', 'another-owner'));
  pending.resolve({ data: { session: { ...userSession(), provider_token: 'synthetic-google-proof' } } });
  await retry; assertCleared(h); assert.equal(h.calls.length, before);
});
await check('cross-tab logout clears all rendered and entered Owner state', async () => {
  const h = harness(); await flush(); h.el('owner-reason').value = 'Private entered reason';
  h.auth('SIGNED_OUT', null); assertCleared(h); const before = h.calls.length;
  await h.el('owner-control-form').dispatch('submit'); await h.el('owner-drive-retry').dispatch('click');
  assert.equal(h.calls.length, before); assert.deepEqual(h.redirects, ['/login.html']);
});
await check('account switch cannot inherit the old Owner controls', async () => {
  const h = harness(); await flush(); h.auth('SIGNED_IN', userSession('other-token', 'different-user'));
  assertCleared(h); assert.deepEqual(h.redirects, ['/login.html']);
});
await check('missing stored session is rejected before API dispatch', async () => {
  const h = harness(); await flush(); h.state.session = null; const before = h.calls.length;
  await h.el('owner-drive-retry').dispatch('click'); assertCleared(h); assert.equal(h.calls.length, before);
});
await check('getSession error is rejected before API dispatch', async () => {
  const h = harness(); await flush(); h.state.getSession = async () => ({ error: new Error('synthetic') });
  const before = h.calls.length; await h.el('owner-drive-retry').dispatch('click');
  assertCleared(h); assert.equal(h.calls.length, before);
});
await check('local logout hides immediately even when remote logout fails', async () => {
  const pending = deferred(); const h = harness({ signOut: () => pending.promise }); await flush();
  const logout = h.el('owner-logout').dispatch('click'); assertCleared(h);
  pending.resolve({ error: new Error('synthetic network failure') }); await logout;
  assertCleared(h); assert.match(h.el('boot-error').textContent, /ออกจากระบบไม่สำเร็จ/); assert.equal(h.redirects.length, 0);
});
await check('successful logout preserves its return path and tolerates unavailable storage', async () => {
  for (const storageFails of [false, true]) {
    const h = harness({ storageFails }); await flush();
    await h.el('owner-logout').dispatch('click');
    assertCleared(h); assert.deepEqual(h.redirects, ['/login.html']);
    assert.deepEqual(h.storageWrites, storageFails ? [] : [
      ['cnyos:post_auth_path', '/owner-control.html']
    ]);
  }
});
await check('pagehide clears state and BFCache restoration starts a fresh load', async () => {
  const h = harness(); await flush(); await h.window.dispatch('pagehide'); assertCleared(h);
  await h.window.dispatch('pageshow', { persisted: true }); assertCleared(h);
  assert.deepEqual(h.redirects, ['/owner-control.html']);
});
await check('late initial session cannot resurrect after logout', async () => {
  const pending = deferred(); const h = harness({ getSession: () => pending.promise });
  h.auth('SIGNED_OUT', null); pending.resolve({ data: { session: userSession() } }); await flush();
  assertCleared(h); assert.equal(h.calls.length, 0);
});
await check('late subscription headers cannot resurrect after logout', async () => {
  const pending = deferred(); const h = harness({ fetch: () => pending.promise }); await flush();
  h.auth('SIGNED_OUT', null); assert.equal(h.calls[0].signal.aborted, true);
  pending.resolve(response({ ok: true, clinics })); await flush(); assertCleared(h);
});
await check('late subscription body cannot resurrect after logout', async () => {
  const pending = deferred(); const h = harness({ fetch: () => ({ ok: true, status: 200, json: () => pending.promise }) }); await flush();
  h.auth('SIGNED_OUT', null); pending.resolve({ ok: true, clinics }); await flush(); assertCleared(h);
});
await check('late Drive response cannot reveal cleared destinations', async () => {
  const pending = deferred(); const h = harness({ fetch: url => url === '/api/owner-drive'
    ? { ok: true, status: 200, json: () => pending.promise } : response({ ok: true, clinics }) });
  await flush(); h.auth('SIGNED_OUT', null); pending.resolve(drivePayload); await flush(); assertCleared(h);
});
await check('late successful mutation cannot repopulate or display success after logout', async () => {
  const h = harness(); await flush(); const pending = deferred(); h.state.fetch = () => pending.promise;
  const post = h.submit(); await flush(); h.auth('SIGNED_OUT', null);
  pending.resolve(response({ ok: true })); await post; await flush(); assertCleared(h);
});
await check('saved mutation plus failed refresh is not reported as an unsaved mutation', async () => {
  const h = harness(); await flush(); h.state.fetch = (_, init) => {
    if (init.method === 'POST') return response({ ok: true }); throw new Error('synthetic failed refresh');
  };
  await h.submit(); assert.match(h.el('owner-status').textContent, /บันทึกสำเร็จ แต่โหลดสถานะล่าสุดไม่สำเร็จ/);
  assert.equal(h.el('owner-submit').disabled, true);
  const before = h.calls.length; await h.submit(); assert.equal(h.calls.length, before, 'must not retry ambiguous writes');
});
await check('unknown mutation outcome is not falsely reported as not saved', async () => {
  const h = harness(); await flush(); h.state.fetch = () => { throw new Error('synthetic connection lost'); };
  await h.submit(); assert.match(h.el('owner-status').textContent, /ยังยืนยันผลคำสั่งไม่ได้/);
  assert.equal(h.el('owner-submit').disabled, true);
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
});
await check('timeout includes response-body parsing and prevents a late render', async () => {
  const h = harness(); await flush(); const pending = deferred();
  h.state.fetch = () => ({ ok: true, status: 200, json: () => pending.promise });
  const retry = h.el('owner-drive-retry').dispatch('click'); await flush(); h.timeouts.at(-1).abort(); await retry;
  assert.match(h.el('owner-drive-status').textContent, /15 วินาที/);
  pending.resolve(drivePayload); await flush(); assert.equal(h.el('owner-drive-submit').disabled, true);
});
for (const status of [401, 403]) {
  await check(`HTTP ${status} locks Owner controls rather than retaining stale authority`, async () => {
    const h = harness(); await flush(); h.state.fetch = () => response({ ok: false, code: 'CNYOS_OWNER_NOT_AUTHORIZED' }, status);
    await h.el('owner-drive-retry').dispatch('click'); assertCleared(h);
  });
}
await check('initial session timeout gives a usable recovery panel and rejects late completion', async () => {
  const pending = deferred(); const h = harness({ getSession: () => pending.promise });
  await flush(); h.timeouts[0].abort(); await flush();
  assertCleared(h); assert.equal(h.el('owner-recovery-actions').hidden, false);
  assert.equal(h.el('owner-boot-spinner').hidden, true);
  assert.match(h.el('boot-error').textContent, /15 วินาที/);
  pending.resolve({ data: { session: userSession() } }); await flush();
  assertCleared(h); assert.equal(h.calls.length, 0);
});
await check('bootstrap API failure exposes recovery without granting Owner access', async () => {
  const h = harness({ fetch: () => { throw new Error('Offline'); } }); await flush();
  assertCleared(h); assert.equal(h.el('owner-recovery-actions').hidden, false);
  assert.equal(h.el('owner-recovery-login').disabled, false);
  assert.match(h.el('boot-error').textContent, /เชื่อมต่อ Owner Functions/);
});
await check('recovery reload never repeats a subscription mutation', async () => {
  const h = harness({ fetch: () => { throw new Error('Offline'); } }); await flush();
  await h.el('owner-recovery-retry').dispatch('click');
  assert.deepEqual(h.redirects, ['/owner-control.html']);
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 0);
});
await check('runtime setup failure stays locked and permits page reload without account-reset claims', async () => {
  const h = harness({ runtimeFails: true }); await flush();
  assertCleared(h); assert.equal(h.el('owner-recovery-login').disabled, true);
  assert.equal(h.el('owner-recovery-actions').hidden, false);
  await h.el('owner-recovery-retry').dispatch('click');
  assert.deepEqual(h.redirects, ['/owner-control.html']); assert.equal(h.calls.length, 0);
});
for (const httpStatus of [401, 403]) {
  await check(`HTTP ${httpStatus} cannot create a login/Owner redirect loop or wait for a response body`, async () => {
    let bodyReads = 0;
    const h = harness({ fetch: () => ({ ok: false, status: httpStatus,
      json: () => { bodyReads++; return new Promise(() => {}); } }) });
    await flush(); assertCleared(h);
    assert.equal(bodyReads, 0); assert.equal(h.redirects.length, 0);
    assert.equal(h.el('owner-recovery-actions').hidden, false);
    assert.match(h.el('boot-error').textContent, new RegExp(String(httpStatus)));
  });
}
await check('recovery sign-out works even when initial authorization never succeeded', async () => {
  let attempts = 0;
  const h = harness({ fetch: () => response({ ok: false }, 403),
    signOut: async () => { attempts++; return { error: null }; } }); await flush();
  await h.el('owner-recovery-login').dispatch('click');
  assertCleared(h); assert.equal(attempts, 1); assert.deepEqual(h.redirects, ['/login.html']);
  assert.deepEqual(h.storageWrites, [['cnyos:post_auth_path', '/owner-control.html']]);
});
await check('failed sign-out can be retried explicitly from recovery rather than a hidden button', async () => {
  let attempts = 0;
  const h = harness({ signOut: async () => ({ error: ++attempts === 1 ? new Error('Offline') : null }) }); await flush();
  await h.el('owner-logout').dispatch('click'); assertCleared(h);
  assert.equal(h.el('owner-recovery-login').disabled, false);
  await h.el('owner-recovery-login').dispatch('click');
  assert.equal(attempts, 2); assert.deepEqual(h.redirects, ['/login.html']); assertCleared(h);
});
await check('hanging sign-out times out and a late success cannot claim completion or navigate', async () => {
  const pending = deferred(); const h = harness({ signOut: () => pending.promise }); await flush();
  const logout = h.el('owner-logout').dispatch('click'); await flush();
  h.timeouts.at(-1).abort(); await logout;
  assertCleared(h); assert.equal(h.el('owner-recovery-actions').hidden, false);
  assert.equal(h.el('owner-recovery-login').disabled, false); assert.equal(h.redirects.length, 0);
  pending.resolve({ error: null }); await flush(); assert.equal(h.redirects.length, 0);
});
await check('duplicate sign-out and recovery reload are suppressed while sign-out is pending', async () => {
  const pending = deferred(); let attempts = 0;
  const h = harness({ signOut: () => { attempts++; return pending.promise; } }); await flush();
  const logout = h.el('owner-logout').dispatch('click');
  await h.el('owner-recovery-login').dispatch('click');
  await h.el('owner-recovery-retry').dispatch('click');
  assert.equal(attempts, 1); assert.equal(h.redirects.length, 0);
  pending.resolve({ error: null }); await logout; assert.deepEqual(h.redirects, ['/login.html']);
});
await check('duplicate subscription submits and manual refresh cannot overlap an in-flight mutation', async () => {
  const pending = deferred(); const h = harness(); await flush();
  h.state.fetch = (_, init) => init.method === 'POST' ? pending.promise : response({ ok: true, clinics });
  const post = h.submit(); await flush(); const before = h.calls.length;
  await h.submit(); await h.el('owner-refresh').dispatch('click');
  assert.equal(h.calls.length, before); assert.equal(h.el('owner-refresh').disabled, true);
  pending.resolve(response({ ok: true })); await post;
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(h.el('owner-refresh').disabled, false); assert.equal(h.el('owner-submit').disabled, false);
});
await check('read-only refresh recovers an uncertain subscription result without retrying the write', async () => {
  const h = harness(); await flush(); h.state.fetch = () => { throw new Error('Lost response'); };
  await h.submit(); assert.equal(h.el('owner-submit').disabled, true);
  h.state.fetch = () => response({ ok: true, clinics });
  await h.el('owner-refresh').dispatch('click');
  assert.equal(h.el('owner-submit').disabled, false);
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(h.calls.at(-1).method, 'GET');
});
await check('malformed clinic state fails closed instead of claiming an empty successful connection', async () => {
  for (const value of [undefined, {}, [{ clinic_id: 'synthetic-clinic' }]]) {
    const h = harness({ fetch: () => response({ ok: true, clinics: value }) }); await flush();
    assertCleared(h); assert.equal(h.el('owner-recovery-actions').hidden, false);
  }
});
await check('version conflict followed by failed refresh remains blocked until a successful read', async () => {
  const h = harness(); await flush(); h.state.fetch = (_, init) => {
    if (init.method === 'POST') return response({ ok: false, code: 'CNYOS_OWNER_SUBSCRIPTION_VERSION_CONFLICT' }, 409);
    throw new Error('Refresh offline');
  };
  await h.submit(); assert.equal(h.el('owner-submit').disabled, true);
  const before = h.calls.length; await h.submit(); assert.equal(h.calls.length, before);
});
await check('disabled Drive setup is a separate state and does not break the authorized subscription console', async () => {
  const h = harness({ fetch: url => url === '/api/owner-drive'
    ? response({ ok: false, code: 'CNYOS_OWNER_DRIVE_DISABLED' }, 503) : response({ ok: true, clinics }) }); await flush();
  assert.equal(h.el('owner-app').classList.contains('hidden'), false);
  assert.equal(h.el('owner-submit').disabled, false); assert.equal(h.el('owner-drive-submit').disabled, true);
  assert.equal(h.el('owner-drive-form').hidden, true);
  assert.equal(h.el('owner-drive-status').classList.contains('danger'), false);
  assert.equal(h.el('owner-toast').textContent, ''); assert.equal(h.redirects.length, 0);
});
function prepareDrive(h) {
  h.el('owner-drive-clinic').value = 'synthetic-clinic';
  h.el('owner-drive-confirm-code').value = 'TEST-STG';
  h.el('owner-drive-reason').value = 'Synthetic Drive regression';
  for (const key of folderKeys) h.el(`owner-drive-${key}`).value = `synthetic-${key}`;
}
await check('unknown Drive mutation outcome requires fresh status and does not allow an automatic second POST', async () => {
  const h = harness(); await flush(); prepareDrive(h);
  h.state.fetch = () => { throw new Error('Lost Drive response'); };
  await h.el('owner-drive-form').dispatch('submit');
  assert.equal(h.el('owner-drive-submit').disabled, true);
  await h.el('owner-drive-form').dispatch('submit');
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
  h.state.fetch = () => response(drivePayload);
  await h.el('owner-drive-retry').dispatch('click');
  assert.equal(h.el('owner-drive-submit').disabled, false);
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
});
await check('duplicate Drive submit dispatch is ignored while the first is in flight', async () => {
  const h = harness(); await flush(); prepareDrive(h); const pending = deferred();
  h.state.fetch = (_, init) => init.method === 'POST' ? pending.promise : response(drivePayload);
  const post = h.el('owner-drive-form').dispatch('submit'); await flush();
  await h.el('owner-drive-form').dispatch('submit');
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
  pending.resolve(response({ ok: true })); await post;
  assert.equal(h.el('owner-drive-submit').disabled, false);
});
console.log(`Owner session lifecycle passed: ${passed} synthetic browser-controller cases; no live authentication or deployment claimed.`);
