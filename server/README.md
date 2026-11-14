# EmbroideryLabs API

Accounts, plans and saved designs for the editor. It is **off** until you set it up: while
`apiBase` in `js/config.js` is `null`, the site works exactly as before (every export is made in the
browser and is free), and nothing in this folder is used. This folder is not part of the static site
(`.vercelignore` and `.dockerignore` leave it out).

What it does when it is on:

| | Free | Hobby | Pro |
|---|---|---|---|
| Drawing, stitch preview, mockups | yes | yes | yes |
| Machine files (.PES, .DST, .PEC) | 3 in total | 100 a month | unlimited |
| Price | $0 | $9.99 / month | $22.99 / month |
| Saved designs in the account | 200 | 200 | 200 |

- Sign-in is Google only (Google Identity Services, popup).
- The machine file is made by this Worker with the **same engine files** the browser runs
  (`js/engine/embwriter.js`, `digitize.js`, `engine.js`), so the bytes are identical
  (checked by `test/export.test.mjs` against the golden files in `tests/engine/golden`).
- "A month" is the calendar month in UTC: the Hobby count starts again on the 1st.
- Stack: one Cloudflare Worker (plain ES modules, no dependencies, no build step of your own;
  `wrangler` bundles it), one D1 database, Stripe Checkout and the Stripe customer portal.

```
server/
  wrangler.toml          Worker settings (placeholders to fill in)
  migrations/            D1 schema: users, subscriptions, export_log, projects, stripe_events (apply all, in order)
  src/index.js           routes
  src/google.js          Google ID token check (RS256 against Google's keys, aud, iss, exp)
  src/session.js         signed session cookie
  src/plans.js           plans and export counting
  src/stripe.js          Checkout, portal, webhook signature, subscription events
  src/projects.js        saved designs
  src/exporter.js        imports the site's engine
  src/market.js          marketplace: published designs, stars, key unlocks
  src/users.js           handles, profiles, badges, activity, wallet
  src/economy.js         the marketplace rules (mirrored for the browser in ../js/market-rules.js)
  test/*.test.mjs        node --test, local SQLite as D1, Google and Stripe mocked
```

## Endpoints

