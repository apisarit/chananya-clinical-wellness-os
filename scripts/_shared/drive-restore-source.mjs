import {
  createHash,
  createPrivateKey,
  sign as signBytes
} from 'node:crypto';
import {
  normalizeExactRestoreSource,
  normalizeRestoreEnvironment,
  normalizeRestoreRootFolderId,
  normalizeRestoreSourceRequest,
  RESTORE_DATA_DOMAINS,
  RESTORE_FOLDER_DOMAINS
} from '../../netlify/functions/_shared/restore-source.mjs';

const API_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,256}$/;
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const GOOGLE_FOLDER_MIME = 'application/vnd.google-apps.folder';
const DOMAIN_MIME = 'application/vnd.chananya.backup+json';
const MANIFEST_MIME = 'application/json';
const MAX_ENCRYPTED_OBJECT_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function assert(condition, code) {
  if (!condition) throw new Error(code);
}

function exactKeys(value, expected, code) {
  const actual = Object.keys(record(value)).sort();
  const wanted = [...expected].sort();
  assert(JSON.stringify(actual) === JSON.stringify(wanted), code);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function equalJson(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function expectedDomainMime(domain) {
  return domain === 'manifest' ? MANIFEST_MIME : DOMAIN_MIME;
}

function driveHeaders(accessToken) {
  if (!accessToken || String(accessToken).length > 8192) {
    throw new Error('RESTORE_SOURCE_GOOGLE_ACCESS_TOKEN_REQUIRED');
  }
  return Object.freeze({
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json'
  });
}

function base64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

export async function fetchGoogleRestoreReaderAccessToken(serviceAccount, fetchImpl = fetch) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const tokenUri = String(serviceAccount?.tokenUri || '');
  if (tokenUri !== 'https://oauth2.googleapis.com/token') {
    throw new Error('RESTORE_SOURCE_GOOGLE_TOKEN_URI_INVALID');
  }
  const unsigned = `${base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64Url(JSON.stringify({
    iss: serviceAccount?.clientEmail,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud: tokenUri,
    iat: issuedAt,
    exp: issuedAt + 3600
  }))}`;
  let assertion;
  try {
    assertion = `${unsigned}.${base64Url(signBytes(
      'RSA-SHA256',
      Buffer.from(unsigned),
      createPrivateKey(serviceAccount?.privateKey)
    ))}`;
  } catch {
    throw new Error('RESTORE_SOURCE_GOOGLE_SERVICE_ACCOUNT_INVALID');
  }
  const response = await fetchImpl(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(8000)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.access_token) {
    throw new Error('RESTORE_SOURCE_GOOGLE_OAUTH_FAILED');
  }
  return payload.access_token;
}

export function assertRestoreSourceEndpoint(value) {
  let url;
  try { url = new URL(String(value || '')); }
  catch { throw new Error('RESTORE_SOURCE_API_URL_INVALID'); }
  if (url.protocol !== 'https:'
      || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.netlify\.app$/i.test(url.hostname)
      || url.port
      || url.username
      || url.password
      || url.pathname !== '/api/restore-source'
      || url.search
      || url.hash) {
    throw new Error('RESTORE_SOURCE_API_URL_INVALID');
  }
  return url.toString();
}

export async function fetchExactRestoreSource({
  endpoint,
  apiToken,
  clinicCode,
  slot,
  expectedEnvironment,
  expectedRootFolderId,
  fetchImpl = fetch
}) {
  const url = assertRestoreSourceEndpoint(endpoint);
  if (!API_TOKEN_PATTERN.test(String(apiToken || ''))) {
    throw new Error('RESTORE_SOURCE_API_TOKEN_REQUIRED');
  }
  const request = normalizeRestoreSourceRequest({ clinicCode, slot });
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(request),
    redirect: 'error',
    signal: AbortSignal.timeout(8000)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok !== true) {
    const candidate = String(payload?.code || '');
    throw new Error(/^RESTORE_SOURCE_[A-Z0-9_]{3,100}$/.test(candidate)
      ? candidate
      : 'RESTORE_SOURCE_API_REQUEST_FAILED');
  }
  return normalizeExactRestoreSource(payload.source, {
    clinicCode: request.clinicCode,
    slot: request.slot,
    environment: normalizeRestoreEnvironment(expectedEnvironment),
    expectedRootFolderId: normalizeRestoreRootFolderId(expectedRootFolderId)
  });
}

