/**
 * UI smoke test for the roleplay features, with no model key.
 *
 * Starts the Vite dev server, seeds a world straight into IndexedDB through the
 * app's own modules (tagged beats, a settled check, kept versions, next-move
 * ideas, NPC memories, game rules, a thread), then drives the Story, Journal,
 * world editor, and Cast screens at desktop and phone widths.
 *
 *   npm run smoke                     # desktop + phone
 *   SMOKE_DEVICES=all npm run smoke   # every size below, foldables included
 *   SMOKE_DEVICES=z-fold-open,galaxy-s8 npm run smoke
 *   SMOKE_SHOTS=dir npm run smoke     # also save screenshots to dir
 *
 * Each screen also checks that nothing runs off the side: no sideways page
 * scroll, and no button, field, or label past the screen edge.
 */

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const PORT = 5199;
const BASE = `http://localhost:${PORT}/`;
const SHOTS = process.env.SMOKE_SHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

/** CSS-pixel viewports. Bands: compact <600, regular 600-959 (book when 700+ tall), wide 960+. */
const DEVICES = {
  desktop: { width: 1280, height: 900 },
  phone: { width: 390, height: 844, mobile: true },
  'galaxy-fold-cover': { width: 280, height: 653, mobile: true },
  'z-fold-cover': { width: 344, height: 882, mobile: true },
  'galaxy-s8': { width: 360, height: 740, mobile: true },
  'pixel': { width: 412, height: 915, mobile: true },
  'phone-landscape': { width: 844, height: 390, mobile: true },
  'z-fold-open': { width: 884, height: 1104, mobile: true },
  'z-fold-open-landscape': { width: 900, height: 616, mobile: true },
  'tablet': { width: 768, height: 1024, mobile: true },
  'desktop-wide': { width: 1920, height: 1080 }
};
const pick = (process.env.SMOKE_DEVICES || 'desktop,phone').trim();
const DEVICE_NAMES = pick === 'all' ? Object.keys(DEVICES) : pick.split(',').map((d) => d.trim()).filter(Boolean);
for (const name of DEVICE_NAMES) if (!DEVICES[name]) throw new Error(`Unknown device "${name}". Known: ${Object.keys(DEVICES).join(', ')}`);

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (e) {
    const message = String(e?.message ?? e);
    // SMOKE_VERBOSE=1 keeps Playwright's call log, which says why a click could not land.
    results.push({ name, ok: false, error: process.env.SMOKE_VERBOSE ? message.slice(0, 2500) : message.split('\n')[0] });
  }
};

async function waitForServer(url, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`dev server did not start at ${url}`);
}

