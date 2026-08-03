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
  gives you hundreds of models — Claude, Kimi K2, DeepSeek, GPT, Grok, Llama — so you can compare
  which writes your stories best.
- **Anthropic / OpenAI / Gemini / Moonshot / Together / DeepSeek / xAI** direct keys also work.
- **Local models**: point the Ollama or Custom endpoint preset at your local server
  (for Ollama, set `OLLAMA_ORIGINS=*` so the browser may call it).

There is no hardcoded model list: the picker fetches the provider's live catalog where supported and
always accepts a free-typed model ID, so new models work the day they launch.

Set two defaults in Settings:

- **Prose model** — writes the story. Spend your best model here.
- **Utility model** — background work (continuity extraction, season analysis, character drafts).
  A cheap fast model is ideal. Both can be overridden per world.

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
- Keys and preferences: **localStorage** on this device.
- Move worlds between devices with **export / import** (Worlds screen or Profile). Each device has
  its own storage; there is no sync backend yet.

## Security

Small Worlds has no server and no accounts — the security model is protecting what sits on your
device and what leaves it in backups.

- **App lock + key encryption** (Settings → Security). Set a passphrase and the app shows a lock
  screen on open, and your API keys are stored encrypted (AES-256-GCM; key derived from your
  passphrase with PBKDF2-SHA256, 600k iterations). The decrypted keys exist only in memory while
  unlocked. There is deliberately no recovery: forget the passphrase and the keys are wiped (your
  stories are untouched — the passphrase never encrypts story text, so they can't be lost with it).
- **Encrypted exports.** Every export and full backup offers an optional passphrase. Use it for
  anything that will sit in cloud storage, email, or a chat app. Import detects encrypted files and
  asks for the passphrase.
- **Content-Security-Policy.** Production builds lock script execution to the app's own bundle.
  `connect-src` stays open on purpose — you can point the app at any AI endpoint, including local
  Ollama over http.
- **Erase all data** (Settings → Security) wipes IndexedDB, settings, keys, and the vault in one
  step.
- **What this doesn't cover:** story text in IndexedDB is not encrypted at rest (it is as private
  as any file on your device — protect it with your OS user account / device encryption), and your
  prompts necessarily go to whichever AI provider you configured, under that provider's privacy
  policy.

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
- `src/screens/` — the seven screens: Worlds, Story, Cast, Next season, Profile, Settings, New world.
- `src/db.ts` — Dexie/IndexedDB schema and world export/import.
- `prototype/` — the original dc-runtime design prototype this UI was ported from (reference only).
