import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'owner-control.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'owner-control.js'), 'utf8');

assert.match(html, /owner-control\.js\?v=cnyos-owner-google-20260906"/, 'Owner Console must load the recovery-aware controller revision');
assert.match(html, /owner-control\.css\?v=cnyos-owner-google-20260906"/, 'Owner recovery stylesheet must share the controller revision');

assert.match(html, /id="owner-drive-form"/);
assert.match(html, /id="owner-drive-status"[^>]*role="status"[^>]*aria-live="polite"/);
assert.match(html, /id="owner-drive-retry"[^>]*type="button"/);
assert.match(html, /id="owner-drive-environment"[^>]*readonly/);
assert.match(html, /Service account และ encryption key[^<]*จะไม่ถูกรับหรือแสดงในเบราว์เซอร์/);

for (const field of ['environment', 'deployment', 'project', 'service-account', 'root']) {
  assert.match(html, new RegExp(`id="owner-drive-context-${field}"`));
}

for (const folder of ['patients', 'products', 'pharmacy', 'transactions', 'manifests']) {
  assert.match(html, new RegExp(`id="owner-drive-${folder}"[^>]*aria-describedby="[^"]*owner-drive-status[^"]*"[^>]*required[^>]*disabled`));
  assert.match(js, new RegExp(`key: '${folder}'`));
}

assert.match(js, /ownerApi\('\/api\/owner-drive', method, body\)/);
assert.match(js, /payload\?\.environment \|\| payload\?\.backup_environment \|\| payload\?\.backupEnvironment/);
assert.match(js, /deploymentId:\s*String\(payload\?\.deploymentId/);
assert.match(js, /projectRef:\s*String\(payload\?\.projectRef/);
assert.match(js, /serviceAccountEmail:\s*String\(payload\?\.serviceAccountEmail/);
assert.match(js, /rootFolderId:\s*String\(payload\?\.rootFolderId/);
assert.match(js, /element\.textContent = driveContext\?\.\[key\] \|\| '—'/);
assert.match(js, /AbortSignal\.timeout\(OWNER_API_TIMEOUT_MS\)/);
assert.match(js, /signal:\s*timeout\.signal/);
assert.match(js, /driveRetry\.addEventListener\('click',[\s\S]*await refreshDrive\(\)/);
assert.match(js, /const requestActive = driveBusy \|\| driveLoading;[\s\S]*aria-busy', String\(requestActive\)/);
assert.match(js, /clinicSelect\.value = clinicId;[\s\S]*driveClinicSelect\.value = clinicId;/);
assert.match(js, /requestId: crypto\.randomUUID\(\),[\s\S]*clinicId: clinic\.clinic_id,[\s\S]*clinicCode: expectedCode,[\s\S]*expectedVersion,[\s\S]*folders,[\s\S]*reason: cleanReason/);
assert.match(js, /link\.rel = 'noopener noreferrer'/);

const refreshStart = js.indexOf('async function refreshDrive()');
const refreshEnd = js.indexOf('async function start()', refreshStart);
assert.ok(refreshStart >= 0 && refreshEnd > refreshStart, 'Drive refresh function must exist');
const refreshBlock = js.slice(refreshStart, refreshEnd);
assert.match(refreshBlock, /catch \(error\)[\s\S]*driveReady = false;[\s\S]*finally[\s\S]*driveLoading = false;/);
const refreshCatch = refreshBlock.slice(refreshBlock.indexOf('catch (error)'));
// Explicitly disabled service is distinct from a transient failed read: stale
// destinations must be removed when disabled, while ordinary failures preserve edits.
const disabledStart = refreshCatch.indexOf("if (error?.code === 'CNYOS_OWNER_DRIVE_DISABLED') {");
const disabledEnd = refreshCatch.indexOf("driveEnvironmentInput.value = driveEnvironment || 'ไม่พร้อมใช้งาน';", disabledStart);
assert.ok(disabledStart >= 0 && disabledEnd > disabledStart, 'Disabled Drive must have an explicit bounded handling branch');
const disabledBlock = refreshCatch.slice(disabledStart, disabledEnd);
assert.match(disabledBlock, /driveAssignments = \[\];/);
assert.match(disabledBlock, /driveContext = null;/);
assert.match(disabledBlock, /spec\.input\.value = ''/);
assert.match(disabledBlock, /driveForm\.hidden = true;/);
assert.match(disabledBlock, /return;/);
const transientCatch = refreshCatch.slice(0, disabledStart) + refreshCatch.slice(disabledEnd);
assert.doesNotMatch(transientCatch, /driveAssignments\s*=\s*\[\]/, 'transient failed refresh must preserve the last assignments');
assert.doesNotMatch(transientCatch, /spec\.input\.value\s*=/, 'transient failed refresh must preserve entered folder values');
assert.doesNotMatch(js, /aria-busy', String\([^\n]*!driveReady/, 'not-ready is not an active request');

const postStart = js.indexOf("await driveApi('POST'");
const postEnd = js.indexOf('});', postStart);
assert.ok(postStart >= 0 && postEnd > postStart, 'Drive POST block must exist');
const postBlock = js.slice(postStart, postEnd);
assert.doesNotMatch(postBlock, /environment\s*:/, 'browser must not choose the server backup environment');
assert.doesNotMatch(`${html}\n${js}`, /GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON|BACKUP_ENCRYPTION_KEY_BASE64/);
assert.doesNotMatch(html, /<(?:input|textarea)[^>]*(?:service.account|encryption|secret|private.key)/i);

console.log('Owner Drive UI contract passed: server-fixed environment, five destinations, optimistic version and no browser secrets');
