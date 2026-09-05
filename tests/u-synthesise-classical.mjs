import assert from 'node:assert/strict';
import {classicalIdentity, classicalSources, trigrams, mountainDetails, plates, doubleMountains, lifeRing, classicalRings, classicalReading, sectorAt, loShuGrid, heTu, hexagrams, findHexagram, studyGuide} from '../knowledge/u-synthesise/classical.mjs';

const position=degrees=>({frame:'magnetic_bearing',degrees});
const read=(degrees,options)=>classicalReading(position(degrees),options);
const value=(degrees,id)=>read(degrees).readings.find(r=>r.id===id).sector;
assert.equal(classicalRings().length+1,classicalIdentity.scaleCount);
assert.equal(classicalIdentity.scaleCount,14);
assert.equal(mountainDetails.length,24);
assert.equal(new Set(mountainDetails.map(m=>m.symbol)).size,24);
assert.deepEqual(plates.map(p=>p.offset),[0,-7.5,7.5]);
// Independent fixture: offsets must classify the same measured direction differently.
assert.deepEqual([0,7.5,352.5].map(d=>['earth','human','heaven'].map(id=>value(d,id).symbol)),[['子','癸','子'],['癸','癸','子'],['子','子','壬']]);
assert.deepEqual([0,90,180,270].map(d=>value(d,'earth').symbol),['子','卯','午','酉']);
assert.deepEqual([0,90,180,270].map(d=>value(d,'later').symbol),['坎','震','離','兌']);
assert.deepEqual([0,90,180,270].map(d=>value(d,'early').trigram.symbol),['坤','離','乾','坎']);
assert.equal(read(330).facing.symbol,'亥');assert.equal(read(330).sitting.symbol,'巳');
assert.equal(read(180).sittingDegrees,0);assert.equal(read(360).facing.symbol,'子');
assert.equal(read(187.5).facing.symbol,'丁');assert.equal(read(187.4999).facing.symbol,'午');
assert.equal(read(187.5).boundaryDistance,0);assert.equal(read(180).boundaryDistance,7.5);
assert.equal(read(185).deviation,5);
for(const r of classicalRings()){
  assert.equal(r.sectors.reduce((n,s)=>n+s.span,0),360,r.id+' covers a circle');
  for(let degree=0;degree<360;degree+=0.5){
    const matches=r.sectors.filter(s=>((degree-s.start+360)%360)<s.span);
    assert.equal(matches.length,1,r.id+' has exactly one sector at '+degree);
  }
  for(const s of r.sectors){assert.equal(sectorAt(r.sectors,s.center),s);assert.equal(sectorAt(r.sectors,s.start),s);}
  for(const id of r.sourceIds)assert.ok(classicalSources[id]);
}
assert.equal(read(0).readings[0].candidates,null);
assert.equal(read(352.5,{uncertaintyDegrees:0}).readings.find(r=>r.id==='earth').candidates.length,1);
assert.equal(read(352.5,{uncertaintyDegrees:0.1}).readings.find(r=>r.id==='earth').candidates.length,2);
for(const r of read(0,{uncertaintyDegrees:180}).readings)assert.equal(r.candidates.length,classicalRings().find(x=>x.id===r.id).sectors.length);
assert.throws(()=>classicalReading({frame:'true_bearing',degrees:0}),/magnetic/);
for(const d of [NaN,Infinity,'180',null])assert.throws(()=>read(d),/finite/);
for(const u of [-1,181,NaN,'1'])assert.throws(()=>read(0,{uncertaintyDegrees:u}));
const yin='子癸丑卯乙辰午丁未酉辛戌';
const yang='壬艮寅甲巽巳丙坤申庚乾亥';
for(const m of mountainDetails)assert.equal(m.sanYuanPolarity,yin.includes(m.symbol)?'yin':'yang');
assert.equal(mountainDetails.filter(m=>yang.includes(m.symbol)).length,12);
assert.equal(mountainDetails.find(m=>m.symbol==='子').natalPolarity,'yang');
assert.equal(mountainDetails.find(m=>m.symbol==='子').sanYuanPolarity,'yin');
assert.deepEqual(mountainDetails.filter(m=>m.dragon==='heaven').map(m=>m.symbol),[...'子艮卯巽午坤酉乾']);
assert.equal(value(330,'zheng_elements').element,'water');assert.equal(value(330,'palace_elements').element,'metal');
assert.equal(doubleMountains.length,12);assert.equal(sectorAt(doubleMountains,0).symbol,'壬子');
assert.equal(sectorAt(doubleMountains,15).symbol,'癸丑');assert.equal(sectorAt(doubleMountains,15).element,'metal');
// Named yin / yang water-method fixtures: birth, prosperity, storage.
for(const[element,polarity,birth,prosperity,storage]of[
  ['wood','yang','亥','卯','未'],['fire','yang','寅','午','戌'],['metal','yang','巳','酉','丑'],['water','yang','申','子','辰'],
  ['wood','yin','午','寅','戌'],['fire','yin','酉','巳','丑'],['metal','yin','子','申','辰'],['water','yin','卯','亥','未'],
]){
  const rs=lifeRing(element,polarity);assert.equal(new Set(rs.map(s=>s.symbol)).size,12);
  for(const[branch,stage]of[[birth,'長生'],[prosperity,'帝旺'],[storage,'墓']])assert.equal(rs.find(s=>s.branch===branch).symbol,stage,element+' '+polarity+' '+branch);
}
assert.throws(()=>lifeRing('earth'),/Select/);assert.throws(()=>lifeRing('wood','unknown'),/Select/);
assert.deepEqual(loShuGrid,[[6,1,8],[7,5,3],[2,9,4]]);
for(let i=0;i<3;i++){assert.equal(loShuGrid[i].reduce((a,b)=>a+b),15);assert.equal(loShuGrid.reduce((sum,row)=>sum+row[i],0),15);}
assert.equal(loShuGrid[0][0]+loShuGrid[1][1]+loShuGrid[2][2],15);
assert.equal(loShuGrid[0][2]+loShuGrid[1][1]+loShuGrid[2][0],15);
assert.deepEqual(heTu.find(h=>h.direction==='S').pair,[2,7]);assert.deepEqual(heTu.find(h=>h.direction==='C').pair,[5,10]);
assert.equal(hexagrams.length,64);assert.equal(new Set(hexagrams.map(h=>h.yao.join(''))).size,64);
assert.equal(findHexagram('乾','震').number,34);assert.equal(findHexagram('巽','坤').number,46);
assert.equal(findHexagram('離','坎').number,63);assert.equal(findHexagram('坎','離').number,64);
assert.deepEqual(findHexagram('坤','乾').yao,[0,0,0,1,1,1]);
for(const h of hexagrams){assert.equal(h.frame,'catalog_only');assert.ok(h.name&&h.thai);assert.equal(Object.hasOwn(h,'center'),false);}
assert.throws(()=>findHexagram('foo','乾'));
for(const t of trigrams){assert.equal(t.yao.length,3);assert.equal(t.earlyCenter%45,0);assert.equal(t.laterCenter%45,0);}
for(const g of studyGuide)for(const id of g.sourceIds)assert.ok(classicalSources[id]);
assert.equal(read(180).auspiciousness,'not_evaluated');
console.log('Classical Luopan passed: 14 layers, three-plate boundaries, 24 mountain polarity, all 8 life tables, uncertainty, Lo Shu / He Tu, and all 64 distinct hexagrams');
