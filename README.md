# ForeScore

Multi-tenant SaaS platform for managing golf tours — scoring, leaderboards, calcutta auctions, skins, tee times, and itinerary.

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js ≥ 20 |
| Framework | Express 4 + EJS + Bootstrap 5 |
| Database | PostgreSQL via Knex 3 |
| Auth | Passwordless 6-digit one-time codes (emailed via Brevo) |
| Sessions | connect-pg-simple (Postgres-backed) |
| Hosting | Railway |

## Local Development

**Prerequisites:** PostgreSQL running on `:5432`

```bash
createdb forescore_dev
createdb forescore_test
cp .env.example .env
npm install
npm run migrate
npm run dev        # http://localhost:2080
```

Super admin login: `http://localhost:2080/auth/login` → `phil@kellsy.com`

Dev tenant: `http://localhost:2080/init/admin`

If Brevo vars are absent, login codes are printed to stdout: `[login-code] ...`

## Scripts

```bash
npm run dev              # nodemon dev server
npm run migrate          # run pending migrations
npm run migrate:make     # create a new migration file
npm test                 # lint + unit + integration
npm run test:unit
npm run test:integration
npm run test:watch
npm run audit            # npm advisory check
npm run audit:fix        # apply non-breaking audit fixes
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | Postgres connection string |
| `SESSION_SECRET` | Yes | Strong random string for session signing |
| `NODE_ENV` | Yes | `development` / `test` / `production` |
| `APP_BASE_URL` | Yes | Absolute base URL used in emails |
| `BREVO_API_KEY` | Prod | Brevo transactional email API key |
| `BREVO_SENDER_EMAIL` | Prod | Verified Brevo sender address |
| `BREVO_SENDER_NAME` | No | Display name (default: `ForeScore`) |
| `GOLF_COURSE_API_KEY` | No | External course data API (course importer) |
| `PORT` | No | HTTP port (default: `2080`; Railway injects automatically) |
| `TEST_DATABASE_URL` | Test | Postgres DB for integration tests |

Generate a strong session secret:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Railway Deployment

Railway auto-deploys on push to `main`. Each deploy runs `npm run migrate && npm start` — migrations run before the server accepts traffic.

**Initial setup:**
1. Create a Railway project and connect this repo
2. Add a **PostgreSQL** service — `DATABASE_URL` is injected automatically
3. Set environment variables in the Railway dashboard:
   - `NODE_ENV=production`
   - `SESSION_SECRET=<generated above>`
   - `APP_BASE_URL=https://<your-service>.railway.app`
   - `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`, `BREVO_SENDER_NAME`

Health check: `GET /health` → `{ ok: true }`

## Versioning

Version lives in `package.json`. It is used as the asset cache-bust string in production (`?v=1.0.0`). Use semver:

```bash
npm version patch   # bug fixes
npm version minor   # new features
npm version major   # breaking changes
```

Bump the version before pushing a production release.
