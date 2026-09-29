import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
const source = fs.readFileSync(new URL('../foundation.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('  let suggestionSubmitting ='), source.indexOf('  async function decideSuggestion('));
const stored = new Map();
function harness() {
  const h = { calls: [], resets: 0, notices: [], payload: '{"definition":"Synthetic"}', finish: null };
  h.button = { disabled: false };
  h.form = { querySelector: () => h.button, reset() { h.resets++; } };
  h.ctx = { $: selector => selector === '#ttm-suggestion-form' ? h.form : ({ value: selector.endsWith('payload') ? h.payload : 'synthetic' }),
    session: { user: { id: 'synthetic-user' } }, profile: { clinic_id: 'synthetic-clinic' },
    crypto: webcrypto, TextEncoder,
    sessionStorage: { getItem: key => stored.get(key) ?? null, setItem: (key,value) => stored.set(key,value), removeItem: key => stored.delete(key) },
    db: { rpc(name,params) { h.calls.push({ name,params }); return new Promise(resolve => { h.finish = resolve; }); } },
    toast: text => h.notices.push(text), loadSuggestionQueue: async () => {}, loadReviewHistory: async () => {} };
  vm.createContext(h.ctx); vm.runInContext(code, h.ctx);
  h.submit = () => h.ctx.submitSuggestion({ preventDefault() {}, target: h.form });
  h.wait = async () => { for (let i=0; i<100 && !h.finish; i++) await new Promise(resolve => setTimeout(resolve, 2)); assert.ok(h.finish); };
  h.success = () => h.finish({ data: { id: 'synthetic-result', client_request_id: h.calls.at(-1).params.p_request_id } });
  return h;
}
let h = harness();
const first = h.submit(); await h.submit(); await h.wait();
assert.equal(h.calls.length, 1); assert.equal(h.button.disabled, true);
assert.equal(h.calls[0].name, 'submit_ttm_knowledge_suggestion_once');
const originalId = h.calls[0].params.p_request_id;
h.finish({ error: new Error('Synthetic network failure') });
await assert.rejects(first, /Synthetic network failure/);
assert.equal(h.resets, 0); assert.equal(h.button.disabled, false);
assert.equal(stored.size, 1);
assert.doesNotMatch([...stored.values()][0], /Synthetic|definition/);
// A denied retry says nothing about whether the first attempt committed.
h = harness(); const deniedRetry = h.submit(); await h.wait();
h.finish({ error: { code: '42501', message: 'Synthetic retry denial' } });
await assert.rejects(deniedRetry); assert.equal(stored.size, 1);

// Reload with the same storage and recreated form: request identity survives.
h = harness(); h.payload = '{"definition":"Changed"}';
await assert.rejects(h.submit(), /คำขอเดิม/); assert.equal(h.calls.length, 0);
h.payload = '{"definition":"Synthetic"}';
const retry = h.submit(); await h.wait();
assert.equal(h.calls[0].params.p_request_id, originalId);
h.ctx.loadSuggestionQueue = async () => { throw new Error('Synthetic reload failure'); };
h.success(); await assert.rejects(retry, /Synthetic reload failure/);
assert.equal(h.resets, 1); assert.equal(h.notices.length, 1); assert.equal(stored.size, 0);

// A definitive rollback permits correction; blocked storage never calls RPC.
h = harness(); const denied = h.submit(); await h.wait();
h.finish({ error: { code: '23514', message: 'Synthetic invalid payload' } });
await assert.rejects(denied); assert.equal(stored.size, 0); assert.equal(h.resets, 0);
h = harness(); h.ctx.sessionStorage.setItem = () => { throw new Error('Storage blocked'); };
await assert.rejects(h.submit(), /Storage blocked/); assert.equal(h.calls.length, 0);

// Read-back recovery finds an acknowledged request without a second write.
h = harness(); const lost = h.submit(); await h.wait();
h.finish({ error: new Error('Lost response') }); await assert.rejects(lost);
const filters = [];
h.ctx.db.from = table => { assert.equal(table, 'ttm_knowledge_suggestions'); return {
  select() { return this; }, eq(key,value) { filters.push([key,value]); return this; },
  maybeSingle: async () => ({ data: { id: 'synthetic-result', suggestion_no: 'SYNTHETIC', status: 'pending' } })
}; };
await h.ctx.recoverSuggestionRequest();
assert.equal(stored.size, 0); assert.equal(h.calls.length, 1); assert.equal(h.resets, 1);
assert.ok(filters.some(([key,value]) => key === 'requested_by' && value === 'synthetic-user'));
assert.ok(filters.some(([key,value]) => key === 'clinic_id' && value === 'synthetic-clinic'));
h = harness(); const editedDuringSend = h.submit(); await h.wait();
h.payload = '{"definition":"New unsent draft"}';
h.success(); await editedDuringSend;
assert.equal(h.resets, 0, 'late acknowledgement must not erase edits made while waiting');
assert.match(h.notices[0], /ยังไม่ได้ส่ง/);
console.log('TTM submit UI: duplicate guard, reload replay, changed-content refusal, storage failure, rollback correction, acknowledged refresh failure, scoped recovery and newer draft preservation passed; simulation only');
for (const identity of ['session','profile','signed-out']) {
  stored.clear();h=harness();let release;
  h.ctx.suggestionFingerprint=()=>new Promise(resolve=>{release=()=>resolve('a'.repeat(64));});
  const hashing=h.submit().catch(error=>error);
  if(identity==='signed-out')h.ctx.session=null;
  else if(identity==='session')h.ctx.session={user:{id:'different'}};
  else h.ctx.profile={clinic_id:'different'};
  release();await hashing;
  assert.equal(h.calls.length,0,'identity change during hashing must prevent dispatch');
  assert.equal(stored.size,0);
  for(const denied of [false,true]) {
    stored.clear();h=harness();const pending=h.submit().catch(error=>error);await h.wait();
    const marker=[...stored.entries()];
    if(identity==='signed-out')h.ctx.session=null;
    else if(identity==='session')h.ctx.session={user:{id:'different'}};
    else h.ctx.profile={clinic_id:'different'};
    if(denied)h.finish({error:{code:'42501',message:'old actor result'}});else h.success();
    await pending;
    assert.deepEqual([...stored.entries()],marker,'changed context must preserve unresolved original request');
    assert.equal(h.resets,0);assert.equal(h.notices.length,0);
  }
}
stored.clear();
console.log('TTM submission identity races passed: no dispatch after hash-time identity change; late success/denial preserves original recovery marker');
