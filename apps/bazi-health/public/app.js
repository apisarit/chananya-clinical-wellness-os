const STEMS = {
  '甲': { element:'Wood', polarity:'Yang' }, '乙': { element:'Wood', polarity:'Yin' },
  '丙': { element:'Fire', polarity:'Yang' }, '丁': { element:'Fire', polarity:'Yin' },
  '戊': { element:'Earth', polarity:'Yang' }, '己': { element:'Earth', polarity:'Yin' },
  '庚': { element:'Metal', polarity:'Yang' }, '辛': { element:'Metal', polarity:'Yin' },
  '壬': { element:'Water', polarity:'Yang' }, '癸': { element:'Water', polarity:'Yin' }
};

const BRANCHES = {
  '子': { element:'Water', hidden:['癸'] },
  '丑': { element:'Earth', hidden:['己','癸','辛'] },
  '寅': { element:'Wood', hidden:['甲','丙','戊'] },
  '卯': { element:'Wood', hidden:['乙'] },
  '辰': { element:'Earth', hidden:['戊','乙','癸'] },
  '巳': { element:'Fire', hidden:['丙','庚','戊'] },
  '午': { element:'Fire', hidden:['丁','己'] },
  '未': { element:'Earth', hidden:['己','丁','乙'] },
  '申': { element:'Metal', hidden:['庚','壬','戊'] },
  '酉': { element:'Metal', hidden:['辛'] },
  '戌': { element:'Earth', hidden:['戊','辛','丁'] },
  '亥': { element:'Water', hidden:['壬','甲'] }
};

const CLASHES = [['子','午'],['丑','未'],['寅','申'],['卯','酉'],['辰','戌'],['巳','亥']];
const SIX_COMBOS = [['子','丑'],['寅','亥'],['卯','戌'],['辰','酉'],['巳','申'],['午','未']];

const ELEMENTS = ['Wood','Fire','Earth','Metal','Water'];
const ELEMENT_THAI = {Wood:'ไม้',Fire:'ไฟ',Earth:'ดิน',Metal:'ทอง',Water:'น้ำ'};

const TEST_CASE = {
  label:'เด็กหญิง · 9 Sep 2016 · 卯時',
  pillars:{ year:['丙','申'], month:['丁','酉'], day:['甲','午'], hour:['丁','卯'] },
  luck:'乙未',
  annual:'丙午'
};


const THREE_HARMONY = [
  {members:['申','子','辰'], element:'Water', label:'申子辰三合水局'},
  {members:['亥','卯','未'], element:'Wood', label:'亥卯未三合木局'},
  {members:['寅','午','戌'], element:'Fire', label:'寅午戌三合火局'},
  {members:['巳','酉','丑'], element:'Metal', label:'巳酉丑三合金局'},
];
const THREE_MEETINGS = [
  {members:['亥','子','丑'], element:'Water', label:'亥子丑三會水'},
  {members:['寅','卯','辰'], element:'Wood', label:'寅卯辰三會木'},
  {members:['巳','午','未'], element:'Fire', label:'巳午未三會火'},
  {members:['申','酉','戌'], element:'Metal', label:'申酉戌三會金'},
];
const HARMS = [['子','未'],['丑','午'],['寅','巳'],['卯','辰'],['申','亥'],['酉','戌']];
const BREAKS = [['子','酉'],['丑','辰'],['寅','亥'],['卯','午'],['巳','申'],['未','戌']];
const PUNISHMENTS = [
  {members:['寅','巳','申'], label:'寅巳申三刑'},
  {members:['丑','未','戌'], label:'丑未戌三刑'},
  {members:['子','卯'], label:'子卯刑'},
];
const SELF_PUNISH = ['辰','午','酉','亥'];

const GROWTH_STAGES = ['長生','沐浴','冠帶','臨官','帝旺','衰','病','死','墓','絕','胎','養'];
const BRANCH_ORDER = ['子','丑','寅','卯','辰','巳','午','未','申','酉','戌','亥'];
const CHANGSHENG_START = {
  '甲':'亥','乙':'午','丙':'寅','丁':'酉','戊':'寅','己':'酉','庚':'巳','辛':'子','壬':'申','癸':'卯'
};

function twelveGrowthStage(stem, branch){
  const start = BRANCH_ORDER.indexOf(CHANGSHENG_START[stem]);
  const target = BRANCH_ORDER.indexOf(branch);
  const yang = STEMS[stem].polarity === 'Yang';
  const step = yang ? (target-start+12)%12 : (start-target+12)%12;
  return GROWTH_STAGES[step];
}

function allPresent(set, members){ return members.every(x=>set.has(x)); }
function pairPresent(set,[a,b]){ return set.has(a)&&set.has(b); }

function extendedInteractions(branches){
  const set = new Set(branches);
  const results=[];
  THREE_HARMONY.forEach(x=>{if(allPresent(set,x.members)) results.push({type:'三合',label:x.label,element:x.element,severity:'strong'});});
  THREE_MEETINGS.forEach(x=>{if(allPresent(set,x.members)) results.push({type:'三會',label:x.label,element:x.element,severity:'strong'});});
  HARMS.forEach(x=>{if(pairPresent(set,x)) results.push({type:'害',label:`${x[0]}${x[1]}害`,severity:'medium'});});
  BREAKS.forEach(x=>{if(pairPresent(set,x)) results.push({type:'破',label:`${x[0]}${x[1]}破`,severity:'medium'});});
  PUNISHMENTS.forEach(x=>{if(allPresent(set,x.members)) results.push({type:'刑',label:x.label,severity:'strong'});});
  SELF_PUNISH.forEach(b=>{if(branches.filter(x=>x===b).length>=2) results.push({type:'自刑',label:`${b}${b}自刑`,severity:'medium'});});
  return results;
}

