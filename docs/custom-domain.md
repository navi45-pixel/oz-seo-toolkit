# Custom domain runbook — OzSEO Toolkit

Everything needed to move the toolkit from
`https://oz-seo-toolkit.multani-navdeep29.workers.dev` to a domain you own
(example below: `www.ozseo.com.au`), in the right order, with the automated
safety nets this repo already has.

Do the steps **in order** — DNS before Cloudflare, Cloudflare before the origin
swap, the origin swap before Search Console.

---

## 0. What stays working automatically

These need **no changes** when the domain moves:

- **Routing** — the worker fetches clean URLs and the Workers asset layer
  resolves them; nothing is host-specific in `worker.js` (except the code
  fields listed in step 3).
- **Security headers / HTTPS forcing / caching / 404s** — all origin-agnostic.
- **The route-consistency gate** — `scripts/check-404-routes.js` parses
  sitemap `<loc>`s domain-agnostically, so it stays green through the swap.
- **`robots.txt` rules** — only the `Sitemap:` URL and comment banner change
  (handled by the script in step 3).

## 1. DNS

At your registrar (or after moving DNS to Cloudflare):

| Record | Name  | Value                        | Proxy |
|--------|-------|------------------------------|-------|
| CNAME  | `www` | `oz-seo-toolkit.multani-navdeep29.workers.dev` | Proxied (orange) |
| CNAME or A/AAAA | apex (`@`) | per Cloudflare's instructions in step 2 | Proxied |

Notes:
- **`www` as the canonical host is the simplest setup** on Cloudflare; apex →
  `www` forwarding is one toggle (step 2).
- TTL: use Auto. You can lower it *before* the cutover and raise it after, to
  make mistakes cheaper.

## 2. Cloudflare: attach the domain to the Worker

Dashboard: **Workers & Pages → oz-seo-toolkit → Settings → Domains & Routes →
Add → Custom domain**, and add both `www.ozseo.com.au` and the apex
`ozseo.com.au`. Cloudflare will:
- validate the DNS records from step 1,
- provision edge certificates automatically (free, no config),
- with "apex → www redirect" offered as a toggle — turn it on so both hosts
  work and one is canonical.

If you prefer config-as-code instead of the dashboard, the equivalent is a
`routes` entry in `wrangler.toml`:

```toml
routes = [
  { pattern = "www.ozseo.com.au", custom_domain = true },
  { pattern = "ozseo.com.au", custom_domain = true },
]
```

`run_worker_first = true` in `[assets]` stays as is — it's what makes the
HTTPS-force redirect, security headers and branded 404s work on the new host
too.

**Workers paid plan note:** custom domains for Workers require the Workers
Free plan to allow up to 5 custom domains per worker (current behaviour) — if
attachment fails, check the plan limits page in the dashboard.

## 3. Swap the canonical origin (one command)

```bash
node scripts/set-origin.js https://www.ozseo.com.au
```

That rewrites, in one pass:
- **canonical href + og:url + og:image + twitter:image + JSON-LD url fields**
  in the four pages,
- every `<loc>` in `public/sitemap.xml`,
- the `Sitemap:` line + comment banner in `public/robots.txt`.

`--show` lists the current origin per file without changing anything. The
script is safe by construction: it discovers each file's current origin from
its own canonical marker and replaces **only URLs on that host** — outbound
links (schema.org, Google, GitHub, the directory listings…) cannot be touched.
(It also fails loudly if a marker exists but the swap changed nothing.)

Preview what will change first if you like:

```bash
node scripts/set-origin.js --show
node scripts/set-origin.js https://www.ozseo.com.au
git diff            # review: canonicals, sitemap, robots — nothing else
```

Then verify + deploy:

```bash
npm test                 # route-consistency gate (domain-agnostic)
node scripts/smoke.js    # optional: against the current live URL
npm run deploy           # gen:sitemap keeps lastmod; smoke-tests the worker
```

The workers.dev URLs keep working (they just 301 to the new origin via the
canonical tags and Cloudflare's domain config — no code change needed).

## 4. Search Console & the outside world

1. **Search Console**: add a property for `https://www.ozseo.com.au`, verify
   via the DNS record Cloudflare suggests, then submit
   `https://www.ozseo.com.au/sitemap.xml`.
2. If the old property exists for workers.dev, use **Change of Address**
   (Settings → Change of address) pointing to the new property.
3. Re-run the toolkit's own audit on the new origin — the HTTP→HTTPS check,
   security headers and sitemap checks should all pass there too.
4. Email (SPF/DMARC — closes the last self-audit fail): with a real domain you
   control DNS, so publish at minimum:
   - `TXT @ "v=spf1 -all"` (no mail is sent from this domain)
   - `TXT _dmarc "v=DMARC1; p=reject; rua=mailto:you@yourdomain"` 
   These make the **Email authentication** audit check flip to pass and stop
   domain spoofing.

## 5. Rollback

The swap is a plain git diff:

```bash
node scripts/set-origin.js https://oz-seo-toolkit.multani-navdeep29.workers.dev
npm run deploy
```

…and remove the custom domains in the Cloudflare dashboard. DNS TTL is the
only slow part; that's why step 1 suggests lowering it first.

---

### Checklist (printable)

- [ ] DNS: `www` CNAME → workers.dev, proxied (TTL auto/lowered)
- [ ] Cloudflare: add custom domain(s) on the Worker, apex→www redirect on
- [ ] `node scripts/set-origin.js --show` → review
- [ ] `node scripts/set-origin.js https://www.ozseo.com.au` → `git diff` review
- [ ] `npm test` + `npm run deploy` (14/14 smoke)
- [ ] Live spot-checks: `curl -I https://www.ozseo.com.au/` (200 + security
      headers), `curl -I http://www.ozseo.com.au/` (301), `/robots.txt`,
      `/sitemap.xml`, a random 404
- [ ] Search Console: new property, verify, submit sitemap, Change of Address
- [ ] SPF/DMARC TXT records published
- [ ] Old workers.dev property: keep it resolving (no cleanup needed)
