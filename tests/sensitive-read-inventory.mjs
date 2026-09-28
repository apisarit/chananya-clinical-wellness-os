import assert from 'node:assert/strict';
import { inventorySource, inventory } from '../scripts/inventory-sensitive-reads.mjs';
import { fileURLToPath } from 'node:url';
const rows=inventorySource(`db.from('patients').select('*');
db.from('products').select('*');
db.from(table).select('*');
db.from('patients').insert({});
db.from('clinical_treatment_sessions')
 .select('id');`,'fixture.js');
assert.deepEqual(rows.map(x=>[x.line,x.table]),[[1,'patients'],[3,null],[5,'clinical_treatment_sessions']]);
assert.ok(rows.every(x=>x.auditEvidence==='not-established'));
const wrappers=inventorySource(`db.from('clinic_appointments').select('*');
await read('patients', 'PRIVATE-ID', 'first_name');
await query('payments', '*');
await read('products', 'PRIVATE-PRODUCT');`,'fixture.js');
assert.deepEqual(wrappers.map(row=>[row.table,row.classification]),[
  ['clinic_appointments','sensitive-read-candidate'],
  ['patients','wrapper-read-unresolved'],['payments','wrapper-read-unresolved']
]);
assert.ok(!JSON.stringify(wrappers).includes('PRIVATE'));
const rpcRows=inventorySource(`db.rpc('read_history',{});\ndb.rpc(operation,{});\ndb.rpc('issue_invoice',{});`,'server.mts');
assert.deepEqual(rpcRows.map(x=>x.rpc),['read_history',null,'issue_invoice']);
assert.ok(rpcRows.every(x=>x.classification==='rpc-operation-unresolved'));
const server=inventorySource(`await rpc(config, 'identity_status', {});\nfetch('/rest/v1/patients?select=id');`,'endpoint.mts');
assert.equal(server[0].rpc,'identity_status');
assert.equal(server[1].route,'/rest/v1/patients');
assert.ok(!JSON.stringify(server).includes('select=id'),'inventory must not copy query strings');
const report=inventory(fileURLToPath(new URL('..',import.meta.url)));
assert.equal(report.schemaVersion,2);
assert.equal(report.authorizesRelease,false);
assert.ok(report.limitations.length>=3);
assert.ok(report.rows.some(x=>x.file==='clinical-v3.js'&&x.table==='patients'));
assert.ok(report.rows.some(x=>x.file==='app.js'&&x.table==='payments'));
assert.ok(report.rows.some(x=>x.file==='appointments.js'&&x.table==='clinic_appointments'));
assert.ok(report.rows.some(x=>x.file==='app.js'&&x.table==='patients'&&x.wrapper==='read'));
assert.ok(report.files.some(x=>x.file==='netlify/functions/patient-identity.mts'));
assert.ok(report.files.some(x=>x.file.startsWith('netlify/functions/_shared/')));
assert.ok(report.rows.some(x=>x.file==='netlify/functions/patient-identity.mts'&&x.classification==='server-rpc-wrapper-unresolved'));
assert.ok(report.files.every(x=>/^[a-f0-9]{64}$/.test(x.sha256)));
assert.equal(new Set(report.files.map(x=>x.file)).size,report.files.length);
assert.ok(!report.files.some(x=>x.file.startsWith('tests/')||x.file.includes('.env')));
console.log(`Sensitive-read discovery passed: ${report.rows.length} lexical candidates; audit evidence remains unestablished, scope explicitly incomplete.`);
