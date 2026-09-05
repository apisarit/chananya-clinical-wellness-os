# Evidence search pilot

This module searches public research and drug-label metadata. It does not use an
LLM, diagnose, recommend treatment, read patient records, or store searches.
Only manually entered non-patient topics belong in the search field. Search terms
are transmitted to the selected external provider. No patient identifiers,
case notes, names, phone numbers or other confidential material should be entered.

## API contract

`POST /api/evidence-search` requires same-origin `Origin`,
`Content-Type: application/json`, and the current Supabase access token in
`Authorization: Bearer …`. Body: `{ "source": "pubmed", "query": "turmeric" }`.
The source must be `pubmed`, `clinicaltrials` or `dailymed`; the query must contain
2–160 characters. Additional fields, URLs and markup are rejected. The response
contains `ok`, `source`, `retrievedAt`, up to five `results` with
`id/title/url/date/detail`, and `total` when supplied by the provider. Dates retain
the source's publication/update date representation; `retrievedAt` is UTC ISO.

No browser role or tenant identifier is accepted. The function verifies the JWT
with Supabase `/auth/v1/user`, then calls existing `current_access_context()` with
the user's JWT and a **public** API key. That database function requires active
membership, an active clinic and active subscription. The returned clinic must
match the server configuration. Effective roles match the runtime's
`knowledge_read`: super_admin, practitioner, doctor, pharmacy, production,
inventory. Governance admin does not inherit clinical permissions.

Access is checked again after fetching results, so an OFF/role change while the
source responds suppresses the response. This is request authorization, not
revocation of data a user already saw or downloaded. No database migration or
service-role access is added.

## Deployment configuration

The feature fails closed and is OFF unless `CNYOS_EVIDENCE_ENABLED=true` is set in
the server environment. Set configuration in Netlify with Functions scope; do not
paste runtime secrets into public config files. Reuse the exact site bindings:

| Variable | Requirement |
|---|---|
| `CNYOS_EVIDENCE_ENABLED` | `true` to enable after staging verification |
| `CNYOS_EVIDENCE_PUBMED_ENABLED` | Separate PubMed rollout guard; defaults OFF, requires provider-wide quota controls before enabling |
| `SUPABASE_URL` | Exact HTTPS origin for the intended Supabase project |
| `SUPABASE_PUBLISHABLE_KEY` or `SUPABASE_ANON_KEY` | Public key for that project; elevated keys rejected |
| `CNYOS_OWNER_EXPECTED_PROJECT_REF` | Exact 20-letter project reference |
| `CNYOS_RUNTIME_EXPECTED_CLINIC_ID` | Exact clinic UUID for this isolated site |
| `CNYOS_OWNER_EXPECTED_NETLIFY_SITE_ID` | Exact intended Netlify site UUID |
| `CNYOS_OWNER_EXPECTED_SITE_ORIGIN` | Exact intended `https://…netlify.app` origin |

The existing runtime binding permits only a published deploy on the configured
site (including a standalone staging site whose Netlify deploy context is
`production`). Deploy previews, another tenant's site and missing configuration
remain blocked. No configuration is changed by tests or the build.

PubMed has a separate default-OFF guard and returns `EVIDENCE_PUBMED_DISABLED`
without contacting NCBI when unset. Setting this flag is not enough for production:
NCBI's no-key limit is three requests per second per upstream egress IP, shared
across callers; one nonempty PubMed search makes two calls. Implement and verify
coordinated provider-wide quota control for the actual egress topology before
enabling, and rerun the public adapter smoke. A per-visitor Netlify rate limit or
an in-memory per-function counter does not provide that global guarantee.

## Provider boundaries and operating cost

- PubMed uses NCBI ESearch followed by ESummary and returns bibliographic metadata
  with constructed PubMed PMID links. No full paper or abstract is downloaded.
- ClinicalTrials.gov API v2 returns five study identifiers, titles, status and
  update dates. A registry entry is not proof a treatment works.
- DailyMed v2 returns label titles and publication dates with validated SPL set
  links. U.S. labeling does not establish Thai authorization or a recommendation.

Provider URLs are fixed in server code; provider-supplied URLs and pagination
links are never fetched. Redirects fail closed. Requests have a 15-second total
outbound time budget, a 2 KiB JSON body limit and a 512 KiB maximum provider JSON
response. No application query/token logging or shared cache is used. Deployment
logs, platform access controls and third-party data practices still need normal
operational review.

Each successful search uses one Netlify Function request, three Supabase
authorization requests (verify user, pre-lookup access, post-lookup access), and
one external request, or two for PubMed. It incurs no model-token usage. Hosting,
compute and network consumption still count toward platform billing.

The function declares a Netlify rate limit of 12 requests per minute per IP and
domain. This is an abuse mitigation, **not a global spending cap or a guarantee
of provider quotas**: Netlify enforcement may lag, users may share an IP, and
multiple instances/sites may share outbound IPs. Upstream 429 returns a safe busy
response without an automatic retry. Check the deploy log confirms the rate rule
was applied; a future production workload may require a shared provider quota.

## Verification and remaining gates

Run `node tests/evidence-search-contract.mjs`. Tests use deterministic synthetic
tokens and response fixtures, check successful parsing and denial boundaries,
and make no authenticated live call. Passing them does not prove Google login,
deployed database policy, Netlify rate-rule installation or a provider's current
availability. Before enabling: test the published staging endpoint with a real
authorized session, both clinics' isolation, rejected roles, and Owner
OFF → blocked → ON, including a revocation during a lookup.

Public adapter smoke on 2026-09-05 (generic topics only, no credentials):
ClinicalTrials.gov `turmeric` returned five validated studies; DailyMed `aspirin`
returned five validated SPL label references; PubMed `turmeric` returned five
validated PMID references after ESearch and ESummary both returned HTTP 200.
Earlier source attempts timed out, so this establishes successful parsing and
connectivity at the time of the check, not an availability/latency guarantee.
These were public adapter checks, not deployed authenticated E2E. Both runtime
feature flags remain unset/OFF in this source-only change.

Official references:

- [NCBI E-utilities](https://www.ncbi.nlm.nih.gov/books/NBK25499/)
- [NCBI usage guidelines and disclaimer requirements](https://www.ncbi.nlm.nih.gov/books/NBK25497/)
- [ClinicalTrials.gov data API](https://clinicaltrials.gov/data-api/api)
- [DailyMed v2 SPL search](https://dailymed.nlm.nih.gov/dailymed/webservices-help/v2/spls_api.cfm)
- [Netlify function rate limiting](https://docs.netlify.com/manage/security/secure-access-to-sites/rate-limiting/)
