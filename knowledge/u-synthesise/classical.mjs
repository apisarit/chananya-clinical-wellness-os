import {deepFreeze, mountains, bagua, branches, stems, elements} from './catalog.mjs';
import {landscapeRings, landscapeSources} from './landscape.mjs';

// A sourced study atlas. Ring membership never assigns a fortune or medical result.
export const classicalIdentity = deepFreeze({version: '1.1.1', name: 'หล่อแกดั้งเดิม', frame: 'magnetic_bearing', north: 0, clockwise: true, boundary: '[start,end)', scaleCount: 16});
export const classicalSources = deepFreeze({
  ...landscapeSources,
  compass: {title: 'Feng Shui Natural — 24 Mountains and facing / sitting', url: 'https://www.fengshuinatural.com/en/fengshuicompass.htm', kind: 'practitioner'},
  plates: {title: 'Evelyn Escarfullery / FORMOSA Art — Three plates and schools', url: 'https://www.formosa-art.com/feng-shui-knowledge/feng-shui-blog/evelyn-escarfullery/', kind: 'practitioner'},
  shuoGua: {title: '周易 · 說卦傳 — ปากว้าและภาพแทนตามคัมภีร์', url: 'https://www.chineseclassic.com/content/196', kind: 'classical_text'},
  early: {title: '易學網 — ผังปากว้าก่อนฟ้าตามเส้ายง', url: 'https://www.eee-learning.com/article/5480', kind: 'scholarly_exposition'},
  hetu: {title: '周易數 · 河圖洛書論 — เหอถูและลั่วซู', url: 'https://www.eee-learning.com/book/6256', kind: 'classical_text'},
  sanyuan: {title: '劉燮鈞 — 二十四山三元龍及運用', url: 'https://www.cafengshuinet.com/m/show_detail.php?id=2781', kind: 'practitioner'},
  sanhe: {title: '劉啟治 / 聚賢館 — 雙山 และ 十二長生', url: 'https://www.juxian.com.hk/fs005/', kind: 'practitioner'},
  hexagrams: {title: '易學網 — ตารางข่วยบน × ข่วยล่าง 64 ข่วย', url: 'https://www.eee-learning.com/content/4', kind: 'classical_table'},
  tuan: {title: '周易 · 彖傳 — ความหมายภาพรวมของข่วย', url: 'https://zh.wikisource.org/wiki/周易/彖', kind: 'classical_text'},
  calendar: {title: 'Hong Kong Observatory — ก้านฟ้าและกิ่งดิน', url: 'https://www.hko.gov.hk/en/gts/time/stemsandbranches.htm', kind: 'calendar'},
});

const mod = (v, n = 360) => ((v % n) + n) % n;
export const elementName = id => elements.find(e => e.id === id)?.name || id;
export const polarityName = id => id === 'yang' ? 'หยาง' : 'หยิน';
const sounds = '壬:เหริน:Rén 子:จื่อ:Zǐ 癸:กุ่ย:Guǐ 丑:โฉ่ว:Chǒu 艮:เกิ้น:Gèn 寅:อิ๋น:Yín 甲:เจี่ย:Jiǎ 卯:เหม่า:Mǎo 乙:อี่:Yǐ 辰:เฉิน:Chén 巽:ซวิ่น:Xùn 巳:ซื่อ:Sì 丙:ปิ่ง:Bǐng 午:อู่:Wǔ 丁:ติง:Dīng 未:เว่ย:Wèi 坤:คุน:Kūn 申:เซิน:Shēn 庚:เกิง:Gēng 酉:โหย่ว:Yǒu 辛:ซิน:Xīn 戌:ซวี:Xū 乾:เฉียน:Qián 亥:ไฮ่:Hài';
const pronunciation = Object.fromEntries(sounds.split(' ').map(x => {const [symbol, thai, pinyin] = x.split(':'); return [symbol, {thai, pinyin}];}));

// Yao arrays run from the bottom line to the top line: 1 = yang, 0 = yin.
export const trigrams = deepFreeze([
  ['乾','☰','เฉียน','Qián','ฟ้า','พ่อ','ความแข็งแรงและการเริ่มต้น','metal',1,6,180,315,[1,1,1]],
  ['兌','☱','ตุ้ย','Duì','หนองน้ำ','ลูกสาวคนเล็ก','ความยินดีและการแลกเปลี่ยน','metal',2,7,135,270,[1,1,0]],
  ['離','☲','หลี','Lí','ไฟ','ลูกสาวคนกลาง','ความสว่างและการเกาะเกี่ยว','fire',3,9,90,180,[1,0,1]],
  ['震','☳','เจิ้น','Zhèn','ฟ้าร้อง','ลูกชายคนโต','การเคลื่อนไหวและการเริ่มผลิ','wood',4,3,45,90,[1,0,0]],
  ['巽','☴','ซวิ่น','Xùn','ลม','ลูกสาวคนโต','การแทรกซึมและการกระจาย','wood',5,4,225,135,[0,1,1]],
  ['坎','☵','ขั่น','Kǎn','น้ำ','ลูกชายคนกลาง','ความลึกและการผ่านอุปสรรค','water',6,1,270,0,[0,1,0]],
  ['艮','☶','เกิ้น','Gèn','ภูเขา','ลูกชายคนเล็ก','การหยุดและการตั้งขอบเขต','earth',7,8,315,45,[0,0,1]],
  ['坤','☷','คุน','Kūn','ดิน','แม่','การรองรับและการหล่อเลี้ยง','earth',8,2,0,225,[0,0,0]],
].map(([symbol,glyph,thai,pinyin,image,family,theme,element,earlyNumber,loShu,earlyCenter,laterCenter,yao]) => ({symbol,glyph,thai,pinyin,image,family,theme,element,earlyNumber,loShu,earlyCenter,laterCenter,yao,sourceIds:['shuoGua','early','hetu']})));

