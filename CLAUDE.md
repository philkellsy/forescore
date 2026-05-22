# ForeScore — Claude Code Guide

## Project overview

ForeScore is a **multi-tenant SaaS** golf tour management platform, forked from
a single-tenant app called **Legends** (Bonville International Golf Resort annual trip).
Each golf tour operator is a **tenant**. Players can participate across multiple tenants.

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js ≥ 20 |
| Framework | Express 4 |
| Templating | EJS + Bootstrap 5 |
| ORM / query | Knex 3 |
| Database | **PostgreSQL** (migrated from SQLite — do not use SQLite patterns) |
| Session store | connect-pg-simple (Postgres-backed sessions table) |
| Auth | Passwordless 6-digit one-time codes (SHA-256 hashed, emailed via Brevo) |
| Email | Brevo transactional API |
| Hosting | Railway |

## Routing model

All application routes live under `/:tenantSlug`. The slug is the first path segment — no subdomain, no `/t/` prefix.

```
/legends/auth/login
/legends/tours
/legends/scoring/42
```

This gives deep-linkable, bookmarkable URLs that work identically in local dev and production. Users who belong to multiple tenants get a tenant-switcher UI; the URL always encodes which tenant you're in.

`tenantMiddleware` resolves `req.params.tenantSlug` → DB lookup → `req.tenant` + `res.locals.tenant`.
If the slug doesn't exist the middleware returns 404.

## Multi-tenancy model

Row-level tenancy. Two tables carry `tenant_id` explicitly:
- `courses` — each tenant maintains their own course library
- `tours` — tours belong to a tenant

All child tables (scorecards, players, teams, etc.) inherit tenant scope through
FK chains (`scorecard → golf_round → tour → tenant`). They do **not** carry a redundant `tenant_id`.

**Global tables** (no tenant_id, shared across all tenants):
- `users` — identity is global; membership is scoped via `tenant_memberships`
- `login_codes` — per-user auth codes, not per-tenant

## User roles

Roles live on `tenant_memberships.role`, **not** on `users`:

| Role | Access |
|---|---|
| `owner` | Billing, full admin, can delete tenant |
| `admin` | Full tour management, user management |
| `scorer` | Can enter/edit scores |
| `player` | Read access, own scorecard entry |

`requireRole('admin', 'owner')` or `requireMinRole('admin')` — both available in
`src/middleware/authorize.js`. Role is resolved once per request by `tenantMiddleware`
(attached as `req.tenantMembership`) so role checks are synchronous after that.

## Authentication

Passwordless flow, scoped per tenant:
1. User visits `/:tenantSlug/auth/login`
2. Submits email or mobile → `login_codes` row created (SHA-256 hash of 6-digit code)
3. Code emailed via Brevo; logged to stdout in dev when Brevo vars are absent
4. User submits code → verified, `used_at` stamped, session created
5. **Tenant membership is checked before session is established** — users with no
   membership in the requested tenant get a 403, not a session
6. After login redirects to `/:tenantSlug/`
7. Codes expire after 15 minutes; resend throttled to 30 seconds

Session stores `{ id, firstName, lastName, email, isSuperAdmin }` — **no role** (role is
resolved fresh from DB on each request via tenant middleware).

## Super admins

`users.is_super_admin` (boolean) — a cross-tenant flag, not a role. Multiple super admins
are supported.

Super admin login lives at `/auth/login` (no tenant slug) and is handled by
`src/routes/super-admin.routes.js`. After login, super admins land at `/` which renders
the tenant picker (`src/views/super-admin/tenants.ejs`).

Super admins visiting a tenant URL (`/:tenantSlug/...`) without a real `tenant_memberships`
row get a **synthetic membership** injected by `tenantMiddleware`:
```js
{ role: 'owner', tenant_id, user_id, isSynthetic: true }
```
All `requireRole`/`requireMinRole` middleware works unchanged — synthetic membership is
indistinguishable from a real owner membership at the middleware layer.

`POST /tenants` (create tenant) requires super admin. Tenant creation redirects to the
new tenant's admin page.

Super admin nav links: tenant picker (`/`), all-tours list (`/tours`), system-wide session
logs (`/session-logs`).

