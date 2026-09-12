'use strict';
/* OzSEO Toolkit — backlinks page logic */

const $id = (s) => document.getElementById(s);
const esc = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };

/* Parse JSON safely — turns empty/broken responses into a friendly error message */
async function safeJson(res) {
  let text = '';
  try { text = await res.text(); } catch { /* body interrupted */ }
  if (!text) throw new Error(`The server returned an empty response (status ${res.status}). Please try again.`);
  try { return JSON.parse(text); }
  catch { throw new Error(`The server returned an unexpected response (status ${res.status}). Please try again.`); }
}

async function loadListings() {
  const state = $id('fState').value;
  const cat = $id('fCategory').value;
  const params = new URLSearchParams();
  if (state) params.set('state', state);
  if (cat) params.set('category', cat);
  try {
    const res = await fetch('/api/backlinks?' + params);
    const data = await safeJson(res);
    const box = $id('listings');
    $id('blCount').textContent = data.total ? `${data.total} site${data.total === 1 ? '' : 's'} listed` : '';
    if (!data.listings.length) {
      box.innerHTML = `<div class="empty-note" style="grid-column:1/-1">No listings yet${state || cat ? ' for that filter' : ''} — be the first to add your site above! &#128640;</div>`;
      return;
    }
    box.innerHTML = data.listings.map((l) => `
      <div class="listing">
        <h3>${esc(l.name)}
          <span class="badge state">${esc(l.state)}</span>
          <span class="badge cat">${esc(l.category)}</span>
        </h3>
        <div class="meta">
          <span class="badge">Added ${esc(l.addedAt)}</span>
        </div>
        <p>${esc(l.description)}</p>
        ${l.lookingFor ? `<p class="lf">&#128279; Looking for: ${esc(l.lookingFor)}</p>` : ''}
        <p style="margin-top:10px">
          <a href="${esc(l.website)}" target="_blank" rel="noopener nofollow ugc">Visit website &rarr;</a>
          &nbsp;&middot;&nbsp; <a href="mailto:${esc(l.email)}">Contact</a>
        </p>
      </div>`).join('');
  } catch {
    $id('listings').innerHTML = '<div class="empty-note" style="grid-column:1/-1">Could not load listings. Try refreshing.</div>';
  }
}

$id('fState').addEventListener('change', loadListings);
$id('fCategory').addEventListener('change', loadListings);

$id('blForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $id('blMsg');
  const btn = $id('blSubmit');
  msg.className = 'form-msg';
  msg.textContent = '';
  btn.disabled = true; btn.textContent = 'Submitting…';
  try {
    const res = await fetch('/api/backlinks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: $id('blName').value,
        website: $id('blWebsite').value,
        email: $id('blEmail').value,
        state: $id('blState').value,
        category: $id('blCategory').value,
        description: $id('blDesc').value,
        lookingFor: $id('blLooking').value,
      }),
    });
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    msg.className = 'form-msg ok';
    msg.textContent = '\u2705 Your website is now live in the directory!';
    e.target.reset();
    loadListings();
  } catch (err) {
    msg.className = 'form-msg err';
    msg.textContent = err.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Add My Website Free';
  }
});

/* Backend reachability self-check (server asleep / static preview detection) */
(async () => {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch('/api/health', { signal: ctrl.signal });
    clearTimeout(t);
    const ct = r.headers.get('content-type') || '';
    if (r.ok && ct.includes('application/json')) return;
  } catch { /* fall through to banner */ }
  const b = document.createElement('div');
  b.className = 'backend-banner show';
  b.innerHTML = '\u26A0\uFE0F The directory is not connected. You are viewing the static preview, or the server fell asleep — open the LIVE PREVIEW of the running \u201COzSEO Toolkit\u201D process, or ask the assistant to restart the server, then refresh.';
  const hero = document.querySelector('.hero');
  hero && hero.appendChild(b);
})();

loadListings();
