'use strict';
/**
 * check-readme.js — keeps README claims in sync with the code (CI gate).
 *
 * Re-derives the two numbers that drift most from the actual sources:
 *   1. the "NN+ checks" figure  ← count of add() check call sites in lib/*.js
 *   2. the Skills Hub breakdown ← <span class="tag"> counts in public/skills.html
 * Exits non-zero if the README no longer matches, with no dependencies.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failures = 0;
const fail = (msg) => { failures++; console.error(`\u2717 ${msg}`); };
const ok = (msg) => console.log(`\u2713 ${msg}`);

const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

/* ---------- 1. total check call sites in the audit engine ---------- */
const libDir = path.join(ROOT, 'lib');
const addCalls = fs.readdirSync(libDir).filter((f) => f.endsWith('.js')).reduce((n, f) => {
  const src = fs.readFileSync(path.join(libDir, f), 'utf8');
  return n + (src.match(/^\s*add\(/gm) || []).length;
}, 0);

const claim = readme.match(/(\d+)\+ checks/);
if (!claim) {
  fail('README has no "NN+ checks" claim (expected e.g. "90+ checks").');
} else if (addCalls >= Number(claim[1])) {
  ok(`README claims ${claim[1]}+ checks \u2014 engine has ${addCalls} check call sites in lib/`);
} else {
  fail(`README claims ${claim[1]}+ checks but the engine only has ${addCalls} add() call sites \u2014 update README.md or restore the checks.`);
}

/* ---------- 2. Skills Hub module counts ---------- */
const skillsHtml = fs.readFileSync(path.join(ROOT, 'public', 'skills.html'), 'utf8');
const tagRe = /class="tag[^"]*"[^>]*>\s*(AUTO|PLAYBOOK|PAGE|HUB|OPTIONAL)\s*<\/span>/g;
const tags = { AUTO: 0, PLAYBOOK: 0, PAGE: 0, HUB: 0, OPTIONAL: 0 };
let total = 0, t;
while ((t = tagRe.exec(skillsHtml))) { tags[t[1]]++; total++; }
ok(`skills.html has ${total} module cards (AUTO ${tags.AUTO}, PLAYBOOK ${tags.PLAYBOOK}, PAGE ${tags.PAGE}, HUB ${tags.HUB}, OPTIONAL ${tags.OPTIONAL})`);

const totalClaim = readme.match(/## Skills Hub \u2014 (\d+) integrated skill modules/);
if (!totalClaim) {
  fail('README is missing the "## Skills Hub \u2014 N integrated skill modules" heading.');
} else if (Number(totalClaim[1]) === total) {
  ok(`README Skills Hub total (${totalClaim[1]}) matches the ${total} cards on the page`);
} else {
  fail(`README says ${totalClaim[1]} skill modules but skills.html has ${total} cards.`);
}

for (const label of ['AUTO', 'PLAYBOOK']) {
  const m = readme.match(new RegExp(`(\\d+)\\s*\u00d7\\s*${label}`));
  if (!m) {
    fail(`README is missing the "N \u00d7 ${label}" breakdown.`);
  } else if (Number(m[1]) === tags[label]) {
    ok(`README ${label} count (${m[1]}) matches the ${tags[label]} cards`);
  } else {
    fail(`README says ${m[1]} \u00d7 ${label} but skills.html has ${tags[label]}.`);
  }
}

const specialClaim = readme.match(/(\d+)\s*\u00d7\s*special/);
const specials = tags.PAGE + tags.HUB + tags.OPTIONAL;
if (!specialClaim) {
  fail('README is missing the "N \u00d7 special" breakdown.');
} else if (Number(specialClaim[1]) === specials) {
  ok(`README special count (${specialClaim[1]}) matches the ${specials} PAGE/HUB/OPTIONAL cards`);
} else {
  fail(`README says ${specialClaim[1]} \u00d7 special but skills.html has ${specials} (PAGE+HUB+OPTIONAL).`);
}

/* ---------- verdict ---------- */
if (failures) {
  console.error(`\n${failures} README claim(s) out of sync \u2014 update README.md or the code.`);
  process.exit(1);
}
console.log('\nREADME claims match the code.');
