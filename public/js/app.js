'use strict';
/* OzSEO Toolkit — audit page logic */

const $id = (s) => document.getElementById(s);
const form = $id('auditForm');
const urlInput = $id('urlInput');
const auditBtn = $id('auditBtn');
const progressBox = $id('progressBox');
const progressFill = $id('progressFill');
const progressStep = $id('progressStep');
const progressTitle = $id('progressTitle');
const errorBox = $id('errorBox');
const results = $id('results');

const STEPS = [
  'Fetching your homepage…',
  'Parsing HTML, titles, meta tags & headings…',
  'Checking AI / GEO visibility & structured data…',
  'Scanning robots.txt, sitemap & broken links…',
  'Testing SSL certificate, DNS & security headers…',
  'Analysing content, readability & local SEO signals…',
  'Scoring everything…',
];

let stepTimer = null;

/* ---------- Backend reachability self-check ----------
   Detects "server asleep" / static-preview mode BEFORE the user wastes a click. */
const BACKEND_MSG = '\u26A0\uFE0F The audit engine is not connected. This happens in two cases: (1) you are viewing the static file preview — audits only run in the LIVE PREVIEW of the running \u201COzSEO Toolkit\u201D process; or (2) the server fell asleep between sessions — ask the assistant to restart it, then refresh this page.';

function showBackendBanner() {
  let b = document.getElementById('backendBanner');
  if (!b) {
    b = document.createElement('div');
    b.id = 'backendBanner';
    b.className = 'backend-banner';
    const hero = document.querySelector('.hero');
    hero && hero.prepend(b);
  }
  b.innerHTML = BACKEND_MSG;
  b.classList.add('show');
}

let backendOk = null;
(async () => {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch('/api/health', { signal: ctrl.signal });
    clearTimeout(t);
    const ct = r.headers.get('content-type') || '';
    backendOk = r.ok && ct.includes('application/json');
  } catch { backendOk = false; }
  if (!backendOk) showBackendBanner();
})();

/* Parse JSON safely — turns empty/broken responses into a friendly error message */
async function safeJson(res) {
  let text = '';
  try { text = await res.text(); } catch { /* body interrupted */ }
  if (!text) {
    if ([404, 502, 503].includes(res.status)) {
      throw new Error(`The audit service could not be reached (status ${res.status}). The server was likely asleep between sessions — please try again in a few seconds, or ask the assistant to restart it.`);
    }
    throw new Error(`The server returned an empty response (status ${res.status}). This usually means the request timed out while the target website was slow to respond — please try again.`);
  }
  try { return JSON.parse(text); }
  catch { throw new Error(BACKEND_MSG); }
}

function startProgress() {
  progressBox.classList.add('show');
  errorBox.classList.remove('show');
  let i = 0;
  progressFill.style.width = '6%';
  progressStep.textContent = STEPS[0];
  clearInterval(stepTimer);
  stepTimer = setInterval(() => {
    i = Math.min(i + 1, STEPS.length - 1);
    progressStep.textContent = STEPS[i];
    progressFill.style.width = Math.min(8 + i * 13, 90) + '%';
  }, 3200);
}
function stopProgress() {
  clearInterval(stepTimer);
  progressFill.style.width = '100%';
  setTimeout(() => { progressBox.classList.remove('show'); progressFill.style.width = '5%'; }, 500);
}
function showError(msg) {
  errorBox.textContent = msg;
  errorBox.classList.add('show');
  progressBox.classList.remove('show');
  clearInterval(stepTimer);
}

function scoreColor(s) { return s >= 80 ? 'var(--green)' : s >= 50 ? 'var(--amber)' : 'var(--red)'; }
function gradeOf(s) {
  if (s >= 90) return ['A', 'var(--green)'];
  if (s >= 80) return ['B', '#7ee2ae'];
  if (s >= 65) return ['C', 'var(--gold)'];
  if (s >= 50) return ['D', 'var(--amber)'];
  return ['F', 'var(--red)'];
}
function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