export const mountainDetails = deepFreeze(mountains.map((m, i) => {
  const palace = bagua[Math.floor(i / 3)];
  const branch = branches.find(b => b.symbol === m.symbol), stem = stems.find(s => s.symbol === m.symbol);
  const trigram = trigrams.find(t => t.symbol === m.symbol);
  const sanYuanPolarity = Math.floor(i / 3) % 2 === 0 ? (i % 3 === 0 ? 'yang' : 'yin') : (i % 3 === 0 ? 'yin' : 'yang');
  return {...m, ...pronunciation[m.symbol], animal: branch?.animal || null,
    element: (branch || stem || trigram).element, natalPolarity: (branch || stem)?.polarity || null,
    dragon: ['earth','heaven','human'][i % 3], dragonName: ['ตี้หยวน · 地元','เทียนหยวน · 天元','เหรินหยวน · 人元'][i % 3],
    sanYuanPolarity, palace, oppositeSymbol: mountains[(i + 12) % 24].symbol,
    sourceIds: ['compass','sanyuan','calendar'],
  };
}));

export const plates = deepFreeze([
  {id:'earth', name:'จานดิน · 地盤正針', short:'地盤', offset:0, use:'ฐาน 24 ขุนเขาสำหรับระบุแนวนั่ง–หันและทิศที่วัด', sourceIds:['compass','plates']},
  {id:'human', name:'จานคน · 人盤中針', short:'人盤', offset:-7.5, use:'วงอ้างอิงการพิจารณาทราย–ภูเขาแวดล้อมในสายซาฮะ', sourceIds:['plates']},
  {id:'heaven', name:'จานฟ้า · 天盤縫針', short:'天盤', offset:7.5, use:'วงอ้างอิงทางน้ำและน้ำเข้า–ออกในสายซาฮะ', sourceIds:['plates','sanhe']},
].map(p => ({...p, sectors: mountainDetails.map(m => ({...m, start:mod(m.start+p.offset), center:mod(m.center+p.offset), plate:p.id}))})));

export const doubleMountains = deepFreeze(Array.from({length:12}, (_, i) => {
  const first = plates[2].sectors[i*2], second = plates[2].sectors[i*2+1];
  return {symbol:first.symbol+second.symbol, center:mod(first.start+15), start:first.start, span:30,
    element:['water','metal','fire','wood'][i%4], branch:branches[i].symbol, branchIndex:i, plate:'heaven', sourceIds:['sanhe','plates']};
}));
export const lifeStages = deepFreeze([
  ['長生','ฉางเซิง','เริ่มเกิด'],['沐浴','มู่อวี้','อาบชำระ'],['冠帶','กวนไต้','เติบโตสวม冠帶'],['臨官','หลินกวน','เข้ารับหน้าที่'],
  ['帝旺','ตี้วั่ง','เต็มกำลัง'],['衰','ซวย','กำลังลด'],['病','ปิ้ง','อ่อนกำลัง'],['死','สื่อ','สิ้นช่วง'],
  ['墓','มู่','เก็บสะสม'],['絕','เจวี๋ย','ขาดตอน'],['胎','ไท','ก่อรูป'],['養','หย่าง','บำรุงเลี้ยง'],
].map(([symbol,thai,meaning])=>({symbol,thai,meaning})));
export function lifeRing(element='water', polarity='yang') {
  const starts={wood:{yang:11,yin:6},fire:{yang:2,yin:9},metal:{yang:5,yin:0},water:{yang:8,yin:3}};
  if(!Object.hasOwn(starts,element)||!['yang','yin'].includes(polarity)) throw new TypeError('Select a named water-method element and polarity');
  return doubleMountains.map(pair=>({...pair,...lifeStages[mod((pair.branchIndex-starts[element][polarity])*(polarity==='yang'?1:-1),12)], pair:pair.symbol, element, polarity}));
}

