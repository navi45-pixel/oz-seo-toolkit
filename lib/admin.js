'use strict';
/*
 * lib/admin.js — shared operator-auth helpers for the moderation endpoints.
 *
 * Auth model: a static bearer token set by the operator
 *   - Node:   ADMIN_TOKEN env var
 *   - Workers: ADMIN_TOKEN secret (npx wrangler secret put ADMIN_TOKEN)
 * Requests must send "Authorization: Bearer <token>". Comparison is
 * constant-time per character so response timing cannot leak the token.
 * Without ADMIN_TOKEN configured the endpoints answer 503 (disabled), so
 * a deployment without the secret is closed by default.
 */

/** Constant-time string equality (no early exit on mismatch). */
function safeEqual(a, b) {
  const sa = String(a);
  const sb = String(b);
  const len = Math.max(sa.length, sb.length);
  let diff = sa.length === sb.length ? 0 : 1; // length difference counts immediately
  for (let i = 0; i < len; i++) {
    diff |= (sa.charCodeAt(i) || 0) ^ (sb.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/** Extract the bearer token from an Authorization header value. */
function bearerToken(headerValue) {
  const m = /^Bearer\s+(.+)$/i.exec(String(headerValue || '').trim());
  return m ? m[1].trim() : null;
}

/**
 * Decide whether a request may use the moderation endpoints.
 * Returns { allowed, status, error } — status/error set when not allowed.
 */
function authorize(headerValue, configuredToken) {
  if (!configuredToken) {
    return { allowed: false, status: 503, error: 'Moderation is disabled on this deployment (no ADMIN_TOKEN configured).' };
  }
  const token = bearerToken(headerValue);
  if (!token || !safeEqual(token, configuredToken)) {
    return { allowed: false, status: 401, error: 'Unauthorized.' };
  }
  return { allowed: true };
}

module.exports = { safeEqual, bearerToken, authorize };
