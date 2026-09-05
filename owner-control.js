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
  const driveStatus = $('#owner-drive-status');
  const driveForm = $('#owner-drive-form');
  const driveClinicSelect = $('#owner-drive-clinic');
  const driveEnvironmentInput = $('#owner-drive-environment');
  const driveCurrent = $('#owner-drive-current');
  const driveConfirmCode = $('#owner-drive-confirm-code');
  const driveReason = $('#owner-drive-reason');
  const driveSubmit = $('#owner-drive-submit');
  const driveRetry = $('#owner-drive-retry');
  const toast = $('#owner-toast');

  const driveContextFields = Object.freeze({
    environment: $('#owner-drive-context-environment'),
    deploymentId: $('#owner-drive-context-deployment'),
    projectRef: $('#owner-drive-context-project'),
    serviceAccountEmail: $('#owner-drive-context-service-account'),
    rootFolderId: $('#owner-drive-context-root')
  });

  const driveFolderSpecs = Object.freeze([
    Object.freeze({ key: 'patients', label: 'Patients', input: $('#owner-drive-patients') }),
    Object.freeze({ key: 'products', label: 'Products', input: $('#owner-drive-products') }),
    Object.freeze({ key: 'pharmacy', label: 'Pharmacy', input: $('#owner-drive-pharmacy') }),
    Object.freeze({ key: 'transactions', label: 'Transactions', input: $('#owner-drive-transactions') }),
    Object.freeze({ key: 'manifests', label: 'Manifests', input: $('#owner-drive-manifests') })
  ]);

  let session = null;
  let clinics = [];
  let driveAssignments = [];
  let driveEnvironment = '';
  let driveReady = false;
  let driveBusy = false;
  let driveLoading = false;
  let driveContext = null;
  let ownerDb = null;
  let ownerEpoch = 0;
  let ownerBlocked = false;
  let subscriptionUncertain = false;
  let signingOut = false;
  let navigationStarted = false;
  const ownerRequests = new Set();

  const OWNER_API_TIMEOUT_MS = 15000;

  const messages = Object.freeze({
    CNYOS_OWNER_NOT_AUTHORIZED: 'บัญชีนี้ไม่อยู่ใน Owner allowlist',
    CNYOS_OWNER_GOOGLE_SIGN_IN_REQUIRED: 'Owner Console ต้องเข้าสู่ระบบด้วย Google',
    CNYOS_OWNER_EMAIL_UNCONFIRMED: 'บัญชี Google ยังไม่ได้ยืนยันอีเมล',
    CNYOS_OWNER_CONTROL_DISABLED: 'Owner Control ยังไม่ได้เปิดใน Functions environment',
    CNYOS_OWNER_ENVIRONMENT_INVALID: 'Owner Control ไม่พบ staging/production environment ที่ถูกต้อง',
    CNYOS_OWNER_DEPLOYMENT_INVALID: 'Owner Control environment ไม่ตรงกับ deployment ID',
    CNYOS_OWNER_PRODUCTION_DENYLIST_REQUIRED: 'Staging Owner Control ยังไม่มี Production Supabase denylist ของลูกค้ารายนี้',
    CNYOS_OWNER_PRODUCTION_DENYLIST_INVALID: 'Production Supabase denylist ของ Owner Control ไม่ถูกต้อง',
    CNYOS_OWNER_PRODUCTION_TARGET_DENIED: 'Owner Control staging ห้ามชี้ไป Production Supabase',
    CNYOS_OWNER_DATABASE_REQUEST_FAILED: 'Supabase ปฏิเสธคำสั่ง กรุณาตรวจ migration และ Functions secret',
    CNYOS_OWNER_CLINIC_CONFIRMATION_MISMATCH: 'Clinic code ที่ยืนยันไม่ตรงกับ tenant เป้าหมาย',
    CNYOS_OWNER_SUBSCRIPTION_VERSION_INVALID: 'Subscription version ไม่ถูกต้อง กรุณาโหลดสถานะใหม่',
    CNYOS_OWNER_SUBSCRIPTION_VERSION_CONFLICT: 'สถานะ Subscription ถูกแก้ไขจากอีก session แล้ว กรุณาตรวจสถานะล่าสุดก่อนยืนยันอีกครั้ง',
    CNYOS_OWNER_REQUEST_ID_CONFLICT: 'Request ID นี้เคยถูกใช้กับคำสั่งอื่น กรุณาลองใหม่',
    CNYOS_OWNER_DRIVE_DISABLED: 'Direct Drive assignment ยังไม่ได้เปิดใน Functions environment',
    CNYOS_OWNER_DRIVE_ENVIRONMENT_MISSING: 'Server ไม่ได้ระบุ backup environment จึงปิดการบันทึกเพื่อความปลอดภัย',
    CNYOS_OWNER_DRIVE_ENVIRONMENT_INVALID: 'Functions ตั้งค่า backup environment ไม่ถูกต้อง',
    CNYOS_OWNER_DRIVE_SERVICE_ACCOUNT_MISSING: 'Functions ยังไม่มี Google Drive service account',
    CNYOS_OWNER_DRIVE_SERVICE_ACCOUNT_INVALID: 'Google Drive service account ใน Functions ไม่ถูกต้อง',
    CNYOS_OWNER_DRIVE_AUTH_FAILED: 'Functions ยืนยันตัวตนกับ Google Drive ไม่สำเร็จ',
    CNYOS_OWNER_DRIVE_FOLDER_INPUT_INVALID: 'Google Drive folder URL หรือ folder ID ไม่ถูกต้อง',
    CNYOS_OWNER_DRIVE_FOLDER_ACCESS_FAILED: 'Service account เข้าไม่ถึงโฟลเดอร์ Google Drive ที่ระบุ',
    CNYOS_OWNER_DRIVE_FOLDER_ID_MISMATCH: 'Google Drive ตอบกลับ folder ID ไม่ตรงกับที่ระบุ',
    CNYOS_OWNER_DRIVE_FOLDER_TYPE_INVALID: 'รายการที่ระบุไม่ใช่ Google Drive folder',
    CNYOS_OWNER_DRIVE_FOLDER_TRASHED: 'โฟลเดอร์ที่ระบุอยู่ในถังขยะของ Google Drive',
    CNYOS_OWNER_DRIVE_FOLDER_WRITE_DENIED: 'Service account ไม่มีสิทธิ์เพิ่มไฟล์ในโฟลเดอร์ที่ระบุ',
    CNYOS_OWNER_DRIVE_FOLDER_PARENT_UNVERIFIED: 'Google Drive ไม่ยืนยัน parent ของโฟลเดอร์นี้',
    CNYOS_OWNER_DRIVE_FOLDER_PARENT_MISMATCH: 'โฟลเดอร์นี้ไม่ได้อยู่ใต้ staging/production root ที่กำหนด',
    CNYOS_OWNER_DRIVE_ROOT_FOLDER_INVALID: 'Functions ยังไม่ได้กำหนด Google Drive root ที่ถูกต้อง',
    CNYOS_OWNER_DRIVE_DEPLOYMENT_INVALID: 'Environment และ deployment ID ของ Functions ไม่สอดคล้องกัน',
    CNYOS_OWNER_DRIVE_PROJECT_GUARD_MISMATCH: 'Supabase project guard ของ Owner และ backup ไม่ตรงกัน',
    CNYOS_OWNER_DRIVE_PRODUCTION_DENYLIST_REQUIRED: 'Direct Drive staging ยังไม่มี Production Supabase denylist ของลูกค้ารายนี้',
    CNYOS_OWNER_DRIVE_PRODUCTION_DENYLIST_INVALID: 'Production Supabase denylist ไม่ถูกต้อง',
    CNYOS_OWNER_DRIVE_PRODUCTION_TARGET_DENIED: 'Staging ห้ามกำหนด destination ให้ Production Supabase',
    CNYOS_OWNER_DRIVE_CONTEXT_INVALID: 'Functions ไม่ได้ส่ง deployment context ที่จำเป็นกลับมา',
    CNYOS_OWNER_DRIVE_FAILED: 'Functions ไม่สามารถทำรายการ Drive assignment ได้',
    CNYOS_OWNER_DRIVE_FOLDERS_NOT_UNIQUE: 'ต้องใช้ Google Drive folder คนละโฟลเดอร์ทั้ง 5 ประเภท',
    CNYOS_DRIVE_FOLDER_ALREADY_ASSIGNED: 'มีโฟลเดอร์อย่างน้อยหนึ่งรายการถูก assign ให้ clinic/environment อื่นแล้ว',
    CNYOS_DRIVE_BACKUP_RUN_ACTIVE: 'กำลัง export backup ของ Clinic นี้ กรุณารอให้ run จบแล้วโหลดสถานะใหม่',
    CNYOS_DRIVE_VERSION_CONFLICT: 'Destination ถูกแก้ไขจากอีก session แล้ว กรุณาโหลดสถานะใหม่',
    CNYOS_DRIVE_REQUEST_ID_CONFLICT: 'Request ID นี้เคยถูกใช้กับข้อมูลอื่น กรุณาลองใหม่',
    CNYOS_OWNER_DRIVE_DATABASE_RESPONSE_INVALID: 'Database ตอบกลับ Drive destination ไม่สมบูรณ์',
    CNYOS_OWNER_DRIVE_INPUT_INVALID: 'ข้อมูล Drive destination ไม่ครบหรือไม่ถูกต้อง',
    CNYOS_OWNER_DRIVE_CLINIC_CODE_INVALID: 'Clinic code สำหรับ Drive destination ไม่ถูกต้อง',
    CNYOS_OWNER_DRIVE_VERSION_INVALID: 'Destination version ไม่ถูกต้อง กรุณาโหลดสถานะใหม่',
    CNYOS_OWNER_DRIVE_REASON_INVALID: 'เหตุผลต้องมี 8–500 ตัวอักษร',
    CNYOS_OWNER_CLINIC_NOT_ALLOWED: 'Clinic นี้ไม่อยู่ใน allowlist ของ Owner Console',
    CNYOS_OWNER_CLINIC_NOT_FOUND: 'ไม่พบ Clinic เป้าหมายในฐานข้อมูล',
    CNYOS_OWNER_ORIGIN_DENIED: 'Origin นี้ไม่ได้รับอนุญาตให้เรียก Owner Console',
    CNYOS_OWNER_REQUEST_TIMEOUT: 'Server ใช้เวลาตอบนานเกิน 15 วินาที กรุณาลองโหลดสถานะอีกครั้ง',
    CNYOS_OWNER_NETWORK_REQUEST_FAILED: 'เชื่อมต่อ Owner Functions ไม่สำเร็จ กรุณาตรวจเครือข่ายแล้วลองใหม่'
  });

  function showToast(message, error = false) {
    if (ownerBlocked) return;
    toast.textContent = message;
    toast.classList.toggle('error', error);
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 4200);
  }

  function errorMessage(error) {
    const message = messages[error?.code] || error?.message || 'Owner Control ทำรายการไม่สำเร็จ';
    const folder = driveFolderSpecs.find(item => item.key === error?.field);
    return folder ? `${folder.label}: ${message}` : message;
  }

  function ownerSessionError() {
    const error = new Error('Owner session changed; sign in again');
    error.code = 'CNYOS_OWNER_SESSION_CHANGED';
    return error;
  }

  function currentOwnerEpoch(epoch) {
    return !ownerBlocked && epoch === ownerEpoch;
  }

  function assertOwnerEpoch(epoch) {
    if (!currentOwnerEpoch(epoch)) throw ownerSessionError();
  }

  function loginAgain() {
    if (navigationStarted) return;
    navigationStarted = true;
    try { sessionStorage.setItem('cnyos:post_auth_path', '/owner-control.html'); }
    catch { /* Restricted storage must not prevent hiding or leaving the console. */ }
    location.replace('/login.html');
  }

  function clearOwnerSession(redirect = false) {
    ownerBlocked = true;
    ownerEpoch += 1;
    session = null;
    for (const controller of ownerRequests) controller.abort();
    ownerRequests.clear();
    clinics = [];
    driveAssignments = [];
    driveEnvironment = '';
    driveContext = null;
    driveReady = false;
    driveBusy = false;
    driveLoading = false;
    app.classList.add('hidden');
    boot.classList.remove('hidden');
    for (const element of [list, clinicSelect, driveClinicSelect, driveCurrent]) element.replaceChildren();
    for (const element of [confirmCode, reason, driveConfirmCode, driveReason, driveEnvironmentInput,
      ...driveFolderSpecs.map(spec => spec.input)]) element.value = '';
    for (const element of [clinicSelect, stateSelect, confirmCode, reason, submit,
      driveClinicSelect, driveConfirmCode, driveReason, driveSubmit, driveRetry,
      ...driveFolderSpecs.map(spec => spec.input)]) element.disabled = true;
    $('#owner-email').textContent = '—';
    status.textContent = '';
    driveStatus.textContent = '';
    toast.textContent = '';
    toast.classList.remove('show');
    renderDriveContext();
    $('#boot-error').textContent = 'Session สิ้นสุดหรือเปลี่ยนแล้ว กรุณาเข้าสู่ระบบใหม่';
    if (redirect && !signingOut) loginAgain();
  }

  function ownerRequestTimeout() {
    const controller = new AbortController();
    ownerRequests.add(controller);
    const timeoutSignal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(OWNER_API_TIMEOUT_MS) : null;
    const abort = () => controller.abort();
    const timer = timeoutSignal ? null : setTimeout(abort, OWNER_API_TIMEOUT_MS);
    timeoutSignal?.addEventListener('abort', abort, { once: true });
    return Object.freeze({
      signal: controller.signal,
      clear: () => {
        if (timer !== null) clearTimeout(timer);
        timeoutSignal?.removeEventListener('abort', abort);
        ownerRequests.delete(controller);
      }
    });
  }

  function ownerAwait(promise, signal) {
    // Bound session lookup, fetch and body parsing, including test/browser adapters that ignore abort.
    return new Promise((resolve, reject) => {
      const abort = () => reject(new Error('OWNER_REQUEST_ABORTED'));
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve(promise).then(value => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      }, error => {
        signal.removeEventListener('abort', abort);
        reject(error);
      });
    });
  }

  async function ownerApi(path, method = 'GET', body) {
    const epoch = ownerEpoch;
    assertOwnerEpoch(epoch);
    const principal = session?.user?.id;
    if (!principal) throw ownerSessionError();
    const timeout = ownerRequestTimeout();
    try {
      // This is transport freshness, not authorization: the server still checks Google Owner and tenant access.
      const latest = await ownerAwait(ownerDb.auth.getSession(), timeout.signal);
      assertOwnerEpoch(epoch);
      if (latest.error || !latest.data?.session?.access_token || latest.data.session.user?.id !== principal) {
        clearOwnerSession(true);
        throw ownerSessionError();
      }
      session = latest.data.session;
      const response = await ownerAwait(fetch(path, {
        method,
        cache: 'no-store',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        signal: timeout.signal,
        ...(body ? { body: JSON.stringify(body) } : {})
      }), timeout.signal);
      assertOwnerEpoch(epoch);
      const payload = await ownerAwait(response.json(), timeout.signal);
      assertOwnerEpoch(epoch);
      if (!response.ok || payload.ok !== true) {
        const error = new Error(messages[payload.code] || payload.code || `HTTP ${response.status}`);
        error.code = payload.code || 'CNYOS_OWNER_REQUEST_FAILED';
        error.field = payload.field;
        error.status = response.status;
        if (response.status === 401 || response.status === 403) clearOwnerSession(true);
        throw error;
      }
      return payload;
    } catch (cause) {
      if (!currentOwnerEpoch(epoch)) throw ownerSessionError();
      if (cause?.code) throw cause;
      const code = timeout.signal.aborted ? 'CNYOS_OWNER_REQUEST_TIMEOUT' : 'CNYOS_OWNER_NETWORK_REQUEST_FAILED';
      const error = new Error(messages[code]);
      error.code = code;
      throw error;
    } finally {
      timeout.clear();
    }
  }

  function subscriptionApi(method = 'GET', body) {
    return ownerApi('/api/owner-subscription', method, body);
  }

  function driveApi(method = 'GET', body) {
    return ownerApi('/api/owner-drive', method, body);
  }

  function formatTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
  }

  function folderValue(value) {
    if (typeof value === 'string') return value.trim();
    if (!value || typeof value !== 'object') return '';
    return String(value.id || value.folder_id || value.folderId || '').trim();
  }

  function normalizeDriveAssignment(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const container = raw.folder_ids || raw.folderIds || raw.folders || {};
    const folderArray = Array.isArray(container) ? container : [];
    const folderObject = Array.isArray(container) ? {} : container;
    const folders = {};

    for (const spec of driveFolderSpecs) {
      const snakeKey = `${spec.key}_folder_id`;
      const camelKey = `${spec.key}FolderId`;
      const arrayEntry = folderArray.find(item => item?.key === spec.key || item?.type === spec.key || item?.category === spec.key);
      folders[spec.key] = folderValue(
        folderObject?.[spec.key] ??
        folderObject?.[snakeKey] ??
        folderObject?.[camelKey] ??
        raw[snakeKey] ??
        raw[camelKey] ??
        arrayEntry
      );
    }

    const versionValue = Number(raw.version ?? raw.assignment_version ?? raw.assignmentVersion ?? 0);
    return {
      clinicId: String(raw.clinic_id || raw.clinicId || '').trim(),
      clinicCode: String(raw.clinic_code || raw.clinicCode || '').trim().toUpperCase(),
      environment: String(raw.environment || '').trim(),
      folders,
      version: Number.isSafeInteger(versionValue) && versionValue >= 0 ? versionValue : 0,
      updatedAt: raw.updated_at || raw.updatedAt || raw.changed_at || raw.changedAt || null
    };
  }

  function normalizeDriveAssignments(payload) {
    const source = payload?.assignments ?? payload?.data?.assignments ?? [];
    const values = Array.isArray(source) ? source : Object.values(source || {});
    return values.map(normalizeDriveAssignment).filter(Boolean);
  }

  function normalizeDriveContext(payload) {
    const context = Object.freeze({
      environment: String(payload?.environment || payload?.backup_environment || payload?.backupEnvironment || '').trim(),
      deploymentId: String(payload?.deploymentId || payload?.deployment_id || '').trim(),
      projectRef: String(payload?.projectRef || payload?.project_ref || '').trim(),
      serviceAccountEmail: String(payload?.serviceAccountEmail || payload?.service_account_email || '').trim(),
      rootFolderId: String(payload?.rootFolderId || payload?.root_folder_id || '').trim()
    });
    if (Object.values(context).some(value => !value)) {
      const error = new Error(messages.CNYOS_OWNER_DRIVE_CONTEXT_INVALID);
      error.code = 'CNYOS_OWNER_DRIVE_CONTEXT_INVALID';
      throw error;
    }
    return context;
  }

  function renderDriveContext() {
    for (const [key, element] of Object.entries(driveContextFields)) {
      element.textContent = driveContext?.[key] || '—';
    }
  }

  function selectedClinic() {
    return clinics.find(item => item.clinic_id === clinicSelect.value) || null;
  }

  function subscriptionVersion(clinic) {
    const value = Number(clinic?.subscription_version);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }

  function selectedDriveClinic() {
    return clinics.find(item => item.clinic_id === driveClinicSelect.value) || null;
  }

  function driveAssignmentFor(clinic) {
    if (!clinic) return null;
    const clinicCode = String(clinic.clinic_code || '').toUpperCase();
    return driveAssignments.find(item =>
      (!item.environment || item.environment === driveEnvironment) && (
        (item.clinicId && item.clinicId === clinic.clinic_id) ||
        (item.clinicCode && item.clinicCode === clinicCode)
      )
    ) || null;
  }

  function driveFolderUrl(value) {
    const clean = String(value || '').trim();
    if (/^https:\/\/drive\.google\.com\/drive\/folders\//i.test(clean)) return clean;
    return `https://drive.google.com/drive/folders/${encodeURIComponent(clean)}`;
  }

  function setDriveStatus(message, error = false) {
    driveStatus.textContent = message;
    driveStatus.classList.toggle('danger', error);
    driveStatus.setAttribute('role', error ? 'alert' : 'status');
    driveStatus.setAttribute('aria-live', error ? 'assertive' : 'polite');
  }

  function setDriveControlsState() {
    const clinic = selectedDriveClinic();
    const requestActive = driveBusy || driveLoading;
    const canEdit = Boolean(!ownerBlocked && session && driveReady && driveEnvironment && clinic && !requestActive);
    driveForm.setAttribute('aria-busy', String(requestActive));
    driveRetry.disabled = ownerBlocked || !session || requestActive;
    driveClinicSelect.disabled = ownerBlocked || !session || !driveReady || clinics.length === 0 || requestActive;
    for (const spec of driveFolderSpecs) spec.input.disabled = !canEdit;
    driveConfirmCode.disabled = !canEdit;
    driveReason.disabled = !canEdit;
    driveSubmit.disabled = !canEdit;
  }

  function renderDriveCurrent() {
    const clinic = selectedDriveClinic();
    const assignment = driveAssignmentFor(clinic);
    driveCurrent.replaceChildren();

    for (const spec of driveFolderSpecs) {
      spec.input.value = assignment?.folders?.[spec.key] || '';
    }

    if (!clinic) {
      const empty = document.createElement('span');
      empty.textContent = 'เลือก Clinic เพื่อดู destination ปัจจุบัน';
      driveCurrent.append(empty);
      setDriveControlsState();
      return;
    }

    const heading = document.createElement('p');
    const title = document.createElement('strong');
    title.textContent = `${clinic.clinic_code} · ${driveEnvironment || 'environment unavailable'}`;
    heading.append(title);

    if (!assignment) {
      const empty = document.createElement('span');
      empty.className = 'muted';
      empty.textContent = 'ยังไม่ได้ assign Drive destination · expected version 0';
      driveCurrent.append(heading, empty);
      setDriveControlsState();
      return;
    }

    const version = document.createElement('small');
    version.className = 'muted';
    version.textContent = `Current version ${assignment.version} · ${formatTime(assignment.updatedAt)}`;
    const folderList = document.createElement('div');
    folderList.className = 'list';

    for (const spec of driveFolderSpecs) {
      const value = assignment.folders[spec.key];
      const row = document.createElement('div');
      row.className = 'item';
      const label = document.createElement('strong');
      label.textContent = spec.label;
      if (value) {
        const link = document.createElement('a');
        link.href = driveFolderUrl(value);
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'เปิด Google Drive';
        link.setAttribute('aria-label', `เปิด ${spec.label} folder ของ ${clinic.clinic_code}`);
        row.append(label, link);
      } else {
        const missing = document.createElement('span');
        missing.className = 'muted';
        missing.textContent = 'ไม่ได้กำหนด';
        row.append(label, missing);
      }
      folderList.append(row);
    }

    driveCurrent.append(heading, version, folderList);
    setDriveControlsState();
  }

  function syncClinicSelection(clinicId) {
    if (!clinics.some(item => item.clinic_id === clinicId)) return;
    clinicSelect.value = clinicId;
    driveClinicSelect.value = clinicId;
    confirmCode.value = '';
    reason.value = '';
    driveConfirmCode.value = '';
    driveReason.value = '';
    renderDriveCurrent();
  }

  function renderClinics() {
    const previous = clinics.some(item => item.clinic_id === clinicSelect.value)
      ? clinicSelect.value
      : clinics.some(item => item.clinic_id === driveClinicSelect.value)
        ? driveClinicSelect.value
        : clinics[0]?.clinic_id || '';

    list.replaceChildren();
    clinicSelect.replaceChildren();
    driveClinicSelect.replaceChildren();
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
      version.textContent = `v${subscriptionVersion(clinic) ?? '—'} · ${formatTime(clinic.changed_at)}`;
      meta.append(badge, version);
      row.append(identity, meta);
      list.append(row);

      const subscriptionOption = document.createElement('option');
      subscriptionOption.value = clinic.clinic_id;
      subscriptionOption.textContent = `${clinic.clinic_code} — ${clinic.enabled ? 'ON' : 'OFF'}`;
      clinicSelect.append(subscriptionOption);

      const driveOption = document.createElement('option');
      driveOption.value = clinic.clinic_id;
      driveOption.textContent = clinic.clinic_code;
      driveClinicSelect.append(driveOption);
    }
    clinicSelect.disabled = ownerBlocked || !session || clinics.length === 0;
    submit.disabled = ownerBlocked || subscriptionUncertain || !session || clinics.length === 0;
    if (previous) {
      clinicSelect.value = previous;
      driveClinicSelect.value = previous;
    }
    if (clinics.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'ไม่พบ tenant ในฐานข้อมูล';
      list.append(empty);
    }
    renderDriveCurrent();
  }

  async function refresh() {
    const epoch = ownerEpoch;
    assertOwnerEpoch(epoch);
    status.textContent = 'กำลังอ่านสถานะจริงจาก Supabase…';
    status.classList.remove('danger');
    const payload = await subscriptionApi();
    assertOwnerEpoch(epoch);
    subscriptionUncertain = false;
    clinics = payload.clinics || [];
    renderClinics();
    status.textContent = `เชื่อมต่อแล้ว · ${clinics.length} tenant · ทุกคำสั่งถูกบันทึกใน audit ledger`;
  }

  async function refreshDrive() {
    const epoch = ownerEpoch;
    assertOwnerEpoch(epoch);
    driveLoading = true;
    if (!driveEnvironment) driveEnvironmentInput.value = 'กำลังโหลด…';
    setDriveStatus('กำลังอ่าน Drive destination และ environment จาก server…');
    setDriveControlsState();

    try {
      const payload = await driveApi();
      assertOwnerEpoch(epoch);
      const nextContext = normalizeDriveContext(payload);
      const nextAssignments = normalizeDriveAssignments(payload);
      driveContext = nextContext;
      driveEnvironment = nextContext.environment;
      driveAssignments = nextAssignments;
      driveEnvironmentInput.value = driveEnvironment;
      driveReady = true;
      renderDriveContext();
      renderDriveCurrent();
      setDriveStatus(`เชื่อมต่อแล้ว · ${driveEnvironment} · ${driveAssignments.length} tenant มี Drive destination`);
    } catch (error) {
      if (!currentOwnerEpoch(epoch)) throw ownerSessionError();
      driveReady = false;
      driveEnvironmentInput.value = driveEnvironment || 'ไม่พร้อมใช้งาน';
      setDriveStatus(errorMessage(error), true);
      throw error;
    } finally {
      driveLoading = false;
      setDriveControlsState();
    }
  }

  async function start() {
    if (!window.ChananyaRuntime) throw new Error('CNYOS runtime unavailable');
    const db = window.ChananyaRuntime.getDb();
    ownerDb = db;
    const epoch = ownerEpoch;
    // Keep auth callbacks synchronous; calling Supabase APIs inside them can deadlock its session lock.
    db.auth.onAuthStateChange((event, nextSession) => {
      if (ownerBlocked) return;
      if (event === 'SIGNED_OUT' || (session && nextSession?.user?.id !== session.user?.id)) {
        clearOwnerSession(true);
        return;
      }
      if (session && nextSession) session = nextSession;
    });
    window.addEventListener('pagehide', () => clearOwnerSession());
    window.addEventListener('pageshow', event => {
      if (!event.persisted) return;
      clearOwnerSession();
      // A cached document must start a fresh, server-authorized load; never redisplay its retained DOM.
      location.replace('/owner-control.html');
    });
    const result = await db.auth.getSession();
    assertOwnerEpoch(epoch);
    if (result.error) throw result.error;
    session = result.data.session;
    if (!session) {
      clearOwnerSession(true);
      return;
    }

    $('#owner-email').textContent = session.user?.email || 'Google Owner';
    $('#owner-logout').addEventListener('click', async () => {
      signingOut = true;
      clearOwnerSession();
      try {
        const signedOut = await db.auth.signOut();
        if (signedOut?.error) throw signedOut.error;
        loginAgain();
      } catch {
        $('#boot-error').textContent = 'ออกจากระบบไม่สำเร็จ หน้านี้ถูกล็อกแล้ว กรุณาตรวจเครือข่ายและลองใหม่';
        $('#boot-error').classList.add('error');
      } finally {
        signingOut = false;
      }
    });
    clinicSelect.addEventListener('change', () => syncClinicSelection(clinicSelect.value));
    driveClinicSelect.addEventListener('change', () => syncClinicSelection(driveClinicSelect.value));
    driveRetry.addEventListener('click', async () => {
      if (ownerBlocked || driveLoading || driveBusy) return;
      try {
        await refreshDrive();
        showToast('โหลด Drive destination ล่าสุดแล้ว');
      } catch (error) {
        showToast(errorMessage(error), true);
      }
    });

    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (ownerBlocked || subscriptionUncertain) return;
      const epoch = ownerEpoch;
      const clinic = selectedClinic();
      if (!clinic) return showToast('กรุณาเลือก Clinic', true);
      const expectedCode = clinic.clinic_code;
      if (confirmCode.value.trim().toUpperCase() !== expectedCode.toUpperCase()) {
        return showToast(`พิมพ์ ${expectedCode} เพื่อยืนยัน tenant เป้าหมาย`, true);
      }
      const enabled = stateSelect.value === 'on';
      const expectedVersion = subscriptionVersion(clinic);
      if (expectedVersion === null) {
        return showToast(messages.CNYOS_OWNER_SUBSCRIPTION_VERSION_INVALID, true);
      }
      const cleanReason = reason.value.trim();
      if (cleanReason.length < 8) return showToast('กรุณาระบุเหตุผลอย่างน้อย 8 ตัวอักษร', true);
      const action = enabled ? 'ON' : 'OFF';
      if (!window.confirm(`ยืนยัน ${action} subscription ของ ${expectedCode} ที่ Supabase database (expected version ${expectedVersion})?`)) return;

      submit.disabled = true;
      status.textContent = `กำลังบันทึก ${action} ที่ฐานข้อมูล…`;
      let saved = false;
      try {
        await subscriptionApi('POST', {
          requestId: crypto.randomUUID(),
          clinicId: clinic.clinic_id,
          clinicCode: expectedCode,
          enabled,
          expectedVersion,
          reason: cleanReason
        });
        assertOwnerEpoch(epoch);
        saved = true;
        confirmCode.value = '';
        reason.value = '';
        await refresh();
        showToast(`${expectedCode} เปลี่ยนเป็น ${action} ที่ฐานข้อมูลแล้ว`);
      } catch (error) {
        if (!currentOwnerEpoch(epoch)) return;
        if (saved) {
          subscriptionUncertain = true;
          status.textContent = 'บันทึกสำเร็จ แต่โหลดสถานะล่าสุดไม่สำเร็จ กรุณาโหลดหน้าใหม่ก่อนทำรายการต่อ';
          status.classList.add('danger');
          return;
        }
        if (error?.code === 'CNYOS_OWNER_SUBSCRIPTION_VERSION_CONFLICT') {
          try {
            await refresh();
          } catch {
            // Keep the original concurrency error as the actionable result.
          }
          if (!currentOwnerEpoch(epoch)) return;
          status.textContent = 'คำสั่งไม่ถูกบันทึก · สถานะเปลี่ยนจากอีก session แล้ว กรุณาตรวจและยืนยันใหม่';
        } else {
          subscriptionUncertain = true;
          status.textContent = 'ยังยืนยันผลคำสั่งไม่ได้ กรุณาโหลดสถานะล่าสุดก่อนทำรายการซ้ำ';
        }
        status.classList.add('danger');
        showToast(errorMessage(error), true);
      } finally {
        submit.disabled = ownerBlocked || subscriptionUncertain || !session || clinics.length === 0;
      }
    });

    driveForm.addEventListener('submit', async event => {
      event.preventDefault();
      if (ownerBlocked) return;
      const epoch = ownerEpoch;
      const clinic = selectedDriveClinic();
      if (!driveReady || !driveEnvironment || !clinic) return showToast('Drive assignment ยังไม่พร้อมใช้งาน', true);
      const expectedCode = clinic.clinic_code;
      if (driveConfirmCode.value.trim().toUpperCase() !== expectedCode.toUpperCase()) {
        return showToast(`พิมพ์ ${expectedCode} เพื่อยืนยัน Drive destination`, true);
      }
      const cleanReason = driveReason.value.trim();
      if (cleanReason.length < 8) return showToast('กรุณาระบุเหตุผลอย่างน้อย 8 ตัวอักษร', true);
      const folders = Object.fromEntries(driveFolderSpecs.map(spec => [spec.key, spec.input.value.trim()]));
      if (Object.values(folders).some(value => !value)) return showToast('กรุณาระบุ Drive folder ให้ครบทั้ง 5 ประเภท', true);
      const assignment = driveAssignmentFor(clinic);
      const expectedVersion = assignment?.version || 0;
      if (!window.confirm(`ยืนยัน assign Google Drive ของ ${expectedCode} สำหรับ ${driveEnvironment} (expected version ${expectedVersion})?`)) return;

      for (const spec of driveFolderSpecs) spec.input.removeAttribute('aria-invalid');
      driveBusy = true;
      setDriveControlsState();
      setDriveStatus(`กำลังตรวจสิทธิ์ทั้ง 5 โฟลเดอร์และบันทึก ${expectedCode}…`);
      let saved = false;
      try {
        await driveApi('POST', {
          requestId: crypto.randomUUID(),
          clinicId: clinic.clinic_id,
          clinicCode: expectedCode,
          expectedVersion,
          folders,
          reason: cleanReason
        });
        assertOwnerEpoch(epoch);
        saved = true;
        driveConfirmCode.value = '';
        driveReason.value = '';
        showToast(`${expectedCode} บันทึก Drive destination สำหรับ ${driveEnvironment} แล้ว`);
        await refreshDrive();
      } catch (error) {
        if (!currentOwnerEpoch(epoch)) return;
        if (saved) {
          setDriveStatus('บันทึกสำเร็จ แต่โหลด destination ล่าสุดไม่สำเร็จ กรุณาโหลดหน้าใหม่', true);
        } else {
          setDriveStatus(errorMessage(error), true);
          showToast(errorMessage(error), true);
          const invalidFolder = driveFolderSpecs.find(item => item.key === error?.field);
          if (invalidFolder) {
            invalidFolder.input.setAttribute('aria-invalid', 'true');
            invalidFolder.input.focus();
          }
        }
      } finally {
        driveBusy = false;
        setDriveControlsState();
      }
    });

    await refresh();
    assertOwnerEpoch(epoch);
    boot.classList.add('hidden');
    app.classList.remove('hidden');
    try {
      await refreshDrive();
    } catch (error) {
      showToast(errorMessage(error), true);
    }
  }

  start().catch(error => {
    if (ownerBlocked) return;
    const message = errorMessage(error);
    $('#boot-error').textContent = message;
    $('#boot-error').classList.add('error');
  });
})();
