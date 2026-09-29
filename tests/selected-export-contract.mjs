import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {
  allowedDataset, buildCsv, normalizeSelectedExportRequest,
  projectSelectedRow, selectedExportHeaders
} from '../netlify/functions/_shared/selected-export.mjs';

assert.equal(allowedDataset('patients'), true);
assert.equal(allowedDataset('users'), false);
assert.deepEqual(normalizeSelectedExportRequest({
  dataset: 'patients', format: 'CSV', selectedIds: ['11111111-1111-4111-8111-111111111111']
}), {
  dataset: 'patients', format: 'csv', selectedIds: ['11111111-1111-4111-8111-111111111111']
});

assert.throws(() => normalizeSelectedExportRequest({
  dataset: 'patients', format: 'csv', selectedIds: ['x', 'x']
}), error => error.code === 'SELECTED_EXPORT_IDS_DUPLICATE');
assert.throws(() => normalizeSelectedExportRequest({
  dataset: 'patients', format: 'csv', selectedIds: ['11111111-1111-4111-8111-111111111111'], destination: 'nas'
}), error => error.code === 'SELECTED_EXPORT_FIELD_INVALID');
assert.throws(() => normalizeSelectedExportRequest({
  dataset: 'patients', format: 'xlsx', selectedIds: ['11111111-1111-4111-8111-111111111111']
}), error => error.code === 'SELECTED_EXPORT_FORMAT_INVALID');
assert.throws(() => normalizeSelectedExportRequest({
  dataset: 'patients', format: 'csv', selectedIds: Array.from({ length: 101 }, (_, i) => `id-${i}`)
}), error => error.code === 'SELECTED_EXPORT_IDS_INVALID');

const patientColumns = selectedExportHeaders('patients');
assert.equal(patientColumns.includes('national_id'), false, 'national ID must not be exported by default');
assert.deepEqual(projectSelectedRow('patients', { id: 'p1', hn: 'HN1', national_id: 'secret', first_name: 'A' }), {
  id: 'p1', clinic_id: null, hn: 'HN1', prefix: null, first_name: 'A', last_name: null,
  gender: null, date_of_birth: null, phone: null, email: null, active: null, created_at: null, updated_at: null
});

const csv = buildCsv([
  { id: 'p1', hn: '=2+2', first_name: 'A, B', last_name: 'line\nname' }
], ['id', 'hn', 'first_name', 'last_name']);
assert.equal(csv, 'id,hn,first_name,last_name\r\np1,\'=2+2,"A, B","line\nname"\r\n');
assert.throws(() => buildCsv([], ['id', 'secret_column']), error => error.code === 'SELECTED_EXPORT_COLUMNS_INVALID');

const browserContext={window:{}};
vm.runInNewContext(fs.readFileSync(new URL('../selected-export-browser.js',import.meta.url),'utf8'),browserContext);
const browserExport=browserContext.window.CnyosSelectedExport;
for(const input of ['=2+2','+2','-2','@SUM(A1)','\ttext','\rtext','\ntext','  =2+2','\t =2+2','＝2+2','＋2','－2','＠SUM(A1)','\uFEFF=2+2']) {
  const row={first_name:input};
  const escaped=`'${input}`;
  const expected=/[",\r\n]/.test(escaped)?`"${escaped.replaceAll('"','""')}"`:escaped;
  assert.equal(buildCsv([row],['first_name']),`first_name\r\n${expected}\r\n`);
  assert.equal(browserExport.patientCsv([row]),buildCsv([row],patientColumns),'browser/server CSV escaping diverged');
  assert.equal(projectSelectedRow('patients',row).first_name,input,'JSON projection must retain original data');
  assert.equal(browserExport.projectPatient(row).first_name,input);
}
for(const input of ['Synthetic name','  Synthetic name','ชื่อทดสอบ','A, B','A"B','']) {
  assert.equal(browserExport.patientCsv([{first_name:input}]),buildCsv([{first_name:input}],patientColumns));
}

console.log('Selected export contract passed: allowlist, selected IDs, fixed columns and CSV safety');

const appSource=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
let downloads=0;
const exportContext={accountBlocked:false,role:'admin',selectedPatientIds:new Set(['a','missing']),
  profile:{clinic_id:'synthetic-clinic-a'},
  data:{patients:[{id:'a',clinic_id:'synthetic-clinic-a',first_name:'Synthetic'}]},window:browserContext.window,
  $:()=>({value:'json'}),Blob,URL:{createObjectURL:()=> 'blob:synthetic',revokeObjectURL(){}},
  document:{createElement:()=>({click(){downloads++;}})},setTimeout:()=>{},toast:()=>{}};
vm.runInNewContext(appSource.slice(appSource.indexOf('  function downloadSelectedPatients()'),appSource.indexOf('  function billingOrders()'))+';this.download=downloadSelectedPatients;',exportContext);
assert.throws(()=>exportContext.download(),/รายการที่เลือกไม่ครบ/);
assert.equal(downloads,0,'missing selected records must not produce a partial file');
exportContext.selectedPatientIds=new Set(['a']);
exportContext.accountBlocked=true;
assert.throws(()=>exportContext.download(),/บัญชีเปลี่ยนแล้ว/);
exportContext.accountBlocked=false;
exportContext.$=()=>({value:'invalid'});
assert.throws(()=>exportContext.download(),/รูปแบบ Export ไม่ถูกต้อง/);
assert.equal(downloads,0);
exportContext.$=()=>({value:'json'});
exportContext.download();
assert.equal(downloads,1);
for(const rows of [
  [{id:'a',clinic_id:'synthetic-clinic-b'}],
  [{id:'a'}],
  [{id:'a',clinic_id:'synthetic-clinic-a'},{id:'a',clinic_id:'synthetic-clinic-a'}],
  [{id:'a',clinic_id:'synthetic-clinic-a'},{id:'a',clinic_id:'synthetic-clinic-b'}],
]) {
  exportContext.data.patients=rows;
  assert.throws(()=>exportContext.download(),/คลินิก|ซ้ำ/,'ambiguous or foreign selected rows must not download');
  assert.equal(downloads,1);
}
exportContext.data.patients=[{id:'a',clinic_id:'synthetic-clinic-a'}];
for(const profile of [null,{}, {clinic_id:''}]) {
  exportContext.profile=profile;
  assert.throws(()=>exportContext.download(),/คลินิก/,'missing current clinic must not download');
  assert.equal(downloads,1);
}
console.log('Selected export controller passed: missing selection/clinic, foreign or duplicate rows, blocked account and invalid format cannot download; valid selection downloads once.');
