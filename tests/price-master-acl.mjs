import assert from 'node:assert/strict';
import { createPriceMasterFixture } from './helpers/price-master-fixture.mjs';
const { db, asOwner, asAnon } = await createPriceMasterFixture({ permissiveDefaults: true });
const rows = await asOwner(`select p.oid::regprocedure::text signature,
  has_function_privilege('anon',p.oid,'EXECUTE') anon,
  has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,
  has_function_privilege('service_role',p.oid,'EXECUTE') service_role
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in (
    'list_price_master','list_price_master_history','set_price_master_item',
    'resolve_price_master_item','setup_price_master_default','price_master_admin',
    'create_price_master_service','create_clinical_treatment_session',
    'quote_treatment_invoice','amend_treatment_session_duration',
    'reject_price_master_audit_mutation','enforce_product_price_snapshot','enforce_invoice_price_snapshot'
  )`);
assert.ok(rows.rows.length >= 13);
for (const row of rows.rows) {
  assert.equal(row.anon, false, `anon must not inherit ${row.signature}`);
  assert.equal(row.service_role, false, `unneeded service-role execute must not survive ${row.signature}`);
  const internal = /^(reject_price_master_audit_mutation|enforce_product_price_snapshot|enforce_invoice_price_snapshot)\(/.test(row.signature);
  assert.equal(row.authenticated, !internal, `explicit authenticated boundary: ${row.signature}`);
}
await assert.rejects(asAnon('select * from public.price_master_audit'), /permission denied/);
await db.close();
console.log('Price-master ACL passed under permissive creator defaults: no unintended anonymous/service-role or trigger execution');