// 旺相休囚死 seasonal multipliers. This is a transparent heuristic layer, not a universal school standard.
const SEASON_BY_MONTH = {
  '寅':'Wood','卯':'Wood','辰':'Earth',
  '巳':'Fire','午':'Fire','未':'Earth',
  '申':'Metal','酉':'Metal','戌':'Earth',
  '亥':'Water','子':'Water','丑':'Earth'
};
const PRODUCES = {Wood:'Fire',Fire:'Earth',Earth:'Metal',Metal:'Water',Water:'Wood'};
const CONTROLS = {Wood:'Earth',Earth:'Water',Water:'Fire',Fire:'Metal',Metal:'Wood'};
function seasonMultiplier(monthBranch, element){
  const season=SEASON_BY_MONTH[monthBranch];
  if(element===season) return 1.60; // 旺
  if(PRODUCES[season]===element) return 1.25; // 相
  if(PRODUCES[element]===season) return 0.90; // 休
  if(CONTROLS[element]===season) return 0.75; // 囚
  if(CONTROLS[season]===element) return 0.60; // 死
  return 1;
}

const HIDDEN_WEIGHTS=[8,5,3];
function seasonalElementProfile(pillars){
  const monthBranch=pillars.month[1];
  const raw={Wood:0,Fire:0,Earth:0,Metal:0,Water:0};
  for(const [stem,branch] of Object.values(pillars)){
    raw[STEMS[stem].element]+=10;
    raw[BRANCHES[branch].element]+=14;
    BRANCHES[branch].hidden.forEach((h,i)=>raw[STEMS[h].element]+=(HIDDEN_WEIGHTS[i]||2));
  }
  const weighted={};
  for(const [el,v] of Object.entries(raw)) weighted[el]=Math.round(v*seasonMultiplier(monthBranch,el)*10)/10;
  return {raw,weighted,season:SEASON_BY_MONTH[monthBranch],monthBranch};
}

// Classical 調候 rules are kept separate from 扶抑 strength logic.
// v1.2 starts with the fully sourced test path 甲木 in 酉 month; fallback remains explicit.
const TIAOHOU = {
  '甲酉': {
    title:'八月甲木 · 木囚金旺',
    priority:[
      {stem:'丁',element:'Fire',rank:1,reason:'丁火為先 — ใช้ไฟ丁เป็นลำดับแรก'},
      {stem:'丙',element:'Fire',rank:2,reason:'次用丙火 — รองลงมาคือ丙火'},
      {stem:'庚',element:'Metal',rank:3,reason:'庚金再次 — 庚เป็นลำดับถัดไป'}
    ],
    caution:['癸透อาจกด/รบกวนไฟในกรอบข้อความตำรานี้','ต้องอ่านทั้ง局 ไม่ใช่เติมธาตุตามรายการแบบกลไก'],
    source:'《窮通寶鑑》· 三秋甲木 · 八月甲木',
    sourceUrl:'https://zh.wikisource.org/zh/%E7%A9%B7%E9%80%9A%E5%AE%9D%E9%89%B4'
  }
};

function tiaohouRule(dayStem, monthBranch){
  return TIAOHOU[`${dayStem}${monthBranch}`] || {
    title:'調候 rule not yet encoded for this stem/month',
    priority:[], caution:['v1.2 จะไม่เดา用神เมื่อไม่มี rule ที่ตรวจสอบแล้ว'], source:'Pending classical rule encoding', sourceUrl:null
  };
}

function supportBalanceRecommendation(dayElement, strengthLabel){
  const resource=Object.keys(PRODUCES).find(k=>PRODUCES[k]===dayElement);
  const companion=dayElement;
  const output=PRODUCES[dayElement];
  const wealth=CONTROLS[dayElement];
  const officer=Object.keys(CONTROLS).find(k=>CONTROLS[k]===dayElement);
  const weak=['弱','偏弱'].includes(strengthLabel);
  return {
    lens:'扶抑',
    priority: weak ? [resource,companion] : [output,wealth,officer],
    avoidAuto: weak ? [output,wealth,officer] : [resource,companion],
    explanation: weak ? '身偏弱: 扶抑 lens ให้ความสำคัญกับ印/比劫ก่อน' : '身偏強: 扶抑 lens พิจารณา泄耗克มากขึ้น'
  };
}

function compareUsefulGodLenses(dayStem, monthBranch, dayElement, strengthLabel){
  const balance=supportBalanceRecommendation(dayElement,strengthLabel);
  const climate=tiaohouRule(dayStem,monthBranch);
  const climateElements=[...new Set(climate.priority.map(x=>x.element))];
  const overlap=balance.priority.filter(x=>climateElements.includes(x));
  return {balance,climate,overlap,conflict:climate.priority.length>0 && overlap.length===0};
}

function describeElement(el){ return `${ELEMENT_THAI[el]} (${el})`; }



const produces = {Wood:'Fire',Fire:'Earth',Earth:'Metal',Metal:'Water',Water:'Wood'};
const controls = {Wood:'Earth',Earth:'Water',Water:'Fire',Fire:'Metal',Metal:'Wood'};

function tenGod(dayStem, otherStem){
  if(dayStem===otherStem) return '比肩';
  const d=STEMS[dayStem], o=STEMS[otherStem];
  const same=d.polarity===o.polarity;
  if(d.element===o.element) return same?'比肩':'劫財';
  if(produces[o.element]===d.element) return same?'偏印':'正印';
  if(produces[d.element]===o.element) return same?'食神':'傷官';
  if(controls[d.element]===o.element) return same?'偏財':'正財';
  if(controls[o.element]===d.element) return same?'七殺':'正官';
  return '—';
}

function hiddenTenGods(dayStem, branch){return BRANCHES[branch].hidden.map(s=>({stem:s,god:tenGod(dayStem,s)}));}

function detectInteractions(branches){
  const set=new Set(branches);
  return {
    clashes:CLASHES.filter(([a,b])=>set.has(a)&&set.has(b)).map(([a,b])=>`${a}${b}沖`),
    combos:SIX_COMBOS.filter(([a,b])=>set.has(a)&&set.has(b)).map(([a,b])=>`${a}${b}合`)
  };
}

function rootBranches(dayEl,pillars){
  return Object.entries(pillars).filter(([,p])=>BRANCHES[p[1]].element===dayEl || BRANCHES[p[1]].hidden.some(h=>STEMS[h].element===dayEl));
}

