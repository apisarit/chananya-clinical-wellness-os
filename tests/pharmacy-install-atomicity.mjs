// Disposable SQL rehearsal only. Does not generate/apply a production migration.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createPriceMasterFixture} from './helpers/price-master-fixture.mjs';

const files=['pharmacy_clarification_candidate.sql',
  'pharmacy_clarification_backup_candidate.sql',
  'prescription_replacement_candidate.sql',
  'prescription_replacement_backup_candidate.sql'];
const bodies=[];
for(const file of files) {
  const sql=await fs.readFile(new URL(`../supabase/manual/${file}`,import.meta.url),'utf8');
  // Narrow transformation of these known files, never a general SQL parser.
  assert.equal((sql.match(/^begin;\s*$/gm)||[]).length,1,file);
  assert.equal((sql.match(/^commit;\s*$/gm)||[]).length,1,file);
  assert.match(sql,/commit;\s*$/);
  bodies.push(sql.replace(/^begin;\s*$/m,'').replace(/^commit;\s*$/m,''));
}
const migration='20260926214550_pharmacy_clarification_replacement_bundle.sql';
const releaseSql=await fs.readFile(new URL(`../supabase/migrations/${migration}`,import.meta.url),'utf8');
const normalize=sql=>sql.replace(/^--.*\n/gm,'').replace(/^begin;\s*$/m,'').replace(/^commit;\s*$/m,'').replace(/\s+/g,' ').trim();
assert.equal(normalize(releaseSql),normalize(bodies.join('\n')),'release bundle differs from rehearsed components');
const {db}=await createPriceMasterFixture({permissiveDefaults:true,stopBeforeMigration:migration});
try {
  // This connection is created above, in-memory, from synthetic fixture data.
  // Do not turn this into a live database inventory/export utility.
  const dataSnapshot=async()=>{
    const tables=(await db.query(`select n.nspname,c.relname from pg_class c
      join pg_namespace n on n.oid=c.relnamespace where c.relkind='r'
      and (n.nspname in ('public','auth') or n.nspname like 'cnyos_%')
      order by n.nspname,c.relname`)).rows;
    const result=[];
    const identifier=value=>'"'+value.replaceAll('"','""')+'"';
    for(const {nspname,relname} of tables){
      const rows=(await db.query(`select to_jsonb(t)::text value from
        ${identifier(nspname)}.${identifier(relname)} t order by to_jsonb(t)::text`)).rows;
      result.push({schema:nspname,table:relname,count:rows.length,
        sha256:createHash('sha256').update(JSON.stringify(rows)).digest('hex')});
    }
    return result;
  };
  const snapshot=async()=>({
    routines:(await db.query(`select n.nspname,p.proname,
      pg_get_function_identity_arguments(p.oid) args,pg_get_functiondef(p.oid) definition,
      p.proacl::text acl from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where (n.nspname='public' or n.nspname like 'cnyos_%') and p.prokind='f'
      order by n.nspname,p.proname,args`)).rows,
    relations:(await db.query(`select n.nspname,c.relname,c.relkind,c.relrowsecurity,c.relacl::text acl
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' or n.nspname like 'cnyos_%'
      order by n.nspname,c.relname`)).rows,
    columns:(await db.query(`select n.nspname,c.relname,a.attnum,a.attname,
      format_type(a.atttypid,a.atttypmod) type,a.attnotnull,a.attidentity,a.attgenerated,
      pg_get_expr(d.adbin,d.adrelid) default_expression
      from pg_attribute a join pg_class c on c.oid=a.attrelid
      join pg_namespace n on n.oid=c.relnamespace
      left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
      where (n.nspname='public' or n.nspname like 'cnyos_%')
        and a.attnum>0 and not a.attisdropped
      order by n.nspname,c.relname,a.attnum`)).rows,
    policies:(await db.query(`select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check
      from pg_policies where schemaname='public' or schemaname like 'cnyos_%'
      order by schemaname,tablename,policyname`)).rows,
    triggers:(await db.query(`select n.nspname,c.relname,t.tgname,t.tgenabled,
      pg_get_triggerdef(t.oid) definition from pg_trigger t
      join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
      where (n.nspname='public' or n.nspname like 'cnyos_%') and not t.tgisinternal
      order by n.nspname,c.relname,t.tgname`)).rows,
    constraints:(await db.query(`select n.nspname,c.relname,k.conname,
      pg_get_constraintdef(k.oid) definition from pg_constraint k
      join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' or n.nspname like 'cnyos_%'
      order by n.nspname,c.relname,k.conname`)).rows
  });
  const baseline=await snapshot();
  const baselineData=await dataSnapshot();
  assert.equal(baselineData.find(row=>row.schema==='public'&&row.table==='products')?.count,2);
  assert.ok(baselineData.some(row=>row.schema==='auth'&&row.count>0));
  for(let boundary=0;boundary<bodies.length;boundary++) {
    await db.exec('begin;');
    try {
      for(let index=0;index<=boundary;index++)await db.exec(bodies[index]);
      await assert.rejects(db.exec(`do $$ begin raise exception 'SYNTHETIC_INSTALL_FAILURE'; end $$;`),/SYNTHETIC_INSTALL_FAILURE/);
    } finally {await db.exec('rollback;');}
    assert.deepEqual(await snapshot(),baseline,`partial install leaked after ${files[boundary]}`);
    assert.deepEqual(await dataSnapshot(),baselineData,`fixture data changed after ${files[boundary]}`);
    assert.equal((await db.query("select to_regnamespace('cnyos_clarification_internal') value")).rows[0].value,null);
  }
  await db.exec('begin;');
  try {
    // Exercise the actual migration body, not a fixture-only installation.
    await db.exec(releaseSql.replace(/^begin;\s*$/m,'').replace(/^commit;\s*$/m,''));
    const result=(await db.query(`select to_regprocedure('public.manage_prescription_clarification(uuid,uuid,text,text)') is not null clarification,
      to_regprocedure('public.manage_prescription_replacement(uuid,uuid,text,text,text,jsonb)') is not null replacement,
      to_regclass('cnyos_clarification_internal.replacements') is not null receipts`)).rows[0];
    assert.deepEqual(result,{clarification:true,replacement:true,receipts:true});
  } finally {await db.exec('rollback;');}
  assert.deepEqual(await snapshot(),baseline);
  assert.deepEqual(await dataSnapshot(),baselineData);
  console.log('Pharmacy install rehearsal passed: four injected partial-install failures and complete-install rollback preserve baseline schema and synthetic table counts/SHA256; no deployment or production-shaped populated-upgrade claim.');
} finally {await db.close();}
