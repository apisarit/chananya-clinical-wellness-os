import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {mountUSynthesise} from '../u-synthesise.js';

const root = new URL('../', import.meta.url);
const read = file => fs.readFileSync(new URL(file, root), 'utf8');
class Element {
  constructor(tag = 'div') { this.localName = tag; this.children = []; this.attrs = {}; this.events = {}; this.value = ''; this.textContent = ''; this.hidden = false; }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  getAttribute(key) { return this.attrs[key] ?? null; }
  getBoundingClientRect() { return {left:0,top:0,width:392,height:392}; }
  addEventListener(name, callback) { this.events[name] = callback; }
}
const ids = Object.fromEntries([...read('luopan-wheel.html').matchAll(/\bid="(us-[^"]+|lr-form|lr-birth|lr-tz|luopan-birthdate-ray)"/g)].map(match => [match[1], new Element()]));
ids['lr-birth'].value = '29/10/2530 22.19'; ids['lr-tz'].value = '7';
ids['us-mode'].value = 'astro_medical'; ids['us-spatial'].hidden = true;
const window = {};
vm.runInNewContext(read('luopan-knowledge.js'), {window});
const document = {getElementById: id => ids[id] || null, createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag)};
mountUSynthesise(document, window);
assert.match(ids['us-version'].textContent, /U Synthesise 0\.2\.0.*113/);
assert.equal(ids['us-modules'].children.length, 4);
assert.equal(ids['us-layer-frames'].children.length, 23);
assert.equal(ids['us-wuxing'].children.length, 5);
assert.equal(ids['us-sources'].children.length, 4);
assert.match(ids['us-overlay'].textContent, /亥 กุน.*ปิตตะ.*322\.5°–337\.5°/);
const mountains = () => ids['us-compass'].children.filter(item => item.attrs['data-mountain']);
const geometry = () => mountains().map(item => [item.attrs['data-mountain'], item.attrs.d]);
assert.equal(mountains().length, 24);
const originalGeometry = geometry();
assert.ok(!ids['us-compass'].children.some(item => item.attrs['data-bearing']), 'no fabricated initial measured heading');

