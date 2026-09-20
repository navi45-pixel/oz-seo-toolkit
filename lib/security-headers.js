'use strict';
/**
 * security-headers.js — the ONE copy of the security headers and cache
 * policy. server.js (Node) and worker.js (Workers) both consume this module,
 * so the two runtimes cannot drift; scripts/check-drift.js reads it back as
 * the repo-side expectation when diffing the deployed worker's behaviour.
 *
 * CSP matches the site's reality: one bundled stylesheet (/css/styles.css)
 * plus inline scripts, zero third-party resources (no CDN fonts, no analytics).
 * Keep 'self' on style-src — dropping it silently unstyles every page in
 * real browsers while all byte-level checks (smoke, drift) stay green, because
 * none of them execute CSP.
 */
const SECURITY_HEADERS = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': [
    "default-src 'none'",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
};

// Cache policy: HTML always revalidates (deploys land instantly); every other
// static asset caches for a day. The Workers asset layer pre-sets its own
// cache-control (max-age=0), so non-HTML must OVERRIDE it, not fill a blank.
const CACHE_POLICY = {
  html: 'public, max-age=0, must-revalidate',
  asset: 'public, max-age=86400',
};

function applyCachePolicy(headers) {
  const ct = (headers.get('content-type') || '').toLowerCase();
  // API/JSON responses own their policy: the homepage strip sets max-age=300,
  // health/audit must not be cached at all. Overriding them with the asset
  // policy would let browsers pin API data for a day — never touch JSON.
  if (ct.includes('application/json')) return headers;
  if (ct.includes('text/html')) {
    if (!headers.has('cache-control')) headers.set('cache-control', CACHE_POLICY.html);
  } else {
    headers.set('cache-control', CACHE_POLICY.asset);
  }
  return headers;
}

module.exports = { SECURITY_HEADERS, CACHE_POLICY, applyCachePolicy };
