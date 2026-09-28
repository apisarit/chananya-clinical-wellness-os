/* Metadata-only recovery identity. This journal is not payment authorization. */
(() => {
  'use strict';
  // Existing PostgreSQL identifiers include seeded UUIDs without RFC version bits.
  const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
  const hash = async fields => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(fields)))), b => b.toString(16).padStart(2, '0')).join('');
  const storageKey = (actorId, clinicId) => {
    if (!uuid(actorId) || !uuid(clinicId)) throw new Error('PAYMENT_JOURNAL_CONTEXT_REQUIRED');
    return `cnyos.payment.pending.v1:${clinicId}:${actorId}`;
  };
  function validate(value, actorId, clinicId) {
    if (!value || Array.isArray(value)
      || Object.keys(value).sort().join() !== 'actorId,clinicId,digest,invoiceId,requestId,version'
      || value.version !== 1 || value.actorId !== actorId || value.clinicId !== clinicId
      || !uuid(value.invoiceId) || !uuid(value.requestId)
      || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest)) {
      throw new Error('PAYMENT_JOURNAL_INVALID');
    }
    return Object.freeze(value);
  }
  function restore({ actorId, clinicId, storage = sessionStorage }) {
    const raw = storage.getItem(storageKey(actorId, clinicId));
    if (raw === null) return null;
    let value;
    try { value = JSON.parse(raw); } catch { throw new Error('PAYMENT_JOURNAL_INVALID'); }
    return validate(value, actorId, clinicId);
  }
  async function prepare({ actorId, clinicId, payload, expectedRequestId = null, storage = sessionStorage }) {
    const key = storageKey(actorId, clinicId);
    if (!payload || !uuid(payload.p_invoice_id) || !Number.isFinite(payload.p_amount)
      || payload.p_amount <= 0 || payload.p_amount > 10000000
      || !/^\d+(?:\.\d{1,2})?$/.test(String(payload.p_amount))
      || !['cash', 'qr', 'bank_transfer', 'card'].includes(payload.p_channel)
      || !(payload.p_reference_note === null || typeof payload.p_reference_note === 'string')
      || (payload.p_reference_note !== null && (payload.p_reference_note.trim() || null) !== payload.p_reference_note)
      || (payload.p_reference_note?.length || 0) > 200) throw new Error('PAYMENT_DRAFT_INVALID');
    // Fixed field order; do not persist the reference note or payment details.
    const digest = await hash([payload.p_invoice_id, payload.p_amount, payload.p_channel, payload.p_reference_note]);
    // Re-read after hashing, so overlapping preparation cannot overwrite a marker.
    const previous = restore({ actorId, clinicId, storage });
    // Explicit reload retries may only reuse the marker the operator reviewed.
    // Missing/replaced storage must never silently create a fresh payment identity.
    if (expectedRequestId !== null && (!uuid(expectedRequestId) || previous?.requestId !== expectedRequestId)) throw new Error('PAYMENT_JOURNAL_CHANGED');
    if (previous) {
      if (previous.invoiceId !== payload.p_invoice_id || previous.digest !== digest) throw new Error('PAYMENT_OUTCOME_UNRESOLVED');
      return previous;
    }
    const marker = validate({ version: 1, actorId, clinicId, invoiceId: payload.p_invoice_id, requestId: crypto.randomUUID(), digest }, actorId, clinicId);
    const serialized = JSON.stringify(marker);
    storage.setItem(key, serialized);
    if (storage.getItem(key) !== serialized) throw new Error('PAYMENT_JOURNAL_UNAVAILABLE');
    return marker;
  }
  async function recover({ actorId, clinicId, readPayment, isCurrent, storage = sessionStorage }) {
    if (typeof readPayment !== 'function' || typeof isCurrent !== 'function' || !isCurrent()) throw new Error('PAYMENT_CONTEXT_CHANGED');
    const marker = restore({ actorId, clinicId, storage });
    if (!marker) throw new Error('PAYMENT_JOURNAL_MISSING');
    const key = storageKey(actorId, clinicId), original = storage.getItem(key);
    // Adapter must read through the current authorized session, including invoice clinic.
    // It must never call the payment write RPC to discover whether a payment exists.
    const result = await readPayment(marker);
    if (!isCurrent()) throw new Error('PAYMENT_CONTEXT_CHANGED');
    const row = result?.payment ? { ...result.payment } : null;
    const amount = row?.amount;
    if (result?.clinicId !== clinicId || !row || !uuid(row.id)
      || row.request_key !== marker.requestId || row.invoice_id !== marker.invoiceId
      || row.received_by !== actorId || row.provider !== 'manual' || row.status !== 'paid'
      || !['number', 'string'].includes(typeof amount) || !/^\d+(?:\.\d{1,2})?$/.test(String(amount))
      || !Number.isFinite(Number(amount)) || Number(amount) <= 0 || Number(amount) > 10000000
      || typeof row.payment_reference !== 'string' || !row.payment_reference.trim()
      || typeof row.paid_at !== 'string' || !Number.isFinite(Date.parse(row.paid_at))
      || !['cash', 'qr', 'bank_transfer', 'card'].includes(row.channel)
      || !(row.gateway_transaction_id === null || typeof row.gateway_transaction_id === 'string')) throw new Error('PAYMENT_READBACK_MISMATCH');
    const digest = await hash([row.invoice_id, Number(amount), row.channel, row.gateway_transaction_id]);
    if (digest !== marker.digest) throw new Error('PAYMENT_READBACK_MISMATCH');
    if (!isCurrent()) throw new Error('PAYMENT_CONTEXT_CHANGED');
    if (storage.getItem(key) !== original) throw new Error('PAYMENT_JOURNAL_CHANGED');
    storage.removeItem(key);
    if (storage.getItem(key) !== null) throw new Error('PAYMENT_JOURNAL_UNAVAILABLE');
    return row;
  }
  // No public discard. Only a matching, current-session read can clear uncertainty.
  window.CnyosPaymentJournal = Object.freeze({ prepare, restore, recover });
})();
