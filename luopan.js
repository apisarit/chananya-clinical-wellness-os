
  (()=>{
    function createDateEngine(A,S,M,LUNAR){
  const mod=(n,m=360)=>(n%m+m)%m;
  const stems='甲乙丙丁戊己庚辛壬癸'.split(''),branches='子丑寅卯辰巳午未申酉戌亥'.split('');
  const signs=S.thaiSigns.map(r=>r[1]),names=S.planets.map(r=>r[1]);
  const weekdays=['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'];
  const months=['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  const jd0=(y,m,d)=>Date.UTC(y,m-1,d)/864e5+2440588;
  const dt=(label,value)=>({label,value:String(value??'—')});
  const degree=n=>mod(n,30).toFixed(2)+'°';
  const entry=(a,span,label,title,details=[])=>({a:mod(a),span,label,short:Array.isArray(label)?label.join(' / '):label,title,details,ref:S.file});
  function parse(value,tz=7){
    const match=value.trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})[ T]+(\d{1,2})[:.](\d{2})$/);
    if(!match)throw Error('ใช้รูปแบบ 29/10/2530 22.19 หรือ 29/10/1987 22:19');
    const [d,m,raw,h,min]=match.slice(1).map(Number),y=raw>=2400?raw-543:raw;
    const date=new Date(Date.UTC(y,m-1,d,h,min));
    if(y<1900||y>2100||m<1||m>12||date.getUTCDate()!==d||date.getUTCMonth()!==m-1||h>23||min>59||!Number.isFinite(tz)||tz< -12||tz>14)throw Error('ตรวจวัน เดือน ปี และเวลา: รองรับ ค.ศ. 1900–2100 / พ.ศ. 2443–2643');
    return {y,m,d,h,min,tz,utc:new Date(date.valueOf()-tz*36e5),civil:date};
  }
  function lunarAt(jd){
    let lo=0,hi=LUNAR.length-1;
    while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(LUNAR[mid][0]<=jd)lo=mid;else hi=mid-1;}
    const r=LUNAR[lo],day=r[2]+jd-r[0];
    return {month:r[1],day,cs:r[3],animal:r[4],leap:!!r[5],text:(day<=15?'ขึ้น '+day:'แรม '+(day-15))+' ค่ำ เดือน '+(r[1]===88?'8 หลัง':r[1])};
  }
  function calculate(input,options={}){
    const p=typeof input==='string'?parse(input,Number(options.tz??7)):input;
    const jd=p.utc.valueOf()/864e5+2440587.5,T=(jd-2451545)/36525;
    const solar=A.SunPosition(p.utc).elon;
    // Approximation to Lahiri; retained as an explicitly named comparison convention.
    const ayan=23.857092353+1.396971278*T+0.0003086*T*T;
    const planetBodies=['Sun','Moon','Mars','Mercury','Jupiter','Venus','Saturn'];
    const longitudes=planetBodies.map(body=>mod(A.Ecliptic(A.GeoVector(body,p.utc,true)).elon-ayan));
    longitudes.push(mod(125.04452-1934.136261*T+0.0020708*T*T+T*T*T/450000-ayan));
    const solarYear=p.m<=2&&solar>=270&&solar<315?p.y-1:p.y;
    const yi=mod(solarYear-1984,60),mi=Math.floor(mod(solar-315)/30);
    const dayShift=options.dayBoundary==='23'&&p.h>=23?1:0;
    const di=mod(jd0(p.y,p.m,p.d)+49+dayShift,60),bi=Math.floor(mod(p.h+1,24)/2);
    const pillars=[stems[yi%10]+branches[yi%12],stems[(2+2*(yi%10)+mi)%10]+branches[(mi+2)%12],stems[di%10]+branches[di%12],stems[(2*(di%10%5)+bi)%10]+branches[bi]];
    const dm=di%10,clockAngle=(p.h%12+p.min/60)*30;
    const lunar=lunarAt(jd0(p.y,p.m,p.d));
    const lunarAngle=lunar.month===88?null:mod((lunar.month-4)*30+lunar.day-16);
    const seasonIndex=lunarAngle===null?null:Math.floor(lunarAngle/20);
    const year=p.m>=4?p.y:p.y-1,begin=Date.UTC(year,3,1),end=Date.UTC(year+1,3,1);
    const anchor=(p.civil.valueOf()-begin)/(end-begin)*360;
    const latitude=options.latitude===''||options.latitude==null?null:Number(options.latitude);
    const longitude=options.longitude===''||options.longitude==null?null:Number(options.longitude);
    let asc=null;
    if(latitude!==null||longitude!==null){
      if(latitude===null||longitude===null||!Number.isFinite(latitude)||!Number.isFinite(longitude)||Math.abs(latitude)>66||Math.abs(longitude)>180)throw Error('กรอกทั้งละติจูด (−66 ถึง 66) และลองจิจูด (−180 ถึง 180)');
      const theta=mod(A.SiderealTime(p.utc)*15+longitude)*Math.PI/180,epsilon=A.e_tilt(A.MakeTime(p.utc)).tobl*Math.PI/180,phi=latitude*Math.PI/180;
      let lambda=Math.atan2(-Math.cos(theta),Math.sin(theta)*Math.cos(epsilon)+Math.tan(phi)*Math.sin(epsilon));
      const rising=-Math.sin(theta)*Math.cos(lambda)+Math.cos(theta)*Math.sin(lambda)*Math.cos(epsilon);
      if(rising<0)lambda+=Math.PI;
      asc=mod(lambda*180/Math.PI-ayan);
    }
    const astroDay=new Date(Date.UTC(p.y,p.m-1,p.d)-(p.h<6?864e5:0)).getUTCDay();
    const dayPlanet=astroDay===3&&(p.h>=18||p.h<6)?8:[1,2,3,4,5,6,7][astroDay];
    const takCycle=[1,2,3,4,7,5,8,6],takRoles=['บริวาร','อายุ','เดช','ศรี','มูละ','อุตสาหะ','มนตรี','กาลกิณี'];
    const tak=Object.fromEntries(takCycle.map((n,i)=>[n,takRoles[mod(i-takCycle.indexOf(dayPlanet),8)]]));
    const houseFor=si=>asc===null?null:mod(si-Math.floor(asc/30),12);
    function dignity(pi,si){
      const r=S.planets[pi],out=[];
      if(S.thaiSigns[si][5]===pi+1)out.push('เกษตร');
      if(S.thaiSigns[mod(si+6,12)][5]===pi+1)out.push('ประ');
      if(r[5]===si+1)out.push('อุจจ์');if(r[6]===si+1)out.push('นิจ');return out.join(' / ')||'—';
    }
    const planetDetails=longitudes.map((lon,i)=>{
      const si=Math.floor(lon/30),house=houseFor(si);
      return {number:i+1,name:names[i],longitude:lon,sign:signs[si],signIndex:si,degree:degree(lon),house:house===null?'รอสถานที่เกิด':S.houses[house][1],taksa:tak[i+1],dignity:dignity(i,si)};
    });
    return {p,solar,ayan,longitudes,planetDetails,asc,pillars,dm,clockAngle,lunar,lunarAngle,seasonIndex,anchor,year,begin,end,tak,dayPlanet,weekday:weekdays[p.civil.getUTCDay()],astroWeekday:dayPlanet===8?'พุธกลางคืน':weekdays[astroDay],houseFor,dignity,dayBoundary:options.dayBoundary||'00'};
  }
  function project(c){
    const layers=JSON.parse(JSON.stringify(M.layers));
    const by=Object.fromEntries(layers.map(l=>[l.id,l]));
    const angleTime=c.anchor-c.clockAngle,angleThai=c.anchor-c.longitudes[0],angleStem=c.anchor-(c.dm*36+18);
    const gods=S.godMatrix[c.dm],godNames=Object.fromEntries(S.godNames.map(r=>[r[0],r[2]]));
    const stemInfo=s=>{const r=S.stems[stems.indexOf(s)];return s+' '+r[5];};
    const god=s=>gods[stems.indexOf(s)]+' '+godNames[gods[stems.indexOf(s)]];
    layers.forEach(l=>{
      l.rotation=l.group===1?angleTime:l.group===2?angleThai:l.group===3?(c.lunarAngle===null?0:c.anchor-c.lunarAngle):l.group===4?angleStem:0;
      l.status=l.group===0?'วงทิศอ้างอิง':l.group===3&&c.lunarAngle===null?'เดือน 8 หลัง: รอเกณฑ์ฤดูอธิกมาส':'ตั้งจากวันเวลา';
      l.basis=l.group===0?l.basis:l.basis+' · หมุนจุดเริ่มเพื่อเทียบด้วยเข็มเดียว';
    });
    const signDetail=si=>{
      const lord=S.thaiSigns[si][5],pl=c.planetDetails[lord-1],hi=c.houseFor(si);
      return [dt('ราศี / ธาตุ',signs[si]+' / '+S.thaiSigns[si][2]),dt('เจ้าเรือน',lord+' '+names[lord-1]),dt('ภพกำเนิด',hi===null?'รอสถานที่เกิด':(hi+1)+' '+S.houses[hi][1]),dt('เจ้าเรือนอยู่',pl.sign+' '+pl.degree+' / ภพ '+pl.house),dt('ทักษาของเจ้าเรือน',pl.taksa),dt('เกณฑ์ตำแหน่งดาว','ดาราศาสตร์สมัยใหม่ + ลาหิรีประมาณ; ไม่ใช่สมผุสสุริยยาตร์'),...c.planetDetails.filter(p=>p.signIndex===si).map(p=>dt(p.number+' '+p.name,p.degree+' · '+p.dignity+' · ทักษา '+p.taksa))];
    };
    for(const id of ['zodiac','thai-elements','rulers','dignities'])by[id].entries.forEach((e,i)=>{e.details=signDetail(i);e.ref='คำนวณจากวันเวลาที่กรอก · '+S.file;});
    by.rulers.entries.forEach((e,i)=>{const lord=S.thaiSigns[i][5];e.details.push(...S.thaiPairs.filter(r=>r[1]===lord||r[2]===lord).map(r=>dt(r[3],r[4])));});
    by.houses.entries=Array.from({length:12},(_,i)=>{
      const si=mod((c.asc===null?0:Math.floor(c.asc/30))+i,12),h=S.houses[i];
      return entry(si*30,30,h[1],c.asc===null?'ภพอ้างอิง '+(i+1)+' '+h[1]+' · ยังไม่ผูกลัคนา':(i+1)+' '+h[1]+' / '+signs[si],[dt('สถานะ',c.asc===null?'วงภพอ้างอิงเทียบเมษ เพื่อสำรวจชื่อและความหมาย; ยังไม่ใช่ภพกำเนิด':'ภพแบบราศี จากลัคนา '+signs[Math.floor(c.asc/30)]+' '+degree(c.asc)),dt('ความหมายภพ',h[8]),...(c.asc===null?[]:signDetail(si))]);
    });
    by.houses.status=c.asc===null?'รอสถานที่เกิด':'คำนวณจากลัคนา';
    by.houses.name=c.asc===null?'ภพ 12 · วงอ้างอิง':'ภพกำเนิด 12';
    by.houses.basis='ภพแบบราศี · '+(c.asc===null?'วงอ้างอิงเทียบเมษ; ยังไม่ระบุลัคนากำเนิด':signs[Math.floor(c.asc/30)]+' '+degree(c.asc));
    by.stems.entries.forEach((e,i)=>{const r=S.stems[i];e.details=[dt('ก้านฟ้า',stemInfo(stems[i])),dt('Day Master',stemInfo(stems[c.dm])),dt('สิบเทพ',god(stems[i])),dt('ส่งเสริม / รับจาก',r[6]+' / '+r[7]),dt('ข่ม / ถูกข่มโดย',r[8]+' / '+r[9])];});
    by['ten-gods'].name='สิบเทพต่อ '+stems[c.dm];by['ten-gods'].basis='Day Master จากวันเกิด: '+stemInfo(stems[c.dm]);
    by['ten-gods'].entries.forEach((e,i)=>{e.label=e.short=gods[i];e.title=stems[i]+' → '+stemInfo(stems[c.dm])+' · '+god(stems[i]);e.details=[dt('Day Master',stemInfo(stems[c.dm])),dt('ก้านที่เทียบ',stemInfo(stems[i])),dt('สิบเทพ',god(stems[i]))];});
    for(const id of ['branches','hidden'])by[id].entries.forEach((e,i)=>{
      const selected=[S.branches[(i+6)%12],S.branches[i]];
      e.details=selected.flatMap(r=>[dt('กิ่งดิน',r[1]+' '+r[2]+' '+r[3]),dt('ก้านฟ้าแฝง',[r[7],r[9],r[11]].filter(Boolean).map(s=>stemInfo(s)+' → '+god(s)).join(' / '))]);
      e.details.push(dt('ยามกำเนิดจริง',c.pillars[3]+' · '+c.p.h.toString().padStart(2,'0')+':'+c.p.min.toString().padStart(2,'0')));
    });
    const calendar={id:'calendar',name:'เดือน · เม.ย. → มี.ค.',group:0,rotation:0,status:'พิกัดวงปี',basis:'0° = 1 เม.ย. '+(c.year+543)+' · ช่องตามจำนวนวันจริง',entries:[]};
    for(let i=0;i<12;i++){const start=Date.UTC(c.year,3+i,1),end=Date.UTC(c.year,4+i,1),m=(3+i)%12;calendar.entries.push(entry((start-c.begin)/(c.end-c.begin)*360,(end-start)/(c.end-c.begin)*360,months[m],months[m]+' '+(new Date(start).getUTCFullYear()+543),[dt('วันในเดือน',(end-start)/864e5)]));}
    const planetary={id:'planetary',name:'ดาวกำเนิด 8',group:2,rotation:angleThai,status:'คำนวณจากวันเวลา',basis:'ราหูใช้จุดโหนดเฉลี่ย · ลาหิรีประมาณ',entries:Array.from({length:12},(_,i)=>{
      const ps=c.planetDetails.filter(p=>p.signIndex===i);
      return entry(i*30,30,ps.map(p=>p.number).join(' ')||'—',signs[i]+' · '+(ps.map(p=>p.name).join(' / ')||'ไม่มีดาวในตารางนี้'),ps.map(p=>dt(p.number+' '+p.name,p.degree+' · '+p.dignity+' · ทักษา '+p.taksa)));
    })};
    const pillarLayer={id:'pillars',name:'BaZi · ปี เดือน วัน ยาม',group:4,rotation:c.anchor-225,status:'ข้อมูลกำเนิดคงเดิม',basis:'BaZi: ปีและเดือนตาม節 · วันเปลี่ยน '+c.dayBoundary+':00 · เวลาท้องถิ่น UTC'+(c.p.tz>=0?'+':'')+c.p.tz,entries:c.pillars.map((p,i)=>{
      const r=S.branches[branches.indexOf(p[1])],name=['ปี','เดือน','วัน','ยาม'][i];
      return entry(i*90,90,[name,p],name+' '+p,[dt('ก้านฟ้า',stemInfo(p[0])),dt('กิ่งดิน',p[1]+' '+r[2]+' '+r[3]),dt('สิบเทพก้านฟ้า',i===2?'Day Master':god(p[0])),dt('ก้านฟ้าแฝง',[r[7],r[9],r[11]].filter(Boolean).map(s=>stemInfo(s)+' → '+god(s)).join(' / '))]);
    })};
    const order=['calendar','directions','mountains','zodiac','thai-elements','rulers','houses','dignities','planetary','seasons','season-main','season-mix','stems','ten-gods','wuxing','pillars','branches','hidden','hours','tri','tu','eka','kala'];
    layers.push(calendar,planetary,pillarLayer);layers.sort((a,b)=>order.indexOf(a.id)-order.indexOf(b.id));
    const branchCounts={};c.pillars.forEach(p=>branchCounts[p[1]]=(branchCounts[p[1]]||0)+1);
    const relations=S.chineseRelations.filter(r=>{
      const chars=String(r[2]).match(/[子丑寅卯辰巳午未申酉戌亥]/g);if(!chars?.length)return false;
      const need={};chars.forEach(k=>need[k]=(need[k]||0)+1);return Object.entries(need).every(([k,n])=>(branchCounts[k]||0)>=n);
    }).map(r=>r[1]+' '+r[2]+' · '+(r[4]||r[5]||''));
    return {layers,c,relations,stemDescription:stemInfo(stems[c.dm]),solarSign:signs[Math.floor(c.longitudes[0]/30)]};
  }
  function read(projection,angle){return projection.layers.map(l=>{
    const local=mod(angle-l.rotation),e=l.entries.find(e=>mod(local-e.a)<e.span)||l.entries[0];
    return {layer:l,entry:e,localAngle:local};
  });}
  return {parse,calculate,project,read,mod,months,signs};
}
    const root=document.getElementById('luopan-birthdate-ray');
    const q=id=>root.querySelector('#'+id),data=window.LuopanKnowledgeV1;
    const engine=createDateEngine(Astronomy,data.source,data.model,data.lunar);
    const svg=q('lr-svg'),input=q('lr-birth'),slider=q('lr-angle');
    const colors=[1,2,3,4,5].map(i=>'var(--viz-series-'+i+')');
    const NS='http://www.w3.org/2000/svg';
    let projection=null,angle=0,center=0,R=0,core=0,hole=0,geometry=[],paths=[],needle=null,dots=[],dragging=false,frame=null,detailBlocks=[];
    const add=(tag,attrs,parent=svg)=>{const el=document.createElementNS(NS,tag);for(const [k,v] of Object.entries(attrs))el.setAttribute(k,String(v));parent.appendChild(el);if(attrs['data-tooltip']){const title=document.createElementNS(NS,'title');title.textContent=attrs['data-tooltip'];el.appendChild(title);}return el;};
    const point=(r,a)=>[center+r*Math.sin(a*Math.PI/180),center-r*Math.cos(a*Math.PI/180)];
    const label=(str,x,y,attrs={})=>{const e=add('text',{x,y,'text-anchor':'middle',...attrs});e.textContent=str;return e;};
    function arc(inner,outer,start,span){const a=point(outer,start),b=point(outer,start+span),c=point(inner,start+span),d=point(inner,start);return 'M'+a.join(',')+' A'+outer+','+outer+' 0 '+(span>180?1:0)+' 1 '+b.join(',')+' L'+c.join(',')+' A'+inner+','+inner+' 0 '+(span>180?1:0)+' 0 '+d.join(',')+' Z';}
    function tangent(str,r,a,available){
      const p=point(r,a),rotation=engine.mod(a)>90&&engine.mod(a)<270?a+180:a;
      const e=label(str,p[0],p[1]+4,{transform:'rotate('+rotation+' '+p.join(' ')+')'});
      if(e.getBBox().width>available)e.remove();
    }
    function rows(target,dataRows){target.replaceChildren();for(const r of dataRows){const tr=document.createElement('tr'),th=document.createElement('th'),td=document.createElement('td');th.scope='row';th.textContent=r.label;td.textContent=r.value;tr.append(th,td);target.appendChild(tr);}}
    const asText=e=>Array.isArray(e.label)?e.label.join(' / '):e.label;
    function readout(){
      const all=engine.read(projection,angle),by=Object.fromEntries(all.map(x=>[x.layer.id,x]));
      const atBirth=Math.abs(engine.mod(angle-projection.c.anchor+180)-180)<0.05;
      const dateMs=projection.c.begin+angle/360*(projection.c.end-projection.c.begin),date=new Date(dateMs);
      const refDate=date.getUTCDate()+'/'+(date.getUTCMonth()+1)+'/'+(date.getUTCFullYear()+543);
      const fmt=x=>asText(by[x].entry);
      rows(q('lr-quick'),[
        {label:'ภพ / ราศี',value:(projection.c.asc===null?'ภพอ้างอิง: ':'')+fmt('houses')+' · '+fmt('zodiac')},
        {label:'กาลสมุฏฐาน',value:fmt('kala')},
        {label:'ฤดู / ตัวหลัก',value:projection.c.seasonIndex===null?'เดือน 8 หลัง: รอเกณฑ์ฤดูพิสดาร':fmt('seasons')+' · '+fmt('season-main')},
        {label:'ระคน / จำนวนส่วน',value:projection.c.seasonIndex===null?'รอเกณฑ์อธิกมาส':fmt('season-mix')},
        {label:'กิ่งดิน / ก้านฟ้า',value:fmt('branches')+' · '+fmt('stems')+' · '+fmt('ten-gods')},
        {label:'Wuxing · ส่งเสริม / ข่ม',value:by.wuxing.entry.title+' · '+by.wuxing.entry.details.filter(d=>d.label==='ส่งเสริม →'||d.label==='ข่ม →').map(d=>d.label+' '+d.value).join(' / ')}
      ]);
      q('lr-state').textContent=atBirth?'เข็มที่จุดวันเกิด · ทุกวงตั้งแนวเทียบจากวันเวลาที่กรอก':'สำรวจช่องวง · สเกลวัน '+refDate+' · ข้อมูลกำเนิดคงเดิม';
      q('lr-angle-label').textContent=angle.toFixed(1)+'°';slider.value=angle.toFixed(1);
      const allNode=q('lr-all');
      all.forEach((r,i)=>{
        if(!detailBlocks[i]){
          const det=document.createElement('details'),sum=document.createElement('summary'),table=document.createElement('table'),body=document.createElement('tbody');
          det.className='lr-details';table.className='table table-sm';table.appendChild(body);det.append(sum,table);allNode.appendChild(det);detailBlocks[i]={det,sum,body,entry:null};
        }
        const block=detailBlocks[i];if(block.entry===r.entry)return;
        const {sum,body}=block;
        sum.textContent=String(i+1).padStart(2,'0')+' '+r.layer.name+' · '+r.entry.title;
        rows(body,[{label:'สถานะ',value:r.layer.status},{label:'พิกัด',value:r.layer.basis},...r.entry.details,{label:'ที่มา',value:r.entry.ref}]);block.entry=r.entry;
      });
      svg.setAttribute('aria-label','เข็ม '+angle.toFixed(1)+' องศา ผ่าน '+by.kala.entry.title+' · ราศี '+fmt('zodiac')+' · '+(projection.c.asc===null?'ยังไม่ระบุลัคนา':fmt('houses')));
    }
    function paintNeedle(){
      const states=engine.read(projection,angle);
      paths.forEach((group,i)=>group.forEach((p,j)=>p.setAttribute('fill-opacity',states[i].entry===projection.layers[i].entries[j]?0.58:(j%2?0.12:0.2))));
      const start=point(hole+2,angle),end=point(R+2,angle);
      needle.setAttribute('x1',start[0]);needle.setAttribute('y1',start[1]);needle.setAttribute('x2',end[0]);needle.setAttribute('y2',end[1]);
      dots.forEach((dot,i)=>{const p=point(i===dots.length-1?R+2:(geometry[i].inner+geometry[i].outer)/2,angle);dot.setAttribute('cx',p[0]);dot.setAttribute('cy',p[1]);});
    }
    function draw(){
      if(!projection)return;
      const w=Math.max(280,Math.floor(root.getBoundingClientRect().width));center=w/2;R=center-12;core=w>=560?132:76;hole=w>=560?47:35;
      svg.setAttribute('viewBox','0 0 '+w+' '+w);svg.setAttribute('width',w);svg.setAttribute('height',w);
      Array.from(svg.children).filter(x=>!['title','desc'].includes(x.localName)).forEach(x=>x.remove());
      geometry=[];paths=[];dots=[];let outer=R;
      const emphasis=w>=560?['calendar','zodiac','houses','pillars','branches']:['calendar','zodiac','houses'];
      const wide=w>=560?24:w>=320?18:16,normal=(R-core-emphasis.length*wide)/(22-emphasis.length);
      projection.layers.forEach((l,li)=>{
        const isCore=l.id==='kala',width=emphasis.includes(l.id)?wide:normal,inner=isCore?hole:outer-width;
        geometry.push({inner,outer});const group=[];
        l.entries.forEach((e,ei)=>{
          const a=e.a+l.rotation,color=isCore?colors[[4,1,0][ei]]:colors[l.group];
          group.push(add('path',{d:arc(inner,outer,a,e.span),fill:color,'fill-opacity':0.2,stroke:'var(--border)','stroke-width':0.65,'data-tooltip':l.name+' · '+e.title,'data-layer':l.id,'data-entry':ei}));
          if(isCore){const p=point(hole+(outer-hole)*0.55,a+e.span/2);label(e.short,p[0],p[1]+4,{'class':'lr-medium'});}
          else if(width>=16){const r=(inner+outer)/2,txt=l.id==='pillars'?e.label.join(' '):e.short;tangent(txt,r,a+e.span/2,r*e.span*Math.PI/180-8);}
        });
        paths.push(group);outer=inner;
      });
      const rotation=projection.layers.at(-1).rotation;
      for(let h=0;h<12;h++)if(w>=560||[2,6,10].includes(h)){const p=point(core-9,h*30+rotation);label(h===0?'12':h,p[0],p[1]+4);}
      label('กาลสมุฏฐาน',center,center-14,{'class':'lr-medium'});label('12 ชม. × 2',center,center+5);label(projection.c.p.h.toString().padStart(2,'0')+':'+projection.c.p.min.toString().padStart(2,'0'),center,center+24);
      needle=add('line',{stroke:'var(--foreground)','stroke-width':1.7,'pointer-events':'none'});
      geometry.slice(0,-1).forEach(()=>dots.push(add('circle',{r:w>=560?2.3:1.3,fill:'var(--foreground)','pointer-events':'none'})));
      dots.push(add('circle',{r:6,fill:'var(--foreground)','data-tooltip':'ลากเข็มอ่านทุกชั้น'}));
      paintNeedle();
    }
    function setAngle(a){angle=engine.mod(a);if(frame!==null)cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{paintNeedle();readout();frame=null;});}
    function profile(){
      const c=projection.c,p=c.p,kala=engine.read(projection,c.anchor).find(x=>x.layer.id==='kala').entry;
      q('lr-natal').textContent=p.d+'/'+p.m+'/'+(p.y+543)+' '+String(p.h).padStart(2,'0')+':'+String(p.min).padStart(2,'0')+' · วัน'+c.weekday+' · '+c.lunar.text+' · '+kala.short;
      q('lr-pillars').textContent=c.pillars.map((x,i)=>['ปี','เดือน','วัน','ยาม'][i]+' '+x).join('  ·  ')+'  |  Day Master '+projection.stemDescription;
      const rowsOut=[
        {label:'กาลกำเนิด',value:kala.title},{label:'BaZi กำเนิด',value:c.pillars.join(' · ')},{label:'Day Master',value:projection.stemDescription},{label:'สัมพันธ์กิ่งดินที่มีสมาชิกครบ',value:projection.relations.join(' | ')||'ไม่พบชุดที่มีสมาชิกครบตามตารางเดิม'},
        {label:'จันทรคติไทย',value:c.lunar.text+' จ.ศ. '+c.lunar.cs},{label:'ฤดูพิสดารกำเนิด',value:c.seasonIndex===null?'เดือน 8 หลัง: รอเกณฑ์อธิกมาส':data.source.seasons[c.seasonIndex][1]+' ช่วง '+data.source.seasons[c.seasonIndex][2]+' · '+data.source.seasons[c.seasonIndex][11]},
        {label:'ลัคนา',value:c.asc===null?'รอสถานที่เกิด':engine.signs[Math.floor(c.asc/30)]+' '+engine.mod(c.asc,30).toFixed(2)+'°'},
        {label:'วันทักษา',value:c.astroWeekday+' · เกณฑ์ 06:00 / 18:00 โดยประมาณ'},
        ...c.planetDetails.map(p=>({label:p.number+' '+p.name,value:p.sign+' '+p.degree+' · ภพ '+p.house+' · '+p.dignity+' · ทักษา '+p.taksa})),
        {label:'วงปี',value:'1 เมษายน–31 มีนาคม · ช่องเดือนตามวันจริง'},
        {label:'เข็มร่วม',value:'วันเกิดใช้ตั้งแนวเทียบของแต่ละวง; การลากเข็มคือสำรวจสเกลเดิม ไม่เปลี่ยนวันเกิด และไม่ใช่การคำนวณดวงจร'},
        {label:'การเทียบข้ามระบบ',value:'แนวตรงร่วมเป็นวิธีแสดงข้อมูล ยังไม่ใช่กฎยืนยันว่าภพ ฤดู ทิศ และธาตุข้ามระบบเท่ากัน'},
        {label:'ฐานดาวไทย',value:'Astronomy Engine 2.1.19 + ลาหิรีประมาณ; ภพแบบราศี; ราหูเฉลี่ย · ไม่ใช่สมผุสสุริยยาตร์'},
        {label:'กาลละเอียด / ฤดู',value:'คงข้อมูลตำราใน Excel เดิม รวมสถานะรอทบทวนต้นฉบับ'},
        {label:'จันทรคติ',value:'CsDate / pythaidate 0.2.0; ปี พ.ศ. แปลงด้วย −543 ตามรูปแบบปัจจุบัน'},
        {label:'สหะ–อริ MASTER',value:'ยังรอต้นฉบับกฎที่เคยใช้'},
        {label:'แหล่งคำนวณ',value:'github.com/cosinekitty/astronomy · github.com/hmmbug/pythaidate · Three_Systems_Time_Integration.xlsx'}
      ];rows(q('lr-profile'),rowsOut);
    }
    function apply(event){
      event?.preventDefault();
      try{const c=engine.calculate(input.value,{tz:q('lr-tz').value,dayBoundary:q('lr-boundary').value,latitude:q('lr-lat').value,longitude:q('lr-lon').value});projection=engine.project(c);angle=c.anchor;detailBlocks=[];q('lr-all').replaceChildren();q('lr-error').hidden=true;profile();draw();readout();}
      catch(err){q('lr-error').textContent=err.message;q('lr-error').hidden=false;}
    }
    function fromPointer(event){const b=svg.getBoundingClientRect(),x=event.clientX-b.left-center,y=event.clientY-b.top-center;if(Math.hypot(x,y)>hole)setAngle(Math.atan2(x,-y)*180/Math.PI);}
    svg.addEventListener('pointerdown',event=>{dragging=true;svg.setPointerCapture(event.pointerId);fromPointer(event);});
    svg.addEventListener('pointermove',event=>{if(dragging)fromPointer(event);});
    svg.addEventListener('pointerup',event=>{dragging=false;if(svg.hasPointerCapture(event.pointerId))svg.releasePointerCapture(event.pointerId);});
    svg.addEventListener('pointercancel',()=>{dragging=false;});
    q('lr-form').addEventListener('submit',apply);slider.addEventListener('input',()=>setAngle(Number(slider.value)));
    q('lr-home').addEventListener('click',()=>setAngle(projection.c.anchor));
    q('lr-bangkok').addEventListener('click',()=>{q('lr-lat').value='13.7563';q('lr-lon').value='100.5018';apply();});
    new ResizeObserver(()=>draw()).observe(root);apply();
  })();
