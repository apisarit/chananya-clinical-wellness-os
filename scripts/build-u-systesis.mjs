import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function buildUSystesis() {
  for (const name of ['catalog', 'engine']) {
    const source = await fs.readFile(path.join(root, 'knowledge/u-systesis', name + '.mjs'), 'utf8');
    const browserSource = source.replace("from './catalog.mjs'", "from './u-systesis-catalog.js'");
    await fs.writeFile(path.join(root, 'u-systesis-' + name + '.js'), '// Generated from knowledge/u-systesis/' + name + '.mjs\n' + browserSource);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildUSystesis();
