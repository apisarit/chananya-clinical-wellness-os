(() => {
  'use strict';

  const $ = selector => document.querySelector(selector);
  let idToken = '';
  let linkedProfiles = [];
  let expiryTimer = null;

  const messages = Object.freeze({
    LINK_CODE_FORMAT_INVALID: 'รูปแบบรหัสเชื่อมบัญชีไม่ถูกต้อง',
    LINK_CODE_INVALID_OR_EXPIRED: 'รหัสเชื่อมบัญชีไม่ถูกต้องหรือหมดอายุแล้ว',
    LINE_ID_ALREADY_LINKED: 'LINE นี้เชื่อมกับผู้รับบริการรายอื่นอยู่แล้ว กรุณาติดต่อเจ้าหน้าที่',
    LINE_PATIENT_ALREADY_LINKED: 'ผู้รับบริการมีบัญชี LINE หลักอยู่แล้ว กรุณาให้เจ้าหน้าที่ตรวจสอบหรือยกเลิกบัญชีเดิม',
    CONSENT_REQUIRED: 'กรุณายืนยันความยินยอมก่อนเชื่อมบัญชี',
    LINE_ID_TOKEN_EXPIRED: 'การเข้าสู่ระบบ LINE หมดอายุ กรุณาเปิดใหม่อีกครั้ง',
    PATIENT_IDENTITY_NOT_LINKED: 'ยังไม่พบการเชื่อมบัญชีกับผู้รับบริการ',
    RATE_LIMITED: 'มีการเรียกใช้ถี่เกินไป กรุณารอสักครู่แล้วลองใหม่',
    PATIENT_IDENTITY_NOT_CONFIGURED: 'บริการบัตรผู้รับบริการดิจิทัลยังไม่เปิดใช้งาน',
    PATIENT_IDENTITY_REQUEST_FAILED: 'ไม่สามารถดำเนินการได้ในขณะนี้ กรุณาใช้ HN หรือติดต่อเจ้าหน้าที่'
  });

  function status(message, kind = '') {
    const element = $('#patient-app-status');
    element.textContent = message;
    element.classList.toggle('danger', kind === 'danger');
  }

  function setBusy(busy) {
    document.querySelectorAll('button, input, select').forEach(element => { element.disabled = Boolean(busy); });
  }

  async function loadLineSdk() {
    if (window.liff) return;
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const finish = error => {
        clearTimeout(timeout);
        script.removeEventListener('load', onLoad);
        script.removeEventListener('error', onError);
        if (error) {
          script.remove();
          reject(error);
        }
        else resolve();
      };
      const onLoad = () => finish();
      const onError = () => finish(new Error('LINE_SDK_UNAVAILABLE'));
      const timeout = setTimeout(() => onError(), 8000);
      script.src = 'https://static.line-scdn.net/liff/edge/2/sdk.js';
      script.async = true;
      script.referrerPolicy = 'no-referrer';
      script.addEventListener('load', onLoad, { once: true });
      script.addEventListener('error', onError, { once: true });
      document.head.append(script);
    });
  }

  async function api(action, payload = {}) {
    const response = await fetch('/api/patient-identity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      credentials: 'same-origin',
      body: JSON.stringify({ action, idToken, ...payload })
    });
    const body = await response.json().catch(() => ({ ok: false, code: 'PATIENT_IDENTITY_REQUEST_FAILED' }));
    if (!response.ok || !body.ok) {
      const error = new Error(body.code || 'PATIENT_IDENTITY_REQUEST_FAILED');
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function renderProfiles() {
    const select = $('#patient-profile-select');
    select.replaceChildren();
    for (const profile of linkedProfiles) {
      const option = document.createElement('option');
      option.value = profile.patient_id;
      option.textContent = `${profile.display_name} • ${profile.hn} • ${profile.clinic_name}`;
      select.append(option);
    }
    $('#patient-link-section').classList.toggle('hidden', linkedProfiles.length > 0);
    $('#patient-profile-section').classList.toggle('hidden', linkedProfiles.length === 0);
    if (linkedProfiles.length) status('บัญชีได้รับการยืนยันแล้ว เลือกผู้รับบริการเพื่อสร้าง QR');
    else status('กรอกรหัสจากเจ้าหน้าที่เพื่อเชื่อมบัญชี LINE กับประวัติผู้รับบริการ');
    window.dispatchEvent(new CustomEvent('chananya:patient-card-rendered'));
  }

  async function loadProfiles() {
    const result = await api('status');
    linkedProfiles = result.linked || [];
    renderProfiles();
  }

  function stopExpiryTimer() {
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = null;
  }

  function updateExpiry(expiresAt) {
    stopExpiryTimer();
    const remaining = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000));
    $('#patient-qr-expiry').textContent = remaining > 0
      ? `QR หมดอายุใน ${remaining} วินาที • ใช้ได้ครั้งเดียว`
      : 'QR หมดอายุแล้ว กรุณาสร้างใหม่';
    $('#patient-qr-section').classList.toggle('expired', remaining === 0);
    if (remaining > 0) expiryTimer = setTimeout(() => updateExpiry(expiresAt), 1000);
  }

  async function generateCard() {
    const patientId = $('#patient-profile-select').value;
    if (!patientId) return;
    setBusy(true);
    try {
      const result = await api('card', { patientId });
      const card = result.card;
      $('#patient-card-name').textContent = card.displayName;
      $('#patient-card-hn').textContent = card.hn;
      $('#patient-display-code').textContent = `${card.displayCode.slice(0, 3)} ${card.displayCode.slice(3)}`;
      $('#patient-qr-image').src = card.qrDataUrl;
      $('#patient-qr-section').classList.remove('hidden');
      updateExpiry(card.expiresAt);
      status('แสดง QR ให้ผู้รักษาสแกน แล้วตรวจสอบชื่อร่วมกันก่อนยืนยัน Encounter');
    } catch (error) {
      status(messages[error.message] || messages.PATIENT_IDENTITY_REQUEST_FAILED, 'danger');
    } finally {
      setBusy(false);
    }
  }

  async function linkIdentity(event) {
    event.preventDefault();
    setBusy(true);
    try {
      await api('link', {
        linkCode: $('#patient-link-code').value,
        consentConfirmed: $('#patient-link-consent').checked
      });
      $('#patient-link-form').reset();
      await loadProfiles();
      status('เชื่อมบัญชีสำเร็จแล้ว');
    } catch (error) {
      status(messages[error.message] || messages.PATIENT_IDENTITY_REQUEST_FAILED, 'danger');
    } finally {
      setBusy(false);
    }
  }

  async function init() {
    try {
      const response = await fetch('/api/patient-identity', { cache: 'no-store' });
      const config = await response.json();
      if (!config.enabled || !config.liffId) {
        status(messages.PATIENT_IDENTITY_NOT_CONFIGURED, 'danger');
        return;
      }
      await loadLineSdk();
      if (!window.liff) throw new Error('LINE_SDK_UNAVAILABLE');
      await window.liff.init({ liffId: config.liffId });
      if (!window.liff.isLoggedIn()) {
        window.liff.login({ redirectUri: location.href });
        return;
      }
      idToken = window.liff.getIDToken() || '';
      if (!idToken) throw new Error('LINE_ID_TOKEN_MISSING');
      await loadProfiles();
    } catch (error) {
      console.error(error);
      status('เปิดบริการผ่าน LINE ไม่สำเร็จ กรุณาใช้ HN หรือติดต่อเจ้าหน้าที่', 'danger');
    }
  }

  $('#patient-link-form').addEventListener('submit', linkIdentity);
  $('#patient-generate-card').addEventListener('click', generateCard);
  $('#patient-refresh-card').addEventListener('click', generateCard);
  window.addEventListener('pagehide', stopExpiryTimer);
  init();
})();
