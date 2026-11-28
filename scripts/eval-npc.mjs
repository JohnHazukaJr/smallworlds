/**
 * NPC eval: replays fixed scenes (src/eval/scenarios.ts) through the real
 * writeTurn in a browser, then grades each reply with rule checks and an LLM
 * judge. Use it before and after a prompt or engine change to see whether NPCs
 * got better or worse, instead of finding out by playing.
 *
 *   EVAL_API_KEY=... EVAL_MODEL=z-ai/glm-5.2 npm run eval
 *
 * Settings (environment, or KEY=value lines in .env.eval.local):
 *   EVAL_API_KEY        required. Sent only to the provider below.
 *   EVAL_MODEL          required. The prose model under test.
 *   EVAL_PROVIDER       openrouter (default) | anthropic | openai | custom
 *   EVAL_BASE_URL       override the provider URL (required for custom)
 *   EVAL_KIND           openai | anthropic | gemini, for custom (default openai)
 *   EVAL_UTILITY_MODEL  director/utility model (default: EVAL_MODEL)
 *   EVAL_JUDGE_MODEL    judge model (default: EVAL_UTILITY_MODEL). Keep it fixed across runs.
 *   EVAL_RUNS           times to run each scene (default 1; 3 smooths out luck)
 *   EVAL_ONLY           comma list of scenario ids
 *   EVAL_NO_JUDGE=1     rule checks only (cheaper)
 *   EVAL_CONCURRENCY    scenes in flight at once (default 2)
 *   EVAL_OUT            output folder (default eval-results/<timestamp>)
 *   EVAL_BASELINE       a previous results.json to compare against
 *   EVAL_STRICT=1       exit 1 when any rule check fails or a scene errors
 *   EVAL_SCENE_TIMEOUT_MIN  give up on one scene after this many minutes (default 15)
 *
 * Writes results.json (everything, minus the key) and report.md.
 */

import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

// ---------- config ----------

if (existsSync('.env.eval.local')) {
  for (const line of readFileSync('.env.eval.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const env = process.env;

const PROVIDERS = {
  openrouter: { kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1' },
  anthropic: { kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' },
  openai: { kind: 'openai', baseUrl: 'https://api.openai.com/v1' },
  custom: { kind: env.EVAL_KIND || 'openai', baseUrl: '' }
};
const providerName = (env.EVAL_PROVIDER || 'openrouter').toLowerCase();
const preset = PROVIDERS[providerName];
if (!preset) fail(`Unknown EVAL_PROVIDER "${providerName}". Use: ${Object.keys(PROVIDERS).join(', ')}`);
const baseUrl = env.EVAL_BASE_URL || preset.baseUrl;
if (!baseUrl) fail('EVAL_BASE_URL is required for a custom provider.');
if (!env.EVAL_API_KEY) fail('Set EVAL_API_KEY (or put it in .env.eval.local).');
if (!env.EVAL_MODEL) fail('Set EVAL_MODEL to the prose model under test.');

const utilityModel = env.EVAL_UTILITY_MODEL || env.EVAL_MODEL;
const cfg = {
  kind: env.EVAL_KIND || preset.kind,
  baseUrl,
  apiKey: env.EVAL_API_KEY,
  proseModel: env.EVAL_MODEL,
  utilityModel,
  judgeModel: env.EVAL_JUDGE_MODEL || utilityModel,
  noJudge: env.EVAL_NO_JUDGE === '1'
};
const RUNS = Math.max(1, Number(env.EVAL_RUNS || 1));
const CONCURRENCY = Math.max(1, Number(env.EVAL_CONCURRENCY || 2));
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = env.EVAL_OUT || join('eval-results', stamp);

function fail(message) {
  console.error(message);
  process.exit(2);
}

// ---------- server ----------

const PORT = 5198;
/** Per scene. A multi-turn scene on a slow model takes a few minutes; an hour means something hung. */
const SCENE_TIMEOUT_MS = Math.max(60_000, Number(env.EVAL_SCENE_TIMEOUT_MIN || 15) * 60_000);
const BASE = `http://localhost:${PORT}/`;

async function waitForServer(url, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`dev server did not start at ${url}`);
}

// ---------- run ----------

async function runOne(browser, id, run) {
  // A fresh context per scene: empty IndexedDB, empty localStorage.
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');
    // One stuck scene must not hold the whole run: it is recorded as an error and the next begins.
    let timer;
    const cap = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`scene timed out after ${SCENE_TIMEOUT_MS / 60_000} min`)), SCENE_TIMEOUT_MS);
    });
    const result = await Promise.race([
      page.evaluate(async ({ id, cfg }) => {
        const mod = await import('/src/eval/runInPage.ts');
        return mod.runScenario(id, cfg);
      }, { id, cfg }),
      cap
    ]).finally(() => clearTimeout(timer));
    return { ...result, run, pageErrors: errors.slice(0, 3) };
  } catch (e) {
    return { scenarioId: id, run, error: String(e?.message ?? e).split('\n')[0], pieces: [], checks: [], notices: [], pageErrors: errors.slice(0, 3) };
  } finally {
    await context.close();
  }
}

