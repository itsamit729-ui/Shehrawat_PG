# Backend integration contract

All routes below are relative to `VITE_API_BASE_URL`, usually `/api/v1`. This document specifies the interface required by the frontend; it does not describe an already deployed backend.

## Common behaviour

- JSON success response is the payload itself; errors are `{ "message": "safe user-facing explanation" }` plus the correct HTTP status. 204 is supported.
- Use an HttpOnly, Secure session cookie; the frontend sends `credentials: include`. Never return database/provider secrets or session tokens for browser storage.
- `GET /auth/session` returns a Session (`src/domain.ts`) plus `csrfToken`. The frontend returns this token in `X-CSRF-Token` on later requests. Validate Origin and CSRF for mutations. Login/OTP endpoints also require Origin validation and abuse limits before a session exists.
- On 401, no private payload may be returned. 403 denies cross-user/corporate/property access. 409 signals a conflicting booking or stale edit. 422 is validation, 429 rate limits. Do not trust IDs/roles supplied by the browser.
- Mutations include a UUID `Idempotency-Key`. The backend must retain result and payload hash for the appropriate operation and protect against duplicate financial effects. Ambiguous provider results require reconciliation. The UI does not automatically retry mutations.
- The existing UI models express money as INR rupee values. Convert to integer paise at the server boundary; validate decimal precision. Database ledgers and provider amounts must use integer paise. Never rely on a browser-provided invoice/payment amount as authoritative.
- Date-only stay/billing fields are YYYY-MM-DD; timestamps are ISO 8601. Use Asia/Kolkata for business billing rules, and database UTC timestamps for expiry comparisons.

## Read endpoints

| Route | Response |
|---|---|
| GET `/properties` | `Property[]`, public listing fields only |
| GET `/auth/session` | `{id,name,role,residentId?,corporateId?,csrfToken}` or 401 |
| GET `/portal` | Authorized subset of `DataState` in `src/domain.ts`; never send an entire business snapshot to a resident/company |
| GET `/conversations` | Authorized `Conversation[]`; polled every five seconds only while the inbox is visible |
| GET `/beds` | Owner-scoped `Bed[]`; polled every fifteen seconds only while inventory is visible |
| GET `/payments/status?orderId=…` | `{status: "pending" | "processing" | "confirmed" | "failed" | "review"}`; must authorize the reference |

`/portal` must scope residents, invoices, tickets, agreements, requests and allocations to the current user. Do not send owner messages/settings/expenses to residents. Public property records are fetched separately. Arrays omitted from the snapshot render as empty.

## Identity

| Route | Body / result |
|---|---|
| POST `/auth/otp/request` | `{phone}` → `{challengeId}`; owner only, server throttles/resend/expiry/attempt limits |
| POST `/auth/login` | owner `{role,challengeId,otp}`, others `{role,email,password}` → `{user: Session,csrfToken}` plus cookie |
| POST `/auth/signup` | resident `{role,name,email,password}`, corporate adds `{companyName}` → 202 `{verificationRequired,message}`; same answer if the email is taken, and no session |
| POST `/auth/verify-email` | `{token}` → 204; single-use |
| POST `/auth/resend-verification` | `{email}`; same safe response whether account exists or not |
| POST `/auth/change-password` | resident or corporate `{currentPassword,password}` → `{user: Session,csrfToken}` plus new cookie; ends other sessions |
| GET `/auth/google/enabled` | `{enabled}` |
| GET `/auth/google/start` | redirects to Google, then back to `/resident/home` or `/login?google_error=existing\|failed` |
| POST `/auth/google/link` | resident → `{url}` to open, then back to `/resident/security?google_connected=1` |
| POST `/auth/logout` | revoke session, clear cookie |
| POST `/auth/recover` | `{email}`; same safe response whether account exists or not |
| POST `/auth/set-password` | `{token,password}`; single-use invitation/recovery token, expiry, server password policy |

## CRUD resources

The frontend sends POST `/{collection}` to create, PATCH `/{collection}/{id}` to edit. Validate allowlisted fields per role instead of mass-assigning arbitrary input.

