/**
 * Infer a model's context window and a conservative prompt char budget.
 * Unknown ids default to 32k — the old 128k assumption overflowed smaller models.
 */

const DEFAULT_WINDOW = 32_768;
const CHARS_PER_TOKEN = 3.2;
const TOKENIZER_RESERVE = 1024;
const REASONING_OUTPUT_RESERVE = 4000;
const PROMPT_FLOOR_CHARS = 12_000;
const PROMPT_CAP_CHARS = 110_000;
const PROMPT_CAP_LARGE_CHARS = 180_000;

/** Explicit k/m suffixes in the model id, when present. */
function windowFromSuffix(model: string): number | null {
  const m = model.toLowerCase();
  const hit = m.match(/(?:^|[^a-z0-9])(\d+)\s*([km])(?:-context)?(?:$|[^a-z0-9])/);
  if (!hit) {
    const named = m.match(/[-_/](\d+)k(?:[-_/]|$)/);
    if (named) {
      const n = Number(named[1]);
      if (n >= 4 && n <= 1024) return n * 1024;
    }
    return null;
  }
  const n = Number(hit[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return hit[2] === 'm' ? n * 1_000_000 : n * 1024;
}

export function inferContextWindowTokens(model: string): number {
  const fromSuffix = windowFromSuffix(model);
  if (fromSuffix) return fromSuffix;

  const m = model.toLowerCase();

  if (m.includes('gemini')) return 1_048_576;
  if (/\bglm[-_.]?5(?:\.\d)?/.test(m) || m.includes('glm-5.2') || m.includes('glm-5-2')) {
    return 1_048_576;
  }
  if (m.includes('claude')) return 200_000;
  if (/\bgpt-5/.test(m) || m.includes('gpt5')) return 400_000;
  if (m.includes('gpt-4.1') || m.includes('gpt-4-1')) return 1_048_576;
  if (m.includes('gpt-4o')) return 128_000;
  if (m.includes('llama-3.1') || m.includes('llama-3-1') || m.includes('llama3.1')) return 128_000;
  if (m.includes('llama-4') || m.includes('llama4')) return 128_000;

  return DEFAULT_WINDOW;
}

export function isReasoningModel(model: string): boolean {
  const m = model.toLowerCase();
  return (
    m.includes('reasoner') ||
    m.includes('thinking') ||
    /(?:^|[-_/])r1(?:$|[-_/])/.test(m) ||
    /(?:^|[-_/])o1(?:$|[-_/])/.test(m) ||
    /(?:^|[-_/])o3(?:$|[-_/])/.test(m) ||
    m.includes('think') ||
    /\bglm[-_.]?5/.test(m)
  );
}

/**
 * Character budget for system + history. Never shrinks the caller's maxTokens —
 * thinking models get extra output reserve instead.
 */
export function promptCharBudget(model: string, maxTokens: number): number {
  const window = inferContextWindowTokens(model);
  const reserve = TOKENIZER_RESERVE + (isReasoningModel(model) ? REASONING_OUTPUT_RESERVE : 0);
  const tokens = Math.max(0, window - Math.max(0, maxTokens) - reserve);
  const chars = Math.floor(tokens * CHARS_PER_TOKEN);
  const cap = window >= 128_000 ? PROMPT_CAP_LARGE_CHARS : PROMPT_CAP_CHARS;
  return Math.max(PROMPT_FLOOR_CHARS, Math.min(chars, cap));
}

export function isLargeContextWindow(model: string): boolean {
  return inferContextWindowTokens(model) >= 128_000;
}
