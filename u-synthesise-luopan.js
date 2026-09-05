import {classicalIdentity, classicalSources, trigrams, mountainDetails, classicalRings, ringPresets, classicalReading, elementName, polarityName, loShuGrid, heTu, hexagrams, hexagramMatrix, findHexagram, studyGuide} from './u-synthesise-classical.js';

export function mountClassicalLuopan(document, {onExplore} = {}) {
  const q=id=>document.getElementById(id), svg=q('us-compass'), NS='http://www.w3.org/2000/svg';
  if(!svg||!q('us-atlas-preset'))return {update(){}};
  let reading=null, overlay=null, selected='earth', visible=new Set(ringPresets.core.ids);
  let lifeElement='water', lifePolarity='yang', origin='manual';
  const mod=(v,n=360)=>((v%n)+n)%n;
  const point=(r,a)=>[490+r*Math.sin(a*Math.PI/180),490-r*Math.cos(a*Math.PI/180)];
  const range=s=>s.start+'°–'+mod(s.start+s.span)+'°'+(s.start+s.span>=360?' (ผ่านเหนือ)':'');
  const node=(tag,text,parent,attrs={})=>{
    const el=document.createElement(tag);if(text!==undefined)el.textContent=text;
    for(const [k,v]of Object.entries(attrs))el.setAttribute(k,String(v));
    if(parent)parent.appendChild(el);return el;
  };
  const shape=(tag,attrs,text,parent=svg)=>{
    const el=document.createElementNS(NS,tag);for(const[k,v]of Object.entries(attrs))el.setAttribute(k,String(v));
    if(text!==undefined)el.textContent=text;parent.appendChild(el);return el;
  };
  function references(ids,parent){
    const p=node('p',undefined,parent,{class:'us-reference'});
    for(const id of [...new Set(ids)]){
      const s=classicalSources[id];node('a',s.title,p,{href:s.url,target:'_blank',rel:'noopener noreferrer'});
    }
  }
  function arc(inner,outer,start,span){
    const a=point(outer,start),b=point(outer,start+span),c=point(inner,start+span),d=point(inner,start);
    return `M${a} A${outer},${outer} 0 0 1 ${b} L${c} A${inner},${inner} 0 0 0 ${d} Z`;
  }
  function rings(){return classicalRings({lifeElement,lifePolarity});}
  function result(){return reading?classicalReading(reading.position,{uncertaintyDegrees:reading.uncertaintyDegrees,lifeElement,lifePolarity}):null;}
  function selectLayer(id){selected=id;q('us-layer-select').value=id;draw();readout();}
  function draw(){
    svg.replaceChildren();svg.setAttribute('viewBox','0 0 980 980');
    shape('title',{},'หล่อแกดั้งเดิม · เหนือ 0° คงที่ · '+(visible.size+1)+' ชั้นที่แสดง');
    shape('circle',{cx:490,cy:490,r:487,fill:'#171e25',stroke:'#cdb278','stroke-width':2});
    const active=rings().filter(r=>visible.has(r.id)), thickness=360/active.length, data=result();
    // Inner to outer. Metadata and measured coordinates never depend on birth input.
    active.slice().reverse().forEach((r,index)=>{
      const inner=92+index*thickness,outer=inner+thickness-1;
      const read=data?.readings.find(x=>x.id===r.id);
      for(const s of r.sectors){
        const hit=read?.sector===s || (read?.sector.start===s.start);
        const possible=read?.candidates?.some(c=>c.start===s.start);
        const linked=r.id==='earth'&&s.symbol===overlay?.symbol;
        const attrs={d:arc(inner,outer,s.start,s.span),fill:hit?'#cfb77b':linked?'#795838':index%2?'#252c30':'#323332',stroke:possible?'#e9b569':'#686052','stroke-width':possible?2:0.7,'data-layer-id':r.id,'data-sector-start':s.start};
        if(r.id==='earth')attrs['data-mountain']=s.symbol;
        const path=shape('path',attrs);shape('title',{},r.name+' · '+s.value+' · '+range(s),path);
        const middle=(inner+outer)/2,p=point(middle,s.center);
        const rotation=s.center+(s.center>90&&s.center<270?180:0);
        const available=2*middle*Math.sin(s.span*Math.PI/360);
        const font=Math.min(30,thickness*0.72,available/(s.label.length+0.3));
        shape('text',{x:0,y:font*0.35,transform:`translate(${p[0]} ${p[1]}) rotate(${rotation})`,'text-anchor':'middle',fill:hit?'#172126':'#f5e6bd','font-size':font,'font-weight':r.id===selected?700:500,'pointer-events':'none'},s.label);
      }
      if(r.id===selected)shape('circle',{cx:490,cy:490,r:outer,fill:'none',stroke:'#ffdb89','stroke-width':2,'pointer-events':'none'});
    });
    for(let d=0;d<360;d++){
      const p=point(458,d),end=point(d%10===0?470:d%5===0?466:462,d);
      shape('line',{x1:p[0],y1:p[1],x2:end[0],y2:end[1],stroke:'#cdb278','stroke-width':d%10===0?1.4:0.55,'pointer-events':'none'});
      if(d%30===0){const t=point(478,d);shape('text',{x:0,y:4,transform:`translate(${t[0]} ${t[1]}) rotate(${d+(d>90&&d<270?180:0)})`,'text-anchor':'middle','font-size':11,fill:'#f5e6bd','pointer-events':'none'},d+'°');}
    }
    shape('text',{x:490,y:477,'text-anchor':'middle','font-size':29,fill:'#f5e6bd'},data?data.degrees.toFixed(1)+'°':'羅盤');
    shape('text',{x:490,y:505,'text-anchor':'middle','font-size':15,fill:'#f5e6bd'},data?data.facing.symbol+' '+data.facing.thai:'เหนือ 0°');
    shape('text',{x:490,y:528,'text-anchor':'middle','font-size':12,fill:'#cdb278'},'จานคงที่');
    if(data){
      const a=point(88,data.degrees),b=point(454,data.degrees),c=point(88,data.sittingDegrees),d=point(454,data.sittingDegrees);
      shape('line',{x1:c[0],y1:c[1],x2:d[0],y2:d[1],stroke:'#dfded3','stroke-width':2,'stroke-dasharray':'7 7','pointer-events':'none','data-sitting':data.sittingDegrees});
      shape('line',{x1:a[0],y1:a[1],x2:b[0],y2:b[1],stroke:'#ffcc71','stroke-width':3,'pointer-events':'none','data-bearing':data.degrees});
      shape('circle',{cx:b[0],cy:b[1],r:6,fill:'#ffcc71','pointer-events':'none'});
    }
    q('us-wheel-count').textContent='แสดง '+(visible.size+1)+' / '+classicalIdentity.scaleCount+' ชั้น รวมสเกลองศา · เส้นทึบ = แนวอ่าน · เส้นประ = ฝั่งตรงข้าม';
  }
  function readout(){
    const rs=rings(),focus=rs.find(r=>r.id===selected),data=result(),box=q('us-layer-detail');box.replaceChildren();
    node('p',focus.school,box,{class:'us-eyebrow'});node('h3',focus.name,box);node('p',focus.description,box);
    if(data){const read=data.readings.find(r=>r.id===selected);node('strong',read.sector.value,box);node('p',range(read.sector),box,{class:'text-small'});}
    else node('p','กรอกองศาหรือแตะวงเพื่อดูค่าที่เข็มตัดผ่าน',box,{class:'text-small'});
    references(focus.sourceIds,box);
    const axis=q('us-axis-summary');axis.replaceChildren();
    const rows=q('us-ring-results');rows.replaceChildren();
    q('us-reading-origin').textContent=reading?(origin==='study'?'ตำแหน่งทดลองจากวง · ยังไม่ใช่ค่าที่วัดหน้างาน':'ค่าทิศทางที่กรอก · อ้างเหนือแม่เหล็ก'):'รอองศา · แตะวงเพื่อทดลองอ่านได้';
    if(!data){node('p','เมื่อกรอกองศา จะแสดงคู่แนวนั่ง–หัน และอ่านทุกวงพร้อมกันที่นี่',axis);return;}
    const axes=[['แนวอ่าน / หัน · 向',data.facing,data.degrees],['ฝั่งตรงข้าม / นั่ง · 坐',data.sitting,data.sittingDegrees]];
    for(const[label,m,d]of axes){const card=node('div',undefined,axis,{class:'us-axis-card'});node('span',label,card);node('strong',m.symbol+' '+m.thai+' · '+m.code,card);node('span',d.toFixed(1)+'° · ธาตุ'+elementName(m.element),card);}
    const offset=data.deviation===0?'ตรงกึ่งกลางขุนเขา':'ห่างกึ่งกลาง '+Math.abs(data.deviation).toFixed(1)+'° '+(data.deviation>0?'ตาม':'ทวน')+'เข็มนาฬิกา';
    node('p',offset+' · ใกล้เส้นแบ่งขุนเขาที่สุด '+data.boundaryDistance.toFixed(1)+'°',axis,{class:'text-small us-axis-note'});
    for(const r of rs){
      const read=data.readings.find(x=>x.id===r.id),row=node('tr',undefined,rows);
      const th=node('th',undefined,row,{scope:'row'}),button=node('button',r.name,th,{type:'button',class:'us-text-button'});button.addEventListener('click',()=>selectLayer(r.id));
      const cell=node('td',undefined,row);node('strong',read.sector.value,cell);node('div',range(read.sector),cell,{class:'text-small'});
      if(read.candidates?.length>1)node('div','ช่วงคลาดเคลื่อนคร่อม: '+read.candidates.map(s=>s.label).join(' / '),cell,{class:'us-uncertain text-small'});
    }
  }
  function setPreset(key){
    const preset=ringPresets[key]||ringPresets.core;visible=new Set(preset.ids);
    q('us-atlas-preset').value=Object.hasOwn(ringPresets,key)?key:'core';
    for(const[id,input]of controls)input.checked=visible.has(id);
    draw();
  }
  const controls=[];
  for(const [key,p]of Object.entries(ringPresets))node('option',p.name,q('us-atlas-preset'),{value:key});
  q('us-atlas-preset').value='core';
  for(const r of rings()){
    node('option',r.name,q('us-layer-select'),{value:r.id});
    const label=node('label',undefined,q('us-ring-switches'),{class:'us-ring-check'});
    const input=node('input',undefined,label,{type:'checkbox',value:r.id});input.checked=visible.has(r.id);controls.push([r.id,input]);
    node('span',r.name,label);
    input.addEventListener('change',()=>{if(input.checked)visible.add(r.id);else if(visible.size>1)visible.delete(r.id);else input.checked=true;q('us-atlas-preset').value='custom';draw();});
  }
  node('option','เลือกวงเอง',q('us-atlas-preset'),{value:'custom',disabled:'disabled'});
  q('us-layer-select').value=selected;
  q('us-atlas-preset').addEventListener('change',()=>setPreset(q('us-atlas-preset').value));
  q('us-layer-select').addEventListener('change',()=>selectLayer(q('us-layer-select').value));
  q('us-zoom').addEventListener('change',()=>svg.setAttribute('style','width:'+Number(q('us-zoom').value)*100+'%;max-width:none'));
  const updateLife=()=>{lifeElement=q('us-life-element').value;lifePolarity=q('us-life-polarity').value;draw();readout();};
  q('us-life-element').value=lifeElement;q('us-life-polarity').value=lifePolarity;
  q('us-life-element').addEventListener('change',updateLife);q('us-life-polarity').addEventListener('change',updateLife);
  svg.addEventListener('click',event=>{
    const target=event.target, layer=target?.getAttribute?.('data-layer-id');
    if(!layer)return;selected=layer;q('us-layer-select').value=layer;
    const rect=svg.getBoundingClientRect(),x=event.clientX-rect.left-rect.width/2,y=event.clientY-rect.top-rect.height/2;
    const degrees=Math.round(mod(Math.atan2(x,-y)*180/Math.PI)*10)/10;
    onExplore?.(degrees);readout();
  });
  q('us-bearing-slider').addEventListener('input',()=>onExplore?.(Number(q('us-bearing-slider').value)));

  function mountainTable(){
    const normal=s=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
    const search=normal(q('us-mountain-filter').value.trim()),list=q('us-mountain-cards');list.replaceChildren();
    const found=mountainDetails.filter(m=>normal([m.symbol,m.code,m.thai,m.pinyin,m.animal,m.palace.name,elementName(m.element),m.dragonName].join(' ')).includes(search));
    q('us-mountain-count').textContent=found.length+' / 24 ขุนเขา';
    for(const m of found){
      const card=node('article',undefined,list,{class:'us-mountain-card'});
      const btn=node('button',m.symbol+' '+m.thai+' · '+m.code,card,{type:'button',class:'us-mountain-button'});btn.addEventListener('click',()=>{selected='earth';q('us-layer-select').value='earth';onExplore?.(m.center);});
      node('p',m.pinyin+' · '+({stem:'ก้านฟ้า',branch:'กิ่งดิน',trigram:'ข่วย'}[m.kind])+(m.animal?' · '+m.animal:''),card);
      node('p',range(m)+' · กลาง '+m.center+'°',card);
      node('p','正五行 '+elementName(m.element)+' · วัง'+m.palace.symbol+' '+elementName(m.palace.element),card);
      node('p',m.dragonName+' · ซานหยวน'+polarityName(m.sanYuanPolarity),card);
      if(m.natalPolarity)node('p','ก้านฟ้า/กิ่งดิน BaZi: '+polarityName(m.natalPolarity),card,{class:'text-small'});
      node('p','ตรงข้าม '+m.oppositeSymbol,card,{class:'text-small'});
    }
    if(!found.length)node('p','ไม่พบขุนเขาที่ตรงกับคำค้น',list);
  }
  q('us-mountain-filter').addEventListener('input',mountainTable);mountainTable();
  function yaoGraphic(yao,parent){
    const chart=document.createElementNS(NS,'svg');chart.setAttribute('viewBox','0 0 90 '+(yao.length*16));chart.setAttribute('class','us-yao');chart.setAttribute('aria-label',yao.slice().reverse().map(y=>y?'หยาง':'หยิน').join(' '));chart.setAttribute('role','img');parent.appendChild(chart);
    yao.slice().reverse().forEach((y,i)=>{shape('rect',{x:0,y:i*16,width:y?90:38,height:8,fill:'currentColor'},undefined,chart);if(!y)shape('rect',{x:52,y:i*16,width:38,height:8,fill:'currentColor'},undefined,chart);});
  }
  for(const t of trigrams){
    const card=node('article',undefined,q('us-trigram-cards'),{class:'us-trigram-card'});yaoGraphic(t.yao,card);
    node('h3',t.symbol+' '+t.thai,card);node('p',t.pinyin+' · '+t.image+' · '+t.family,card);node('p',t.theme,card);
    node('p','ก่อนฟ้า '+t.earlyCenter+'° · เลข '+t.earlyNumber,card,{class:'text-small'});
    node('p','หลังฟ้า '+t.laterCenter+'° · ลั่วซู '+t.loShu+' · '+elementName(t.element),card,{class:'text-small'});
  }
  const gridDirs=[['NW','N','NE'],['W','C','E'],['SW','S','SE']];
  loShuGrid.forEach((row,i)=>row.forEach((value,j)=>{const cell=node('div',undefined,q('us-loshu-grid'));node('small',gridDirs[i][j],cell);node('strong',String(value),cell);}));
  for(const h of heTu){const row=node('tr',undefined,q('us-hetu-rows'));node('th',h.name,row,{scope:'row'});node('td',h.pair.join(' · '),row);node('td',elementName(h.element),row);}
  for(const select of ['us-hex-lower','us-hex-upper']){for(const t of trigrams)node('option',t.symbol+' '+t.thai+' · '+t.image,q(select),{value:t.symbol});q(select).value='乾';}
  function hexResult(){const h=findHexagram(q('us-hex-lower').value,q('us-hex-upper').value),box=q('us-hex-result');box.replaceChildren();yaoGraphic(h.yao,box);node('h3',h.number+' · '+h.name+' · '+h.thai,box);node('p','ข่วยบน '+h.upper+' / ข่วยล่าง '+h.lower+' · อ่านเส้นจากล่างขึ้นบน',box);node('p','คำไทยเป็นคำแปลย่อเพื่อศึกษา ยังไม่ใช่คำทำนายจากทิศที่กรอก',box,{class:'text-small'});}
  q('us-hex-lower').addEventListener('change',hexResult);q('us-hex-upper').addEventListener('change',hexResult);hexResult();
  const header=node('tr',undefined,q('us-hex-matrix'));node('th','ล่าง ↓ / บน →',header,{scope:'col'});for(const t of trigrams)node('th',t.symbol,header,{scope:'col'});
  hexagramMatrix.forEach((row,l)=>{const tr=node('tr',undefined,q('us-hex-matrix'));node('th',trigrams[l].symbol,tr,{scope:'row'});row.forEach((number,u)=>{const h=hexagrams[number-1],cell=node('td',undefined,tr),button=node('button',number+' '+h.name,cell,{type:'button','aria-label':number+' '+h.name+' '+h.thai});button.addEventListener('click',()=>{q('us-hex-lower').value=trigrams[l].symbol;q('us-hex-upper').value=trigrams[u].symbol;hexResult();});});});
  for(const guide of studyGuide){const detail=node('details',undefined,q('us-study-guide'));node('summary',guide.title,detail);node('p',guide.text,detail);references(guide.sourceIds,detail);}
  for(const [id,s]of Object.entries(classicalSources)){const li=node('li',undefined,q('us-classical-sources'));node('a',s.title,li,{href:s.url,target:'_blank',rel:'noopener noreferrer'});}
  draw();readout();
  return {update(nextReading,nextOverlay,nextOrigin='manual'){reading=nextReading;overlay=nextOverlay;origin=nextOrigin;if(reading)q('us-bearing-slider').value=String(reading.position.degrees);draw();readout();}};
}
