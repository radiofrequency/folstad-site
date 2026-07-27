# Folstad AI

Static marketing site for **Folstad AI** — custom AI agents and automation for businesses of any size.

**Contact:** [DM @RyanFrequency on X](https://x.com/messages/compose?recipient_id=1518619688041074691)

## Stack

- [Astro](https://astro.build) (`output: 'static'`)
- Hand-authored CSS (Barely There, light ethereal)
- Near-zero client JS (nav active state + soft reveal)

## Develop

```bash
cd folstad-site
npm install
npm run dev
```

Open the URL Astro prints (usually `http://localhost:4321`).

## Build

```bash
npm run build
npm run preview
```

Output is in `dist/` — pure static files.

### Base path (GitHub Pages project site)

If the site is served from `https://<user>.github.io/folstad-site/`:

```bash
BASE_PATH=folstad-site SITE_URL=https://<user>.github.io npm run build
```

For a custom domain or user root site (`username.github.io`):

```bash
SITE_URL=https://yourdomain.com npm run build
# leave BASE_PATH unset
```

## Deploy — GitHub Pages

**Repo:** [github.com/radiofrequency/folstad-site](https://github.com/radiofrequency/folstad-site)  
**Live (project URL):** https://radiofrequency.github.io/folstad-site/

Push to `main` deploys via `.github/workflows/deploy.yml`.

### Repo variables

| Variable | Current | When to change |
|----------|---------|----------------|
| `BASE_PATH` | `folstad-site` | **Delete** when you attach a custom domain (site must serve at `/`) |
| `SITE_URL` | `https://radiofrequency.github.io` | Set to `https://yourdomain.com` with custom domain |

### Point a GoDaddy domain at this site

GitHub Pages custom domains need a **CNAME** (or A records for apex). Example for `www.yourdomain.com` and apex `yourdomain.com`.

#### A) In GitHub (do this first)

1. Open **https://github.com/radiofrequency/folstad-site/settings/pages**
2. Under **Custom domain**, enter your domain (prefer `www.yourdomain.com` or the apex you want).
3. Save. GitHub will create a `CNAME` file after the next deploy (or add `public/CNAME` with one line: `www.yourdomain.com` and push).
4. Check **Enforce HTTPS** after DNS validates (can take minutes to hours).
5. **Before or right after custom domain works:**
   - Delete repo variable `BASE_PATH` (Settings → Secrets and variables → Actions → Variables)
   - Set `SITE_URL` to `https://www.yourdomain.com` (or your apex)
   - Re-run **Actions → Deploy to GitHub Pages** so asset paths are `/` not `/folstad-site/`

#### B) In GoDaddy DNS

1. Sign in → **My Products** → your domain → **DNS** / **Manage DNS**.
2. Remove or edit old records that send the domain to the previous host (old A/CNAME to hosting, Website Builder, etc.) so they don’t conflict.

**Option 1 — Use `www` (recommended)**

| Type | Name | Value | TTL |
|------|------|--------|-----|
| CNAME | `www` | `radiofrequency.github.io` | 1 hour |

**Option 2 — Apex (naked) domain `yourdomain.com`**

GitHub Pages apex uses A records (not a CNAME to github.io):

| Type | Name | Value | TTL |
|------|------|--------|-----|
| A | `@` | `185.199.108.153` | 1 hour |
| A | `@` | `185.199.109.153` | 1 hour |
| A | `@` | `185.199.110.153` | 1 hour |
| A | `@` | `185.199.111.153` | 1 hour |

Optional: also set **www → apex** or **www CNAME → radiofrequency.github.io**, and in GitHub set the primary custom domain you want (then enable redirect from the other if offered).

**AAAA (IPv6)** optional — GitHub documents:

| Type | Name | Value |
|------|------|--------|
| AAAA | `@` | `2606:50c0:8000::153` |
| AAAA | `@` | `2606:50c0:8001::153` |
| AAAA | `@` | `2606:50c0:8002::153` |
| AAAA | `@` | `2606:50c0:8003::153` |

3. Save DNS. Wait for propagation (often 15–60 min; up to 48h).
4. Back in GitHub Pages settings, wait until the domain shows as **DNS check successful**, then enable **Enforce HTTPS**.

#### C) If the domain currently hosts the old Folstad site

- Pointing DNS at GitHub **replaces** whatever GoDaddy was serving for that hostname.
- To keep the old site and use a new hostname, create a subdomain (e.g. `ai.folstad.ca` or `www` only) and only change that record.
- For subdomain only:

| Type | Name | Value |
|------|------|--------|
| CNAME | `ai` | `radiofrequency.github.io` |

Then set GitHub custom domain to `ai.folstad.ca` and `SITE_URL` / clear `BASE_PATH` as above.

#### D) Common GoDaddy pitfalls

- **Forwarding** (domain “Forwarding” to another URL) fights custom DNS — turn off forwarding for hostnames you manage with records.
- Don’t leave an old **Parked** / **Website Builder** A record on `@` if you want GitHub on the apex.
- After DNS change, hard-refresh or try incognito; CDN caches can lag.

## Brand assets

| File | Use |
|------|-----|
| `public/mark.svg` | Aperture mark |
| `public/logo.svg` | Mark + wordmark |
| `public/favicon.svg` | Favicon |
| `assets/brand/` | Logo explorations (not required at runtime) |

## Site map

Single page with anchors:

- `#hero` — thesis + CTA
- `#what-we-do`
- `#how-we-do-it`
- `#starter-kits`
- `#pricing` — Pilot / Build / Run
- `#contact` → X DM (@RyanFrequency)

## Pricing (public)

| Tier | Price | Role |
|------|-------|------|
| Pilot | $4,900 one-time | Starter kit / first workflows |
| Build | from $12,000 | Custom multi-domain project |
| Run | $1,800 / month | Ops, updates, light new work |
| New Business | Custom quote | Website, email, payments, support — AI from day one |

Quotes and discovery via X only — no checkout on the site.
