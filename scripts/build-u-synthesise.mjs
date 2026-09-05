import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function buildUSynthesise() {
  for (const name of ['catalog', 'engine', 'classical', 'landscape']) {
    const source = await fs.readFile(path.join(root, 'knowledge/u-synthesise', name + '.mjs'), 'utf8');
    const browserSource = source.replace(/from '\.\/(catalog|classical|landscape)\.mjs'/g, (_, name) => "from './u-synthesise-" + name + ".js'");
    await fs.writeFile(path.join(root, 'u-synthesise-' + name + '.js'), '// Generated from knowledge/u-synthesise/' + name + '.mjs\n' + browserSource);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildUSynthesise();
