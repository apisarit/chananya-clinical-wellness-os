import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const migration = fs.readFileSync(
  new URL(
    '../supabase/migrations/20261008224500_pharmacy_reviewer_dispenser_separation.sql',
    import.meta.url
  ),
  'utf8'
);
const compact = migration.replace(/\s+/g, ' ').toLowerCase();

assert.match(migration, /create table if not exists public\.clinic_product_prices/i);
assert.match(migration, /create table if not exists public\.dispensing_order_events/i);
assert.match(migration, /set search_path = pg_catalog, public, pg_temp/gi);
assert.match(migration, /PRESCRIPTION_REVIEWER_DISPENSER_MUST_DIFFER/);
assert.match(migration, /price_source','clinic_product_prices'/i);
assert.match(migration, /v_item\.quantity_prescribed \* v_conversion_factor/i);
assert.match(migration, /stock_base_units_per_dispense_unit/i);
assert.match(migration, /unit_price between 100 and 2000/i);
assert.match(migration, /check \(currency = 'THB'\)/i);
assert.match(migration, /list_clinic_product_price_completeness\(\)/i);
assert.match(
  migration,
  /v_actor_role := case\s+when public\.is_super_admin\(\) then 'super_admin'/i
);
assert.match(
  migration,
  /order by l\.expiry_date nulls last,l\.received_at,l\.id\s+for update/i
);
assert.match(migration, /DISPENSING_ORDER_EVENTS_APPEND_ONLY/);
assert.match(
  migration,
  /where auth\.role\(\)='service_role' or public\.current_clinic_id\(\) is not null/i,
  'healthcheck must remain hidden from a suspended authenticated clinic session'
);
assert.match(
  migration,
  /revoke all on table public\.dispensing_order_events\s+from public,anon,authenticated,service_role/i
);
assert.match(
  migration,
  /grant execute on function public\.transition_atomic_prescription_dispensing\(uuid,text,jsonb,text\)\s+to authenticated/i
);
assert.doesNotMatch(
  compact,
  /v_price_entry|\(p_item_prices[^)]*->>|p_item_prices[^;]*unit_price/,
  'browser item prices must not be parsed as the authoritative sale price'
);

const db = new PGlite();

const actor = async (
  id,
  department,
  statement,
  params = [],
  { superAdmin = false } = {}
) => {
  await db.query(`select set_config('app.actor_id',$1,false)`, [id]);
  await db.query(`select set_config('app.clinic_id',$1,false)`, [CLINIC_ID]);
  await db.query(`select set_config('app.department',$1,false)`, [department]);
  await db.query(`select set_config('app.super_admin',$1,false)`, [String(superAdmin)]);
  await db.query(`select set_config('app.claim_role','authenticated',false)`);
  await db.exec('set role authenticated');
  try {
    return await db.query(statement, params);
  } finally {
    await db.exec('reset role');
  }
};

const CLINIC_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_CLINIC_ID = '10000000-0000-4000-8000-000000000002';
const PRICE_ADMIN_ID = '20000000-0000-4000-8000-000000000001';
const REVIEWER_ID = '20000000-0000-4000-8000-000000000002';
const DISPENSER_ID = '20000000-0000-4000-8000-000000000003';
const PRODUCT_ID = '30000000-0000-4000-8000-000000000001';
const ENCOUNTER_ID = '40000000-0000-4000-8000-000000000001';
const PRESCRIPTION_ID = '50000000-0000-4000-8000-000000000001';
const PRESCRIPTION_2_ID = '50000000-0000-4000-8000-000000000002';
const PRESCRIPTION_3_ID = '50000000-0000-4000-8000-000000000003';
const ITEM_ID = '60000000-0000-4000-8000-000000000001';
const ITEM_2_ID = '60000000-0000-4000-8000-000000000002';
const ORDER_ID = '70000000-0000-4000-8000-000000000001';
const ORDER_2_ID = '70000000-0000-4000-8000-000000000002';
const ORDER_3_ID = '70000000-0000-4000-8000-000000000003';
const LOT_1_ID = '80000000-0000-4000-8000-000000000001';
const LOT_2_ID = '80000000-0000-4000-8000-000000000002';

try {
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema auth;

    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid
    language sql stable
    set search_path = pg_catalog
    as $$
      select nullif(current_setting('app.actor_id',true),'')::uuid
    $$;
    create function auth.role() returns text
    language sql stable
    set search_path = pg_catalog
    as $$
      select nullif(current_setting('app.claim_role',true),'')
    $$;

    create function public.current_clinic_id() returns uuid
    language sql stable
    set search_path = pg_catalog
    as $$
      select nullif(current_setting('app.clinic_id',true),'')::uuid
    $$;
    create function public.current_department_role() returns text
    language sql stable
    set search_path = pg_catalog
    as $$
      select nullif(current_setting('app.department',true),'')
    $$;
    create function public.current_user_role() returns text
    language sql stable
    set search_path = pg_catalog
    as $$ select nullif(current_setting('app.department',true),'') $$;
    create function public.is_super_admin() returns boolean
    language sql stable
    set search_path = pg_catalog
    as $$ select current_setting('app.super_admin',true) = 'true' $$;
    create function public.department_can(capability text) returns boolean
    language sql stable
    set search_path = pg_catalog
    as $$
      select case
        when current_setting('app.super_admin',true) = 'true' then true
        when capability = 'pharmacy' then current_setting('app.department',true) in ('pharmacy','super_admin')
        when capability = 'billing' then current_setting('app.department',true) in ('billing','super_admin')
        when capability = 'governance' then current_setting('app.department',true) in ('owner','admin','super_admin')
        when capability = 'product_read' then current_setting('app.department',true) in ('pharmacy','billing','inventory','super_admin')
        when capability = 'patient_read' then current_setting('app.department',true) in ('practitioner','doctor','reception','pharmacy','billing','super_admin')
        else false
      end
    $$;
    create function public.enforce_authenticated_subscription_statement_write()
    returns trigger
    language plpgsql
    set search_path = pg_catalog
    as $$ begin return null; end $$;

    create table public.clinics(id uuid primary key);
    create table public.products(
      id uuid primary key,
      clinic_id uuid not null references public.clinics(id),
      sku text not null unique,
      name_th text not null,
      active boolean not null default true,
      stock_unit text not null,
      dispense_unit text not null,
      conversion_factor numeric(18,6) not null,
      unique(id,clinic_id)
    );
    create table public.encounters(
      id uuid primary key,
      clinic_id uuid not null references public.clinics(id)
    );
    create table public.prescriptions(
      id uuid primary key,
      prescription_no text not null unique,
      encounter_id uuid not null references public.encounters(id),
      status text not null default 'sent_to_pharmacy',
      completed_at timestamptz,
      updated_at timestamptz not null default now()
    );
    create table public.prescription_items(
      id uuid primary key,
      prescription_id uuid not null references public.prescriptions(id),
      product_id uuid not null references public.products(id),
      quantity_prescribed numeric(18,4) not null,
      unit text not null,
      status text not null default 'ordered',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table public.inventory_lots(
      id uuid primary key,
      clinic_id uuid not null references public.clinics(id),
      product_id uuid not null references public.products(id),
      lot_number text not null,
      expiry_date date,
      received_at timestamptz not null default now(),
      current_quantity numeric(18,4) not null,
      unit text not null,
      status text not null default 'active',
      updated_at timestamptz not null default now()
    );
    create table public.dispensing_orders(
      id uuid primary key,
      prescription_id uuid not null unique references public.prescriptions(id),
      status text not null default 'waiting',
      reviewed_by uuid references auth.users(id),
      reviewed_at timestamptz,
      prepared_by uuid references auth.users(id),
      prepared_at timestamptz,
      dispensed_by uuid references auth.users(id),
      dispensed_at timestamptz,
      updated_at timestamptz not null default now()
    );
    create table public.dispensing_items(
      id uuid primary key default gen_random_uuid(),
      dispensing_order_id uuid not null references public.dispensing_orders(id),
      prescription_item_id uuid not null references public.prescription_items(id),
      inventory_lot_id uuid references public.inventory_lots(id),
      quantity_dispensed numeric(18,4) not null,
      unit text not null,
      unit_price numeric(18,2) not null,
      status text not null,
      notes text
    );
    create table public.stock_movements(
      id uuid primary key default gen_random_uuid(),
      clinic_id uuid not null references public.clinics(id),
      inventory_lot_id uuid not null references public.inventory_lots(id),
      movement_type text not null,
      quantity numeric(18,4) not null,
      direction text not null,
      reference_type text,
      reference_id uuid,
      reason text,
      performed_by uuid references auth.users(id),
      occurred_at timestamptz not null default now()
    );
    create table public.audit_logs(
      id uuid primary key default gen_random_uuid(),
      clinic_id uuid not null references public.clinics(id),
      user_id uuid references auth.users(id),
      action text not null,
      entity text,
      entity_id text,
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );

    create function public.test_apply_stock_movement() returns trigger
    language plpgsql
    set search_path = pg_catalog, public
    as $$
    begin
      if new.direction = 'out' then
        update public.inventory_lots
        set current_quantity = current_quantity - new.quantity,
            updated_at = now()
        where id = new.inventory_lot_id
          and current_quantity >= new.quantity;
        if not found then raise exception 'INSUFFICIENT_STOCK'; end if;
      end if;
      return new;
    end
    $$;
    create trigger test_stock_movement
    after insert on public.stock_movements
    for each row execute function public.test_apply_stock_movement();
  `);

  await db.exec(migration);

  const rpcAcl = await db.query(`
    select
      has_function_privilege(
        'anon',
        'public.transition_atomic_prescription_dispensing(uuid,text,jsonb,text)',
        'execute'
      ) transition_anon,
      has_function_privilege(
        'authenticated',
        'public.transition_atomic_prescription_dispensing(uuid,text,jsonb,text)',
        'execute'
      ) transition_authenticated,
      has_function_privilege(
        'service_role',
        'public.transition_atomic_prescription_dispensing(uuid,text,jsonb,text)',
        'execute'
      ) transition_service,
      has_function_privilege(
        'anon','public.set_clinic_product_price(uuid,numeric,text,text)','execute'
      ) price_anon,
      has_function_privilege(
        'authenticated','public.set_clinic_product_price(uuid,numeric,text,text)','execute'
      ) price_authenticated,
      has_function_privilege(
        'service_role','public.set_clinic_product_price(uuid,numeric,text,text)','execute'
      ) price_service,
      has_function_privilege(
        'anon','public.list_clinic_product_price_completeness()','execute'
      ) completeness_anon,
      has_function_privilege(
        'authenticated','public.list_clinic_product_price_completeness()','execute'
      ) completeness_authenticated,
      has_function_privilege(
        'service_role','public.list_clinic_product_price_completeness()','execute'
      ) completeness_service
  `);
  assert.deepEqual(rpcAcl.rows,[{
    transition_anon:false,
    transition_authenticated:true,
    transition_service:false,
    price_anon:false,
    price_authenticated:true,
    price_service:false,
    completeness_anon:false,
    completeness_authenticated:true,
    completeness_service:false
  }]);

  await db.exec(
    `
      insert into auth.users(id) values
        ('${PRICE_ADMIN_ID}'),('${REVIEWER_ID}'),('${DISPENSER_ID}');
      insert into public.clinics(id) values('${CLINIC_ID}'),('${OTHER_CLINIC_ID}');
      insert into public.products(
        id,clinic_id,sku,name_th,stock_unit,dispense_unit,conversion_factor
      ) values
        ('${PRODUCT_ID}','${CLINIC_ID}','TEST-001','ยาทดสอบ','เม็ด','แผง',10),
        ('30000000-0000-4000-8000-000000000099','${OTHER_CLINIC_ID}',
         'OTHER-001','สินค้าคลินิกอื่น','เม็ด','แผง',10);
      insert into public.encounters(id,clinic_id) values('${ENCOUNTER_ID}','${CLINIC_ID}');
      insert into public.prescriptions(id,prescription_no,encounter_id) values
        ('${PRESCRIPTION_ID}','RX-TEST-001','${ENCOUNTER_ID}'),
        ('${PRESCRIPTION_2_ID}','RX-TEST-002','${ENCOUNTER_ID}'),
        ('${PRESCRIPTION_3_ID}','RX-TEST-003','${ENCOUNTER_ID}');
      insert into public.prescription_items(
        id,prescription_id,product_id,quantity_prescribed,unit
      ) values
        ('${ITEM_ID}','${PRESCRIPTION_ID}','${PRODUCT_ID}',15,'แผง'),
        ('${ITEM_2_ID}','${PRESCRIPTION_2_ID}','${PRODUCT_ID}',100,'แผง');
      insert into public.dispensing_orders(id,prescription_id) values
        ('${ORDER_ID}','${PRESCRIPTION_ID}'),
        ('${ORDER_2_ID}','${PRESCRIPTION_2_ID}'),
        ('${ORDER_3_ID}','${PRESCRIPTION_3_ID}');
      insert into public.inventory_lots(
        id,clinic_id,product_id,lot_number,expiry_date,current_quantity,unit
      ) values
        ('${LOT_1_ID}','${CLINIC_ID}','${PRODUCT_ID}','FEFO-30',current_date + 30,100,'เม็ด'),
        ('${LOT_2_ID}','${CLINIC_ID}','${PRODUCT_ID}','FEFO-180',current_date + 180,200,'เม็ด');
    `
  );

  const incompletePrices = await actor(
    PRICE_ADMIN_ID,
    'billing',
    `select * from public.list_clinic_product_price_completeness()`
  );
  assert.deepEqual(
    incompletePrices.rows.map(row => ({
      sku: row.sku,
      ready: row.price_ready,
      issue: row.issue_code
    })),
    [{ sku:'TEST-001',ready:false,issue:'PRODUCT_PRICE_REQUIRED' }],
    'completeness gate must expose only active products in the caller clinic'
  );
  await assert.rejects(
    actor(
      REVIEWER_ID,
      'pharmacy',
      `select * from public.list_clinic_product_price_completeness()`
    ),
    /PRICE_GOVERNANCE_REQUIRED/
  );
  for (const [invalidPrice,currency,expected] of [
    [99,'THB','PRODUCT_PRICE_INVALID'],
    [2001,'THB','PRODUCT_PRICE_INVALID'],
    [150,'USD','PRODUCT_PRICE_CURRENCY_INVALID']
  ]) {
    await assert.rejects(
      actor(
        PRICE_ADMIN_ID,
        'billing',
        `select public.set_clinic_product_price($1,$2,$3,'invalid boundary')`,
        [PRODUCT_ID,invalidPrice,currency]
      ),
      new RegExp(expected)
    );
  }
  await assert.rejects(
    db.query(
      `insert into public.clinic_product_prices(
        clinic_id,product_id,unit_price,currency
      ) values($1,$2,99,'THB')`,
      [CLINIC_ID,PRODUCT_ID]
    ),
    /clinic_product_prices_thb_range_check/
  );
  await assert.rejects(
    db.query(
      `insert into public.clinic_product_prices(
        clinic_id,product_id,unit_price,currency
      ) values($1,$2,150,'USD')`,
      [CLINIC_ID,PRODUCT_ID]
    ),
    /clinic_product_prices_thb_only_check/
  );

  const price = await actor(
    PRICE_ADMIN_ID,
    'billing',
    `select (public.set_clinic_product_price($1,150,'THB','approved test price')).*`,
    [PRODUCT_ID]
  );
  assert.equal(Number(price.rows[0].unit_price), 150);
  const completePrices = await actor(
    PRICE_ADMIN_ID,
    'owner',
    `select * from public.list_clinic_product_price_completeness()`
  );
  assert.equal(completePrices.rows[0].price_ready,true);
  assert.equal(Number(completePrices.rows[0].unit_price),150);
  assert.equal(completePrices.rows[0].currency,'THB');

  await actor(
    REVIEWER_ID,
    'pharmacy',
    `select public.transition_atomic_prescription_dispensing(
      $1,'review','[]'::jsonb,'reviewed by pharmacist A'
    ) result`,
    [ORDER_ID]
  );

  await assert.rejects(
    actor(
      REVIEWER_ID,
      'pharmacy',
      `select public.transition_atomic_prescription_dispensing(
        $1,'dispense',$2::jsonb,'must fail same actor'
      )`,
      [ORDER_ID,JSON.stringify([{ prescription_item_id: ITEM_ID, unit_price: 9999 }])]
    ),
    /PRESCRIPTION_REVIEWER_DISPENSER_MUST_DIFFER/
  );

  assert.equal(
    Number((await db.query(
      `select count(*) count from public.dispensing_order_events where dispensing_order_id=$1`,
      [ORDER_ID]
    )).rows[0].count),
    1,
    'denied same-actor dispense must not append an event'
  );

  const browserPricePayload = JSON.stringify([
    { prescription_item_id: ITEM_ID, unit_price: 9999 }
  ]);
  const dispensed = await actor(
    DISPENSER_ID,
    'pharmacy',
    `select public.transition_atomic_prescription_dispensing(
      $1,'dispense',$2::jsonb,'dispensed by pharmacist B'
    ) result`,
    [ORDER_ID,browserPricePayload]
  );
  assert.equal(dispensed.rows[0].result.status, 'dispensed');
  assert.equal(dispensed.rows[0].result.allocation_count, 2);
  assert.equal(Number(dispensed.rows[0].result.medication_total), 2250);

  const allocations = await db.query(`
    select l.lot_number,di.quantity_dispensed,di.unit_price,m.quantity stock_quantity
    from public.dispensing_items di
    join public.inventory_lots l on l.id=di.inventory_lot_id
    join public.stock_movements m
      on m.reference_id=di.dispensing_order_id
     and m.inventory_lot_id=di.inventory_lot_id
    where di.dispensing_order_id=$1
    order by l.expiry_date
  `,[ORDER_ID]);
  assert.deepEqual(
    allocations.rows.map(row => ({
      lot: row.lot_number,
      dispensed: Number(row.quantity_dispensed),
      price: Number(row.unit_price),
      stock: Number(row.stock_quantity)
    })),
    [
      { lot: 'FEFO-30', dispensed: 10, price: 150, stock: 100 },
      { lot: 'FEFO-180', dispensed: 5, price: 150, stock: 50 }
    ],
    'FEFO must convert 15 packs to 150 exact base units and ignore browser price'
  );

  const firstRequestKey = dispensed.rows[0].result.request_key;
  const retry = await actor(
    DISPENSER_ID,
    'pharmacy',
    `select public.transition_atomic_prescription_dispensing(
      $1,'dispense','[{"unit_price":1}]'::jsonb,'retry'
    ) result`,
    [ORDER_ID]
  );
  assert.equal(retry.rows[0].result.idempotent, true);
  assert.equal(retry.rows[0].result.request_key, firstRequestKey);
  assert.equal(
    Number((await db.query(
      `select count(*) count from public.dispensing_order_events where dispensing_order_id=$1`,
      [ORDER_ID]
    )).rows[0].count),
    2,
    'idempotent retry must not append another event'
  );

  await actor(
    REVIEWER_ID,
    'pharmacy',
    `select public.transition_atomic_prescription_dispensing(
      $1,'review','[]'::jsonb,'review insufficient order'
    )`,
    [ORDER_2_ID]
  );
  await assert.rejects(
    actor(
      DISPENSER_ID,
      'pharmacy',
      `select public.transition_atomic_prescription_dispensing(
        $1,'dispense','[]'::jsonb,'insufficient stock'
      )`,
      [ORDER_2_ID]
    ),
    /PRESCRIPTION_STOCK_INSUFFICIENT/
  );
  const rollback = await db.query(`
    select
      d.status,
      pi.status item_status,
      count(di.id)::int allocation_count,
      count(sm.id)::int movement_count,
      count(ev.id) filter(where ev.to_status='dispensed')::int dispense_event_count
    from public.dispensing_orders d
    join public.prescriptions rx on rx.id=d.prescription_id
    join public.prescription_items pi on pi.prescription_id=rx.id
    left join public.dispensing_items di on di.dispensing_order_id=d.id
    left join public.stock_movements sm on sm.reference_id=d.id
    left join public.dispensing_order_events ev on ev.dispensing_order_id=d.id
    where d.id=$1
    group by d.status,pi.status
  `,[ORDER_2_ID]);
  assert.deepEqual(rollback.rows,[{
    status: 'reviewed',
    item_status: 'ordered',
    allocation_count: 0,
    movement_count: 0,
    dispense_event_count: 0
  }]);

  await actor(
    PRICE_ADMIN_ID,
    'owner',
    `select public.transition_atomic_prescription_dispensing(
      $1,'review','[]'::jsonb,'super admin governance review'
    )`,
    [ORDER_3_ID],
    { superAdmin:true }
  );
  const superAdminEvent = await db.query(`
    select actor_role
    from public.dispensing_order_events
    where dispensing_order_id=$1 and action='review'
  `,[ORDER_3_ID]);
  assert.equal(
    superAdminEvent.rows[0].actor_role,
    'super_admin',
    'super admin must not be mislabeled with the underlying clinic role'
  );

  for (const [index,factor] of [3,6,12,30].entries()) {
    const serial = String(index + 10).padStart(12,'0');
    const productId = `31000000-0000-4000-8000-${serial}`;
    const prescriptionId = `51000000-0000-4000-8000-${serial}`;
    const itemId = `61000000-0000-4000-8000-${serial}`;
    const orderId = `71000000-0000-4000-8000-${serial}`;
    const lotId = `81000000-0000-4000-8000-${serial}`;
    await db.query(`
      insert into public.products(
        id,clinic_id,sku,name_th,stock_unit,dispense_unit,conversion_factor
      ) values($1,$2,$3,$4,'เม็ด','แผง',$5)
    `,[productId,CLINIC_ID,`FACTOR-${factor}`,`Factor ${factor}`,factor]);
    await db.query(`
      insert into public.prescriptions(id,prescription_no,encounter_id)
      values($1,$2,$3)
    `,[prescriptionId,`RX-FACTOR-${factor}`,ENCOUNTER_ID]);
    await db.query(`
      insert into public.prescription_items(
        id,prescription_id,product_id,quantity_prescribed,unit
      ) values($1,$2,$3,1,'แผง')
    `,[itemId,prescriptionId,productId]);
    await db.query(`
      insert into public.dispensing_orders(id,prescription_id) values($1,$2)
    `,[orderId,prescriptionId]);
    await db.query(`
      insert into public.inventory_lots(
        id,clinic_id,product_id,lot_number,expiry_date,current_quantity,unit
      ) values($1,$2,$3,$4,current_date+30,$5,'เม็ด')
    `,[lotId,CLINIC_ID,productId,`LOT-${factor}`,factor]);
    await actor(
      PRICE_ADMIN_ID,
      'billing',
      `select public.set_clinic_product_price($1,100,'THB',$2)`,
      [productId,`factor ${factor} approved price`]
    );
    await actor(
      REVIEWER_ID,
      'pharmacy',
      `select public.transition_atomic_prescription_dispensing(
        $1,'review','[]'::jsonb,$2
      )`,
      [orderId,`factor ${factor} review`]
    );
    const factorDispense = await actor(
      DISPENSER_ID,
      'pharmacy',
      `select public.transition_atomic_prescription_dispensing(
        $1,'dispense','[]'::jsonb,$2
      ) result`,
      [orderId,`factor ${factor} dispense`]
    );
    assert.equal(factorDispense.rows[0].result.allocation_count,1);
    assert.equal(Number(factorDispense.rows[0].result.medication_total),100);
    const factorEvidence = await db.query(`
      select
        di.quantity_dispensed,
        di.unit,
        sm.quantity stock_quantity,
        l.current_quantity
      from public.dispensing_items di
      join public.stock_movements sm
        on sm.reference_id=di.dispensing_order_id
       and sm.inventory_lot_id=di.inventory_lot_id
      join public.inventory_lots l on l.id=sm.inventory_lot_id
      where di.dispensing_order_id=$1
    `,[orderId]);
    assert.deepEqual(factorEvidence.rows.map(row => ({
      dispensed:Number(row.quantity_dispensed),
      unit:row.unit,
      stock:Number(row.stock_quantity),
      remaining:Number(row.current_quantity)
    })),[{
      dispensed:1,
      unit:'แผง',
      stock:factor,
      remaining:0
    }],`factor ${factor} must consume exact base units without rounding loss`);
  }

  const submitted = await actor(
    DISPENSER_ID,
    'pharmacy',
    `select public.transition_atomic_prescription_dispensing(
      $1,'submit_billing','[]'::jsonb,'ready for billing'
    ) result`,
    [ORDER_ID]
  );
  assert.equal(submitted.rows[0].result.status,'submitted_to_billing');

  const eventEvidence = await db.query(`
    select action,from_status,to_status,actor_id,actor_role,request_key
    from public.dispensing_order_events
    where dispensing_order_id=$1
    order by created_at,id
  `,[ORDER_ID]);
  assert.deepEqual(
    eventEvidence.rows.map(row => ({
      action: row.action,
      from: row.from_status,
      to: row.to_status,
      actor: row.actor_id,
      role: row.actor_role,
      hasRequestKey: Boolean(row.request_key)
    })),
    [
      { action:'review',from:'waiting',to:'reviewed',actor:REVIEWER_ID,role:'pharmacy',hasRequestKey:true },
      { action:'dispense',from:'reviewed',to:'dispensed',actor:DISPENSER_ID,role:'pharmacy',hasRequestKey:true },
      { action:'submit_billing',from:'dispensed',to:'submitted_to_billing',actor:DISPENSER_ID,role:'pharmacy',hasRequestKey:true }
    ]
  );

  await assert.rejects(
    db.query(
      `update public.dispensing_order_events set reason='tampered' where dispensing_order_id=$1`,
      [ORDER_ID]
    ),
    /DISPENSING_ORDER_EVENTS_APPEND_ONLY/
  );
  await assert.rejects(
    db.query(`delete from public.dispensing_order_events where dispensing_order_id=$1`,[ORDER_ID]),
    /DISPENSING_ORDER_EVENTS_APPEND_ONLY/
  );

  const expectedEventCount = Number((await db.query(
    `select count(*) count from public.dispensing_order_events where clinic_id=$1`,
    [CLINIC_ID]
  )).rows[0].count);
  await db.query(`select set_config('app.actor_id',$1,false)`,[REVIEWER_ID]);
  await db.query(`select set_config('app.clinic_id',$1,false)`,[CLINIC_ID]);
  await db.query(`select set_config('app.department','pharmacy',false)`);
  await db.exec('set role authenticated');
  try {
    assert.equal(
      Number((await db.query(`select count(*) count from public.dispensing_order_events`)).rows[0].count),
      expectedEventCount
    );
    await db.query(`select set_config('app.clinic_id',$1,false)`,[OTHER_CLINIC_ID]);
    assert.equal(
      Number((await db.query(`select count(*) count from public.dispensing_order_events`)).rows[0].count),
      0,
      'event RLS must hide another clinic'
    );
    await assert.rejects(
      db.query(`insert into public.dispensing_order_events(
        clinic_id,prescription_id,dispensing_order_id,action,from_status,to_status,
        actor_id,actor_role
      ) values($1,$2,$3,'review','waiting','reviewed',$4,'pharmacy')`,[
        CLINIC_ID,PRESCRIPTION_ID,ORDER_ID,REVIEWER_ID
      ]),
      /permission denied/i
    );
  } finally {
    await db.exec('reset role');
  }

  console.log(
    'Pharmacy separation passed: distinct reviewer/dispenser, server price, converted FEFO, rollback, immutable tenant events'
  );
} finally {
  await db.close();
}
