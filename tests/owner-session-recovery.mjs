import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { setImmediate as tick } from 'node:timers/promises';

const source = fs.readFileSync(new URL('../owner-control.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../owner-control.html', import.meta.url), 'utf8');
const identity = '11111111-1111-4111-8111-111111111111';
const session = token => ({ access_token: token, user: { id: identity, email: 'owner@example.test' } });
const clinic = { clinic_id: '00000000-0000-4000-8000-00000000a001', clinic_code: 'CLINIC-STG', enabled: true, subscription_version: 3 };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const drain = async () => { for (let i = 0; i < 12; i++) await tick(); };

class Element {
  constructor(id = '') {
    this.id = id; this.value = ''; this.textContent = ''; this.disabled = false;
    this.children = []; this.events = {}; this.attributes = {}; this.classes = new Set();
    this.classList = {
      add: (...names) => names.forEach(name => this.classes.add(name)),
      remove: (...names) => names.forEach(name => this.classes.delete(name)),
      contains: name => this.classes.has(name),
      toggle: (name, force) => { const on = force ?? !this.classes.has(name); on ? this.classes.add(name) : this.classes.delete(name); return on; }
    };
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; this.value = ''; }
  addEventListener(event, fn) { (this.events[event] ||= []).push(fn); }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  focus() {}
}

async function harness({ rejectSession = false } = {}) {
  const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, new Element(id)]));
  const spinner = new Element();
  elements.boot.querySelector = () => spinner;
  elements['owner-app'].classList.add('hidden');
  elements['owner-boot-actions'].classList.add('hidden');
  const h = { elements, spinner, calls: [], current: session('opening-token'), failRead: false, rejectSession, postBehavior: 'success', writes: 0, version: 3, redirects: [], storage: new Map(), signedOut: null };
  const db = { auth: {
    getSession: async () => ({ data: { session: h.current }, error: null }),
    signOut: async options => { h.signedOut = options; h.current = null; return { error: null }; }
  } };
  const document = { querySelector: selector => elements[selector.slice(1)], createElement: () => new Element() };
  vm.runInNewContext(source, {
    window: { ChananyaRuntime: { getDb: () => db }, confirm: () => true }, document,
    location: { replace: path => h.redirects.push(path) },
    sessionStorage: { setItem: (key, value) => h.storage.set(key, value) },
    crypto: { randomUUID: () => '22222222-2222-4222-8222-222222222222' },
    AbortSignal, AbortController, setTimeout: () => 1, clearTimeout() {},
    fetch: async (path, options) => {
      h.calls.push({ path, ...options });
      if (h.rejectSession) return response({ ok: false, code: 'CNYOS_OWNER_SESSION_INVALID' }, 401);
      if (path === '/api/owner-drive') return response({ ok: false, code: 'CNYOS_OWNER_DRIVE_DISABLED' }, 503);
      if (options.method === 'POST') {
        h.writes++;
        if (h.postBehavior === 'conflict') return response({ ok: false, code: 'CNYOS_OWNER_SUBSCRIPTION_VERSION_CONFLICT' }, 409);
        h.version++;
        if (h.postBehavior === 'lost') throw new Error('Response lost after server commit');
        if (h.postBehavior === 'saved-read-failed') h.failRead = true;
        return response({ ok: true, result: { enabled: false, version: h.version } });
      }
      if (h.failRead) throw new Error('Status request unavailable');
      return response({ ok: true, clinics: [{ ...clinic, enabled: h.version === 3, subscription_version: h.version }] });
    }
  });
  h.fire = async (id, type = 'click') => {
    const element = elements[id];
    for (const fn of element.events[type] || []) await fn({ preventDefault() {}, currentTarget: element });
    await drain();
  };
  h.submit = async () => {
    elements['owner-clinic'].value = clinic.clinic_id;
    elements['owner-confirm-code'].value = clinic.clinic_code;
    elements['owner-state'].value = 'off';
    elements['owner-reason'].value = 'Reviewed synthetic subscription test';
    await h.fire('owner-control-form', 'submit');
  };
  await drain();
  return h;
}

