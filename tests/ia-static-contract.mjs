import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const contracts = [
  { page: 'index.html', scripts: ['app-shell.js', 'app.js'] },
  { page: 'appointments.html', scripts: ['app-shell.js', 'appointments.js'] },
  { page: 'check-in.html', scripts: ['app-shell.js', 'check-in.js'] },
  { page: 'foundation.html', scripts: ['app-shell.js', 'foundation.js'] },
  { page: 'luopan.html', scripts: ['app-shell.js', 'luopan-auth.js'] },
  {
    page: 'clinical-v3.html',
    scripts: ['app-shell.js', 'clinical-v3.js', 'clinical-context-guard.js', 'body-pain-map.js', 'ttm-diagnosis-assistant.js', 'diagnosis-atomic-bridge.js', 'opd-workflow.js', 'clinical-signoff.js']
  },
  { page: 'outcomes.html', scripts: ['app-shell.js', 'outcomes.js'] },
  { page: 'pharmacy.html', scripts: ['app-shell.js', 'pharmacy.js', 'pharmacy-sale-selector-fix.js', 'pharmacy-labels.js', 'pharmacy-v33-tools.js'] },
  { page: 'production.html', scripts: ['app-shell.js', 'production.js'] },
  { page: 'quality.html', scripts: ['app-shell.js', 'quality.js'] },
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

const patientCardHtml = read('patient-card.html');
const patientCardSource = read('patient-card.js');
assert.doesNotMatch(patientCardHtml, /\sstyle=/i, 'patient card should use the shared stylesheet');
assert.doesNotMatch(patientCardHtml, /<script(?![^>]*\bsrc=)[^>]*>/i, 'patient card should not contain inline scripts');
assert.doesNotMatch(patientCardSource, /localStorage|sessionStorage|setInterval\s*\(/, 'patient card must not persist credentials in browser storage');
assert.doesNotMatch(patientCardSource, /SUPABASE|service[_-]?role/i, 'patient card must never receive database credentials');
const patientCardIds = [...patientCardHtml.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
assert.equal(new Set(patientCardIds).size, patientCardIds.length, 'patient card should not contain duplicate IDs');

const identityReview = read('identity-review.html');
assert.doesNotMatch(identityReview, /<script(?![^>]*\bsrc=)[^>]*>/i, 'identity review must not contain inline scripts');
const identityReviewScripts = [...identityReview.matchAll(/<script[^>]+src="([^"]+)"/gi)].map(match => match[1].split('?')[0]);
assert.deepEqual(identityReviewScripts, ['brand-config.js', 'tenant-brand.js'], 'identity review may load only credential-free white-label presentation scripts');
assert.doesNotMatch(identityReview, /(?:src|href)=["'][^"']*(?:supabase|auth-config)/i, 'identity review must not connect to production services');
assert.match(identityReview, /Read-only UI review/, 'identity review must identify itself as non-operational');
const identityReviewIds = [...identityReview.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
assert.equal(new Set(identityReviewIds).size, identityReviewIds.length, 'identity review should not contain duplicate IDs');

const platformReview = read('ui-review.html');
const platformReviewSource = read('ui-review.js');
assert.doesNotThrow(() => new vm.Script(platformReviewSource, { filename: 'ui-review.js' }), 'platform review controller should parse');
assert.doesNotMatch(platformReview, /<script(?![^>]*\bsrc=)[^>]*>/i, 'platform review must not contain inline scripts');
assert.doesNotMatch(platformReview, /(?:src|href)=["'][^"']*(?:supabase|auth-config)/i, 'platform review must not connect to database or auth services');
assert.doesNotMatch(platformReview, /href=["']\/(?:appointments|check-in|foundation|clinical-v3|outcomes|pharmacy|production|quality|admin)(?:\.html)?["']/i, 'platform review navigation must not escape into database-locked operational routes');
assert.doesNotMatch(platformReviewSource, /fetch\s*\(|XMLHttpRequest|supabase|localStorage|sessionStorage/i, 'platform review controller must remain credential-free and read-only');
for (const workspace of ['operations','appointments','checkin','foundation','clinical','outcomes','pharmacy','production','quality','admin']) {
  assert.match(platformReview, new RegExp(`data-review-workspace=["']${workspace}["']`), `platform review should expose ${workspace}`);
  assert.match(platformReview, new RegExp(`data-review-route=["']${workspace}["']`), `platform review should navigate to ${workspace}`);
}
for (const gate of ['Authenticated staging ทุก role', 'LINE callback จริง', 'Encrypted backup + restore drill', 'Privacy / Security / Legal review']) {
  assert.ok(platformReview.includes(gate), `platform review should disclose release gate: ${gate}`);
}
assert.match(platformReview, /ปิตตะ 42 \/ วาตะ 80 \/ เสมหะ 20[\s\S]*?ยังไม่บรรจุครบ/, 'platform review must not claim complete disease coverage');
assert.match(platformReview, /รูปธาตุ 42 \/ อวัยวะแผนไทย[\s\S]*?ยังไม่บรรจุครบ/, 'platform review must disclose incomplete rupa-dhatu coverage');
assert.match(platformReview, /Clinical outcome timeline/, 'platform review must expose the restored outcomes timeline');
const platformReviewIds = [...platformReview.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
assert.equal(new Set(platformReviewIds).size, platformReviewIds.length, 'platform review should not contain duplicate IDs');
const coverageManifest = read('docs/PLATFORM_COVERAGE_AND_RELEASE_GATES.md');
assert.match(coverageManifest, /Source present[\s\S]*?Preview visible[\s\S]*?Staging verified[\s\S]*?Knowledge complete/, 'coverage manifest must separate code, preview, staging and knowledge completion');
assert.match(coverageManifest, /Preview \/ production candidate under verification/, 'coverage manifest must prohibit a premature commercial-production claim');

const config = read('auth-config.js');
assert.doesNotMatch(config, /createElement|appendChild|insertAdjacent|MutationObserver|setInterval/, 'auth-config.js must remain configuration-only');

const css = read('app.css');
assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.app-frame \{ display: block; \}/, 'tablet/mobile layout must collapse the desktop shell');
assert.match(css, /body\.shell-open \.sidebar \{ transform: none; \}/, 'mobile navigation must expose the sidebar as a drawer');
assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.clinical-layout \{ grid-template-columns: 1fr; \}/, 'clinical workspace must stack on narrow screens');
assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.foundation-browser \{ grid-template-columns: 1fr; \}/, 'foundation browser must stack on narrow screens');
assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.identity-checkin-grid \{ grid-template-columns: 1fr; \}/, 'hybrid check-in must stack on narrow screens');
assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.identity-review-grid \{ grid-template-columns: 1fr; \}/, 'identity review must stack on narrow screens');
assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.outcome-card \{ grid-template-columns: 1fr; \}/, 'outcome timeline must stack on narrow screens');
assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.identity-preview \{ grid-template-columns: 1fr; \}/, 'identity confirmation must become single-column on phones');
assert.match(css, /\.workflow-nav \{ grid-template-columns: repeat\(7,minmax\(122px,1fr\)\); overflow-x: auto;/, 'clinical workflow must remain reachable with horizontal scrolling');
assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.form, \.opd-grid, \.bm-grid, \.ttm-context-grid, \.checkgrid, \.opd-chipgrid \{ grid-template-columns: 1fr; \}/, 'clinical forms must become single-column on phones');

console.log(`Static IA contracts passed for ${contracts.length} operational routes`);
