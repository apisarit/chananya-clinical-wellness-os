import {identity, modules, layers, frames, mountains, bagua, elements, sources, rules} from './u-systesis-catalog.js';
import {angle, readBearing, readBirthTime, branchBearingOverlay, relateElements, attachLegacyKnowledge} from './u-systesis-engine.js';

export function mountUSystesis(document, window) {
  const q = id => document.getElementById(id);
  if (!q('us-mode')) return;
  const svg = q('us-compass'), NS = 'http://www.w3.org/2000/svg';
  let reading = null, overlay = null;
  const node = (tag, text, parent) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (parent) parent.appendChild(element);
    return element;
  };
  const shape = (tag, attrs, text) => {
    const element = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
    if (text !== undefined) element.textContent = text;
    svg.appendChild(element);
    return element;
  };
  const point = (r, degrees) => [250 + r * Math.sin(degrees * Math.PI / 180), 250 - r * Math.cos(degrees * Math.PI / 180)];
  function arc(inner, outer, start, span) {
    const a = point(outer, start), b = point(outer, start + span), c = point(inner, start + span), d = point(inner, start);
    return `M${a} A${outer},${outer} 0 0 1 ${b} L${c} A${inner},${inner} 0 0 0 ${d} Z`;
  }
  function draw() {
    svg.replaceChildren();
    shape('title', {}, '24 ขุนเขา · เหนือแม่เหล็ก 0 องศา · ตารางทิศคงที่');
    for (const sector of bagua) {
      shape('path', {d: arc(188, 225, sector.start, sector.span), fill: 'var(--viz-series-1)', 'fill-opacity': '.12', stroke: 'var(--border)'});
      const p = point(207, sector.center);
      shape('text', {x: p[0], y: p[1] + 5, 'text-anchor': 'middle'}, sector.direction + ' ' + sector.symbol);
    }
    for (const mountain of mountains) {
      const selected = reading?.mountain.symbol === mountain.symbol;
      const linked = overlay?.symbol === mountain.symbol;
      const path = shape('path', {d: arc(126, 187, mountain.start, 15), fill: selected ? 'var(--viz-series-5)' : 'var(--viz-series-2)', 'fill-opacity': selected ? '.58' : linked ? '.40' : '.08', stroke: 'var(--border)', 'data-mountain': mountain.symbol});
      const title = document.createElementNS(NS, 'title');
      title.textContent = `${mountain.symbol} ${mountain.code} · ${mountain.start}°–${(mountain.start + 15) % 360}°`;
      path.appendChild(title);
      const p = point(158, mountain.center), code = point(140, mountain.center);
      shape('text', {x: p[0], y: p[1] + 5, 'text-anchor': 'middle'}, mountain.symbol);
      shape('text', {x: code[0], y: code[1] + 3, 'text-anchor': 'middle', 'font-size': '9'}, mountain.code);
    }
    shape('text', {x: 250, y: 238, 'text-anchor': 'middle', 'font-size': '21'}, reading ? reading.position.degrees.toFixed(1) + '°' : '24 ขุนเขา');
    shape('text', {x: 250, y: 264, 'text-anchor': 'middle', 'font-size': '13'}, 'เหนือแม่เหล็ก · ตารางคงที่');
    if (reading) {
      const p = point(230, reading.position.degrees), start = point(83, reading.position.degrees);
      shape('line', {x1: start[0], y1: start[1], x2: p[0], y2: p[1], stroke: 'var(--foreground)', 'stroke-width': '2', 'data-bearing': reading.position.degrees});
      shape('circle', {cx: p[0], cy: p[1], r: 5, fill: 'var(--foreground)'});
    }
  }
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
  function submitBearing(event) {
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
    q('us-version').textContent = `${identity.name} ${identity.version} · 23 ชั้น · สมุฏฐานเดิม ${attached.legacy.source.ttmRaw.length} กฎ`;
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
    q('us-version').textContent = 'U systesis: ฐานความรู้โหลดไม่ครบ กรุณาโหลดหน้าใหม่';
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
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => mountUSystesis(document, window), {once: true});
  else mountUSystesis(document, window);
}
