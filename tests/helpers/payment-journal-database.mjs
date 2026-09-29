import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

export async function preparePaymentRecovery({actorId,clinicId,invoiceId,requestId,amount}) {
  const source=await fs.readFile(new URL('../../payment-journal.js',import.meta.url),'utf8');
  const records=new Map();
  const storage={getItem:key=>records.get(key)??null,setItem:(key,value)=>records.set(key,value),removeItem:key=>records.delete(key)};
  function boot() {
    const context={window:{},sessionStorage:storage,TextEncoder,crypto:{subtle:webcrypto.subtle,randomUUID:()=>requestId}};
    vm.runInNewContext(source,context);return context.window.CnyosPaymentJournal;
  }
  const args={actorId,clinicId};
  await boot().prepare({...args,payload:{p_invoice_id:invoiceId,p_amount:amount,p_channel:'cash',p_reference_note:'Synthetic replacement payment'}});
  assert.equal(records.size,1,'marker must exist before the payment write');
  return async function verify({asUser,foreignActor}) {
    const journal=boot(); // Recreated execution context, preserved session storage.
    const readPayment=actor=>async marker=>{
      assert.equal(marker.requestId,requestId);
      assert.match(marker.requestId,/^[a-f0-9-]{36}$/);
      const result=await asUser(actor,`select jsonb_build_object('clinicId',p.clinic_id,'payment',to_jsonb(pay)) result
        from public.payments pay join public.invoices i on i.id=pay.invoice_id
        join public.patients p on p.id=i.patient_id where pay.request_key='${marker.requestId}'`);
      assert.ok(result.rows.length<=1);
      return result.rows[0]?.result??null;
    };
    const before=(await asUser(actorId,`select count(*)::int n, sum(amount)::text total from public.payments where invoice_id='${invoiceId}'`)).rows[0];
    await assert.rejects(journal.recover({...args,isCurrent:()=>true,readPayment:readPayment(foreignActor)}),/READBACK_MISMATCH/);
    assert.equal(journal.restore(args).requestId,requestId,'denied read must preserve uncertainty');
    const row=await journal.recover({...args,isCurrent:()=>true,readPayment:readPayment(actorId)});
    assert.equal(row.request_key,requestId);
    assert.equal(Number(row.amount),amount);
    assert.equal(journal.restore(args),null);
    const after=(await asUser(actorId,`select count(*)::int n, sum(amount)::text total from public.payments where invoice_id='${invoiceId}'`)).rows[0];
    assert.deepEqual(after,before,'recovery must not insert another payment or alter totals');
    console.log('Payment journal/database passed: marker before commit, recreated controller, foreign-role read denied, exact paid receipt recovered with unchanged count/total. SQL adapter, not hosted REST/UI.');
  };
}