const octants = (pick) => bagua.map((sector,i)=>({...sector,...pick(sector,i)}));
const ring = (id,name,school,description,sourceIds,sectors) => ({id,name,school,description,sourceIds,sectors});
export function classicalRings({lifeElement='water',lifePolarity='yang'}={}) {
  return [
    ring('directions','8 ทิศ · 八方','ฐานร่วม','เหนือ 0° ตะวันออก 90° ใต้ 180° ตะวันตก 270° หน้าปัดอ้างเหนือแม่เหล็กและเพิ่มองศาตามเข็มนาฬิกา',['compass'],octants(s=>({label:s.direction,value:s.name}))),
    ring('later','ปากว้าหลังฟ้า · 後天八卦','ฐานร่วม','ข่วยประจำทิศตามผังหลังฟ้า ใช้อ่านคู่กับลั่วซูและธาตุของวัง',['shuoGua','compass'],octants(s=>{const t=trigrams.find(t=>t.symbol===s.symbol);return {label:t.symbol,value:t.glyph+' '+t.thai+' · '+t.image+' · '+t.family,trigram:t};})),
    ring('early','ปากว้าก่อนฟ้า · 先天八卦','ผังเส้ายง','ผังความสัมพันธ์ก่อนฟ้า: เฉียนอยู่ใต้ คุนอยู่เหนือ ตำแหน่งคงที่ของผังนี้ต่างจากหลังฟ้า เลขกำกับเป็นลำดับก่อนฟ้า',['early'],octants(s=>{const t=trigrams.find(t=>t.earlyCenter===s.center);return {symbol:t.symbol,element:t.element,label:t.symbol,value:t.glyph+' '+t.thai+' · เลขก่อนฟ้า '+t.earlyNumber,trigram:t};})),
    ring('loshu','ลั่วซู · 洛書九宮','ฐานร่วม','เลขประจำ 8 วังและเลข 5 ที่ศูนย์กลาง เป็นผังฐาน ไม่ใช่ดาวจรประจำปีหรือผังดาวเหินอาคาร',['compass','hetu'],octants(s=>{const t=trigrams.find(t=>t.symbol===s.symbol);return {label:String(t.loShu),value:t.loShu+' · วัง'+t.thai+' · ธาตุ'+elementName(t.element)};})),
    ring('palace_elements','ธาตุปากว้า · 八卦五行','ฐานร่วม','ธาตุประจำวังหลังฟ้า 45° ต่อวัง แยกจากธาตุรายขุนเขา 15° และธาตุของคู่ซวงซาน',['hetu','compass'],octants(s=>({label:elements.find(e=>e.id===s.element).symbol,value:'วัง'+s.symbol+' · ธาตุ'+elementName(s.element),element:s.element}))),
    ...plates.map(p=>ring(p.id,p.name,p.id==='earth'?'ฐานร่วม':'ซาฮะ · 三合',p.use+' · ตำแหน่งชื่อขุนเขาเลื่อน '+(p.offset>0?'+':'')+p.offset+'° จากจานดิน การเลื่อนนี้เป็นเกณฑ์จาน ไม่ใช่ค่าชดเชยเหนือจริง',['plates',...(p.id==='earth'?['compass']:[])],p.sectors.map(s=>({...s,label:s.symbol,value:s.symbol+' '+s.thai+' · '+s.pinyin+' · '+s.code})))),
    ring('zheng_elements','ธาตุขุนเขา · 正五行','ฐานร่วม','ธาตุของก้านฟ้า กิ่งดิน หรือข่วยที่เป็นขุนเขานั้น เช่น 亥 เป็นน้ำ แม้อยู่ในวัง乾ซึ่งเป็นทอง',['calendar','hetu'],mountainDetails.map(m=>({...m,label:elements.find(e=>e.id===m.element).symbol,value:m.symbol+' · ธาตุ'+elementName(m.element)}))),
    ring('dragons','สามหยวนมังกร · 三元龍','ซานหยวน · 三元','แต่ละวังมี 3 ขุนเขา เรียงเป็นตี้หยวน–เทียนหยวน–เหรินหยวน เป็นการจัดกลุ่มขุนเขา ไม่ใช่จานดิน–ฟ้า–คนสามวง',['sanyuan'],mountainDetails.map(m=>({...m,label:{earth:'地',heaven:'天',human:'人'}[m.dragon],value:m.symbol+' · '+m.dragonName}))),
    ring('mountain_polarity','หยิน–หยางขุนเขา · 三元陰陽','ซานหยวน · 三元','เกณฑ์ซานหยวน: 子午卯酉 เป็นหยิน และ 寅申巳亥 เป็นหยาง จึงห้ามยกหยิน–หยางกิ่งดิน BaZi มาแทน',['sanyuan'],mountainDetails.map(m=>({...m,label:m.sanYuanPolarity==='yang'?'陽':'陰',value:m.symbol+' · '+polarityName(m.sanYuanPolarity)+' ตามซานหยวน'}))),
    ring('double','คู่ขุนเขา · 天盤雙山','ซาฮะ · 三合','จับคู่บนจานฟ้าเป็น 12 ช่อง ช่องละ 30° ธาตุซาฮะตามกลุ่ม申子辰น้ำ・亥卯未ไม้・寅午戌ไฟ・巳酉丑ทอง เช่น 癸丑 เป็นทองตามเกณฑ์นี้',['sanhe','plates'],doubleMountains.map(p=>({...p,label:p.symbol,value:p.symbol+' · ซาฮะธาตุ'+elementName(p.element)}))),
    ...landscapeRings(),
    ring('life','12 ระยะฉางเซิง · 十二長生','ซาฮะ · ตารางศึกษา','แสดงตามธาตุและหยิน/หยางที่ผู้ใช้เลือก: หยางเรียงไปข้างหน้า หยินย้อนกลับ ชื่อ病・死เป็นชื่อระยะตามตำรา ยังไม่ใช้วินิจฉัยคนหรือฟันธงน้ำเข้า–ออก',['sanhe'],lifeRing(lifeElement,lifePolarity).map(s=>({...s,label:s.symbol,value:s.symbol+' '+s.thai+' · '+s.meaning+' · คู่ '+s.pair+' · ธาตุ'+elementName(lifeElement)+' '+polarityName(lifePolarity)}))),
  ];
}
export const ringPresets = deepFreeze({
  core:{name:'แกนหลัก',ids:['directions','later','early','loshu','earth','zheng_elements']},
  sanhe:{name:'ซาฮะ · สามจาน',ids:['directions','earth','human','heaven','double','life']},
  sanyuan:{name:'ซานหยวน · ปากว้า',ids:['directions','early','later','loshu','earth','dragons','mountain_polarity']},
  jinsuo:{name:'ภูมิประเทศ–น้ำ · 金鎖玉關',ids:['directions','later','loshu','earth','jinsuo_sha','jinsuo_shui']},
  all:{name:'ครบ 16 ชั้น',ids:classicalRings().map(r=>r.id)},
});

