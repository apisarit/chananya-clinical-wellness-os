import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const html = fs.readFileSync(new URL('owner-control.html', root), 'utf8');
const js = fs.readFileSync(new URL('owner-control.js', root), 'utf8');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
assert.equal(new Set(ids).size, ids.length, 'Owner page IDs must be unique');
for (const [, id] of js.matchAll(/\$\('#([^']+)'\)/g)) {
  assert.ok(ids.includes(id), `Owner controller element missing from HTML: ${id}`);
}
for (const id of ['owner-refresh', 'owner-recovery-retry', 'owner-recovery-login']) {
  assert.match(html, new RegExp(`<button[^>]*id="${id}"[^>]*type="button"`), `${id} must not submit a form`);
}
for (const id of ['owner-refresh', 'owner-recovery-login', 'owner-clinic', 'owner-state', 'owner-confirm-code', 'owner-reason', 'owner-submit', 'owner-drive-submit']) {
  assert.match(html, new RegExp(`<[^>]+id="${id}"[^>]*\\bdisabled\\b`), `${id} must start disabled`);
}
assert.match(html, /id="owner-recovery-actions" hidden/);
assert.match(html, /id="owner-boot-spinner"/);
assert.match(html, /owner-control\.js\?v=cnyos-owner-recovery-20260906/);
assert.match(html, /supabase-js@2\.112\.4" integrity="sha384-yiVMs0R\/Jyz7OhoXa\/DsEMUSBLjEhr\/QJta2ONO\+zB6I8\/GmNg\/7AUFrZmAJV7KV" crossorigin="anonymous"/);
assert.match(html, /owner-control\.css\?v=cnyos-owner-recovery-20260906/);
const css = fs.readFileSync(new URL('owner-control.css', root), 'utf8');
assert.match(css, /\.owner-console-page \[hidden\] \{ display: none !important; \}/);
assert.ok(!html.includes('onclick='), 'No inline click handlers');
assert.ok(!html.includes('owner-onoff.netlify.app'), 'Do not introduce the incorrect standalone URL');
console.log('PASS Owner recovery HTML wiring, unique IDs, disabled controls and pinned SDK integrity');
