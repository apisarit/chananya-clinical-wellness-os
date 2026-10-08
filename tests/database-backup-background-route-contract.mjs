import assert from 'node:assert/strict';
import fs from 'node:fs';
import backgroundHandler, {
  config
} from '../netlify/functions/database-backup-background.mts';
import {
  BACKUP_BACKGROUND_FUNCTION_PATH
} from '../netlify/functions/_shared/database-backup-runtime.mjs';

assert.equal(
  typeof backgroundHandler,
  'function',
  'the POST-only route must preserve the Netlify background handler export'
);
assert.deepEqual(
  config,
  {
    path: '/api/internal/database-backup-worker',
    method: 'POST'
  },
  'Netlify must receive an explicit POST-only route before it can enqueue the background worker'
);
assert.equal(
  config.path,
  BACKUP_BACKGROUND_FUNCTION_PATH,
  'the scheduler destination and deployed background route must remain identical'
);
const source = fs.readFileSync(
  new URL('../netlify/functions/database-backup-background.mts', import.meta.url),
  'utf8'
);
assert.match(
  source,
  /path:\s*'\/api\/internal\/database-backup-worker'/,
  'the custom route must remain a literal that Netlify can extract at build time'
);
assert.doesNotMatch(
  source,
  /path:\s*BACKUP_BACKGROUND_FUNCTION_PATH/,
  'an imported route constant would silently produce no Netlify route metadata'
);

console.log('Database backup background route checks passed: explicit POST-only ingress with background handler preserved');
