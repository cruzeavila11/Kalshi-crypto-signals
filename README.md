# Kalshi Crypto Signal Dashboard — iPad Edition

This is the first working UI package for the signal-only bot.

## Safety boundary

This project is deliberately **read-only**. It has no order-placement endpoint, no trading button, and no code that calls Kalshi's order-creation API.

The browser UI can eventually receive market data from a cloud relay. Keep Kalshi private credentials off the iPad/browser.

## What is included

- Mobile/iPad-friendly dashboard
- BTC / ETH / SOL signal cards
- Signal feed
- Signal-history area
- iPad notification permission button
- Cloud endpoint field
- Optional Node.js read-only relay for Kalshi public market data

## Important

The included dashboard uses demo values until a cloud service is connected. Do not treat demo signals as live trading signals.

## Cloud deployment

The optional `server.js` is designed for a Node.js hosting service. After deployment, point the dashboard's "Cloud data endpoint" at:

`https://YOUR-DOMAIN/api/markets`

A production version should add:
- real-time polling/WebSocket ingestion
- historical signal storage
- outcome resolution
- calibrated signal statistics
- alert throttling
- a stronger crypto-market classifier
- fee-aware expected-value calculations

Kalshi's public market-data API supports market and orderbook data. Authentication should be kept server-side if it is needed. See the current Kalshi API documentation before deployment.

## iPad

Once hosted over HTTPS, open the site in Safari and use Share → Add to Home Screen. Notification support depends on the browser/OS and the site being served securely.

## Single-owner authentication

The server now **fails closed** unless authentication is configured. Public market data at Kalshi does not make this dashboard public: every `/api/...` route, including `/api/health`, and the dashboard files require the owner's authenticated cookie. Public resources are limited to the login page/scripts/styles, service-worker retirement script, and `/live` (which returns only `{ "ok": true }`). Repository/server/test files are never served.

Required Render environment variables:

| Variable | Required value |
| --- | --- |
| `AUTH_USERNAME` | Owner's chosen login name, at most 128 characters |
| `AUTH_PASSWORD_HASH` | Salted Argon2id PHC-format hash; never a plaintext password |
| `AUTH_SESSION_SECRET` | Independently generated cryptographically random secret: at least 32 bytes encoded as unpadded base64url |
| `AUTH_SESSION_VERSION` | Non-secret session revision, 1–64 letters/digits/dots/underscores/hyphens; increment to revoke all sessions |
| `APP_ORIGIN` | Exact deployed HTTPS origin, without a trailing slash or path |
| `NODE_ENV` | `production` |

Configure these through Render's environment settings, never source files, frontend JavaScript, GitHub, screenshots, chat, or committed `.env` files. Do not use test credentials in production. This implementation does not supply or generate production credentials.

Generate the owner's password in a password manager. On a trusted local machine, use a vetted Argon2id tool to produce its salted hash without putting the plaintext password in shell arguments/history. Recommended parameters: memory 65,536 KiB, time cost 3, parallelism 1, salt at least 16 random bytes, hash length 32 bytes. The server accepts memory 19,456–131,072 KiB, time cost 2–6, parallelism 1–4, and a 32-byte hash. Store the plaintext only in the password manager and supply only the complete encoded hash to Render. Generate the session secret independently with a cryptographic generator and transfer it securely to Render. No literal example secrets are provided here.

Use Node.js 22 or later. Install dependencies with `npm ci`; start with `npm start`. No database or persistent disk is needed. For local development/test only, explicitly use `NODE_ENV=development` or `test` with a loopback `APP_ORIGIN`; the development cookie has a different name and omits `Secure`. Never use that mode for an externally reachable deployment.

### Sessions and safeguards

- The owner logs in at `/login`; logout is available on the dashboard.
- Argon2id verifies the password, including for an incorrect username. Both failures return `Invalid credentials`.
- Cookies are signed using maintained `jose` HS256 JWT verification with a fixed algorithm, owner subject, origin issuer/audience, issuance time, eight-hour absolute expiry, and session version. Payloads contain no credentials. Signing authenticates cookies; it does not encrypt their non-secret payload.
- Production cookies use `__Host-kalshi_session`, `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, no Domain, and an eight-hour maximum age.
- Unauthenticated navigation redirects to `/login`; APIs return `401` JSON before market handlers run.
- Exact `APP_ORIGIN` checking plus `SameSite=Strict` protects login/logout and future state-changing routes. Missing/null/cross-site origins are rejected; logout requires POST. Never add state-changing GET routes or permissive CORS.
- Login is limited globally to 20 attempts/minute and per client to five failed attempts/15 minutes before password hashing. At most two verifications run concurrently. Client buckets use the normalized transport-peer address (IPv6 /56 grouping), never forwarded headers. Behind a proxy, clients sharing that peer share the conservative five-failure limit. Limits are in memory and reset on restarts; the global limit remains a second layer.
- Express trusts no proxy by default. Optional `AUTH_TRUSTED_PROXY_CIDRS` is a comma-separated allowlist of verified immediate Render proxy IP addresses/CIDRs; only hop zero can be trusted. Verify the actual deployment topology before configuring it: do not guess Render ranges, use a hop-count rule, or permit all addresses. Arbitrary direct clients cannot enable trust with headers. Forwarded identity is never used for login buckets, even for trusted proxies. Production cookies remain Secure independently of proxy headers. Production is intended to be reachable only through Render HTTPS.
- Sessions survive restarts/spin-downs with unchanged settings. Changing `AUTH_SESSION_SECRET` or `AUTH_SESSION_VERSION` revokes all existing cookies. Rotate the secret/version when changing the password; replacing only the password hash does not revoke issued sessions.
- Logout expires the browser cookie. A copied cookie cannot be individually revoked without server-side state; it remains usable until expiry or global rotation. Offline logout cannot clear an HttpOnly cookie; the UI reports failure rather than claiming success.
- `/live` is available for a Render liveness check without exposing configuration. Authenticated `/api/health` continues to return `READ_ONLY` and `tradingEnabled: false`. No order or execution code is added.

### Browser migration and privacy

All application/auth/API responses are `no-store`. Login/logout additionally send `Clear-Site-Data: "cache"` where browsers support it, without the `"storage"` directive. The retirement worker and client cleanup remove Kalshi-named caches and unregister the origin's old root worker; no dashboard data is served offline. Logout and API `401` stop polling, blank the dashboard, and navigate to login. Supported browsers notify other open tabs through BroadcastChannel. Restored/visible pages recheck their session before revealing content.

Close old dashboard tabs and reopen/reload the installed home-screen app when this change is eventually deployed. Previously downloaded files, screenshots, or old tabs running old JavaScript cannot be remotely erased. Test the back button, multiple tabs, and installed Safari home-screen app before treating browser migration as verified on the owner's device.

Logout deliberately preserves browser-local signal history, benchmark metadata, positions, and alert preferences. Those records are not encrypted by server authentication and remain accessible to someone with access to the browser profile. Use a private device/profile; export valuable history before manually clearing site data.

Run `node --test tests/*.test.cjs` for all regressions. Authentication tests generate ephemeral test credentials in memory only and verify access control, cookie flags/claims, expiry/tampering, revocation/restarts, logout, throttling, origin rejection, static-file denial, client lifecycle/cache cleanup, fail-closed startup, and unchanged READ_ONLY health. They do not change Render settings or verify Render's live proxy topology.
