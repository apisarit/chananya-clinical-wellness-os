// Metadata-only inventory on a disposable migrated fixture. Never exports rows.
import assert from 'node:assert/strict';
import {createPriceMasterFixture} from './helpers/price-master-fixture.mjs';
const {db}=await createPriceMasterFixture();
try {
  const {rows}=await db.query(`
    with recursive related(oid) as (
      select 'public.patients'::regclass::oid
      union
      select c.conrelid from pg_constraint c join related r on c.confrelid=r.oid
      where c.contype='f'
    )
    select n.nspname as schema_name,t.relname as table_name,
      t.relrowsecurity as rls_enabled,
      coalesce((select jsonb_agg(jsonb_build_object(
        'constraint',c.conname,'target_schema',pn.nspname,'target_table',pt.relname,
        'definition',pg_get_constraintdef(c.oid)) order by c.conname)
        from pg_constraint c join pg_class pt on pt.oid=c.confrelid
        join pg_namespace pn on pn.oid=pt.relnamespace
        where c.conrelid=t.oid and c.contype='f' and c.confrelid in(select oid from related)),
        '[]'::jsonb) as patient_link_paths
    from related r join pg_class t on t.oid=r.oid
    join pg_namespace n on n.oid=t.relnamespace
    order by n.nspname,t.relname`);
  const tables=new Set(rows.map(row=>`${row.schema_name}.${row.table_name}`));
  for(const table of ['public.patients','public.encounters','public.prescriptions','public.prescription_items','public.dispensing_orders','public.invoices','public.payments'])
    assert.ok(tables.has(table),`Missing patient-linked table: ${table}`);
  assert.equal(tables.size,rows.length,'recursive paths must not duplicate tables');
  const possibleIndirect=(await db.query(`
    select n.nspname as schema_name,t.relname as table_name,a.attname as column_name,
      format_type(a.atttypid,a.atttypmod) as data_type
    from pg_attribute a join pg_class t on t.oid=a.attrelid
    join pg_namespace n on n.oid=t.relnamespace
    where t.relkind in ('r','p') and a.attnum>0 and not a.attisdropped
      and (n.nspname='public' or n.nspname like 'cnyos\\_%' escape '\\')
      and (a.atttypid in ('json'::regtype,'jsonb'::regtype)
        or a.attname in ('patient_id','encounter_id','entity_id','reference_id','subject_id'))
    order by n.nspname,t.relname,a.attnum`)).rows.map(row=>({...row,
      foreign_key_reachable:tables.has(`${row.schema_name}.${row.table_name}`)}));
  assert.ok(possibleIndirect.some(row=>row.table_name==='clinic_state'&&row.column_name==='data'&&!row.foreign_key_reachable),
    'Legacy clinic JSON must not disappear from the coverage review');
  assert.ok(possibleIndirect.some(row=>row.table_name==='audit_logs'&&row.column_name==='entity_id'),
    'Generic audit references need a separate subject-scoping review');
  console.log(JSON.stringify({kind:'patient-export-schema-inventory',scope:'ordered migrations in disposable fixture',
    authorization:false,complete_patient_export:false,
    limitations:['Foreign-key paths are review candidates, not disclosure authorization.',
      'JSON/text references, attachments, external providers and uninstalled manual candidates require separate inventory.',
      'Column redaction, requester identity, role/tenant denial, consistent snapshot, audit and delivery remain unimplemented by this inventory.'],
    tables:rows,possible_indirect_sources:possibleIndirect},null,2));
} finally {await db.close();}
