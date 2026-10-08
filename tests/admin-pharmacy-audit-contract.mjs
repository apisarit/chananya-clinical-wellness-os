import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const admin = read('admin.js');
const adminHtml = read('admin.html');
const migration = read('supabase/migrations/20261008224500_pharmacy_reviewer_dispenser_separation.sql');

assert.match(adminHtml, /id="pharmacy-event-list"/);
assert.match(adminHtml, /สถานะเดิม–สถานะใหม่/);
assert.match(adminHtml, /event ledger แบบ append-only/);
assert.match(adminHtml, /admin\.js\?v=pharmacy-audit-history-20261008/);

assert.match(admin, /query\('dispensing_order_events', '\*', 'created_at'\)/);
assert.match(admin, /event\.from_status/);
assert.match(admin, /event\.to_status/);
assert.match(admin, /event\.actor_id/);
assert.match(admin, /event\.actor_role/);
assert.match(admin, /event\.created_at/);
assert.match(admin, /event\.reason/);

assert.match(migration, /create table if not exists public\.dispensing_order_events/);
assert.match(migration, /create policy dispensing_order_events_tenant_read/);
assert.match(migration, /before update or delete on public\.dispensing_order_events/);
assert.match(migration, /before truncate on public\.dispensing_order_events/);
assert.match(migration, /revoke all on table public\.dispensing_order_events/);
assert.match(migration, /grant select on table public\.dispensing_order_events to authenticated,service_role/);

console.log('Admin pharmacy audit contract passed.');
