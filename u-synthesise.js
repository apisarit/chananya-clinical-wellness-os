import {identity, modules, layers, frames, mountains, bagua, elements, sources, rules} from './u-synthesise-catalog.js';
import {mountClassicalLuopan} from './u-synthesise-luopan.js';
import {angle, readBearing, readBirthTime, branchBearingOverlay, relateElements, attachLegacyKnowledge} from './u-synthesise-engine.js';

export function mountUSynthesise(document, window) {
  const q = id => document.getElementById(id);
  if (!q('us-mode')) return;
  let reading = null, overlay = null, bearingOrigin = 'manual';
  const node = (tag, text, parent) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (parent) parent.appendChild(element);
    return element;
  };
  const atlas = mountClassicalLuopan(document, {onExplore(degrees) {
    q('us-bearing').value = String(degrees);
    q('us-uncertainty').value = '';
    submitBearing(null, 'study');
  }});
  function draw() { atlas.update(reading, overlay, bearingOrigin); }
  function birthOverlay() {
    try {
      const text = q('lr-birth').value;
      const year = Number(text.trim().match(/^\d{1,2}\/\d{1,2}\/(\d{4})/)?.[1]);
      const value = readBirthTime(text, {era: year >= 2400 ? 'BE' : 'CE', utcOffsetMinutes: Number(q('lr-tz').value) * 60});
      overlay = branchBearingOverlay(value.chineseHour.symbol);
      q('us-overlay').textContent = `ยามของวันเกิดที่กรอก: ${value.chineseHour.symbol} ${value.chineseHour.animal} · กาล${value.kala.name} · เน้นขุนเขาชื่อเดียวกัน ${overlay.mountain.start}°–${(overlay.mountain.start + 15) % 360}° เป็นการเทียบสัญลักษณ์ ยังไม่ประเมินทิศมงคล`;
    } catch {
      overlay = null;
      q('us-overlay').textContent = 'ยังไม่เชื่อมวันเกิด: ตรวจวันเวลาและเขตเวลาในโหมดเวลา';
    }
    draw();
  }
  function submitBearing(event, origin = 'manual') {
    bearingOrigin = origin;
    event?.preventDefault();
    try {
      const raw = q('us-bearing').value.trim(), degrees = Number(raw);
      if (!raw || !Number.isFinite(degrees) || degrees < 0 || degrees > 360) throw new Error('กรอกองศา 0–360 ที่อ้างเหนือแม่เหล็ก');
      const uncertainty = q('us-uncertainty').value.trim();
      reading = readBearing({position: angle('magnetic_bearing', degrees), source: 'manual', uncertaintyDegrees: uncertainty === '' ? null : Number(uncertainty)});
      const quality = reading.candidates === null ? 'ยังไม่ระบุความคลาดเคลื่อน' : reading.candidates.length > 1 ? 'ช่วงคลาดเคลื่อนคร่อม ' + reading.candidates.map(item => item.symbol).join(' / ') : 'ช่วงคลาดเคลื่อนอยู่ในขุนเขาเดียว';
      q('us-result').textContent = `${reading.position.degrees.toFixed(1)}° · ${reading.mountain.symbol} ${reading.mountain.code} · ${reading.bagua.name} · ข่วย ${reading.bagua.symbol} · ${quality}`;
      q('us-error').hidden = true;
    } catch {
      reading = null;
      q('us-result').textContent = 'รอค่าทิศทาง';
      q('us-error').textContent = 'ตรวจองศา 0–360 และค่าคลาดเคลื่อน 0–180 หรือเว้นค่าคลาดเคลื่อนไว้';
      q('us-error').hidden = false;
    }
    draw();
  }
  const frameNames = {magnetic_bearing: 'ทิศเหนือแม่เหล็ก', zodiac_sidereal: 'องศาราศีนิรายนะ', civil_year_april: 'วงปีเริ่มเมษายน', clock12: 'เวลา 12 ชั่วโมง × 2 รอบ', lunar_sequence: 'ลำดับฤดูจันทรคติ', category: 'หมวดองค์ความรู้'};
  try {
    const attached = attachLegacyKnowledge(window.LuopanKnowledgeV1);
    q('us-version').textContent = `${identity.name} ${identity.version} · วงเวลา 23 ชั้น · หล่อแก 16 ชั้น · สมุฏฐานเดิม ${attached.legacy.source.ttmRaw.length} กฎ`;
    for (const module of modules) {
      const item = node('li', undefined, q('us-modules'));
      node('strong', module.name + ' — ', item);
      node('span', module.scope, item);
    }
    for (const layer of layers) {
      const row = node('tr', undefined, q('us-layer-frames'));
      const legacy = attached.legacy.model.layers.find(item => item.id === layer.id);
      node('th', legacy?.name || ({calendar: 'วงปี', planetary: 'ดาวไทย', pillars: 'สี่เสา'}[layer.id]), row);
      node('td', frameNames[layer.frame] || frames[layer.frame].domain, row);
    }
    for (const element of elements) {
      const row = node('tr', undefined, q('us-wuxing'));
      node('th', element.name, row);
      for (const relation of ['generates', 'controls']) node('td', elements.find(target => relateElements(element.id, target.id).relation === relation).name, row);
    }
    q('us-review').textContent = 'กฎสหะ–อริและฤดูละเอียดคงสถานะรอทบทวนต้นฉบับ · ดาวเหินและทิศมงคลเฉพาะบุคคลยังไม่เปิดใช้ · ' + rules.filter(rule => rule.status === 'implemented').length + ' กฎพื้นฐานสำหรับอ่านทิศ กาล และความสัมพันธ์';
    for (const source of Object.values(sources).filter(item => item.url)) {
      const item = node('li', undefined, q('us-sources'));
      const link = node('a', source.title, item);
      link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    }
  } catch {
    q('us-version').textContent = 'U Synthesise: ฐานความรู้โหลดไม่ครบ กรุณาโหลดหน้าใหม่';
    q('us-mode').disabled = true;
    return;
  }
  q('us-mode').addEventListener('change', () => {
    const compassMode = q('us-mode').value === 'feng_shui';
    q('luopan-birthdate-ray').hidden = compassMode;
    q('us-spatial').hidden = !compassMode;
    if (compassMode) birthOverlay();
  });
  q('us-bearing-form').addEventListener('submit', submitBearing);
  q('lr-form').addEventListener('submit', birthOverlay);
  birthOverlay();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => mountUSynthesise(document, window), {once: true});
  else mountUSynthesise(document, window);
}
