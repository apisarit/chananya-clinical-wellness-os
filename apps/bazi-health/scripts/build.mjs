import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const names=['_headers','app.css','app.js','index.html'];
const provenance=JSON.parse(fs.readFileSync(path.join(root,'provenance.json'),'utf8'));
assert.deepEqual(fs.readdirSync(path.join(root,'public')).sort(), names, 'Unexpected public file');
const hashes=Object.fromEntries(names.map(name=>[name,createHash('sha256').update(fs.readFileSync(path.join(root,'public',name))).digest('hex')]));
const prepared=path.join(root,'release-source.json');
let source;
if(fs.existsSync(prepared)){
  source=JSON.parse(fs.readFileSync(prepared,'utf8'));
  assert.deepEqual(source.files,hashes,'Prepared release files changed');
}else{
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
  assert.equal(git('status','--porcelain','--untracked-files=all','--','.'),'','Commit the standalone app before building a release');
  source={commit:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}'),files:hashes};
}
assert.match(source.commit,/^[0-9a-f]{40}$/);
assert.match(source.tree,/^[0-9a-f]{40}$/);
const dist=path.join(root,'dist');
fs.rmSync(dist,{recursive:true,force:true});
fs.mkdirSync(dist,{recursive:true});
for(const name of names) fs.copyFileSync(path.join(root,'public',name),path.join(dist,name));
fs.writeFileSync(path.join(dist,'release.json'),JSON.stringify({
  application:'chananya-bazi-health',version:provenance.version,source,
  originalFile:provenance.originalFile,originalSha256:provenance.originalSha256,
  tabs:['Wuxing / BaZi','Health Assessment'],dataHandling:'page_memory_only',clinicalDiagnosis:false
},null,2)+'\n');
console.log(`Built standalone BaZi ${provenance.version}: ${names.length} public assets, source ${source.commit}`);
