// Generated from knowledge/u-synthesise/landscape.mjs
import {deepFreeze, bagua, mountains} from './u-synthesise-catalog.js';

export const landscapeIdentity = deepFreeze({id:'jin-suo-yu-guan', name:'Jin Suo Yu Guan · 金鎖玉關', version:'1.0.0', scope:'eight_palace_baseline', frame:'magnetic_bearing'});
export const landscapeSources = deepFreeze({
  jinsuo: {title:'靈寶樓 · 風水朴真 三 — 金鎖玉關: 砂、水 และเงื่อนไขรูปทรง', url:'https://lingbaolou.net/风水朴真-三、-2/1068/', kind:'practitioner_exposition', scope:'Eight-palace baseline and form qualifications; later proposed Qi variants are not applied'},
});
export const landscapeKinds = deepFreeze([
  {id:'sha', name:'砂 · ภูเขา / สิ่งสูง', description:'ระบุสิ่งสูงหรือมวลอาคารเมื่อเทียบกับจุดอ้างอิงที่ใช้สำรวจ'},
  {id:'shui', name:'水 · น้ำ / ที่ต่ำ', description:'ระบุแหล่งน้ำหรือที่ต่ำ; ถนนและพื้นที่เปิดเป็นการเทียบเชิงภูมิประเทศ ต้องบันทึกสภาพจริงประกอบ'},
  {id:'mixed', name:'มีทั้ง砂และ水', description:'บันทึกแยกรายสิ่งได้ ไม่หักล้างผลสองชนิดเป็นคะแนนเดียว'},
  {id:'unclassified', name:'ยังจำแนกไม่ได้', description:'เก็บสิ่งที่เห็นก่อน แล้วจึงเลือกประเภท'},
]);
// These are Lo Shu PALACE numbers, never annual Flying Stars or birth numbers.
const fixture = [
  ['N','坎',1,'sha'],['NE','艮',8,'shui'],['E','震',3,'sha'],['SE','巽',4,'sha'],
  ['S','離',9,'shui'],['SW','坤',2,'sha'],['W','兌',7,'shui'],['NW','乾',6,'shui'],
];
export const landscapeRules = deepFreeze(fixture.map(([direction,palace,loShu,prefers])=>{
  const sector=bagua.find(s=>s.direction===direction);
  return {...sector,id:'JSYG-P'+loShu,palace,loShu,prefers,scope:'eight_palace_baseline',sourceIds:['jinsuo']};
}));
const mod=v=>((v%360)+360)%360;
const at=(sectors,d)=>sectors.find(s=>mod(d-s.start)<s.span);
const baseline=(rule,kind)=>['sha','shui'].includes(kind)?(kind===rule.prefers?'favorable':'unfavorable'):kind;
export const baselineText = value=>({favorable:'吉 · เข้ากฎพื้นฐาน',unfavorable:'凶 · สวนกฎพื้นฐาน',mixed:'มีทั้งสองชนิด · อ่านแยก',unclassified:'รอจำแนกสิ่งที่เห็น'}[value]);

export function landscapeRings(){
  return ['sha','shui'].map(kind=>({id:'jinsuo_'+kind,name:kind==='sha'?'พบ砂 · ภูเขา / สิ่งสูง':'พบ水 · น้ำ / ที่ต่ำ',school:landscapeIdentity.name,
    description:'กฎพื้นฐาน 8 วัง: ลั่วซู 1–2–3–4 รับ砂; 6–7–8–9 รับ水 อ่านรูปลักษณ์ประกอบ ยังไม่ใช่คำตัดสินทั้งสถานที่หรือคำทำนายรายบุคคล',sourceIds:['jinsuo'],
    sectors:landscapeRules.map(r=>({...r,label:(kind==='sha'?'砂':'水')+(r.prefers===kind?'吉':'凶'),value:r.name+' · '+r.palace+' ลั่วซู '+r.loShu+' · '+baselineText(baseline(r,kind)),baseline:baseline(r,kind)}))}));
}

export function readLandscape({position,kind='unclassified',uncertaintyDegrees=null,form='unassessed'}={}){
  if(position?.frame!=='magnetic_bearing')throw new TypeError('Landscape requires magnetic_bearing');
  if(typeof position.degrees!=='number'||!Number.isFinite(position.degrees))throw new TypeError('A finite bearing is required');
  if(!landscapeKinds.some(k=>k.id===kind))throw new TypeError('Unknown landscape kind');
  if(!['unassessed','orderly','adverse'].includes(form))throw new TypeError('Unknown landscape form');
  if(uncertaintyDegrees!==null&&(typeof uncertaintyDegrees!=='number'||!Number.isFinite(uncertaintyDegrees)||uncertaintyDegrees<0||uncertaintyDegrees>180))throw new RangeError('Uncertainty must be null or 0–180');
  const degrees=mod(position.degrees),rule=at(landscapeRules,degrees),mountain=at(mountains,degrees);
  const candidates=uncertaintyDegrees===null?null:uncertaintyDegrees===0?[rule]:landscapeRules.filter(s=>Math.abs(mod(degrees-s.center+180)-180)<=uncertaintyDegrees+s.span/2);
  const candidateReadings=(candidates||[rule]).map(r=>({rule:r,baseline:baseline(r,kind)}));
  const crossesPalaces=candidateReadings.length>1;
  const conflicts=new Set(candidateReadings.map(r=>r.baseline)).size>1;
  const value=baseline(rule,kind);
  let status,explanation;
  if(kind==='unclassified'){status='unclassified';explanation='เลือกชนิดสิ่งที่เห็นก่อนอ่านกฎ';}
  else if(kind==='mixed'){status='mixed';explanation='มีทั้ง砂และ水 ให้เพิ่มเป็นคนละรายการเพื่ออ่านกฎของแต่ละสิ่ง';}
  else if(conflicts){status='boundary_ambiguous';explanation='ช่วงคลาดเคลื่อนคร่อมวังที่ให้ผลต่างกัน ยังเลือกผลเดียวไม่ได้';}
  else if(form==='adverse'){status='form_review';explanation='รูปลักษณ์ที่ระบุมีเงื่อนไขขัดเกณฑ์ ต้องพิจารณาร่วม แม้ทิศจะเข้ากฎพื้นฐาน';}
  else if(form==='unassessed'){status='form_unassessed';explanation='ได้เฉพาะกฎทิศ ยังไม่ได้พิจารณารูปลักษณ์';}
  else {status='baseline_only';explanation='อ่านตามกฎทิศและรูปลักษณ์ที่เลือก ยังไม่รวมระยะ ขนาด ทิศตรงข้าม และข้อยกเว้นรายขุนเขา';}
  return {method:landscapeIdentity.id,version:landscapeIdentity.version,position:{frame:'magnetic_bearing',degrees},kind,form,uncertaintyDegrees,rule,mountain,baseline:value,candidateReadings,crossesPalaces,conflicts,status,explanation,sourceIds:['jinsuo'],overallAssessment:'not_evaluated'};
}
