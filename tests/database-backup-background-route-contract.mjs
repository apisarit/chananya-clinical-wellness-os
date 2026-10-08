import assert from 'node:assert/strict';
import backgroundHandler, {
  config
} from '../netlify/functions/database-backup-background.mts';

assert.equal(
  typeof backgroundHandler,
  'function',
  'the POST-only route must preserve the Netlify background handler export'
);
assert.deepEqual(
  config,
  { method: 'POST' },
  'Netlify must reject GET before it can enqueue the background worker'
);

console.log('Database backup background route checks passed: POST-only ingress with background handler preserved');