## Key domain concepts

### Tours
One multi-day golf trip per tenant. `label` is the human-readable display name
(e.g. "Legends 2026"); `year` is an integer for sorting only — not a unique key.
Per-round configuration lives in `golf_rounds` (course, calc_type, status, tour_date).

**There is no `num_rounds` column on `tours`.** The set of rounds for a tour is derived
by querying `SELECT round_number FROM golf_rounds WHERE tour_id = ?` — never use
`tour.num_rounds` (it doesn't exist). Rounds include draft, open, and closed statuses.

Tour lifecycle: `draft` → `active` (requires super-admin payment approval via `is_paid`) → `completed`.
Multiple active tours per tenant are allowed.

**Tour duration is derived**: `MIN(golf_rounds.tour_date)` → `MAX(golf_rounds.tour_date)`.
No `start_date` / `end_date` columns are stored on `tours`.
Non-golf days simply have no `golf_rounds` row — there is no `rest_days` column.

### Calc types (per round)
| Value | Meaning |
|---|---|
| `stableford` | Points scored against par with handicap |
| `ambrose_nett` | 4-ball ambrose team format, nett score |
| `stroke` | Gross stroke play |

Round 1 is **not** assumed to be ambrose — each round's calc_type is set independently on `golf_rounds`.

### 2-ball competition
Optional alongside the main round format. Controlled by `golf_rounds.two_ball_enabled` (boolean)
and `two_ball_type` (`'best_ball'` | `'aggregate'`). Partners are implicit from tee group position:
positions 1+2 = ball A, positions 3+4 = ball B. Independent cross-group pairing may be added later.

### Handicaps
- **Tour handicap index**: stored in `player_handicaps.playing_handicap` (decimal 5,1) — per tour/player.
- **Round override**: stored in `player_day_handicaps.handicap_index` (decimal 5,1) — per tour/player/round_number. Falls back to tour handicap when absent.
- **Round playing handicap** is always computed in real-time (never stored):
  `ROUND(handicap_index × (slope_rating / 113) + (course_rating − course_par))`
  where `course_par = SUM(holes.par)` for the tee set.

### Competition types
Individual stableford, ambrose teams, skins (individual + team), calcutta
auction, novelty events (nearest-to-pin, long drive).

### Scoring
Scorecards have a `type` of `individual` or `team`. Each hole has a
`gross_score` and computed `stableford_points`. Optimistic concurrency
controlled via `scorecard_holes.version` + `op_id` (idempotent patch ops).

### Calcutta
Optional per tour (`tours.calcutta_enabled`). Players are auctioned. `buyer_user_id` paid the
winning bid; `owner_user_id` is an optional fractional re-seller. Prize percentages configured
per tour on the `tours` table.

### Skins
Per-hole pots. Carry-forward tracked in `skins_carry`. Each hole has
`base_pot_amount` + `carry_in_amount` = `total_pot_amount`.

### Prizes
- `tours.tour_prizes` jsonb `[{label, amount}]` — aggregate/championship prizes
- `tours.daily_prizes` jsonb `[{label, amount}]` — per-round stableford prizes
- `golf_rounds.ambrose_prizes` jsonb `[{label, amount}]` — prizes for ambrose rounds

### Tee groups + group generation
`tee_groups` stores per-round groups with tee_time, starting_hole, group_number, source.
`tee_group_players` stores player assignments with position (1-4).

Group sizes prioritise foursomes, use threesomes to avoid 2-balls (only unavoidable when n=5 or n=2).
Use `groupSizes(n)` from `src/services/scoring/group-generator.service.js`.

Two auto-generation strategies:
- **distribute** (`distributeGroups`): minimises repeat playing partners from all prior rounds via random-trial pairings matrix
- **leaderboard** (`reverseLeaderboardGroups`): worst-placed players go first, leaders go last

All tee group mutations are locked once a round's status leaves `draft`.

### Leaderboard
Championship countback always uses **absolute** hole numbers (holes 10-18 for back 9),
regardless of starting hole. When `leaderboard_best_of_rounds` is set on a tour, each player's
championship total uses only their best N rounds — dropped rounds are also excluded from countback.

## Project structure

```
src/
  app.js             Express app factory — creates /:tenantSlug router
  server.js          Entry point (port 2080)
  bootstrap.js       Runs migrations + seeds 'init' tenant + Phil (is_super_admin) in dev
  config/
    env.js           All env vars with defaults
    roles.js         ROLES + ROLE_HIERARCHY constants
    constants.js     Session/auth timing constants
  db/
    knex.js          Knex singleton (env-aware: dev/test/production)
    repositories/    Data-access layer — 18 files, one per domain entity
  middleware/
    tenant.js        Resolves /:tenantSlug → req.tenant + req.tenantMembership (synth for super admin)
    auth.js          requireAuth — redirects to /:tenantSlug/auth/login
    authorize.js     requireRole(...roles) + requireMinRole(minRole)
    rate-limit.js    Auth endpoint rate limiter
  routes/
    auth.routes.js        Login/logout — tenant-aware, checks membership on verify; logs session events
    super-admin.routes.js Global auth (/auth/login, /auth/send-code, /auth/verify-code), tenant picker (/),
                          create tenant (/tenants), all-tours list (/tours), session logs (/session-logs)
    admin.routes.js       /:tenantSlug/admin — tour setup, round config, player roster, members, tee times,
                          courses (split ratings, duplication), session logs (super admin only)
  services/
    auth/
      login-code.service.js          createLoginCode, consumeLoginCode, findUserByLookup
      session-logger.service.js      logSessionEvent — fire-and-forget DB write to session_logs
      mailer.service.js              sendLoginCode, sendEmailChangeCode (uses HTML template skin)
    email/templates/
      login-code.js                  HTML email template for sign-in OTP
      email-change.js                HTML email template for email-change OTP
      layout.js                      Shared HTML email wrapper/skin
    event-status.service.js          canActivate, canComplete
    scoring/
      handicap.service.js            strokesForHole, computeCourseHandicap
      stableford-leaderboard.service.js  calculateStablefordLeaderboards (dynamic rounds + bestOf)
      group-generator.service.js     groupSizes, distributeGroups, reverseLeaderboardGroups
  views/
    super-admin/     login.ejs, tenants.ejs, session-logs.ejs — global super admin UI
    admin/           dashboard.ejs, tour-detail.ejs, round-config.ejs, tour-setup.ejs,
                     members.ejs, tee-times.ejs, courses.ejs, course-edit.ejs, course-import.ejs,
                     session-logs.ejs (tenant-scoped, super admin only)
    admin/partials/  player-hcp-row.ejs — handicap display + round override inline form
    partials/nav.ejs ForeScore branding, tenantPath() URLs, role-based admin link
  public/            Static assets, PWA manifest + service worker
migrations/
  001_initial_schema.js         Consolidated baseline — all tables (tenants, users, tours, courses,
                                  scoring, tee times, calcutta, skins, leaderboard, itinerary, etc.)
  002_course_split_ratings.js   supports_split_ratings boolean on courses (default false)
  003_session_logs.js           session_logs table with indexes on user_id, tenant_id, created_at
  legacy/            Archived SQLite migrations from Legends — reference only
test/
  helpers/
    pg.js            Shared Postgres test helper: createTestDb, seedTenantAndOwner, seedEvent
  unit/              Pure logic + service tests
  integration/       HTTP-level tests (scoring integration tests skipped until routes rebuilt)
```

## Repository layer

All DB access goes through `src/db/repositories/`. Each file exports pure functions that take `db` as the first argument (dependency injection — no singleton imports).

| Repository | Key functions |
|---|---|
| `tenants.js` | `findBySlug`, `findById`, `create`, `update` |
| `users.js` | `findById`, `findByEmail`, `findByPhone`, `findByEmailOrPhone`, `create`, `update` |
| `tenant-memberships.js` | `findByTenantAndUser`, `findAllByUser`, `findAllByTenant`, `create`, `updateRole`, `remove` |
| `tours.js` | `findById`, `findByTenant`, `findActive`, `create`, `update`, `markDirty` |
| `courses.js` | `findById`, `findByTenant`, `create`, `update`, `remove` |
| `holes.js` | `findByCourse`, `replaceAll` (atomic delete + insert in transaction) |
| `event-players.js` | `findByTour`, `findByTourAndUser`, `register`, `updateStatus` |
| `player-handicaps.js` | `findByTour`, `findByTourAndUser`, `upsert` — tour-level raw handicap index |
| `player-day-handicaps.js` | `findByTourRound`, `findByTourRoundAndUser`, `upsert`, `remove` — per-round overrides |
| `golf-rounds.js` | `findByTour`, `findByRound`, `upsert`, `updateStatus`, `setPublished` |
| `tee-groups.js` | `findByTourRound` (returns groups with nested players), `create`, `addPlayer`, `removePlayer`, `clearRound` |
| `teams.js` | `findByTourRound` (returns teams with nested members), `findById`, `create`, `addMember`, `removeMember` |
| `scorecards.js` | `findById`, `findByTourRound`, `findForUser`, `findForTeam`, `create`, `updateStatus` |
| `scorecard-holes.js` | `findByScorecard`, `upsert` (with optimistic concurrency — throws `VERSION_CONFLICT`) |
| `leaderboard-snapshots.js` | `findLatest`, `save` |
| `calcutta-auctions.js` | `findByTour`, `findByTourAndPlayer`, `create`, `update` |
| `novelty-events.js` | `findByTourRound`, `create`, `findResult`, `setResult` (upsert) |
| `itinerary-items.js` | `findByTour`, `create`, `update`, `remove` |

`scorecard-holes.upsert` throws `{ code: 'VERSION_CONFLICT', currentVersion }` when the stored version doesn't match `expectedVersion`. Routes should catch this and return 409.

## What's built vs pending

### Built ✅
- Postgres schema (3 migrations: consolidated baseline + 2 additive)
- Tenant middleware + `/:tenantSlug` router
- Auth flow (login codes, tenant membership check, Postgres session store)
- `requireAuth`, `requireRole`, `requireMinRole` middleware
- `bootstrap.js` — seeds `init` tenant + Phil (is_super_admin) as owner in dev (email: phil@kellsy.com)
- Repository layer (18 repositories)
- **Email templates** — HTML skin (`layout.js`) used for sign-in OTP and email-change OTP emails
- **Session logging** — all auth events (login_success, logout, code_invalid, no_membership) written to `session_logs`; cleanup job deletes rows older than 180 days on startup and every 24h
- **Super admin**: global login, tenant picker, create tenant, tours list, payment approval, system-wide session logs (`/session-logs` — filterable by tenant)
- **Admin routes** (`/:tenantSlug/admin`):
  - Tour CRUD (create/edit/activate/complete) — `/admin/tours/:tourId`
  - Round configuration (course, calc_type, status, tour_date, leaderboard publish, 2-ball, ambrose prizes) — `/admin/tours/:tourId/rounds/:roundNumber`
  - Round config has "Manage courses" link (opens new tab) next to each course dropdown
  - Tour setup (leaderboard rules, skins, prizes, calcutta) — `/admin/tours/:tourId/setup`
  - Player roster (add/edit handicap/remove)
  - Member management
  - Courses (create/edit/holes/import from API, duplicate tee set)
    - `supports_split_ratings`: when off, SI Secondary = Primary + 18 (computed); when on, all 36 SI values editable independently
    - Hole data locked (par, metres, SI) when scores exist — metadata (name, tee, ratings) always editable
    - Tour admins can edit courses not currently assigned to an open round
  - **Tee times**: manual groups, player assignment, generate (distribute/reverse leaderboard), round handicap overrides, round subnav
  - **Itinerary**: create/edit/delete items by type (golf, accommodation, transfer, meal, activity, note) — `/admin/tours/:tourId/itinerary`
- Services: `event-status`, `handicap` (strokesForHole + computeCourseHandicap), `stableford-leaderboard`, `group-generator`
- **Scoring routes** (`/:tenantSlug/scoring`):
  - Scorer index — shows scorecards for the logged-in player with computed course handicap
  - Live scorecard (`/scoring/live/:id`) — per-hole gross score entry, offline-capable PWA
    - Shot dots (•) show strokes received per hole based on WHS course handicap
    - Optimistic concurrency; conflict detection and resolution
    - Ambrose team scoring with drive selection
  - Confirm / confirm-final flows for score submission
  - `ensureRoundScorecards` creates individual (and team) scorecards when a round is opened
- `src/services/events/day-label.service.js` — `dayLabel(roundNumber)` returns `"Day N"`
- Player dashboard (`/:tenantSlug/`) — shows active tour, open round, scorecard links
- Leaderboard routes (`/:tenantSlug/leaderboards`) — stableford championship + day boards, eclectic, skins, ambrose; shows "not yet released" message when no boards published
- Test suite (56 unit tests passing)

### Planned (not yet started)

#### Itinerary — player-facing view
Admin management is built. A player-facing itinerary view (`/:tenantSlug/tours/:tourId/itinerary` or similar) accessible to all tour members is not yet built.

## Database schema

Live schema reference: [docs/schema.md](docs/schema.md) — full Mermaid ERD + plain-English table descriptions.

Refresh the SQL dump: `bash scripts/dump-schema.sh` → writes `docs/schema.sql`.

MCP Postgres server is configured in [.vscode/mcp.json](.vscode/mcp.json) for in-session DB queries.

## Test tenant

`TEST_TENANT_ID = 1` (defined in `src/config/constants.js`). This tenant sees **all courses system-wide** — the `tenant_id` filter is bypassed in course list queries, round-config dropdowns, and course edit/duplicate lookups. Delete remains strict: the test tenant can only delete courses it actually owns. Useful for replicating cross-tenant issues and testing with real course data from other tenants.

Key schema notes:
- `event_players` table is still named that in the DB (not renamed by original migration)
- `golf_rounds` id sequence is still named `event_day_statuses_id_seq` internally
- `tours` id sequence is still named `events_id_seq` internally
- `golf_rounds.female_course_id` is the women's tee set for mixed tours (nullable)
- `courses.gender` (`mens|womens|open`) filters round-config course dropdowns
- `courses.supports_split_ratings` (boolean, default false) — controls whether SI Secondary is editable or auto-computed
- `session_logs` — auth event log; 180-day retention enforced by server.js cleanup job

## Environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (dev default: `postgresql://localhost:5432/forescore_dev`) |
| `TEST_DATABASE_URL` | Postgres for integration tests (default: `forescore_test`) |
| `PORT` | HTTP port (default: `2080`) |
| `SESSION_SECRET` | express-session secret — must be strong random in production |
| `APP_BASE_URL` | Absolute base URL used in emails |
| `BREVO_API_KEY` | Brevo transactional email — omit to log codes to stdout in dev |
| `BREVO_SENDER_EMAIL` | Verified Brevo sender address |
| `BREVO_SENDER_NAME` | Display name (default: `ForeScore`) |
| `GOLF_COURSE_API_KEY` | External golf course data API (optional) |
| `NODE_ENV` | `development` \| `test` \| `production` |

## Coding conventions

- CommonJS (`require`/`module.exports`); no ESM, no TypeScript
- Knex for all DB access — raw SQL only when Knex cannot express it
- **Repository pattern**: all queries in `src/db/repositories/`; routes and services
  never import `knex` directly
- Repositories return plain objects (no ORM-style model instances)
- **Postgres inserts**: always use `.returning('*')` or `.returning('id')` —
  unlike SQLite, Postgres does not return the inserted ID without it
- Tenant safety: all tenant-scoped queries must filter by `tenant_id`; never
  trust a bare `tour_id` without verifying `tours.tenant_id = req.tenant.id`
- Migrations: Postgres-native only — no SQLite pragmas or table-rename workarounds
- `res.locals.tenantPath` is available in all views: `tenantPath('/admin/tours')` → `/legends/admin/tours`

## Testing

```bash
npm test                    # lint + unit + integration
npm run test:unit
npm run test:integration
npm run test:watch
```

- All tests use Postgres (`TEST_DATABASE_URL`) — no SQLite, no mocks
- `test/helpers/pg.js` provides `createTestDb()`, `seedTenantAndOwner()`, `seedEvent()`
- Integration tests require a running Postgres server
- Scoring integration tests are skipped (`test.skip`) until those routes are rebuilt
- **Tests must be kept current**: any new service function, business rule change, or migration
  must be accompanied by tests. Do not add features without covering them.

## Running locally

```bash
# Requires Postgres.app (or Homebrew postgres) running on :5432
createdb forescore_dev
createdb forescore_test
cp .env.example .env
npm install
npm run migrate             # knex migrate:latest
npm run dev                 # http://localhost:2080
# Super admin login: /auth/login → phil@kellsy.com
# Dev seed tenant: /init/admin
```

## Deployment: Railway

This app deploys to Railway. When working on deployment tasks:

1. The app and its PostgreSQL database are both hosted on Railway.
2. Services communicate over Railway's private network — use internal hostnames,
   not public URLs, for service-to-service calls.
3. The database is Railway-managed Postgres (usage-based billing). Do not suggest
   migrating to or adding any external database service.
4. Backups will ultimately run via the Railway postgres-s3-backups template to Cloudflare R2. They are not yet set up.
   Do not modify backup config without flagging it explicitly.

### Environment variables

Railway's Postgres plugin does **not** expose a pre-built `DATABASE_URL` that can be referenced from the app service — its internal `DATABASE_URL` is itself a nested template that Railway will not recursively resolve. Instead, the app is configured to build the database URL from individual PG variables.

**App service variables (set in Railway dashboard):**
| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `SESSION_SECRET` | strong random hex (generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) |
| `APP_BASE_URL` | `https://forescore-production.up.railway.app` |
| `PGHOST` | `${{Postgres.RAILWAY_PRIVATE_DOMAIN}}` |
| `PGUSER` | `${{Postgres.PGUSER}}` |
| `PGPASSWORD` | `${{Postgres.PGPASSWORD}}` |
| `PGDATABASE` | `${{Postgres.PGDATABASE}}` |
| `PGPORT` | `5432` |
| `BREVO_API_KEY` | from Brevo dashboard |
| `BREVO_SENDER_EMAIL` | verified Brevo sender |
| `BREVO_SENDER_NAME` | `ForeScore` |
| `GOLF_COURSE_API_KEY` | optional |

Do **not** set `DATABASE_URL` or `TEST_DATABASE_URL` in the Railway app service — the app builds the connection string from the PG* vars above. `TEST_DATABASE_URL` is only for local test runs.

The app builds `DATABASE_URL` at runtime in `src/config/env.js` and `knexfile.js` using:
```js
`postgresql://${PGUSER}:${encodeURIComponent(PGPASSWORD)}@${PGHOST}:${PGPORT}/${PGDATABASE}`
```

### Local development
- Use a `.env` file locally with `DATABASE_URL=postgresql://localhost:5432/forescore_dev`.
- Never run migrations against the production database from a local machine.

### Deploying
- Railway auto-deploys on push to `main`.
- Start command (in `railway.json`): `node scripts/check-db.js && npm run migrate && npm start`
- `scripts/check-db.js` validates the DB connection and exits cleanly before migrations run.
- Migrations run via `npm run migrate` before the server starts.

### First deployment status — **IN PROGRESS** (paused 2026-05-12)
The initial Railway deployment has not yet completed successfully. The last known state:
- ✅ DB connection works (`postgres.railway.internal` via PG* vars)
- ✅ `check-db.js` connects and exits cleanly (fix: added `process.exit(0)` — not yet verified in production)
- ⏳ Migrations have not yet been confirmed to run
- ⏳ Health check at `/health` has not yet passed
- ⏳ App has not yet started in production

**Next step when resuming:** push the latest code (including `process.exit(0)` fix in `scripts/check-db.js`) and verify the full deploy log shows migration output and server startup.

### Versioning and cache-busting
- App version lives in `package.json` (`version` field) — this is the single source of truth.
- `src/app.js` reads `package.json` at boot and uses it as `assetVersion` for CSS/JS/image cache-busting (`?v=1.0.0`).
- Semver convention: patch (`1.0.x`) for fixes/tweaks, minor (`1.x.0`) for new features, major (`x.0.0`) for breaking changes.
- **A deploy script is planned but not yet built.** When created, it must include a `package.json` version bump (via `npm version patch|minor|major`) before pushing to main, so every production deploy gets a fresh cache-bust string automatically.
