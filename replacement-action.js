/* Fixed replacement request identity; never persist clinical text locally. */
(() => {
  'use strict';
  const stable=value=>JSON.stringify(value,(_,item)=>item && typeof item==='object' && !Array.isArray(item)
    ?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
  const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(stable(value)))),byte=>byte.toString(16).padStart(2,'0')).join('');
  const key=(actor,ticket)=>`cnyos.replacement.pending.v1:${actor}:${ticket}`;
  function hasPending({actorId,storage=sessionStorage}) {
    if(typeof actorId!=='string'||!actorId.trim())throw new Error('REPLACEMENT_ACTOR_REQUIRED');
    const prefix=`cnyos.replacement.pending.v1:${actorId}:`;
    for(let index=0;index<storage.length;index++) {
      if(storage.key(index)?.startsWith(prefix))return true;
    }
    return false;
  }
  function validate(marker,actorId,ticketId,oldOrderId) {
    const fields=['actorId','digest','oldOrderId','requestId','ticketId','version'];
    if(!marker||Array.isArray(marker)||Object.keys(marker).sort().join()!==fields.join()
      ||marker.version!==1||marker.actorId!==actorId||marker.ticketId!==ticketId
      ||(oldOrderId!==undefined&&marker.oldOrderId!==oldOrderId)
      ||!['actorId','ticketId','oldOrderId','requestId'].every(field=>typeof marker[field]==='string'&&marker[field].trim().length>0)
      ||typeof marker.digest!=='string'||!/^[a-f0-9]{64}$/.test(marker.digest))throw new Error('REPLACEMENT_PENDING_CONFLICT');
    return marker;
  }
  function restore({db,actorId,ticketId,oldOrderId,storage=sessionStorage}) {
    const serialized=storage.getItem(key(actorId,ticketId));
    if(serialized===null)return null;
    let marker;
    try {marker=validate(JSON.parse(serialized),actorId,ticketId,oldOrderId);}
    catch {throw new Error('REPLACEMENT_PENDING_CONFLICT');}
    return controller({db,marker,serialized,storage});
  }
  async function prepare({db,actorId,ticketId,oldOrderId,reason,notes=null,items,storage=sessionStorage}) {
    if(!actorId||!ticketId||!oldOrderId||typeof reason!=='string'||reason.trim().length<3||reason.trim().length>2000
      ||!Array.isArray(items)||!items.length)throw new Error('REPLACEMENT_DRAFT_INVALID');
    const body=JSON.parse(JSON.stringify({ticket:ticketId,reason:reason.trim(),notes,items}));
    const hash=await digest(body);
    const storageKey=key(actorId,ticketId);
    const previous=storage.getItem(storageKey);
    let marker;
    try {marker=previous!==null?JSON.parse(previous):{version:1,actorId,ticketId,oldOrderId,requestId:crypto.randomUUID(),digest:hash};}
    catch {throw new Error('REPLACEMENT_PENDING_CONFLICT');}
    validate(marker,actorId,ticketId,oldOrderId);
    if(marker.digest!==hash)throw new Error('REPLACEMENT_PENDING_CONFLICT');
    const serialized=JSON.stringify(marker);
    if(previous===null)storage.setItem(storageKey,serialized);
    if(storage.getItem(storageKey)!==serialized)throw new Error('REPLACEMENT_JOURNAL_UNAVAILABLE');
    return controller({db,marker,serialized,storage,body,resumed:previous!==null});
  }
  function controller({db,marker,serialized,storage,body=null,resumed=true}) {
    const {actorId,ticketId,oldOrderId,digest:hash}=marker;
    const storageKey=key(actorId,ticketId);
    let busy=false,confirmed=null;
    let uncertain=resumed,rejected=false,discarded=false;
    const canDiscard=()=>rejected&&!uncertain&&!busy&&!confirmed&&!discarded;
    async function verify(receipt) {
      if(receipt?.request_id!==marker.requestId||receipt.ticket_id!==ticketId||receipt.old_order_id!==oldOrderId
        ||receipt.actor_id!==actorId||typeof receipt.new_rx_id!=='string'||!receipt.new_rx_id.trim()
        ||typeof receipt.new_order_id!=='string'||!receipt.new_order_id.trim()||receipt.new_order_id===oldOrderId
        ||await digest(receipt.request_payload)!==hash)throw new Error('REPLACEMENT_READBACK_MISMATCH');
      return receipt;
    }
    async function run(write) {
      if(write&&!body)throw new Error('REPLACEMENT_DRAFT_REQUIRED');
      if(discarded)throw new Error('REPLACEMENT_REQUEST_DISCARDED');
      if(confirmed)return confirmed;
      if(busy)throw new Error('REPLACEMENT_REQUEST_BUSY');
      if(storage.getItem(storageKey)!==serialized)throw new Error('REPLACEMENT_JOURNAL_CHANGED');
      busy=true;
      try {
        if(write) {
          const priorUncertainty=uncertain;
          uncertain=true;rejected=false;
          const result=await db.rpc('manage_prescription_replacement',{p_request_id:marker.requestId,p_ticket_id:ticketId,
            p_action:'replace',p_reason:body.reason,p_notes:body.notes,p_items:body.items});
          if(result.error) {
            if(!priorUncertainty&&result.error.code==='P0001'
              && /^REPLACEMENT_(ACCESS_DENIED|REQUEST_INVALID|TICKET_NOT_FOUND|PRESCRIBER_REQUIRED|REASON_REQUIRED|CORRECTION_REQUIRED|REVISION_CHANGED)$/.test(result.error.message||'')) {
              uncertain=false;rejected=true;
            }
            throw result.error;
          }
          await verify(result.data);
        }
        const read=await db.rpc('manage_prescription_replacement',{p_request_id:marker.requestId,p_ticket_id:ticketId,p_action:'read'});
        if(read.error)throw read.error;
        const receipt=await verify(read.data);
        if(storage.getItem(storageKey)!==serialized)throw new Error('REPLACEMENT_JOURNAL_CHANGED');
        storage.removeItem(storageKey);
        confirmed=receipt;
        return confirmed;
      } finally {busy=false;}
    }
    return Object.freeze({requestId:marker.requestId,submit:()=>run(true),recover:()=>run(false),canDiscard,discard:()=>{
      if(!canDiscard())throw new Error('REPLACEMENT_OUTCOME_UNCERTAIN');
      if(storage.getItem(storageKey)!==serialized)throw new Error('REPLACEMENT_JOURNAL_CHANGED');
      storage.removeItem(storageKey);discarded=true;
    }});
  }
  window.CnyosReplacementAction=Object.freeze({prepare,restore,hasPending});
})();
