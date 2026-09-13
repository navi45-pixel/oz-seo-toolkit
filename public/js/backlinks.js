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

/* Directory loading — paginated (server default: 50 per page, max 100) */
const PAGE_SIZE = 50;
let blCursor = null; // id-anchored cursor: stable while new listings arrive
let blHasMore = false;
let blLastFilters = { state: '', cat: '' };

function listingCard(l) {
  return `
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
        </p>
      </div>`;
}

async function loadListings(opts) {
  const append = !!(opts && opts.append);
  const state = $id('fState').value;
  const cat = $id('fCategory').value;
  // Filters changed since this page was requested? Start over instead of mixing.
  if (append && (state !== blLastFilters.state || cat !== blLastFilters.cat)) return loadListings();
  if (!append) {
    blCursor = null;
    blLastFilters = { state, cat };
  }
  const params = new URLSearchParams();
  if (state) params.set('state', state);
  if (cat) params.set('category', cat);
  params.set('limit', String(PAGE_SIZE));
  if (blCursor) params.set('after', blCursor);
  try {
    const res = await fetch('/api/backlinks?' + params);
    const data = await safeJson(res);
    const box = $id('listings');
    $id('blCount').textContent = data.total ? `${data.total} site${data.total === 1 ? '' : 's'} listed` : '';
    blHasMore = !!data.hasMore;
    blCursor = data.nextCursor || null;
    const html = data.listings.map(listingCard).join('');
    if (append) box.insertAdjacentHTML('beforeend', html);
    else box.innerHTML = html || `<div class="empty-note" style="grid-column:1/-1">No listings yet${state || cat ? ' for that filter' : ''} — be the first to add your site above! &#128640;</div>`;
    const more = $id('blMore');
    if (more) more.style.display = blHasMore ? '' : 'none';
  } catch {
    const more = $id('blMore');
    if (more) more.style.display = 'none';
    $id('listings').innerHTML = '<div class="empty-note" style="grid-column:1/-1">Could not load listings. Try refreshing.</div>';
  }
}

$id('fState').addEventListener('change', () => loadListings());
$id('fCategory').addEventListener('change', () => loadListings());
const blMoreBtn = $id('blMore');
if (blMoreBtn) blMoreBtn.addEventListener('click', () => loadListings({ append: true }));

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
