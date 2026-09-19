const NETLIFY_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.netlify\.app$/;

// A syntax allowlist, not authorization. Callers must still bind the exact
// configured origin, site ID, published deployment and authenticated identity.
// Do not admit arbitrary custom domains or all subdomains of cnyos.cloud.
export function isSupportedSiteHostname(hostname) {
  return hostname === 'cnyos.cloud' || NETLIFY_HOST.test(hostname);
}
