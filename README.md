# Small Worlds AI

Longform AI roleplay: worlds with their own rules, a cast that holds its line, and seasons that
remember selectively. Local-first — your stories, characters, and API keys live on your device and
are sent nowhere except the AI endpoint you configure.

**Copyright © 2026. All rights reserved.** This is proprietary software — no copying,
modification, or redistribution without written permission. See [LICENSE](LICENSE). Stories and
worlds you create in the app are yours, not covered by this license.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
```

Production build (static files in `dist/`):

```bash
npm run build
npm run preview    # serve the production build locally
```

## Set up an AI provider

The app runs on your own API keys. Open **Settings → Your AI providers → add a provider**.

- **OpenRouter** (recommended): one pay-as-you-go key at [openrouter.ai/keys](https://openrouter.ai/keys)
  gives you hundreds of models — Claude, GLM, Kimi K2, DeepSeek, GPT, Grok, Llama — so you can compare
  which writes your stories best. GLM 5.x slugs are `z-ai/glm-5.2` and `z-ai/glm-5.3`.
- **Z.ai**: direct GLM (`glm-5.2`, `glm-5.3`, `glm-5.3-flash`, `glm-image`). The browser may hit CORS —
  use OpenRouter’s `z-ai/glm-5.2`, or sign in so the optional cloud relay can reach `api.z.ai`.
  The relay requires a signed-in user. China BigModel is Custom: `https://open.bigmodel.cn/api/paas/v4`.
- **Small Worlds hosted** (optional): Settings → Small Worlds hosted, after you sign in. No API key.
  Credits are metered on the server. Bring-your-own-key stays free.
- **Anthropic / OpenAI / Gemini / Moonshot / Together / DeepSeek / xAI** direct keys also work.
- **Local models**: point the Ollama or Custom endpoint preset at your local server
  (for Ollama, set `OLLAMA_ORIGINS=*` so the browser may call it).

There is no hardcoded model list: the picker fetches the provider's live catalog where supported and
always accepts a free-typed model ID, so new models work the day they launch.

Set three defaults in Settings (each can be overridden per world):

- **Prose model** — writes the story. Recommended pairing: `glm-5.2` (or Flash if you want speed).
- **Utility model** — director, wrap, live canon, drafts. Recommended: `glm-5.2`.
- **Image model** — scene backdrops. Recommended: `glm-image`. Official Z.ai image generation is
  text-only; matching uploaded cast photos needs an OpenRouter-style multimodal image model.

## How it works

- **Story** — the writing loop. Type what you say or do: a question or words aimed at someone are
  spoken, "I draw my sword" is an action, quotes and \*gestures\* are taken exactly as written.
  *Direct* turns your line into an author instruction; *Continue* lets the scene move on. Three
  lengths: Beat / Scene / Episode. NPC lines appear under their own name and portrait. Prose
  streams in live; rewrite or delete the last turn any time. Two layouts: *Write* and *Read*.
- **Places** — places can sit inside each other (a town, a street, a room). Each has what it is,
  its feel, its condition right now, who's usually there, optional rules, and hidden history the
  writer reveals only when earned. The scene follows you: walk somewhere and the chapter moves
  there (with undo), or pick a place from the Story header.
- **Cast** — deep NPC sheets: identity, voice with example lines, psychology, secrets (including
  *must-not-know-yet* plot walls), typed relationships, hard behaviour anchors, free-form AI
  directives, and a current-state snapshot that evolves with the story. Only in-scene characters get
  their full sheet in the prompt. Describe a character in one sentence to get an AI-drafted sheet.
- **Wrap up** — ending an episode files what happened into continuity automatically. Ending a
  season opens the review.
- **Next season** — the sequel engine. The season is read back into beats; you mark each
  Drop / Soften / Keep / Raise, choose the time gap, decide who returns, review what changed
  off-screen, and set the premise. A season bible (weighted recap + carried beats + evolved
  character states) seeds season N+1 without dragging thousands of old turns into context.
- **Settings (world section)** — POV, tense, prose density, pacing, narrator hard rules, content
  boundaries, verbatim world instructions, and per-world model overrides.

## Your data

- Stories, cast, continuity: **IndexedDB** on this device.
- Keys and preferences: **localStorage** on this device (keys go into the vault when enabled).
- **Device backup** (Profile → Back up this device): worlds + settings + encrypted key vault.
  Restore on another browser the same way. World-only export/import still lives on the Worlds screen.
