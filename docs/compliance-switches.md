# Wayside Station compliance switches

All new gates and moderation UI are dormant by default. Deploy this branch once;
then the owner can change environment variables and restart the Railway API or
apply Vercel environment changes without editing code. Vercel applies environment
changes to a new deployment of the **same code**; its Routing Middleware cannot
read Railway variables. Keep the geo allowlist/token in sync on both services.
The public `GET /config/features` response is cached for 60 seconds, and the
client refreshes it every minute. Secrets (service keys, license keys, bypass
tokens) are never returned. No `VITE_` build-time switches are needed.

| Feature | Env var or setting | Where to set it | What turns on |
| --- | --- | --- | --- |
| Website geo allowlist | `GEO_ALLOWED_COUNTRIES=US` or `US,CA` | Vercel → project → Settings → Environment Variables (production and any desired previews) | Root Vite Routing Middleware returns a small 451 station notice outside the two-letter ISO country allowlist. Empty/unset/invalid lists allow everyone; unknown country allows. `/assets`, `/privacy`, `/terms`, robots and favicons remain available. |
| API geo allowlist | `GEO_ALLOWED_COUNTRIES=US` or `US,CA` | Railway → API service → Variables | Fastify blocks outside countries only when the GeoLite2 database has loaded. Unknown IP/country and failed lookups allow. `/health`, `/healthz`, `/config/features`, account export/delete and CORS preflight are exempt. `geoBlock` in the features response means this API gate is enforcing; `geoAllowedCountries` names the configured policy for the papers, including the website policy. |
| GeoLite2 download | `MAXMIND_LICENSE_KEY` | Railway → API service → Variables | Downloads GeoLite2-Country at startup when the API allowlist is configured. A usable cached database survives download failures; without a database the gate fails open with a warning. Obtain a MaxMind account/license and accept its database terms. |
| MaxMind account authentication | `MAXMIND_ACCOUNT_ID` | Railway → API service → Variables | Uses account ID plus license key for HTTP Basic download authentication. Older license-only accounts can omit the ID. The API's network must allow `download.maxmind.com` and its download redirects. |
| Geo database cache | `GEO_DATABASE_CACHE_DIR` (optional) | Railway → API service → Variables; optionally mount a volume at that directory | Defaults to `server/.cache/geolite2` when starting in `server/`. Checks daily and refreshes once the database is a week old. A mounted volume preserves the cache across deployments. No database or license is committed. |
| Geo owner bypass | `GEO_BYPASS_TOKEN` (long random secret) | **Both** Vercel and Railway → Environment Variables / Variables | Visiting `https://waysidestation.com/?geo_bypass=<URL-encoded-token>` sets the secure, HttpOnly, same-site `ws_geo_bypass` cookie for seven days and removes the token from the URL before redirecting to the station. On API requests use `X-WS-Geo-Bypass: <token>`. The website cookie is not sent to the Railway domain; the API header is a separate bypass, useful for owner tooling. Rotating/unsetting the secret revokes old bypasses. |
| Age gate | `AGE_GATE_MIN_AGE=13` (integer 13–120) | Railway → API service → Variables | Required Kiosk signup checkbox and Terms minimum-age line. Signed-in riders without `users.age_confirmed_at` get a one-time paper prompt. Explicit confirmation records server time; immediate-session signups record it after account creation. Email-confirmed signups confirm after their first sign-in. Until confirmed, server blocks posts/reactions, lounge entry/chat, Monster Bash chat, photo uploads, listings and private messages. Export/delete/read access remains available. Unset/empty/invalid values turn the gate off. No birthday is collected. |
| Terms acceptance | **Both** `TERMS_VERSION=2026-10-01` (opaque version string) **and** `LEGAL_CONTACT_EMAIL` (nonempty, finalized legal contact) | Railway → API service → Variables; staging only until reviewed | `termsAcceptance` and `termsVersion` in `/config/features`. Existing signed-in riders see “We've added house rules,” with both papers, I agree, and Read later (this tab/session only). Posting/reactions, chat, uploads, listings and private messages require the current version; browsing, playing, export and deletion stay available. With either variable unset/blank there is no notice, acceptance query or added write restriction. Changing the version re-prompts even previously accepted riders. If age confirmation is also needed, it is folded into the same notice and saved with acceptance. New Kiosk signups explicitly agree there; their signup intent survives email confirmation, and an authenticated POST saves it before displaying any notice. Signup intent is never reused after a version change or an earlier saved acceptance. |
| Report and block | `REPORTS_ENABLED=true` (exact value; default false) | Railway → API service → Variables | Report slips on Wayside Online posts, lounge/Monster Bash chat, PictoBox photos and counter marketplace listings; block controls and Settings unblock list; report queue in the existing Scareathon admin panel. Backend routes return 404 while off. Blocks hide posts, chat and photos, and stop new/existing private messages in either direction. Admin removal can restrict further sharing; restrictions enforce only while this switch is on. |
| Moderation admins | Existing `ADMIN_USER_IDS` / `ADMIN_EMAILS` allowlists | Railway → API service → Variables | Existing Scareathon admins can view/dismiss reports or remove content, optionally restricting the author. Agent keys never acquire admin rights. These are existing admin settings, not a new grant. |
| Legal contact / takedowns | `LEGAL_CONTACT_EMAIL` | Railway → API service → Variables | Contact links and DMCA/takedown section in both station papers; removes DRAFT banner. While unset, contact lines and takedown section are absent and DRAFT remains. Owner must review the papers before finalizing. |
| Legal owner | `LEGAL_OWNER_NAME` | Railway → API service → Variables | Adds the owner name to Privacy and Terms. Unset omits the name. |
| Account deletion | `SUPABASE_SERVICE_ROLE_KEY` or existing `SUPABASE_SERVICE_KEY` | Railway → API service → Variables; obtain the server-only key from Supabase → project API settings | `accountDeletion=true` and the existing Close-your-account controls become available. Without either key, Settings says “Coming soon” and the deletion route exits before any database erasure. Never expose this key to Vercel client bundles. Existing account export also needs the service key to obtain the authoritative auth email. |
| Email changes | `EMAIL_CHANGE_ENABLED=false` to disable (otherwise on) | Railway → API service → Variables | Removes the email-change form and shows “Coming soon” when false. Otherwise retains the existing secure confirmation flow. This is a UI feature switch; Supabase enforces account email changes. |
| Secure email change | Enable **Secure email change** | Supabase → Authentication → email provider settings | Supabase requires confirmations sent to both current and new email addresses. Set this before enabling email changes; check the station redirect URL is allowed. |
| Server rate limits | Always on; no switch | Installed in Railway API code | `@fastify/rate-limit`: report submissions 20/hour, export and deletion 10/hour each, and account/sign-in-adjacent/agent-key/chat/ticket routes 120/minute per client IP, before JWT verification (including failed auth attempts). HTTP 429 includes retry information. Supabase owns actual sign-in, signup and reset-email endpoints and their own limits. |
| Legal baseline | Always on; no switch | Station Privacy / Terms papers | Terms say coins have no real-money value and cannot be bought or cashed out. Both papers name Supabase (auth/storage), Railway (API) and Vercel (hosting). Regions line appears when an allowlist is configured. |

