import { readFile } from 'node:fs/promises';

// Netlify accepts .mts Functions, while Node 20 does not load that extension
// without a TypeScript-aware loader. These Functions intentionally contain
// plain ESM, so the contract tests only need to declare their module format.
export async function load(url, context, nextLoad) {
  const sourceUrl = new URL(url);
  if (sourceUrl.protocol !== 'file:' || !sourceUrl.pathname.endsWith('.mts')) {
    return nextLoad(url, context);
  }

  sourceUrl.search = '';
  sourceUrl.hash = '';
  return {
    format: 'module',
    shortCircuit: true,
    source: await readFile(sourceUrl, 'utf8')
  };
}