function strengthAudit(pillars){
  const dayStem=pillars.day[0], dayEl=STEMS[dayStem].element;
  const resourceEl=Object.keys(produces).find(k=>produces[k]===dayEl);
  const outputEl=produces[dayEl], wealthEl=controls[dayEl], officerEl=Object.keys(controls).find(k=>controls[k]===dayEl);
  const profile=seasonalElementProfile(pillars);
  const monthEl=BRANCHES[pillars.month[1]].element;
  let score=50; const audit=[];

  if(monthEl===dayEl){score+=20;audit.push(['得令','月令同氣 / season matches Day Master','+20']);}
  else if(produces[monthEl]===dayEl){score+=15;audit.push(['得令','月令生身 / season generates Day Master','+15']);}
  else if(controls[monthEl]===dayEl){score-=20;audit.push(['失令','月令克身 / season controls Day Master','-20']);}
  else if(produces[dayEl]===monthEl){score-=11;audit.push(['泄令','日主生月令 / Day Master drains into season','-11']);}
  else {audit.push(['月令','Neutral direct relation','0']);}

  const roots=rootBranches(dayEl,pillars);
  let rootScore=0;
  roots.forEach(([pos,[,b]])=>{rootScore += BRANCHES[b].element===dayEl ? (pos==='month'?10:8) : 5;});
  rootScore=Math.min(rootScore,18); score+=rootScore;
  audit.push(['得地',`${roots.length} root source(s): ${roots.map(([p,x])=>`${p}:${x[1]}`).join(', ')||'none'}`,`+${rootScore}`]);

  const w=profile.weighted;
  const support=w[resourceEl]+w[dayEl];
  const drain=w[outputEl]+w[wealthEl]+w[officerEl];
  const supportShare=support/(support+drain||1);
  const ratioAdj=Math.round((supportShare-.38)*32);
  const capped=Math.max(-14,Math.min(14,ratioAdj)); score+=capped;
  audit.push(['得勢 / 克泄耗',`Season-weighted support ${support.toFixed(1)} vs drain/control ${drain.toFixed(1)}`,`${capped>=0?'+':''}${capped}`]);

  const branches=Object.values(pillars).map(p=>p[1]);
  const basic=detectInteractions(branches);
  const ext=extendedInteractions(branches);
  for(const [pos,[,b]] of roots){
    const clash=CLASHES.find(([a,c])=>(a===b&&branches.includes(c))||(c===b&&branches.includes(a)));
    if(clash){ score-=6; audit.push(['根受沖',`${pos} root ${b} is clashed by ${clash.find(x=>x!==b)}`,'-6']); }
  }
  if(ext.some(x=>x.type==='三合'||x.type==='三會')) audit.push(['成局','Full 三合/三會 detected; transformation not auto-assumed','0']);
  score=Math.max(0,Math.min(100,score));
  let label='中和'; if(score<35) label='弱'; else if(score<48) label='偏弱'; else if(score>68) label='強'; else if(score>58) label='偏強';
  return {score,label,audit,profile,resourceEl,companionEl:dayEl,outputEl,wealthEl,officerEl,interactions:{...basic,extended:ext},roots};
}

function structureAudit(pillars){
  const dayStem=pillars.day[0], monthBranch=pillars.month[1];
  const monthHidden=BRANCHES[monthBranch].hidden;
  const primary=tenGod(dayStem,monthHidden[0]);
  const visible=Object.entries(pillars).filter(([k])=>k!=='day').map(([position,p])=>({position,stem:p[0],god:tenGod(dayStem,p[0])}));
  const flags=[];
  if(primary==='正官' && visible.some(x=>x.god==='傷官')) flags.push('傷官見官');
  if(primary==='七殺' && visible.some(x=>['食神','傷官'].includes(x.god))) flags.push('食傷制殺候選');
  if(visible.filter(x=>['食神','傷官'].includes(x.god)).length>=2) flags.push('食傷透顯');
  return {primaryStructure:`${primary}格起點`,primary,visible,flags};
}

function transitAudit(pillars,luck,annual){
  const natal=Object.values(pillars).map(p=>p[1]);
  const branches=[...natal,luck[1],annual[1]];
  const interactions=detectInteractions(branches);
  const extended=extendedInteractions(branches);
  const repeat=natal.includes(annual[1])?`${annual[1]}伏吟/重疊`:null;
  return {interactions:{...interactions,extended},repeat,luck,annual};
}

function analyzeChart(pillars,luck='乙未',annual='丙午'){
  const dayStem=pillars.day[0], dayElement=STEMS[dayStem].element;
  const strength=strengthAudit(pillars), structure=structureAudit(pillars), transit=transitAudit(pillars,luck,annual);
  const hidden={},growth={};
  for(const [k,[,b]] of Object.entries(pillars)){hidden[k]=hiddenTenGods(dayStem,b); growth[k]=twelveGrowthStage(dayStem,b);}
  growth.luck=twelveGrowthStage(dayStem,luck[1]); growth.annual=twelveGrowthStage(dayStem,annual[1]);
  const useful=compareUsefulGodLenses(dayStem,pillars.month[1],dayElement,strength.label);
  return {dayStem,dayElement,strength,structure,transit,hidden,growth,useful};
}

// BaZi calendar engine v1.1
// Conventions: solar-term (Jie) year/month boundaries; local civil day boundary at 00:00 (sect 2).
// Solar longitude uses a compact apparent-Sun approximation suitable for calendar boundary detection.

const CAL_STEMS = ['甲','乙','丙','丁','戊','己','庚','辛','壬','癸'];
const CAL_BRANCHES = ['子','丑','寅','卯','辰','巳','午','未','申','酉','戌','亥'];
const MONTH_BRANCHES = ['寅','卯','辰','巳','午','未','申','酉','戌','亥','子','丑'];
const JIE_LONGITUDES = [315,345,15,45,75,105,135,165,195,225,255,285];

const mod=(n,m)=>((n%m)+m)%m;
const rad=d=>d*Math.PI/180;
const deg=r=>r*180/Math.PI;

function julianDayUTC(y,m,d,h=0,min=0,sec=0){
  if(m<=2){y-=1;m+=12;}
  const A=Math.floor(y/100);
  const B=2-A+Math.floor(A/4);
  const day=d+(h+min/60+sec/3600)/24;
  return Math.floor(365.25*(y+4716))+Math.floor(30.6001*(m+1))+day+B-1524.5;
}

