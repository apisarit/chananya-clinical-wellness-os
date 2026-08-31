(() => {
  'use strict';

  const button = document.getElementById('google-login') || document.getElementById('login');
  const status = document.getElementById('status');
  const error = document.getElementById('error');

  function showError(cause, retryable = true) {
    const message = cause?.message || String(cause || 'เข้าสู่ระบบไม่สำเร็จ');
    if (button) button.disabled = !retryable;
    if (status) {
      status.classList.add('error');
      status.textContent = 'เข้าสู่ระบบไม่สำเร็จ';
    }
    if (error) error.textContent = message;
    else if (status) status.textContent = message;
  }

  async function oauthProviderStatus(url, key, provider) {
    try {
      const response = await fetch(`${String(url).replace(/\/$/, '')}/auth/v1/settings`, {
        headers: { apikey: key }
      });
      if (!response.ok) return null;
      const settings = await response.json();
      return settings?.external?.[provider] === true;
    } catch {
      // A settings probe must not block login when the provider endpoint is
      // temporarily unavailable. The OAuth request remains authoritative.
      return null;
    }
  }

  async function start() {
    if (!button || !status) throw new Error('Login controls are unavailable');
    const config = window.CHANANYA_AUTH || {};
    const url = config.url || config.supabaseUrl;
    const key = config.anonKey || config.publishableKey;
    const provider = String(config.provider || 'google').trim().toLowerCase();
    const providerLabel = provider === 'google' ? 'Google' : provider.charAt(0).toUpperCase() + provider.slice(1);
    if (!window.supabase || !url || !key) throw new Error('ไม่พบ Supabase configuration');
    button.textContent = `เข้าสู่ระบบด้วย ${providerLabel}`;
    document.querySelectorAll?.('[data-auth-provider-name]').forEach(element => { element.textContent = providerLabel; });

    const client = window.supabase.createClient(url, key, {
      auth: {
        flowType: 'pkce',
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false
      }
    });
    const sessionResult = await client.auth.getSession();
    if (sessionResult.error) throw sessionResult.error;
    if (sessionResult.data.session) {
      location.replace('/');
      return;
    }

    const providerEnabled = await oauthProviderStatus(url, key, provider);
    if (providerEnabled === false) {
      button.disabled = true;
      status.classList.add('error');
      status.textContent = `${providerLabel} Login ของ CNYOS Staging ยังไม่ได้เปิดใช้งาน`;
      return;
    }

    button.addEventListener('click', async () => {
      button.disabled = true;
      status.classList.remove('error');
      status.textContent = `กำลังเปิด ${providerLabel}…`;
      if (error) error.textContent = '';
      const result = await client.auth.signInWithOAuth({
        provider,
        options: { redirectTo: `${location.origin}/auth-callback.html` }
      });
      if (result.error) showError(result.error, true);
    });
  }

  start().catch(cause => showError(cause, false));
})();
