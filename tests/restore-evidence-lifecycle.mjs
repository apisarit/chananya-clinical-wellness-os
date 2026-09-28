import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cnyos-restore-evidence-'));
const destination=path.join(directory,'isolated-restore-drill.json');
const run=()=>spawnSync(process.execPath,[new URL('../scripts/verify-restored-database.mjs',import.meta.url).pathname],{
  encoding:'utf8',env:{PATH:process.env.PATH,RESTORE_EVIDENCE_DIR:directory},timeout:10000
});
try {
  const historical=JSON.stringify({valid:true,synthetic:true,source_commit:'a'.repeat(40)});
  await fs.writeFile(destination,historical,{mode:0o600});
  let result=run();assert.equal(result.status,1);assert.equal(result.stdout,'');
  assert.equal(JSON.parse(result.stderr).code,'RESTORE_DRILL_ACK_REQUIRED');
  await assert.rejects(fs.stat(destination),{code:'ENOENT'});
  const archived=await fs.readdir(directory);assert.equal(archived.length,1);
  assert.match(archived[0],/^isolated-restore-drill\.json\.[a-f0-9-]+\.superseded$/);
  assert.equal(await fs.readFile(path.join(directory,archived[0]),'utf8'),historical);
  result=run();assert.equal(result.status,1);
  assert.deepEqual(await fs.readdir(directory),archived,'retry must preserve earlier archive');
  console.log('Restore evidence lifecycle passed: failed invocation retires stale success, preserves historical bytes, and repeated failure creates no success. No network call.');
} finally {await fs.rm(directory,{recursive:true,force:true});}
