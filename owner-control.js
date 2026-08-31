(() => {
  'use strict';

  const $ = selector => document.querySelector(selector);
  const boot = $('#boot');
  const app = $('#owner-app');
  const status = $('#owner-status');
  const list = $('#owner-clinic-list');
  const clinicSelect = $('#owner-clinic');
  const stateSelect = $('#owner-state');
  const confirmCode = $('#owner-confirm-code');
  const reason = $('#owner-reason');
  const form = $('#owner-control-form');
  const submit = $('#owner-submit');
  const toast = $('#owner-toast');
  let session = null;
  let clinics = [];

  const messages = Object.freeze({
    CNYOS_OWNER_NOT_AUTHORIZED: 'บัญชีนี้ไม่อยู่ใน Owner allowlist',
    CNYOS_OWNER_GOOGLE_SIGN_IN_REQUIRED: 'Owner Console ต้องเข้าสู่ระบบด้วย Google',
    CNYOS_OWNER_EMAIL_UNCONFIRMED: 'บัญชี Google ยังไม่ได้ยืนยันอีเมล',
    CNYOS_OWNER_CONTROL_DISABLED: 'Owner Control ยังไม่ได้เปิดใน Functions environment',
    CNYOS_OWNER_DATABASE_REQUEST_FAILED: 'Supabase ปฏิเสธคำสั่ง กรุณาตรวจ migration และ Functions secret',
    CNYOS_OWNER_CLINIC_CONFIRMATION_MISMATCH: 'Clinic code ที่ยืนยันไม่ตรงกับ tenant เป้าหมาย'
  });

  function showToast(message, error = false) {
    toast.textContent = message;
    toast.classList.toggle('error', error);
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 4200);
  }

  function errorMessage(error) {
    return messages[error?.code] || error?.message || 'Owner Control ทำรายการไม่สำเร็จ';
  }

  async function ownerApi(method = 'GET', body) {
    const response = await fetch('/api/owner-subscription', {
      method,
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok !== true) {
      const error = new Error(messages[payload.code] || payload.code || `HTTP ${response.status}`);
      error.code = payload.code;
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function formatTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
  }

  function renderClinics() {
    list.replaceChildren();
    clinicSelect.replaceChildren();
    for (const clinic of clinics) {
      const row = document.createElement('article');
      row.className = 'owner-clinic-row';

      const identity = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = clinic.clinic_code;
      const name = document.createElement('span');
      name.textContent = clinic.clinic_name_th || clinic.clinic_name_en || clinic.clinic_id;
      identity.append(title, name);

      const meta = document.createElement('div');
      meta.className = 'owner-clinic-meta';
      const badge = document.createElement('span');
      badge.className = `owner-state ${clinic.enabled ? 'on' : 'off'}`;
      badge.textContent = clinic.enabled ? 'ON' : 'OFF';
      const version = document.createElement('small');
      version.textContent = `v${clinic.subscription_version} · ${formatTime(clinic.changed_at)}`;
      meta.append(badge, version);
      row.append(identity, meta);
      list.append(row);

      const option = document.createElement('option');
      option.value = clinic.clinic_id;
      option.textContent = `${clinic.clinic_code} — ${clinic.enabled ? 'ON' : 'OFF'}`;
      clinicSelect.append(option);
    }
    if (clinics.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'ไม่พบ tenant ในฐานข้อมูล';
      list.append(empty);
    }
  }

  async function refresh() {
    status.textContent = 'กำลังอ่านสถานะจริงจาก Supabase…';
    const payload = await ownerApi();
    clinics = payload.clinics || [];
    renderClinics();
    status.textContent = `เชื่อมต่อแล้ว · ${clinics.length} tenant · ทุกคำสั่งถูกบันทึกใน audit ledger`;
  }

  async function start() {
    if (!window.ChananyaRuntime) throw new Error('CNYOS runtime unavailable');
    const db = window.ChananyaRuntime.getDb();
    const result = await db.auth.getSession();
    if (result.error) throw result.error;
    session = result.data.session;
    if (!session) {
      sessionStorage.setItem('cnyos:post_auth_path', '/owner-control.html');
      location.replace('/login.html');
      return;
    }

    $('#owner-email').textContent = session.user?.email || 'Google Owner';
    $('#owner-logout').addEventListener('click', async () => {
      await db.auth.signOut();
      location.replace('/login.html');
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const clinic = clinics.find(item => item.clinic_id === clinicSelect.value);
      if (!clinic) return showToast('กรุณาเลือก Clinic', true);
      const expectedCode = clinic.clinic_code;
      if (confirmCode.value.trim().toUpperCase() !== expectedCode.toUpperCase()) {
        return showToast(`พิมพ์ ${expectedCode} เพื่อยืนยัน tenant เป้าหมาย`, true);
      }
      const enabled = stateSelect.value === 'on';
      const cleanReason = reason.value.trim();
      if (cleanReason.length < 8) return showToast('กรุณาระบุเหตุผลอย่างน้อย 8 ตัวอักษร', true);
      const action = enabled ? 'ON' : 'OFF';
      if (!window.confirm(`ยืนยัน ${action} subscription ของ ${expectedCode} ที่ Supabase database?`)) return;

      submit.disabled = true;
      status.textContent = `กำลังบันทึก ${action} ที่ฐานข้อมูล…`;
      try {
        await ownerApi('POST', {
          requestId: crypto.randomUUID(),
          clinicId: clinic.clinic_id,
          clinicCode: expectedCode,
          enabled,
          reason: cleanReason
        });
        confirmCode.value = '';
        reason.value = '';
        await refresh();
        showToast(`${expectedCode} เปลี่ยนเป็น ${action} ที่ฐานข้อมูลแล้ว`);
      } catch (error) {
        status.textContent = 'คำสั่งไม่ถูกบันทึก';
        showToast(errorMessage(error), true);
      } finally {
        submit.disabled = false;
      }
    });

    boot.classList.add('hidden');
    app.classList.remove('hidden');
    await refresh();
  }

  start().catch(error => {
    const message = errorMessage(error);
    $('#boot-error').textContent = message;
    $('#boot-error').classList.add('error');
  });
})();