The idempotent `server/db/migrations/20261014_compliance.sql` runs on API startup,
after the existing account migration, before traffic is accepted. It always builds
`content_reports`, `user_blocks` and user confirmation/restriction columns. New
moderation tables have RLS enabled without client policies; the API DB role owns
writes. Supabase clients cannot alter API-managed compliance fields. Live chat
normally stays in memory; while reporting is on, a bounded cache retains recent
server-authored report targets (across neither restarts nor API replicas). Reports
save a review snapshot so moderators can act after the chat disappears. Report
submission should reach the same API instance as that chat; use a single API
replica for the existing in-memory lounge/Monster Bash rooms.

`20261015_terms_acceptance.sql` runs immediately after the compliance migration at
startup. It adds `users.terms_accepted_at` and `users.terms_version_accepted` and
extends the Supabase profile-write guard. `GET /user/terms-acceptance` is private,
uncached, and returns the current version, whether acceptance is required, the
saved timestamp/version and whether age confirmation is needed. The authenticated
`POST /user/terms-acceptance` accepts `{ accepted: true, version, ageConfirmed }`,
checks the current version, uses server time, and shares the account routes'
120/minute IP rate limit. A stale version returns 409. The acceptance record is
included in account exports and cleared on account deletion.

For review, run `VITE_PREVIEW=1 npm run dev` and open `/?preview=terms` or
`/?preview=terms-age` (also available on `/station`). These render the exact notice
with mock state and no auth/API requests. The hook is available only in Vite dev
or builds made with `VITE_PREVIEW=1`; regular production builds ignore it. It
does not activate the Railway switch. Screenshots belong on the separate review
branch, never in the feature branch or `public/`.

Regression checks: `npx tsc -b`, `npm run lint`, `npm test -- --runInBand`.
With Vite running, `node scripts/check-station-terms-browser.mjs` checks the live
notice/Kiosk components against mock API responses and captures the four previews
to `work/review-shots/` (gitignored). It uses `playwright`, or the module specified
by `TERMS_PLAYWRIGHT_MODULE`; `TERMS_BASE_URL` and `TERMS_SHOTS_DIR` override the
server URL and scratch capture folder. For mocked signup checks, Vite still needs
test-only `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` placeholders; the preview
entry itself needs neither and never imports auth/API modules.

Account exports include the rider's reports and blocks. Account deletion clears
blocks, reports they filed, and authored-content snapshots attached to other
reports. Listing removal cancels the listing and returns its item to the seller;
post removal keeps reply structure, photo removal deletes the picture, chat
removal clears the live message and its reconnect history.

Suggested activation check: leave switches unset and compare the station; enable
one feature at a time, wait up to 60 seconds for config refresh, verify with a
non-admin rider, then exercise the owner/admin controls. For geo, test a known
outside IP, an unknown location, the owner bypass, legal papers and account
export/delete. Railway trusts only its immediate forwarding proxy for client IP.