function apparentSolarLongitudeUTC(date){
  const jd=julianDayUTC(date.getUTCFullYear(),date.getUTCMonth()+1,date.getUTCDate(),date.getUTCHours(),date.getUTCMinutes(),date.getUTCSeconds());
  const T=(jd-2451545.0)/36525;
  const L0=mod(280.46646 + T*(36000.76983 + T*0.0003032),360);
  const M=mod(357.52911 + T*(35999.05029 - 0.0001537*T),360);
  const C=(1.914602-T*(0.004817+0.000014*T))*Math.sin(rad(M))
        +(0.019993-0.000101*T)*Math.sin(rad(2*M))
        +0.000289*Math.sin(rad(3*M));
  const trueLong=L0+C;
  const omega=125.04-1934.136*T;
  return mod(trueLong-0.00569-0.00478*Math.sin(rad(omega)),360);
}

function localToUtcDate({year,month,day,hour=0,minute=0,second=0,tzOffset=7}){
  return new Date(Date.UTC(year,month-1,day,hour,minute,second)-tzOffset*3600000);
}

function validateBirthInput(input){
  const {year,month,day,hour=0,minute=0,tzOffset=7}=input;
  if(![year,month,day,hour,minute].every(Number.isInteger) || year<1900 || year>2100 || month<1 || month>12 || day<1 || hour<0 || hour>23 || minute<0 || minute>59 || !Number.isFinite(tzOffset) || tzOffset < -12 || tzOffset > 14){
    throw new Error('กรุณาระบุวันเกิด เวลา และเขตเวลาให้ครบถ้วน');
  }
  const date=new Date(Date.UTC(year,month-1,day));
  if(date.getUTCFullYear()!==year || date.getUTCMonth()!==month-1 || date.getUTCDate()!==day){
    throw new Error('วันเกิดไม่มีอยู่ในเดือนและปีที่เลือก');
  }
  return input;
}

function gregorianJdn(y,m,d){
  const a=Math.floor((14-m)/12);
  const y2=y+4800-a;
  const m2=m+12*a-3;
  return d+Math.floor((153*m2+2)/5)+365*y2+Math.floor(y2/4)-Math.floor(y2/100)+Math.floor(y2/400)-32045;
}

function sexagenaryFromIndex(i){
  const idx=mod(i,60);
  return CAL_STEMS[idx%10]+CAL_BRANCHES[idx%12];
}

function dayPillar(year,month,day){
  // Calibrated to the standard sexagenary cycle; 2016-09-09 => 甲午.
  const idx=mod(gregorianJdn(year,month,day)+49,60);
  return sexagenaryFromIndex(idx);
}

function yearPillarFromSolarYear(solarYear){
  // 1984 is 甲子.
  return sexagenaryFromIndex(solarYear-1984);
}

function monthIndexFromLongitude(lon){
  return Math.floor(mod(lon-315,360)/30);
}

function monthPillar(yearPillar, lon){
  const yStem=yearPillar[0];
  const yStemIndex=CAL_STEMS.indexOf(yStem);
  const mi=monthIndexFromLongitude(lon);
  const yinStem=(2 + 2*yStemIndex + mi)%10; // 五虎遁
  return CAL_STEMS[yinStem]+MONTH_BRANCHES[mi];
}

function hourPillar(dayPillarValue,hour){
  const dStemIndex=CAL_STEMS.indexOf(dayPillarValue[0]);
  const branchIndex=Math.floor(mod(hour+1,24)/2);
  const ziStem=(2*(dStemIndex%5))%10; // 五鼠遁
  return CAL_STEMS[(ziStem+branchIndex)%10]+CAL_BRANCHES[branchIndex];
}

function angularDistance(a,b){
  const d=Math.abs(mod(a-b+180,360)-180);
  return d;
}

function nearestJieDistanceDegrees(lon){
  return Math.min(...JIE_LONGITUDES.map(x=>angularDistance(lon,x)));
}

function calculateFourPillars(input){
  validateBirthInput(input);
  const {year,month,day,hour=0,minute=0,tzOffset=7}=input;
  const utc=localToUtcDate(input);
  const lon=apparentSolarLongitudeUTC(utc);
  const mi=monthIndexFromLongitude(lon);
  // 寅/卯... until 丑. Jan before 立春 belongs to previous solar year.
  const solarYear=(month===1 || (month===2 && mi===11)) ? year-1 : year;
  const yp=yearPillarFromSolarYear(solarYear);
  const mp=monthPillar(yp,lon);
  const dp=dayPillar(year,month,day);
  // Midnight day-pillar convention; late Zi hour uses the next day's hour stem.
  const nextDay=new Date(Date.UTC(year,month-1,day+1));
  const hourDay=hour===23 ? dayPillar(nextDay.getUTCFullYear(),nextDay.getUTCMonth()+1,nextDay.getUTCDate()) : dp;
  const hp=hourPillar(hourDay,hour);
  return {
    pillars:{year:[yp[0],yp[1]],month:[mp[0],mp[1]],day:[dp[0],dp[1]],hour:[hp[0],hp[1]]},
    solarLongitude:lon,
    solarYear,
    monthIndex:mi,
    nearBoundary:nearestJieDistanceDegrees(lon)<0.12,
    utcISO:utc.toISOString()
  };
}

function shiftGanZhi(pillar,steps){
  const s=CAL_STEMS.indexOf(pillar[0]), b=CAL_BRANCHES.indexOf(pillar[1]);
  const cur=[...Array(60).keys()].find(i=>CAL_STEMS[i%10]===pillar[0]&&CAL_BRANCHES[i%12]===pillar[1]);
  if(cur===undefined) throw new Error(`Invalid GanZhi pillar: ${pillar}`);
  return sexagenaryFromIndex(cur+steps);
}

function isYangStem(stem){return CAL_STEMS.indexOf(stem)%2===0;}

function luckDirection(yearStem,gender){
  // Common rule: Yang male / Yin female forward; Yin male / Yang female reverse.
  const yang=isYangStem(yearStem);
  return ((gender==='male'&&yang)||(gender==='female'&&!yang)) ? 1 : -1;
}

function generateLuckPillars(monthPillarValue,yearStem,gender,count=9){
  const direction=luckDirection(yearStem,gender);
  return Array.from({length:count},(_,i)=>shiftGanZhi(monthPillarValue,direction*(i+1)));
}

function monthIndexAtDateUTC(date){return monthIndexFromLongitude(apparentSolarLongitudeUTC(date));}

