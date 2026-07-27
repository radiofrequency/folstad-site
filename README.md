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

1. Push this repo to GitHub.
2. **Settings → Pages → Build and deployment → Source:** GitHub Actions.
3. Optional repository variables:
   - `BASE_PATH` — default workflow uses `folstad-site` (repo name). Set empty string logic via override if using a custom domain.
   - `SITE_URL` — e.g. `https://youruser.github.io`
4. Push to `main` (or run **Actions → Deploy to GitHub Pages → Run workflow**).

Workflow: `.github/workflows/deploy.yml`

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
