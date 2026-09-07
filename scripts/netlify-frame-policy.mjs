import assert from 'node:assert/strict';

export function assertSameOriginFramePolicy(headers, pathname = 'response') {
  assert.ok(headers && typeof headers.get === 'function', `${pathname} headers are unavailable`);
  assert.equal(
    headers.get('x-frame-options'),
    'SAMEORIGIN',
    `${pathname} must set X-Frame-Options=SAMEORIGIN`
  );

  const contentSecurityPolicy = headers.get('content-security-policy') || '';
  assert.ok(contentSecurityPolicy, `${pathname} must set Content-Security-Policy`);
  const frameAncestorDirectives = contentSecurityPolicy
    .split(';')
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => value.split(/\s+/))
    .filter(([name]) => name.toLowerCase() === 'frame-ancestors');

  assert.equal(
    frameAncestorDirectives.length,
    1,
    `${pathname} must set exactly one CSP frame-ancestors directive`
  );
  assert.deepEqual(
    frameAncestorDirectives[0].slice(1),
    ["'self'"],
    `${pathname} CSP frame-ancestors must allow only 'self'`
  );
}