ids['us-mode'].value = 'feng_shui'; ids['us-mode'].events.change();
assert.equal(ids['us-spatial'].hidden, false);
assert.equal(ids['luopan-birthdate-ray'].hidden, true);
const submit = () => ids['us-bearing-form'].events.submit({preventDefault() {}});
ids['us-bearing'].value = '330'; ids['us-uncertainty'].value = ''; submit();
assert.match(ids['us-result'].textContent, /330\.0° · 亥 NW3.*ยังไม่ระบุความคลาดเคลื่อน/);
ids['us-bearing'].value = '337.4'; ids['us-uncertainty'].value = '0.2'; submit();
assert.match(ids['us-result'].textContent, /ช่วงคลาดเคลื่อนคร่อม.*壬.*亥/);
ids['us-bearing'].value = '360'; ids['us-uncertainty'].value = '0'; submit();
assert.match(ids['us-result'].textContent, /0\.0° · 子 N2/);
const measured = ids['us-result'].textContent;
ids['lr-birth'].value = '01/04/2567 06:00'; ids['lr-form'].events.submit();
assert.match(ids['us-overlay'].textContent, /卯 เถาะ.*เสมหะ/);
assert.equal(ids['us-result'].textContent, measured, 'birthdate cannot change the measured bearing');
assert.deepEqual(geometry(), originalGeometry, 'birthdate and bearing do not rotate 24 Mountains');
ids['lr-birth'].value = '31/04/2567 06:00'; ids['lr-form'].events.submit();
assert.match(ids['us-overlay'].textContent, /ยังไม่เชื่อมวันเกิด/);
for (const value of ['', '-1', '361', 'NaN']) {
  ids['us-bearing'].value = value; submit();
  assert.equal(ids['us-error'].hidden, false);
  assert.equal(ids['us-result'].textContent, 'รอค่าทิศทาง');
  assert.ok(!ids['us-compass'].children.some(item => Object.hasOwn(item.attrs, 'data-bearing')));
}
ids['us-mode'].value = 'astro_medical'; ids['us-mode'].events.change();
assert.equal(ids['us-spatial'].hidden, true);
assert.equal(ids['luopan-birthdate-ray'].hidden, false);
assert.doesNotMatch(read('u-synthesise.js'), /fetch\s*\(|XMLHttpRequest|localStorage|sessionStorage|supabase|DeviceOrientationEvent/);
assert.match(read('app-shell.js'), /label: 'U Synthesise'.*capability: 'luopan_read'/);
for (const name of ['catalog', 'engine', 'classical']) {
  const expected = '// Generated from knowledge/u-synthesise/' + name + '.mjs\n' + read('knowledge/u-synthesise/' + name + '.mjs').replace("from './catalog.mjs'", "from './u-synthesise-catalog.js'");
  assert.equal(read('u-synthesise-' + name + '.js'), expected, 'published module must match its tested source');
}
console.log('U Synthesise UI passed: two modes, fixed geometry, birthdate separation, uncertain and invalid headings, complete catalog and generated module identity');

const allText=el=>[el.textContent,...el.children.map(allText)].join(' ');
assert.equal(ids['us-mountain-cards'].children.length,24);
assert.equal(ids['us-trigram-cards'].children.length,8);
assert.equal(ids['us-loshu-grid'].children.length,9);
assert.equal(ids['us-hetu-rows'].children.length,5);
assert.equal(ids['us-hex-matrix'].children.length,9);
assert.equal(ids['us-study-guide'].children.length,10);
assert.equal(ids['us-classical-sources'].children.length,9);
ids['us-atlas-preset'].value='all';ids['us-atlas-preset'].events.change();
assert.match(ids['us-wheel-count'].textContent,/14 \/ 14/);
assert.equal(new Set(ids['us-compass'].children.map(c=>c.attrs['data-layer-id']).filter(Boolean)).size,13);
ids['us-zoom'].value='2';ids['us-zoom'].events.change();assert.match(ids['us-compass'].attrs.style,/width:200%/);
ids['us-uncertainty'].value='3';ids['us-bearing-slider'].value='180';ids['us-bearing-slider'].events.input();
assert.equal(ids['us-bearing'].value,'180');assert.equal(ids['us-uncertainty'].value,'');
assert.match(ids['us-reading-origin'].textContent,/ตำแหน่งทดลอง/);
assert.equal(ids['us-ring-results'].children.length,13);
assert.match(allText(ids['us-axis-summary']),/午 อู่.*子 จื่อ/);
ids['us-compass'].events.click({target:mountains()[0],clientX:300,clientY:196});
assert.equal(ids['us-bearing'].value,'90','tap maps to measured reference geometry at mobile display width');
assert.match(ids['us-reading-origin'].textContent,/ตำแหน่งทดลอง/);
ids['us-bearing'].value='330';submit();assert.match(ids['us-reading-origin'].textContent,/ค่าทิศทางที่กรอก/);
const geometryAll=geometry();
ids['us-life-element'].value='fire';ids['us-life-polarity'].value='yin';ids['us-life-element'].events.change();
assert.deepEqual(geometry(),geometryAll,'changing study water element cannot rotate the plates');
ids['us-layer-select'].value='life';ids['us-layer-select'].events.change();assert.match(allText(ids['us-layer-detail']),/ฉางเซิง.*火|ฉางเซิง.*ไฟ/s);
ids['us-mountain-filter'].value='hai';ids['us-mountain-filter'].events.input();assert.equal(ids['us-mountain-cards'].children.length,1);assert.match(allText(ids['us-mountain-cards']),/亥.*กุน/);
ids['us-mountain-filter'].value='<script>';ids['us-mountain-filter'].events.input();assert.match(allText(ids['us-mountain-cards']),/ไม่พบ/);
ids['us-mountain-filter'].value='';ids['us-mountain-filter'].events.input();
ids['us-hex-upper'].value='震';ids['us-hex-lower'].value='乾';ids['us-hex-upper'].events.change();assert.match(allText(ids['us-hex-result']),/34.*大壯/);
ids['us-bearing'].value='';submit();assert.equal(ids['us-ring-results'].children.length,0);assert.doesNotMatch(allText(ids['us-axis-summary']),/亥/);
for(const file of ['u-synthesise-luopan.js','u-synthesise-classical.js'])assert.doesNotMatch(read(file),/fetch\s*\(|XMLHttpRequest|localStorage|sessionStorage|supabase|DeviceOrientationEvent|innerHTML/);
console.log('Classical UI passed: all rings, mobile tap, zoom, manual vs study provenance, search, hexagram selection, unchanged bearings and no stale invalid result');
export {ids};
