# Browser security baseline

The Clinical OS sends an enforced Content Security Policy from Netlify for every route. Browser scripts may load only from the same origin, the pinned packages on jsDelivr, and the official LINE LIFF host. Inline script and `eval` are denied. Supabase and LINE are the only third-party network destinations in `connect-src`.

Authenticated HTML and the root application document use `Cache-Control: private, no-store` so pages that render protected health information are not retained as reusable HTTP cache entries. Static JavaScript and styles remain independently cacheable.

The baseline also denies framing, plugins, cross-domain policy files, referrer transmission, and non-HTTPS subresources. Print windows bind behavior through DOM event listeners rather than inline handlers so they remain compatible with the script policy.

The browser Supabase SDK is pinned to `2.112.4`. Supabase, XLSX, barcode and QR browser libraries also require checked SHA-384 Subresource Integrity values, so a CDN response that differs from the reviewed bytes is rejected. Any version change must be explicit, must update the reviewed integrity value, and must pass `tests/browser-security-contract.mjs` plus the full `npm run check` suite.

This control is defense in depth. It does not replace database RLS/RPC authorization, authenticated staging, penetration testing, privacy review, or the commercial release gates in `release-readiness.json`.
