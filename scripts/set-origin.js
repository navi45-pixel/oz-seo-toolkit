#!/usr/bin/env node
'use strict';
/**
 * set-origin.js — swap the site's canonical origin everywhere it appears.
 *
 * Usage:
 *   node scripts/set-origin.js https://your-domain.com.au
 *   node scripts/set-origin.js --show        (list the current origin per file)
 *
 * SAFE BY CONSTRUCTION: each file's current origin is discovered from its own
 * canonical marker — rel="canonical" (pages), <loc> (sitemap.xml), the
 * "Sitemap:" line (robots.txt) — and ONLY URLs on that exact host are replaced.
 * Outbound links (schema.org, Google, directories, GitHub…) are structurally
 * impossible to touch: they never appear in a canonical marker.
 *
 * Files handled:
 *   - public/{index,backlinks,skills,api}.html — rel=canonical, og:url,
 *     og:image, twitter:image and JSON-LD url/provider/documentation fields
 *   - public/sitemap.xml — every <loc>
 *   - public/robots.txt — the Sitemap: line and the comment banner
 *
 * After running: npm run deploy, then add the domain in Cloudflare
 * (see docs/custom-domain.md for the full runbook).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const arg = process.argv[2] || '';
const showOnly = arg === '--show';
let newOrigin = null;
if (!showOnly) {
  if (!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}$/i.test(arg.replace(/\/+$/, ''))) {
    console.error('Usage: node scripts/set-origin.js https://your-domain.com.au   (or --show)');
    process.exit(2);
  }
  newOrigin = arg.replace(/\/+$/, '');
}

const PAGES = ['public/index.html', 'public/backlinks.html', 'public/skills.html', 'public/api.html'];
const hostOf = (url) => { try { return new URL(url).host.toLowerCase(); } catch { return null; } };

/** Find the file's current canonical origin; null if no marker exists. */
function currentOrigin(text, kind) {
  let marker;
  if (kind === 'page') marker = text.match(/rel="canonical"\s+href="(https?:\/\/[^"/]+)/i);
  else if (kind === 'sitemap') marker = text.match(/<loc>(https?:\/\/[^/<]+)/i);
  else if (kind === 'robots') marker = text.match(/^Sitemap:\s*(https?:\/\/[^/\s]+)/im);
  return marker ? marker[1].toLowerCase() : null;
}

/** Replace every URL whose origin === fromOrigin with toOrigin (path/query kept). */
function swapHost(text, fromOrigin, toOrigin) {
  const from = fromOrigin.toLowerCase();
  const urlRe = /https?:\/\/[a-z0-9.-]+(?::\d+)?(?:\/[^\s"'<>)]*)?/gi;
  return text.replace(urlRe, (url) => {
    try {
      const u = new URL(url);
      if (u.origin.toLowerCase() !== from) return url; // different site: never touch
      return toOrigin + url.slice(u.origin.length);
    } catch { return url; }
  });
}

const summary = [];
let changedFiles = 0;
let firstOrigin = null;

for (const rel of [...PAGES, 'public/sitemap.xml', 'public/robots.txt']) {
  const full = path.join(ROOT, rel);
  const text = fs.readFileSync(full, 'utf8');
  const kind = rel.endsWith('.xml') ? 'sitemap' : rel.endsWith('.txt') ? 'robots' : 'page';
  const origin = currentOrigin(text, kind);
  if (!origin) { summary.push(`${rel}: no canonical marker found — SKIPPED (fix the file)`); continue; }
  firstOrigin = firstOrigin || origin;

  if (showOnly) { summary.push(`${rel}: ${origin}`); continue; }
  if (origin === newOrigin.toLowerCase()) { summary.push(`${rel}: already ${origin}`); continue; }

  fs.writeFileSync(full, swapHost(text, origin, newOrigin));
  if (fs.readFileSync(full, 'utf8') === text) {
    // The comparison bug guard: a "successful" run that changed nothing means
    // the marker and the URL matching disagree — fail loudly instead.
    summary.push(`${rel}: ERROR — origin ${origin} found in the marker but no URLs matched it`);
    changedFiles = -1000; // force non-zero exit
    continue;
  }
  changedFiles++;
  summary.push(`${rel}: ${origin} -> ${newOrigin}`);
}

console.log(summary.join('\n'));
if (showOnly) {
  if (firstOrigin) console.log(`\nCurrent canonical origin: ${firstOrigin}`);
  process.exit(0);
}
if (!changedFiles) {
  console.log(`\nNothing changed — origin may already be ${newOrigin} (or markers are missing).`);
  process.exit(1);
}
console.log(`\nOrigin set to ${newOrigin} in ${changedFiles} file(s).`);
console.log('Next: npm run deploy, then add the domain in Cloudflare and submit the sitemap in Search Console (docs/custom-domain.md).');