export function sectorAt(sectors, degrees) {
  if(typeof degrees!=='number'||!Number.isFinite(degrees)) throw new TypeError('A finite bearing is required');
  return sectors.find(s=>mod(degrees-s.start)<s.span);
}
export function classicalReading(position, {uncertaintyDegrees=null,...options}={}) {
  if(position?.frame!=='magnetic_bearing') throw new TypeError('Classical compass requires an explicit magnetic bearing');
  if(typeof position.degrees!=='number'||!Number.isFinite(position.degrees)) throw new TypeError('A finite bearing is required');
  if(uncertaintyDegrees!==null&&(!Number.isFinite(uncertaintyDegrees)||uncertaintyDegrees<0||uncertaintyDegrees>180)) throw new RangeError('Uncertainty must be null or 0–180');
  const degrees=mod(position.degrees), rings=classicalRings(options);
  if(!Number.isFinite(degrees)) throw new TypeError('A finite bearing is required');
  const readings=rings.map(r=>({id:r.id,sector:sectorAt(r.sectors,degrees),candidates:uncertaintyDegrees===null?null:uncertaintyDegrees===0?[sectorAt(r.sectors,degrees)]:r.sectors.filter(s=>Math.abs(mod(degrees-s.center+180)-180)<=uncertaintyDegrees+s.span/2)}));
  const facing=sectorAt(mountainDetails,degrees), sitting=sectorAt(mountainDetails,mod(degrees+180));
  const deviation=mod(degrees-facing.center+180)-180;
  return {degrees,facing,sitting,sittingDegrees:mod(degrees+180),deviation,boundaryDistance:7.5-Math.abs(deviation),readings,auspiciousness:'not_evaluated'};
}

// North-up tables match the compass on this page; many printed classics use south-up.
export const loShuGrid = deepFreeze([[6,1,8],[7,5,3],[2,9,4]]);
export const heTu = deepFreeze([
  {direction:'N',name:'เหนือ',pair:[1,6],element:'water'}, {direction:'E',name:'ตะวันออก',pair:[3,8],element:'wood'},
  {direction:'S',name:'ใต้',pair:[2,7],element:'fire'}, {direction:'W',name:'ตะวันตก',pair:[4,9],element:'metal'},
  {direction:'C',name:'กลาง',pair:[5,10],element:'earth'},
]);

