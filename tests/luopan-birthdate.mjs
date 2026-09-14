import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=name=>fs.readFileSync(path.join(root,name),'utf8');
const shell=read('luopan.html');
const html=read('luopan-wheel.html');
const allScriptNames=[...html.matchAll(/<script\b[^>]*src="([^"]+)"[^>]*>/g)].map(m=>m[1].split('?')[0]);
assert.deepEqual(allScriptNames,['luopan-frame-guard.js','luopan-knowledge.js','luopan-astronomy.js','luopan.js','u-synthesise.js']);
assert.match(html,/<script type="module" src="u-synthesise\.js/);
const scriptNames=allScriptNames.slice(1,4);
assert.doesNotMatch(html,/<script(?![^>]*\bsrc=)[^>]*>|\son[a-z]+\s*=/i);
assert.match(html,/Luopan 360° v1\.0\.0/);
assert.match(html,/23 ชั้น/);
assert.match(read('foundation.html'),/href="\/luopan\.html"/);
assert.match(read('_redirects'),/^\/luopan\s+\/luopan\.html\s+301!$/m);
assert.match(shell,/data-page="luopan"/);
assert.match(shell,/data-src="\/luopan-wheel\.html"/);
assert.doesNotMatch(shell,/<iframe[^>]+\ssrc=/i,'wheel must not load before authentication');
assert.match(shell,/luopan-auth\.js/);
assert.match(read('app-shell.js'),/key: 'luopan'[\s\S]*?capability: 'luopan_read'/);
assert.match(read('luopan-auth.js'),/getSession\(\)[\s\S]*?location\.replace\('\/login\.html'\)[\s\S]*?runtime\.can\(profile, 'luopan_read'\)[\s\S]*?frame\.src = frame\.dataset\.src/);
assert.match(read('luopan-frame-guard.js'),/window\.parent\.location\.origin === location\.origin/);
assert.doesNotMatch(read('luopan.js'),/fetch\s*\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage|supabase|window\.openai/i);
assert.doesNotMatch(html,/<iframe\b|srcdoc=/i);
for(const script of scriptNames)assert.doesNotThrow(()=>new vm.Script(read(script),{filename:script}));

async function runAuth(session){
  const frame={dataset:{src:'/luopan-wheel.html'},src:''};
  const elements={
    '#luopan-frame':frame,
    '#app':{classList:{remove(value){this.removed=value;}}},
    '#boot':{classList:{add(value){this.added=value;}}},
    '#boot-error':{textContent:''},
    '#logout':{addEventListener(){}}
  };
  let destination=null,mounted=null;
  const location={replace(value){destination=value;}};
  const window={
    ChananyaRuntime:{
      getDb(){return {auth:{async signOut(){}}};},
      async getSession(){return session;},
      async getProfile(){return session?{access_context_ready:true}:null;},
      can(_profile,capability){return capability==='luopan_read';}
    },
    ChananyaShell:{mount(input){mounted=input;}}
  };
  vm.runInNewContext(read('luopan-auth.js'),{window,document:{querySelector:selector=>elements[selector]},location,console});
  await new Promise(resolve=>setImmediate(resolve));
  return {destination,mounted,frame,elements};
}

const signedOut=await runAuth(null);
assert.equal(signedOut.destination,'/login.html');
assert.equal(signedOut.frame.src,'','signed-out users must not load the wheel frame');
const signedIn=await runAuth({user:{id:'user-1',email:'owner@example.test'}});
assert.equal(signedIn.destination,null);
assert.equal(signedIn.mounted.active,'luopan');
assert.equal(signedIn.frame.src,'/luopan-wheel.html');
assert.equal(signedIn.elements['#app'].classList.removed,'hidden');
assert.equal(signedIn.elements['#boot'].classList.added,'hidden');

class Element{
  constructor(tag='div'){this.localName=tag;this.attrs={};this.children=[];this.events={};this.textContent='';this.value='';this.hidden=true;this.capture=false;}
  setAttribute(key,value){this.attrs[key]=String(value);}
  appendChild(child){this.children.push(child);child.parent=this;return child;}
  append(...children){children.forEach(child=>this.appendChild(child));}
  replaceChildren(...children){this.children=[];this.append(...children);}
  addEventListener(type,listener){this.events[type]=listener;}
  remove(){this.parent.children.splice(this.parent.children.indexOf(this),1);}
  getBBox(){return {width:[...this.textContent].reduce((n,c)=>n+(/[\u0e31\u0e34-\u0e3a\u0e47-\u0e4e]/.test(c)?0:7),0),height:16};}
  setPointerCapture(){this.capture=true;}
  hasPointerCapture(){return this.capture;}
  releasePointerCapture(){this.capture=false;}
  allText(){return this.textContent+this.children.map(child=>child.allText()).join(' ');}
}

for(const width of [736,360]){
  const ids=Object.fromEntries([...html.matchAll(/\bid="(lr-[^"]+)"/g)].map(m=>[m[1],new Element(m[1]==='lr-svg'?'svg':'div')]));
  assert.equal(Object.keys(ids).length,[...html.matchAll(/\bid="(lr-[^"]+)"/g)].length,'IDs must be unique');
  ids['lr-birth'].value='29/10/2530 22.19';ids['lr-tz'].value='7';ids['lr-boundary'].value='00';
  const fragmentRoot=new Element();
  fragmentRoot.querySelector=selector=>{const element=ids[selector.slice(1)];assert.ok(element,'Missing '+selector);return element;};
  fragmentRoot.getBoundingClientRect=()=>({width});ids['lr-svg'].getBoundingClientRect=()=>({width,left:0,top:0});
  const document={getElementById:id=>{assert.equal(id,'luopan-birthdate-ray');return fragmentRoot;},createElement:tag=>new Element(tag),createElementNS:(_,tag)=>new Element(tag)};
  const context=vm.createContext({document,Date,ResizeObserver:class{observe(){}},requestAnimationFrame:callback=>{callback();return 1;},cancelAnimationFrame(){}});
  context.window=context;
  for(const name of scriptNames)vm.runInContext(read(name),context,{filename:name});
  assert.equal(ids['lr-error'].hidden,true,ids['lr-error'].textContent);
  assert.match(ids['lr-natal'].textContent,/ปิตตะ/);
  assert.match(ids['lr-pillars'].textContent,/ปี 丁卯.*เดือน 庚戌.*วัน 辛亥.*ยาม 己亥/);
  assert.equal(ids['lr-all'].children.length,23);
  assert.match(ids['lr-profile'].allText(),/รอสถานที่เกิด/);
  const paths=ids['lr-svg'].children.filter(e=>e.localName==='path');
  assert.equal(new Set(paths.map(e=>e.attrs['data-layer'])).size,23);
  assert.ok(paths.every(e=>e.children.some(c=>c.localName==='title')),'Native SVG hover titles must survive standalone export');
  assert.ok(!paths.some(e=>/NaN|undefined/.test(e.attrs.d)));
  const initial=ids['lr-quick'].allText(),birth=ids['lr-birth'].value;
  ids['lr-svg'].events.pointerdown({pointerId:1,clientX:width-10,clientY:width/2});
  ids['lr-svg'].events.pointerup({pointerId:1});
  assert.notEqual(ids['lr-quick'].allText(),initial);assert.equal(ids['lr-birth'].value,birth);
  assert.match(ids['lr-state'].textContent,/ข้อมูลกำเนิดคงเดิม/);
  ids['lr-home'].events.click();assert.equal(ids['lr-quick'].allText(),initial);
  ids['lr-bangkok'].events.click();assert.match(ids['lr-profile'].allText(),/มิถุน|เมถุน/);
  assert.doesNotMatch(ids['lr-profile'].allText(),/รอสถานที่เกิด/);
  const submit=value=>{ids['lr-birth'].value=value;ids['lr-form'].events.submit({preventDefault(){}});};
  for(const [time,kala]of [['01:59','ปิตตะ'],['02:00','วาตะ'],['05:59','วาตะ'],['06:00','เสมหะ'],['09:59','เสมหะ'],['10:00','ปิตตะ'],['13:59','ปิตตะ'],['14:00','วาตะ'],['17:59','วาตะ'],['18:00','เสมหะ'],['21:59','เสมหะ'],['22:00','ปิตตะ']]){
    submit('29/10/2530 '+time);assert.equal(ids['lr-error'].hidden,true);assert.ok(ids['lr-natal'].textContent.includes(kala),time+' '+kala);
  }
  for(const invalid of ['31/04/2530 22:19','29/02/2530 22:19','29/10/2530 24:00','29/10/2530 22:60']){submit(invalid);assert.equal(ids['lr-error'].hidden,false,invalid);}
  submit('29/02/2567 22:19');assert.equal(ids['lr-error'].hidden,true);
  submit('29/10/1987 22:19');assert.equal(ids['lr-error'].hidden,true);assert.match(ids['lr-pillars'].textContent,/辛亥/);
}
console.log('Authenticated Luopan contract passed: login gate, 23 layers, pinned browser scripts, local-only input, birthdate/drag/house behavior and Kala boundaries');
