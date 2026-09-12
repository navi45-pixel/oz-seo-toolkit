#!/usr/bin/env node
/**
 * sync-kv.js — push data/backlinks.json to the Workers KV namespace and
 * verify the write landed (authoritative read-back, not the edge cache).
 *
 * Usage:
 *   npm run sync:kv                 push local data → KV, then verify
 *   npm run sync:kv -- --check      verify only, without writing
 *   node scripts/sync-kv.js --check
 *
 * Requires wrangler auth (`npx wrangler login` or CLOUDFLARE_API_TOKEN).
 * The namespace id is read from wrangler.toml — single source of truth.
 * Note: wrangler 4 defaults kv commands to LOCAL storage; --remote is
 * mandatory here and is asserted in the spawned arguments.
 */
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'data', 'backlinks.json');
const WRANGLER_TOML = path.join(ROOT, 'wrangler.toml');
const KEY = 'backlinks';

const CHECK_ONLY = process.argv.includes('--check');

function readNamespaceId() {
  const toml = fs.readFileSync(WRANGLER_TOML, 'utf8');
  const m = toml.match(/\[\[kv_namespaces\]\][\s\S]*?id\s*=\s*"([0-9a-f]+)"/);
  if (!m) {
    console.error(`ERROR: no [[kv_namespaces]] id found in ${path.relative(ROOT, WRANGLER_TOML)}`);
    process.exit(1);
  }
  return m[1];
}

function readLocalData() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('not a JSON array');
    return parsed;
  } catch (e) {
    console.error(`ERROR: cannot read ${path.relative(ROOT, DATA_FILE)}: ${e.message}`);
    process.exit(1);
  }
}

function runWrangler(args, opts = {}) {
  // execSync takes a proper command string (no DEP0190 array+shell warning,
  // and cmd.exe handles a single plain string better than quoted tokens).
  const q = process.platform === 'win32';
  const quote = (s) => (q && /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  const cmd = ['npx', ...args].map(quote).join(' ');
  return execSync(cmd, { stdio: 'inherit', shell: true, ...opts });
}

function kvKeyPut(namespaceId, file) {
  // --remote is the whole point of this script: without it wrangler 4 writes
  // to the local dev store and the real namespace never changes.
  const args = ['wrangler', 'kv', 'key', 'put', KEY, '--path', file,
    '--namespace-id', namespaceId, '--remote'];
  console.log(`$ npx ${args.join(' ')}`);
  runWrangler(args);
}

function kvKeyGet(namespaceId) {
  // --remote + fresh process: bypasses the edge cache and any isolate cache,
  // so this is the authoritative state of the namespace.
  const args = ['wrangler', 'kv', 'key', 'get', KEY, '--namespace-id', namespaceId, '--remote'];
  return runWrangler(args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 16 * 1024 * 1024,
  });
}

function summarize(list) {
  return list.map((x) => x.name || x.id || '?').join(', ');
}

function main() {
  const namespaceId = readNamespaceId();
  console.log(`namespace: ${namespaceId}`);

  const local = readLocalData();

  if (CHECK_ONLY) {
    let remote;
    try {
      remote = JSON.parse(kvKeyGet(namespaceId));
    } catch (e) {
      console.error(`ERROR: remote read failed: ${e.message.trim()}`);
      process.exit(1);
    }
    if (!Array.isArray(remote)) {
      console.error('ERROR: remote value is not a JSON array');
      process.exit(1);
    }
    const same = JSON.stringify(local) === JSON.stringify(remote);
    console.log(`local: ${local.length} listings [${summarize(local)}]`);
    console.log(`remote: ${remote.length} listings [${summarize(remote)}]`);
    if (!same) {
      console.error('CHECK FAILED — remote differs from local data. Run `npm run sync:kv` to push.');
      process.exit(1);
    }
    console.log('CHECK PASSED — remote matches local data.');
    return;
  }

  kvKeyPut(namespaceId, DATA_FILE);

  // Verify the write actually landed (guards against silent no-ops).
  let remote;
  try {
    remote = JSON.parse(kvKeyGet(namespaceId));
  } catch (e) {
    console.error(`ERROR: post-write verification read failed: ${e.message.trim()}`);
    process.exit(1);
  }
  const same = JSON.stringify(local) === JSON.stringify(remote);
  console.log(`local: ${local.length} listings`);
  console.log(`remote: ${Array.isArray(remote) ? remote.length : '?'} listings`);
  if (!same) {
    console.error('SYNC FAILED — verification read-back differs from local data (KV propagation lag?).');
    console.error('Re-run `npm run sync:kv` shortly, or inspect with:');
    console.error(`  npx wrangler kv key get ${KEY} --namespace-id ${namespaceId} --remote`);
    process.exit(1);
  }
  console.log(`SYNC OK — ${remote.length} listing(s) verified in KV: [${summarize(remote)}]`);
  console.log('Note: edge readers may lag up to ~60s (KV eventual consistency + worker cache TTL).');
}

main();
