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

**Verified on MySQL 8.4 in CI, not yet on Aiven.** All tests and migrations pass against a stock MySQL server in GitHub Actions. Aiven's TLS and default settings, and the app running on Render, are still untested.

## Changes from the blueprint

| Blueprint | Built | Consequence |
|---|---|---|
| One Next.js service for website and API | Separate API service, as the frontend already expects | Two Render services. Cross-site cookies need planning, see below. |
| Aiven PostgreSQL | Aiven MySQL 8 | See below |
| Exclusion constraint prevents overlapping stays | The blueprint's fallback: every allocation locks its bed rows first | The database itself won't reject an overlap, so all writes to `bed_allocations` must go through `modules/inventory/allocations.ts`. |
| `POST /holds` takes bed IDs | Takes property, room type and date, per the frontend contract; the server picks the bed | Corporate multi-bed holds will need a separate entry point in stage 4. |
| Staff accounts with property assignments | Not yet | Needs a new role on the frontend too. |
| Resident and corporate accounts by invitation only | Self-service signup and Google sign-in as well | See Authentication. |

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
npm run create-owner -- --name "Owner name"     # prints the owner password once
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
3. Set `SMS_PROVIDER` and `MAIL_PROVIDER`. Until real adapters exist in `src/providers`, the only value production accepts is `log`, which sends nothing and prints codes and links to the service logs. **Anyone who can read those logs can sign in as anyone, so don't use it for real customers.** Production refuses `dev`.
4. Use `app.YOUR-DOMAIN` and `api.YOUR-DOMAIN`, with `COOKIE_DOMAIN=.YOUR-DOMAIN`. Separate `onrender.com` hostnames count as cross-site, and browsers may block the login cookie.
5. Set `TRUST_PROXY_HOPS` to the real number of proxies and confirm logged client IPs are correct. If it's wrong, every visitor can share one IP's rate limit.

## Authentication

Built in-house, using no third-party auth service.

| Concern | Behaviour |
|---|---|
| Owner sign-in, stopgap | With `OWNER_LOGIN=password`, a generated password with no phone or email. Move back to SMS by setting `otp` here and `VITE_OWNER_LOGIN=otp` on the frontend. |
| Owner sign-in | 6-digit SMS code, 5-minute expiry, 5 attempts, one send per 60 seconds, daily limits per phone and IP. Stored as a keyed hash. A new code cancels the old one. |
| Resident and corporate sign-in | Password of 12+ characters hashed with Argon2id, set through an invitation link or at signup. |
| Self-service signup | Name, email and password, plus a company name for corporate accounts. The answer is the same whether or not the email is taken, and it doesn't sign the person in. A new account sees no records, and a new company is only what the person typed, with no residents linked to it. |
| Email verification | With `REQUIRE_EMAIL_VERIFICATION` on, the default, sign-in waits for a 30-minute link from `/verify-email`. Only an explicit `false` turns it off. Accepting an invitation or recovery link also proves the email. |
| Adding a resident who already signed up | A proven email keeps its account and sessions. For an unproven one, the password, sessions and Google link all end, and only the invitation gets back in, so nobody can sign up early with someone else's email and later see their records. |
| Google sign-in | Residents only, because a company account needs a company name. Off until `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `API_URL` are set. A matching email never signs in to an existing account: that person connects Google from Security after signing in. |
| Changing a password | Residents and companies, from Security. Needs the current password, and ends every other session. |
| Email delivery | `MAIL_PROVIDER=brevo` or `resend`, with its API key and `MAIL_FROM`. |
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
