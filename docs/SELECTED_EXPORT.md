# Selected export (separate from backup)

This is a controlled export primitive, not the database backup path. The
transactional source remains Supabase PostgreSQL. The export contract accepts
an explicit allowlisted dataset and at most 100 selected IDs, and produces
CSV or JSON with fixed columns. Arbitrary table names, columns, destinations,
credentials and raw LINE payloads are not accepted.

The current implementation is intentionally local/pure and does not upload to
Google Drive or NAS. Google Drive backup remains encrypted `.cdb.json.enc`
output; the NAS field remains configuration-only until a separately reviewed
connector is implemented. A future authenticated owner endpoint may call this
module after tenant, role, audit and destination checks are complete.

Run the contract test with:

```bash
node tests/selected-export-contract.mjs
```
