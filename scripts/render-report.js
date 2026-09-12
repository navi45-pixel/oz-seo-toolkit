'use strict';
/** Renders a self-contained HTML audit report from /api/audit JSON — mirrors the tool UI. */
const fs = require('fs');
const path = require('path');

const [,, auditJsonPath, perfJsonPath, outPath] = process.argv;
const d = JSON.parse(fs.readFileSync(auditJsonPath, 'utf8'));
let perf = null;
try { perf = JSON.parse(fs.readFileSync(perfJsonPath, 'utf8')); } catch { }
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'styles.css'), 'utf8');

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const color = (s) => s >= 80 ? 'var(--green)' : s >= 50 ? 'var(--amber)' : 'var(--red)';
const grade = (s) => s >= 90 ? 'A' : s >= 80 ? 'B' : s >= 65 ? 'C' : s >= 50 ? 'D' : 'F';
const ICONS = { pass: '\u2713', warn: '!', fail: '\u2717', info: 'i' };

const circ = 2 * Math.PI * 64;
const ring = `<div class="score-ring"><svg width="150" height="150">
<circle class="ring-bg" cx="75" cy="75" r="64" fill="none" stroke-width="12"></circle>
<circle cx="75" cy="75" r="64" fill="none" stroke-width="12" stroke-linecap="round" stroke-dasharray="${circ}" stroke-dashoffset="${circ - circ * d.overall / 100}" style="stroke:${color(d.overall)}" transform="rotate(-90 75 75)"></circle>
</svg><div class="score-num"><div><b>${d.overall}</b><small>OVERALL / 100</small></div></div></div>`;

const groupCards = Object.entries(d.groups).map(([k, g]) => {
  const c = 2 * Math.PI * 19;
  return `<div class="group-card" style="cursor:default"><div class="gc-top"><h3>${esc(g.label)}</h3>
  <div class="mini-ring"><svg width="46" height="46"><circle cx="23" cy="23" r="19" fill="none" stroke="#1d3a30" stroke-width="5"></circle>
  <circle cx="23" cy="23" r="19" fill="none" stroke="${color(g.score)}" stroke-width="5" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c - c * g.score / 100}" transform="rotate(-90 23 23)"></circle></svg>
  <span style="color:${color(g.score)}">${g.score}</span></div></div>
  <div class="gc-counts"><span><span class="dot pass"></span>${g.pass}</span><span><span class="dot warn"></span>${g.warn}</span><span><span class="dot fail"></span>${g.fail}</span></div></div>`;
}).join('');

const order = ['seo', 'geo', 'technical', 'performance', 'security', 'mobile', 'content', 'local'];
const sections = order.map((key) => {
  const g = d.groups[key]; if (!g) return '';
  const checks = d.checks.filter((c) => c.group === key);
  return `<div class="section-block open" id="sec-${key}">
  <div class="section-head" style="cursor:default"><h2>${esc(g.label)}</h2><span class="section-score" style="color:${color(g.score)}">${g.score}/100</span></div>
  <div class="section-body" style="display:block">${checks.map((c) => `<div class="check"><span class="check-icon ${c.status}">${ICONS[c.status]}</span>
  <div class="check-body"><b>${esc(c.name)}</b><div class="msg">${esc(c.message)}</div>${c.fix ? `<div class="fix">${esc(c.fix)}</div>` : ''}</div></div>`).join('')}</div></div>`;
}).join('');

const speedHtml = perf ? `<div class="section-block open"><div class="section-head" style="cursor:default"><h2>&#9889; Speed probe (3 live requests)</h2></div>
<div class="section-body" style="display:block"><div class="speed-grid">
<div class="metric-card ${perf.ttfbAvg <= 600 ? 'good' : 'mid'}"><b>${perf.ttfbAvg} ms</b><small>Avg TTFB</small></div>
<div class="metric-card ${perf.ttfbBest <= 400 ? 'good' : 'mid'}"><b>${perf.ttfbBest} ms</b><small>Best TTFB</small></div>
<div class="metric-card ${perf.htmlKb <= 150 ? 'good' : 'mid'}"><b>${perf.htmlKb} KB</b><small>HTML weight</small></div>
<div class="metric-card good"><b>${esc(perf.encoding)}</b><small>Compression</small></div>
</div></div></div>` : '';

