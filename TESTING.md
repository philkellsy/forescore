# Testing Plan

## Goals
- Catch scoring regressions early (Stableford, handicaps, comp aggregations).
- Keep auth/session behavior safe (magic-link and 30-day cookie policy).
- Validate core routes for player/admin flows.

## Test Layers
1. Unit tests (`test/unit`)
- Pure scoring math: handicap allocation, Stableford conversion.
- Draw/grouping helpers.
- Permission guards.

2. Integration tests (`test/integration`)
- Express route behavior (`/health`, auth entry points, role redirects).
- DB-backed scoring write paths and leaderboard calculations using a temp SQLite DB.

3. End-to-end tests (next phase)
- Mobile player score entry flows.
- Admin setup flows (event/year, players, tee groups).
- Real-time leaderboard refresh checks.

## Scripts
- `npm test`: runs unit + integration suites.
- `npm run test:unit`: fast pure-function tests.
- `npm run test:integration`: route/service integration checks.
- `npm run test:watch`: local TDD watch mode.

## Coverage Priorities
1. Stableford and per-hole handicap stroke logic.
2. Day 2 Calcutta draw-order constraints (including prior winner in group 1).
3. Sultans "best 3 of 4" hole rollups.
4. Auth token expiry, single-use enforcement, and logout invalidation.
5. Player-scoped score entry permissions by tee group.
