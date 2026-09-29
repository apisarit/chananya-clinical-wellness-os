/* One explicit clinical decision; retries reuse its identity and exact content.
 * The optional reload journal stores metadata/digest only, never clinical text.
 * No automatic mutation retry, price calculation or authorization here.
 */
(() => {
  'use strict';
  function create({ db, orderId, actorId, action, requestId, text = '', resumed = false }) {
    const content = String(text).trim();
    if (!orderId || !actorId || !['open', 'answer', 'acknowledge'].includes(action)
      || (action !== 'acknowledge' && (content.length < 3 || content.length > 2000))) {
      throw new Error('CLARIFICATION_INPUT_INVALID');
    }
    const key = requestId || (action === 'open' ? crypto.randomUUID() : null);
    if (!key) throw new Error('CLARIFICATION_REQUEST_REQUIRED');
    let busy = false, attempted = resumed, confirmed = null;
    let uncertain = resumed, rejected = false;
    const args = Object.freeze({ p_order_id: orderId, p_request_id: key,
      p_action: action, p_text: action === 'acknowledge' ? null : content });
    async function read() {
      const result = await db.rpc('manage_prescription_clarification', {
        p_order_id: orderId, p_request_id: key, p_action: 'read', p_text: null
      });
      if (result.error) throw result.error;
      const ticket = result.data;
      if (!ticket || ticket.order_id !== orderId || ticket.request_id !== key
        || !['open', 'answered', 'resolved'].includes(ticket.status)
        || (action === 'open' && (ticket.requested_by !== actorId || ticket.question !== content))
        || (action === 'answer' && (!['answered', 'resolved'].includes(ticket.status)
          || ticket.answered_by !== actorId || ticket.answer !== content))
        || (action === 'acknowledge' && (ticket.status !== 'resolved' || ticket.acknowledged_by !== actorId))) {
        throw new Error('CLARIFICATION_READBACK_MISMATCH');
      }
      confirmed = ticket;
      uncertain = false; rejected = false;
      return ticket;
    }
    async function run(write) {
      if (busy) throw new Error('CLARIFICATION_ACTION_PENDING');
      if (confirmed) return confirmed;
      if (!write && !attempted) throw new Error('CLARIFICATION_NOT_ATTEMPTED');
      busy = true;
      try {
        if (write) {
          attempted = true;
          const priorUncertainty = uncertain;
          uncertain = true; rejected = false;
          // Any error leaves this same decision available for read-only recovery.
          const response = await db.rpc('manage_prescription_clarification', { ...args });
          if (response.error) {
            const definitive = response.error.code === '42501'
              || (response.error.code === 'P0001' && /^(?:CLARIFICATION|CNYOS_SUBSCRIPTION)_[A-Z_]+$/.test(response.error.message || ''));
            // A rejected retry cannot establish that a prior lost response did not commit.
            if (definitive && !priorUncertainty) { rejected = true; uncertain = false; }
            throw response.error;
          }
        }
        return await read();
      } finally { busy = false; }
    }
    return Object.freeze({ requestId: key, submit: () => run(true), recover: () => run(false),
      canDiscard: () => rejected && !uncertain && !busy && !confirmed });
  }
  const storageKey = (actor, order) => `cnyos.clarification.pending.v1:${encodeURIComponent(actor)}:${encodeURIComponent(order)}`;
  const digest = async (marker, text) => {
    const bytes = new TextEncoder().encode(JSON.stringify([
      marker.actorId, marker.orderId, marker.requestId, marker.action,
      marker.action === 'acknowledge' ? '' : String(text).trim()
    ]));
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      byte => byte.toString(16).padStart(2, '0')).join('');
  };
  function journal(db, marker, storage, raw, base = null) {
    const key = storageKey(marker.actorId, marker.orderId);
    let busy = false, confirmed = null;
    const clear = () => {
      if (storage.getItem(key) === raw) storage.removeItem(key);
    };
    async function run(readOnly, text) {
      if (busy) throw new Error('CLARIFICATION_ACTION_PENDING');
      if (confirmed) return confirmed;
      busy = true;
      try {
        if (!base && readOnly) {
          const result = await db.rpc('manage_prescription_clarification', {
            p_order_id: marker.orderId, p_request_id: marker.requestId, p_action: 'read', p_text: null
          });
          if (result.error) throw result.error;
          const ticket = result.data;
          if (!ticket || ticket.order_id !== marker.orderId || ticket.request_id !== marker.requestId
            || !['open','answered','resolved'].includes(ticket.status)
            || (marker.action === 'open' && ticket.requested_by !== marker.actorId)
            || (marker.action === 'answer' && (!['answered','resolved'].includes(ticket.status) || ticket.answered_by !== marker.actorId))
            || (marker.action === 'acknowledge' && (ticket.status !== 'resolved' || ticket.acknowledged_by !== marker.actorId))) {
            throw new Error('CLARIFICATION_READBACK_MISMATCH');
          }
          const content = marker.action === 'open' ? ticket.question : marker.action === 'answer' ? ticket.answer : '';
          if (typeof content !== 'string') throw new Error('CLARIFICATION_READBACK_MISMATCH');
          if (await digest(marker, content) !== marker.digest) throw new Error('CLARIFICATION_READBACK_MISMATCH');
          clear();
          confirmed = ticket;
          return ticket;
        }
        if (!base) {
          if (await digest(marker, text ?? '') !== marker.digest) throw new Error('CLARIFICATION_ORIGINAL_TEXT_REQUIRED');
          base = create({ db, ...marker, text: text ?? '', resumed: true });
        }
        const result = await (readOnly ? base.recover() : base.submit());
        clear();
        confirmed = result;
        return result;
      } catch (error) {
        // A definite first-attempt rejection is safe to forget on reload;
        // rejected retries after an unknown outcome remain journaled.
        if (base?.canDiscard()) clear();
        throw error;
      } finally { busy = false; }
    }
    return Object.freeze({ requestId: marker.requestId, recover: () => run(true),
      submit: text => run(false, text), needsText: () => !base && marker.action !== 'acknowledge',
      canDiscard: () => !busy && !!base?.canDiscard(), discard: () => {
        if (busy || !base?.canDiscard()) throw new Error('CLARIFICATION_OUTCOME_UNCERTAIN');
        clear();
      } });
  }
  async function prepare(options, storage = sessionStorage) {
    const base = create(options);
    const key = storageKey(options.actorId, options.orderId);
    if (storage.getItem(key) !== null) throw new Error('CLARIFICATION_RECOVERY_REQUIRED');
    const marker = { version: 1, actorId: options.actorId, orderId: options.orderId,
      requestId: base.requestId, action: options.action };
    marker.digest = await digest(marker, options.text ?? '');
    // Recheck after hashing: another asynchronous caller must not overwrite it.
    if (storage.getItem(key) !== null) throw new Error('CLARIFICATION_RECOVERY_REQUIRED');
    const raw = JSON.stringify(marker);
    storage.setItem(key, raw);
    if (storage.getItem(key) !== raw) throw new Error('CLARIFICATION_STORAGE_UNAVAILABLE');
    return journal(options.db, marker, storage, raw, base);
  }
  function restore({db, actorId, orderId}, storage = sessionStorage) {
    const raw = storage.getItem(storageKey(actorId, orderId));
    if (raw === null) return null;
    const marker = JSON.parse(raw);
    if (!marker || marker.version !== 1 || marker.actorId !== actorId || marker.orderId !== orderId
      || typeof marker.requestId !== 'string' || !marker.requestId
      || !['open','answer','acknowledge'].includes(marker.action)
      || !/^[a-f0-9]{64}$/.test(marker.digest || '')
      || Object.keys(marker).sort().join(',') !== 'action,actorId,digest,orderId,requestId,version') {
      throw new Error('CLARIFICATION_INVALID_RECOVERY');
    }
    return journal(db, marker, storage, raw);
  }
  window.CnyosClarificationAction = Object.freeze({ create, prepare, restore });
})();
