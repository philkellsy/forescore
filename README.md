# Legends Scoring PWA

Node.js monolith for the Legends annual golf trip at Bonville International Golf Resort.

## Stack
- Express 4 + EJS + Bootstrap 5
- SQLite + Knex
- Session auth (`express-session`, `connect-sqlite3`)
- Passwordless magic-link auth
- PWA manifest + service worker

## Local Run
1. Copy env:
   - `cp .env.example .env`
2. Install deps:
   - `npm install`
3. Start on port `5050`:
   - `npm run dev`
4. Open:
   - `http://localhost:5050/auth/login`

## Test Scripts
- `npm test` (unit + integration)
- `npm run test:unit`
- `npm run test:integration`
- `npm run test:watch`

Detailed test strategy: `TESTING.md`.

## Security / Dependency Scripts
- `npm run audit` (online npm advisory check)
- `npm run audit:offline` (offline local check)
- `npm run audit:fix` (apply non-breaking audit fixes)
- `npm run deps:update` (update within semver ranges)

## Seeded Admin
- Name: Phil Kells
- Email: phil@kellsy.com
- Phone: 0404878210

## Magic Link Email (Brevo)
Set these environment variables:
- `APP_BASE_URL` (for verify links; use your Fly domain in production)
- `BREVO_API_KEY`
- `BREVO_SENDER_EMAIL` (must be verified in Brevo)
- `BREVO_SENDER_NAME` (optional; default `Legends Golf`)

If Brevo vars are missing, magic links are logged to server stdout in development (`[magic-link] ...`).
If Brevo send fails, the login page still returns the generic success message and the error is logged server-side.

### Fly.io secrets
Example commands:
- `fly secrets set APP_BASE_URL=https://<your-app>.fly.dev`
- `fly secrets set BREVO_API_KEY=<your_brevo_api_key>`
- `fly secrets set BREVO_SENDER_EMAIL=<verified_sender_email>`
- `fly secrets set BREVO_SENDER_NAME=\"Legends Golf\"`

## Fly.io Deployment (New App)
For a fresh Fly app deployment:

1. Login:
- `flyctl auth login`

2. Create a new app and volume:
- `scripts/fly-new-app-setup.sh <app-name> syd legends_data 1`

3. Set required secrets:
- `flyctl secrets set SESSION_SECRET=\"<strong-random-secret>\" --app <app-name>`
- `flyctl secrets set APP_BASE_URL=\"https://<app-name>.fly.dev\" --app <app-name>`
- `flyctl secrets set BREVO_API_KEY=\"<brevo-api-key>\" --app <app-name>`
- `flyctl secrets set BREVO_SENDER_EMAIL=\"<verified-sender-email>\" --app <app-name>`
- `flyctl secrets set BREVO_SENDER_NAME=\"Legends Golf\" --app <app-name>`

4. Deploy:
- `flyctl deploy --app <app-name>`

5. Smoke check:
- `flyctl status --app <app-name>`
- `flyctl open --app <app-name>`

## Notes
- Session cookie duration is 30 days (`rolling: true`), until logout.
- Database schema is bootstrapped at runtime by `src/bootstrap.js`.