const ICONS = { pass: '\u2713', warn: '!', fail: '\u2717', info: 'i' };

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (!url) { showError('Please enter your website URL first.'); return; }
  auditBtn.disabled = true;
  auditBtn.textContent = 'Auditing…';
  results.classList.remove('show');
  startProgress();

  try {
    if (backendOk === false) { stopProgress(); showError(BACKEND_MSG); auditBtn.disabled = false; auditBtn.textContent = 'Run Full Audit'; return; }
    const ctrl = new AbortController();
    const kill = setTimeout(() => ctrl.abort(), 60000);
    let res;
    try {
      res = await fetch('/api/audit?url=' + encodeURIComponent(url), { signal: ctrl.signal });
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('The audit timed out after 60 seconds. The target website may be very slow — please try again.');
      throw new Error('Could not reach the audit server. If you are viewing the static file preview, audits only work in the LIVE preview (the running server) — open that instead.');
    } finally { clearTimeout(kill); }
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data.error || 'Audit failed.');
    stopProgress();
    render(data);
    runSpeedTest(url); // fires in background, fills the speed panel
  } catch (err) {
    showError(err.message);
    auditBtn.disabled = false;
    auditBtn.textContent = 'Run Full Audit';
  }
});

function render(d) {
  results.classList.add('show');
  results.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // overall ring
  const ring = $id('overallRing');
  const circ = 402;
  ring.style.stroke = scoreColor(d.overall);
  setTimeout(() => { ring.style.strokeDashoffset = circ - (circ * d.overall) / 100; }, 60);
  $id('overallScore').textContent = d.overall;
  const [g, gc] = gradeOf(d.overall);
  const pill = $id('gradePill');
  pill.textContent = 'Grade ' + g;
  pill.style.background = gc; pill.style.color = '#08130c';

  $id('resultHost').firstChild.textContent = d.host;
  $id('resultUrl').textContent = d.url + '  •  audited ' + new Date(d.fetchedAt).toLocaleString('en-AU');

  const totals = Object.values(d.groups).reduce((a, x) => ({ p: a.p + x.pass, w: a.w + x.warn, f: a.f + x.fail }), { p: 0, w: 0, f: 0 });
  $id('summaryStats').innerHTML = [
    `<div class="stat"><span class="dot pass"></span><b>${totals.p}</b> passed</div>`,
    `<div class="stat"><span class="dot warn"></span><b>${totals.w}</b> warnings</div>`,
    `<div class="stat"><span class="dot fail"></span><b>${totals.f}</b> failed</div>`,
    `<div class="stat">TTFB <b>${d.ttfb} ms</b></div>`,
    `<div class="stat">Page size <b>${d.pageSizeKb} KB</b></div>`,
    `<div class="stat">Words <b>${d.wordCount.toLocaleString()}</b></div>`,
    d.ssl ? `<div class="stat">SSL valid <b>${d.ssl.daysLeft} days</b></div>` : '',
    d.drift ? `<div class="stat">Drift <b>${d.drift.previousOverall} \u2192 ${d.overall}</b> (${d.drift.delta >= 0 ? '+' : ''}${d.drift.delta}) since ${new Date(d.drift.previousAt).toLocaleDateString('en-AU')}</div>` : '',
  ].join('');

  // group cards
  const grid = $id('groupGrid');
  grid.innerHTML = Object.entries(d.groups).map(([key, grp]) => {
    const c = 2 * Math.PI * 19;
    const off = c - (c * grp.score) / 100;
    return `<div class="group-card" onclick="document.getElementById('sec-${key}').scrollIntoView({behavior:'smooth'});document.getElementById('sec-${key}').classList.add('open')">
      <div class="gc-top">
        <h3>${esc(grp.label)}</h3>
        <div class="mini-ring">
          <svg width="46" height="46">
            <circle cx="23" cy="23" r="19" fill="none" stroke="#1d3a30" stroke-width="5"></circle>
            <circle cx="23" cy="23" r="19" fill="none" stroke="${scoreColor(grp.score)}" stroke-width="5" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${off}" transform="rotate(-90 23 23)"></circle>
          </svg>
          <span style="color:${scoreColor(grp.score)}">${grp.score}</span>
        </div>
      </div>
      <div class="gc-counts">
        <span><span class="dot pass"></span>${grp.pass}</span>
        <span><span class="dot warn"></span>${grp.warn}</span>
        <span><span class="dot fail"></span>${grp.fail}</span>
      </div>
    </div>`;
  }).join('');

  // SERP preview
  $id('serpUrl').textContent = (d.serp.url || d.url).replace(/^https?:\/\//, '').split('?')[0];
  $id('serpTitle').textContent = d.serp.title || '(no title tag found)';
  $id('serpDesc').textContent = d.serp.description || '(no meta description found — Google will improvise one, which usually hurts click-through rate)';

  // detail sections
  const order = ['seo', 'geo', 'technical', 'performance', 'security', 'mobile', 'content', 'local'];
  const details = $id('detailSections');
  details.innerHTML = order.map((key) => {
    const grp = d.groups[key];
    if (!grp) return '';
    const checks = d.checks.filter((c) => c.group === key);
    const open = grp.fail > 0 ? ' open' : '';
    return `<div class="section-block${open}" id="sec-${key}">
      <div class="section-head" onclick="this.parentElement.classList.toggle('open')">
        <h2>${esc(grp.label)}</h2>
        <span class="section-score" style="color:${scoreColor(grp.score)}">${grp.score}/100</span>
        <span class="section-chevron">&#9662;</span>
      </div>
      <div class="section-body">
        ${checks.map((c) => `<div class="check">
          <span class="check-icon ${c.status}">${ICONS[c.status]}</span>
          <div class="check-body">
            <b>${esc(c.name)}</b>
            <div class="msg">${esc(c.message)}</div>
            ${c.fix ? `<div class="fix">${esc(c.fix)}</div>` : ''}
          </div>
        </div>`).join('')}
        ${key === 'content' ? keywordsBlock(d) : ''}
        ${key === 'geo' ? aiCrawlersBlock(d) : ''}
      </div>
    </div>`;
  }).join('');
}

function keywordsBlock(d) {
  if (!d.keywords || !d.keywords.length) return '';
  return `<div style="margin-top:12px"><b style="font-size:14px">Top keywords on this page</b>
    <div class="kw-grid">${d.keywords.map((k) => `<span class="kw-pill"><b>${esc(k.word)}</b> &times;${k.count} <small>(${k.density}%)</small></span>`).join('')}</div>
    <p class="psi-note">Readability score: ${d.readability ?? 'n/a'}/100 (Flesch Reading Ease). Aim for 50+ so both humans and AI engines summarise you accurately.</p>
  </div>`;
}

function aiCrawlersBlock(d) {
  if (!d.robotsTxt) return '';
  return `<div style="margin-top:14px"><b style="font-size:14px">AI crawler access in robots.txt</b>
    <div class="kw-grid">${d.aiCrawlers.map((c) => `<span class="kw-pill" style="${c.blocked ? 'border-color:rgba(255,107,107,.5)' : ''}">${c.blocked ? '\u26D4' : '\u2705'} <b>${esc(c.bot)}</b> <small>${esc(c.vendor)}</small></span>`).join('')}</div>
    <p class="psi-note">If you want to appear in AI answers (ChatGPT, Perplexity, Google AI Overviews), don\u2019t block these crawlers. Blocking CCBot/Google-Extended removes you from most AI training &amp; citation sources.</p>
  </div>`;
}

/* ---------- Speed: built-in probe + PageSpeed (Lighthouse) ---------- */
function probeCard(p) {
  const cls = p.ttfbAvg <= 600 ? 'good' : p.ttfbAvg <= 1500 ? 'mid' : 'bad';
  return `<div style="margin:6px 0 12px"><b style="font-size:14px">Built-in server probe (${p.samples} live requests)</b>
    <div class="speed-grid">
      <div class="metric-card ${cls}"><b>${p.ttfbAvg} ms</b><small>Avg TTFB</small></div>
      <div class="metric-card ${p.ttfbBest <= 400 ? 'good' : 'mid'}"><b>${p.ttfbBest} ms</b><small>Best TTFB</small></div>
      <div class="metric-card ${p.htmlKb <= 150 ? 'good' : p.htmlKb <= 400 ? 'mid' : 'bad'}"><b>${p.htmlKb} KB</b><small>HTML weight</small></div>
      <div class="metric-card ${p.encoding !== 'none' ? 'good' : 'mid'}"><b>${esc(p.encoding)}</b><small>Compression</small></div>
    </div></div>`;
}

async function runSpeedTest(url) {
  const panel = $id('speedPanel');
  const body = $id('speedBody');
  const status = $id('speedStatus');
  panel.classList.add('show');

  // 1) built-in probe (always works)
  let probeHtml = '';
  try {
    const pr = await fetch('/api/perf?url=' + encodeURIComponent(url));
    const p = await safeJson(pr);
    if (pr.ok && p) probeHtml = probeCard(p);
  } catch { /* probe optional */ }

  // 2) Google Lighthouse via free PSI API
  try {
    const res = await fetch('/api/speed?url=' + encodeURIComponent(url));
    const s = await safeJson(res);
    if (!res.ok) throw new Error(s.error || 'Speed test failed');
    status.textContent = (s.scores.performance != null ? s.scores.performance + '/100' : 'done');
    status.style.color = scoreColor(s.scores.performance ?? 0);

    const catChip = (label, v) => v == null ? '' : `<span class="chip" style="color:${scoreColor(v)}">${label}: <b>${v}</b></span>`;
    const m = s.metrics;
    const card = (label, met, good, bad, fmt) => {
      if (met.value == null) return '';
      const cls = met.value <= good ? 'good' : met.value <= bad ? 'mid' : 'bad';
      return `<div class="metric-card ${cls}"><b>${fmt(met.value)}</b><small>${label}</small></div>`;
    };
    const ms = (v) => v >= 1000 ? (v / 1000).toFixed(1) + ' s' : Math.round(v) + ' ms';

    body.innerHTML = probeHtml + `
      <b style="font-size:14px">Google Lighthouse lab test</b>
      <div class="chips" style="justify-content:flex-start;margin:6px 0 6px">
        ${catChip('Performance', s.scores.performance)}
        ${catChip('Accessibility', s.scores.accessibility)}
        ${catChip('Best Practices', s.scores.bestPractices)}
        ${catChip('SEO (Lighthouse)', s.scores.seo)}
        <span class="chip">Lab test: ${s.strategy}</span>
      </div>
      <div class="speed-grid">
        ${card('First Contentful Paint', m.fcp, 1800, 3000, ms)}
        ${card('Largest Contentful Paint', m.lcp, 2500, 4000, ms)}
        ${card('Total Blocking Time', m.tbt, 200, 600, ms)}
        ${card('Cumulative Layout Shift', m.cls, 0.1, 0.25, (v) => v.toFixed(2))}
        ${card('Speed Index', m.si, 3400, 5800, ms)}
        ${card('Time to Interactive', m.tti, 3800, 7300, ms)}
      </div>
      ${s.lcpElement ? `<p class="psi-note">Largest element painted: <code style="color:var(--blue)">${esc(s.lcpElement).slice(0, 140)}</code> — optimise this (compress, preload, serve responsive sizes) for the biggest LCP win.</p>` : ''}
      ${s.opportunities.length ? `<b style="font-size:14px">Top speed opportunities</b>
        <div class="opps">${s.opportunities.map((o) => `<div class="opp"><span>${esc(o.title)}</span><span class="saving">save ~${(o.saving / 1000).toFixed(1)}s</span></div>`).join('')}</div>` : '<p class="psi-note">No major speed opportunities detected — nice work!</p>'}
      <p class="psi-note">Full interactive report (incl. real Chrome user field data): <a href="${esc(s.reportUrl)}" target="_blank" rel="noopener">open in PageSpeed Insights &rarr;</a></p>`;
  } catch (err) {
    status.textContent = 'probe only';
    status.style.color = 'var(--amber)';
    body.innerHTML = probeHtml + `<p class="psi-note">&#9888;&#65039; Google Lighthouse: ${esc(err.message)}<br>The free PageSpeed API occasionally rate-limits shared IPs. Wait a minute and re-run, or test directly at <a href="https://pagespeed.web.dev/" target="_blank" rel="noopener">pagespeed.web.dev</a>. ${probeHtml ? 'The built-in probe results above still show your real server speed.' : ''}</p>`;
  }
}
