import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createPriceMasterFixture } from './helpers/price-master-fixture.mjs';

// Deliberately NOT in the passing release suite: this diagnostic exits 1 while
// the known replay defect remains. Disposable local PGlite and synthetic rows.
const {db,ids,asOwner,asUser,asAnon}=await createPriceMasterFixture();
const patient='9b000000-0000-4000-8000-000000000001';
const encounter='9b000000-0000-4000-8000-000000000002';
async function run() {
try {
  const candidate=process.argv.includes('--generation-candidate');
  const receipts=process.argv.includes('--receipt-candidate');
  if(receipts) assert.ok(candidate,'receipt prototype requires generation prototype');
  if (candidate) {
    assert.ok(process.argv.includes('--signature-identity'), 'prototype covers signature identity only');
    await asOwner('select 1');
    await db.exec(await fs.readFile(new URL('./fixtures/amendment-generation-prototype.sql',import.meta.url),'utf8'));
    if(receipts) await db.exec(await fs.readFile(new URL('./fixtures/amendment-receipt-prototype.sql',import.meta.url),'utf8'));
  }
  await asOwner(`select set_config('request.jwt.claim.sub','${ids.owner}',false)`);
  await db.exec(`
    insert into public.patients(id,hn,first_name,last_name,created_by)
    values('${patient}','AMEND-REPLAY-SYN','Synthetic','Replay','${ids.owner}');
    insert into public.encounters(id,encounter_no,patient_id,clinic_id,status,practitioner_id,created_by)
    values('${encounter}','AMEND-REPLAY-ENC','${patient}','${ids.clinicA}','draft','${ids.userA}','${ids.userA}');
    insert into public.clinical_record_signoffs(encounter_id,record_section,signer_id,signer_name,lock_record)
    values('${encounter}','complete_record','${ids.userA}','Synthetic signer',true);
  `);
  const call=`select public.unlock_clinical_record_for_amendment('${encounter}','Synthetic repeated request') as unlocked`;
  const count=async()=>Number((await asOwner(`select count(*) as n from public.clinical_record_audit_events
    where encounter_id='${encounter}' and event_type='UNLOCK_FOR_AMENDMENT'`)).rows[0].n);
  await asUser(ids.superAdmin,call);
  const first=await count();
  assert.equal(first,1,'first authorized unlock must produce its audit event');
  if (process.argv.includes('--stale-signature') || process.argv.includes('--signature-identity')) {
    // Prepare required synthetic clinical sections while the record is unlocked;
    // the actual practitioner signing RPC, not a direct flag update, re-locks it.
    await asOwner(`select set_config('request.jwt.claim.sub','${ids.owner}',false)`);
    await db.exec(`
      insert into public.ttm_structured_diagnoses(encounter_id,analysis_summary,thai_diagnosis,diagnosed_by)
      values('${encounter}','Synthetic analysis','Synthetic diagnosis','${ids.userA}');
      insert into public.clinical_treatment_plans(encounter_id,goal_1,planned_by)
      values('${encounter}','Synthetic goal','${ids.userA}');
    `);
    if (process.argv.includes('--signature-identity')) {
      if(!receipts) await db.exec('begin');
      try {
        const sign=()=>asUser(ids.userA,`select id,signed_at,lock_record${candidate?',signature_generation':''} from public.sign_clinical_record_complete(
          '${encounter}','Synthetic practitioner',null,'Synthetic generation probe')`);
        const a=(await sign()).rows[0];
        const b=(await sign()).rows[0];
        const distinct=candidate ? a.signature_generation!==b.signature_generation
          : a.id!==b.id || String(a.signed_at)!==String(b.signed_at);
        console.log(JSON.stringify({environment:'disposable-pglite',sameRowId:a.id===b.id,
          sameSignedAt:String(a.signed_at)===String(b.signed_at),distinctSignatureIdentity:distinct}));
        assert.equal(distinct,true,'SIGNATURE_IDENTITY_NOT_VERSIONED: id plus signed_at cannot distinguish repeated signing in one transaction');
        if(candidate) {
          assert.equal(Number(b.signature_generation),Number(a.signature_generation)+1);
          if(receipts) {
            const request='9b000000-0000-4000-8000-000000000003';
            const invoke=(key,generation,reason='Synthetic receipt request')=>asUser(ids.superAdmin,
              `select cnyos_amendment_test.unlock_once('${key}','${encounter}','${b.id}',${generation},'${reason}') as receipt`);
            const initial=(await invoke(request,b.signature_generation)).rows[0].receipt;
            const replaySql=`select cnyos_amendment_test.unlock_once('${request}','${encounter}','${b.id}',${b.signature_generation},'Synthetic receipt request')`;
            await assert.rejects(asUser(ids.userA,replaySql),/PERMISSION_DENIED/,'practitioner cannot replay an admin receipt');
            await assert.rejects(asAnon(replaySql),/permission denied/,'anonymous access must be denied at schema/function boundary');
            for(const statement of [
              'select * from cnyos_amendment_test.receipts',
              "update cnyos_amendment_test.receipts set reason='tampered'",
              'delete from cnyos_amendment_test.receipts',
              'truncate cnyos_amendment_test.receipts'
            ]) await assert.rejects(asUser(ids.superAdmin,statement),/permission denied/,'application administrator cannot directly edit/read receipts');
            const events=await count();
            assert.deepEqual((await invoke(request,b.signature_generation)).rows[0].receipt,initial);
            assert.equal(await count(),events,'exact replay must not duplicate audit');
            await assert.rejects(invoke(request,b.signature_generation,'Different request reason'),/AMENDMENT_REQUEST_CONFLICT/);
            const newer=(await sign()).rows[0];
            assert.deepEqual((await invoke(request,b.signature_generation)).rows[0].receipt,initial,'old receipt remains a historical result');
            assert.equal((await asOwner(`select lock_record from public.clinical_record_signoffs where id='${b.id}'`)).rows[0].lock_record,true,'old replay cannot unlock a new signature');
            await assert.rejects(invoke('9b000000-0000-4000-8000-000000000004',b.signature_generation),/AMENDMENT_SIGNATURE_STALE/);
            assert.ok(Number(newer.signature_generation)>Number(b.signature_generation));
            console.log('Receipt prototype passed: exact replay, payload conflict, re-sign preservation and stale-generation denial; disposable fixture only');
            return;
          }
          await asUser(ids.superAdmin,call);
          const unlocked=(await asOwner(`select signature_generation from public.clinical_record_signoffs where encounter_id='${encounter}'`)).rows[0];
          assert.equal(String(unlocked.signature_generation),String(b.signature_generation),'unlock must retain the signed generation');
          return;
        }
      } finally {if(!receipts) await db.exec('rollback');}
    }
    const signed=(await asUser(ids.userA,`select (public.sign_clinical_record_complete(
      '${encounter}','Synthetic practitioner',null,'Synthetic re-sign')).lock_record as locked`)).rows[0];
    assert.equal(signed.locked,true,'actual signing RPC must re-lock before the probe');
    await asUser(ids.superAdmin,call);
    const after=(await asOwner(`select lock_record from public.clinical_record_signoffs
      where encounter_id='${encounter}' and record_section='complete_record'`)).rows[0];
    console.log(JSON.stringify({environment:'disposable-pglite',resignedByActualRpc:true,
      lockedAfterOldRequest:after.lock_record,productionEvidence:false}));
    assert.equal(after.lock_record,true,'AMENDMENT_STALE_SIGNATURE_UNSAFE: old request unlocked the re-signed record');
  }
  await asUser(ids.superAdmin,call);
  const repeated=await count();
  console.log(JSON.stringify({environment:'disposable-pglite',firstUnlockEvents:first,afterExactRepeat:repeated,
    replaySafe:repeated===first,productionEvidence:false}));
  assert.equal(repeated,first,'AMENDMENT_REPLAY_UNSAFE: identical repeated unlock created another audit event');
} finally {await db.close();}
}
await run();
