/* Metadata-only service-invoice recovery; never grants financial permission. */
(() => {
  'use strict';
  const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
  const digest = async values => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(values)))), v => v.toString(16).padStart(2, '0')).join('');
  const key = (actorId, clinicId) => {
    if (!uuid(actorId) || !uuid(clinicId)) throw new Error('SERVICE_JOURNAL_CONTEXT_REQUIRED');
    return `cnyos.service-invoice.pending.v1:${clinicId}:${actorId}`;
  };
  function restore({ actorId, clinicId, storage = sessionStorage }) {
    const raw = storage.getItem(key(actorId, clinicId));
    if (raw === null) return null;
    let marker;
    try { marker = JSON.parse(raw); } catch { throw new Error('SERVICE_JOURNAL_INVALID'); }
    if (!marker || Object.keys(marker).sort().join() !== 'actorId,clinicId,digest,encounterId,requestId,version'
      || marker.version !== 1 || marker.actorId !== actorId || marker.clinicId !== clinicId
      || !uuid(marker.encounterId) || !uuid(marker.requestId) || !/^[a-f0-9]{64}$/.test(marker.digest)) throw new Error('SERVICE_JOURNAL_INVALID');
    return Object.freeze(marker);
  }
  async function prepare({ actorId, clinicId, encounterId, amount, description, expectedRequestId = null, storage = sessionStorage }) {
    const storageKey = key(actorId, clinicId);
    if (!uuid(encounterId) || typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > 10000000
      || !/^\d+(?:\.\d{1,2})?$/.test(String(amount))
      || typeof description !== 'string' || !description.trim() || description.trim().length > 500) throw new Error('SERVICE_DRAFT_INVALID');
    const hash = await digest([encounterId, amount, description.trim()]);
    const existing = restore({ actorId, clinicId, storage });
    if (expectedRequestId !== null && (!uuid(expectedRequestId) || existing?.requestId !== expectedRequestId)) throw new Error('SERVICE_JOURNAL_CHANGED');
    if (existing) {
      if (existing.encounterId !== encounterId || existing.digest !== hash) throw new Error('SERVICE_OUTCOME_UNRESOLVED');
      return existing;
    }
    const marker = { version: 1, actorId, clinicId, encounterId, requestId: crypto.randomUUID(), digest: hash };
    const serialized = JSON.stringify(marker);
    storage.setItem(storageKey, serialized);
    if (storage.getItem(storageKey) !== serialized) throw new Error('SERVICE_JOURNAL_UNAVAILABLE');
    return Object.freeze(marker);
  }
  async function recover({ actorId, clinicId, readInvoice, isCurrent, storage = sessionStorage }) {
    if (typeof isCurrent !== 'function' || !isCurrent() || typeof readInvoice !== 'function') throw new Error('SERVICE_CONTEXT_CHANGED');
    const marker = restore({ actorId, clinicId, storage });
    if (!marker) throw new Error('SERVICE_JOURNAL_MISSING');
    const storageKey = key(actorId, clinicId), original = storage.getItem(storageKey);
    // Authorized adapter must SELECT by request ID and return invoice + items;
    // never invoke issuance to discover whether an invoice exists.
    const result = await readInvoice(marker);
    if (!isCurrent()) throw new Error('SERVICE_CONTEXT_CHANGED');
    const row = result?.invoice, items = result?.items;
    const item = Array.isArray(items) && items.length === 1 ? items[0] : null;
    const validMoney = v => ['number','string'].includes(typeof v) && /^\d+(?:\.\d{1,2})?$/.test(String(v)) && Number(v) > 0 && Number(v) <= 10000000;
    const lineMatches = line => {
      if (!line || !validMoney(line.unit_price) || !validMoney(line.line_total)
        || !['number','string'].includes(typeof line.quantity)
        || !/^\d{1,12}(?:\.\d{1,12})?$/.test(String(line.quantity))) return false;
      const [whole,fraction=''] = String(line.quantity).split('.');
      const quantity = BigInt(whole + fraction), scale = 10n ** BigInt(fraction.length);
      const cents = value => { const [units,decimal=''] = String(value).split('.'); return BigInt(units + decimal.padEnd(2,'0')); };
      // Positive decimal half-up, matching PostgreSQL round(numeric, 2).
      return quantity > 0n && (2n * quantity * cents(line.unit_price) + scale) / (2n * scale) === cents(line.line_total);
    };
    if (!row || !uuid(row.id) || result.clinicId !== clinicId || row.created_by !== actorId
      || row.encounter_id !== marker.encounterId || row.source_service_request_key !== marker.requestId
      || !validMoney(row.grand_total) || !item || item.invoice_id !== row.id || item.item_type !== 'service'
      || !lineMatches(item) || Number(item.line_total) !== Number(row.grand_total)
      || typeof item.description !== 'string'
      || await digest([marker.encounterId, Number(row.grand_total), item.description.trim()]) !== marker.digest) throw new Error('SERVICE_READBACK_MISMATCH');
    if (!isCurrent()) throw new Error('SERVICE_CONTEXT_CHANGED');
    if (storage.getItem(storageKey) !== original) throw new Error('SERVICE_JOURNAL_CHANGED');
    storage.removeItem(storageKey);
    if (storage.getItem(storageKey) !== null) throw new Error('SERVICE_JOURNAL_UNAVAILABLE');
    return row;
  }
  window.CnyosServiceInvoiceJournal = Object.freeze({ prepare, restore, recover });
})();