async function fetchDriveMetadata({ accessToken, fileId, fetchImpl = fetch }) {
  const id = String(fileId || '');
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(id)) throw new Error('RESTORE_SOURCE_DRIVE_ID_INVALID');
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`);
  url.searchParams.set('fields', 'id,name,mimeType,size,parents,trashed');
  url.searchParams.set('supportsAllDrives', 'true');
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: driveHeaders(accessToken),
    redirect: 'error',
    signal: AbortSignal.timeout(8000)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload) throw new Error('RESTORE_SOURCE_DRIVE_METADATA_FAILED');
  return payload;
}

export async function inspectRestoreFolder({
  accessToken,
  folderId,
  expectedParentId = '',
  fetchImpl = fetch
}) {
  const expectedId = normalizeRestoreRootFolderId(folderId);
  const metadata = await fetchDriveMetadata({ accessToken, fileId: expectedId, fetchImpl });
  assert(metadata.id === expectedId, 'RESTORE_SOURCE_FOLDER_ID_MISMATCH');
  assert(metadata.mimeType === GOOGLE_FOLDER_MIME, 'RESTORE_SOURCE_FOLDER_MIME_INVALID');
  assert(metadata.trashed === false, 'RESTORE_SOURCE_FOLDER_TRASHED');
  if (expectedParentId) {
    const parentId = normalizeRestoreRootFolderId(expectedParentId);
    assert(Array.isArray(metadata.parents)
      && metadata.parents.length === 1
      && metadata.parents[0] === parentId, 'RESTORE_SOURCE_FOLDER_PARENT_MISMATCH');
  }
  return Object.freeze({
    id: expectedId,
    name: String(metadata.name || '').slice(0, 200)
  });
}

export async function inspectRestoreObject({
  accessToken,
  sourceObject,
  fetchImpl = fetch
}) {
  const item = record(sourceObject);
  const metadata = await fetchDriveMetadata({
    accessToken,
    fileId: item.fileId,
    fetchImpl
  });
  const size = Number(metadata.size);
  assert(metadata.id === item.fileId, 'RESTORE_SOURCE_FILE_ID_MISMATCH');
  assert(metadata.name === item.fileName, 'RESTORE_SOURCE_FILE_NAME_MISMATCH');
  assert(metadata.mimeType === expectedDomainMime(item.domain), 'RESTORE_SOURCE_FILE_MIME_MISMATCH');
  assert(metadata.trashed === false, 'RESTORE_SOURCE_FILE_TRASHED');
  assert(Array.isArray(metadata.parents)
    && metadata.parents.length === 1
    && metadata.parents[0] === item.destinationFolderId,
  'RESTORE_SOURCE_FILE_PARENT_MISMATCH');
  assert(Number.isSafeInteger(size) && size > 0, 'RESTORE_SOURCE_FILE_SIZE_INVALID');
  if (item.domain === 'manifest') {
    assert(size <= MAX_MANIFEST_BYTES, 'RESTORE_SOURCE_MANIFEST_SIZE_INVALID');
  } else {
    assert(size === item.encryptedBytes
      && size <= MAX_ENCRYPTED_OBJECT_BYTES, 'RESTORE_SOURCE_FILE_SIZE_MISMATCH');
  }
  return Object.freeze({
    id: metadata.id,
    name: metadata.name,
    mimeType: metadata.mimeType,
    parentId: metadata.parents[0],
    size
  });
}

export async function downloadInspectedDriveObject({
  accessToken,
  metadata,
  fetchImpl = fetch
}) {
  const inspected = record(metadata);
  const id = String(inspected.id || '');
  const size = Number(inspected.size);
  assert(/^[A-Za-z0-9_-]{10,200}$/.test(id)
    && Number.isSafeInteger(size)
    && size > 0
    && size <= MAX_ENCRYPTED_OBJECT_BYTES,
  'RESTORE_SOURCE_DOWNLOAD_ARGUMENT_INVALID');
  const response = await fetchImpl(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`,
    {
      method: 'GET',
      headers: driveHeaders(accessToken),
      redirect: 'error',
      signal: AbortSignal.timeout(30000)
    }
  );
  if (!response.ok) throw new Error('RESTORE_SOURCE_DRIVE_DOWNLOAD_FAILED');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert(bytes.length === size, 'RESTORE_SOURCE_DOWNLOADED_SIZE_MISMATCH');
  return bytes;
}

