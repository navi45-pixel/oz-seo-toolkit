'use strict';
/**
 * check-404-routes.js — CI gate: the 404 suggester's route map (data-sugg*
 * attributes on the nav anchors in public/404.html) must match the real
 * pages. Prevents suggestions from drifting when pages are added, renamed
 * or removed.
 *
 * Sources of truth compared:
 *   1. data attributes in public/404.html (what the suggester offers)
 *   2. public/*.html files        (what is actually served — index.html
 *      maps to '/', others to '/<name>'; 404.html excluded)
 *   3. page routes in server.js   (app.get('<path>', ...) sendFile calls,
 *      plus '/' while express.static serves index.html)
 *   4. <loc> URLs in public/sitemap.xml (the canonical public pages)
 *
 * worker.js deliberately has no route list: it fetches clean URLs as-is and
 * the Workers asset layer resolves them, so the file set in (2) IS the
 * worker's routing.
 *
 * All sets must be identical. Exits non-zero on any drift.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let failures = 0;
const fail = (msg) => { failures++; console.error(`\u2717 ${msg}`); };
const ok = (msg) => console.log(`\u2713 ${msg}`);
const norm = (s) => [...s].sort().join(', ');

/* 1. The suggester map (404.html nav anchors) */
const html = read('public/404.html');
const mapSet = new Set();
const anchorRe = /<a\s+href="([^"]+)"[^>]*data-sugg-kw=/g;
let m;
while ((m = anchorRe.exec(html))) mapSet.add(m[1]);
if (!mapSet.size) fail('no data-sugg-kw anchors found in public/404.html — the suggester has no route map.');

/* 2. The actually-served pages: public/*.html (404.html excluded) */
const fileSet = new Set();
for (const f of fs.readdirSync(path.join(ROOT, 'public'))) {
  if (!f.endsWith('.html') || f === '404.html') continue;
  fileSet.add(f === 'index.html' ? '/' : `/${f.replace(/\.html$/, '')}`);
}
if (!fileSet.size) fail('no HTML pages found in public/ — nothing is served?');

/* 3. Node routes (server.js) */
const serverSrc = read('server.js');
const nodeSet = new Set();
const nodeRe = /app\.get\('([^']+)',\s*\(_req,\s*res\)\s*=>\s*res\.sendFile/g;
while ((m = nodeRe.exec(serverSrc))) nodeSet.add(m[1]);
if (/express\.static\(path\.join\(__dirname,\s*'public'\)\)/.test(serverSrc)) nodeSet.add('/');
if (nodeSet.size === 1 && nodeSet.has('/')) fail('server.js only serves / via static — page routes missing?');

/* 4. Sitemap URLs (paths only — domain-agnostic, so a future custom
 *    domain swap doesn't break this gate) */
const sitemap = read('public/sitemap.xml');
const smSet = new Set();
const smRe = /<loc>([^<]+)<\/loc>/g;
while ((m = smRe.exec(sitemap))) {
  try { smSet.add(new URL(m[1]).pathname === '/' ? '/' : new URL(m[1]).pathname.replace(/\/$/, '') || '/'); }
  catch { fail(`sitemap.xml has a non-URL <loc>: ${m[1]}`); }
}

const compare = (name, set) => {
  if (norm(set) === norm(fileSet)) ok(`${name} match the served pages: ${norm(set)}`);
  else fail(`${name} has ${norm(set)} — served pages are ${norm(fileSet)}`);
};

compare('404.html suggester map routes', mapSet);
compare('server.js routes', nodeSet);
compare('sitemap.xml URLs', smSet);

if (failures) {
  console.error(`\n${failures} route-map drift issue(s) — make the 404 suggester, server routes, public/ pages and sitemap agree.`);
  process.exit(1);
}
console.log('\n404 suggester routes are in sync with the real pages.');