function findAdjacentJie(input,direction){
  const start=localToUtcDate(input);
  const startMi=monthIndexAtDateUTC(start);
  const stepMs=6*3600*1000*direction;
  let a=new Date(start), b=new Date(start);
  for(let i=0;i<160;i++){
    b=new Date(b.getTime()+stepMs);
    if(monthIndexAtDateUTC(b)!==startMi){
      let lo=direction>0?a:b, hi=direction>0?b:a;
      for(let k=0;k<28;k++){
        const mid=new Date((lo.getTime()+hi.getTime())/2);
        if(monthIndexAtDateUTC(mid)===startMi){
          if(direction>0) lo=mid; else hi=mid;
        } else {
          if(direction>0) hi=mid; else lo=mid;
        }
      }
      return direction>0?hi:lo;
    }
    a=new Date(b);
  }
  return null;
}

function calculateLuckStart(input,gender,pillars){
  const direction=luckDirection(pillars.year[0],gender);
  const birth=localToUtcDate(input);
  const jie=findAdjacentJie(input,direction);
  if(!jie) return null;
  const days=Math.abs(jie-birth)/86400000;
  const years=days/3;
  const y=Math.floor(years);
  const months=Math.floor((years-y)*12);
  const daysR=Math.round((((years-y)*12)-months)*30);
  const startDate=new Date(Date.UTC(input.year+y,input.month-1+months,input.day+daysR,input.hour??0,input.minute??0)-(input.tzOffset??7)*3600000);
  return {direction,daysToJie:days,startAgeYears:years,startAge:{years:y,months,days:daysR},jieUTC:jie.toISOString(),approxStartUTC:startDate.toISOString()};
}

{CAL_STEMS,CAL_BRANCHES,MONTH_BRANCHES,JIE_LONGITUDES};



const TH_GOD={
 '比肩':'เพื่อนร่วมธาตุ','劫財':'คู่แข่ง/แรงร่วม','劫财':'คู่แข่ง/แรงร่วม',
 '食神':'เทพอาหาร/การสร้างผลงาน','傷官':'ดาวแสดงออก/ท้าทายกรอบ','伤官':'ดาวแสดงออก/ท้าทายกรอบ',
 '偏財':'ลาภเคลื่อนไหว','偏财':'ลาภเคลื่อนไหว','正財':'ทรัพย์ประจำ','正财':'ทรัพย์ประจำ',
 '七殺':'เจ็ดพิฆาต/แรงกดดัน','七杀':'เจ็ดพิฆาต/แรงกดดัน','正官':'ขุนนางตรง/กฎระเบียบ',
 '偏印':'ตราประทับรอง/การเรียนรู้เฉพาะทาง','正印':'ตราประทับตรง/การสนับสนุน'
};
const TH_GROWTH={
 '長生':'กำเนิด','长生':'กำเนิด','沐浴':'ชำระ/เริ่มเปิดรับ','冠帶':'ตั้งตัว','冠带':'ตั้งตัว',
 '臨官':'เข้ารับตำแหน่ง','临官':'เข้ารับตำแหน่ง','帝旺':'รุ่งเรืองสูงสุด','衰':'เริ่มถอย',
 '病':'อ่อนกำลัง','死':'สิ้นกำลัง','墓':'เก็บสะสม','絕':'ตัดขาด','绝':'ตัดขาด','胎':'ก่อกำเนิด','養':'หล่อเลี้ยง','养':'หล่อเลี้ยง'
};
const TH_STRENGTH={'Very Weak':'อ่อนมาก','Weak':'อ่อน','Balanced':'สมดุล','Strong':'แข็ง','Very Strong':'แข็งมาก','偏弱':'ค่อนข้างอ่อน','偏強':'ค่อนข้างแข็ง','偏强':'ค่อนข้างแข็ง'};
function tgThai(x){ return TH_GOD[x] ? x+' · '+TH_GOD[x] : x; }
function growthThai(x){ return TH_GROWTH[x] ? x+' · '+TH_GROWTH[x] : x; }
function strengthThai(x){ return TH_STRENGTH[x] ? x+' · '+TH_STRENGTH[x] : x; }


const STEM_THAI={
 '甲':'ไม้หยาง','乙':'ไม้หยิน','丙':'ไฟหยาง','丁':'ไฟหยิน','戊':'ดินหยาง',
 '己':'ดินหยิน','庚':'ทองหยาง','辛':'ทองหยิน','壬':'น้ำหยาง','癸':'น้ำหยิน'
};
const BRANCH_THAI={
 '子':'ชวด · น้ำ','丑':'ฉลู · ดิน','寅':'ขาล · ไม้','卯':'เถาะ · ไม้',
 '辰':'มะโรง · ดิน','巳':'มะเส็ง · ไฟ','午':'มะเมีย · ไฟ','未':'มะแม · ดิน',
 '申':'วอก · ทอง','酉':'ระกา · ทอง','戌':'จอ · ดิน','亥':'กุน · น้ำ'
};
const HEALTH_MAP={
 Wood:{thai:'ไม้',yinYang:'ตับ / ถุงน้ำดี',cn:'肝・膽',traditional:'ตามทฤษฎีห้าธาตุจีนเชื่อมกับการไหลเวียน/เส้นเอ็นและดวงตา'},
 Fire:{thai:'ไฟ',yinYang:'หัวใจ / ลำไส้เล็ก',cn:'心・小腸',traditional:'ตามทฤษฎีดั้งเดิมเชื่อมกับความร้อน การไหลเวียน และจิตใจ'},
 Earth:{thai:'ดิน',yinYang:'ม้าม / กระเพาะอาหาร',cn:'脾・胃',traditional:'ตามทฤษฎีดั้งเดิมเชื่อมกับการย่อยและการแปรสภาพอาหาร'},
 Metal:{thai:'ทอง',yinYang:'ปอด / ลำไส้ใหญ่',cn:'肺・大腸',traditional:'ตามทฤษฎีดั้งเดิมเชื่อมกับการหายใจ ผิวหนัง และการขับถ่าย'},
 Water:{thai:'น้ำ',yinYang:'ไต / กระเพาะปัสสาวะ',cn:'腎・膀胱',traditional:'ตามทฤษฎีดั้งเดิมเชื่อมกับสารน้ำ การเก็บสำรอง และระบบสืบพันธุ์'}
};
function pillarThai(pair){
 const [s,b]=pair;
 return `${STEM_THAI[s]||s} / ${BRANCH_THAI[b]||b}`;
}
function healthFromAnalysis(a){
 const w=a.strength.profile.weighted;
 const sorted=Object.entries(w).sort((x,y)=>y[1]-x[1]);
 const high=sorted[0], low=sorted[sorted.length-1];
 return {
   high,low,
   summary:`ธาตุที่เด่นสุดในโมเดล: ${HEALTH_MAP[high[0]].thai} (${high[1].toFixed(1)}) · ธาตุที่ต่ำสุด: ${HEALTH_MAP[low[0]].thai} (${low[1].toFixed(1)})`,
   pattern:`นี่เป็น “pattern ตามโมเดล BaZi” เท่านั้น ไม่ได้แปลว่าอวัยวะของธาตุที่สูงหรือต่ำมีโรค ระบบจะแสดงความสัมพันธ์ตามทฤษฎีดั้งเดิมเพื่อใช้ตั้งคำถามสุขภาพ ไม่ใช้สรุปโรคหรือสั่งการรักษา`
 };
}