/** Runs in the page: seeds one world through the app's real modules. */
async function seed() {
  const { db, uid } = await import('/src/db.ts');
  const { createWorld, emptyCharacter } = await import('/src/worldOps.ts');
  const { DEFAULT_STATS } = await import('/src/mechanics.ts');
  const { beatsToProse } = await import('/src/ai/beatProtocol.ts');

  const world = await createWorld({
    title: 'Smoke Harbour', line: 'Fog and debts.', bible: 'A harbour town of ledgers and fog.',
    premise: 'Debts come due.'
  });
  await db.worlds.update(world.id, {
    mechanics: { enabled: true, stats: DEFAULT_STATS, difficulty: 'fair' }
  });
  const season = await db.seasons.where('worldId').equals(world.id).first();
  const episode = await db.episodes.where('worldId').equals(world.id).first();
  const player = await db.characters.where('worldId').equals(world.id).first();
  await db.characters.update(player.id, {
    name: 'Rowan', stats: { finesse: 2 }, inventory: [{ id: uid(), name: 'lantern', qty: 1 }]
  });
  const canvas = document.createElement('canvas');
  canvas.width = 20; canvas.height = 30;
  const g = canvas.getContext('2d');
  g.fillStyle = '#7a8fa6'; g.fillRect(0, 0, 20, 30);
  const figure = canvas.toDataURL('image/jpeg');
  const ada = emptyCharacter(world.id, {
    name: 'Ada', role: 'registrar', hue: 200, summary: 'Keeps the books.',
    appearance: 'Tall, silver streak in black hair, long grey coat.',
    figures: [figure],
    memories: [{
      id: uid(), text: 'Rowan broke into her archive and read the sealed ledger',
      feeling: 'betrayed', salience: 3, episodeId: episode.id, createdAt: Date.now()
    }]
  });
  await db.characters.add(ada);
  // Someone who reads as under 18, to check the intimate section stays locked.
  await db.characters.add(emptyCharacter(world.id, { name: 'Pip', age: '15', role: 'errand runner', hue: 40 }));
  await db.worlds.update(world.id, { ai: { ...(await db.worlds.get(world.id)).ai, mature: true } });
  await db.episodes.update(episode.id, { castIds: [player.id, ada.id], location: 'Harbour office' });

  let t = Date.now() - 60_000;
  const base = { episodeId: episode.id, worldId: world.id };
  const firstBeats = [
    { role: 'narrator', text: 'The lock gives with a dry click.' },
    { role: 'character', text: '*looks up from the ledger* "Read it again."', speakerId: ada.id, kind: 'cast', name: 'Ada' }
  ];
  const oldText = 'The lock holds. Somewhere a bell rings.';
  const firstText = beatsToProse(firstBeats);
  const move = {
    ...base, id: uid(), role: 'user', mode: 'act', text: 'I pick the lock on the archive door.', createdAt: t++,
    check: { intent: 'pick the archive lock', stat: 'Finesse', difficulty: 'normal', dice: [2, 4], modifier: 2, total: 8, tier: 'partial' }
  };
  const reply = {
    ...base, id: uid(), role: 'narrator', mode: null, text: firstText, beats: firstBeats, createdAt: t++,
    alts: [{ text: oldText, createdAt: t - 5 }, { text: firstText, beats: firstBeats, createdAt: t - 1 }], altIndex: 1
  };
  const lastBeats = [
    { role: 'character', text: '"Nobody sends me. I came for the ledger."', speakerId: ada.id, kind: 'cast', name: 'Ada' }
  ];
  const ask = { ...base, id: uid(), role: 'user', mode: 'play', text: '"Who sent you?"', createdAt: t++ };
  const last = { ...base, id: uid(), role: 'narrator', mode: null, text: beatsToProse(lastBeats), beats: lastBeats, createdAt: t++ };
  await db.turns.bulkAdd([move, reply, ask, last]);
  await db.episodes.update(episode.id, {
    suggestions: { afterTurnId: last.id, items: ['"Then show me the ledger."', 'Slip the ledger under my coat', 'Ask who else has seen it'] }
  });
  await db.threads.add({
    id: uid(), worldId: world.id, seasonId: season.id, text: 'Who forged the sealed ledger?',
    openedLabel: 'opened S1 · E1', status: 'open', createdAt: Date.now()
  });

  const { useApp } = await import('/src/store/app.ts');
  useApp.setState({ layout: 'write' });
  useApp.getState().openWorld(world.id);
  return { worldId: world.id, oldText, firstText };
}