// Rows = lower / inner; columns = upper / outer, both in Qian,Dui,Li,Zhen,Xun,Kan,Gen,Kun order.
export const hexagramMatrix = deepFreeze([
  [1,43,14,34,9,5,26,11],[10,58,38,54,61,60,41,19],[13,49,30,55,37,63,22,36],[25,17,21,51,42,3,27,24],
  [44,28,50,32,57,48,18,46],[6,47,64,40,59,29,4,7],[33,31,56,62,53,39,52,15],[12,45,35,16,20,8,23,2],
]);
const hexNames='乾|坤|屯|蒙|需|訟|師|比|小畜|履|泰|否|同人|大有|謙|豫|隨|蠱|臨|觀|噬嗑|賁|剝|復|無妄|大畜|頤|大過|坎|離|咸|恆|遯|大壯|晉|明夷|家人|睽|蹇|解|損|益|夬|姤|萃|升|困|井|革|鼎|震|艮|漸|歸妹|豐|旅|巽|兌|渙|節|中孚|小過|既濟|未濟'.split('|');
const hexThai='พลังสร้างสรรค์|การรองรับ|ความยากในระยะเริ่ม|ความเยาว์และการเรียนรู้|การรอคอย|ข้อพิพาท|กองทัพและระเบียบ|การร่วมกลุ่ม|การสะสมเล็กน้อย|การย่างก้าว|ความราบรื่น|ความติดขัด|ความร่วมใจ|การครอบครองมาก|ความถ่อมตน|ความพร้อมและความยินดี|การตาม|การแก้สิ่งเสื่อม|การเข้าใกล้|การพิจารณา|การขจัดสิ่งกีดขวาง|การตกแต่ง|การสึกกร่อน|การกลับคืน|ความไม่เสแสร้ง|การสะสมกำลังมาก|การหล่อเลี้ยง|ภาระที่มากเกิน|ห้วงลึกและอุปสรรค|ความสว่าง|การตอบสนองต่อกัน|ความสม่ำเสมอ|การถอย|กำลังอันมาก|ความก้าวหน้า|แสงที่ถูกบดบัง|ครอบครัว|ความแตกต่าง|อุปสรรคในการเดิน|การคลี่คลาย|การลด|การเพิ่ม|การตัดสิน|การพบ|การรวมตัว|การขึ้นสู่|ความคับข้อง|บ่อน้ำ|การเปลี่ยนแปลง|ภาชนะหลอมรวม|การสะเทือน|การหยุด|ความค่อยเป็นค่อยไป|การเข้าสู่ความสัมพันธ์|ความอุดม|การเดินทาง|การแทรกซึม|ความยินดี|การกระจาย|การกำหนดขอบเขต|ความจริงใจภายใน|การเกินเล็กน้อย|สำเร็จแล้ว|ยังไม่สำเร็จ'.split('|');
// Original, concise Thai study interpretations of the public-domain Tuan text.
// These describe the selected figure; they are not a cast, changing-line reading or bearing prediction.
const hexMeanings = {
  1: 'พลังริเริ่มและความมุ่งมั่น ใช้กำลังอย่างมีวินัยและเลือกจังหวะลงมือให้เหมาะ',
  2: 'ความอ่อนโยนที่รองรับและหล่อเลี้ยง รับฟัง ร่วมมือ และทำหน้าที่อย่างมั่นคง',
  3: 'การเริ่มต้นท่ามกลางความยุ่งยาก ค่อยวางรากฐานและหาผู้ช่วยก่อนขยายงาน',
  4: 'ความไม่รู้ที่เปิดทางให้เรียนรู้ ยอมรับข้อจำกัดและขอคำชี้แนะด้วยความตั้งใจ',
  5: 'รอเมื่อข้างหน้ายังมีความเสี่ยง เตรียมตัวให้พร้อมและรักษาความเชื่อมั่น',
  6: 'ความเห็นต่างอาจกลายเป็นข้อพิพาท หาข้อยุติที่เป็นธรรมก่อนความขัดแย้งบานปลาย',
  7: 'การรวมกำลังต้องมีระเบียบและผู้นำที่รับผิดชอบ ใช้อำนาจเพื่อประโยชน์ส่วนรวม',
  8: 'การร่วมกลุ่มด้วยความไว้วางใจ เลือกผู้ร่วมทางที่มีหลักและเป้าหมายสอดคล้องกัน',
  9: 'กำลังยังเหมาะกับการสะสมทีละน้อย เก็บรายละเอียดและค่อยสร้างความพร้อม',
  10: 'ก้าวผ่านสถานการณ์ละเอียดอ่อนด้วยความระมัดระวัง รู้ขอบเขตและวางตนให้เหมาะ',
  11: 'ความร่วมมือเปิดทางให้สิ่งต่าง ๆ ไหลคล่อง ใช้โอกาสนี้สร้างความสมดุลร่วมกัน',
  12: 'การสื่อสารและความร่วมมือติดขัด รักษาหลักของตนและทบทวนจังหวะเดินหน้า',
  13: 'ผู้คนร่วมมือกันได้ด้วยเป้าหมายที่เปิดกว้าง มองประโยชน์ร่วมเหนือพวกพ้อง',
  14: 'มีทรัพยากรหรือความสามารถมาก จัดการอย่างรู้คุณค่าและรับผิดชอบต่อผู้อื่น',
  15: 'ความถ่อมตนช่วยรักษาสมดุล ยอมรับทั้งจุดแข็งของตนและคุณค่าของผู้อื่น',
  16: 'ความยินดีสร้างแรงพร้อมใจ จัดเตรียมให้ดีแล้วเปลี่ยนแรงกระตุ้นเป็นการลงมือ',
  17: 'ปรับตัวตามจังหวะและผู้ที่ควรเรียนรู้ ยืดหยุ่นโดยยังยึดหลักที่ถูกต้อง',
  18: 'สิ่งที่ปล่อยค้างจนเสื่อมต้องได้รับการแก้ไข มองต้นเหตุและติดตามผลให้ต่อเนื่อง',
  19: 'เข้าใกล้เพื่อดูแลและส่งเสริมการเติบโต ใช้ช่วงเอื้ออำนวยโดยตระหนักถึงการเปลี่ยนผ่าน',
  20: 'หยุดมองภาพรวมและทบทวนตนเอง สังเกตให้เข้าใจก่อนตัดสินใจหรือเป็นแบบอย่าง',
  21: 'มีสิ่งกีดขวางที่ต้องจัดการตรงจุด ใช้ความชัดเจนและความเป็นธรรมในการแก้ปัญหา',
  22: 'รูปแบบที่งามช่วยสื่อคุณค่า จัดสิ่งภายนอกให้เหมาะโดยรักษาเนื้อหาที่แท้จริง',
  23: 'ฐานเดิมกำลังสึกกร่อน ประคองสิ่งสำคัญและชะลอการขยายจนกว่าจะมั่นคง',
  24: 'พลังเริ่มกลับคืนหลังช่วงถดถอย กลับสู่หลักที่ดีและเริ่มใหม่ทีละก้าว',
  25: 'ความจริงใจและการกระทำที่ตรงหลัก วางเจตนาให้บริสุทธิ์และไม่ฝืนสิ่งที่ไม่เหมาะ',
  26: 'สะสมความรู้และกำลังด้วยการยับยั้งตน ฝึกฝนให้พร้อมก่อนรับงานใหญ่',
  27: 'สิ่งที่หล่อเลี้ยงย่อมส่งผลต่อการเติบโต พิจารณาว่ากำลังรับและส่งต่ออะไร',
  28: 'ภาระมากจนฐานรับไม่ไหว ทบทวนโครงสร้างและปรับน้ำหนักก่อนฝืนต่อ',
  29: 'อุปสรรคอาจเกิดซ้ำเหมือนห้วงน้ำลึก รักษาสติและความซื่อตรงผ่านแต่ละขั้น',
  30: 'ความกระจ่างต้องอาศัยสิ่งยึดเหนี่ยวที่เหมาะ มองให้ชัดและยึดหลักที่เที่ยงตรง',
  31: 'การตอบสนองเกิดจากการเปิดใจต่อกัน รับฟังอย่างอ่อนโยนและเคารพความรู้สึกอีกฝ่าย',
  32: 'ความยั่งยืนเกิดจากความสม่ำเสมอ รักษาเป้าหมายโดยปรับวิธีให้เข้ากับเวลา',
  33: 'การถอยให้ถูกจังหวะช่วยรักษากำลัง เว้นระยะอย่างมีหลักเมื่อสถานการณ์ไม่เอื้อ',
  34: 'มีกำลังมากจึงยิ่งต้องกำกับตน ใช้ความเข้มแข็งอย่างถูกต้องและไม่เกินขอบเขต',
  35: 'ความสามารถค่อยปรากฏและมีทางก้าวหน้า เดินหน้าด้วยความชัดเจนและผลงานที่เหมาะสม',
  36: 'แสงถูกบดบังในสภาพแวดล้อมที่ยาก รักษาความชัดเจนภายในและวางตัวอย่างสุขุม',
  37: 'ความมั่นคงเริ่มจากความสัมพันธ์ใกล้ตัว ทำหน้าที่ให้ชัดและดูแลกันอย่างรับผิดชอบ',
  38: 'มุมมองต่างกันแต่ยังมีจุดร่วม เริ่มร่วมมือจากเรื่องเล็กโดยเคารพความแตกต่าง',
  39: 'ทางข้างหน้ามีอุปสรรคควรหยุดประเมิน ขอแรงผู้รู้และมองเส้นทางที่เหมาะกว่า',
  40: 'เงื่อนปัญหาเริ่มคลี่คลาย จัดการสิ่งค้างให้จบแล้วคืนสู่ความเรียบง่าย',
  41: 'การลดส่วนเกินช่วยปรับสมดุล เลือกสละสิ่งไม่จำเป็นด้วยความจริงใจ',
  42: 'การเพิ่มพูนมีคุณค่าเมื่อเกิดประโยชน์ร่วม ใช้โอกาสสนับสนุนผู้อื่นและพัฒนาตน',
  43: 'ถึงเวลาตัดสินใจให้ชัด สื่อสารอย่างตรงไปตรงมาและแก้ปัญหาโดยไม่ใช้ความรุนแรง',
  44: 'การพบสิ่งใหม่อาจมีอิทธิพลแรง พิจารณาเจตนาและขอบเขตก่อนผูกพันระยะยาว',
  45: 'การรวมตัวต้องมีศูนย์กลางที่คนเชื่อถือ วางเป้าหมายร่วมและจัดกำลังให้พร้อม',
  46: 'เติบโตขึ้นได้ด้วยความพยายามเป็นลำดับ เรียนรู้จากผู้สนับสนุนและไม่เร่งข้ามขั้น',
  47: 'ข้อจำกัดทดสอบความมั่นคงภายใน รักษาหลักและให้การกระทำช่วยยืนยันคำพูด',
  48: 'บ่อน้ำแทนแหล่งหล่อเลี้ยงร่วม ดูแลต้นทุนและทางเข้าถึงให้เกิดประโยชน์ได้จริง',
  49: 'สิ่งเดิมอาจต้องเปลี่ยนเมื่อไม่ตอบโจทย์ เลือกเวลาและสร้างความเชื่อถือก่อนลงมือ',
  50: 'การปรุงเปลี่ยนสิ่งที่มีให้เกิดคุณค่า พัฒนาคนและความสามารถเพื่อหล่อเลี้ยงส่วนรวม',
  51: 'เหตุสะเทือนทำให้ตื่นตัว ตั้งสติแล้วรักษาหน้าที่สำคัญให้มั่นคง',
  52: 'รู้จักหยุดในจุดที่ควรหยุด วางใจให้นิ่งแล้วแยกให้ออกว่าเมื่อใดควรเคลื่อนไหว',
  53: 'ความก้าวหน้าที่มั่นคงค่อยเป็นค่อยไป ให้เวลาแต่ละขั้นเติบโตอย่างเหมาะสม',
  54: 'บทบาทในความสัมพันธ์อาจยังไม่สมดุล รู้ฐานะของตนและไม่เร่งผูกมัดเกินความพร้อม',
  55: 'ช่วงเต็มเปี่ยมควรใช้ความสามารถให้เกิดประโยชน์ ระลึกว่าความรุ่งเรืองมีจังหวะเปลี่ยน',
  56: 'อยู่ในบริบทที่ยังไม่คุ้นเคย วางตัวสุภาพ ปรับตัว และระวังการตัดสินใจ',
  57: 'อิทธิพลอ่อนโยนค่อยซึมลึก สื่อสารให้ชัดและทำต่อเนื่องอย่างมีหลัก',
  58: 'ความยินดีช่วยเชื่อมผู้คน เปิดใจแลกเปลี่ยนโดยไม่ละทิ้งความจริงใจและหลักการ',
  59: 'คลายสิ่งที่ทำให้ผู้คนแยกจากกัน สร้างความเข้าใจและกลับมาหาเป้าหมายร่วม',
  60: 'ขอบเขตที่พอดีช่วยให้ดำเนินต่อได้ วางกติกาชัดเจนโดยไม่เข้มงวดจนเกินทน',
  61: 'ความน่าเชื่อถือเริ่มจากใจที่จริง ทำคำพูดกับการกระทำให้สอดคล้องกัน',
  62: 'จังหวะนี้ให้ความสำคัญกับเรื่องเล็ก รอบคอบในรายละเอียดและก้าวอย่างพอดี',
  63: 'งานเข้าที่หรือผ่านจุดสำเร็จแล้ว ดูแลรายละเอียดต่อเนื่องเพื่อรักษาสมดุล',
  64: 'การเปลี่ยนผ่านยังไม่จบ ตรวจความพร้อมและทำขั้นสุดท้ายอย่างระมัดระวัง',
};
export const hexagrams = deepFreeze(hexNames.map((name,i)=>{
  let lowerIndex=-1,upperIndex=-1;
  hexagramMatrix.forEach((row,l)=>{const u=row.indexOf(i+1);if(u!==-1){lowerIndex=l;upperIndex=u;}});
  const lower=trigrams[lowerIndex],upper=trigrams[upperIndex];
  return {number:i+1,name,thai:hexThai[i],meaning:hexMeanings[i+1],glyph:String.fromCodePoint(0x4dc0+i),lower:lower.symbol,upper:upper.symbol,yao:[...lower.yao,...upper.yao],sourceIds:['hexagrams','tuan'],frame:'catalog_only'};
}));
export function findHexagram(lower,upper) {
  const found=hexagrams.find(h=>h.lower===lower&&h.upper===upper);
  if(!found)throw new TypeError('Two named trigrams are required');
  return found;
}

