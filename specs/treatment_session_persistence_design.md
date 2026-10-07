# Treatment session persistence boundary

## Problem

The Treatment Session form currently treats an error-free RPC response as proof of persistence. A missing or mismatched acknowledgement can therefore clear the form and emit a success event even when no exact session has been read back. Switching encounters also discards an unsaved session draft.

## Acceptance criteria

- A save is successful only after the RPC returns a valid row and an independent read finds the same row by `id` and `encounter_id` with the submitted clinical fields intact.
- Each mutation carries a client-generated UUID. The database stores it under a unique `(encounter_id, client_request_id)` constraint, returns the original row for an exact replay, and rejects reuse with different clinical content.
- If the transport outcome is ambiguous and no row ID is available, recovery reads by the exact encounter and operation UUID. It never infers identity from a similar payload and never re-sends the RPC automatically.
- An empty or wrong-encounter acknowledgement, missing/mismatched readback, timeout, or transport interruption never clears the draft and never emits `chananya:clinical-data-changed` as success.
- One unresolved write per encounter blocks duplicate submission. A known server rejection keeps the draft and permits a deliberate corrected retry.
- Drafts are isolated by encounter and survive A → B → A navigation. A late A response must not reset or report success in B's form.
- Draft content remains in memory only. The tab stores only the opaque operation UUID needed for reload-safe replay/recovery, and navigation warns before discarding an in-memory clinical draft.
- Treatment sessions remain append-only. A later correction or follow-up is a new numbered session; the client does not invent an update path that the database contract does not provide.
- Authorization is checked before write and after readback. The server RPC remains authoritative for clinic, role, assigned practitioner, subscription, and encounter-lock rules.

## Evidence boundary

The browser regression uses synthetic identities and an in-memory Supabase-shaped fixture with all network requests aborted. It proves client control flow only. It is not staging or production evidence, does not establish RLS behavior, and does not authorize deployment.
