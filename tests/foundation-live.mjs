import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = fs.readFileSync(new URL('../foundation-live.js', import.meta.url), 'utf8');
function harness(refresh = async () => {}) {
  const timers = new Map();
  let next = 0;
  const subscriptions = [];
  const statuses = [];
  const listeners = new Map();
  const host = {
    setTimeout(fn, delay) { const id = ++next; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener(event, fn) { listeners.set(`host:${event}`, fn); },
    removeEventListener(event) { listeners.delete(`host:${event}`); }
  };
  const page = {
    hidden: false,
    addEventListener(event, fn) { listeners.set(`page:${event}`, fn); },
    removeEventListener(event) { listeners.delete(`page:${event}`); }
  };
  const channel = {
    on(type, filter, fn) { subscriptions.push({ type, filter, fn }); return this; },
    subscribe(fn) { this.notify = fn; return this; }
  };
  let removed = 0;
  const db = { channel: () => channel, removeChannel: async () => { removed++; } };
  vm.runInNewContext(source, { window: host, document: page });
  const live = host.ChananyaFoundationLive.create({ db, refresh, onStatus: value => statuses.push(value), host, page });
  async function tick(delay) {
    const selected = [...timers].filter(([, timer]) => timer.delay === delay);
    for (const [id, timer] of selected) { timers.delete(id); await timer.fn(); }
    await Promise.resolve();
  }
  return { live, db, page, channel, subscriptions, statuses, timers, listeners, tick, removed: () => removed };
}

test('subscribes only to knowledge tables, catches initial gap and batches change bursts', async () => {
  let reads = 0;
  const h = harness(async () => { reads++; });
  h.live.start();
  h.live.start();
  const events = h.subscriptions.filter(item => item.type === 'postgres_changes');
  assert.deepEqual(events.map(item => item.filter.table), ['ttm_sources', 'ttm_concepts', 'ttm_concept_relations', 'ttm_diagnostic_knowledge']);
  assert.ok(events.every(item => item.filter.event === '*' && !item.filter.filter));
  h.channel.notify('SUBSCRIBED');
  for (let i = 0; i < 100; i++) events[i % 4].fn({ new: { shouldNeverBeRenderedDirectly: true } });
  await h.tick(350);
  assert.equal(reads, 1);
  assert.equal(h.statuses.at(-1), 'live');
  assert.equal(h.timers.size, 0);
});

test('serializes reads and refetches events received during a read', async () => {
  let reads = 0;
  let release;
  const h = harness(() => { reads++; return reads === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve(); });
  h.live.start();
  h.channel.notify('SUBSCRIBED');
  const first = h.tick(350);
  h.live.request();
  h.live.request();
  assert.equal(reads, 1);
  release();
  await first;
  await h.tick(350);
  assert.equal(reads, 2);
});

test('reconnect catches missed changes; errors use bounded polling and recover', async () => {
  let fail = true;
  let reads = 0;
  const h = harness(async () => { reads++; if (fail) throw new Error('network'); });
  h.live.start();
  h.channel.notify('SUBSCRIBED');
  await h.tick(350);
  assert.equal(h.statuses.at(-1), 'stale');
  fail = false;
  h.channel.notify('CHANNEL_ERROR');
  await h.tick(30000);
  await h.tick(350);
  assert.equal(h.statuses.at(-1), 'fallback');
  h.channel.notify('SUBSCRIBED');
  await h.tick(350);
  assert.equal(h.statuses.at(-1), 'live');
  assert.equal(reads, 3);
  assert.equal(h.timers.size, 0);
});

test('handles missing publication/system errors even on an open channel', async () => {
  const h = harness();
  h.live.start();
  h.channel.notify('SUBSCRIBED');
  await h.tick(350);
  h.subscriptions.find(item => item.type === 'system').fn({ extension: 'postgres_changes', status: 'error' });
  assert.equal(h.statuses.at(-1), 'fallback');
  assert.ok([...h.timers.values()].some(timer => timer.delay === 30000));
});

test('defers hidden-page work and reconciles on visibility/focus', async () => {
  let reads = 0;
  const h = harness(async () => { reads++; });
  h.live.start();
  h.page.hidden = true;
  h.channel.notify('SUBSCRIBED');
  h.live.request();
  await h.tick(350);
  assert.equal(reads, 0);
  h.page.hidden = false;
  h.listeners.get('page:visibilitychange')();
  await h.tick(350);
  assert.equal(reads, 1);
  h.listeners.get('host:focus')();
  await h.tick(350);
  assert.equal(reads, 2);
});

test('page exit removes channel, timers and listeners; ignores late callbacks', async () => {
  let reads = 0;
  const h = harness(async () => { reads++; });
  h.live.start();
  h.channel.notify('SUBSCRIBED');
  h.live.stop();
  const count = h.statuses.length;
  h.channel.notify('CLOSED');
  h.live.request();
  await h.tick(350);
  assert.equal(h.removed(), 1);
  assert.equal(h.timers.size, 0);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.statuses.length, count);
  assert.equal(reads, 0);
});

test('missing realtime client falls back to periodic reads', async () => {
  let reads = 0;
  const h = harness(async () => { reads++; });
  h.db.channel = () => { throw new Error('unavailable'); };
  h.live.start();
  await h.tick(30000);
  await h.tick(350);
  assert.equal(reads, 1);
  assert.equal(h.statuses.at(-1), 'fallback');
});