const refreshed = await harness();
assert.ok(refreshed.elements.boot.classList.contains('hidden'));
refreshed.current = session('refreshed-token');
await refreshed.submit();
const post = refreshed.calls.find(call => call.method === 'POST');
assert.equal(post.headers.Authorization, 'Bearer refreshed-token', 'mutation must use the SDK refreshed token');
assert.equal(JSON.parse(post.body).expectedVersion, 3);
assert.equal(refreshed.writes, 1);
assert.equal(refreshed.elements['owner-submit'].disabled, false, 'OFF must leave Owner controls usable');
assert.equal(refreshed.elements['owner-control-form'].events.submit.length, 1);

const failed = await harness({ rejectSession: true });
assert.ok(failed.spinner.classList.contains('hidden'), 'error must stop the indefinite spinner');
assert.ok(!failed.elements['owner-boot-actions'].classList.contains('hidden'));
assert.match(failed.elements['boot-error'].textContent, /Session หมดอายุ/);
failed.rejectSession = false; failed.current = session('renewed-token');
await failed.fire('owner-boot-retry');
assert.ok(failed.elements.boot.classList.contains('hidden'));
assert.equal(failed.elements['owner-control-form'].events.submit.length, 1, 'retry must not duplicate mutation handlers');
await failed.submit(); assert.equal(failed.writes, 1);

const saved = await harness(); saved.postBehavior = 'saved-read-failed';
await saved.submit();
assert.match(saved.elements['owner-status'].textContent, /บันทึก OFF สำเร็จแล้ว/);
assert.doesNotMatch(saved.elements['owner-status'].textContent, /คำสั่งไม่ถูกบันทึก/);
assert.equal(saved.elements['owner-submit'].disabled, true, 'new writes require a current version');
await saved.submit(); assert.equal(saved.writes, 1, 'no resubmission with stale version');
saved.failRead = false;
await saved.fire('owner-refresh');
assert.equal(saved.elements['owner-submit'].disabled, false);

const lost = await harness(); lost.postBehavior = 'lost';
await lost.submit();
assert.match(lost.elements['owner-status'].textContent, /ยังยืนยันผลคำสั่งไม่ได้/);
assert.equal(lost.elements['owner-submit'].disabled, true);
assert.equal(lost.writes, 1, 'never automatically retry an uncertain mutation');
await lost.fire('owner-refresh');
assert.equal(lost.elements['owner-submit'].disabled, false);

const conflict = await harness(); conflict.postBehavior = 'conflict'; conflict.version = 5;
await conflict.submit();
assert.match(conflict.elements['owner-status'].textContent, /สถานะเปลี่ยนจากอีก session/);
assert.equal(conflict.writes, 1); assert.equal(conflict.elements['owner-submit'].disabled, false);

const changed = await harness();
changed.current = { ...session('other-account-token'), user: { id: '33333333-3333-4333-8333-333333333333' } };
await changed.submit(); assert.equal(changed.writes, 0, 'account switch cannot execute the old confirmation');
assert.equal(changed.elements['owner-submit'].disabled, true);
await changed.fire('owner-logout');
assert.equal(changed.signedOut.scope, 'local');
assert.equal(changed.storage.get('cnyos:post_auth_path'), '/owner-control.html');
assert.deepEqual(changed.redirects, ['/login.html']);

const bootLogin = await harness({ rejectSession: true });
await bootLogin.fire('owner-boot-login');
assert.equal(bootLogin.signedOut.scope, 'local');
assert.deepEqual(bootLogin.redirects, ['/login.html']);
console.log('Owner recovery passed: latest session, account-switch denial, boot retry and local login, confirmed/unknown write outcomes, OFF recovery, and concurrency.');
