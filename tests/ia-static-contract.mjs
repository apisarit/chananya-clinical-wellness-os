import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const contracts = [
  { page: 'index.html', scripts: ['app-shell.js', 'app.js'] },
  { page: 'appointments.html', scripts: ['app-shell.js', 'appointments.js'] },
  {
    page: 'clinical-v3.html',
    scripts: ['app-shell.js', 'clinical-v3.js', 'clinical-context-guard.js', 'body-pain-map.js', 'ttm-diagnosis-assistant.js', 'diagnosis-atomic-bridge.js', 'opd-workflow.js', 'clinical-signoff.js']
  },
  { page: 'pharmacy.html', scripts: ['app-shell.js', 'pharmacy.js', 'pharmacy-sale-selector-fix.js', 'pharmacy-labels.js', 'pharmacy-v33-tools.js'] },
  { page: 'production.html', scripts: ['app-shell.js', 'production.js'] },
  { page: 'admin.html', scripts: ['app-shell.js', 'admin.js', 'admin-clinical-audit.js'] }
];

for (const contract of contracts) {
  const html = read(contract.page);
  assert.doesNotMatch(html, /\sstyle=/i, `${contract.page} should use the shared stylesheet instead of inline style attributes`);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, `${contract.page} should not contain inline scripts`);

  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, `${contract.page} should not contain duplicate IDs`);

  const sources = contract.scripts.map(read);
  const ownedMarkup = [html, ...sources].join('\n');
  for (const [index, source] of sources.entries()) {
    const selectors = [
      ...source.matchAll(/\$\(\s*['"]#([A-Za-z][\w:-]*)['"]\s*\)/g),
      ...source.matchAll(/querySelector\(\s*['"]#([A-Za-z][\w:-]*)['"]\s*\)/g)
    ];
    for (const match of selectors) {
      assert.match(ownedMarkup, new RegExp(`\\bid=["']${match[1]}["']`), `${contract.scripts[index]} references missing #${match[1]} in ${contract.page} or an owned slot`);
    }
  }

  const activeSource = sources.join('\n');
  assert.doesNotMatch(activeSource, /MutationObserver|setInterval\s*\(/, `${contract.page} active modules should use explicit lifecycle events`);
  assert.doesNotMatch(activeSource, /localStorage/, `${contract.page} should not create a second client-side source of truth`);
}

const config = read('auth-config.js');
assert.doesNotMatch(config, /createElement|appendChild|insertAdjacent|MutationObserver|setInterval/, 'auth-config.js must remain configuration-only');

console.log(`Static IA contracts passed for ${contracts.length} operational routes`);
