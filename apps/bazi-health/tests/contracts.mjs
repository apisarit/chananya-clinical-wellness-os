import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
const code=fs.readFileSync(path.join(root,'public/app.js'),'utf8');
const css=fs.readFileSync(path.join(root,'public/app.css'),'utf8');
const headers=fs.readFileSync(path.join(root,'public/_headers'),'utf8');
const nodes=new Map();
let activeElement=null;
class Element {
  constructor(tag,attrs={}){this.tag=tag;this.attrs=attrs;this.style={};this.dataset={};this.hidden='hidden' in attrs;this._value=attrs.value||'';this.textContent='';this._html='';}
  set innerHTML(value){
    this._html=value;
    if(this.tag==='select'){
      this.options=[...value.matchAll(/<option value="([^"]*)"([^>]*)>/g)].map(m=>({value:m[1],selected:m[2].includes('selected')}));
      this._value=(this.options.find(o=>o.selected)||this.options[0])?.value||'';
    }
  }
  get innerHTML(){return this._html;}
  set value(value){this._value=this.tag==='select'&&this.options&&!this.options.some(o=>o.value===String(value))?'':String(value);}
  get value(){return this._value;}
  setAttribute(key,value){this.attrs[key]=String(value);}
  getAttribute(key){return this.attrs[key];}
  focus(){activeElement=this;}
}
for(const match of html.matchAll(/<([a-z]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)){
  assert.ok(!nodes.has(match[3]),`duplicate id ${match[3]}`);
  const attrs=Object.fromEntries([...match[2].matchAll(/([\w-]+)="([^"]*)"/g)].map(m=>[m[1],m[2]]));
  if(/\bhidden(?:\s|$)/.test(match[2])) attrs.hidden='';
  const node=new Element(match[1],attrs);nodes.set(match[3],node);
  if(match[1]==='select') node.innerHTML=html.slice(match.index+match[0].length).split('</select>')[0];
}
const document={
  querySelector(selector){assert.match(selector,/^#/);const node=nodes.get(selector.slice(1));assert.ok(node,selector);return node;},
  querySelectorAll(selector){
    assert.equal(selector,'.luck');
    return [...nodes.get('luckStrip').innerHTML.matchAll(/data-p="([^"]+)"/g)].map(m=>{const node=new Element('button');node.dataset.p=m[1];return node;});
  }
};
const context=vm.createContext({document,console,fetch(){throw new Error('Network access is not allowed');}});
vm.runInContext(code,context);
const evaluate=source=>JSON.parse(vm.runInContext(`JSON.stringify(${source})`,context));
const get=id=>nodes.get(id);
const fixtures=JSON.parse(fs.readFileSync(path.join(root,'tests/calendar-vectors.json'),'utf8'));
for(const fixture of fixtures.cases){
  const result=evaluate(`calculateFourPillars(${JSON.stringify(fixture.input)})`);
  assert.deepEqual(Object.values(result.pillars).map(p=>p.join('')),fixture.expected,JSON.stringify(fixture.input));
}
for(const invalid of [
  {year:2025,month:2,day:29,hour:12,minute:0},
  {year:2026,month:4,day:31,hour:12,minute:0},
  {year:2026,month:0,day:1,hour:12,minute:0},
  {year:2026,month:1,day:1,hour:24,minute:0},
  {year:2026,month:1,day:1,hour:12,minute:60},
  {year:1899,month:1,day:1,hour:12,minute:0},
  {year:2026,month:1,day:1,hour:12,minute:0,tzOffset:25}
]) assert.throws(()=>vm.runInContext(`calculateFourPillars(${JSON.stringify(invalid)})`,context));
assert.equal(evaluate("localToUtcDate({year:2026,month:1,day:15,hour:12,minute:0,tzOffset:5.5}).toISOString()"),'2026-01-15T06:30:00.000Z');
const input={year:2000,month:1,day:15,hour:12,minute:0,tzOffset:0};
const start=evaluate(`calculateLuckStart(${JSON.stringify(input)},'female',calculateFourPillars(${JSON.stringify(input)}).pillars)`);
assert.equal(new Date(start.approxStartUTC).getUTCHours(),12,'UTC+0 must remain UTC+0');

assert.equal(get('panel-health').hidden,true);
assert.equal(get('tab-bazi').getAttribute('aria-selected'),'true');
const initialPillars=get('pillars').innerHTML;
const initialHealth=get('healthOrgans').innerHTML;
assert.equal((initialHealth.match(/class="health-organ"/g)||[]).length,5);
get('tab-health').onclick();
assert.equal(get('panel-bazi').hidden,true);
assert.equal(get('panel-health').hidden,false);
assert.equal(get('tab-health').getAttribute('aria-selected'),'true');
assert.equal(get('pillars').innerHTML,initialPillars,'tab switching must preserve the calculated chart');
let prevented=false;
get('tab-health').onkeydown({key:'ArrowLeft',preventDefault(){prevented=true;}});
assert.ok(prevented);assert.equal(activeElement,get('tab-bazi'));
assert.equal(get('panel-bazi').hidden,false);
get('tab-bazi').onkeydown({key:'End',preventDefault(){}});
assert.equal(activeElement,get('tab-health'));

get('time').value='';get('calc').onclick();
assert.equal(get('results').hidden,true,'invalid input must hide stale results');
assert.equal(get('inputError').hidden,false);
get('sample').onclick();
assert.equal(get('results').hidden,false);
assert.equal(get('inputError').hidden,true);
assert.match(get('inputStatus').textContent,/ตัวอย่างสมมุติ/);
get('year').value='2024';get('month').value='2';get('day').value='31';get('month').onchange();
assert.equal(get('day').value,'29');
get('year').value='2025';get('year').onchange();assert.equal(get('day').value,'28');
get('year').value='1987';get('month').value='10';get('month').onchange();get('day').value='29';get('time').value='22:19';get('calc').onclick();
assert.match(get('pillars').innerHTML,/丁卯/);
assert.match(get('pillars').innerHTML,/辛亥/);
assert.equal(get('elements').innerHTML,get('healthElements').innerHTML);
assert.match(get('healthPattern').textContent,/ไม่ใช้สรุปโรคหรือสั่งการรักษา/);
assert.equal((get('relationSummary').innerHTML.match(/class="rel-group"/g)||[]).length,4);
assert.equal((get('starGroups').innerHTML.match(/class="star-group"/g)||[]).length,5);
assert.doesNotMatch(code,/\b(?:fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB)\b/);
assert.equal((html.match(/role="tab"/g)||[]).length,2);
assert.equal((html.match(/role="tabpanel"/g)||[]).length,2);
assert.doesNotMatch(html,/<script(?![^>]*src=)[^>]*>/);
assert.match(html,/คะแนนธาตุไม่ใช่คะแนนสุขภาพหรือความเสี่ยงโรค/);
assert.match(css,/\[hidden\]\{display:none!important\}/);
assert.match(css,/@media\(max-width:420px\)/);
assert.match(headers,/connect-src 'none'/);
assert.match(headers,/script-src 'self'/);
assert.equal(fs.existsSync(path.join(root,'netlify/functions')),false);
console.log(`BaZi health release verified: ${fixtures.cases.length} independent calendar vectors; date validation; two accessible tabs; five-element health model; no network or storage.`);
