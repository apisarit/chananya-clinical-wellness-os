/* Realtime events invalidate the graph; all reads still use the signed-in client. */
(() => {
  'use strict';
  const TABLES = Object.freeze(['ttm_sources', 'ttm_concepts', 'ttm_concept_relations', 'ttm_diagnostic_knowledge']);

  function create({ db, refresh, onStatus, tables = TABLES, host = window, page = document }) {
    let channel = null;
    let timer = null;
    let retryTimer = null;
    let pending = false;
    let running = false;
    let stopped = true;
    let connected = false;
    let generation = 0;

    function status(value) { if (!stopped) onStatus(value); }
    function fallback() {
      if (stopped || retryTimer !== null) return;
      retryTimer = host.setTimeout(() => {
        retryTimer = null;
        request();
      }, 30000);
    }
    function request() {
      if (stopped) return;
      pending = true;
      // Fixed window, not a trailing debounce: continuous imports cannot starve refresh.
      if (page.hidden || running || timer !== null) return;
      timer = host.setTimeout(flush, 350);
    }
    async function flush() {
      timer = null;
      if (stopped || page.hidden || running || !pending) return;
      const current = generation;
      running = true;
      pending = false;
      status('refreshing');
      try {
        await refresh();
        if (stopped || current !== generation) return;
        status(connected ? 'live' : 'fallback');
        if (!connected) fallback();
      } catch (error) {
        if (stopped || current !== generation) return;
        status('stale');
        fallback();
      } finally {
        running = false;
        if (!stopped && pending) request();
      }
    }
    function wake() { if (!page.hidden) request(); }
    function offline() { connected = false; status('fallback'); fallback(); }
    function start() {
      if (!stopped) return;
      stopped = false;
      generation += 1;
      status('connecting');
      host.addEventListener('online', wake);
      host.addEventListener('offline', offline);
      host.addEventListener('focus', wake);
      page.addEventListener('visibilitychange', wake);
      try {
        const subscription = db.channel('foundation-knowledge-live');
        channel = subscription;
        for (const table of tables) {
          // No active=true filter: deactivation must also invalidate the local graph.
          subscription.on('postgres_changes', { event: '*', schema: 'public', table }, request);
        }
        subscription.on('system', {}, payload => {
          if (stopped || channel !== subscription) return;
          if (payload.extension === 'postgres_changes' && payload.status === 'error') offline();
        });
        subscription.subscribe(value => {
          if (stopped || channel !== subscription) return;
          connected = value === 'SUBSCRIBED';
          if (connected) {
            if (retryTimer !== null) host.clearTimeout(retryTimer);
            retryTimer = null;
            // Catch changes during initial load and every reconnect.
            request();
          } else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(value)) {
            status('fallback');
            fallback();
          }
        });
        fallback();
      } catch {
        status('fallback');
        fallback();
      }
    }
    function stop() {
      stopped = true;
      generation += 1;
      connected = false;
      pending = false;
      host.clearTimeout(timer);
      host.clearTimeout(retryTimer);
      timer = retryTimer = null;
      host.removeEventListener('online', wake);
      host.removeEventListener('offline', offline);
      host.removeEventListener('focus', wake);
      page.removeEventListener('visibilitychange', wake);
      const previous = channel;
      channel = null;
      if (previous) Promise.resolve(db.removeChannel(previous)).catch(() => {});
    }
    return Object.freeze({ start, stop, request });
  }
  window.ChananyaFoundationLive = Object.freeze({ create, tables: TABLES });
})();