| Collection | Allowed frontend purpose |
|---|---|
| `residents` | owner profile creation/editing; separate from bed allocation |
| `properties` | owner public text editing |
| `beds` | owner Available ↔ Blocked only when no conflicting occupancy/hold |
| `invoices` | owner invoice draft/posting with duplicate billing protection |
| `tickets` | residents create/edit their own request text; only owner/staff change assignment/status |
| `leads` | public enquiry submission with spam protection; only owner reads/edits leads |
| `campaigns` | owner drafts; server validates template, segment and schedule |
| `agreements` | owner prepares versioned template request; signing status comes from provider |
| `conversations` | owner human/bot assignment, never overwrite customer messages |
| `expenses` | owner validated expense entries, ledger-backed on server |

See exact field types in `domain.ts`. Do not allow generic mutation endpoints to expose any other table.

## Actions

| Route | Request / required behaviour |
|---|---|
| POST `/holds` | `{propertyId,sharing,moveIn}` → `{id,expiresAt,amount}`. Select an available bed under transaction/overlap lock, calculate binding quote; amount is rupees for UI |
| POST `/payment-orders` | `{holdId,name,phone,email,moveIn,occupation}` or `{invoiceId}` → `{checkoutUrl}`. Server calculates payable amount and returns HTTPS provider checkout |
| POST `/payments/manual` | `{invoiceId,amount,method,reference}`; owner only, validate outstanding amount, post auditable receipt |
| POST `/refunds` | `{paymentId,amount,reason}`; owner-only verified refund request, idempotent provider processing, no premature refunded status |
| POST `/messages/send` | `{conversationId,body}`; validate service window, human assignment, scope and quota; persist outbox |
| POST `/campaigns/schedule` | `{id}`; recheck template approval, opt-in, actual segment size, schedule and spend cap |
| POST `/settings` | allowlisted owner settings; not a secrets endpoint |
| POST `/agreements/{id}/link` | authorized expiring `{url}` for provider signing or private signed-copy download |
| POST `/referrals` | `{name,phone,note,residentId}`; verify referring account and permitted contact handling |
| POST `/move-outs` | `{date,reason,residentId}`; notice/cancellation policy and settlement stay server-owned |
| POST `/housing-requests` | `{corporateId,propertyId,beds,start,notes,employee?,email?}`; company-scoped request, not immediate reservation |
| POST `/uploads` | `{fileName,contentType,size,purpose}` → `{id,uploadUrl}`; issue short-lived authorized PUT URL |
| POST `/uploads/{id}/complete` | inspect/quarantine file, verify type/size/object ownership before allowing download |

`PUT uploadUrl` sends the selected file directly to private storage with Content-Type. The storage service must permit the final frontend Origin, PUT and Content-Type via CORS. The frontend accepts PDF/JPEG/PNG up to 5 MB; the server must independently enforce limits and scan/inspect content.

`settings.mealMenu` maps day numbers `0` (Sunday) through `6` to `{breakfast,lunch,dinner}` strings. Return only resident-safe settings in resident snapshots. Return owner refund request summaries in `requests` with `type: "refunds"`; provider confirmation determines their status. For future property-specific menus, add a property scope to this contract.

## Payment and provider boundaries

The payment provider must redirect to `/payment/status?order_id=…`. The frontend polls server verification; it never trusts browser success flags. Captured payment after hold expiry enters review; it must not displace another booking. Backend webhooks verify signatures, deduplicate, reconcile out-of-order events and write financial records atomically.

SMS delivery, WhatsApp bot execution, template approval, campaign dispatch, e-sign evidence, durable jobs, server-side pagination and backups are backend work. No client-side timer or role check substitutes for these. The frontend's preview endpoints and callbacks must never be used to post real ledger records.

## Production test cases

1. Correct Origin/credentials/CSRF on deployed frontend and backend domains.
2. Authenticated resident/company cannot retrieve or mutate another account's IDs.
3. Expired OTP/session/invitation and blocked/brute-force requests are rejected.
4. Concurrent requests for the same bed produce one allocation; expired holds free capacity.
5. Duplicate payment callbacks, retries and late captures cannot double-credit or steal a bed.
6. Opt-out or service-window expiry between draft and send prevents an unauthorized message.
7. Private file URLs expire and cannot be requested by another account.
