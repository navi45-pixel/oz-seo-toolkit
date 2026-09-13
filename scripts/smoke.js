#!/usr/bin/env node
/**
 * smoke.js — dependency-free smoke tests for a running OzSEO Toolkit.
 *
 * Usage:
 *   node scripts/smoke.js [BASE_URL]        (default: http://localhost:3000)
 *   npm run smoke                           (same default)
 *   npm run smoke -- https://oz-seo-toolkit.<account>.workers.dev
 *
 * Checks:
 *   1. /api/health answers ok:true
 *   2. GET /api/audit?url=example.com returns a valid scored report
 *      (overall 0-100, exactly 8 scored groups, non-null SEO score)
 *   3. Pages /, /backlinks, /skills, /api all return 200
 */
'use strict';

const BASE = (process.argv[2] || process.env.SMOKE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const AUDIT_URL = 'example.com';

const results = [];
let failed = 0;

function report(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function getJson(path, timeoutMs) {
  const res = await fetch(BASE + path, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep null */ }
  return { status: res.status, json, text };
}

async function main() {
  console.log(`Smoke testing ${BASE}\n`);

  // 1. Health
  try {
    const { status, json } = await getJson('/api/health', 20_000);
    report('GET /api/health', status === 200 && json && json.ok === true,
      json && json.runtime ? `ok:true (runtime: ${json.runtime})` : `status ${status}`);
  } catch (e) {
    report('GET /api/health', false, e.message);
  }

  // 2. Real audit
  try {
    const { status, json } = await getJson(`/api/audit?url=${AUDIT_URL}`, 90_000);
    const groups = json && json.groups ? Object.keys(json.groups) : [];
    const overallOk = json && typeof json.overall === 'number' && json.overall >= 0 && json.overall <= 100;
    const groupsOk = groups.length === 8;
    const seoOk = json && json.groups && json.groups.seo && json.groups.seo.score != null;
    const allOk = status === 200 && overallOk && groupsOk && seoOk;
    report(`GET /api/audit?url=${AUDIT_URL}`, allOk,
      allOk ? `overall ${json.overall}, ${groups.length} groups` : `status ${status}, overall ${overallOk}, groups ${groups.length}, seo ${seoOk}`);
  } catch (e) {
    report(`GET /api/audit?url=${AUDIT_URL}`, false, e.message);
  }

  // 3. Backlink directory (shape + privacy + pagination — never mutates data)
  try {
    const { status, json } = await getJson('/api/backlinks', 20_000);
    const shapeOk = json && typeof json.total === 'number' && Array.isArray(json.listings)
      && typeof json.hasMore === 'boolean' && typeof json.limit === 'number';
    // Stored submissions do contain emails; the public API must never leak one.
    const emailLeak = shapeOk && json.listings.some((l) => l.email != null);
    report('GET /api/backlinks', status === 200 && shapeOk && !emailLeak,
      shapeOk
        ? `total ${json.total}, limit ${json.limit}, hasMore ${json.hasMore}${emailLeak ? ' — EMAIL LEAK: listing contains an email field' : ', no email fields'} `
        : `status ${status}, unexpected shape`);

    // Pagination contract: limit=1 pages must slice the full listing in order
    // (tolerant of empty directories and single-listing installs).
    if (shapeOk) {
      const page = await getJson('/api/backlinks?limit=1&offset=0', 20_000);
      const next = await getJson('/api/backlinks?limit=1&offset=1', 20_000);
      const firstId = (r) => (r.json.listings[0] ? r.json.listings[0].id : null);
      const pageOk = page.status === 200 && page.json.listings.length <= 1;
      const nextOk = next.status === 200 && next.json.listings.length <= 1;
      const windowOk = json.listings.length === 0
        || (page.json.listings.length === 1 && firstId(page) === json.listings[0].id);
      const distinctOk = json.listings.length < 2
        || firstId(next) === json.listings[1].id;
      report('GET /api/backlinks pagination', pageOk && nextOk && windowOk && distinctOk,
        `page1=${firstId(page) || '∅'} page2=${firstId(next) || '∅'}`);
    }
  } catch (e) {
    report('GET /api/backlinks', false, e.message);
  }

  // 4. Pages
  for (const p of ['/', '/backlinks', '/skills', '/api']) {
    try {
      const res = await fetch(BASE + p, { signal: AbortSignal.timeout(20_000) });
      // Consume the body so the socket is released.
      await res.arrayBuffer().catch(() => {});
      report(`GET ${p}`, res.status === 200, `status ${res.status}`);
    } catch (e) {
      report(`GET ${p}`, false, e.message);
    }
  }

  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  if (failed > 0) {
    console.error('SMOKE TEST FAILED');
    process.exit(1);
  }
  console.log('SMOKE TEST PASSED');
}

main();