export function validateBackupManifest(bytes, source, expectedSourceRevision) {
  assert(Buffer.isBuffer(bytes)
    && bytes.length > 0
    && bytes.length <= MAX_MANIFEST_BYTES,
  'RESTORE_SOURCE_MANIFEST_SIZE_INVALID');
  const expectedCommit = String(expectedSourceRevision || '').trim().toLowerCase();
  assert(GIT_COMMIT_PATTERN.test(expectedCommit), 'RESTORE_SOURCE_EXPECTED_COMMIT_INVALID');

  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('RESTORE_SOURCE_MANIFEST_JSON_INVALID'); }
  exactKeys(manifest, [
    'format',
    'environment',
    'deployment_id',
    'source_revision',
    'clinic_id',
    'clinic_code',
    'slot',
    'generated_at',
    'drive_assignment',
    'domains',
    'failures'
  ], 'RESTORE_SOURCE_MANIFEST_SHAPE_INVALID');
  assert(manifest.format === 'chananya-backup-manifest/v2', 'RESTORE_SOURCE_MANIFEST_FORMAT_INVALID');
  assert(manifest.environment === source.environment, 'RESTORE_SOURCE_MANIFEST_ENVIRONMENT_MISMATCH');
  assert(manifest.clinic_id === source.clinicId, 'RESTORE_SOURCE_MANIFEST_CLINIC_ID_MISMATCH');
  assert(manifest.clinic_code === source.clinicCode, 'RESTORE_SOURCE_MANIFEST_CLINIC_CODE_MISMATCH');
  const normalizedSlot = normalizeRestoreSourceRequest({
    clinicCode: source.clinicCode,
    slot: manifest.slot
  }).slot;
  assert(normalizedSlot === source.slot, 'RESTORE_SOURCE_MANIFEST_SLOT_MISMATCH');
  assert(typeof manifest.deployment_id === 'string'
    && manifest.deployment_id.length >= 3
    && manifest.deployment_id.length <= 200,
  'RESTORE_SOURCE_MANIFEST_DEPLOYMENT_INVALID');
  assert(String(manifest.source_revision || '').toLowerCase() === expectedCommit,
    'RESTORE_SOURCE_MANIFEST_SOURCE_REVISION_MISMATCH');
  const generatedAt = new Date(String(manifest.generated_at || ''));
  assert(!Number.isNaN(generatedAt.getTime())
    && generatedAt >= new Date(source.slot)
    && generatedAt <= new Date(source.completedAt),
  'RESTORE_SOURCE_MANIFEST_GENERATED_AT_INVALID');
  assert(Array.isArray(manifest.failures) && manifest.failures.length === 0,
    'RESTORE_SOURCE_MANIFEST_FAILURES_PRESENT');

  const assignment = record(manifest.drive_assignment);
  exactKeys(assignment, ['version', 'root_folder_id', 'folder_ids'],
    'RESTORE_SOURCE_MANIFEST_ASSIGNMENT_SHAPE_INVALID');
  exactKeys(assignment.folder_ids, RESTORE_FOLDER_DOMAINS,
    'RESTORE_SOURCE_MANIFEST_FOLDERS_SHAPE_INVALID');
  assert(Number(assignment.version) === source.assignmentVersion
    && assignment.root_folder_id === source.rootFolderId
    && equalJson(assignment.folder_ids, source.folders),
  'RESTORE_SOURCE_MANIFEST_ASSIGNMENT_MISMATCH');

  assert(Array.isArray(manifest.domains)
    && manifest.domains.length === RESTORE_DATA_DOMAINS.length,
  'RESTORE_SOURCE_MANIFEST_DOMAINS_INVALID');
  const seen = new Set();
  for (const domainEntry of manifest.domains) {
    exactKeys(domainEntry, [
      'domain',
      'destination_folder_id',
      'drive_assignment_version',
      'file_id',
      'file_name',
      'plaintext_bytes',
      'encrypted_bytes',
      'plaintext_sha256',
      'ciphertext_sha256',
      'key_id',
      'row_counts'
    ], 'RESTORE_SOURCE_MANIFEST_DOMAIN_SHAPE_INVALID');
    const domain = String(domainEntry.domain || '');
    assert(RESTORE_DATA_DOMAINS.includes(domain) && !seen.has(domain),
      'RESTORE_SOURCE_MANIFEST_DOMAIN_INVALID');
    seen.add(domain);
    const expected = source.objects[domain];
    assert(domainEntry.destination_folder_id === expected.destinationFolderId
      && Number(domainEntry.drive_assignment_version) === expected.driveAssignmentVersion
      && domainEntry.file_id === expected.fileId
      && domainEntry.file_name === expected.fileName
      && Number(domainEntry.plaintext_bytes) === expected.plaintextBytes
      && Number(domainEntry.encrypted_bytes) === expected.encryptedBytes
      && domainEntry.plaintext_sha256 === expected.plaintextSha256
      && domainEntry.ciphertext_sha256 === expected.ciphertextSha256
      && domainEntry.key_id === expected.keyId
      && equalJson(domainEntry.row_counts, expected.rowCounts),
    `RESTORE_SOURCE_MANIFEST_DOMAIN_EVIDENCE_MISMATCH_${domain.toUpperCase()}`);
  }
  assert(RESTORE_DATA_DOMAINS.every(domain => seen.has(domain)),
    'RESTORE_SOURCE_MANIFEST_DOMAINS_INCOMPLETE');

  return Object.freeze({
    sourceRevision: expectedCommit,
    deploymentId: manifest.deployment_id,
    generatedAt: generatedAt.toISOString(),
    manifestSha256: createHash('sha256').update(bytes).digest('hex')
  });
}

