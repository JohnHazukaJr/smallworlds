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
  China BigModel is Custom: `https://open.bigmodel.cn/api/paas/v4`.
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

- **Story** — the writing loop. Four modes: *Continue* (the narrator takes the next beat), *Steer*
  (direct the scene in your words), *Speak* (your dialogue only), *Act* (your action only). Three
  lengths: Beat / Scene / Episode. Prose streams in live; rewrite or delete the last turn any time.
  The *Direct* layout (or the Direct sheet on mobile) shows scene cast, continuity, open threads,
  and one-tap nudges.
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
  `.env.example`), run `supabase/migrations/001_initial.sql`, then sign in with phone, email, or
  Google. Sync is revisioned pull/push with RLS; API keys sync only as E2E ciphertext via a separate
  secrets passphrase. Deploy `supabase/functions/ai-proxy` if you want the browser to reach Z.ai /
  BigModel through an allowlisted relay (forwards your Bearer token; no hosted inference).

## Security

Local-first by default. Optional Supabase auth is for sync — not required to play.

- **App lock + key encryption** (Settings → Security). Set a passphrase and the app shows a lock
  screen on open, and your API keys are stored encrypted (AES-256-GCM; key derived from your
  passphrase with PBKDF2-SHA256, 600k iterations). Lock always persists ciphertext before blanking
  memory. Forget the passphrase and keys on this device are wiped — restore from a device backup
  or re-enter them. Stories stay.
- **Encrypted device backups.** Required when API keys are present. Import detects encrypted files.
- **Optional TOTP MFA** on the account (Supabase free-tier basic MFA). Phone SMS OTP needs Twilio.
- **Content-Security-Policy.** Production builds lock script execution to the app's own bundle.
  `connect-src` stays open on purpose — you can point the app at any AI endpoint, including local
  Ollama over http.
- **Erase all data** (Settings → Security) wipes IndexedDB, settings, keys, vault, and sync meta.
- **What this doesn't cover:** story text in IndexedDB is not encrypted at rest (protect it with
  OS/device encryption). Prompts go to whichever AI provider you configured.

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
