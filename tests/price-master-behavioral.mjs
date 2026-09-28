import assert from 'node:assert/strict';
import { createPriceMasterFixture } from './helpers/price-master-fixture.mjs';

const { db, ids, asUser, asAnon, asService, asOwner } = await createPriceMasterFixture();
const owner = ids.owner;
const practitioner = ids.userA;
const otherTenant = ids.userB;

async function expectDbError(work, code) {
  await assert.rejects(work, error => String(error.message).includes(code), code);
}

const setup = await asUser(owner, `select * from public.setup_price_master_default()`);
assert.equal(setup.rows.length, 1);
const setupRow = setup.rows[0];
const service = await asUser(owner, `
  select * from public.resolve_price_master_item('service', null, '${setupRow.service_id}')
`);
assert.equal(service.rows.length, 1);
assert.equal(Number(service.rows[0].unit_price), 650);
assert.equal(service.rows[0].unit_code, 'hour');

const ownerCatalog = await asUser(owner, `select * from public.list_price_master()`);
assert.ok(ownerCatalog.rows.some(row => row.item_type === 'service' && Number(row.unit_price) === 650));
assert.ok(ownerCatalog.rows.some(row => row.item_type === 'service' && row.service_id === ids.serviceA && row.unit_price === null),
  'active clinic services without prices must remain visible as unpriced');

const productInsert = await asUser(owner, `
  select * from public.set_price_master_item(
    '${setupRow.price_list_id}', 'product', '${ids.productA}', null,
    'ชิ้น', 100, 0, 'Initial product price'
  )
`);
assert.equal(Number(productInsert.rows[0].unit_price), 100);
assert.equal(Number(productInsert.rows[0].item_version), 1);

const productUpdate = await asUser(owner, `
  select * from public.set_price_master_item(
    '${setupRow.price_list_id}', 'product', '${ids.productA}', null,
    'ชิ้น', 120, 1, 'Reviewed product price'
  )
`);
assert.equal(Number(productUpdate.rows[0].unit_price), 120);
assert.equal(Number(productUpdate.rows[0].item_version), 2);
await expectDbError(
  asUser(owner, `select * from public.set_price_master_item(
    '${setupRow.price_list_id}', 'product', '${ids.productA}', null,
    'ชิ้น', 130, 1, 'Stale product price'
  )`),
  'PRICE_MASTER_VERSION_CONFLICT'
);

const history = await asUser(owner, `select * from public.list_price_master_history('${productInsert.rows[0].item_id}')`);
assert.ok(history.rows.some(row => row.before_state && row.after_state));
await expectDbError(asUser(owner, `delete from public.price_master_audit`), 'permission denied');

await expectDbError(
  asUser(practitioner, `select * from public.setup_price_master_default()`),
  'PRICE_MASTER_ADMIN_REQUIRED'
);
const otherCatalog = await asUser(otherTenant, `select * from public.list_price_master()`);
assert.equal(otherCatalog.rows.some(row => row.product_id === ids.productA), false);
const crossTenantDirect = await asUser(otherTenant, `select count(*)::int count from public.price_lists where clinic_id='${ids.clinicA}'`);
assert.equal(crossTenantDirect.rows[0].count, 0);

await expectDbError(
  asUser(owner, `select * from public.set_price_master_item(
    '${setupRow.price_list_id}', 'product', '${ids.productA}', null,
    'wrong-unit', 140, 2, 'Wrong unit'
  )`),
  'PRICE_MASTER_UNIT_MISMATCH'
);
await expectDbError(
  asUser(owner, `select * from public.set_price_master_item(
    '${setupRow.price_list_id}', 'product', '${ids.productA}', null,
    'ชิ้น', null, 2, 'Null price'
  )`),
  'PRICE_MASTER_PRICE_INVALID'
);
await expectDbError(
  asUser(owner, `select * from public.set_price_master_item(
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'product', '${ids.productA}', null,
    'ชิ้น', 140, 0, 'Missing list'
  )`),
  'PRICE_MASTER_LIST_NOT_FOUND'
);

await expectDbError(asAnon(`select * from public.list_price_master()`), 'permission denied');
await expectDbError(
  asAnon(`select * from public.set_price_master_item(
    '${setupRow.price_list_id}', 'product', '${ids.productA}', null,
    'ชิ้น', 140, 2, 'Anonymous attempt'
  )`),
  'permission denied'
);

const clinicState = (await asOwner(`select subscription_state,subscription_version from public.clinics where id='${ids.clinicA}'`)).rows[0];
await asOwner(`select public.set_clinic_subscription_state(
  'f1111111-1111-4111-a111-111111111111'::uuid,
  '${ids.clinicA}'::uuid, 'CHANANYA', false, ${clinicState.subscription_version}::bigint,
  'Price master subscription OFF test', '${owner}'::uuid, 'owner@example.test'
)`);
const suspendedList = await asUser(owner, `select * from public.list_price_master()`);
assert.equal(suspendedList.rows.length, 0);
await expectDbError(asUser(owner, `select * from public.setup_price_master_default()`), 'CNYOS_CLINIC_CONTEXT_REQUIRED');
const preserved = await asOwner(`select count(*)::int count from public.price_list_items where id='${productInsert.rows[0].item_id}'`);
assert.equal(preserved.rows[0].count, 1, 'OFF must preserve price records');
await asOwner(`select public.set_clinic_subscription_state(
  'f2222222-2222-4222-a222-222222222222'::uuid,
  '${ids.clinicA}'::uuid, 'CHANANYA', true, ${Number(clinicState.subscription_version) + 1}::bigint,
  'Price master subscription ON recovery', '${owner}'::uuid, 'owner@example.test'
)`);

console.log('Price-master full-migration behavioral checks passed: RLS tenant scope, owner/admin role, explicit 650 setup, updates/version conflicts, input validation, anon denial, subscription OFF denial, and record preservation');
