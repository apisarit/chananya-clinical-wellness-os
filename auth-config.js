(() => {
  'use strict';
  const config = window.CLINICAL_OS_CONFIG || {};
  const database = config.database || {};
  const auth = config.auth || {};
  const url = database.url || '';
  const publishableKey = database.publishableKey || '';

  // Backward-compatible alias while legacy pages are retired. This object is
  // generated from the per-deployment tenant config; it must contain only a
  // browser-safe Supabase publishable key, never a service-role key.
  window.CHANANYA_AUTH = Object.freeze({
    url,
    anonKey: publishableKey,
    supabaseUrl: url,
    publishableKey,
    redirectTo: auth.redirectOrigin || location.origin
  });
})();
