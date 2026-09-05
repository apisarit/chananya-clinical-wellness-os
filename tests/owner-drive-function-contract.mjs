import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inspectDriveFolder,
  normalizeDriveFolderId,
  normalizeOwnerDriveRequest,
  ownerDrivePublicError,
  sanitizeOwnerDriveAssignment
} from '../netlify/functions/_shared/owner-drive.mjs';
import { handleOwnerDrive } from '../netlify/functions/owner-drive.mts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const folderIds = {
  patients: 'folder_patients_12345',
  products: 'folder_products_12345',
  pharmacy: 'folder_pharmacy_12345',
  transactions: 'folder_transactions_12345',
  manifests: 'folder_manifests_12345'
};

assert.equal(normalizeDriveFolderId(folderIds.patients), folderIds.patients);
assert.equal(
  normalizeDriveFolderId(`https://drive.google.com/drive/u/0/folders/${folderIds.products}`),
  folderIds.products
);
assert.equal(
  normalizeDriveFolderId(`https://drive.google.com/open?id=${folderIds.pharmacy}`),
  folderIds.pharmacy
);
assert.throws(
  () => normalizeDriveFolderId(`https://attacker.example/drive/folders/${folderIds.patients}`),
  /FOLDER_INPUT_INVALID/
);
assert.throws(() => normalizeDriveFolderId('short'), /FOLDER_INPUT_INVALID/);

const normalized = normalizeOwnerDriveRequest({
  requestId: '22222222-2222-4222-a222-222222222222',
  clinicId: '7f760bc7-8a6f-4bfe-8bf3-5c349a15c070',
  clinicCode: 'jitarsa-stg',
  expectedVersion: 0,
  reason: 'Assign isolated staging backup folders',
  folders: folderIds
});
assert.equal(normalized.clinicCode, 'JITARSA-STG');
assert.equal(normalized.expectedVersion, 0);
assert.deepEqual(normalized.folders, folderIds);
assert.throws(
  () => normalizeOwnerDriveRequest({ ...normalized, environment: 'production' }),
  /ENVIRONMENT_INPUT_INVALID/
);
assert.throws(
  () => normalizeOwnerDriveRequest({ ...normalized, expectedVersion: -1 }),
  /VERSION_INVALID/
);
assert.throws(
  () => normalizeOwnerDriveRequest({
    ...normalized,
    requestId: '22222222-2222-1222-a222-222222222222'
  }),
  /INPUT_INVALID/
);
assert.throws(
  () => normalizeOwnerDriveRequest({
    ...normalized,
    folders: { ...folderIds, manifests: folderIds.patients }
  }),
  /FOLDERS_NOT_UNIQUE/
);

const driveCalls = [];
const inspected = await inspectDriveFolder({
  accessToken: 'server-only-access-token',
  folderId: folderIds.patients,
  fetchImpl: async (url, options) => {
    driveCalls.push({ url: String(url), options });
    return new Response(JSON.stringify({
      id: folderIds.patients,
      name: 'Jitarsa patients staging',
      mimeType: 'application/vnd.google-apps.folder',
      trashed: false,
      capabilities: { canAddChildren: true }
    }), { status: 200 });
  }
});
assert.equal(inspected.name, 'Jitarsa patients staging');
assert.match(driveCalls[0].url, /supportsAllDrives=true/);
assert.match(driveCalls[0].url, /capabilities%28canAddChildren%29/);
assert.equal(driveCalls[0].options.headers.Authorization, 'Bearer server-only-access-token');

await assert.rejects(
  inspectDriveFolder({
    accessToken: 'server-only-access-token',
    folderId: folderIds.products,
    fetchImpl: async () => new Response(JSON.stringify({
      id: folderIds.products,
      name: 'Read only',
      mimeType: 'application/vnd.google-apps.folder',
      trashed: false,
      capabilities: { canAddChildren: false }
    }), { status: 200 })
  }),
  /FOLDER_WRITE_DENIED/
);

