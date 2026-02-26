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

Magic links are logged to server stdout in development (`[magic-link] ...`).

## Notes
- Session cookie duration is 30 days (`rolling: true`), until logout.
- Database schema is bootstrapped at runtime by `src/bootstrap.js`.
