# Sehrawat PG backend

A TypeScript API on Fastify and Aiven MySQL, deployed separately from the React frontend. It implements the frontend's [API contract](../frontend/API_CONTRACT.md) and follows the implementation blueprint, with the changes listed below.

## Status

| Blueprint stage | State |
|---|---|
| 1. Schema, identity, deployment | Built: owner OTP, password login, sessions, CSRF, invitations, recovery, audit log, job queue. Not deployed. |
| 2. Inventory, holds, booking | Partly built: properties, beds, 15-minute holds, resident profiles. Holds can't yet become confirmed bookings, because that needs payments. |
| 3. Invoices, payments, reconciliation | Not started |
| 4. Portals and complaints | Not started, apart from a scoped `/portal` with beds and residents |
| 5. WhatsApp, bot, campaigns | Not started |
| 6. Signing, dashboards, performance, recovery testing | Not started |

Routes in the contract that aren't built return 404.

**Not yet verified against MySQL.** The code compiles and the unit tests pass, but the 58 database tests, the migrations and all the SQL have never run on a real server. Treat "built" above as unproven until they pass.

## Changes from the blueprint

| Blueprint | Built | Consequence |
|---|---|---|
| One Next.js service for website and API | Separate API service, as the frontend already expects | Two Render services. Cross-site cookies need planning, see below. |
| Aiven PostgreSQL | Aiven MySQL 8 | See below |
| Exclusion constraint prevents overlapping stays | The blueprint's fallback: every allocation locks its bed rows first | The database itself won't reject an overlap, so all writes to `bed_allocations` must go through `modules/inventory/allocations.ts`. |
| `POST /holds` takes bed IDs | Takes property, room type and date, per the frontend contract; the server picks the bed | Corporate multi-bed holds will need a separate entry point in stage 4. |
| Staff accounts with property assignments | Not yet | Needs a new role on the frontend too. |

MySQL details that matter when changing this code:

- **Allocation transactions run at READ COMMITTED.** At MySQL's default level, a plain `SELECT` after a lock can read a stale snapshot and miss a competing allocation. Use `lockingTransaction` for anything touching allocations.
- **Every connection pins `sql_mode` and UTC.** Aiven's default mode includes `ANSI`, which changes how quotes parse.
- **Every table needs a primary key.** Aiven enforces `sql_require_primary_key`.
- **DDL isn't transactional.** A migration that fails halfway has to be finished by hand, so keep them small and expand-only.

## Run locally

Requires Node 22 or newer and a MySQL 8 server.

```sh
cd backend
npm ci
cp .env.example .env        # then set DATABASE_URL and AUTH_SECRET
npm run migrate
npm run seed:dev            # sample properties and 500 beds; refused in production
npm run create-owner -- --phone 98XXXXXXXX --name "Owner name"
npm run dev
```

Point the frontend at it with `VITE_DEMO_MODE=false` and `VITE_API_BASE_URL=http://localhost:4000/api/v1`. OTP codes and password links print in the backend's terminal when using the `dev` providers.

## Tests

```sh
TEST_DATABASE_URL=mysql://root:password@127.0.0.1:3306/sehrawat_test npm test
```

**This database gets wiped, so never point it at real data.** Without `TEST_DATABASE_URL`, only the unit tests run and the database suites are reported as skipped. CI runs everything against MySQL 8.4.

## Deploy

`backend/render.yaml` is a separate Blueprint, so the frontend's deployment isn't affected. Before the service can start in production:

1. Create the Aiven MySQL service, then set `DATABASE_URL` to its Service URI and `DB_CA_CERT` to the project CA certificate.
2. Run `npm run migrate` and `npm run create-owner` once from a trusted machine with those settings. The server refuses to start until the business row exists.
3. Implement real SMS and email adapters in `src/providers`. **Production refuses to start until this is done**, because the `dev` providers print codes and links.
4. Use `app.YOUR-DOMAIN` and `api.YOUR-DOMAIN`, with `COOKIE_DOMAIN=.YOUR-DOMAIN`. Separate `onrender.com` hostnames count as cross-site, and browsers may block the login cookie.
5. Set `TRUST_PROXY_HOPS` to the real number of proxies and confirm logged client IPs are correct. If it's wrong, every visitor can share one IP's rate limit.

## Authentication

Built in-house, using no third-party auth service.

| Concern | Behaviour |
|---|---|
| Owner sign-in | 6-digit SMS code, 5-minute expiry, 5 attempts, one send per 60 seconds, daily limits per phone and IP. Stored as a keyed hash. A new code cancels the old one. |
| Resident and corporate sign-in | Invitation link, then a password of 12+ characters hashed with Argon2id. |
| Sessions | Random token in an HttpOnly cookie; only its hash is stored. Owners: 30 minutes idle, 12 hours absolute. Others: 24 hours idle, 7 days absolute. Rotated on login, revoked on logout and password reset. |
| Cross-site protection | Exact Origin allowlist on every mutation, plus a CSRF token derived from the session. |
| Enumeration | Unknown phones and emails get the same answers as known ones, and no SMS or email is sent. |
| Rate limits | Stored in MySQL, so restarts don't reset them. |
| Authorization | Checked per route on the server. Business and record scope come from the session, never the request. |

Fresh-OTP checks for sensitive owner actions arrive with the first such action (refunds, stage 3). Owner phone recovery is the blueprint's manual process, and its steps still need agreeing.

## Decisions to confirm

These are placeholders chosen to keep building. All are one-line changes:

- **Amount due on a hold:** one month's rent. The blueprint leaves deposit and proration rules open.
- **Booking window:** up to 180 days ahead.
- **Public hold limit:** 10 per hour per IP.
- **Resident and corporate session lengths:** 24 hours idle, 7 days absolute.
- **Phone numbers:** Indian mobile numbers only.

## Structure

```text
migrations/          ordered SQL files, applied once and checksummed
seed/                sample listings for local and staging use
src/
  server.ts          process entry: web server and job runner
  app.ts             plugins, error handling, route registration
  config.ts          validated environment, with production safety checks
  http/              request pipeline (origin, session, CSRF) and errors
  db/                connection, types, migrator, transaction helpers
  modules/identity/  OTP, passwords, sessions, invitations
  modules/inventory/ properties, beds, and holds (allocations.ts owns the locking)
  modules/people/    resident profiles and /portal
  jobs/              database-backed queue and housekeeping
  providers/         SMS and email adapters
  shared/            money, dates, audit, rate limits, idempotency
```
