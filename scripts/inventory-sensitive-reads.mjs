// Source discovery only. A listed read is not evidence that access was audited.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const sensitive = /^(patients|encounters|appointments|clinic_appointments|prescriptions|prescription_items|dispensing_orders|dispensing_items|invoices|invoice_items|payments|body_pain_points|clinical_.+|ttm_opd_histories|ttm_structured_diagnoses|patient_.+)$/;
export function inventorySource(source, file) {
  const rows = [];
  // Deliberately conservative lexical discovery, not a JavaScript parser.
  // Includes dynamic .from() as unresolved; comments/strings require review.
  for (const match of source.matchAll(/\.from\(\s*([^\n)]*)\)\s*\.select\s*\(/g)) {
    const literal = match[1].match(/^(['"])([^'"]+)\1\s*$/);
    if (literal && !sensitive.test(literal[2])) continue;
    rows.push({ file, line: source.slice(0, match.index).split('\n').length,
      table: literal?.[2] ?? null, classification: literal ? 'sensitive-read-candidate' : 'dynamic-table-unresolved',
      auditEvidence: 'not-established' });
  }
  for (const match of source.matchAll(/\.rpc\(\s*([^,\n)]*)/g)) {
    const literal = match[1].match(/^(['"])([^'"]+)\1\s*$/);
    rows.push({ file, line: source.slice(0,match.index).split('\n').length,
      rpc:literal?.[2]??null, classification:'rpc-operation-unresolved',
      auditEvidence:'not-established' });
  }
  // Known browser helper shapes; the name alone does not prove a database read.
  // Retain only table identity, never IDs, select fields or other arguments.
  for (const match of source.matchAll(/\b(read|query)\(\s*(['"])([^'"]+)\2\s*[,)]/g)) {
    if (!sensitive.test(match[3])) continue;
    rows.push({file,line:source.slice(0,match.index).split('\n').length,
      table:match[3],wrapper:match[1],classification:'wrapper-read-unresolved',
      auditEvidence:'not-established'});
  }
  for (const match of source.matchAll(/\brpc\(\s*config\s*,\s*(['"])([^'"]+)\1/g)) {
    rows.push({file,line:source.slice(0,match.index).split('\n').length,rpc:match[2],
      classification:'server-rpc-wrapper-unresolved',auditEvidence:'not-established'});
  }
  for (const match of source.matchAll(/\/rest\/v1\/(?:rpc\/)?[a-zA-Z_][a-zA-Z_0-9]*/g)) {
    rows.push({file,line:source.slice(0,match.index).split('\n').length,route:match[0],
      classification:'rest-route-unresolved',auditEvidence:'not-established'});
  }
  return rows.sort((a,b)=>a.line-b.line);
}
export function inventory(root) {
  const rows = [], files = [];
  function scan(directory,recursive) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      const absolute=path.join(directory,entry.name);
      // Never follow symlinks into external directories or credential locations.
      if(entry.isDirectory() && recursive) scan(absolute,true);
      if(!entry.isFile() || !/\.(?:js|mjs|mts|ts)$/.test(entry.name)) continue;
      const file=path.relative(root,absolute).split(path.sep).join('/');
      const source=fs.readFileSync(absolute,'utf8');
      files.push({file,sha256:createHash('sha256').update(source).digest('hex')});
      rows.push(...inventorySource(source,file));
    }
  }
  scan(root,false);
  scan(path.join(root,'netlify/functions'),true);
  return { schemaVersion:2, authorizesRelease:false, scope:'root browser JavaScript and netlify/functions; direct reads and unresolved RPC calls',
    limitations:['Lexical candidates need source review; comments and strings may match.',
      'RPC calls are unclassified operations, not confirmed reads; routine bodies require review.',
      'Aliased builders, dynamic REST routes, other wrapper signatures and other source directories are not covered.',
      'No live reads, access-log verification or legal compliance conclusion.'], files, rows };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(inventory(path.resolve(fileURLToPath(new URL('..',import.meta.url)))),null,2));
}
