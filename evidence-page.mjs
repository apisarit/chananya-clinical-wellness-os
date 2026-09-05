import { sources, normalizeResults, publicMessage } from './evidence-view.mjs';

export function createEvidenceController({ document, runtime, shell, location, fetchImpl = fetch }) {
  const $ = id => document.getElementById(id);
  let ready = false;
  let activeRequest = null;
  let generation = 0;
  let unsubscribe = null;

  function clear(message = 'เลือกแหล่งอ้างอิงและกรอกคำค้นเพื่อเริ่ม') {
    generation++;
    activeRequest?.abort();
    activeRequest = null;
    $('evidence-results').replaceChildren();
    $('evidence-output').setAttribute('aria-busy', 'false');
    $('evidence-status').textContent = message;
    $('evidence-submit').disabled = !ready;
  }

  function sourceChanged() {
    const source = sources[$('evidence-source').value];
    clear();
    $('source-description').textContent = source?.description || '';
    $('evidence-query').placeholder = source ? `เช่น ${source.example}` : '';
  }

  function render(rows, source) {
    const cards = rows.map(row => {
      const card = document.createElement('article');
      card.className = 'evidence-result';
      const provenance = document.createElement('small');
      provenance.textContent = `${sources[source].label} • ${row.id}${row.date ? ` • ${row.date}` : ''}`;
      const title = document.createElement('h3');
      title.textContent = row.title;
      const detail = document.createElement('p');
      detail.textContent = row.detail;
      const link = document.createElement('a');
      link.href = row.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.referrerPolicy = 'no-referrer';
      link.textContent = 'เปิดต้นฉบับ ↗';
      card.append(provenance, title, detail, link);
      return card;
    });
    $('evidence-results').replaceChildren(...cards);
  }

  async function search(event) {
    event?.preventDefault();
    if (!ready) return;
    clear();
    const current = generation;
    const source = $('evidence-source').value;
    const query = $('evidence-query').value.trim();
    if (!Object.hasOwn(sources, source) || query.length < 2 || query.length > 160) {
      $('evidence-status').textContent = publicMessage(400);
      return;
    }
    const controller = new AbortController();
    activeRequest = controller;
    $('evidence-submit').disabled = true;
    $('evidence-output').setAttribute('aria-busy', 'true');
    $('evidence-status').textContent = `กำลังค้น ${sources[source].label}…`;
    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const session = await runtime.getSession();
      if (current !== generation) return;
      if (!session?.access_token) { ready = false; clear(publicMessage(401)); return; }
      const response = await fetchImpl('/api/evidence-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ source, query }),
        signal: controller.signal,
        credentials: 'same-origin',
        cache: 'no-store',
        referrerPolicy: 'no-referrer'
      });
      const payload = await response.json();
      if (current !== generation) return;
      if (!response.ok || payload.ok !== true) {
        if (response.status === 401 || response.status === 403) ready = false;
        $('evidence-status').textContent = publicMessage(response.status, payload.code);
        return;
      }
      const rows = normalizeResults(payload, source);
      render(rows, source);
      const retrieved = new Date(payload.retrievedAt);
      const time = Number.isNaN(retrieved.getTime()) ? '' : ` • ดึงข้อมูล ${retrieved.toLocaleString('th-TH')}`;
      $('evidence-status').textContent = rows.length ? `แสดง ${rows.length} รายการจาก ${sources[source].label}${time} • ยังไม่ผ่านการทบทวนทางคลินิก` : `ไม่พบรายการที่แสดงได้จาก ${sources[source].label} ลองใช้ชื่อภาษาอังกฤษหรือคำค้นอื่น`;
    } catch (error) {
      if (current === generation) $('evidence-status').textContent = error?.name === 'AbortError' ? 'แหล่งข้อมูลตอบกลับช้า กรุณาลองใหม่' : publicMessage(502);
    } finally {
      clearTimeout(timeout);
      if (current === generation) {
        activeRequest = null;
        $('evidence-output').setAttribute('aria-busy', 'false');
        $('evidence-submit').disabled = !ready;
      }
    }
  }

  async function init() {
    ready = false;
    clear();
    const current = generation;
    unsubscribe?.();
    unsubscribe = null;
    $('app').classList.add('hidden');
    $('boot').classList.remove('hidden');
    try {
      if (!runtime) throw new Error('ไม่สามารถเปิดระบบได้ กรุณาโหลดหน้าใหม่');
      const session = await runtime.getSession();
      if (current !== generation) return;
      if (!session) { location.replace('/login.html'); return; }
      const profile = await runtime.getProfile(session.user.id);
      if (current !== generation) return;
      if (!runtime.can(profile, 'knowledge_read')) throw new Error('บัญชีนี้ไม่มีสิทธิ์อ่านแหล่งอ้างอิง');
      shell?.mount({ profile, session, active: 'foundation' });
      ready = true;
      sourceChanged();
      $('app').classList.remove('hidden');
      $('boot').classList.add('hidden');
      const subscription = runtime.getDb().auth.onAuthStateChange((event, nextSession) => {
        if (event === 'SIGNED_OUT' || !nextSession) {
          ready = false;
          clear(publicMessage(401));
          $('evidence-query').value = '';
          location.replace('/login.html');
        }
      });
      unsubscribe = () => subscription?.data?.subscription?.unsubscribe();
    } catch (error) {
      $('boot-error').textContent = error?.message || 'ไม่สามารถเปิดแหล่งอ้างอิงได้';
    }
  }

  $('evidence-form').addEventListener('submit', search);
  $('evidence-source').addEventListener('change', sourceChanged);
  $('evidence-query').addEventListener('input', () => clear());
  $('evidence-clear').addEventListener('click', () => { clear(); $('evidence-query').value = ''; });
  $('logout').addEventListener('click', async () => {
    ready = false;
    clear();
    $('evidence-query').value = '';
    try {
      const result = await runtime.getDb().auth.signOut();
      if (result?.error) throw result.error;
      location.replace('/login.html');
    } catch { $('evidence-status').textContent = 'ออกจากระบบไม่สำเร็จ กรุณาลองใหม่'; }
  });
  return { init, search, clear, dispose() { ready = false; clear(); unsubscribe?.(); } };
}

if (typeof window !== 'undefined' && window.document) {
  const controller = createEvidenceController({ document: window.document, runtime: window.ChananyaRuntime, shell: window.ChananyaShell, location: window.location });
  window.addEventListener('pagehide', () => controller.dispose());
  window.addEventListener('pageshow', event => { if (event.persisted) controller.init(); });
  controller.init();
}
