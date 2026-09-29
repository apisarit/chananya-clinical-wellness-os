/* Metadata-only, per-tab amendment recovery. The server remains authoritative. */
(() => {
  'use strict';
  const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
  const generation = value => {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('AMENDMENT_GENERATION_INVALID');
    const text = String(value);
    if (!/^[1-9][0-9]{0,18}$/.test(text) || BigInt(text) > 9223372036854775807n) throw new Error('AMENDMENT_GENERATION_INVALID');
    return text;
  };
  const key = ({actorId,clinicId}) => {
    if (!uuid(actorId) || !uuid(clinicId)) throw new Error('AMENDMENT_CONTEXT_INVALID');
    return `cnyos.amendment.pending.v1:${clinicId}:${actorId}`;
  };
  const digest = async reason => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(reason))),b=>b.toString(16).padStart(2,'0')).join('');
  function restore(context) {
    const storage=context.storage ?? sessionStorage;
    const raw=storage.getItem(key(context));
    if(raw===null)return null;
    let marker;
    try {marker=JSON.parse(raw);} catch {throw new Error('AMENDMENT_JOURNAL_INVALID');}
    if(!marker || Object.keys(marker).sort().join()!=='actorId,clinicId,encounterId,generation,reasonDigest,requestId,signoffId,version'
      || marker.version!==1 || marker.actorId!==context.actorId || marker.clinicId!==context.clinicId
      || !uuid(marker.encounterId) || !uuid(marker.signoffId) || !uuid(marker.requestId)
      || typeof marker.generation!=='string' || generation(marker.generation)!==marker.generation
      || typeof marker.reasonDigest!=='string' || !/^[a-f0-9]{64}$/.test(marker.reasonDigest)) throw new Error('AMENDMENT_JOURNAL_INVALID');
    return Object.freeze(marker);
  }
  function current(context) {
    if(typeof context.isCurrent!=='function' || !context.isCurrent()) throw new Error('AMENDMENT_CONTEXT_CHANGED');
  }
  async function prepare(context) {
    current(context);
    const {encounterId,signoffId,reason}=context;
    if(!uuid(encounterId) || !uuid(signoffId) || typeof reason!=='string' || reason.trim().length<5 || reason.trim().length>2000)
      throw new Error('AMENDMENT_DRAFT_INVALID');
    const version=generation(context.generation), reasonDigest=await digest(reason.trim());
    current(context);
    const storage=context.storage ?? sessionStorage, storageKey=key(context), existing=restore(context);
    if(context.expectedRequestId!=null && existing?.requestId!==context.expectedRequestId) throw new Error('AMENDMENT_JOURNAL_CHANGED');
    if(existing) {
      if(existing.encounterId!==encounterId || existing.signoffId!==signoffId || existing.generation!==version
        || existing.reasonDigest!==reasonDigest) throw new Error('AMENDMENT_OUTCOME_UNRESOLVED');
      return existing;
    }
    const marker={version:1,actorId:context.actorId,clinicId:context.clinicId,encounterId,signoffId,
      generation:version,reasonDigest,requestId:crypto.randomUUID()};
    const serialized=JSON.stringify(marker);
    storage.setItem(storageKey,serialized);
    if(storage.getItem(storageKey)!==serialized) throw new Error('AMENDMENT_JOURNAL_UNAVAILABLE');
    return Object.freeze(marker);
  }
  function clear(context, marker) {
    current(context);
    const storage=context.storage ?? sessionStorage;
    const existing=restore(context);
    if(!existing || JSON.stringify(existing)!==JSON.stringify(marker)) throw new Error('AMENDMENT_JOURNAL_CHANGED');
    storage.removeItem(key(context));
    if(storage.getItem(key(context))!==null) throw new Error('AMENDMENT_JOURNAL_UNAVAILABLE');
  }
  function confirm(context,marker,receipt) {
    current(context);
    if(!receipt || receipt.request_id!==marker.requestId || receipt.encounter_id!==marker.encounterId
      || receipt.signoff_id!==marker.signoffId || receipt.signature_generation!==marker.generation
      || receipt.actor_id!==marker.actorId || receipt.clinic_id!==marker.clinicId
      || receipt.reason_digest!==marker.reasonDigest || receipt.unlocked!==true) throw new Error('AMENDMENT_RECEIPT_MISMATCH');
    clear(context,marker);
    return receipt;
  }
  async function recover(context) {
    current(context);
    const marker=restore(context);
    if(!marker || typeof context.readReceipt!=='function') throw new Error('AMENDMENT_JOURNAL_MISSING');
    const receipt=await context.readReceipt(marker.requestId);
    current(context);
    if(receipt===null) throw new Error('AMENDMENT_RECEIPT_PENDING');
    return confirm(context,marker,receipt);
  }
  function reject(context,marker,code) {
    if(!['AMENDMENT_SIGNATURE_STALE','AMENDMENT_ALREADY_UNLOCKED'].includes(code)) throw new Error('AMENDMENT_REJECTION_UNVERIFIED');
    clear(context,marker);
  }
  window.CnyosAmendmentJournal=Object.freeze({prepare,restore,confirm,recover,reject,generation});
})();