- **Optional cloud sync** (Profile): set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (see
  `.env.example`), run every file in `supabase/migrations/` in order (001 through 005), then sign
  in with phone, email, or Google. Sync is revisioned pull/push with RLS; API keys sync only as E2E
  ciphertext via a separate secrets passphrase. Deploy `supabase/functions/ai-proxy` if you want the
  browser to reach Z.ai / BigModel through an allowlisted relay (signed-in users only; forwards the
  caller’s key; no hosted inference).
- **Erase this device** (Settings) wipes local data only. **Delete cloud account** (Profile or
  Settings, when signed in) deletes the Supabase user — synced rows and secrets cascade — and then
  wipes this device.

## Hosted credits

Optional. BYOK and local play stay free. To sell hosted models:

1. Run `supabase/migrations/003_billing.sql`.
2. In Stripe, create a monthly price and a one-time pack price.
3. Set function secrets (not `VITE_` vars): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
   `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_PACK`, `HOSTED_CHAT_BASE_URL`, `HOSTED_CHAT_API_KEY`,
   `HOSTED_PROSE_MODEL`, `HOSTED_UTILITY_MODEL`, `HOSTED_IMAGE_MODEL`. `HOSTED_IMAGE_BASE_URL` is
   optional.
4. Deploy `ensure-billing`, `create-checkout-session`, `create-portal-session`, `stripe-webhook`,
   `hosted-ai`, and `delete-account`. `supabase/config.toml` turns JWT verification off for the
   webhook only; the function checks the Stripe signature. Point the Stripe webhook at
   `.../functions/v1/stripe-webhook` for `checkout.session.completed`, `invoice.paid`,
   `customer.subscription.updated`, and `customer.subscription.deleted`.
5. Credit amounts live in `src/billing/plans.ts` and `supabase/functions/_shared/billing.ts` (keep
   them identical). New accounts get a one-time starter grant. The client cannot set the price.

## Security

Local-first by default. Optional Supabase auth is for sync — not required to play.

- **App lock + key encryption** (Settings → Security). Set a passphrase and the app shows a lock
  screen on open, and your API keys are stored encrypted (AES-256-GCM; key derived from your
  passphrase with PBKDF2-SHA256, 600k iterations). Lock always persists ciphertext before blanking
  memory. While the lock is on, story text in IndexedDB is encrypted too (AES-256-GCM with a story
  key wrapped by your passphrase). Forget the passphrase and the keys *and* the encrypted worlds on
  this device can't be read — keep an encrypted device backup.
- **Encrypted device backups.** Required when API keys are present. Import detects encrypted files.
- **Optional TOTP MFA** on the account (Supabase free-tier basic MFA). Once enrolled, every sign-in
  asks for the authenticator code, and the database refuses synced rows until it is entered
  (migration 005). Phone SMS OTP needs Twilio.
- **Content-Security-Policy.** Production builds lock script execution to the app's own bundle.
  `connect-src` stays open on purpose — you can point the app at any AI endpoint, including local
  Ollama over http. Fonts are bundled; the app does not call Google Fonts.
- **Erase this device** (Settings → Security) wipes IndexedDB, settings, keys, vault, and sync meta
  on this browser. It does not delete a cloud account.
- **Delete cloud account** removes the Supabase user (synced stories, encrypted secrets, billing)
  and then erases this device.
- **Deleted means deleted.** Removing a world, place, or turn keeps only its id (so sync can delete
  it elsewhere), never its text.
- **What this doesn't cover:** without the app lock, story text in IndexedDB is not encrypted at
  rest (protect it with OS/device encryption). Prompts go to whichever AI provider you configured.

Production builds ship a `public/_headers` file (copied into `dist/`) that Netlify and Cloudflare
Pages apply automatically: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`, `Permissions-Policy` (camera/mic/location/payment off),
`Strict-Transport-Security`, and `Cross-Origin-Opener-Policy: same-origin`.

## Use it on your phone

The app is an installable PWA. Host the `dist/` build on any static host with HTTPS
(GitHub Pages, Netlify, Cloudflare Pages — all free), open it on your phone, and use
**Add to Home Screen**. The app shell works offline; writing needs network for the AI call.
Keys entered on the phone stay on the phone.

## Project layout

- `src/ai/` — universal streaming LLM client (OpenAI-compatible, Anthropic, Gemini), prompt
  builder, and the story engine (writing loop + utility tasks).
- `src/screens/` — Worlds, Story, Cast, Locations, Next season, Profile, Settings, New world.
- `src/db.ts` — Dexie/IndexedDB schema and world export/import.
- `src/sync/` — device serialization + Supabase pull/push sync.
- `src/cloud/` — Supabase client and auth store.
- `supabase/migrations/` — Postgres schema + RLS for cloud sync.
- `prototype/` — the original dc-runtime design prototype this UI was ported from (reference only).
