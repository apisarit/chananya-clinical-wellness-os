// Local read-only report, with all outbound requests blocked. No patient data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { captureKnowledgeSourceCandidate } from '../scripts/knowledge-source-candidate.mjs';
import { renderKnowledgeReview } from '../scripts/render-knowledge-review.mjs';

const packet = await captureKnowledgeSourceCandidate();
const html = renderKnowledgeReview(packet);
const browser = await chromium.launch({ headless: true,
  ...(process.env.CNYOS_TEST_BROWSER_PATH ? { executablePath: process.env.CNYOS_TEST_BROWSER_PATH } : {}) });
try {
  const context = await browser.newContext();
  const unexpectedRequests = [];
  await context.route('**/*', route => {
    unexpectedRequests.push(route.request().url());
    return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://cnyos-source-review.invalid/', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://cnyos-source-review.invalid/');
  assert.equal(await page.locator('.knowledge-row').count(), 113);
  assert.equal(await page.locator('form,button,script,iframe,img').count(), 0);
  assert.equal(await page.locator('#candidate-id').textContent(), packet.candidateId);
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('.skip').evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#contents').evaluate(node => node === document.activeElement), true);
  const row = page.locator('.knowledge-row').first();
  await row.locator(':scope > summary').focus();
  await page.keyboard.press('Enter');
  assert.equal(await row.getAttribute('open'), '');
  assert.equal(await row.locator('.source-text').isVisible(), true);
  await row.locator('.raw > summary').click();
  assert.equal(await row.locator('pre').isVisible(), true);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `horizontal overflow at ${width}`);
  }
  await page.emulateMedia({ media: 'print' });
  assert.equal(await page.locator('.knowledge-row').nth(1).locator('.source-text').isVisible(), true,
    'print preview must not silently omit collapsed source rows');
  await page.emulateMedia({ media: 'screen' });
  if (process.env.CNYOS_REVIEW_SCREENSHOT_DIR) {
    await fs.mkdir(process.env.CNYOS_REVIEW_SCREENSHOT_DIR, { recursive: true });
    for (const [name, width] of [['desktop', 1280], ['mobile', 390]]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: path.join(process.env.CNYOS_REVIEW_SCREENSHOT_DIR, `${name}.png`) });
    }
  }
  const altered = structuredClone(packet);
  const data = JSON.parse(gunzipSync(Buffer.from(altered.files[0].base64, 'base64')));
  const injection = '<img src="https://outside.invalid/collect" onerror="window.sourceExecuted=true">';
  data.rules[0].input_key = injection;
  data.rules[0].output_value = '</p><script>window.sourceExecuted=true</script>';
  data.rules[1].source_ref = '';
  const bytes = gzipSync(JSON.stringify(data));
  const digest = value => createHash('sha256').update(value).digest('hex');
  altered.files[0] = { path: altered.files[0].path, bytes: bytes.length, sha256: digest(bytes), base64: bytes.toString('base64') };
  altered.candidateId = digest(JSON.stringify({ schema: altered.schema, purpose: altered.purpose,
    reviewStatus: altered.reviewStatus, clinicalUse: altered.clinicalUse,
    files: altered.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })) }));
  await page.route('https://cnyos-source-review.invalid/rejected', route => route.fulfill({ contentType: 'text/html', body: renderKnowledgeReview(altered) }));
  await page.goto('https://cnyos-source-review.invalid/rejected');
  assert.ok((await page.locator('#problems').textContent()).includes('REQUIRED_TEXT:source_ref'));
  assert.equal(await page.locator('.knowledge-row').count(), 112);
  assert.ok((await page.locator('.knowledge-row').first().textContent()).includes(injection));
  assert.equal(await page.locator('img,script').count(), 0);
  assert.equal(await page.evaluate(() => window.sourceExecuted), undefined);
  assert.equal(unexpectedRequests.length, 0);
  assert.deepEqual(errors, []);
  console.log('Knowledge review browser passed: 320/390/1280 layout, keyboard disclosure, all rows in print, rejected-row display, escaped source injection and no outbound requests.');
} finally { await browser.close(); }