export function validateEncryptedObjectEnvelope({
  bytes,
  source,
  domain,
  expectedSourceRevision,
  expectedDeploymentId
}) {
  assert(Buffer.isBuffer(bytes) && bytes.length > 0,
    'RESTORE_SOURCE_ENVELOPE_SIZE_INVALID');
  assert(RESTORE_DATA_DOMAINS.includes(domain), 'RESTORE_SOURCE_ENVELOPE_DOMAIN_INVALID');
  const expected = source.objects[domain];
  assert(bytes.length === expected.encryptedBytes,
    'RESTORE_SOURCE_ENVELOPE_SIZE_MISMATCH');
  let envelope;
  try { envelope = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('RESTORE_SOURCE_ENVELOPE_JSON_INVALID'); }
  exactKeys(envelope, [
    'format',
    'algorithm',
    'key_id',
    'created_at',
    'metadata',
    'aad_sha256',
    'plaintext_sha256',
    'ciphertext_sha256',
    'iv',
    'tag',
    'ciphertext'
  ], 'RESTORE_SOURCE_ENVELOPE_SHAPE_INVALID');
  exactKeys(envelope.metadata, [
    'environment',
    'deployment_id',
    'source_revision',
    'clinic_id',
    'clinic_code',
    'domain',
    'slot',
    'source_format',
    'schema_version'
  ], 'RESTORE_SOURCE_ENVELOPE_METADATA_SHAPE_INVALID');
  assert(envelope.format === 'chananya-encrypted-backup/v1'
    && envelope.algorithm === 'AES-256-GCM',
  'RESTORE_SOURCE_ENVELOPE_FORMAT_INVALID');
  assert(envelope.metadata.environment === source.environment
    && envelope.metadata.deployment_id === expectedDeploymentId
    && envelope.metadata.source_revision === expectedSourceRevision
    && envelope.metadata.clinic_id === source.clinicId
    && envelope.metadata.clinic_code === source.clinicCode
    && envelope.metadata.domain === domain
    && envelope.metadata.slot === source.slot
    && envelope.metadata.source_format === 'chananya-domain-export/v1'
    && typeof envelope.metadata.schema_version === 'string'
    && envelope.metadata.schema_version.length > 0,
  'RESTORE_SOURCE_ENVELOPE_METADATA_MISMATCH');
  assert(envelope.key_id === expected.keyId
    && envelope.plaintext_sha256 === expected.plaintextSha256
    && envelope.ciphertext_sha256 === expected.ciphertextSha256,
  'RESTORE_SOURCE_ENVELOPE_EVIDENCE_MISMATCH');
  assert(envelope.aad_sha256 === createHash('sha256')
    .update(JSON.stringify(envelope.metadata))
    .digest('hex'), 'RESTORE_SOURCE_ENVELOPE_AAD_MISMATCH');
  assert(typeof envelope.ciphertext === 'string'
    && /^[A-Za-z0-9+/]+={0,2}$/.test(envelope.ciphertext),
  'RESTORE_SOURCE_ENVELOPE_CIPHERTEXT_INVALID');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  assert(ciphertext.length > 0
    && createHash('sha256').update(ciphertext).digest('hex') === expected.ciphertextSha256,
  'RESTORE_SOURCE_ENVELOPE_CIPHERTEXT_HASH_MISMATCH');
  assert(Buffer.from(String(envelope.iv || ''), 'base64').length === 12
    && Buffer.from(String(envelope.tag || ''), 'base64').length === 16,
  'RESTORE_SOURCE_ENVELOPE_CRYPTO_FIELDS_INVALID');
  const createdAt = new Date(String(envelope.created_at || ''));
  assert(!Number.isNaN(createdAt.getTime())
    && createdAt >= new Date(source.slot)
    && createdAt <= new Date(source.completedAt),
  'RESTORE_SOURCE_ENVELOPE_CREATED_AT_INVALID');
  return Object.freeze({
    domain,
    schemaVersion: envelope.metadata.schema_version,
    createdAt: createdAt.toISOString()
  });
}
