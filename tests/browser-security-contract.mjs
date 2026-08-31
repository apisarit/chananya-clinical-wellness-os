import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const htmlFiles = fs.readdirSync(root).filter(file => file.endsWith('.html'));

for (const file of htmlFiles) {
  const html = read(file);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, `${file} must not contain inline script`);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${file} must not contain inline event handlers`);

  for (const match of html.matchAll(/<script\b[^>]*>/gi)) {
    const source = match[0].match(/\ssrc=["']([^"']+)["']/i)?.[1];
    if (!source) continue;
    if (!/^https?:/i.test(source)) continue;
    assert.match(source, /^https:\/\/(?:cdn\.jsdelivr\.net|static\.line-scdn\.net)\//, `${file} loads an unapproved script origin: ${source}`);
    if (source.startsWith('https://cdn.jsdelivr.net/')) {
      assert.match(match[0], /\sintegrity=["']sha384-[A-Za-z0-9+/=]+["']/i, `${file} must authenticate ${source} with SHA-384 SRI`);
      assert.match(match[0], /\scrossorigin=["']anonymous["']/i, `${file} must use anonymous CORS for ${source}`);
    }
  }

  assert.doesNotMatch(html, /@supabase\/supabase-js@2(?:["'/]|$)/, `${file} must pin the complete Supabase browser SDK version`);
}

for (const file of ['auth-login.js', 'auth-callback.js', 'owner-control.js', 'pharmacy-labels.js', 'pharmacy-v33-tools.js']) {
  const source = read(file);
  assert.doesNotThrow(() => new vm.Script(source, { filename: file }), `${file} must parse as browser JavaScript`);
  assert.doesNotMatch(source, /onclick\s*=/i, `${file} must bind events without inline handlers`);
}
assert.match(read('pharmacy-v33-tools.js'), /PRINT_LIBRARY_INTEGRITY/);
assert.match(read('pharmacy-v33-tools.js'), /script\.integrity = integrity/);

const loginEvents = {};
const loginElements = {
  'google-login': {
    disabled: false,
    addEventListener(type, handler) { loginEvents[type] = handler; }
  },
  status: {
    textContent: '',
    classList: { add() {}, remove() {} }
  }
};
let loginClientOptions;
let oauthOptions;
const loginLocation = { origin: 'https://staging.example.test', replace() {} };
const loginWindow = {
  CHANANYA_AUTH: { url: 'https://staging.supabase.co', anonKey: 'sb_publishable_test' },
  supabase: {
    createClient(_url, _key, options) {
      loginClientOptions = options;
      return {
        auth: {
          async getSession() { return { data: { session: null }, error: null }; },
          async signInWithOAuth(optionsInput) { oauthOptions = optionsInput; return { error: null }; }
        }
      };
    }
  }
};
vm.runInNewContext(read('auth-login.js'), {
  window: loginWindow,
  document: { getElementById: id => loginElements[id] || null },
  location: loginLocation,
  fetch: async () => ({ ok: true, async json() { return { external: { google: true } }; } }),
  sessionStorage: { getItem() { return null; }, removeItem() {} },
  console,
  String
});
await new Promise(resolve => setImmediate(resolve));
assert.equal(loginClientOptions.auth.flowType, 'pkce');
assert.equal(loginClientOptions.auth.detectSessionInUrl, false);
assert.equal(typeof loginEvents.click, 'function', 'login must bind its OAuth action');
await loginEvents.click();
assert.equal(oauthOptions.provider, 'google');
assert.equal(oauthOptions.options.redirectTo, 'https://staging.example.test/auth-callback.html');

const disabledProviderElements = {
  'google-login': { disabled: false, addEventListener() { throw new Error('disabled provider must not bind OAuth'); } },
  status: { textContent: '', classList: { add() {}, remove() {} } }
};
vm.runInNewContext(read('auth-login.js'), {
  window: loginWindow,
  document: { getElementById: id => disabledProviderElements[id] || null },
  location: loginLocation,
  fetch: async () => ({ ok: true, async json() { return { external: { google: false } }; } }),
  sessionStorage: { getItem() { return null; }, removeItem() {} },
  console,
  String
});
await new Promise(resolve => setImmediate(resolve));
assert.equal(disabledProviderElements['google-login'].disabled, true);
assert.match(disabledProviderElements.status.textContent, /Google Login.*ยังไม่ได้เปิดใช้งาน/);

let exchangedCode;
let sanitizedCallbackUrl;
let callbackDestination;
const callbackElements = { status: { textContent: '' }, error: { textContent: '' } };
const callbackLocation = {
  search: '?code=one-time-code',
  replace(value) { callbackDestination = value; }
};
const callbackWindow = {
  CHANANYA_AUTH: { url: 'https://staging.supabase.co', anonKey: 'sb_publishable_test' },
  supabase: {
    createClient() {
      return { auth: { async exchangeCodeForSession(code) { exchangedCode = code; return { error: null }; } } };
    }
  }
};
vm.runInNewContext(read('auth-callback.js'), {
  window: callbackWindow,
  document: { title: 'Callback', getElementById: id => callbackElements[id] },
  location: callbackLocation,
  history: { replaceState(_state, _title, url) { sanitizedCallbackUrl = url; } },
  URLSearchParams,
  sessionStorage: { getItem() { return null; }, removeItem() {} },
  setTimeout,
  console,
  String
});
await new Promise(resolve => setImmediate(resolve));
assert.equal(exchangedCode, 'one-time-code');
assert.equal(sanitizedCallbackUrl, '/auth-callback.html');
assert.equal(callbackDestination, '/');

const login = read('login.html');
const legacyLogin = read('login-v3.html');
const callback = read('auth-callback.html');
assert.match(login, /auth-login\.js/);
assert.match(legacyLogin, /auth-login\.js/);
assert.match(callback, /auth-callback\.js/);
assert.match(read('auth-login.js'), /detectSessionInUrl:\s*false/);
assert.match(read('auth-callback.js'), /exchangeCodeForSession/);

const netlify = read('netlify.toml');
const cspMatch = netlify.match(/Content-Security-Policy = "([^"]+)"/);
assert.ok(cspMatch, 'Netlify must enforce a Content-Security-Policy');
const directives = Object.fromEntries(cspMatch[1].split(';').map(value => {
  const [name, ...tokens] = value.trim().split(/\s+/);
  return [name, tokens];
}));

assert.deepEqual(directives['default-src'], ["'self'"]);
assert.ok(directives['script-src'].includes("'self'"));
assert.ok(directives['script-src'].includes('https://cdn.jsdelivr.net'));
assert.ok(directives['script-src'].includes('https://static.line-scdn.net'));
assert.ok(!directives['script-src'].includes("'unsafe-inline'"), 'inline scripts must remain blocked');
assert.ok(!directives['script-src'].includes("'unsafe-eval'"), 'eval must remain blocked');
assert.deepEqual(directives['object-src'], ["'none'"]);
assert.deepEqual(directives['base-uri'], ["'none'"]);
assert.deepEqual(directives['frame-ancestors'], ["'none'"]);
assert.ok(directives['connect-src'].includes('https://*.supabase.co'));
assert.ok(directives['connect-src'].includes('wss://*.supabase.co'));

assert.match(netlify, /Referrer-Policy = "no-referrer"/);
assert.match(netlify, /Strict-Transport-Security = "max-age=31536000"/);
assert.match(netlify, /Cross-Origin-Opener-Policy = "same-origin-allow-popups"/);
assert.match(netlify, /for = "\/"[\s\S]*?Cache-Control = "private, no-store, max-age=0"/);
assert.match(netlify, /for = "\/\*\.html"[\s\S]*?Cache-Control = "private, no-store, max-age=0"/);

console.log(`Browser security contracts passed: ${htmlFiles.length} HTML routes, pinned SDK, CSP and PHI no-store headers`);
