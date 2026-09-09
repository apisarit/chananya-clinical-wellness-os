import { PLATFORM_FEATURES, normalizePlatformPlan, platformPlanInput, platformPreflight, resolvePlatformFeatures } from './platform-config.js';

const $ = id => document.getElementById(id);
const ids = ['name', 'slug', 'site', 'database', 'drive', 'nas'];
const requests = new Set();
let db, session, accountId, epoch = 0, registry, saved = null, dirty = true, busy = false;
let selected = PLATFORM_FEATURES.map(item => item.id), saveId = null;
const messages = {
  PLATFORM_DISABLED: 'Platform Console ยังไม่ได้เปิดสำหรับเว็บไซต์นี้',
  PLATFORM_OWNERS_UNCONFIGURED: 'ยังไม่ได้ตั้งค่าบัญชีเจ้าของแพลตฟอร์ม',
  PLATFORM_OWNER_REQUIRED: 'บัญชีนี้ไม่มีสิทธิ์ Platform Owner กรุณาใช้บัญชีเจ้าของแพลตฟอร์ม',
  CNYOS_OWNER_NOT_AUTHORIZED: 'กรุณาใช้บัญชี Google ของเจ้าของแพลตฟอร์ม',
  CNYOS_OWNER_GOOGLE_SIGN_IN_REQUIRED: 'กรุณาออกจากระบบแล้วเข้าสู่ Google ใหม่',
  CNYOS_OWNER_SESSION_INVALID: 'Session หมดอายุ กรุณาเข้าสู่ระบบใหม่',
  CNYOS_OWNER_SESSION_REQUIRED: 'กรุณาเข้าสู่ระบบด้วย Google',
  PLATFORM_RECENT_LOGIN_REQUIRED: 'กรุณาเข้า Google ใหม่เพื่อยืนยันการ Deploy (ภายใน 15 นาที)',
  PLATFORM_SERVICE_UNAVAILABLE: 'เชื่อมบริการจัดการแพลตฟอร์มไม่สำเร็จ กรุณาลองโหลดสถานะใหม่',
  PLATFORM_SOURCE_CHANGED: 'มีรุ่นใหม่ของระบบแล้ว กรุณาโหลดหน้าและบันทึกแบบร่างใหม่',
  PLATFORM_REQUEST_CONFLICT: 'รายการเปลี่ยนไปแล้ว กรุณาโหลดสถานะล่าสุด',
  PLATFORM_CONFIRMATION_MISMATCH: 'รหัสแอปที่ยืนยันไม่ตรงกับแบบร่าง',
  PLATFORM_DEPLOY_NOT_READY: 'ยังมีการเชื่อมต่อที่ต้องตั้งค่าให้ครบก่อน Deploy',
  PLATFORM_INPUT_INVALID: 'กรุณากรอกข้อมูลให้ครบและไม่เกินความยาวที่กำหนด',
  PLATFORM_SLUG_INVALID: 'รหัสแอปต้องเป็นอักษรอังกฤษตัวเล็ก ตัวเลข และขีดกลาง',
  PLATFORM_LINK_INVALID: 'ใช้ลิงก์ HTTPS ที่ไม่มีรหัสผ่านหรือข้อมูลลับ',
  PLATFORM_DRIVE_LINK_INVALID: 'กรุณาวางลิงก์โฟลเดอร์ Google Drive หรือ Folder ID',
  PLATFORM_DATABASE_LINK_INVALID: 'กรุณาวางลิงก์โครงการ Supabase หรือ API URL ของโครงการ',
  PLATFORM_SITE_LINK_INVALID: 'ใช้ลิงก์หลักของเว็บไซต์ Netlify เช่น https://your-clinic.netlify.app',
  PLATFORM_LINK_SECRET_DENIED: 'ลิงก์นี้มีพารามิเตอร์ กรุณาใช้ลิงก์ปลายทางที่ไม่มีข้อมูลลับ',
  REQUEST_TIMEOUT: 'คำขอใช้เวลานาน กรุณาโหลดสถานะก่อนส่งงานซ้ำ'
};
const deploymentMessages = {
  dispatch_pending: 'บันทึกคำขอแล้ว กำลังตรวจว่าบริการได้รับงานหรือไม่',
  dispatch_unknown: 'ยังยืนยันการรับงานไม่ได้ กรุณาตรวจสถานะ ระบบจะไม่ส่งซ้ำอัตโนมัติ',
  dispatch_rejected: 'บริการ Deploy ปฏิเสธคำขอ ต้องตรวจการเชื่อมต่อและตั้งค่าบริการก่อน',
  queued: 'ส่งคำขอแล้ว กำลังรอ workflow เริ่มทำงาน', running: 'Workflow กำลังทำงาน',
  workflow_succeeded: 'Workflow ทดสอบสำเร็จ เปิดผลการทำงานเพื่อดูลิงก์และหลักฐานเว็บไซต์ร่าง',
  workflow_failed: 'Workflow ยังไม่สำเร็จ เปิดผลการทำงานเพื่อตรวจสาเหตุ'
};
const fmt = value => new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' }).format(new Date(value));
const node = (tag, text, className = '') => { const element = document.createElement(tag); element.textContent = text; if (className) element.className = className; return element; };
function errorText(error) { return messages[error.code || error.message] || 'ทำรายการไม่สำเร็จ กรุณาตรวจการเชื่อมต่อและลองใหม่'; }
function currentInput() { return { ...Object.fromEntries(ids.map(id => [id, $(id).value])), targetKey: $('target').value, features: selected }; }
function lock(value) {
  busy = value;
  for (const element of $('builder').elements) element.disabled = value;
  $('features').querySelector('input[value="core"]').disabled = true;
  for (const id of ['refresh-list', 'refresh-plan', 'confirm']) $(id).disabled = value;
  updateDeployButton();
}
function updateDeployButton() {
  $('deploy').disabled = busy || !saved || dirty || !session || Boolean(saved.deployment)
    || $('confirm').value !== saved.plan.slug || !registry
    || !platformPreflight(saved.plan, registry.targets, registry).canDeployPreview;
}
function invalidate(message = 'กรุณาเข้าสู่ระบบใหม่') {
  epoch += 1; session = null; saved = null; registry = null; saveId = null; dirty = true;
  for (const controller of requests) controller.abort(); requests.clear();
  $('workspace').hidden = true; $('access').hidden = false; $('access-message').textContent = message;
  for (const id of [...ids, 'confirm']) $(id).value = '';
  for (const id of ['history', 'checks', 'deployment-status', 'actor']) $(id).replaceChildren();
  $('logout').disabled = true; $('saved-info').hidden = true;
  updateDeployButton();
}
async function api(body, planId) {
  const myEpoch = epoch;
  if (!session?.access_token) throw Object.assign(new Error(), { code: 'CNYOS_OWNER_SESSION_REQUIRED' });
  const controller = new AbortController(); requests.add(controller);
  const timer = setTimeout(() => controller.abort(), 16000);
  try {
    const response = await fetch(`/api/platform-console${planId ? `?planId=${encodeURIComponent(planId)}` : ''}`, {
      method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json',
        ...(session.provider_token ? { 'X-Owner-Google-Token': session.provider_token } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal
    });
    const data = await response.json();
    if (myEpoch !== epoch) throw new Error('STALE_SESSION');
    if (!response.ok || data.ok !== true) {
      const error = Object.assign(new Error(data.code), { code: data.code, field: data.field });
      if (response.status === 401 || ['PLATFORM_OWNER_REQUIRED', 'CNYOS_OWNER_NOT_AUTHORIZED', 'CNYOS_OWNER_GOOGLE_SIGN_IN_REQUIRED'].includes(data.code)) invalidate(errorText(error));
      throw error;
    }
    return data;
  } catch (error) {
    if (controller.signal.aborted && myEpoch === epoch) throw Object.assign(new Error(), { code: 'REQUEST_TIMEOUT' });
    throw error;
  } finally { clearTimeout(timer); requests.delete(controller); }
}
function renderFeatures() {
  $('features').replaceChildren(...PLATFORM_FEATURES.map(feature => {
    const label = node('label', '', 'feature');
    const input = document.createElement('input'); input.type = 'checkbox'; input.value = feature.id;
    input.checked = selected.includes(feature.id); input.disabled = feature.required;
    const text = node('span', ''); text.append(node('b', feature.name), node('small', feature.detail));
    input.addEventListener('change', () => {
      const next = new Set(selected);
      if (input.checked) next.add(feature.id);
      else {
        next.delete(feature.id);
        for (let round = 0; round < PLATFORM_FEATURES.length; round++) {
          for (const item of PLATFORM_FEATURES) if (item.requires.some(id => !next.has(id))) next.delete(item.id);
        }
      }
      selected = resolvePlatformFeatures([...next]); renderFeatures(); changed();
    });
    label.append(input, text); return label;
  }));
  $('feature-count').textContent = selected.length;
}
function renderReview(preflight) {
  const plan = saved && !dirty ? saved.plan : null;
  $('review-name').textContent = plan?.name || $('name').value || 'แอปใหม่ของคุณ';
  $('review-description').textContent = plan ? `บันทึกเมื่อ ${fmt(saved.createdAt)}` : 'บันทึกแบบร่างเพื่อดูความพร้อมก่อน Deploy';
  $('saved-info').hidden = !plan;
  $('export-plan').hidden = !plan;
  $('refresh-plan').hidden = !plan?.sourceCommit || !saved?.deployment;
  $('checks').replaceChildren(...(preflight?.checks || []).map(check => {
    const li = node('li', '', check.status); li.append(node('span', check.status === 'ready' ? '✓' : check.status === 'blocked' ? '!' : '·', 'check-dot'), node('span', check.message)); return li;
  }));
  $('deployment-status').replaceChildren();
  if (plan && saved.deployment) {
    $('deployment-status').append(node('p', deploymentMessages[saved.deployment.state] || 'กำลังตรวจสถานะ'));
    if (/^https:\/\/github\.com\/apisarit\/chananya-clinical-wellness-os\/actions\/runs\/\d+$/.test(saved.deployment.runUrl || '')) {
      const a = node('a', 'เปิดผล Workflow'); a.href = saved.deployment.runUrl; a.target = '_blank'; a.rel = 'noopener noreferrer'; $('deployment-status').append(a);
    }
    const list = node('ol', '', 'events');
    for (const event of saved.events) list.append(node('li', `${event.action} · ${fmt(event.at)} · ${event.actor}`));
    $('deployment-status').append(list);
  }
  updateDeployButton();
}
function changed() {
  dirty = true; saveId = null; $('confirm').value = ''; $('feature-count').textContent = selected.length;
  $('form-status').textContent = '';
  let preflight; try { preflight = platformPreflight(normalizePlatformPlan(currentInput()), registry.targets, registry); } catch { /* Show field errors on submit. */ }
  renderReview(preflight);
}
function acceptRecord(record, preflight) {
  saved = record; dirty = false;
  const index = registry.records.findIndex(item => item.id === record.id);
  if (index < 0) registry.records.unshift(record); else registry.records[index] = record;
  renderHistory(); renderReview(preflight || platformPreflight(record.plan, registry.targets, registry));
}
function renderHistory() {
  $('draft-count').textContent = registry.records.length;
  $('history').replaceChildren();
  if (!registry.records.length) $('history').append(node('p', 'ยังไม่มีแบบร่าง เริ่มสร้างแอปได้จากแบบฟอร์มด้านบน', 'hint'));
  for (const record of registry.records) {
    const row = node('div', '', 'history-row'), content = node('div', '');
    content.append(node('h3', record.plan.name), node('small', `${record.plan.slug} · ${fmt(record.createdAt)} · ${record.actor}`));
    const button = node('button', 'เปิดแบบร่าง'); button.type = 'button';
    button.addEventListener('click', () => {
      if (busy) return;
      const input = platformPlanInput(record.plan);
      for (const id of ids) $(id).value = input[id];
      $('target').value = record.plan.targetKey; selected = record.plan.features; saveId = null;
      renderFeatures(); acceptRecord(record); $('review-name').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    row.append(content, button); $('history').append(row);
  }
  if (registry.truncated) $('history').append(node('p', 'แสดงสูงสุด 100 แบบร่าง', 'hint'));
}
async function load() {
  const data = await api(); registry = data; $('actor').textContent = data.actor;
  $('target').replaceChildren(new Option('ลูกค้าใหม่ / ยังไม่ลงทะเบียนเว็บไซต์', ''), ...data.targets.map(target => new Option(target.label, target.key)));
  $('dispatcher-label').textContent = data.dispatcherReady ? 'เชื่อมแล้ว' : 'รอเชื่อมสิทธิ์';
  $('access').hidden = true; $('workspace').hidden = false; $('logout').disabled = false;
  renderFeatures(); renderHistory(); renderReview();
  const requestedSection = location.hash.slice(1);
  if (['clinic-setup', 'storage-setup'].includes(requestedSection)) {
    $(requestedSection).scrollIntoView({ block: 'start' });
  }
}
$('target').addEventListener('change', () => {
  const target = registry.targets.find(item => item.key === $('target').value);
  if (target) {
    $('name').value = target.label; $('slug').value = target.key; $('site').value = target.siteOrigin;
    $('database').value = `https://${target.projectRef}.supabase.co`;
    $('drive').value = target.driveRootId ? `https://drive.google.com/drive/folders/${target.driveRootId}` : '';
  }
  changed();
});
ids.forEach(id => $(id).addEventListener('input', changed));
$('confirm').addEventListener('input', updateDeployButton);
$('builder').addEventListener('submit', async event => {
  event.preventDefault(); if (busy || !registry) return;
  const myEpoch = epoch;
  try {
    const input = currentInput(); normalizePlatformPlan(input); saveId ||= crypto.randomUUID(); lock(true);
    const result = await api({ action: 'save', requestId: saveId, plan: input });
    if (epoch !== myEpoch) return;
    acceptRecord(result.record, result.preflight); $('form-status').classList.remove('error'); $('form-status').textContent = 'บันทึกแบบร่างและประวัติที่เซิร์ฟเวอร์แล้ว';
  } catch (error) {
    if (epoch !== myEpoch) return;
    $('form-status').textContent = errorText(error); $('form-status').classList.add('error');
    if (ids.includes(error.field)) $(error.field).focus();
  } finally { if (epoch === myEpoch) lock(false); }
});
$('deploy').addEventListener('click', async () => {
  if ($('deploy').disabled) return;
  const myEpoch = epoch; lock(true);
  try { const result = await api({ action: 'deploy-preview', requestId: crypto.randomUUID(), planId: saved.id, planHash: saved.hash, confirmSlug: $('confirm').value }); if (epoch === myEpoch) acceptRecord(result.record); }
  catch (error) { if (epoch === myEpoch) { $('deployment-status').textContent = errorText(error); $('refresh-plan').hidden = false; } }
  finally { if (epoch === myEpoch) lock(false); }
});
$('refresh-plan').addEventListener('click', async () => {
  if (busy || !saved) return; const myEpoch = epoch; lock(true);
  try { const result = await api(null, saved.id); if (epoch === myEpoch) acceptRecord(result.record, result.preflight); }
  catch (error) { if (epoch === myEpoch) $('deployment-status').textContent = errorText(error); }
  finally { if (epoch === myEpoch) lock(false); }
});
$('export-plan').addEventListener('click', () => {
  if (!saved || dirty) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(saved.plan, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = `${saved.plan.slug}-plan.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('refresh-list').addEventListener('click', async () => {
  if (busy) return;
  const myEpoch = epoch; lock(true);
  try { const result = await api(); if (epoch === myEpoch) { registry = result; renderHistory(); } }
  catch (error) { if (epoch === myEpoch) $('form-status').textContent = errorText(error); }
  finally { if (epoch === myEpoch) lock(false); }
});
$('reload').addEventListener('click', () => location.reload());
function goLogin() { try { sessionStorage.setItem('cnyos:post_auth_path', '/platform-console.html'); } catch { /* Navigation still works. */ } location.replace('/login.html'); }
async function signOut() { invalidate(); try { await db?.auth.signOut({ scope: 'local' }); } finally { goLogin(); } }
$('login').addEventListener('click', signOut); $('logout').addEventListener('click', signOut);
window.addEventListener('pagehide', () => invalidate());
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
async function start() {
  try {
    db = window.ChananyaRuntime.getDb(); session = (await db.auth.getSession()).data.session;
    if (!session) { invalidate('เข้าสู่ระบบด้วยบัญชี Google ของเจ้าของแพลตฟอร์ม'); return; }
    accountId = session.user.id;
    db.auth.onAuthStateChange((event, next) => {
      if (event === 'INITIAL_SESSION') return;
      if (!next || next.user.id !== accountId) invalidate(); else session = next;
    });
    await load();
  } catch (error) { invalidate(errorText(error)); }
}
start();