| Method and path | Body | Answer |
|---|---|---|
| `POST /api/auth/google` | `{ credential }` (the Google ID token) | account info, sets the session cookie |
| `POST /api/auth/logout` | | clears the cookie |
| `GET /api/me` | | `{ signedIn, user, plan, exports: { used, limit, left, per, resetsAt }, billing, plans, googleClientId }` |
| `POST /api/export` | `{ design, format }`: `design` exactly as `Editor.Model.toEngine()` makes it, `format` `pes` `dst` `pec` `pes6` | the file bytes; headers `X-EL-Filename`, `X-EL-Stitches`, `X-EL-Exports-Left`. `402` when the plan is used up, `422` when the engine refuses the design (not counted) |
| `POST /api/billing/checkout` | `{ plan: 'hobby' \| 'pro' }` | `{ url }` of a Stripe Checkout page (a paying customer gets the portal instead) |
| `POST /api/billing/portal` | | `{ url }` of the Stripe customer portal |
| `POST /api/stripe/webhook` | Stripe event | signature checked, then the subscription is stored |
| `GET /api/projects` | | `{ projects: [{ id, name, size, updatedAt }] }` |
| `GET /api/projects/:id` | | `{ id, name, data, ... }` |
| `PUT /api/projects/:id` | `{ name, data }` | create or replace (max 1 MB of JSON, 200 per user) |
| `DELETE /api/projects/:id` | | |
| `GET /api/health` | | which settings are present (never their values) |
| Marketplace | | see [Marketplace](#marketplace) below |

Requests that change something must come from the site (`SITE_ORIGIN`): other origins get `403`
and no CORS headers. Bodies are capped (export 4 MB, design 1 MB, webhook 256 KB). One account can
start at most 20 exports a minute (`429` after that), counted in `export_log` so it holds across
Worker instances; refused designs count toward that cap but never toward the plan.

## Marketplace

People publish designs, star each other's, and spend keys earned from stars to unlock designs.
No real money moves: selling for money is not built ("coming soon" in the site).

**Rules** (`src/economy.js`; the browser copy `js/market-rules.js` must say the same, a test checks it):

- **Stars**: a signed-in person stars someone else's public design, once (and can take it back). Not their own.
  `starsReceived` is lifetime: each person's first star on each of your designs counts once, for good,
  so an unstar or a deleted design never takes back keys already earned.
- **Keys**: `keysEarned = floor(starsReceived / 10) + unlocksOfYourDesigns`, `keys = keysEarned - keysSpent`
  (never below 0). Keys unlock other people's `keys` designs, once, forever; the owner gets +1 key per unlock.
- **Sew-out discount**: `discountPct = min(50, 5 * floor(keys / 10))`.
- **Free sew-out**: the first 5 people whose lifetime stars received reach 10,000 get one
  (`sewout_claims`, rank 1 to 5, given in the same transaction as the star that crosses 10,000).
- **Modes**: `free` (anyone opens and remixes), `keys` (1 to 5 keys), `show` (picture and stitch preview only:
  the file goes to the owner only). **Visibility**: `public` (listed) or `private` (only the owner; 404 for others).
- **Badges** (computed): first-design, first-star, stars-100, stars-1000, stars-10000, streak-7, first-unlock,
  popular (a design with 50+ stars), early-member (first 100 people), free-sewout.
- **Activity**: per-day counts over the last 365 days (UTC) of saves (`PUT /api/projects`), publishes,
  exports (`POST /api/export`) and stars given.

| Method and path | Body | Answer |
|---|---|---|
| `GET /api/market?sort=new\|top&tag=&q=&cursor=&limit=` | | `{ items: [Item], next }` (public designs; `next` is the cursor for the next page, 24 per page, at most 48) |
| `POST /api/market` | `{ title, description, tags, mode, priceKeys, visibility, payload, thumb }` | `201` Item |
| `GET /api/market/:id` | | Item |
| `PATCH /api/market/:id` | any of `{ title, description, tags, mode, priceKeys, visibility }` | Item (owner only: `403 not_owner`) |
| `DELETE /api/market/:id` | | `{ deleted: true }` (owner only) |
| `GET /api/market/:id/file` | | the `.embroidr` JSON: owner, `free`, or `keys` after an unlock; else `403 { error: 'locked' }` |
| `GET /api/market/:id/thumb` | | the picture (the address is in `Item.thumb`) |
| `POST` / `DELETE /api/market/:id/star` | | `{ stars, starred }` |
| `POST /api/market/:id/unlock` | | `{ unlocked: true, keys }`, or `402 { error: 'not-enough-keys', keys, need }` |
| `GET /api/users/:handle` | | `{ handle, name, avatar, joined, starsReceived, badges: [{ id, label, earnedAt }], activity: [{ date, count }], designs: [Item] }` |
| `GET /api/me/wallet` | | `{ starsReceived, keys, keysEarned, keysSpent, discountPct, freeSewout: { eligible, rank, slotsLeft }, progressTo10k }` (`progressTo10k` is 0 to 1) |
| `PATCH /api/me` | `{ handle?, name? }` | `{ handle, name, avatar }`; handle is 3 to 24 of `a-z 0-9 -`, unique (`409 handle_taken`) |

`Item = { id, title, description, tags, mode, priceKeys, visibility, owner: { handle, name, avatar }, thumb,
stars, starred, unlocked, mine, createdAt, updatedAt }`. `unlocked` means the caller can open the file.
`thumb` is a URL on this API (or `null`). `GET /api/me` now also has `user.handle`.

Limits: title 80 characters, description 1,000, at most 8 tags of 24 characters, design 1 MB of JSON,
picture `data:image/webp` or `data:image/png` of at most 200 KB (the first bytes are checked).
20 publishes an hour and 500 designs per person. Everyone gets a handle at sign-in: the Google name as a
slug (`ann-example`), with a short random ending when it is taken.

**Pictures** are stored in D1 as data URLs. To keep them in R2 instead, create a bucket and bind it as
`THUMBS` in `wrangler.toml` (new pictures go there; old ones keep working):

```toml
[[r2_buckets]]
binding = "THUMBS"
bucket_name = "embroiderylabs-thumbs"
```

**Safe against double clicks and races**: an unlock is one SQL statement that checks the balance and
writes the unlock together, and `(user, design)` is unique, so keys are never spent twice. A star, its
lifetime mark, the design's star count and a possible free sew-out are one D1 batch (a transaction);
`sewout_claims` has rank 1 to 5 as its key and a unique user, so there can never be a 6th or a second one.

Apply the new migration after pulling: `npx wrangler d1 migrations apply embroiderylabs --remote`.

Stored in addition (privacy): your handle and display name, the designs you publish (until you delete
them), who starred and unlocked what, and per-day counts of saves, publishes, exports and stars given.

## Run the tests

```sh
cd server
npm test            # = node --test test/*.test.mjs   (needs Node 22.13 or newer for node:sqlite)
```

No packages are installed. Google's keys and Stripe are mocked; the database is an in-memory SQLite
with the same migrations D1 runs.

## Set it up (about an hour, in this order)

You need: a Cloudflare account, a Google account, a Stripe account, and Node 22 on your computer.
Do everything in Stripe **test mode** first.

### 1. Cloudflare: Worker and database

1. Cloudflare dashboard > Workers & Pages > Plans: pick **Workers Paid** ($5/month). The free plan
   allows 10 ms of CPU per request, which is too little to stitch a large design.
2. On your computer:
   ```sh
   cd server
   npx wrangler login
   npx wrangler d1 create embroiderylabs
   ```
   Copy the `database_id` it prints into `wrangler.toml` (replace `REPLACE_WITH_THE_ID_FROM_wrangler_d1_create`).
3. Create the tables:
   ```sh
   npx wrangler d1 migrations apply embroiderylabs --remote
   ```
4. Pick the API address. Best: **`https://api.embroiderylabs.com`**, a subdomain of the site, so the
   session cookie counts as first-party. That needs the domain's DNS on Cloudflare: then uncomment the
   `routes` block in `wrangler.toml` (or Workers > your worker > Settings > Domains & Routes > Add custom
   domain). The `*.workers.dev` address works for a first test with `curl`, but browsers will not send
   the cookie to it from embroiderylabs.com.
5. Check `SITE_ORIGIN` and `SITE_URL` in `wrangler.toml` (the site addresses, no trailing slash).

### 2. Google sign-in

1. <https://console.cloud.google.com> > create a project "EmbroideryLabs".
2. APIs & Services > OAuth consent screen: External; app name, support email, logo if you like, the
   home page `https://embroiderylabs.com` and a privacy policy page (see Privacy below). Scopes: only the
   default `openid`, `email`, `profile`. Publish the app (basic scopes need no Google review).
3. APIs & Services > Credentials > Create credentials > OAuth client ID > **Web application**.
   - Authorized JavaScript origins: `https://embroiderylabs.com`, `https://www.embroiderylabs.com`,
     and for testing on your computer `http://localhost` and `http://localhost:8437`.
   - Authorized redirect URIs: none (sign-in uses a popup).
4. Copy the **Client ID** (`....apps.googleusercontent.com`). It is not secret, but it is stored as one
   below so all settings live in one place.

### 3. Stripe

1. Products > Add product "EmbroideryLabs Hobby": recurring, **$9.99 per month**. Copy its price id
   (`price_...`).
2. Add product "EmbroideryLabs Pro": recurring, **$22.99 per month**. Copy its price id.
3. Settings > Billing > Customer portal: turn it on; allow cancelling, updating the card, and
   **switching plans** between Hobby and Pro (a Hobby customer who picks Pro is sent there).
4. Developers > API keys: copy the **secret key** (`sk_test_...` now, `sk_live_...` at launch).
5. Developers > Webhooks > Add endpoint: `https://api.embroiderylabs.com/api/stripe/webhook`, events
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`. Copy its **signing secret** (`whsec_...`).

### 4. Secrets

```sh
cd server
npx wrangler secret put GOOGLE_CLIENT_ID        # the Client ID from step 2
npx wrangler secret put SESSION_SECRET          # paste the output of: openssl rand -base64 48
npx wrangler secret put STRIPE_SECRET_KEY       # sk_test_... / sk_live_...
npx wrangler secret put STRIPE_WEBHOOK_SECRET   # whsec_...
npx wrangler secret put STRIPE_PRICE_HOBBY      # price_... ($9.99)
npx wrangler secret put STRIPE_PRICE_PRO        # price_... ($22.99)
```

Nothing secret is in the code or in `wrangler.toml`. Changing `SESSION_SECRET` later signs everybody out.

### 5. Deploy and check

```sh
npx wrangler deploy
curl https://api.embroiderylabs.com/api/health
```

Every value in the health answer should be `true` and `origins` should list the site.

### 6. Try it on your computer, then turn it on

1. In a copy of the site on your computer, set the API address in `js/config.js`:
   ```js
   window.EL_CONFIG = Object.assign({ apiBase: 'https://api.embroiderylabs.com', googleClientId: null }, window.EL_CONFIG || {});
   ```
   For a fully local test instead: `cp .dev.vars.example .dev.vars` (fill it in), then
   `npx wrangler d1 migrations apply embroiderylabs --local`, `npx wrangler dev --port 8788`, serve the
   site with `python3 -m http.server 8437` and use `apiBase: 'http://localhost:8788'`. Stripe events
   reach your computer with `stripe listen --forward-to localhost:8788/api/stripe/webhook`.
2. Open the editor: "Sign in" is in the top bar. Sign in, export 3 files, check that the 4th asks for a
   plan, buy Hobby with the test card `4242 4242 4242 4242`, check the menu says Hobby with 100 left,
   open Manage billing, cancel, check it falls back to Free at the period end.
3. Switch Stripe to live mode (live secret key, live prices, live webhook secret: put the three secrets
   again), deploy, then commit `js/config.js` with `apiBase` set. That is the switch: setting `apiBase`
   back to `null` turns everything off again.

## Privacy: what is stored

- **Account**: Google's account id for you, your email, name and profile picture address, when you
  signed up and last signed in.
- **Billing**: the Stripe customer id and the subscription's plan, status and renewal date. Card
  details stay with Stripe and never reach this server.
- **Exports**: one row per export: time, format, plan, stitch count and file size. **Not** the design:
  the design sent for an export is turned into the file in memory and then dropped.
- **Saved designs**: only the ones you save with "Save to my account" (the design as JSON), until you
  delete them.
- One cookie, `el_session`: HttpOnly, Secure, SameSite=Lax, 30 days, signed. No analytics, no ads.
- Without an account nothing is sent anywhere: drawing, preview and mockups stay in the browser.

Before launch, put this on a privacy page (Google's consent screen asks for its address). Deleting an
account is a manual job for now:
`npx wrangler d1 execute embroiderylabs --remote --command "DELETE FROM users WHERE email = 'someone@example.com'"`
(saved designs, exports and subscriptions go with it; cancel the Stripe subscription in Stripe first).

## Honest limits

- **The engine is also in the browser**, because the stitch preview needs it. Someone who knows how can
  call it from the browser console and make files without the server. The paywall stops ordinary use,
  not a determined person. Moving the file writers out of the browser would close most of that gap; the
  preview would keep working.
- Free is 3 exports per Google account; someone can make more Google accounts.
- Sessions are not stored on the server: "Sign out" clears the cookie in that browser only, and a
  copied cookie works until it expires (30 days) or `SESSION_SECRET` changes.
- The Hobby month is the calendar month in UTC, not the billing period.
- A subscription that is `past_due` keeps its plan while Stripe retries the card; `unpaid`,
  `canceled` and `incomplete` count as Free.
- With accounts on, exports need the server: if it is down, the editor says so and exports wait.
  Drawing keeps working.
- Very large designs (a big traced picture) can take seconds of CPU; `limits.cpu_ms` in
  `wrangler.toml` is 30 s. A failed export is not counted. Some odd shapes are much slower than their
  size suggests: a polygon of 20,000 points that crosses itself everywhere takes about 40 s in the
  engine, and the Worker stops it at 30 s. The 20-a-minute cap keeps one account from doing that
  over and over; making the engine faster on such shapes is engine work, not server work.
- Not yet run against the real Google, Stripe and Cloudflare accounts. Checked so far: the node tests
  (Google keys and Stripe mocked), and the Worker in `wrangler dev` (local workerd and D1) driven from
  the real editor in headless Chrome, with server files byte-identical to the browser's.
