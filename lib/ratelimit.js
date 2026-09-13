'use strict';
/*
 * lib/ratelimit.js — shared rate limiter for POST /api/backlinks.
 *
 * Used by BOTH runtimes (Node server.js and the Cloudflare worker) so the
 * anti-spam behaviour cannot drift between them:
 *   - max N submissions per rolling hour window, AND
 *   - a minimum spacing between consecutive submissions
 * per client IP. Only successful submissions and hard rejections are counted
 * against the quota; user mistakes (validation 400s) are not punished.
 *
 * The limiter is storage-agnostic: server.js passes an in-memory Map,
 * worker.js passes a KV-backed async store. On Node the counters reset on
 * restart (fine for spam deterrence); on Workers the counters survive via KV
 * (with ~60s cross-edge consistency, which only makes limits slightly
 * looser, never tighter).
 */

/**
 * Check (and optionally record) a submission attempt.
 *
 * @param {object} opts
 * @param {string} opts.key          Client identifier (e.g. "ip:1.2.3.4").
 * @param {object} opts.store        Async store: { getCount(key), increment(key, windowStartIso) }.
 * @param {number} [opts.maxPerHour] Submissions allowed per rolling hour (default 3).
 * @param {number} [opts.minGapMs]   Minimum spacing between attempts (default 30s).
 * @param {boolean} [opts.record]    True to record the attempt AFTER a success
 *                                   (do the check first with record:false).
 * @returns {Promise<{ok: boolean, reason?: 'gap'|'quota', count?: number, used?: number}>}
 */
async function checkSubmission({ key, store, maxPerHour = 3, minGapMs = 30_000, record = false }) {
  const { lastAt, count } = await store.get(key);

  if (record) {
    await store.increment(key, new Date().toISOString());
    return { ok: true, count: count + 1 };
  }

  if (lastAt && Date.now() - lastAt < minGapMs) {
    return { ok: false, reason: 'gap', count, lastAt };
  }

  // Rolling hour window: count only attempts within the last hour.
  if (count >= maxPerHour && lastAt && Date.now() - lastAt < 3_600_000) {
    return { ok: false, reason: 'quota', count, used: count, lastAt };
  }
  if (count >= maxPerHour && (!lastAt || Date.now() - lastAt >= 3_600_000)) {
    // Hour has fully elapsed since the last attempt — window naturally reset.
    return { ok: true, count: 0 };
  }

  return { ok: true, count };
}

/** Build a tiny in-memory store (Node server; resets on restart). */
function memoryStore() {
  const state = new Map(); // key -> { lastAt: number, count: number }
  return {
    async get(key) {
      const s = state.get(key) || { lastAt: 0, count: 0 };
      // A full hour since the last attempt means the window is stale.
      if (s.lastAt && Date.now() - s.lastAt >= 3_600_000) return { lastAt: 0, count: 0 };
      return s;
    },
    async increment(key, _windowStartIso) {
      const s = state.get(key) || { lastAt: 0, count: 0 };
      const fresh = Date.now() - s.lastAt >= 3_600_000;
      const next = { lastAt: Date.now(), count: fresh ? 1 : s.count + 1 };
      state.set(key, next);
      return next;
    },
  };
}

/** Best-effort client IP extraction from headers (both runtimes). */
function clientKey(headers, fallback) {
  const get = (n) => (headers.get ? headers.get(n) : headers[n]) || '';
  const ip = String(get('cf-connecting-ip')).split(',')[0].trim()
    || String(get('x-forwarded-for')).split(',')[0].trim()
    || fallback || 'unknown';
  return `ip:${ip}`;
}

module.exports = { checkSubmission, memoryStore, clientKey };
