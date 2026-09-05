import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {mountUSystesis} from '../u-systesis.js';

const root = new URL('../', import.meta.url);
const read = file => fs.readFileSync(new URL(file, root), 'utf8');
class Element {
  constructor(tag = 'div') { this.localName = tag; this.children = []; this.attrs = {}; this.events = {}; this.value = ''; this.textContent = ''; this.hidden = false; }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  addEventListener(name, callback) { this.events[name] = callback; }
}
const ids = Object.fromEntries([...read('luopan-wheel.html').matchAll(/\bid="(us-[^"]+|lr-form|lr-birth|lr-tz|luopan-birthdate-ray)"/g)].map(match => [match[1], new Element()]));
ids['lr-birth'].value = '29/10/2530 22.19'; ids['lr-tz'].value = '7';
ids['us-mode'].value = 'astro_medical'; ids['us-spatial'].hidden = true;
const window = {};
vm.runInNewContext(read('luopan-knowledge.js'), {window});
const document = {getElementById: id => ids[id] || null, createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag)};
mountUSystesis(document, window);
assert.match(ids['us-version'].textContent, /U systesis 0\.1\.0.*113/);
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
assert.doesNotMatch(read('u-systesis.js'), /fetch\s*\(|XMLHttpRequest|localStorage|sessionStorage|supabase|DeviceOrientationEvent/);
assert.match(read('app-shell.js'), /label: 'U systesis'.*capability: 'luopan_read'/);
for (const name of ['catalog', 'engine']) {
  const expected = '// Generated from knowledge/u-systesis/' + name + '.mjs\n' + read('knowledge/u-systesis/' + name + '.mjs').replace("from './catalog.mjs'", "from './u-systesis-catalog.js'");
  assert.equal(read('u-systesis-' + name + '.js'), expected, 'published module must match its tested source');
}
console.log('U systesis UI passed: two modes, fixed geometry, birthdate separation, uncertain and invalid headings, complete catalog and generated module identity');
