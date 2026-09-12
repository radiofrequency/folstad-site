# Buzz (`radiofrequency/buzzftw`)

This repository is the **Buzz product** — control plane, launcher SPA, and Hetzner relay. It is not the Folstad marketing site.

| | |
|---|---|
| **Repo** | [github.com/radiofrequency/buzzftw](https://github.com/radiofrequency/buzzftw) |
| **Product** | https://buzzftw.com |
| **Relay** | https://relay.buzzftw.com |
| **Marketing** | Private [radiofrequency/folstad.ca](https://github.com/radiofrequency/folstad.ca) — not published from this repo |

`main` is the Buzz / platform branch.

The `folstad-pages` GitHub branch is a historical Pages snapshot (tag `folstad-v1`). **Do not delete it from GitHub** — that is a human/Ryan task. This repo must not deploy Folstad marketing or GitHub Pages.

## Rename (historical)

This repo was `radiofrequency/folstad-site` (Folstad AI marketing + Buzz in one tree). Marketing was split to `radiofrequency/folstad.ca`. The GitHub repo was renamed to `radiofrequency/buzzftw`.

## Stack

| Path | Role |
|------|------|
| `src/` | Astro SPA: Buzz launcher, auth, dashboard. Leftover Folstad marketing pages (`/`, `/restaurant`) are **not** the live marketing site. |
| `infra/` | AWS CDK control plane (Cognito, API, DynamoDB, ECS hooks) |
| `packages/buzz-api` | Lambda handlers |
| `packages/buzz-runtime` | Fargate project runtime image |
| `packages/buzz-shared` | Shared types |
| `packages/buzz-platform` | Free relay on Hetzner (`relay.buzzftw.com`) |

## Develop

```bash
git clone https://github.com/radiofrequency/buzzftw.git
cd buzzftw
npm install
npm run dev
```

Open the URL Astro prints (usually `http://localhost:4321`).

Buzz app routes: `/signup` → verify email → `/login` → `/buzz` → `/dashboard`.

Auth and API talk to the live control plane (public SPA client config in `src/lib`). Optional overrides: `.env.example`.

```bash
npm run build
npm run preview
```

Default `SITE_URL` is `https://buzzftw.com`. Override with `SITE_URL=...` if you need a different canonical host for a local build.

## Deploy

**Do not** publish this tree to GitHub Pages. The Pages workflow in `.github/workflows/deploy.yml` is disabled so `main` cannot overwrite Folstad marketing.

Buzz infra is **not** deployed by GitHub Actions from this repo:

- Control plane: `cd infra && npm i && npx cdk deploy` (existing laptop AWS credentials; do not invent secrets).
- Relay: [`packages/buzz-platform/MIGRATION.md`](packages/buzz-platform/MIGRATION.md) — `relay.buzzftw.com` on Hetzner.

Apex `buzzftw.com` / `www` stay on the existing CloudFront/S3 marketing host. Changing DNS, AWS account settings, or production credentials is a Ryan task.

## Brand assets

| File | Use |
|------|-----|
| `public/mark.svg` | Aperture mark |
| `public/logo.svg` | Mark + wordmark |
| `public/favicon.svg` | Favicon |
| `assets/brand/` | Logo explorations (not required at runtime) |
