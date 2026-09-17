#!/usr/bin/env node
'use strict';
/**
 * check-drift.js — diff the DEPLOYED worker's behaviour against the repo.
 *
 * Catches the failure mode where the live site stops matching the code:
 * a stale deploy, a Cloudflare setting changed in the dashboard, a hand-edit
 * to a public file that never got deployed, or a code change that skipped CI.
 *
 * What is compared (repo side = the file that actually produces the value):
 *   1. Security headers on /, an API route and a 404   ← lib/security-headers.js
 *   2. Cache policy (HTML revalidates, assets a day)   ← lib/security-headers.js
 *   3. Plain-HTTP → HTTPS 301 redirect                 ← worker.js
 *   4. Every page returns 200                          ← public/*.html
 *   5. robots.txt Sitemap line + disallowed endpoints  ← public/robots.txt
 *   6. sitemap.xml <loc> set + lastmod validity        ← public/sitemap.xml
 *   7. Canonical + og:url on each page                 ← public/*.html
 *   8. /api/health shape                               ← worker.js contract
 *   9. Content fingerprints per page — title, meta description, every
 *      h1–h3 heading, the nav links, and the FAQ JSON-LD questions and
 *      answers                                          ← public/*.html
 *
 * The fingerprints catch the last gap: a deploy that ships stale or
 * hand-edited page files is flagged even when status codes, headers and
 * canonical tags all still look right, and the diff names WHICH part of
 * the page drifted (title / description / heading / nav / FAQ).
 *
 * Usage:
 *   node scripts/check-drift.js [BASE_URL]
 *   BASE_URL defaults to the deployed workers.dev origin (from
 *   public/sitemap.xml so there is one source of truth for the origin).
 *   --local compares against http://localhost:3000 instead.
 *
 * Exit 0 = no drift, exit 1 = drift detected (each diff printed).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const LOCAL = argv.includes('--local');
const BASE = (
  (LOCAL ? 'http://localhost:3000' : argv.find((a) => !a.startsWith('--')) || process.env.DRIFT_BASE_URL || '')
  .replace(/\/+$/, '')
);

if (!BASE) {
  // Derive the deployed origin from the sitemap — same source the pages use.
  const sitemap = fs.readFileSync(path.join(ROOT, 'public', 'sitemap.xml'), 'utf8');
  const m = sitemap.match(/<loc>https?:\/\/([^/<]+)/);
  if (!m) {
    console.error('check-drift: pass BASE_URL or ensure public/sitemap.xml has a <loc> with the canonical origin.');
    process.exit(2);
  }
  console.error(`check-drift: derived origin from sitemap: https://${m[1]}`);
  process.exitCode = 2; // caller should retry with an explicit URL
}

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const pages = fs.readdirSync(path.join(ROOT, 'public')).filter((f) => f.endsWith('.html') && f !== '404.html');

// ---------- content fingerprinting ----------

// Raw-text extraction over the served HTML: strips scripts, styles and tags so
// whitespace/quoting differences never fire, but any real wording change does.
// The FAQ JSON-LD is parsed semantically (questions + answers) so minification
// or @graph reordering cannot false-positive either.
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
const text = (html) => html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/gi, ' ')
  .replace(/\s+/g, ' ')
  .trim();
const truncate = (s) => (s.length > 70 ? s.slice(0, 67) + '…' : s);
const firstDiff = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return `item ${i}: live ${JSON.stringify(a[i] ?? '(absent)')} ≠ repo ${JSON.stringify(b[i] ?? '(absent)')}`;
  }
  return null; // arrays are equal
};

function fingerprint(html) {
  const pick = (re) => (html.match(re) || [])[1] || '';
  const headings = [];
  for (const m of html.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) headings.push(`h${m[1]}: ${text(m[2])}`);
  const nav = [];
  const navMatch = html.match(/<nav\b[^>]*>([\s\S]*?)<\/nav>/i);
  if (navMatch) {
    for (const a of navMatch[1].matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) nav.push(`${a[1]} ${text(a[2])}`);
  }
  const faq = [];
  for (const m of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1]);
      for (const node of Array.isArray(data) ? data : [data]) {
        for (const n of Array.isArray(node['@graph']) ? node['@graph'] : [node]) {
          if (String(n['@type'] || '').toLowerCase() !== 'faqpage') continue;
          for (const q of n.mainEntity || []) {
            faq.push(`Q: ${text(String(q.name || ''))}`);
            faq.push(`A: ${text(String((q.acceptedAnswer || {}).text || ''))}`);
          }
        }
      }
    } catch {
      faq.push('(unparseable JSON-LD)');
    }
  }
  return {
    title: pick(/<title[^>]*>([\s\S]*?)<\/title>/i),
    description: pick(/<meta\s+name="description"\s+content="([^"]*)"/i),
    headings,
    nav,
    faq,
  };
}

// Names which part of the page drifted; empty array = content identical.
const fingerprintDiffs = (live, want) => {
  const out = [];
  if (live.title !== want.title) out.push(`title ${JSON.stringify(truncate(live.title))} ≠ repo ${JSON.stringify(truncate(want.title))}`);
  if (live.description !== want.description) out.push(`meta description ${JSON.stringify(truncate(live.description))} ≠ repo ${JSON.stringify(truncate(want.description))}`);
  if (live.headings.join('\n') !== want.headings.join('\n')) out.push(`headings differ — ${firstDiff(live.headings, want.headings)}`);
  if (live.nav.join('|') !== want.nav.join('|')) out.push(`nav links differ — ${firstDiff(live.nav, want.nav)}`);
  if (live.faq.join('|') !== want.faq.join('|')) out.push(`FAQ JSON-LD differs — ${firstDiff(live.faq, want.faq)}`);
  return out;
};

// ---------- repo-side expectations ----------

let expect;
try {
  ({ SECURITY_HEADERS: expect } = require('../lib/security-headers.js'));
} catch (e) {
  console.error('check-drift: cannot load lib/security-headers.js —', e.message);
  process.exit(2);
}
expect = { ...expect };
delete expect['content-security-policy']; // compared separately: order-insensitive directives

const repo = {
  pages: {},
  robots: read('public', 'robots.txt'),
  sitemap: read('public', 'sitemap.xml'),
  canonicals: {},
  ogUrls: {},
  fingerprints: {},
};
for (const f of pages) {
  const html = read('public', f);
  const route = f === 'index.html' ? '/' : '/' + f.replace(/\.html$/, '');
  repo.pages[route] = html;
  repo.canonicals[route] = (html.match(/<link rel="canonical" href="([^"]+)"/) || [])[1] || null;
  repo.ogUrls[route] = (html.match(/<meta property="og:url" content="([^"]+)"/) || [])[1] || null;
  repo.fingerprints[route] = fingerprint(html);
}
repo.fingerprint404 = fingerprint(read('public', '404.html'));
const repoSitemapLocs = [...repo.sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
const repoSitemapOrigin = repoSitemapLocs[0] ? new URL(repoSitemapLocs[0]).origin : null;
const repoSitemapPaths = repoSitemapLocs.map((u) => new URL(u).pathname);
const repoRobotsSitemap = (repo.robots.match(/^sitemap:\s*(\S+)\s*$/im) || [])[1] || null;
const repoRobotsDisallows = [...repo.robots.matchAll(/^disallow:\s*(\S+)\s*$/gim)].map((m) => m[1]);
const repoCspDirectives = new Set(
  read('lib', 'security-headers.js').match(/"([a-z-]+)\s+[^"]+"/g)?.map((d) => d.slice(1).split(/\s+/)[0]) || []
);

// ---------- live side ----------

const diffs = [];
const notes = [];
const diff = (name, message) => diffs.push(`${name}\n    ${message}`);
const origin = () => (BASE ? BASE : `https://${repoSitemapOrigin.replace(/^https?:\/\//, '')}`);

async function probe(pathname, opts = {}, timeoutMs = 25_000) {
  const res = await fetch(origin() + pathname, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), ...opts });
  const headers = {};
  for (const [k, v] of res.headers.entries()) headers[k.toLowerCase()] = v;
  return { status: res.status, headers, location: res.headers.get('location') || '', text: await res.text() };
}
const firstCanonical = (html) => (html.match(/<link rel="canonical" href="([^"]+)"/) || [])[1] || null;
const firstOgUrl = (html) => (html.match(/<meta property="og:url" content="([^"]+)"/) || [])[1] || null;

async function main() {
  console.log(`Drift check: ${origin()} vs repo\n`);

  // 1+2. Security headers + cache policy on a page, an API route and a 404.
  for (const pathname of ['/', '/api/health', '/definitely-not-a-page-drift-probe']) {
    let live;
    try {
      live = await probe(pathname);
    } catch (e) {
      diff(`headers ${pathname}`, `unreachable: ${e.message}`);
      continue;
    }
    const lower = {};
    for (const [k, v] of Object.entries(live.headers)) lower[k.toLowerCase()] = v;
    for (const [h, want] of Object.entries(expect)) {
      const got = lower[h] || '';
      // Compare CSP and Permissions-Policy order-insensitively; others exactly.
      const norm = (s) => s.toLowerCase().split(';').map((x) => x.trim()).filter(Boolean).sort().join('; ');
      const same = h === 'content-security-policy' || h === 'permissions-policy' ? norm(got) === norm(want) : got === want;
      if (!same) diff(`security header ${h} on ${pathname}`, `live "${got || '(absent)'}" ≠ repo "${want}"`);
    }
    const ct = lower['content-type'] || '';
    const wantCache = ct.includes('text/html') ? 'max-age=0'
      : ct.includes('application/json') ? null // JSON owns its policy; only sanity-check it isn't the asset value
      : 'max-age=86400';
    const gotCache = lower['cache-control'] || '';
    if (live.status === 200 && wantCache && !gotCache.includes(wantCache)) {
      diff(`cache-control on ${pathname}`, `live "${gotCache || '(absent)'}" — expected to contain "${wantCache}" (content-type "${ct.split(';')[0]}")`);
    }
    if (live.status === 200 && ct.includes('application/json') && gotCache.includes('max-age=86400')) {
      diff(`cache-control on ${pathname}`, `JSON response carries the static-asset policy "${gotCache}" — API data must not be pinned for a day`);
    }
    notes.push(`${pathname}: ${live.status}, ${Object.keys(expect).filter((h) => (lower[h] || '') !== '').length}/${Object.keys(expect).length} headers, cache ${gotCache || '(none)'}`);
  }

  // 3. Plain-HTTP → HTTPS 301 (worker.js behaviour; meaningless against a
  // plain-HTTP dev origin, which has no TLS to upgrade to).
  if (origin().startsWith('https:')) {
    try {
      // Fetch the http:// URL directly — probe() always prefixes the https
      // origin, which would silently test the wrong scheme.
      const httpUrl = origin().replace(/^https:/, 'http:') + '/';
      const res = await fetch(httpUrl, { redirect: 'manual', signal: AbortSignal.timeout(25_000) });
      await res.arrayBuffer().catch(() => {});
      const location = res.headers.get('location') || '';
      if (res.status !== 301 || !location.startsWith('https://')) {
        diff('HTTP→HTTPS redirect', `http:// probe returned ${res.status} (location "${location || 'none'}") — worker.js forces a 301`);
      } else notes.push('http→https: 301 ok');
    } catch (e) {
      notes.push(`http→https: probe skipped (${e.message})`);
    }
  } else {
    notes.push('http→https: skipped (local/dev origin has no TLS)');
  }

  // 4. Every repo page exists live with 200.
  for (const route of Object.keys(repo.pages)) {
    let live;
    try {
      live = await probe(route);
    } catch (e) {
      diff(`page ${route}`, `unreachable: ${e.message}`);
      continue;
    }
    if (live.status !== 200) {
      diff(`page ${route}`, `live status ${live.status}, repo serves this page from public/`);
      continue;
    }
    // 7. Canonical / og:url must match the repo's tags (origin-tolerant:
    // a custom-domain cutover changes the origin on both sides together).
    const liveCanon = firstCanonical(live.text);
    if (repo.canonicals[route] && liveCanon !== repo.canonicals[route]) {
      diff(`canonical ${route}`, `live "${liveCanon}" ≠ repo "${repo.canonicals[route]}"`);
    }
    const liveOg = firstOgUrl(live.text);
    if (repo.ogUrls[route] && liveOg !== repo.ogUrls[route]) {
      diff(`og:url ${route}`, `live "${liveOg}" ≠ repo "${repo.ogUrls[route]}"`);
    }
    // 9. Content fingerprint: which part of the page text drifted, if any.
    const fpDiffs = fingerprintDiffs(fingerprint(live.text), repo.fingerprints[route]);
    if (fpDiffs.length) {
      diff(`content ${route}`, fpDiffs.join('; '));
    } else {
      const fp = repo.fingerprints[route];
      notes.push(`content ${route}: sha ${sha(JSON.stringify(fp))} (${fp.headings.length} headings, ${fp.nav.length} nav links, ${fp.faq.length / 2 || 0} FAQ pairs)`);
    }
  }

  // 404 page content — the suggester's routes/questions change with the site,
  // so a stale 404 would quietly misdirect visitors for months.
  try {
    const live404 = await probe('/definitely-not-a-page-drift-fp');
    if (live404.status === 404) {
      const fpDiffs = fingerprintDiffs(fingerprint(live404.text), repo.fingerprint404);
      if (fpDiffs.length) diff('content /404.html', fpDiffs.join('; '));
      else notes.push('content /404.html: sha ' + sha(JSON.stringify(repo.fingerprint404)));
    } else {
      notes.push(`content /404.html: skipped (probe returned ${live404.status})`);
    }
  } catch (e) {
    notes.push(`content /404.html: probe skipped (${e.message})`);
  }

  // 5. robots.txt: Sitemap line + every Disallow rule present live.
  try {
    const live = await probe('/robots.txt');
    if (live.status !== 200) {
      diff('robots.txt', `live status ${live.status}`);
    } else {
      if (repoRobotsSitemap && !new RegExp(`^sitemap:\\s*${repoRobotsSitemap.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'im').test(live.text)) {
        diff('robots.txt Sitemap line', `live is missing "Sitemap: ${repoRobotsSitemap}"`);
      }
      for (const rule of repoRobotsDisallows) {
        if (!new RegExp(`^disallow:\\s*${rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'im').test(live.text)) {
          diff('robots.txt Disallow', `live robots.txt is missing "Disallow: ${rule}"`);
        }
      }
    }
  } catch (e) {
    diff('robots.txt', `unreachable: ${e.message}`);
  }

  // 6. sitemap.xml: every repo <loc> must exist live, lastmod dates valid.
  try {
    const live = await probe('/sitemap.xml');
    if (live.status !== 200) {
      diff('sitemap.xml', `live status ${live.status}`);
    } else {
      const liveLocs = [...live.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
      for (const loc of repoSitemapLocs) {
        if (!liveLocs.includes(loc)) diff('sitemap.xml <loc>', `live sitemap missing ${loc}`);
      }
      if (liveLocs.length !== repoSitemapLocs.length) {
        diff('sitemap.xml <loc>', `live has ${liveLocs.length} urls, repo has ${repoSitemapLocs.length}`);
      }
      const today = new Date().toISOString().slice(0, 10);
      for (const block of live.text.match(/<url>[\s\S]*?<\/url>/g) || []) {
        const m = block.match(/<lastmod>(\d{4}-\d{2}-\d{2})<\/lastmod>/);
        if (!m || m[1] > today) diff('sitemap.xml <lastmod>', `invalid or future date in "${block.slice(0, 80)}…"`);
      }
    }
  } catch (e) {
    diff('sitemap.xml', `unreachable: ${e.message}`);
  }

  // 8. /api/health shape (worker.js contract).
  try {
    const live = await probe('/api/health');
    let j = null;
    try { j = JSON.parse(live.text); } catch { /* keep null */ }
    if (live.status !== 200 || !j || j.ok !== true) {
      diff('/api/health', `status ${live.status}, body ${live.text.slice(0, 80)}`);
    }
  } catch (e) {
    diff('/api/health', `unreachable: ${e.message}`);
  }

  // ---------- report ----------
  for (const n of notes) console.log(`  · ${n}`);
  console.log();
  if (diffs.length) {
    console.error(`DRIFT DETECTED — ${diffs.length} difference(s) between the deployed worker and the repo:\n`);
    for (const d of diffs) console.error('  ✗ ' + d);
    console.error('\nRedeploy (npm run deploy) or restore the dashboard setting that changed.');
    process.exit(1);
  }
  console.log('No drift: the deployed worker matches the repo (headers, cache policy, redirect, pages, canonicals, content fingerprints, robots, sitemap, health).');
  process.exit(0);
}

main().catch((e) => {
  console.error('check-drift failed:', e.message);
  process.exit(1);
});