const BRANCH_SHORT_THAI={
 '子':'ชวด','丑':'ฉลู','寅':'ขาล','卯':'เถาะ','辰':'มะโรง','巳':'มะเส็ง',
 '午':'มะเมีย','未':'มะแม','申':'วอก','酉':'ระกา','戌':'จอ','亥':'กุน'
};
const STEM_COMBOS=[
 ['甲','己','ดิน'],['乙','庚','ทอง'],['丙','辛','น้ำ'],['丁','壬','ไม้'],['戊','癸','ไฟ']
];
const GOD_GROUPS={
 self:{title:'ตัวตน / พวกพ้อง',gods:['比肩','劫財','劫财']},
 resource:{title:'การเรียนรู้ / ผู้สนับสนุน',gods:['正印','偏印']},
 output:{title:'ความสามารถ / การแสดงออก',gods:['食神','傷官','伤官']},
 wealth:{title:'ทรัพย์ / การบริหารทรัพยากร',gods:['正財','正财','偏財','偏财']},
 power:{title:'กฎ / วินัย / แรงกดดัน',gods:['正官','七殺','七杀']}
};
function gzThai(gz){
  if(!gz || gz.length<2) return gz||'';
  return `${STEM_THAI[gz[0]]||gz[0]} + ${BRANCH_SHORT_THAI[gz[1]]||gz[1]} (${gz})`;
}
function relationThai(label){
  const chars=[...label].filter(x=>BRANCH_SHORT_THAI[x]);
  const thai=chars.map(x=>BRANCH_SHORT_THAI[x]).join(' + ');
  if(label.includes('三合')) return {group:'formations',title:'สามประสาน / ซาฮะ',detail:`${thai} รวมกลุ่มสามประสาน`,cn:label};
  if(label.includes('三會')||label.includes('三会')) return {group:'formations',title:'สามประชุมทิศ',detail:`${thai} รวมพลังตามทิศ/ฤดูกาล`,cn:label};
  if(label.includes('合')) return {group:'harmony',title:'คู่สมพงษ์ / หกประสาน',detail:`${thai} เป็นคู่ประสานกัน`,cn:label};
  if(label.includes('沖')||label.includes('冲')) return {group:'clash',title:'คู่ปะทะ',detail:`${thai} ปะทะ/ดึงคนละทิศ`,cn:label};
  if(label.includes('害')) return {group:'friction',title:'คู่เบียดเบียน',detail:`${thai} มีแรงเสียดทานแฝง`,cn:label};
  if(label.includes('破')) return {group:'friction',title:'คู่แตก/รบกวน',detail:`${thai} มีแรงรบกวนหรือแตกโครงสร้าง`,cn:label};
  if(label.includes('自刑')) return {group:'friction',title:'ลงโทษตัวเอง',detail:`${thai} ซ้ำกันเกิด self-penalty ตามตำรา`,cn:label};
  if(label.includes('刑')) return {group:'friction',title:'คู่ลงโทษ',detail:`${thai} มีแรงบีบ/ข้อจำกัดตามตำรา`,cn:label};
  return {group:'other',title:'ความสัมพันธ์อื่น',detail:thai||label,cn:label};
}
function visibleStemPairs(pillars,luck,annual,dayStem){
  const arr=[
    ['ปี',pillars.year[0]],['เดือน',pillars.month[0]],['วัน',pillars.day[0]],['ยาม',pillars.hour[0]],
    ['เสาโชค',luck[0]],['ปีจร',annual[0]]
  ];
  const combos=[];
  for(let i=0;i<arr.length;i++) for(let j=i+1;j<arr.length;j++){
    for(const [a,b,el] of STEM_COMBOS){
      if(new Set([arr[i][1],arr[j][1]]).has(a) && new Set([arr[i][1],arr[j][1]]).has(b)){
        combos.push(`${arr[i][0]} ${STEM_THAI[arr[i][1]]} + ${arr[j][0]} ${STEM_THAI[arr[j][1]]} = คู่合ก้านฟ้า → ${el}`);
      }
    }
  }
  return combos;
}
function roleGroups(pillars, luck, annual, dayStem){
  const items=[
    ['ปี',pillars.year[0]],['เดือน',pillars.month[0]],['ยาม',pillars.hour[0]],
    ['เสาโชค',luck[0]],['ปีจร',annual[0]]
  ].map(([pos,stem])=>({pos,stem,god:tenGod(dayStem,stem)}));
  const out={};
  for(const [key,g] of Object.entries(GOD_GROUPS)){
    out[key]={...g,items:items.filter(x=>g.gods.includes(x.god))};
  }
  return out;
}

// ---------- UI ----------
const $=s=>document.querySelector(s);
const ELCOLOR={Wood:'var(--wood)',Fire:'var(--fire)',Earth:'var(--earth)',Metal:'var(--metal)',Water:'var(--water)'};
const PN={year:'ปี 年',month:'เดือน 月',day:'วัน 日',hour:'ยาม 時'};
const ORDER=['year','month','day','hour'];
let current=null, luckSeq=[], selectedLuck=null;

