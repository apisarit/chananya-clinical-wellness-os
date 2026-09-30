import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

console.log('Release evidence provenance contract passed: CI and artifacts bind to exact deployable candidate HEAD');