assert.deepEqual(sanitizeOwnerDriveAssignment({
  clinic_id: normalized.clinicId,
  clinic_code: normalized.clinicCode,
  clinic_name_th: 'คลินิกจิตอาสา',
  clinic_name_en: 'Jitarsa Clinic',
  clinic_active: true,
  environment: 'staging',
  patients_folder_id: folderIds.patients,
  products_folder_id: folderIds.products,
  pharmacy_folder_id: folderIds.pharmacy,
  transactions_folder_id: folderIds.transactions,
  manifests_folder_id: folderIds.manifests,
  version: 1,
  updated_at: '2026-09-01T00:00:00Z',
  updated_by: '11111111-1111-4111-a111-111111111111',
  reason: 'Assign isolated staging backup folders',
  should_not_leak: 'secret'
}), {
  clinic_id: normalized.clinicId,
  clinic_code: normalized.clinicCode,
  clinic_name_th: 'คลินิกจิตอาสา',
  clinic_name_en: 'Jitarsa Clinic',
  clinic_active: true,
  environment: 'staging',
  patients_folder_id: folderIds.patients,
  products_folder_id: folderIds.products,
  pharmacy_folder_id: folderIds.pharmacy,
  transactions_folder_id: folderIds.transactions,
  manifests_folder_id: folderIds.manifests,
  version: 1,
  updated_at: '2026-09-01T00:00:00Z',
  updated_by: '11111111-1111-4111-a111-111111111111',
  reason: 'Assign isolated staging backup folders'
});
assert.equal(ownerDrivePublicError(new Error('CNYOS_OWNER_DRIVE_FOLDER_WRITE_DENIED')).status, 422);
assert.deepEqual(ownerDrivePublicError(new Error('CNYOS_DRIVE_VERSION_CONFLICT')), {
  code: 'CNYOS_DRIVE_VERSION_CONFLICT',
  status: 409
});
assert.deepEqual(ownerDrivePublicError(new Error('CNYOS_DRIVE_FOLDER_ALREADY_ASSIGNED')), {
  code: 'CNYOS_DRIVE_FOLDER_ALREADY_ASSIGNED',
  status: 409
});
assert.deepEqual(ownerDrivePublicError(new Error('CNYOS_DRIVE_BACKUP_RUN_ACTIVE')), {
  code: 'CNYOS_DRIVE_BACKUP_RUN_ACTIVE',
  status: 409
});
assert.deepEqual(ownerDrivePublicError(new Error('CNYOS_OWNER_CLINIC_NOT_FOUND')), {
  code: 'CNYOS_OWNER_CLINIC_NOT_FOUND',
  status: 404
});
assert.equal(ownerDrivePublicError(new Error('GOOGLE_OAUTH_TOKEN_FAILED')).code, 'CNYOS_OWNER_DRIVE_FAILED');
assert.equal(ownerDrivePublicError(new Error('CNYOS_OWNER_DRIVE_CREDENTIAL_KEY_REUSE')).status, 503);

