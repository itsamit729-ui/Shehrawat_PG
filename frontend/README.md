# Sehrawat PG frontend

React + TypeScript + Vite. This is a standalone frontend for a separate backend on Render. Original HTML prototypes and images remain at the repository root.

## Run locally

Requires Node 24 and npm.

```sh
cd frontend
npm ci
cp .env.example .env.local
npm run dev
```

`VITE_DEMO_MODE=true` explicitly enables fictional records, owner/resident/corporate preview logins and in-memory interactions. Data resets on reload. No SMS, WhatsApp message, payment, e-sign request or document upload is performed in this mode. Do not enter real personal data in a preview.

Live mode is the default if `VITE_DEMO_MODE` is unset. Set it to `false` and set `VITE_API_BASE_URL` when the backend implements [API_CONTRACT.md](./API_CONTRACT.md). The app does not silently fall back to sample records after an API failure.

## Render deployment

Import the repository's `render.yaml` as a Blueprint, or create a **Static Site** with:

| Setting | Value |
|---|---|
| Root directory | `frontend` |
| Build command | `npm ci && npm run build` |
| Publish directory | `dist` |
| Node version | `24` |
| Rewrite | `/*` → `/index.html` |
| Review mode | `VITE_DEMO_MODE=true` |
| Live mode | `VITE_DEMO_MODE=false` |
| API base | `VITE_API_BASE_URL=https://YOUR-BACKEND/api/v1` |

The Blueprint starts in review mode deliberately. Change the mode and rebuild before production. Vite variables are public build-time settings. Never put DB credentials, signing secrets, SMS credentials or Meta tokens in them.

Deploy the backend independently as a Render web service. It must enforce permissions, own the database and provider secrets, process webhooks, lock beds and reconcile payments. Do not put API implementation inside this static site. No Render resources have been created by this frontend change.

Use `app.YOUR-DOMAIN` and `api.YOUR-DOMAIN` on the same registrable domain for production cookie sessions. Different `onrender.com` sites may be treated as cross-site: browser third-party cookie restrictions can prevent login even with SameSite=None. Test the real deployment domains. Configure exact frontend Origin allowlisting, credentials=true and OPTIONS handling on the backend. Never combine credentialed CORS with `*`.

## Screens

- Public: home, filtered properties, property detail/gallery, booking, corporate housing, property partnership, about, safety and terms.
- Accounts: owner OTP entry, resident/company login, recovery, password setup, payment-status verification.
- Owner: overview, residents, beds, invoices/receipts, resident insights, visits/leads, complaints, shared inbox, campaigns, automation, agreements, financial reports, property editing and settings.
- Resident: home, bills, complaints, food menu, documents/upload, referral and move-out.
- Corporate: overview, employee allocations, invoices, housing requests and agreements.

Preview fixtures represent 500 beds across six homes and a smaller fictional resident sample. Occupancy totals describe the bed fixture; financial totals describe the included invoice sample and are not an actual business forecast.

## Implemented frontend interactions

Search/filter/sort properties; gallery browsing; validated multi-step booking; server-expiring hold countdown; searchable/sortable/paginated tables; CSV export with formula escaping; resident forms; vacant-bed maintenance blocking; partial manual receipt validation; complaint forms/status editing; lead editing; bot-to-human inbox handoff and replies; campaign draft/scheduling; automation toggles; agreement links; expense forms/month filters; property text editing; company housing requests; referrals/move-outs; upload type/size validation.

All live interactions require the corresponding backend endpoints. UI route guards are convenience only, never an authorization boundary. The backend must independently check user, role, company, property and record scope.

## Structure

```text
src/
  public.tsx       public site, booking and login
  components.tsx   reusable navigation, tables, forms and dialogs
  owner.tsx        resident, inventory, billing and support screens
  operations.tsx  messaging, campaigns, signing and reporting
  portals.tsx      resident and corporate views
  account.tsx      recovery setup, payment result and uploads
  state.tsx        explicit preview/live adapters and scoped app state
  api.ts          credentialed HTTP, CSRF, timeout and error handling
  domain.ts       shared models, filters, receipt and export rules
  seed.ts         fictional preview fixture
  styles.css      shared responsive design system
  test/           business rules and interaction tests
```

Portal code is lazy-loaded. Static assets are versioned by Vite; listings lazy-load images, while the hero has fetch priority. Routes share components and CSS. The current scoped `/portal` snapshot is adequate for this initial 500-bed scope; large message histories and growing resident records should move to server pagination/cursor endpoints before increasing retention or capacity. Live inbox refresh, signed upload storage, template approval, balance truth and real-time locks depend on the backend.

## Check before launch

```sh
npm test
npm run build
```

Validate desktop and mobile layouts in a real browser; the current authoring environment's managed browser-preview daemon was unavailable. Automated DOM tests do not prove visual layout. Test login cookies on the final frontend/backend domains, error/expired-session handling, concurrent holds, provider payment return/webhook handling, opt-out suppression, authorized document access and real e-sign links.

The client must supply approved property details/pricing, legal policies, contact details, meal menus and provider accounts before live use. Existing prototype addresses, descriptions and imagery remain review content. No secure backend, database migration, provider approval or production deployment is claimed by this frontend commit.