async function run(browser, label, device) {
  const page = await browser.newPage({
    viewport: { width: device.width, height: device.height },
    ...(device.mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2.6 } : {})
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  const shot = async (name) => {
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `${label}-${name}.png`), fullPage: false });
  };
  const step = (name, fn) => check(`[${label}] ${name}`, async () => {
    try {
      await fn();
    } catch (e) {
      await shot(`FAIL-${name.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}`).catch(() => undefined);
      throw e;
    }
  });
  /** Nothing runs off the side of the screen on what is showing now. */
  /** What a reader can touch: on the book layout, the front page, not the next one pre-drawn underneath. */
  const visiblePage = async () => ((await page.locator('.book-face-front').count()) ? page.locator('.book-face-front') : page);
  const fits = (where) => step(`fits the screen: ${where}`, async () => {
    await page.waitForTimeout(400);
    const bad = await page.evaluate(() => {
      const w = document.documentElement.clientWidth;
      const out = [];
      const sw = document.documentElement.scrollWidth;
      if (sw > w + 1) out.push(`page scrolls sideways (${sw} > ${w})`);
      const clipped = (el) => {
        for (let a = el.parentElement; a; a = a.parentElement) {
          const cs = getComputedStyle(a);
          if (cs.overflowX !== 'visible' && a.scrollWidth > a.clientWidth + 1) return true;
          if (cs.display === 'none' || cs.visibility === 'hidden') return true;
        }
        return false;
      };
      for (const el of document.querySelectorAll('button, input, textarea, select, label, [role="group"], [role="radio"]')) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        if (r.bottom < 0 || r.top > window.innerHeight * 4) continue;
        if (clipped(el)) continue;
        if (r.right > w + 2 || r.left < -2) {
          const name = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').trim().slice(0, 28);
          out.push(`${el.tagName.toLowerCase()} "${name}" spans ${Math.round(r.left)}-${Math.round(r.right)} of ${w}`);
        }
      }
      return out.slice(0, 5);
    });
    if (bad.length) throw new Error(bad.join(' | '));
  });

  await page.goto(BASE);
  await page.waitForLoadState('networkidle');
  const seeded = await page.evaluate(seed);
  await page.waitForTimeout(800);
  await shot('story');

  await fits('story');
  await step('tagged beats render with the speaker', async () => {
    await page.getByText('Read it again.', { exact: false }).first().waitFor({ timeout: 8000 });
    await page.getByText('Ada', { exact: true }).first().waitFor({ timeout: 4000 });
  });
  await step('check chip under the move', async () => {
    await page.getByText(/Finesse · partial · 8/i).first().waitFor({ timeout: 4000 });
  });
  await step('kept versions: 2 / 2, flip back and forward', async () => {
    await page.getByText('2 / 2').first().waitFor({ timeout: 4000 });
    await (await visiblePage()).getByRole('button', { name: 'Previous version' }).first().click();
    await page.getByText(seeded.oldText).first().waitFor({ timeout: 4000 });
    await (await visiblePage()).getByRole('button', { name: 'Next version' }).first().click();
    await page.getByText('Read it again.', { exact: false }).first().waitFor({ timeout: 4000 });
  });
  await step('next-move ideas fill the input', async () => {
    const idea = page.getByRole('button', { name: 'Slip the ledger under my coat' });
    await idea.scrollIntoViewIfNeeded();
    await idea.click();
    const value = await page.locator('textarea').last().inputValue();
    if (value !== 'Slip the ledger under my coat') throw new Error(`input was "${value}"`);
    await shot('ideas');
  });
  await step('"Let time pass" is offered', async () => {
    await page.getByRole('button', { name: 'Let time pass' }).waitFor({ timeout: 4000 });
  });
  await step('rewind to here, then undo', async () => {
    await (await visiblePage()).getByRole('button', { name: 'Rewind to here' }).first().click();
    await page.getByText(/Rewound \d+ lines?\./).waitFor({ timeout: 6000 });
    await shot('rewound');
    if (await page.getByText('Nobody sends me.', { exact: false }).count()) throw new Error('later lines still shown');
    await page.getByRole('button', { name: 'Undo' }).click();
    await page.getByText('Nobody sends me.', { exact: false }).first().waitFor({ timeout: 6000 });
  });
  await step('journal lists and resolves a thread', async () => {
    await page.getByRole('button', { name: /^Journal$/ }).first().click();
    await page.getByText('Who forged the sealed ledger?').waitFor({ timeout: 4000 });
    await page.waitForTimeout(600); // let the sheet finish fading in before the picture
    await shot('journal');
    await fits('journal');
    await page.getByRole('button', { name: 'Resolve' }).first().click();
    await page.getByText(/Show resolved \(1\)/).waitFor({ timeout: 4000 });
    await page.getByRole('button', { name: 'Done' }).last().click();
  });
  await step('world editor shows game rules', async () => {
    const edit = page.getByRole('button', { name: /^Edit world$/ });
    if (await edit.count()) await edit.first().click();
    else {
      await page.getByRole('button', { name: /^More$/ }).first().click();
      await page.getByRole('button', { name: /^Edit world$/ }).first().click();
    }
    // The editor's own tab row (the app nav also has a "Settings").
    const tabs = page.getByRole('button', { name: /^Context$/ }).locator('xpath=..');
    await tabs.getByRole('button', { name: /^Settings$/ }).click();
    await page.getByText(/Game rules on/).waitFor({ timeout: 6000 });
    await page.getByText('Living memory').waitFor({ timeout: 4000 });
    await page.getByText(/^Carried/).first().scrollIntoViewIfNeeded();
    await shot('rules');
    await fits('world editor settings');
    await page.keyboard.press('Escape');
  });
  await step('cast card shows what Ada remembers', async () => {
    await page.evaluate(async () => {
      const { useApp } = await import('/src/store/app.ts');
      useApp.getState().go('cast');
    });
    await page.getByText('Ada', { exact: true }).first().click();
    await page.getByRole('button', { name: 'Remembers' }).first().click();
    await page.getByText('Rowan broke into her archive', { exact: false }).waitFor({ timeout: 4000 });
    await shot('remembers');
  });
  await step('appearance parts open from chips and keep their text', async () => {
    await page.getByRole('button', { name: 'Persona' }).first().click();
    await page.getByRole('group', { name: 'Add to appearance' }).waitFor({ timeout: 4000 });
    await page.getByRole('button', { name: '+ Hair' }).click();
    const hair = page.locator('#look-hair');
    await hair.fill('Black with a silver streak');
    await page.getByRole('button', { name: '+ Clothing' }).click();
    await page.locator('#look-clothing').fill('Long grey coat');
    await hair.click();
    await page.locator('#look-face').count().then((n) => { if (n) throw new Error('face opened without a tap'); });
    // Leave the box: text stays, and the chip for Hair is gone.
    await page.getByRole('textbox', { name: 'Appearance: overall' }).click();
    await page.waitForTimeout(700);
    if ((await hair.inputValue()) !== 'Black with a silver streak') throw new Error('hair text lost on blur');
    if (await page.getByRole('button', { name: '+ Hair' }).count()) throw new Error('hair chip still shown');
    await page.getByRole('button', { name: '+ Intimate (18+)' }).waitFor({ timeout: 4000 });
    if (await page.getByRole('button', { name: '+ Intimate (18+)' }).isDisabled()) throw new Error('intimate locked for an adult');
    await page.getByText('wearing now', { exact: true }).waitFor({ timeout: 4000 });
    await shot('appearance');
    await fits('character card');
  });
  await step('intimate section is locked for someone who reads under 18', async () => {
    await page.getByText('Pip', { exact: true }).first().click();
    await page.getByRole('button', { name: 'Persona' }).first().click();
    const chip = page.getByRole('button', { name: '+ Intimate (18+)' });
    await chip.waitFor({ timeout: 4000 });
    if (!(await chip.isDisabled())) throw new Error('intimate chip enabled for a 15-year-old');
    await page.getByText('Ada', { exact: true }).first().click();
  });
  await step('cast card offers full body, a scene box, and its own gallery', async () => {
    await page.getByRole('radio', { name: 'Full body' }).click();
    await page.getByRole('button', { name: 'Generate full body' }).waitFor({ timeout: 4000 });
    await page.getByRole('textbox', { name: 'Scene or pose' }).fill('reading by lamplight at the docks');
    await page.getByRole('button', { name: 'Generate scene' }).waitFor({ timeout: 4000 });
    await page.getByRole('list', { name: 'Full body and scene pictures' }).getByRole('listitem').first().waitFor({ timeout: 4000 });
    // A figure never becomes the avatar: Ada has no main photo.
    if (await page.getByRole('button', { name: 'Main photo, used as the avatar' }).count()) throw new Error('figure became the main photo');
    await page.getByRole('button', { name: 'Open picture 1' }).click();
    await page.getByRole('dialog', { name: 'Picture' }).waitFor({ timeout: 4000 });
    await shot('figure-open');
    await page.getByRole('dialog', { name: 'Picture' }).click();
    await page.getByRole('radio', { name: 'Head & shoulders' }).click();
    await page.getByRole('textbox', { name: 'Scene or pose' }).fill('');
    await shot('portrait-tools');
    await fits('portrait tools');
  });

  const serious = errors.filter((e) => !/favicon|manifest|service worker|sw\.js|workbox/i.test(e));
  await step('no page errors', async () => {
    if (serious.length) throw new Error(serious.slice(0, 3).join(' | '));
  });
  await page.close();
}

const server = spawn(`npx vite --port ${PORT} --strictPort`, {
  shell: true, stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

let browser;
try {
  await waitForServer(BASE);
  browser = await chromium.launch();
  for (const name of DEVICE_NAMES) await run(browser, name, DEVICES[name]);
} catch (e) {
  results.push({ name: 'setup', ok: false, error: String(e?.message ?? e) });
  if (serverLog) console.error(serverLog.slice(-2000));
} finally {
  await browser?.close();
  if (process.platform === 'win32') spawn(`taskkill /pid ${server.pid} /T /F`, { shell: true });
  else server.kill('SIGTERM');
}

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.error}`}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
