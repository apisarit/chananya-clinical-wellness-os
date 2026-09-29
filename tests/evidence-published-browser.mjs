// SIMULATION_ONLY: published Evidence HTML/modules, synthetic auth/provider.
// All browser requests are intercepted; no live credentials or patient data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { buildNetlifyPublish } from '../scripts/build-netlify-publish.mjs';
import { GENERATED_CONFIG_DIRECTORY } from '../scripts/generate-tenant-config.mjs';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'cnyos-evidence-browser-'));
let browser;
try {
  const files = new Map();
  for (const name of ['evidence.html', 'evidence-page.mjs', 'evidence-view.mjs', 'evidence.css', 'app.css']) {
    files.set(name, fs.readFileSync(new URL(`../${name}`, import.meta.url)));
  }
  for (const name of ['index.html', 'login.html', 'auth-callback.html', 'app.js', 'auth-config.js', 'tenant-brand.js', 'chananya-runtime.js', 'app-shell.js']) {
    files.set(name, Buffer.from(name.endsWith('.html') ? '<!doctype html><p>SIMULATION_ONLY</p>' : '/* synthetic bootstrap */'));
  }
  for (const [name, body] of files) fs.writeFileSync(path.join(fixture, name), body);
  const generated = path.join(fixture, GENERATED_CONFIG_DIRECTORY);
  fs.mkdirSync(generated);
  for (const name of ['tenant-config.js', 'brand-config.js']) fs.writeFileSync(path.join(generated, name), '/* SIMULATION_ONLY */');
  fs.writeFileSync(path.join(generated, 'deploy-manifest.json'), JSON.stringify({ build: { deploymentClass: 'dedicated-staging' } }));
  await buildNetlifyPublish({ cwd: fixture, sourceFiles: files });
  browser = await chromium.launch({ headless: true, ...(process.env.CNYOS_TEST_BROWSER_PATH ? { executablePath: process.env.CNYOS_TEST_BROWSER_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.addInitScript(() => {
    window.syntheticAllowed = true;
    window.ChananyaRuntime = {
      getSession: async () => ({ access_token: 'synthetic-only', user: { id: 'synthetic-user' } }),
      getProfile: async () => ({ role: 'practitioner' }),
      can: () => window.syntheticAllowed,
      getDb: () => ({ auth: {
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        signOut: async () => ({})
      } })
    };
    window.ChananyaShell = { mount() {} };
  });
  const requested = [];
  const apiCalls = [];
  let status = 200;
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'https://evidence-test.invalid') return route.abort();
    requested.push(url.pathname);
    if (url.pathname === '/api/evidence-search') {
      const body = route.request().postDataJSON();
      apiCalls.push(body);
      assert.equal(route.request().headers().authorization, 'Bearer synthetic-only');
      return route.fulfill({ status, json: status === 200 ? {
        ok: true, source: body.source, retrievedAt: '2026-09-27T00:00:00Z',
        results: [
          { id: 'NCT12345678', title: '<img src=x onerror="window.injected=true">', detail: 'Synthetic reference' },
          { id: '../private', title: 'Must not render' }
        ]
      } : { ok: false, code: 'SYNTHETIC_DENIED' } });
    }
    const name = url.pathname.slice(1);
    if (!files.has(name) && !['tenant-config.js', 'brand-config.js'].includes(name)) return route.abort();
    const contentType = name.endsWith('.html') ? 'text/html' : name.endsWith('.css') ? 'text/css' : 'text/javascript';
    return route.fulfill({ contentType, body: fs.readFileSync(path.join(fixture, 'dist', name)) });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('https://evidence-test.invalid/evidence.html');
  await page.locator('#app:not(.hidden)').waitFor();
  await page.locator('#evidence-query').fill('Synthetic curcumin');
  await page.locator('#evidence-submit').click();
  await page.getByText('Synthetic reference', { exact: true }).waitFor();
  assert.deepEqual(apiCalls, [{ source: 'clinicaltrials', query: 'Synthetic curcumin' }]);
  assert.equal(await page.locator('#evidence-results article').count(), 1);
  assert.equal(await page.locator('#evidence-results img').count(), 0);
  assert.equal(await page.evaluate(() => !!window.injected), false);
  assert.equal(await page.locator('#evidence-results a').getAttribute('href'), 'https://clinicaltrials.gov/study/NCT12345678');
  assert.ok(requested.includes('/evidence-page.mjs') && requested.includes('/evidence-view.mjs'));
  await page.locator('#evidence-source').selectOption('dailymed');
  assert.equal(await page.locator('#evidence-results article').count(), 0);
  status = 403;
  await page.locator('#evidence-submit').click();
  await page.getByText('บัญชีหรือคลินิกนี้ไม่มีสิทธิ์ค้นในขณะนี้ กรุณาติดต่อผู้ดูแล', { exact: true }).waitFor();
  assert.equal(await page.locator('#evidence-submit').isDisabled(), true);
  assert.equal(await page.locator('#evidence-output').getAttribute('aria-busy'), 'false');
  assert.equal(await page.locator('#evidence-results article').count(), 0);
  assert.deepEqual(errors, []);
  console.log('Published Evidence browser passed: real module loading, synthetic search, citation safety, source reset and permission denial. No live auth/provider verification.');
} finally {
  await browser?.close();
  fs.rmSync(fixture, { recursive: true, force: true });
}
