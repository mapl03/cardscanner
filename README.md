# Card Vault

Scan a football trading card front and back, identify it, look up what it sells for, and keep it in a catalogue that syncs across devices.

Built for Panini and Topps, extensible to other manufacturers and sports.

```
src/firebase.js   project config — the only file with your Firebase values
src/storage.js    Firestore + Firebase Storage; the only file that persists anything
src/ai.js         calls your Cloudflare Worker, which holds the Gemini key
src/App.jsx       model, screens, app shell
worker/           the API proxy: Firebase token check, daily quota, key custody
```

---

## Why the Worker exists

The app is public. Anyone who opens it can read every line of JavaScript in it.

If the Gemini key sat in that JavaScript, every visitor would have your key and could burn your quota. So the key lives in a Cloudflare Worker instead, and the Worker refuses any request that does not carry a valid Firebase ID token from your project.

That gives you three controls:

- **Who can call it** — only signed-in users of your Firebase project, and only from your origin
- **How much they can spend** — `DAILY_LIMIT` lookups per person per day
- **What they can ask for** — the model is allow-listed and output tokens are capped in the Worker, not taken from the browser

Do not skip this and call the Gemini endpoint from the browser. It works in testing and hands out your key in production.

---

## Setup

### 1. Firebase

In the [Firebase console](https://console.firebase.google.com), create a project, then:

- **Authentication → Sign-in method →** enable **Email/Password**
- **Firestore Database →** create in production mode, region `eur3` or `europe-west3` for the lowest latency from Slovenia. The region cannot be changed later.
- **Storage →** optional, and it needs the Blaze plan. See "Full-size photos" below.
- **Project settings → Your apps →** add a Web app, copy the config object

Paste that config into `src/firebase.js`, replacing every `PASTE_…` value.

Those values are not secret. Firebase web config ships in every client bundle by design — your data is protected by `firestore.rules` and `storage.rules`, not by hiding the config.

> A half-filled config fails quietly: sign-in appears to work and writes vanish. The app checks for leftover `PASTE_` placeholders at startup and blocks with a visible message rather than letting that happen.

### Full-size photos

Since 3 February 2026, Cloud Storage for Firebase needs the pay-as-you-go Blaze plan and a linked card, whatever the volume. Under 5 GB stored the bill stays zero, and a bucket in `US-CENTRAL1`, `US-WEST1` or `US-EAST1` keeps the "Always Free" tier — a European bucket does not.

You do not have to decide now. On the free Spark plan the app still works: uploads fail, `saveImages` returns false, and the card saves with its thumbnails. You lose the full-resolution originals, nothing else.

If you go with Blaze, set a budget alert first: Google Cloud Console → Billing → Budgets & alerts. It emails you; it does not stop spending.

### Publish the rules

```bash
npx firebase deploy --only firestore:rules,storage:rules
```

Or paste `firestore.rules` and `storage.rules` into the console by hand. Without them your database is open to the internet.

### 2. Gemini key

Go to [aistudio.google.com](https://aistudio.google.com), sign in with the same Google account as Firebase, and create an API key. No card needed.

Check the quota AI Studio shows for the project — that is the real number, and it is shared by everyone who uses the app.

### 3. Worker

```bash
cd worker
npm install
```

Edit `wrangler.toml`: set `FIREBASE_PROJECT_ID` to your project id, and `ALLOWED_ORIGINS` to your GitHub Pages origin (`https://YOURNAME.github.io`, no trailing path).

For the daily quota:

```bash
npx wrangler kv namespace create QUOTA
```

Uncomment the `[[kv_namespaces]]` block and paste in the id it prints. Without the KV binding the Worker runs fine, it just does not count usage.

Then:

```bash
npx wrangler secret put GEMINI_API_KEY   # paste the key when prompted
npx wrangler deploy
```

Note the URL it prints, e.g. `https://cardscanner-api.yourname.workers.dev`.

### 4. App

```bash
npm install
cp .env.example .env      # put the Worker URL in VITE_API_PROXY
npm run dev
```

Open the address it prints. Create an account, scan a card.

### 5. Publish

Edit `vite.config.js` so `base` matches the repository name (`/cardscanner/` for a repo called `cardscanner`).

```bash
git init && git add . && git commit -m "Card Vault"
git remote add origin https://github.com/mapl03/cardscanner.git
git push -u origin main
```

In the repository settings:

- **Settings → Pages → Source →** GitHub Actions
- **Settings → Secrets and variables → Actions → New repository secret**
  Name `VITE_API_PROXY`, value your Worker URL

`VITE_API_PROXY` is inlined at build time, so it has to come from a repository secret rather than a local `.env`. It is not sensitive — it is just a URL, and the Worker is the thing that enforces access.

Push to `main` and the workflow builds and deploys. First run takes about two minutes.

---

## Installing on a phone

The site must be served over HTTPS. GitHub Pages already is.

**Android / Chrome** — open the link, menu ⋮, *Install app* (or *Add to Home screen*).

**iPhone / Safari** — open the link, Share, *Add to Home Screen*. It has to be Safari; Chrome on iOS cannot install web apps.

Once installed it opens without browser chrome and keeps you signed in.

### Camera

The first scan asks for camera permission. If it is refused, the app falls back to a file picker, which on a phone still opens the camera — so scanning works either way.

iOS only grants camera access to installed web apps from iOS 16.4 onward. On anything older, use the file picker path.

---

## Adding people

Each person creates their own account on the sign-in screen and gets their own private collection. The Firestore rules mean nobody can read anybody else's cards.

To stop strangers signing up, switch to invite-only: in the Firebase console under **Authentication → Settings → User actions**, disable public sign-up, then create accounts by hand under **Authentication → Users**. The *Create account* link in the app will start failing with a clear message, which is the intended behaviour once you go invite-only.

### Quota

Card identification runs on Gemini Flash, which has a no-cost tier with no card required. The published daily allowance moves around, so treat the live number in AI Studio as the truth rather than anything written here.

The quota belongs to the key, not to the person. Everyone shares one pool, so one person working through a shoebox can leave the rest with nothing until the next day. `DAILY_LIMIT` in `wrangler.toml` is the per-person ceiling the Worker enforces on top of that — it needs the KV binding to do anything.

Price lookup uses Google Search grounding, which is metered separately from ordinary Flash calls. If it stops working while scanning still does, that is the grounding allowance, not the model. The app handles it correctly either way: it shows "insufficient market data" rather than inventing a price.

---

## What is not built

**Edge detection and perspective correction.** The scanner crops to the on-screen guide and normalises contrast. It does not find the card's actual corners in the frame. Real correction needs OpenCV.js (`findContours` then `warpPerspective`) — roughly 150 lines and about 1 MB of extra payload.

**A card database.** Identification is the model reading the two photos, every time. There is no local checklist to match against, so set completion depends on cards being labelled consistently.

**Verified pricing.** Values come from whatever sold listings the model finds during the lookup. The prompt forbids estimating and returns "insufficient market data" rather than a guess, but this is not a price feed. For something dependable, move `estimateValue` in `src/ai.js` onto a real source:

- [PriceCharting / SportsCardsPro](https://www.sportscardspro.com/api-documentation) — token-based, covers sports cards
- eBay Marketplace Insights — the official sold-price API, but limited release and needs eBay's approval

---

## Local checks

```bash
node full-test.mjs   # renders the whole app in jsdom against fixture data
```

Covers home stats, collection filters and badges, set checklists, wishlist, profile figures, the value chart, and the card detail sheet. It uses mocked Firebase and AI layers, so it needs no network and no credentials.