async function pool(jobs, n, task) {
  const out = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await task(jobs[i], i);
    }
  }));
  return out;
}

// ---------- report ----------

/**
 * Background utility passes (live memory, summaries) that failed to parse, counted from the
 * page console the dev server forwards. They never fail a scene, so without this they go unseen.
 */
function utilityFailures(log) {
  const out = {};
  for (const m of log.matchAll(/\[parse\] ([a-z][a-z -]*?) (?:The model|$)/gim)) {
    const key = m[1].trim();
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function utilityLine(failures) {
  const entries = Object.entries(failures ?? {});
  if (!entries.length) return 'Utility passes: no parse failures';
  return `**Utility parse failures:** ${entries.map(([k, n]) => `${k} ×${n}`).join(', ')} — story memory is not updating on this utility model`;
}

const DIMS = ['voice', 'character', 'address', 'walls', 'agency', 'craft'];
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const fmt = (x) => (Number.isFinite(x) ? x.toFixed(1) : '–');
const delta = (now, then) => {
  if (!Number.isFinite(now) || !Number.isFinite(then)) return '';
  const d = now - then;
  if (Math.abs(d) < 0.05) return ' (=)';
  return ` (${d > 0 ? '+' : ''}${d.toFixed(1)})`;
};

function summarize(results) {
  const by = new Map();
  for (const r of results) {
    if (!by.has(r.scenarioId)) by.set(r.scenarioId, []);
    by.get(r.scenarioId).push(r);
  }
  const rows = [];
  for (const [id, rs] of by) {
    const checks = rs.flatMap((r) => r.checks);
    const verdicts = rs.map((r) => r.verdict).filter(Boolean);
    const dims = Object.fromEntries(DIMS.map((d) => [d, mean(verdicts.map((v) => v.scores[d]).filter((x) => x > 0))]));
    rows.push({
      id,
      runs: rs.length,
      errors: rs.filter((r) => r.error).length,
      fails: checks.filter((c) => c.status === 'fail').length,
      warns: checks.filter((c) => c.status === 'warn').length,
      dims,
      overall: mean(DIMS.map((d) => dims[d]).filter(Number.isFinite)),
      ms: mean(rs.filter((r) => r.ms).map((r) => r.ms))
    });
  }
  return rows;
}

function report(meta, results, baseline) {
  const rows = summarize(results);
  const base = baseline ? new Map(summarize(baseline.results).map((r) => [r.id, r])) : new Map();
  const allChecks = results.flatMap((r) => r.checks);
  const overall = mean(rows.map((r) => r.overall).filter(Number.isFinite));
  const baseOverall = baseline ? mean([...base.values()].map((r) => r.overall).filter(Number.isFinite)) : NaN;

  const lines = [
    `# NPC eval — ${meta.date}`,
    '',
    `Prose \`${meta.proseModel}\` · utility \`${meta.utilityModel}\` · judge \`${meta.judgeModel}\` · ${meta.runs} run(s) each · commit \`${meta.commit}\`${meta.dirty ? ' (uncommitted changes)' : ''}`,
    baseline ? `Compared with ${baseline.meta.date} (commit \`${baseline.meta.commit}\`, prose \`${baseline.meta.proseModel}\`).` : '',
    '',
    `**Judge mean ${fmt(overall)}/5${delta(overall, baseOverall)}** · rule checks: ${allChecks.filter((c) => c.status === 'fail').length} failed, ${allChecks.filter((c) => c.status === 'warn').length} warned, ${allChecks.filter((c) => c.status === 'pass').length} passed · ${results.filter((r) => r.error).length} errored`,
    utilityLine(meta.utilityFailures),
    '',
    `| Scene | Fail | Warn | ${DIMS.join(' | ')} | Mean |`,
    `|---|---|---|${DIMS.map(() => '---').join('|')}|---|`,
    ...rows.map((r) => {
      const b = base.get(r.id);
      const cells = DIMS.map((d) => `${fmt(r.dims[d])}${b ? delta(r.dims[d], b.dims[d]) : ''}`);
      const err = r.errors ? ` ⚠ ${r.errors} error` : '';
      return `| ${r.id}${err} | ${r.fails} | ${r.warns} | ${cells.join(' | ')} | **${fmt(r.overall)}**${b ? delta(r.overall, b.overall) : ''} |`;
    }),
    ''
  ];

  const flagged = results.filter((r) => r.error || r.judgeError || r.checks.some((c) => c.status !== 'pass') || (r.verdict && DIMS.some((d) => r.verdict.scores[d] > 0 && r.verdict.scores[d] <= 2)));
  if (flagged.length) {
    lines.push('## Needs a look', '');
    for (const r of flagged) {
      lines.push(`### ${r.scenarioId} · run ${r.run}`);
      if (r.error) lines.push(`- **error:** ${r.error}`);
      if (r.judgeError) lines.push(`- **judge error:** ${r.judgeError}`);
      for (const c of r.checks.filter((c) => c.status !== 'pass')) lines.push(`- **${c.status}** \`${c.id}\`: ${c.detail}`);
      if (r.verdict) {
        const low = DIMS.filter((d) => r.verdict.scores[d] > 0 && r.verdict.scores[d] <= 2);
        for (const d of low) lines.push(`- judge **${d} ${r.verdict.scores[d]}**: ${r.verdict.notes[d] ?? ''}`);
        if (r.verdict.worst && r.verdict.worst !== 'none') lines.push(`- worst: ${r.verdict.worst}`);
      }
      if (r.notices?.length) lines.push(`- engine notices: ${r.notices.join(' / ')}`);
      if (r.earlier?.length) {
        lines.push('', `Earlier turns (${r.earlier.length}):`, '```');
        for (const e of r.earlier) {
          lines.push(`> ${e.input}`);
          for (const p of e.pieces) lines.push(`[${p.role === 'character' ? (p.name ?? p.who ?? '?') : 'Narrator'}] ${p.text.trim()}`);
        }
        lines.push('```', 'Graded reply:');
      }
      if (r.pieces?.length) {
        lines.push('', '```');
        for (const p of r.pieces) lines.push(`[${p.role === 'character' ? (p.name ?? p.who ?? '?') : 'Narrator'}] ${p.text.trim()}`);
        lines.push('```');
      }
      lines.push('');
    }
  }
  return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}

// ---------- main ----------

function git(cmd) {
  try { return execSync(`git ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; }
}

const server = spawn(`npx vite --port ${PORT} --strictPort`, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
server.on('exit', (code, signal) => { serverLog += `
[eval] dev server exited (code ${code}, signal ${signal}) at ${new Date().toISOString()}
`; });

let browser;
let exitCode = 0;
try {
  await waitForServer(BASE);
  browser = await chromium.launch();

  const probe = await browser.newPage();
  await probe.goto(BASE);
  const all = await probe.evaluate(async () => (await import('/src/eval/runInPage.ts')).scenarioIds());
  await probe.close();
  const only = (env.EVAL_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = only.filter((id) => !all.includes(id));
  if (unknown.length) throw new Error(`Unknown scenario(s): ${unknown.join(', ')}. Known: ${all.join(', ')}`);
  const ids = only.length ? only : all;

  const jobs = ids.flatMap((id) => Array.from({ length: RUNS }, (_, run) => ({ id, run: run + 1 })));
  console.log(`Running ${jobs.length} scene(s) on ${cfg.proseModel} (judge: ${cfg.noJudge ? 'off' : cfg.judgeModel})…`);
  let done = 0;
  const results = await pool(jobs, CONCURRENCY, async (job) => {
    const r = await runOne(browser, job.id, job.run);
    done += 1;
    const fails = r.checks.filter((c) => c.status === 'fail').length;
    const score = r.verdict ? mean(DIMS.map((d) => r.verdict.scores[d]).filter((x) => x > 0)) : NaN;
    console.log(`  [${done}/${jobs.length}] ${job.id}#${job.run}  ${r.error ? `ERROR ${r.error}` : `${fails ? `${fails} fail` : 'rules ok'}${Number.isFinite(score) ? ` · judge ${score.toFixed(1)}` : ''}`}`);
    return r;
  });

  const meta = {
    date: new Date().toISOString(),
    commit: git('rev-parse --short HEAD'),
    dirty: !!git('status --porcelain'),
    provider: providerName,
    proseModel: cfg.proseModel,
    utilityModel: cfg.utilityModel,
    judgeModel: cfg.noJudge ? null : cfg.judgeModel,
    runs: RUNS,
    utilityFailures: utilityFailures(serverLog)
  };
  const baseline = env.EVAL_BASELINE ? JSON.parse(readFileSync(env.EVAL_BASELINE, 'utf8')) : null;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'results.json'), JSON.stringify({ meta, results }, null, 2));
  const md = report(meta, results, baseline);
  writeFileSync(join(OUT, 'report.md'), md);
  console.log(`\n${md.split('\n## Needs a look')[0]}\nFull report: ${join(OUT, 'report.md')}`);
  if (env.EVAL_STRICT === '1' && results.some((r) => r.error || r.checks.some((c) => c.status === 'fail'))) exitCode = 1;
} catch (e) {
  console.error(String(e?.message ?? e));
  if (serverLog) console.error(serverLog.slice(-2000));
  exitCode = 2;
} finally {
  await browser?.close();
  try { mkdirSync(OUT, { recursive: true }); writeFileSync(join(OUT, 'server.log'), serverLog); } catch { /* best effort */ }
  // Synchronous, so the server is gone before this process exits.
  if (process.platform === 'win32') { try { execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: 'ignore' }); } catch { /* already gone */ } }
  else server.kill('SIGTERM');
}
process.exit(exitCode);