const aiHtml = d.aiCrawlers ? `<div style="margin-top:10px"><b>AI crawler access (robots.txt)</b><div class="kw-grid">${d.aiCrawlers.map((c) => `<span class="kw-pill">${c.blocked ? '\u26D4' : '\u2705'} <b>${esc(c.bot)}</b> <small>${esc(c.vendor)}</small></span>`).join('')}</div></div>` : '';
const kwHtml = d.keywords && d.keywords.length ? `<div style="margin-top:10px"><b>Top keywords</b><div class="kw-grid">${d.keywords.map((k) => `<span class="kw-pill"><b>${esc(k.word)}</b> &times;${k.count} <small>(${k.density}%)</small></span>`).join('')}</div></div>` : '';

const html = `<!DOCTYPE html><html lang="en-AU"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Audit Report — ${esc(d.host)} | OzSEO Toolkit</title>
<style>${css}</style></head><body>
<header class="site"><div class="container nav"><span class="logo"><span class="logo-badge">Oz</span> OzSEO Toolkit — Audit Report</span>
<span class="free-pill">Generated ${new Date(d.fetchedAt).toLocaleString('en-AU')}</span></div></header>
<main class="container">
<div class="overall-card">${ring}
<div class="overall-meta"><h2>${esc(d.host)}<span class="grade-pill" style="background:${color(d.overall)};color:#08130c">Grade ${grade(d.overall)}</span></h2>
<div class="url-line">${esc(d.url)}</div>
<div class="summary-stats">
<div class="stat">TTFB <b>${d.ttfb} ms</b></div>
<div class="stat">HTML <b>${d.pageSizeKb} KB</b></div>
<div class="stat">Words <b>${d.wordCount.toLocaleString()}</b></div>
<div class="stat">Checks <b>${d.checks.length}</b></div>
${d.ssl ? `<div class="stat">SSL <b>${d.ssl.daysLeft} days left</b></div>` : ''}
<div class="stat">Local mentions <b>${Object.keys(d.states || {}).join(', ') || '—'}</b></div>
</div></div></div>
<div class="group-grid">${groupCards}</div>
<h2 class="section-title">Google preview (SERP snippet)</h2>
<div class="serp"><div class="serp-url"><span class="fav">&#127760;</span><span class="u">${esc((d.serp.url || d.url).replace(/^https?:\/\//, ''))}</span></div>
<div class="serp-title">${esc(d.serp.title || '(no title)')}</div><div class="serp-desc">${esc(d.serp.description || '(no meta description)')}</div></div>
${speedHtml}
<h2 class="section-title">Detailed results (${d.checks.length} checks)</h2>
${sections}
<div class="section-block open"><div class="section-head" style="cursor:default"><h2>&#129302; AI visibility &amp; keywords</h2></div>
<div class="section-body" style="display:block">${aiHtml}${kwHtml}
<p class="psi-note" style="margin-top:10px">Readability: ${d.readability ?? 'n/a'}/100 Flesch &middot; Schema types: ${esc((d.schemaTypes || []).join(', '))} &middot; Social: ${esc((d.social || []).join(', '))}</p>
</div></div>
</main>
<footer class="site"><div class="container"><p>&copy; 2026 OzSEO Toolkit &middot; Free audits for Australian businesses &middot; powered by open source (Express, Cheerio, Lighthouse)</p></div></footer>
</body></html>`;

fs.writeFileSync(outPath, html);
console.log('Report written:', outPath, fs.statSync(outPath).size, 'bytes');
