import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../appointments.js',import.meta.url),'utf8');
const start=source.indexOf('  async function bookAppointment(event)');
const end=source.indexOf('  async function loadAppointments()',start);
assert.ok(start>0 && end>start);
for (const failed of [null,'schedules','appointments','both']) {
  const nodes=new Map();
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'synthetic',textContent:'',disabled:false,classList:{remove(){}}});return nodes.get(id);};
  let calls=0,resets=0,release;
  const waiting=new Promise(resolve=>{release=resolve;});
  const context=vm.createContext({
    $:node,canOperate:true,bookingInFlight:false,selectedScheduleMatchesBooking:()=>true,
    db:{rpc:async()=>{calls++;await waiting;return {data:{appointment_no:'SYN-APT',queue_number:1}};}},
    toast:()=>{},
    loadSchedules:async()=>{node('#booking-status').textContent='refreshing';if(['schedules','both'].includes(failed))throw Error('synthetic schedule failure');},
    loadAppointments:async()=>{if(['appointments','both'].includes(failed))throw Error('synthetic list failure');},
  });
  vm.runInContext(source.slice(start,end)+'\nglobalThis.book=bookAppointment;',context);
  const event={preventDefault(){},target:{reset(){resets++;}}};
  const pending=context.book(event);
  assert.equal(node('#booking-submit').disabled,true);
  await context.book(event);
  assert.equal(calls,1,'double submit must not send another booking');
  release();await pending;
  assert.equal(resets,1);
  assert.equal(calls,1,'refresh failure must never retry a committed booking');
  assert.equal(node('#booking-submit').disabled,false);
  assert.match(node('#booking-status').textContent,/จองสำเร็จ SYN-APT/);
  if(failed) assert.match(node('#booking-status').textContent,/ไม่ต้องจองซ้ำ/);
  else assert.doesNotMatch(node('#booking-status').textContent,/ไม่สำเร็จ/);
}
console.log('Booking refresh boundary passed: commit acknowledgement retained for either/both failed reads; duplicate click sends one write. Isolated controller, no live booking.');

const listStart=source.indexOf('  async function loadAppointments()');
const listEnd=source.indexOf('  async function setStatus(',listStart);
assert.ok(listStart>0 && listEnd>listStart);
for(const mode of ['result-error','rejected','stale-error']) {
  const list={innerHTML:''};
  let read=0,settle;
  const pending=new Promise((resolve,reject)=>{settle=()=>mode==='result-error'?resolve({error:new Error('synthetic')}):reject(new Error('synthetic'));});
  const context=vm.createContext({
    $:id=>id==='#appointment-list'?list:{value:''},
    appointmentRequestVersion:0,
    document:{querySelectorAll:()=>[]},
    db:{from(){const current=++read;return {select(){return this;},order(){return this;},then(resolve,reject){return (current===1?pending:Promise.resolve({data:[]})).then(resolve,reject);}};}}
  });
  vm.runInContext(source.slice(listStart,listEnd)+'\nglobalThis.load=loadAppointments;',context);
  const loading=context.load();
  assert.match(list.innerHTML,/กำลังโหลด/);
  if(mode==='stale-error') {
    await context.load();
    settle();await loading;
    assert.match(list.innerHTML,/ไม่มีรายการนัดหมาย/);
    assert.doesNotMatch(list.innerHTML,/ไม่สำเร็จ/);
  } else {
    const rejected=assert.rejects(loading,/synthetic/);
    settle();await rejected;
    assert.match(list.innerHTML,/โหลดรายการนัดไม่สำเร็จ/);
    assert.match(list.innerHTML,/role="alert"/);
    assert.doesNotMatch(list.innerHTML,/กำลังโหลด/);
    await context.load();
    assert.match(list.innerHTML,/ไม่มีรายการนัดหมาย/);
  }
}
console.log('Appointment list failures passed: RPC error and rejected transport stop loading; stale failure cannot overwrite a newer result; read-only retry recovers.');

const actionStart=source.indexOf('  async function setStatus(');
const actionEnd=source.indexOf('  async function init()',actionStart);
assert.ok(actionStart>0 && actionEnd>actionStart);
for(const action of ['setStatus','cancelAppointment']) {
  for(const failure of ['none','appointments','schedules','both','write']) {
    let writes=0,release;
    const waiting=new Promise(resolve=>{release=resolve;});
    const messages=[];
    const button={dataset:{id:'synthetic-id'},disabled:false};
    const inFlight=new Set();
    const context=vm.createContext({
      canOperate:true,canClinicalStatus:false,appointmentActionsInFlight:inFlight,
      document:{querySelectorAll:()=>[button]},prompt:()=> 'synthetic cancellation',
      toast:message=>messages.push(message),
      db:{rpc:async()=>{writes++;await waiting;return failure==='write'?{error:new Error('write denied')}:{data:{}};}},
      loadAppointments:async()=>{if(['appointments','both'].includes(failure))throw Error('read failed');},
      loadSchedules:async()=>{if(['schedules','both'].includes(failure))throw Error('read failed');},
    });
    vm.runInContext(source.slice(actionStart,actionEnd)+`\nglobalThis.act=${action};`,context);
    const pending=context.act('synthetic-id','confirmed');
    assert.equal(button.disabled,true);
    await context.act('synthetic-id','confirmed');
    assert.equal(writes,1);
    const outcome=failure==='write'?assert.rejects(pending,/write denied/):pending;
    release();await outcome;
    assert.equal(writes,1,'read failure must not resend a status/cancellation write');
    assert.equal(button.disabled,false);
    assert.equal(inFlight.size,0);
    if(failure==='write') assert.equal(messages.length,0,'denied write must not claim success');
    else {
      assert.match(messages[0],action==='setStatus'?/อัปเดตสถานะแล้ว/:/ยกเลิกนัดแล้ว/);
      if(['appointments','both'].includes(failure)||(action==='cancelAppointment'&&failure==='schedules')) {
        assert.match(messages.at(-1),/ไม่ต้อง.*ซ้ำ/);
      } else assert.equal(messages.length,1);
    }
  }
}
console.log('Status/cancellation acknowledgement boundaries passed: failed refresh preserves success, denied writes remain errors, duplicate clicks issue one mutation.');
