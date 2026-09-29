import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const workflow = read('.github/workflows/ci.yml');
const generator = read('scripts/generate-release-evidence.mjs');

assert.match(
  workflow,
  /CNYOS_RELEASE_SHA:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\|\|\s*github\.sha\s*\}\}/,
  'CI must select the deployable PR head rather than the synthetic PR merge commit'
);
assert.match(
  workflow,
  /Check out exact candidate commit[\s\S]*?ref:\s*\$\{\{\s*env\.CNYOS_RELEASE_SHA\s*\}\}/,
  'checkout must be pinned to CNYOS_RELEASE_SHA'
);
assert.match(
  workflow,
  /name:\s*release-contracts-\$\{\{\s*env\.CNYOS_RELEASE_SHA\s*\}\}-\$\{\{\s*github\.run_id\s*\}\}/,
  'retained evidence artifact must identify the deployable candidate SHA'
);
assert.match(
  generator,
  /process\.env\.CNYOS_RELEASE_SHA\s*\|\|\s*process\.env\.GITHUB_SHA\s*\|\|\s*head/,
  'evidence generator must prefer explicit CNYOS_RELEASE_SHA'
);
assert.match(
  generator,
  /workflowCommit\s*!==\s*head/,
  'evidence generation must reject a checkout/evidence SHA mismatch'
);

const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'cnyos-source-evidence-'));
try {
  fs.mkdirSync(path.join(fixture,'scripts'));
  fs.writeFileSync(path.join(fixture,'scripts/generate-release-evidence.mjs'),generator);
  fs.writeFileSync(path.join(fixture,'package.json'),JSON.stringify({scripts:{check:'synthetic-only'}}));
  fs.writeFileSync(path.join(fixture,'package-lock.json'),'{}');
  fs.writeFileSync(path.join(fixture,'release-readiness.json'),JSON.stringify({releaseChannel:'synthetic'}));
  fs.writeFileSync(path.join(fixture,'.gitignore'),'artifacts/\n');
  const git=(...args)=>execFileSync('git',args,{cwd:fixture,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  git('init');git('add','.');
  git('-c','user.name=Synthetic Fixture','-c','user.email=fixture@example.test','-c','commit.gpgsign=false','commit','-m','Synthetic source');
  const run=(extra={})=>spawnSync(process.execPath,['scripts/generate-release-evidence.mjs'],{
    cwd:fixture,encoding:'utf8',env:{PATH:process.env.PATH,...extra},timeout:10000
  });
  assert.equal(run().status,0);
  assert.equal(run().status,0,'ignored generated evidence must not dirty source');
  const evidenceDirectory=path.join(fixture,'artifacts/release-evidence');
  const latest=path.join(evidenceDirectory,'exact-commit.json');
  const previousBytes=fs.readFileSync(latest,'utf8');
  fs.writeFileSync(path.join(fixture,'new-runtime.js'),'// uncommitted synthetic runtime');
  const refused=run();assert.equal(refused.status,1);assert.equal(refused.stdout,'');
  assert.match(refused.stderr,/RELEASE_EVIDENCE_WORKTREE_DIRTY/);
  assert.equal(fs.existsSync(latest),false,'failed generation must not leave old success as current');
  assert.ok(fs.readdirSync(evidenceDirectory).filter(name=>name.endsWith('.superseded'))
    .some(name=>fs.readFileSync(path.join(evidenceDirectory,name),'utf8')===previousBytes),
    'historical evidence must remain recoverable without changed bytes');
  assert.equal(run({RELEASE_EVIDENCE_ALLOW_DIRTY:'true'}).status,0);
  const diagnostic=JSON.parse(fs.readFileSync(path.join(fixture,'artifacts/release-evidence/exact-commit.json'),'utf8'));
  assert.equal(diagnostic.workingTreeClean,false,'explicit diagnostic override must not claim a clean checkout');
} finally {fs.rmSync(fixture,{recursive:true,force:true});}
console.log('Release evidence provenance passed: exact candidate binding; untracked source refused; ignored artifacts accepted; diagnostic dirty state retained.');
