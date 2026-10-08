import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url),'utf8');
const html = read('admin.html');
const admin = read('admin.js');
const runtime = read('chananya-runtime.js');
const shell = read('app-shell.js');
const packageJson = JSON.parse(read('package.json'));
const migration = read(
  'supabase/migrations/20261008224500_pharmacy_reviewer_dispenser_separation.sql'
);

assert.match(packageJson.scripts['check:pharmacy-separation'], /node tests\/admin-price-master-contract\.mjs/);
assert.match(packageJson.scripts['check:workflow-ui'], /npm run check:pharmacy-separation/);
assert.match(
  packageJson.scripts.precheck,
  /npm run check:workflow-ui/,
  'npm run check lifecycle must execute the Price Master contract before the main check body'
);

for (const marker of [
  'data-view="prices"',
  'id="price-master-form"',
  'id="price-product"',
  'id="price-unit-price"',
  'id="price-currency"',
  'id="price-reason"',
  'id="price-master-list"',
  'id="price-blocking-message"'
]) assert.match(html,new RegExp(marker));
assert.match(html,/min="100" max="2000"/);
assert.match(html,/value="THB" readonly/);
assert.match(html,/ขาดราคา \(Blocking\)/);
assert.match(html,/admin\.js\?v=pharmacy-audit-history-20261008-price-master1/);
assert.match(html,/app\.css\?v=cnyos-price-master-20261008/);
assert.match(html,/chananya-runtime\.js\?v=cnyos-price-master-20261008/);
assert.match(html,/app-shell\.js\?v=cnyos-price-master-20261008/);

for (const page of [
  'index.html','appointments.html','check-in.html','clinical-v3.html','evidence.html',
  'foundation.html','luopan.html','outcomes.html','pharmacy.html','production.html',
  'quality.html'
]) {
  const source = read(page);
  assert.match(source,/chananya-runtime\.js\?v=cnyos-price-master-20261008/,`${page} must refresh runtime capability`);
  assert.match(source,/app-shell\.js\?v=cnyos-price-master-20261008/,`${page} must refresh Price Master route`);
}
for (const page of ['owner-control.html','platform-console.html']) {
  assert.match(read(page),/chananya-runtime\.js\?v=cnyos-price-master-20261008/);
}

assert.match(runtime,/price_master_manage:\s*\['super_admin','admin','billing'\]/);
assert.match(
  shell,
  /key: 'prices', href: '\/admin\.html#prices'.*capability: 'price_master_manage'/
);
assert.match(admin,/canManagePrices = runtime\.can\(profile, 'price_master_manage'\)/);

const loadStart = admin.indexOf('  async function load()');
const loadEnd = admin.indexOf('  function options(',loadStart);
assert.ok(loadStart > -1 && loadEnd > loadStart);
const loadSource = admin.slice(loadStart,loadEnd);
const billingBranch = loadSource.slice(0,loadSource.indexOf('    const [tasks'));
assert.match(billingBranch,/if \(!canAdminCenter\)/);
assert.match(billingBranch,/prices: await loadPrices\(\)/);
assert.match(billingBranch,/render\(\);\s*return;/);
assert.doesNotMatch(billingBranch,/approval_tasks|approval_actions|staff_list|admin_task_summary|dispensing_order_events/);
assert.match(admin,/if \(!canAdminCenter\) throw new Error\('บัญชีนี้ไม่มีสิทธิ์ Admin Task Center'\)/);
assert.match(admin,/if \(!canAdminCenter\) throw new Error\('บัญชีนี้ไม่มีสิทธิ์จัดการผู้ใช้'\)/);
assert.match(admin,/if \(button\.dataset\.view !== 'prices'\) button\.remove\(\)/);
assert.match(admin,/if \(section\.id !== 'prices'\) section\.remove\(\)/);

assert.match(admin,/db\.rpc\('list_clinic_product_price_completeness'\)/);
assert.match(admin,/db\.rpc\('set_clinic_product_price'/);
assert.match(admin,/p_currency: 'THB'/);
assert.match(admin,/unitPrice < 100 \|\| unitPrice > 2000/);
assert.doesNotMatch(admin,/\.from\('clinic_product_prices'\)\.(insert|update|upsert|delete)/);

assert.match(migration,/create or replace function public\.list_clinic_product_price_completeness\(\)/i);
assert.match(migration,/raise exception 'PRICE_GOVERNANCE_REQUIRED'/);
assert.match(migration,/where p\.clinic_id = v_clinic_id\s+and p\.active/i);
assert.match(migration,/case when price\.id is null then 'PRODUCT_PRICE_REQUIRED'/i);
assert.match(migration,/unit_price between 100 and 2000/i);
assert.match(migration,/check \(currency = 'THB'\)/i);
assert.match(
  migration,
  /revoke all on function public\.list_clinic_product_price_completeness\(\)\s+from public,anon,authenticated,service_role/i
);
assert.match(
  migration,
  /grant execute on function public\.list_clinic_product_price_completeness\(\)\s+to authenticated/i
);

const renderStart = admin.indexOf('  function renderPrices()');
const renderEnd = admin.indexOf('  function render()',renderStart);
assert.ok(renderStart > -1 && renderEnd > renderStart);
const elements = new Map([
  ['#price-ready-count',{ textContent:'' }],
  ['#price-missing-count',{ textContent:'' }],
  ['#price-blocking-message',{
    textContent:'',
    classList:{ toggle(name,value) { this[name] = value; } }
  }],
  ['#price-product',{ innerHTML:'' }],
  ['#price-master-list',{ innerHTML:'' }]
]);
const data = { prices:[
  {
    product_id:'product-missing',sku:'A-001',name_th:'ยาที่ยังไม่มีราคา',
    stock_unit:'เม็ด',dispense_unit:'แผง',conversion_factor:12,
    unit_price:null,currency:null,price_ready:false,issue_code:'PRODUCT_PRICE_REQUIRED'
  },
  {
    product_id:'product-ready',sku:'B-001',name_th:'ยาพร้อมขาย',
    stock_unit:'เม็ด',dispense_unit:'แผง',conversion_factor:6,
    unit_price:150,currency:'THB',price_ready:true,issue_code:null
  }
] };
const esc = value => String(value ?? '').replace(/[&<>"']/g,character => ({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[character]));
const options = (rows,label) => '<option value="">เลือก</option>'
  + rows.map(item => `<option value="${esc(item.id ?? item.product_id)}">${esc(label(item))}</option>`).join('');
vm.runInNewContext(
  `${admin.slice(renderStart,renderEnd)}\nrenderPrices();`,
  {
    data,
    $: selector => elements.get(selector),
    esc,
    options,
    Number,
    String
  }
);
assert.equal(elements.get('#price-ready-count').textContent,1);
assert.equal(elements.get('#price-missing-count').textContent,1);
assert.match(elements.get('#price-blocking-message').textContent,/ห้องยาจะจ่ายรายการเหล่านี้ไม่ได้/);
assert.match(elements.get('#price-product').innerHTML,/value="product-missing"/);
assert.match(elements.get('#price-master-list').innerHTML,/ขาดราคา · Blocking/);
assert.match(
  elements.get('#price-master-list').innerHTML,
  /อัตราแปลง: 1 แผง = 12 เม็ด \(หน่วยสต็อกฐานต่อ 1 หน่วยจ่าย\)/
);
assert.match(elements.get('#price-master-list').innerHTML,/฿150\.00 THB\/แผง/);

console.log('Admin Price Master contract passed: billing-only route, governed THB bounds, completeness blocking and RPC-only writes.');
