# elimux-backend

Express + TypeScript API for ElimuX, backed by Supabase Postgres. Deployed on Railway as the
**only** backend service — see [`BACKEND_GUARD.md`](./BACKEND_GUARD.md) before touching deploy
config. Schema lives in the separate [`elimux-sql`](https://github.com/Afribotke/elimux-sql) repo.

## Routes

Mounted in `src/index.ts`, one file per resource under `src/routes/`. Admin-only endpoints go
through `adminMiddleware` (`X-Admin-Key` header, checked against `ADMIN_KEY`); a plain
`authMiddleware` (`X-Api-Key`) also exists in `src/middleware/auth.ts` but nothing currently
requires it.

| Mount | File | Purpose |
|---|---|---|
| `/api/institutions` | `institutions.ts` | List/get/create/update/delete institutions, `?featured=true` filter, public apply-to-list flow (`/apply`, `/apply/:token`). |
| `/api/programs` | `programs.ts` | List/get/create/update/delete programs, filter by institution, public apply flow (`/apply`). |
| `/api/payments` | `payments.ts` | Paystack integration: plans, `/initialize`, `/verify/:reference`, `/webhook`, subscription status/cancel/history. Email-based, no user auth. |
| `/api/ai-search` | `ai-search.ts` | Natural-language search via the Anthropic provider in `src/lib/ai/`. |
| `/api/favorites` | `favorites.ts` | Device-fingerprint-scoped favorites (add/list/remove), no auth. |
| `/api/share` | `share.ts` | Generates/reads shareable links for institutions or programs. |
| `/api/reviews` | `reviews.ts` | Public review submission and listing (only `status = 'approved'` is public), `/helpful` voting. |
| `/api/admin` | `admin.ts` | Admin-only: `/verify` (key check), subscription plan CRUD, institution/program application moderation (`approve`/`reject`), review moderation. |
| `/api/gamification` | `gamification.ts` | Device-scoped points/badges/leaderboard, referral codes. |
| `/api/sponsor-ads` | `sponsor-ads.ts` | Public placement-scoped ad listing + click tracking; admin create/update/toggle and full listing (`/admin`). |
| `/api/admin/analytics` | `admin-analytics.ts` | Admin dashboards (overview/revenue/users/searches/institutions) reading from `analytics_events`; `POST /track` is the one public route in this file (see file for why). |
| `/api/pwa` | `pwa.ts` | Push subscribe/unsubscribe, admin `/notify` (web-push), offline `/cache` read/write, `/queue`+`/sync` for background-synced actions. |
| `/api/admin/scraper` | `scraper.ts` | Admin-only (router-level `adminMiddleware`, not per-route). Fetches an admin-supplied URL, AI-extracts program listings, diffs against `programs`, files `program_changes` for review (`/run`, `/jobs`, `/changes`, `/changes/:id/approve\|reject`, `/sources` CRUD). See "Data scraper" below before pointing it at a new URL. |

`GET /health` and `GET /` (endpoint index) are defined directly in `src/index.ts`, unauthenticated.

## Identity model

There is no login system. Two identity mechanisms are used depending on the feature:

- **Device fingerprint** (`src/lib/deviceFingerprint.ts`): `sha256(ip + user-agent)`, truncated to 32
  chars. Used by favorites, gamification points/badges, and ad click tracking.
  `getDeviceFingerprint()` is the single source of truth — don't reimplement it inline.
- **Email**: subscriptions/payments and referrals are keyed by email, not a user ID.

## Data scraper

`POST /api/admin/scraper/run` fetches a URL and asks Claude to extract program
listings from the page text — it does **not** use the CSS `selectors` stored
on a `scraping_sources` row (that field is accepted and saved for a possible
future selector-based path, but nothing reads it today).

**Source URLs must point to an actual course catalog page — one that lists
specific degree titles ("Bachelor of Medicine and Bachelor of Surgery",
"Diploma in Nursing") — not a faculty/department directory or org chart page**
(e.g. a page that just lists "Faculty of Engineering" → "Civil Engineering",
"Psychiatry", "Human Anatomy" with no degree-level titles attached). This
matters because a directory page doesn't just produce *no* results — a live
test against `uonbi.ac.ke/programmes` (a department directory) showed the
model **fabricate** plausible-sounding degree titles from bare department
names ("Psychiatry" → "Master of Medicine in Psychiatry (Mmed. Psych.)")
despite an explicit "do not invent programs" instruction in the prompt. 293
fabricated `program_changes` rows got filed and had to be manually rejected.

Three layers now guard against this in `scraper.ts`, in order of how much
they're trusted:
1. **`isVerbatimInSource()`** (strongest) — the extracted name must literally
   occur in the fetched page text. A fabricated title is, by construction,
   text that wasn't on the page it supposedly came from.
2. **`looksLikeDegreeTitle()`** — a regex requiring a degree-level keyword
   (Bachelor/Master/PhD/Diploma/...). Weaker alone: it only catches a bare
   department name slipping through *untouched* — it does **not** catch a
   fabricated title dressed up to look real (which is exactly what happened
   in production and is why check #1 exists).
3. **`source_looks_like_directory`** — the model's own self-report. Not
   authoritative on its own (trusting an LLM's self-assessment of whether it
   just hallucinated is circular), but a useful independent signal when it
   agrees with #1/#2.

If **every** extracted entry fails #1 or #2, the job fails outright and files
zero changes rather than filing a mix of good and fabricated rows. If only
*some* entries fail, those are dropped and the rest proceed, with a
non-fatal note left in the job's `errors` field (`programs_found` in the
response only counts what survived filtering).

## Environment variables

| Variable | Used for |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | DB access (`src/lib/supabase.ts`) — service role, so RLS is bypassed everywhere in this codebase. |
| `ADMIN_KEY` | `adminMiddleware` (`X-Admin-Key` header) |
| `API_KEY` | `authMiddleware` (`X-Api-Key` header, currently unused by any mounted route) |
| `ANTHROPIC_API_KEY` | AI search provider |
| `PAYSTACK_SECRET_KEY` | Payments |
| `FRONTEND_URL` | Builds the Paystack callback URL |
| `PORT` | Server port (Railway sets this) |

Set these in the Railway service, not in a committed `.env` — `.env.local` here is dev-only and
gitignored.

## Working on this repo

```
npm run dev     # ts-node src/index.ts
npm run build   # tsc -> dist/
npm run start   # node dist/index.js (what Railway runs after build)
```

Schema changes: add a numbered file to `elimux-sql`, run it in the Supabase SQL Editor, *then* write
the route code here — see `elimux-sql/README.md`'s "Known drift" section for why this order matters.

Before deploying, run `./scripts/check-before-deploy.ps1` and see `BACKEND_GUARD.md`.