function fillDateSelectors(){
  const d=$('#day'),m=$('#month'),y=$('#year');
  d.innerHTML=Array.from({length:31},(_,i)=>`<option value="${i+1}">${i+1}</option>`).join('');
  const monthNames=['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  m.innerHTML=monthNames.map((n,i)=>`<option value="${i+1}">${n} · ${i+1}</option>`).join('');
  const currentYear=Math.min(2100,new Date().getFullYear());
  y.innerHTML=Array.from({length:currentYear-1899},(_,i)=>currentYear-i).map(v=>`<option value="${v}">${v+543} / ${v}</option>`).join('');
  d.value='15';m.value='1';y.value='2000';
}
function syncDayOptions(){
  const day=$('#day'), selected=+day.value || 1;
  const count=new Date(Date.UTC(+$('#year').value,+$('#month').value,0)).getUTCDate();
  day.innerHTML=Array.from({length:count},(_,i)=>`<option value="${i+1}">${i+1}</option>`).join('');
  day.value=String(Math.min(selected,count));
}
function birthInput(){
  const time=$('#time').value;
  const [hour,minute]=/^\d{2}:\d{2}$/.test(time)?time.split(':').map(Number):[NaN,NaN];
  return {year:+$('#year').value,month:+$('#month').value,day:+$('#day').value,hour,minute,tzOffset:+$('#tz').value};
}
function pill(p){return p.join('')}
function chip(t,c=''){return `<span class="chip ${c}">${t}</span>`}
function render(){
  const input=birthInput(), gender=$('#gender').value;
  try{ current=calculateFourPillars(input); }
  catch(e){
    $('#inputError').textContent=e.message;
    $('#inputError').hidden=false;
    $('#results').hidden=true;
    $('#boundary').innerHTML='';
    $('#inputStatus').textContent='แก้ไขข้อมูลวันเกิดเพื่อแสดงผลใหม่';
    return false;
  }
  $('#inputError').hidden=true;
  $('#results').hidden=false;
  $('#inputStatus').textContent=`คำนวณจาก ${input.day}/${input.month}/${input.year+543} (${input.year}) เวลา ${String(input.hour).padStart(2,'0')}:${String(input.minute).padStart(2,'0')} · UTC${input.tzOffset>=0?'+':''}${input.tzOffset} · ข้อมูลอยู่ในหน้านี้เท่านั้น`;
  luckSeq=generateLuckPillars(pill(current.pillars.month),current.pillars.year[0],gender,9);
  if(!selectedLuck || !luckSeq.includes(selectedLuck)) selectedLuck=luckSeq[0];
  const annual=$('#annual').value || yearPillarFromSolarYear(2026);
  const a=analyzeChart(current.pillars,selectedLuck,annual);
  $('#dm').textContent=a.dayStem+(ELEMENT_THAI[a.dayElement]||a.dayElement);
  $('#dmMeta').textContent=STEMS[a.dayStem].polarity+' '+a.dayElement+' · '+pill(current.pillars.month)+'月';
  $('#strength').textContent=a.strength.score+'/100'; $('#strengthBar').style.width=a.strength.score+'%'; $('#strengthLabel').textContent=strengthThai(a.strength.label);
  $('#structure').textContent=a.structure.primaryStructure; $('#flags').innerHTML=(a.structure.flags.length?a.structure.flags:['ไม่มี flag หลัก']).map(x=>chip(x,'warn')).join(' ');
  $('#longitude').textContent=current.solarLongitude.toFixed(3)+'°';
  $('#pillars').innerHTML=ORDER.map(k=>{ const [s,b]=current.pillars[k]; const god=k==='day'?'日主 · เจ้าชะตา':tgThai(tenGod(a.dayStem,s)); const hidden=a.hidden[k].map(x=>x.stem+' '+tgThai(x.god)).join(' · ');
    return `<div class="pillar ${k==='day'?'active':''}"><div class="eyebrow">${PN[k]}</div><div class="thai-main" style="font-size:19px;margin-top:8px">${pillarThai([s,b])}</div><div class="hz">${s}${b}</div><div class="cn-sub">อักษรจีนสำหรับอ้างอิงตำรา</div><div class="god">${god}</div><div class="subline">12 ระยะพลังชีวิต · ${growthThai(a.growth[k])}<br>ธาตุซ่อน · 藏干<br>${hidden}</div></div>`; }).join('');
  const w=a.strength.profile.weighted, mx=Math.max(...Object.values(w));
  $('#elements').innerHTML=Object.entries(w).map(([el,v])=>`<div class="element"><div class="el-head"><span>${ELEMENT_THAI[el]} · ${el}</span><span>${v.toFixed(1)}</span></div><div class="elbar"><i style="width:${Math.round(v/mx*100)}%;background:${ELCOLOR[el]}"></i></div></div>`).join('');
  $('#healthElements').innerHTML=$('#elements').innerHTML;
  const ints=[...a.strength.interactions.clashes,...a.strength.interactions.combos,...a.strength.interactions.extended.map(x=>x.label)];
  $('#interactions').innerHTML=ints.length?ints.map(x=>{const r=relationThai(x);return chip(r.title+' · '+r.detail, (x.includes('沖')||x.includes('冲')||x.includes('刑'))?'warn':'')}).join(''):'<span class="hint">ยังไม่พบความสัมพันธ์หลักในดวงเดิม</span>';
  $('#audit').innerHTML=a.strength.audit.map(x=>`<tr><td><b>${x[0]}</b></td><td>${x[1]}</td><td>${x[2]}</td></tr>`).join('');
  const u=a.useful, bp=u.balance.priority.map(x=>ELEMENT_THAI[x]||x).join(' → '), cp=u.climate.priority.map(x=>x.rank+'. '+x.stem+' '+x.reason).join('<br>')||'ยังไม่มี classical rule';
  $('#useful').innerHTML=`${u.conflict?'<div class="alert"><b>Rule Conflict Detected</b><br>扶抑 และ 調候 ให้ priority คนละทิศ จึงไม่ merge อัตโนมัติ</div>':''}<div class="lenses" style="margin-top:10px"><div class="lens"><div class="eyebrow">扶抑</div><b>${bp}</b><div class="hint">${u.balance.explanation}</div></div><div class="lens"><div class="eyebrow">調候</div><b>${u.climate.title}</b><div class="hint">${cp}</div></div></div>`;
  const ls=calculateLuckStart(input,gender,current.pillars);
  $('#luckStart').textContent=ls?`${ls.direction===1?'順行':'逆行'} · 起運 ≈ ${ls.startAge.years} ปี ${ls.startAge.months} เดือน ${ls.startAge.days} วัน`:'—';
  $('#luckStrip').innerHTML=luckSeq.map((p,i)=>`<button class="luck ${p===selectedLuck?'active':''}" data-p="${p}"><span>${i+1}</span><b>${p}</b><div style="font-size:10px;line-height:1.35;margin-top:4px">${gzThai(p)}</div></button>`).join('');
  document.querySelectorAll('.luck').forEach(b=>b.onclick=()=>{selectedLuck=b.dataset.p;render()});
  const ti=[...a.transit.interactions.clashes,...a.transit.interactions.combos,...a.transit.interactions.extended.map(x=>x.label)];
  $('#transit').innerHTML=`<b>เสาโชค: ${gzThai(selectedLuck)}<br>ปีจร: ${gzThai(annual)}</b><div class="chips" style="margin-top:8px">${a.transit.repeat?chip(a.transit.repeat+' · กิ่งซ้ำกับดวงเดิม','warn'):''}${ti.map(x=>{const r=relationThai(x);return chip(r.title+' · '+r.detail)}).join('')}</div>`;

  const hp=healthFromAnalysis(a);
  $('#healthSummary').innerHTML=`<b>${hp.summary}</b><br><span class="hint">ไม่ตีความว่า “ธาตุขาด = เป็นโรค” หรือ “ธาตุเกิน = อวัยวะเสีย”</span>`;
  $('#healthOrgans').innerHTML=Object.entries(HEALTH_MAP).map(([el,h])=>{
    const score=a.strength.profile.weighted[el];
    return `<div class="health-organ"><b>${h.thai} · ${h.yinYang}</b><div class="cn-sub">${h.cn}</div><div class="health-note">${h.traditional}</div><div class="small" style="margin-top:7px">คะแนนโมเดล ${score.toFixed(1)}</div></div>`;
  }).join('');
  $('#healthPattern').textContent=hp.pattern;

  const natalBasic=a.strength.interactions;
  const allRel=[
    ...natalBasic.clashes,...natalBasic.combos,...natalBasic.extended.map(x=>x.label),
    ...a.transit.interactions.clashes,...a.transit.interactions.combos,...a.transit.interactions.extended.map(x=>x.label)
  ];
  const relSeen=[...new Set(allRel)].map(relationThai);
  const buckets={
    harmony:{title:'คู่สมพงษ์ / 六合',items:[]},
    formations:{title:'ซาฮะ / กลุ่มสามประสาน',items:[]},
    clash:{title:'คู่ปะทะ / 沖',items:[]},
    friction:{title:'刑 · 害 · 破',items:[]}
  };
  relSeen.forEach(r=>{ if(buckets[r.group]) buckets[r.group].items.push(r); });
  const stemPairs=visibleStemPairs(current.pillars,selectedLuck,annual,a.dayStem);
  buckets.harmony.items.push(...stemPairs.map(x=>({title:'คู่ก้านฟ้าสมพงษ์',detail:x,cn:'天干五合'})));
  $('#relationSummary').innerHTML=Object.values(buckets).map(g=>`<div class="rel-group"><h3>${g.title}</h3>${g.items.length?g.items.map(r=>`<div class="rel-item"><span class="rel-th">${r.title}</span><br>${r.detail}<br><span class="rel-cn">${r.cn}</span></div>`).join(''):'<div class="hint">ยังไม่พบคู่ในกลุ่มนี้</div>'}</div>`).join('');
  const roles=roleGroups(current.pillars,selectedLuck,annual,a.dayStem);
  $('#starGroups').innerHTML=Object.values(roles).map(g=>`<div class="star-group"><b>${g.title}</b>${g.items.length?g.items.map(x=>`<span class="mini-pill">${x.pos}: ${STEM_THAI[x.stem]} · ${tgThai(x.god)}</span>`).join(''):'<span class="hint">ไม่เด่นในชุดที่เลือก</span>'}</div>`).join('');


  $('#boundary').innerHTML=current.nearBoundary?'<div class="alert">เกิดใกล้節氣 boundary — ควร verify ด้วย ephemeris ความละเอียดสูง</div>':'';
}
function setSample(){
  $('#year').value='2000';$('#month').value='1';syncDayOptions();$('#day').value='15';
  $('#time').value='12:00';$('#gender').value='female';$('#tz').value='7';selectedLuck=null;render();
  $('#inputStatus').textContent='ตัวอย่างสมมุติ · '+$('#inputStatus').textContent;
}
function activateTab(name,focus=false){
  if(!['bazi','health'].includes(name)) return;
  for(const key of ['bazi','health']){
    const active=key===name, tab=$('#tab-'+key);
    tab.setAttribute('aria-selected',String(active));
    tab.tabIndex=active?0:-1;
    $('#panel-'+key).hidden=!active;
    if(active && focus) tab.focus();
  }
}
fillDateSelectors();
const annualYear=new Date().getFullYear();
$('#annual').innerHTML=Array.from({length:36},(_,i)=>annualYear-10+i).map(y=>`<option value="${yearPillarFromSolarYear(y)}" ${y===annualYear?'selected':''}>${y+543} / ${y} · ${yearPillarFromSolarYear(y)}</option>`).join('');
$('#calc').onclick=()=>{selectedLuck=null;render()};
$('#sample').onclick=setSample;
$('#annual').onchange=render;
for(const id of ['day','month','year','time','gender','tz']){
  $('#'+id).onchange=()=>{if(id==='month'||id==='year') syncDayOptions();selectedLuck=null;render();};
}
for(const name of ['bazi','health']){
  const tab=$('#tab-'+name);
  tab.onclick=()=>activateTab(name);
  tab.onkeydown=event=>{
    if(!['ArrowRight','ArrowLeft','Home','End'].includes(event.key)) return;
    event.preventDefault();
    activateTab(event.key==='Home'?'bazi':event.key==='End'?'health':name==='bazi'?'health':'bazi',true);
  };
}
setSample();
