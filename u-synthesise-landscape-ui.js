import {landscapeIdentity, landscapeSources, landscapeKinds, baselineText, readLandscape} from './u-synthesise-landscape.js';
import {mountains} from './u-synthesise-catalog.js';

export function mountLandscape(document,{onChange,onExplore}={}){
  const q=id=>document.getElementById(id);
  let current=null,origin='manual',featureOrigin='manual',features=[];
  const node=(tag,text,parent,attrs={})=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;for(const[k,v]of Object.entries(attrs))el.setAttribute(k,String(v));parent?.appendChild(el);return el;};
  const source=parent=>{const s=landscapeSources.jinsuo;node('a',s.title,parent,{href:s.url,target:'_blank',rel:'noopener noreferrer',class:'us-reference'});};
  const kindName=id=>landscapeKinds.find(k=>k.id===id).name;
  const formName=id=>({unassessed:'ยังไม่พิจารณารูปลักษณ์',orderly:'ระบุรูปลักษณ์เรียบร้อย',adverse:'ระบุรูปลักษณ์มีเงื่อนไขขัดเกณฑ์'}[id]);
  function renderResult(r,box){
    node('p',r.mountain.symbol+' '+r.mountain.code+' · '+r.rule.name+' '+r.rule.palace+' · ลั่วซู '+r.rule.loShu,box);
    node('strong',r.conflicts?'ช่วงคลาดเคลื่อนคร่อมกฎ · ยังเลือกผลเดียวไม่ได้':baselineText(r.baseline),box,{class:'us-landscape-status','data-status':r.status});
    node('p',r.explanation,box);
    if(r.crossesPalaces)for(const candidate of r.candidateReadings)node('p',candidate.rule.name+' · '+baselineText(candidate.baseline),box,{class:'text-small'});
    node('p',r.uncertaintyDegrees===null?'ความคลาดเคลื่อน: ยังไม่ทราบ':'ความคลาดเคลื่อนที่กรอก: ± '+r.uncertaintyDegrees+'°',box,{class:'text-small'});
    node('p','กฎ '+r.rule.id+' · '+landscapeIdentity.name+' · รุ่น '+r.version+' · ระดับวัง 45°',box,{class:'text-small'});
  }
  function preview(){
    const box=q('us-landscape-result');box.replaceChildren();
    if(!current){node('p','กรอกองศาหรือแตะวงก่อน แล้วเลือกชนิดสิ่งที่พบตามแนวนั้น',box);return;}
    const r=readLandscape({position:current.position,uncertaintyDegrees:current.uncertaintyDegrees,kind:q('us-landscape-kind').value,form:q('us-landscape-form').value});
    node('p',origin==='study'?'ตัวอย่างจากตำแหน่งทดลองบนวง':'อ่านตามองศาที่กรอก',box,{class:'us-eyebrow'});renderResult(r,box);
  }
  function featureList(){
    const box=q('us-feature-list');box.replaceChildren();q('us-feature-count').textContent=features.length+' / 20 รายการ · จุดเลขบนวงอ้างอิงรายการนี้ · อยู่เฉพาะการเปิดหน้าครั้งนี้';
    if(!features.length){node('p','ยังไม่มีรายการสิ่งแวดล้อม',box);return;}
    features.forEach((f,i)=>{
      const card=node('article',undefined,box,{class:'us-mountain-card'});
      const button=node('button',(i+1)+'. '+f.label+' · '+f.result.position.degrees.toFixed(1)+'°',card,{type:'button',class:'us-mountain-button'});button.addEventListener('click',()=>onExplore?.(f.result.position.degrees));
      node('p',kindName(f.result.kind)+' · '+formName(f.result.form),card);
      node('p',f.origin==='study'?'คัดลอกจากเข็มทดลอง':'องศาที่ผู้ใช้กรอก',card,{class:'us-eyebrow'});
      renderResult(f.result,card);if(f.note)node('p',f.note,card);
      const remove=node('button','ลบรายการ '+(i+1),card,{type:'button',class:'btn'});remove.addEventListener('click',()=>{features.splice(i,1);featureList();onChange?.();});
    });
  }
  q('us-landscape-kind').value='unclassified';q('us-landscape-form').value='unassessed';
  q('us-feature-kind').value='unclassified';q('us-feature-shape').value='unassessed';
  q('us-landscape-kind').addEventListener('change',preview);q('us-landscape-form').addEventListener('change',preview);
  const showOrigin=()=>q('us-feature-origin').textContent=featureOrigin==='study'?'ตำแหน่งจากการทดลองบนวง · ใช้เป็นตัวอย่าง':'ตำแหน่งที่ผู้ใช้กรอกเอง';
  q('us-feature-bearing').addEventListener('input',()=>{featureOrigin='manual';q('us-feature-uncertainty').value='';showOrigin();});
  q('us-feature-use-ray').addEventListener('click',()=>{
    if(!current){q('us-feature-error').hidden=false;q('us-feature-error').textContent='ยังไม่มีองศาให้คัดลอก';return;}
    q('us-feature-bearing').value=String(current.position.degrees);q('us-feature-uncertainty').value=current.uncertaintyDegrees===null?'':String(current.uncertaintyDegrees);
    q('us-feature-kind').value=q('us-landscape-kind').value;q('us-feature-shape').value=q('us-landscape-form').value;
    featureOrigin=origin;showOrigin();q('us-feature-error').hidden=true;
  });
  q('us-feature-form').addEventListener('submit',event=>{
    event.preventDefault();
    try{
      if(features.length>=20)throw new Error('ครบ 20 รายการแล้ว ลบรายการที่ไม่ใช้ก่อนเพิ่ม');
      const label=q('us-feature-label').value.trim(),raw=q('us-feature-bearing').value.trim(),degrees=Number(raw),u=q('us-feature-uncertainty').value.trim(),note=q('us-feature-note').value.trim();
      if(!label||label.length>80||note.length>240)throw new Error('กรอกชื่อไม่เกิน 80 ตัวอักษร และหมายเหตุไม่เกิน 240 ตัวอักษร');
      if(!raw||!Number.isFinite(degrees)||degrees<0||degrees>360)throw new Error('กรอกองศาสิ่งที่พบ 0–360');
      const result=readLandscape({position:{frame:'magnetic_bearing',degrees},kind:q('us-feature-kind').value,form:q('us-feature-shape').value,uncertaintyDegrees:u===''?null:Number(u)});
      features.push({label,note,origin:featureOrigin,result});q('us-feature-error').hidden=true;q('us-feature-label').value='';q('us-feature-note').value='';
      featureList();onChange?.();
    }catch(error){q('us-feature-error').hidden=false;q('us-feature-error').textContent=error instanceof RangeError?'กรอกค่าคลาดเคลื่อน 0–180 หรือเว้นว่างไว้':error.message;}
  });
  for(const m of mountains){
    const r=readLandscape({position:{frame:'magnetic_bearing',degrees:m.center},kind:'sha'}),row=node('tr',undefined,q('us-landscape-table'));
    node('th',m.symbol+' '+m.code+' · '+m.center+'° · '+r.rule.palace+' '+r.rule.loShu,row,{scope:'row'});
    const td=node('td',undefined,row);node('div','砂: '+baselineText(r.baseline),td);node('div','水: '+baselineText(r.rule.prefers==='shui'?'favorable':'unfavorable'),td);
  }
  const guide=q('us-landscape-guide');
  for(const k of landscapeKinds){node('h3',k.name,guide);node('p',k.description,guide);}
  node('p','กฎนี้ใช้เลขลั่วซูประจำวังหลังฟ้า: เหนือ 1 · ตะวันออกเฉียงเหนือ 8 · ตะวันออก 3 · ตะวันออกเฉียงใต้ 4 · ใต้ 9 · ตะวันตกเฉียงใต้ 2 · ตะวันตก 7 · ตะวันตกเฉียงเหนือ 6',guide);
  node('p','เริ่มจากจุดสำรวจเดียว → วัดทิศไปยังสิ่งแวดล้อม → จำแนก砂/水 → อ่านวังและรูปลักษณ์ จานดินเป็นพิกัดของชั้นนี้ ไม่ใช้จานคนหรือจานฟ้ามาเลื่อนกฎ',guide);
  node('p','ขอบเขตฉบับนี้: กฎพื้นฐาน 8 วังเทียบ 24 ขุนเขา ไม่รวมบทพยากรณ์รายขุนเขา รูปทรงเฉพาะทุกชนิด สูตรแก้ฮวงจุ้ย หรือการให้คะแนนรวม ยังไม่แปลงข้อมูลนี้เป็นโรค ธาตุเจ้าเรือน หรือคำสั่งรักษา',guide);
  source(guide);showOrigin();featureList();preview();
  return {get features(){return features.slice();},update(reading,nextOrigin){current=reading;origin=nextOrigin;preview();}};
}