const endpointValues = {
  CNYOS_OWNER_CONTROL_ENABLED: 'true',
  CNYOS_OWNER_DRIVE_ENABLED: 'true',
  SUPABASE_URL: 'https://stagingprojectrefabc.supabase.co',
  CNYOS_OWNER_EXPECTED_PROJECT_REF: 'stagingprojectrefabc',
  BACKUP_EXPECTED_SUPABASE_PROJECT_REF: 'stagingprojectrefabc',
  SUPABASE_SERVICE_ROLE_KEY: 'server-only-test-service-role',
  CNYOS_OWNER_EMAILS: 'owner@example.com',
  CNYOS_OWNER_CLINIC_CODES: 'JITARSA-STG',
  BACKUP_ENVIRONMENT: 'staging',
  BACKUP_DEPLOYMENT_ID: 'jitarsa-clinical-staging',
  BACKUP_PRODUCTION_SUPABASE_URL: 'https://jitarsaprodrefabcxyz.supabase.co',
  GOOGLE_DRIVE_EXPECTED_ROOT_FOLDER_ID: 'root-folder-jitarsa-staging',
  CNYOS_OWNER_EXPECTED_NETLIFY_SITE_ID: '10000000-0000-4000-8000-000000000010',
  CNYOS_OWNER_EXPECTED_SITE_ORIGIN: 'https://synthetic-drive-staging.netlify.app',
  BACKUP_EXPECTED_NETLIFY_SITE_ID: '10000000-0000-4000-8000-000000000010',
  BACKUP_EXPECTED_SITE_ORIGIN: 'https://synthetic-drive-staging.netlify.app',
  GOOGLE_DRIVE_SERVICE_ACCOUNT_WRAP_KEY_ID: 'jitarsa-staging-2026-09-v1',
  GOOGLE_DRIVE_SERVICE_ACCOUNT_WRAP_KEY_BASE64: Buffer.alloc(32, 1).toString('base64'),
  GOOGLE_DRIVE_EXPECTED_SERVICE_ACCOUNT_EMAIL: 'backup@jitarsa-staging-123.iam.gserviceaccount.com',
  BACKUP_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 2).toString('base64'),
  BACKUP_INTERNAL_DISPATCH_SECRET: 'owner-drive-test-dispatch-secret-value'
};
const endpointOwner = {
  id: '11111111-1111-4111-a111-111111111111',
  email: 'owner@example.com',
  email_confirmed_at: '2026-09-01T00:00:00.000Z',
  app_metadata: { provider: 'google', providers: ['google'] },
  identities: [{ provider: 'google' }]
};
const endpointToken = [
  Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({
    sub: endpointOwner.id,
    email: endpointOwner.email,
    amr: [{ method: 'oauth', timestamp: 1788220800 }]
  })).toString('base64url'),
  'verified-by-supabase-user-endpoint'
].join('.');
const resolvedCredential = Object.freeze({
  clientEmail: 'backup@jitarsa-staging-123.iam.gserviceaccount.com',
  privateKey: 'server-only-private-key-marker',
  tokenUri: 'https://oauth2.googleapis.com/token'
});
let tokenCredential;
let savedRpcBody;
const endpointContext = {
  requestId: 'owner-drive-endpoint-test',
  site: {
    id: endpointValues.CNYOS_OWNER_EXPECTED_NETLIFY_SITE_ID,
    url: endpointValues.CNYOS_OWNER_EXPECTED_SITE_ORIGIN
  },
  deploy: { id: 'deploy_1234567890', context: 'production', published: true }
};
const endpointResponse = await handleOwnerDrive(
  new Request('https://synthetic-drive-staging.netlify.app/api/owner-drive', {
    method: 'POST',
    headers: {
      Origin: 'https://synthetic-drive-staging.netlify.app',
      Authorization: `Bearer ${endpointToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      requestId: normalized.requestId,
      clinicId: normalized.clinicId,
      clinicCode: normalized.clinicCode,
      expectedVersion: normalized.expectedVersion,
      reason: normalized.reason,
      folders: normalized.folders
    })
  }),
  endpointContext,
  {
    getEnv: name => endpointValues[name] || '',
    credentialResolver: async input => {
      assert.equal(input.siteId, endpointValues.CNYOS_OWNER_EXPECTED_NETLIFY_SITE_ID);
      assert.equal(input.siteOrigin, endpointValues.CNYOS_OWNER_EXPECTED_SITE_ORIGIN);
      assert.equal(input.expectedServiceAccountEmail, endpointValues.GOOGLE_DRIVE_EXPECTED_SERVICE_ACCOUNT_EMAIL);
      return { serviceAccount: resolvedCredential, source: 'test', keyId: 'test' };
    },
    fetchAccessToken: async serviceAccount => {
      tokenCredential = serviceAccount;
      return 'server-only-google-access-token';
    },
    inspectFolder: async ({ accessToken, folderId, expectedParentId }) => {
      assert.equal(accessToken, 'server-only-google-access-token');
      assert.equal(expectedParentId, endpointValues.GOOGLE_DRIVE_EXPECTED_ROOT_FOLDER_ID);
      return { id: folderId, name: folderId, canAddChildren: true };
    },
    ownerRequest: async options => {
      if (options.resource === '/auth/v1/user') return endpointOwner;
      assert.equal(options.resource, '/rest/v1/rpc/set_clinic_drive_assignment');
      savedRpcBody = options.body;
      return {
        clinicId: normalized.clinicId,
        clinicCode: normalized.clinicCode,
        environment: 'staging',
        patientsFolderId: folderIds.patients,
        productsFolderId: folderIds.products,
        pharmacyFolderId: folderIds.pharmacy,
        transactionsFolderId: folderIds.transactions,
        manifestsFolderId: folderIds.manifests,
        version: 1,
        updatedAt: '2026-09-01T00:00:00.000Z',
        updatedBy: endpointOwner.id,
        reason: normalized.reason,
        changed: true,
        idempotent: false
      };
    }
  }
);
assert.equal(endpointResponse.status, 200);
assert.equal((await endpointResponse.json()).ok, true);
assert.equal(tokenCredential, resolvedCredential, 'POST must mint its Drive token from the resolved Blob credential');
assert.equal(savedRpcBody.p_environment, 'staging');
assert.equal(savedRpcBody.p_patients_folder_id, folderIds.patients);
assert.doesNotMatch(JSON.stringify(endpointValues), /qptxnrldzzinlcabudjv|anotherprojectrefabc/);

let keyReuseReachedAuth = false;
const keyReuseResponse = await handleOwnerDrive(
  new Request('https://synthetic-drive-staging.netlify.app/api/owner-drive', {
    method: 'GET',
    headers: { Origin: 'https://synthetic-drive-staging.netlify.app' }
  }),
  endpointContext,
  {
    getEnv: name => ({
      ...endpointValues,
      BACKUP_ENCRYPTION_KEY_BASE64: endpointValues.GOOGLE_DRIVE_SERVICE_ACCOUNT_WRAP_KEY_BASE64.replace(/=+$/, '')
    })[name] || '',
    ownerRequest: async () => {
      keyReuseReachedAuth = true;
      throw new Error('UNEXPECTED_AUTH');
    }
  }
);
assert.equal(keyReuseResponse.status, 503);
assert.equal((await keyReuseResponse.json()).code, 'CNYOS_OWNER_DRIVE_CREDENTIAL_KEY_REUSE');
assert.equal(keyReuseReachedAuth, false, 'key reuse must fail before Owner auth or data access');

const worker = read('netlify/functions/owner-drive.mts');
assert.match(worker, /path:\s*'\/api\/owner-drive'/);
assert.match(worker, /CNYOS_OWNER_CONTROL_ENABLED/);
assert.match(worker, /CNYOS_OWNER_EXPECTED_PROJECT_REF/);
assert.match(worker, /CNYOS_OWNER_EXPECTED_NETLIFY_SITE_ID/);
assert.match(worker, /CNYOS_OWNER_EXPECTED_SITE_ORIGIN/);
assert.match(worker, /resolveGoogleServiceAccountCredential/);
assert.match(worker, /assertOwnerRuntime/);
assert.match(worker, /const config = configuration\([\s\S]*assertOwnerRuntime\([\s\S]*authenticateOwner\(request, config/);
assert.match(worker, /BACKUP_ENVIRONMENT/);
assert.match(worker, /CNYOS_OWNER_DRIVE_PRODUCTION_DENYLIST_REQUIRED/);
assert.match(worker, /GOOGLE_DRIVE_SERVICE_ACCOUNT_WRAP_KEY_BASE64/);
assert.match(worker, /GOOGLE_DRIVE_SERVICE_ACCOUNT_WRAP_KEY_ID/);
assert.match(worker, /GOOGLE_DRIVE_EXPECTED_SERVICE_ACCOUNT_EMAIL/);
assert.match(worker, /list_owner_drive_assignments/);
assert.match(worker, /set_clinic_drive_assignment/);
assert.match(worker, /p_environment:\s*config\.environment/);
assert.match(worker, /fetchGoogleAccessToken/);
assert.match(worker, /inspectDriveFolder/);
assert.doesNotMatch(worker, /p_environment:\s*input\./);
assert.doesNotMatch(worker, /console\.(?:log|error)\([^\n]*(?:serviceAccountValue|accessToken|Authorization)/);
assert.doesNotMatch(worker, /return json\([^\n]*(?:serviceAccountValue|accessToken|Authorization)/);
assert.doesNotMatch(worker, /serviceAccountAccessToken\(config\.serviceAccount\)/);

console.log('Owner Drive function contracts passed: Google Owner auth, server-fixed environment, five writable folders and audited RPC');
