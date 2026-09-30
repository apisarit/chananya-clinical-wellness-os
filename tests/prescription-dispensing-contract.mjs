import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const migration = read('supabase/migrations/202608270900_atomic_prescription_dispensing.sql');
const pharmacy = read('pharmacy.js');
const pharmacyHtml = read('pharmacy.html');

assert.match(
  migration,
  /create or replace function public\.transition_atomic_prescription_dispensing\s*\(/i,
  'prescription dispensing must cross one controlled RPC'
);
assert.match(migration, /not public\.department_can\('pharmacy'\)/i);
assert.match(migration, /for update of d/i, 'order transition must lock the queue row');
assert.match(
  migration,
  /order by l\.expiry_date nulls last, l\.received_at, l\.id[\s\S]*?for update/i,
  'prescription dispensing must allocate locked lots by FEFO'
);
assert.match(migration, /raise exception 'PRESCRIPTION_STOCK_INSUFFICIENT'/i);
assert.match(migration, /'review_prescription_dispensing'/i);
assert.match(migration, /'dispense_prescription_order'/i);
assert.match(migration, /'submit_prescription_to_billing'/i);
assert.match(
  migration,
  /revoke insert, update, delete on public\.dispensing_items from authenticated/i
);
assert.match(
  migration,
  /revoke insert, update, delete on public\.stock_movements from authenticated/i
);

assert.match(pharmacy, /rpc\('prescription_dispensing_healthcheck'/);
assert.match(pharmacy, /rpc\('transition_atomic_prescription_dispensing'/);
for (const action of ['review', 'dispense', 'submit_billing']) {
  assert.match(pharmacy, new RegExp(`p_action:\\s*'${action}'`));
}
assert.match(pharmacy, /data-rx-price=/, 'Pharmacy must capture a visible sale price');
assert.match(pharmacyHtml, /Review → Prepare → Dispense FEFO → Print label → Submit Billing/);
assert.doesNotMatch(
  pharmacy,
  /\.from\(['"](?:dispensing_orders|dispensing_items|stock_movements)['"]\)\.(?:insert|update|delete|upsert)\s*\(/,
  'Pharmacy browser must not bypass atomic prescription dispensing'
);

console.log('Prescription dispensing contracts passed: role-gated Review, locked FEFO allocation, audited Billing handoff and RPC-only browser writes');