export const studyGuide = deepFreeze([
  {title:'อ่านแนวนั่ง–หัน · 坐向',text:'แนวหันคือด้านที่เลือกสำรวจ แนวนั่งอยู่ตรงข้าม 180° การเลือกด้านหันของอาคารต้องดูสภาพใช้งานและพื้นที่เปิดร่วมด้วย ประตูเข้ากับด้านหันอาจเป็นคนละด้าน วงนี้รายงานคู่ตรงข้ามของค่าที่กรอก',sourceIds:['compass']},
  {title:'วัดหน้างานก่อนอ่านวง',text:'ถือเข็มทิศให้ราบ วัดซ้ำหลายตำแหน่ง หลีกเลี่ยงเหล็ก รถ และแม่เหล็กใกล้ตัว ตรวจค่าด้านหน้าและด้านหลัง หากอุปกรณ์แสดงเหนือจริงต้องรู้ค่าความเบี่ยงเบนของสถานที่และวันนั้นก่อนใช้กับวงเหนือแม่เหล็ก',sourceIds:['compass','plates']},
  {title:'หน้าปัดคงที่กับเข็มอ่าน',text:'ในแอป เหนืออยู่ด้านบนเสมอ เข็มเป็นแนวที่กำลังอ่าน ไม่ใช่เซนเซอร์ที่หมุนตามตัวโทรศัพท์ การแตะวงและเลื่อนแถบคือการทดลองตำแหน่ง; การกรอกองศาคือค่าที่คุณนำมาจากเครื่องวัด',sourceIds:['compass']},
  {title:'สามจานไม่ใช่เหนือสามแบบ',text:'จานดิน คน และฟ้าใช้ลำดับ 24 ขุนเขาชุดเดียวกันแต่มีมุมเยื้องประจำจาน ±7.5° แบบซาฮะที่ระบุไว้ ตัวเลขนี้คงที่ตามผัง และใช้แทนค่าความเบี่ยงเบนแม่เหล็กจริงของสถานที่ไม่ได้',sourceIds:['plates']},
  {title:'อ่านธาตุให้รู้ว่ามาจากวงใด',text:'正五行 อ่านธาตุรายขุนเขา; ธาตุปากว้าอ่านตามวัง 45°; 雙山三合五行 อ่านตามคู่และกลุ่มซาฮะ ทั้งสามจึงอาจให้ชื่อธาตุต่างกันที่องศาเดียว ไม่ควรรวมเป็นคะแนนธาตุเดียว',sourceIds:['hetu','sanhe']},
  {title:'12 ฉางเซิงใช้เกณฑ์ที่เลือก',text:'ตารางนี้ให้เลือกธาตุน้ำ ไม้ ไฟ หรือทอง และลำดับหยาง/หยิน เพื่อศึกษาการเดินระยะบนคู่ขุนเขาจานฟ้า ยังต้องกำหนดสำนัก ชนิดของน้ำ จุดเข้า–ออก และหลักเลือก局ก่อนนำไปใช้กับสถานที่จริง',sourceIds:['sanhe']},
  {title:'ดาวเหินต้องมีข้อมูลอาคาร · 玄空飛星',text:'ลั่วซูคือผังเลขฐาน การทำผังดาวเหินต้องเพิ่มยุคของอาคาร แนวนั่ง–หัน และกฎเดินดาวของสำนัก เลข 9 ในวังใต้ของวงนี้จึงไม่ใช่ผลคำนวณดาวประจำอาคารหรือคำตัดสินว่าทิศใต้ดีเสมอ',sourceIds:['compass','plates']},
  {title:'64 ข่วยกับวงองศา',text:'ตาราง 64 ข่วยด้านล่างใช้โครงข่วยบน–ล่างเพื่อศึกษาชื่อและภาพแทน การวาง 64 ข่วยหรือ 384 เส้นลงองศาต้องกำหนดผังต้ากว้าและจุดเริ่มเฉพาะก่อน เลขลำดับเหวินหวังในตารางนี้จึงไม่ได้แบ่งทิศเป็น 64 ช่อง',sourceIds:['hexagrams','plates']},
  {title:'วงละเอียด 60 / 72 / 120 / 240',text:'หล่อแกบางรุ่นมีมังกรทะลุดิน มังกรลอดเขา และเฟินจินละเอียด จำนวนช่องเท่ากันไม่ได้ยืนยันว่าลำดับอักษรกับเส้นแบ่งเหมือนกัน ต้องผูกกับรุ่นจานและต้นฉบับเฉพาะ จึงเก็บเป็นหัวข้อความรู้ต่อยอด ยังไม่สร้างผลทิศจากวงเหล่านี้',sourceIds:['plates']},
  {title:'กิ่งดินบนวงกับดวงกำเนิด',text:'วงขุนเขาเป็นพิกัดพื้นที่ ส่วนปี เดือน วัน ยามของ BaZi เป็นข้อมูลเวลา สีเน้นกิ่งดินจากยามเกิดบอกเพียงอักษรตรงกัน การหาธาตุเกื้อหนุนเฉพาะบุคคลต้องใช้ดวงเต็มและกฎพิจารณาต่างหาก',sourceIds:['calendar','compass']},
]);
