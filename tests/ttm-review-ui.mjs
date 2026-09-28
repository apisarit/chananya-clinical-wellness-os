import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import './ttm-submit-ui.mjs';

const source = fs.readFileSync(new URL('../foundation.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('  function renderSuggestionQueue()'), source.indexOf('  let suggestionSubmitting ='));
const target = { innerHTML: '' };
const ctx = {
  $: () => target, session: { user: { id: 'reviewer' } }, profile: {clinic_id:'synthetic'}, suggestions: [], queueRequest: 0,
  reviewCapabilities: () => ({ canApprove: true }),
  esc: value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])),
  console: { warn() {} }, fetchAll: async () => { throw new Error('network failure'); }
};
vm.createContext(ctx);
vm.runInContext(code, ctx);
const row = { id: 'synthetic', status: 'pending', action: 'update', requested_by: 'author', payload: { definition: '<script>new</script>' }, target_snapshot: { definition: '<img src=x>' } };
function render(item) { ctx.suggestions = [item]; ctx.renderSuggestionQueue(); return target.innerHTML; }
let html = render(row);
assert.match(html, /ข้อมูลเดิม ณ วันที่เสนอ/);
assert.match(html, /ยังไม่ใช่ข้อมูลที่เผยแพร่/);
assert.match(html, /&lt;img/);
assert.doesNotMatch(html, /<script>|<img/);
assert.doesNotMatch(html, / disabled/);
html = render({ ...row, requested_by: 'reviewer' });
assert.equal((html.match(/ disabled/g) || []).length, 2);
html = render({ ...row, target_snapshot: null });
assert.match(html, /action="approve"[^>]* disabled/);
assert.doesNotMatch(html, /action="reject"[^>]* disabled/);
html = render({ ...row, action: 'create', target_snapshot: null });
assert.doesNotMatch(html, / disabled/);
await ctx.loadSuggestionQueue();
assert.match(target.innerHTML, /role="alert"/);
assert.doesNotMatch(target.innerHTML, /ไม่มี suggestion|ยังไม่ได้ติดตั้ง/);
console.log('TTM review UI passed: escaped baseline/proposal, self-review controls, missing baseline, honest read failure');
ctx.historyRequest = 0;
let response = { data: [{ event: 'knowledge_applied', after_snapshot: { definition: '<script>unsafe</script>' }, before_snapshot: { definition: 'before' }, actor_id: 'synthetic' }] };
ctx.db = { from(table) {
  assert.equal(table, 'ttm_knowledge_suggestion_events');
  return { select() { return this; }, order() { return this; }, range(start, end) { assert.equal(start, 0); assert.equal(end, 50); return Promise.resolve(response); } };
} };
await ctx.loadReviewHistory();
assert.match(target.innerHTML, /เนื้อหาก่อน–หลัง/);
assert.doesNotMatch(target.innerHTML, /<script>/);
response = { data: Array.from({ length: 51 }, () => ({ event: 'approve' })) };
await ctx.loadReviewHistory();
assert.equal((target.innerHTML.match(/<article/g) || []).length, 50);
assert.match(target.innerHTML, /ยังมีประวัติเก่า/);
response = { error: new Error('Synthetic read failure') };
await ctx.loadReviewHistory();
assert.match(target.innerHTML, /role="alert"/);
assert.doesNotMatch(target.innerHTML, /<article/);
console.log('TTM history UI passed: bounded query, content escaping, explicit truncation and error replacing stale history');

for (const fails of [false,true]) {
  let release;
  ctx.fetchAll=()=>new Promise((resolve,reject)=>{release=()=>fails?reject(new Error('older failure')):resolve([{...row,suggestion_no:'OLD'}]);});
  const older=ctx.loadSuggestionQueue();
  ctx.fetchAll=async()=>[{...row,suggestion_no:'NEW'}];
  await ctx.loadSuggestionQueue();
  release(); await older;
  assert.match(target.innerHTML,/NEW/);
  assert.doesNotMatch(target.innerHTML,/OLD|role="alert"/);
  assert.equal(ctx.suggestions[0].suggestion_no,'NEW');
}
for (const field of ['session','profile']) {
  for (const fails of [false,true]) {
    let release;
    ctx.fetchAll=()=>new Promise((resolve,reject)=>{release=()=>fails?reject(new Error('old actor')):resolve([{...row,suggestion_no:'OLD-ACTOR'}]);});
    const pending=ctx.loadSuggestionQueue();
    ctx[field]=field==='session'?{user:{id:'new-actor'}}:{clinic_id:'new-clinic'};
    const before=target.innerHTML;
    release(); await pending;
    assert.equal(target.innerHTML,before,'old-context queue result must not update the page');
  }
}
console.log('TTM queue ordering passed: old success/failure and changed actor/clinic responses cannot replace current queue');
for (const field of ['session','profile']) {
  for (const fails of [false,true]) {
    let release;
    ctx.db={from(){return {select(){return this;},order(){return this;},range(){return new Promise(resolve=>{release=()=>resolve(fails?{error:new Error('old actor')}:{data:[{event:'approve',actor_id:'OLD-ACTOR'}]});});}};}};
    const pending=ctx.loadReviewHistory();
    ctx[field]=field==='session'?{user:{id:'another-actor'}}:{clinic_id:'another-clinic'};
    target.innerHTML='CURRENT-CONTEXT';
    release(); await pending;
    assert.equal(target.innerHTML,'CURRENT-CONTEXT','old-context history must not appear after an account change');
  }
}
console.log('TTM history context boundary passed: delayed success/error cannot render for a changed actor or clinic');
