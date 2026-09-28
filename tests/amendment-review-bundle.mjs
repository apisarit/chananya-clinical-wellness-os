import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {buildAmendmentReviewBundle,amendmentReviewFiles} from '../scripts/build-amendment-review-bundle.mjs';
import {createPriceMasterFixture} from './helpers/price-master-fixture.mjs';
const read=file=>fs.readFile(new URL(`../${file}`,import.meta.url));
const bundle=await buildAmendmentReviewBundle();
const refused=spawnSync(process.execPath,[new URL('../scripts/build-amendment-review-bundle.mjs',import.meta.url).pathname,'--activate'],{encoding:'utf8'});
assert.equal(refused.status,1);assert.equal(refused.stdout,'');
assert.match(refused.stderr,/NO_ACTIVATION_ARGUMENTS/);
assert.equal(bundle.authorization,false);assert.equal(bundle.productionEligible,false);
assert.equal(bundle.sqlSha256,createHash('sha256').update(bundle.sql).digest('hex'));
assert.deepEqual(bundle,await buildAmendmentReviewBundle(),'same source bytes give same review artifact');
// A verifier's imported helpers are part of its reviewed behavior, not invisible dependencies.
for(const file of ['scripts/restore-trace-request.mjs','scripts/restore-count-comparison.mjs',
  'scripts/generate-tenant-config.mjs','platform-config.js']){
  assert.ok(amendmentReviewFiles.includes(file),`${file} must be review-bound`);
  await assert.rejects(buildAmendmentReviewBundle(async name=>name===file?'':read(name)),/SOURCE_EMPTY/);
  const changedDependency=await buildAmendmentReviewBundle(async name=>name===file?
    Buffer.concat([await read(name),Buffer.from('\n// synthetic dependency change\n')]):read(name));
  assert.notEqual(changedDependency.sources.find(x=>x.file===file).sha256,
    bundle.sources.find(x=>x.file===file).sha256);
}
for(const file of amendmentReviewFiles) {
  const bytes=await read(file),record=bundle.sources.find(item=>item.file===file);
  assert.equal(record.sha256,createHash('sha256').update(bytes).digest('hex'));
  assert.equal(record.bytes,bytes.length);
}
for(const file of ['admin.html','amendment-journal.js'])
  await assert.rejects(buildAmendmentReviewBundle(async name=>name===file?'':read(name)),/SOURCE_EMPTY/);
const recovery='supabase/manual/clinical_amendment_recovery_candidate.sql';
await assert.rejects(buildAmendmentReviewBundle(async file=>file===recovery?(await read(file)).toString().replace("raise exception 'CLINICAL_AMENDMENT_RECOVERY_REVIEW_REQUIRED'",'perform 1'):read(file)),/GUARD_INVALID/);
await assert.rejects(buildAmendmentReviewBundle(async file=>file===recovery?(await read(file)).toString().replace('commit;','commit;\nbegin;\ncommit;'):read(file)),/ENVELOPE_INVALID/);
const changed=await buildAmendmentReviewBundle(async file=>file==='admin.html'?Buffer.concat([await read(file),Buffer.from('\n<!-- synthetic byte change -->')]):read(file));
assert.notEqual(changed.sources.find(x=>x.file==='admin.html').sha256,bundle.sources.find(x=>x.file==='admin.html').sha256);

const {db,asOwner,asService,ids}=await createPriceMasterFixture();
const snapshot=async()=>({
  catalog:(await asOwner(`select pg_get_functiondef('public.unlock_clinical_record_for_amendment(uuid,text)'::regprocedure) body,
    (select proacl::text from pg_proc where oid='public.unlock_clinical_record_for_amendment(uuid,text)'::regprocedure) acl,
    (select relacl::text from pg_class where oid='public.clinical_record_signoffs'::regclass) table_acl,
    to_regnamespace('cnyos_amendment_internal') amendment_schema,
    (select count(*) from information_schema.columns where table_schema='public' and table_name='clinical_record_signoffs' and column_name='signature_generation') generation_columns`)).rows,
  signoffs:(await asOwner('select to_jsonb(s) row from public.clinical_record_signoffs s order by id')).rows,
  // Observation timestamp is not persisted application state.
  backup:(await asService("select public.verify_clinic_restore_trace($1)-'verified_at' value",[ids.clinicA])).rows[0].value
});
const first="do $$ begin raise exception 'CLINICAL_AMENDMENT_RECOVERY_REVIEW_REQUIRED'; end $$;";
const second="do $$ begin raise exception 'CLINICAL_AMENDMENT_BACKUP_REVIEW_REQUIRED'; end $$;";
try {
  await asOwner(`insert into public.encounters(id,encounter_no,patient_id,clinic_id,status,practitioner_id)
    select '9e000000-0000-4000-8000-000000000001','SYN-ATOMIC-AMEND',id,$1,'draft',$2 from public.patients where clinic_id=$1 limit 1`,[ids.clinicA,ids.userA]);
  await asOwner(`insert into public.clinical_record_signoffs(encounter_id,record_section,signer_id,lock_record)
    values('9e000000-0000-4000-8000-000000000001','complete_record',$1,true)`,[ids.userA]);
  const before=await snapshot();
  for(const [sql,error] of [
    [bundle.sql,/CLINICAL_AMENDMENT_RECOVERY_REVIEW_REQUIRED/],
    [bundle.sql.replace(first,'-- disposable test only'),/CLINICAL_AMENDMENT_BACKUP_REVIEW_REQUIRED/],
    [bundle.sql.replace(first,'-- disposable test only').replace(second,'-- disposable test only')
      .replace(/commit;\n$/,()=>"do $$ begin raise exception 'SYNTHETIC_FINAL_FAILURE'; end $$;\ncommit;\n"),/SYNTHETIC_FINAL_FAILURE/]
  ]) {
    await asOwner('select 1');
    await assert.rejects(db.exec(sql),error);
    await db.exec('rollback');
    assert.deepEqual(await snapshot(),before,'failure must restore populated rows, ACL, legacy RPC and old backup contract');
  }
  await asOwner('select 1');
  // Success is a test-only derivative, never emitted by the generator.
  await db.exec(bundle.sql.replace(first,'-- disposable test only').replace(second,'-- disposable test only'));
  const after=await snapshot();
  assert.equal(after.backup.schema_version,'2026-09-27.2');
  assert.equal(after.catalog[0].generation_columns,1);
  assert.equal(after.signoffs[0].row.signature_generation,1);
  assert.equal(after.signoffs[0].row.lock_record,true);
  console.log('Amendment review bundle passed: deterministic source hashes, retained independent blockers, malformed-input refusal, populated/ACL rollback after partial and final failure, and test-only paired install. No activation artifact emitted.');
} finally {await db.close();}
