(() => {
  'use strict';

  const status = document.getElementById('status');
  const error = document.getElementById('error');

  async function exchangeAuthorizationCode() {
    const config = window.CHANANYA_AUTH || {};
    const url = config.url || config.supabaseUrl;
    const key = config.anonKey || config.publishableKey;
    if (!window.supabase || !url || !key) throw new Error('ไม่พบ Supabase configuration');

    const code = new URLSearchParams(location.search).get('code');
    if (!code) throw new Error('Missing authorization code');

    const client = window.supabase.createClient(url, key, {
      auth: {
        flowType: 'pkce',
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false
      }
    });
    const result = await client.auth.exchangeCodeForSession(code);
    if (result.error) throw result.error;

    history.replaceState({}, document.title, '/auth-callback.html');
    status.textContent = 'เข้าสู่ระบบสำเร็จ';
    location.replace('/');
  }

  exchangeAuthorizationCode().catch(cause => {
    status.textContent = 'เข้าสู่ระบบไม่สำเร็จ';
    error.textContent = cause?.message || String(cause);
    setTimeout(() => location.replace('/login.html'), 2500);
  });
})();
