# vastos-api

Backend API layer for Vastos CRM — Phase 2 of the infrastructure roadmap (Track B).
Sits in front of the existing Supabase project (Postgres, Auth, RLS unchanged) as the
new access path for features moved off direct Supabase client calls, one module at a
time (strangler-fig pattern) — see the frontend repo's `README.md` for the full
environment picture.

## Local dev

```bash
npm install
cp .env.example .env.local   # or use the pre-filled .env (Staging project) already in the repo
npm run start:dev
curl http://localhost:3000/health
```

## Structure

- `src/health/` — unauthenticated health-check endpoint. This is what Phase 3's Kamal
  deploy pipeline will poll to gate zero-downtime rollouts and trigger rollback.
- `src/supabase/` — `SupabaseService`, a thin wrapper around the Supabase JS client
  using the **anon key** (same privilege level the frontend already has — Postgres RLS
  stays the real enforcement layer). `SUPABASE_SERVICE_ROLE_KEY` is intentionally not
  wired up: bypassing RLS should be an explicit, reviewed decision per endpoint that
  needs it, not a default every module inherits.
- `src/auth/supabase-auth.guard.ts` — verifies the `Authorization: Bearer <token>`
  header against Supabase Auth (`auth.getUser`) rather than reimplementing JWT
  verification. Apply with `@UseGuards(SupabaseAuthGuard)` on any route that needs a
  logged-in user; `request.user` is populated after it passes.

## Status

Bootstrap only (Phase 01 of the roadmap). Not yet deployed anywhere — Phase 02
(Hetzner + Cloudflare) and Phase 03 (Kamal + GitHub Actions) come next.
