import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  randomBytes,
  sign as signBytes
} from 'node:crypto';

export const BACKUP_DOMAINS = Object.freeze(['patients', 'products', 'pharmacy']);
export const BACKUP_FORMAT = 'chananya-encrypted-backup/v1';

const toBase64Url = value => Buffer.from(value)
  .toString('base64')
  .replace(/=/g, '')
  .replace(/\+/g, '-')
  .replace(/\//g, '_');

const sha256 = value => createHash('sha256').update(value).digest('hex');

function safeJson(value) {
  try { return JSON.parse(value); }
  catch { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON_INVALID'); }
}

export function parseServiceAccount(value) {
  const parsed = typeof value === 'string' ? safeJson(value) : value;
  if (!parsed?.client_email || !parsed?.private_key) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_FIELDS_MISSING');
  }
  return Object.freeze({
    clientEmail: String(parsed.client_email),
    privateKey: String(parsed.private_key).replace(/\\n/g, '\n'),
    tokenUri: String(parsed.token_uri || 'https://oauth2.googleapis.com/token')
  });
}

export function parseEncryptionKey(value) {
  let key;
  try { key = Buffer.from(String(value || ''), 'base64'); }
  catch { throw new Error('BACKUP_ENCRYPTION_KEY_INVALID'); }
  if (key.length !== 32) throw new Error('BACKUP_ENCRYPTION_KEY_MUST_BE_32_BYTES');
  return key;
}

export function createServiceAccountAssertion(serviceAccount, now = Date.now()) {
  const issuedAt = Math.floor(now / 1000);
  const header = toBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = toBase64Url(JSON.stringify({
    iss: serviceAccount.clientEmail,
    scope: 'https://www.googleapis.com/auth/drive.file',
    aud: serviceAccount.tokenUri,
    iat: issuedAt,
    exp: issuedAt + 3600
  }));
  const unsigned = `${header}.${claims}`;
  const signature = signBytes('RSA-SHA256', Buffer.from(unsigned), createPrivateKey(serviceAccount.privateKey));
  return `${unsigned}.${toBase64Url(signature)}`;
}

export async function fetchGoogleAccessToken(serviceAccount, fetchImpl = fetch) {
  const assertion = createServiceAccountAssertion(serviceAccount);
  const response = await fetchImpl(serviceAccount.tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) throw new Error('GOOGLE_OAUTH_TOKEN_FAILED');
  return payload.access_token;
}

function envelopeMetadata(payload, metadata) {
  return Object.freeze({
    clinic_id: String(metadata.clinicId),
    clinic_code: String(metadata.clinicCode),
    domain: String(metadata.domain),
    slot: String(metadata.slot),
    source_format: String(payload?.format || 'unknown'),
    schema_version: String(payload?.schema_version || 'unknown')
  });
}

export function encryptBackup(payload, key, metadata, options = {}) {
  if (!BACKUP_DOMAINS.includes(metadata?.domain)) throw new Error('BACKUP_DOMAIN_INVALID');
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('BACKUP_ENCRYPTION_KEY_MUST_BE_32_BYTES');
  const plaintext = Buffer.from(JSON.stringify(payload));
  const iv = options.iv || randomBytes(12);
  if (!Buffer.isBuffer(iv) || iv.length !== 12) throw new Error('BACKUP_IV_INVALID');
  const aadObject = envelopeMetadata(payload, metadata);
  const aad = Buffer.from(JSON.stringify(aadObject));
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const createdAt = options.createdAt || new Date().toISOString();
  const envelope = {
    format: BACKUP_FORMAT,
    algorithm: 'AES-256-GCM',
    key_id: sha256(key).slice(0, 16),
    created_at: createdAt,
    metadata: aadObject,
    aad_sha256: sha256(aad),
    plaintext_sha256: sha256(plaintext),
    ciphertext_sha256: sha256(ciphertext),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64')
  };
  return Object.freeze({
    envelope,
    bytes: Buffer.from(JSON.stringify(envelope)),
    plaintextBytes: plaintext.length,
    encryptedBytes: Buffer.byteLength(JSON.stringify(envelope))
  });
}

export function decryptBackup(envelope, key) {
  if (envelope?.format !== BACKUP_FORMAT || envelope?.algorithm !== 'AES-256-GCM') {
    throw new Error('BACKUP_ENVELOPE_UNSUPPORTED');
  }
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('BACKUP_ENCRYPTION_KEY_MUST_BE_32_BYTES');
  const aad = Buffer.from(JSON.stringify(envelope.metadata));
  if (sha256(aad) !== envelope.aad_sha256) throw new Error('BACKUP_AAD_INTEGRITY_FAILED');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  if (sha256(ciphertext) !== envelope.ciphertext_sha256) throw new Error('BACKUP_CIPHERTEXT_INTEGRITY_FAILED');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (sha256(plaintext) !== envelope.plaintext_sha256) throw new Error('BACKUP_PLAINTEXT_INTEGRITY_FAILED');
  return JSON.parse(plaintext.toString('utf8'));
}

function driveHeaders(accessToken, extra = {}) {
  return { Authorization: `Bearer ${accessToken}`, ...extra };
}

function escapeDriveQuery(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export async function findDriveFile({ accessToken, folderId, name, fetchImpl = fetch }) {
  const query = `name = '${escapeDriveQuery(name)}' and '${escapeDriveQuery(folderId)}' in parents and trashed = false`;
  const url = new URL('https://www.googleapis.com/drive/v3/files');
  url.searchParams.set('q', query);
  url.searchParams.set('fields', 'files(id,name,size,modifiedTime)');
  url.searchParams.set('pageSize', '2');
  url.searchParams.set('supportsAllDrives', 'true');
  url.searchParams.set('includeItemsFromAllDrives', 'true');
  const response = await fetchImpl(url, { headers: driveHeaders(accessToken) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error('GOOGLE_DRIVE_LOOKUP_FAILED');
  return payload.files?.[0] || null;
}

async function createDriveFile({ accessToken, folderId, name, mimeType, bytes, fetchImpl }) {
  const boundary = `chananya_${randomBytes(12).toString('hex')}`;
  const metadata = JSON.stringify({ name, parents: [folderId] });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    Buffer.from(bytes),
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  const response = await fetchImpl(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,size,modifiedTime',
    {
      method: 'POST',
      headers: driveHeaders(accessToken, { 'Content-Type': `multipart/related; boundary=${boundary}` }),
      body
    }
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.id) throw new Error('GOOGLE_DRIVE_UPLOAD_FAILED');
  return payload;
}

async function updateDriveFile({ accessToken, fileId, mimeType, bytes, fetchImpl }) {
  const response = await fetchImpl(
    `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media&supportsAllDrives=true&fields=id,name,size,modifiedTime`,
    {
      method: 'PATCH',
      headers: driveHeaders(accessToken, { 'Content-Type': mimeType }),
      body: Buffer.from(bytes)
    }
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.id) throw new Error('GOOGLE_DRIVE_UPDATE_FAILED');
  return payload;
}

export async function upsertDriveFile({
  accessToken,
  folderId,
  name,
  mimeType = 'application/octet-stream',
  bytes,
  fetchImpl = fetch
}) {
  if (!accessToken || !folderId || !name || !bytes) throw new Error('GOOGLE_DRIVE_UPLOAD_ARGUMENT_MISSING');
  const existing = await findDriveFile({ accessToken, folderId, name, fetchImpl });
  const result = existing
    ? await updateDriveFile({ accessToken, fileId: existing.id, mimeType, bytes, fetchImpl })
    : await createDriveFile({ accessToken, folderId, name, mimeType, bytes, fetchImpl });
  return Object.freeze({ ...result, operation: existing ? 'updated' : 'created' });
}

export async function supabaseRpc(config, name, body = {}, fetchImpl = fetch) {
  const response = await fetchImpl(`${config.supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const code = String(payload?.message || payload?.code || 'SUPABASE_RPC_FAILED').replace(/[^A-Z0-9_]/gi, '_').slice(0, 80);
    throw new Error(code || 'SUPABASE_RPC_FAILED');
  }
  return payload;
}

export function backupSlot(date = new Date()) {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    20, 0, 0, 0
  )).toISOString();
}

export function backupFileName(clinicCode, domain, slot, extension = 'cdb.json.enc') {
  const safeClinic = String(clinicCode || 'CLINIC').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 40) || 'CLINIC';
  const stamp = String(slot).replace(/[-:]/g, '').replace(/\.000Z$/, 'Z');
  return `${safeClinic}_${domain}_${stamp}.${extension}`;
}

export function countDomainRows(payload) {
  return Object.fromEntries(
    Object.entries(payload?.data || {}).map(([table, rows]) => [table, Array.isArray(rows) ? rows.length : 0])
  );
}
