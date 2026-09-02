/**
 * One place for “what this model can do” — windows, thinking, JSON, tools, token field.
 * Used by the chat client, context budget, and Settings hints.
 */

export type ChatJob = 'prose' | 'utility' | 'wrap' | 'test';

export interface ModelProfile {
  windowTokens: number;
  /** Can produce a hidden reasoning channel (GLM-5, o-series, R1, …). */
  reasoningCapable: boolean;
  /** Accepts `thinking: { type: enabled|disabled }` (GLM-5.x). */
  supportsThinkingToggle: boolean;
  /** Accepts `response_format: { type: 'json_object' }`. */
  supportsJsonObject: boolean;
  /** Accepts OpenAI-style `tools` / `tool_choice`. */
  supportsTools: boolean;
  /** GPT-5-class: use `max_completion_tokens` instead of `max_tokens`. */
  usesMaxCompletionTokens: boolean;
  /** Claude Sonnet 5 / Opus 4.7+ — omit temperature. */
  omitsSampling: boolean;
  isGlm: boolean;
  isGlm5: boolean;
}

const DEFAULT_WINDOW = 32_768;

function slug(model: string): string {
  return model.toLowerCase();
}

/** Explicit k/m suffixes in the model id, when present. */
export function windowFromSuffix(model: string): number | null {
  const m = slug(model);
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

export function isGlmFamily(model: string): boolean {
  const m = slug(model);
  return (
    m.includes('glm-') ||
    m.includes('glm_') ||
    /(?:^|[-_/])glm(?:[-_.]|$)/.test(m) ||
    m.includes('z-ai/glm') ||
    m.includes('zhipu/glm')
  );
}

export function isGlm5(model: string): boolean {
  const m = slug(model);
  return /\bglm[-_.]?5/.test(m) || m.includes('glm-5') || m.includes('glm_5');
}

export function omitsSamplingParams(model: string): boolean {
  const m = slug(model);
  if (!m.includes('claude')) return false;
  if (/sonnet[-_.]?5\b/.test(m) || /sonnet[-_.]?5\./.test(m)) return true;
  if (/opus[-_.]?4[-_.]?([7-9]|\d{2,})\b/.test(m)) return true;
  if (/opus[-_.]?([5-9])\b/.test(m)) return true;
  return false;
}

function inferWindow(model: string): number {
  const fromSuffix = windowFromSuffix(model);
  if (fromSuffix) return fromSuffix;

  const m = slug(model);
  if (m.includes('gemini')) return 1_048_576;
  if (isGlm5(model) || /\bglm[-_.]?5(?:\.\d)?/.test(m)) return 1_048_576;
  if (m.includes('claude')) return 200_000;
  if (/\bgpt-5/.test(m) || m.includes('gpt5')) return 400_000;
  if (m.includes('gpt-4.1') || m.includes('gpt-4-1')) return 1_048_576;
  if (m.includes('gpt-4o')) return 128_000;
  if (m.includes('llama-3.1') || m.includes('llama-3-1') || m.includes('llama3.1')) return 128_000;
  if (m.includes('llama-4') || m.includes('llama4')) return 128_000;
  return DEFAULT_WINDOW;
}

function reasoningCapable(model: string): boolean {
  const m = slug(model);
  return (
    m.includes('reasoner') ||
    m.includes('thinking') ||
    /(?:^|[-_/])r1(?:$|[-_/])/.test(m) ||
    /(?:^|[-_/])o1(?:$|[-_/])/.test(m) ||
    /(?:^|[-_/])o3(?:$|[-_/])/.test(m) ||
    m.includes('think') ||
    isGlm5(model)
  );
}

export function modelProfile(model: string): ModelProfile {
  const m = slug(model);
  const glm = isGlmFamily(model);
  const glm5 = isGlm5(model);
  const gpt5 = /\bgpt-5/.test(m) || m.includes('gpt5');
  const oSeries = /(?:^|[-_/])o1(?:$|[-_/])/.test(m) || /(?:^|[-_/])o3(?:$|[-_/])/.test(m);
  return {
    windowTokens: inferWindow(model),
    reasoningCapable: reasoningCapable(model),
    supportsThinkingToggle: glm5,
    supportsJsonObject: glm || gpt5 || m.includes('gpt-4o') || m.includes('gpt-4.1') || m.includes('deepseek'),
    supportsTools: glm || gpt5 || m.includes('gpt-4') || m.includes('deepseek') || m.includes('claude'),
    usesMaxCompletionTokens: gpt5 || oSeries,
    omitsSampling: omitsSamplingParams(model),
    isGlm: glm,
    isGlm5: glm5
  };
}

/** Thinking on only for wrap/season/compact. Prose, director, live canon, tests stay off. */
export function thinkingOnForJob(model: string, job: ChatJob): boolean {
  const p = modelProfile(model);
  if (!p.supportsThinkingToggle) return false;
  return job === 'wrap';
}

/** Extra output reserve only when this call will actually think. */
export function shouldReserveReasoningTokens(model: string, thinkingOn: boolean): boolean {
  return thinkingOn && modelProfile(model).reasoningCapable;
}
