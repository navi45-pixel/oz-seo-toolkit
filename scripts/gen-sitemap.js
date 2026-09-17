#!/usr/bin/env node
'use strict';
/**
 * gen-sitemap.js — regenerate <lastmod> dates in public/sitemap.xml from git.
 *
 * For each URL path in the sitemap, the date is the commit date (UTC, YYYY-MM-DD)
 * of the most recent change touching that page's source file. Falls back to the
 * file's mtime when git history is unavailable (e.g. shallow CI checkouts of
 * fresh pages), and never invents dates in the future.
 *
 * Behaviour:
 *   - Writes the file only when a date actually changes (deploy scripts can run
 *     this unconditionally without dirtying the worktree).
 *   - Exits 0 on success; a sitemap that fails to parse or is missing a source
 *     file mapping is a hard error (fail the deploy, don't ship stale metadata).
 *
 * Path → source mapping: which file's history owns each page's freshness.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SITEMAP = path.join(ROOT, 'public', 'sitemap.xml');

// The four site pages and the file whose changes should bump their lastmod.
const PAGES = [
  { path: '/', source: 'public/index.html' },
  { path: '/backlinks', source: 'public/backlinks.html' },
  { path: '/crawl', source: 'public/crawl.html' },
  { path: '/skills', source: 'public/skills.html' },
  { path: '/api', source: 'public/api.html' },
];

// All dates are UTC: the sitemap protocol has no timezone and the smoke test
// compares against the UTC day, so a local-timezone date here reads as
// "in the future" for any UTC-side checker half the day.
function utcDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function gitLastCommitDate(repoRelPath) {
  try {
    const out = execFileSync(
      'git',
      ['log', '-1', '--format=%cI', '--', repoRelPath],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(out)) {
      // %cI carries a local offset (e.g. +10:00) — normalise to the UTC day,
      // clamped to now so clock skew can never emit a future date.
      return utcDate(Math.min(new Date(out).getTime(), Date.now()));
    }
  } catch { /* fall through to mtime */ }
  // Fallback: shallow clones may have no history for this file — use mtime,
  // clamped to today so a restored checkout can't claim a future date.
  const mtime = fs.statSync(path.join(ROOT, repoRelPath)).mtimeMs;
  return utcDate(Math.min(mtime, Date.now()));
}

function main() {
  const xml = fs.readFileSync(SITEMAP, 'utf8');

  let changed = 0;
  let out = xml;
  for (const page of PAGES) {
    if (!fs.existsSync(path.join(ROOT, page.source))) {
      console.error(`gen-sitemap: source file missing for ${page.path}: ${page.source}`);
      process.exit(1);
    }
    const date = gitLastCommitDate(page.source);
    // Replace the <lastmod> inside the <url> block whose <loc> ends with this
    // page's path (with '/' requiring an exact trailing-slash match).
    const locRe = new RegExp(`(<loc>[^<]*${page.path === '/' ? '/' : page.path}</loc>\\s*<lastmod>)(\\d{4}-\\d{2}-\\d{2})(</lastmod>)`);
    if (!locRe.test(out)) {
      console.error(`gen-sitemap: no <url> block with <lastmod> found for ${page.path} — fix public/sitemap.xml`);
      process.exit(1);
    }
    out = out.replace(locRe, (_m, pre, old, post) => {
      if (old === date) return _m;
      changed++;
      console.log(`gen-sitemap: ${page.path} lastmod ${old} -> ${date}`);
      return pre + date + post;
    });
  }

  if (changed === 0) {
    console.log('gen-sitemap: all lastmod dates already current — nothing to write.');
    return;
  }
  fs.writeFileSync(SITEMAP, out);
  console.log(`gen-sitemap: updated ${changed} date(s) in public/sitemap.xml`);
}

main();
