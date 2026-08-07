import type { ProviderConfig } from '../types';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface StreamRequest {
  provider: ProviderConfig;
  model: string;
  system: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
}

/** Full streamed text plus whether the provider stopped for length. */
export interface StreamResult {
  text: string;
  truncated: boolean;
}

export class AIError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = 'AIError';
  }
}

/** Empty stream — usually context overflow, refusal, or a reasoning model spending all tokens. */
function throwEmptyResponse(finishReason: string, sawReasoning: boolean): never {
  const reason = finishReason ? ` (stop: ${finishReason})` : '';
  if (sawReasoning || isLengthStop(finishReason)) {
    throw new AIError(
      `The model returned an empty response${reason}. ` +
      'The prompt may be too long for this model mid-season, or a reasoning model used its token budget on thinking. ' +
      'Try again, wrap the episode, or pick a larger-context model in Settings.'
    );
  }
  throw new AIError(
    `The model returned an empty response${reason}. ` +
    'If this keeps happening deep in a season, the context is likely too large — wrap the episode or shorten Display length.'
  );
}

/**
 * Claude Sonnet 5 / Opus 4.7+ reject non-default sampling params with 400.
 * Match both direct Anthropic ids and OpenRouter-style `anthropic/...` slugs.
 */
export function modelOmitsSamplingParams(model: string): boolean {
  const m = model.toLowerCase();
  if (!m.includes('claude')) return false;
  if (/sonnet[-_.]?5\b/.test(m) || /sonnet[-_.]?5\./.test(m)) return true;
  // Opus 4.7+ and any Opus 5+
  if (/opus[-_.]?4[-_.]?([7-9]|\d{2,})\b/.test(m)) return true;
  if (/opus[-_.]?([5-9])\b/.test(m)) return true;
  return false;
}

/** Attach temperature only when the model accepts it. */
function withTemperature<T extends Record<string, unknown>>(
  body: T,
  model: string,
  temperature: number | undefined
): T {
  if (modelOmitsSamplingParams(model)) return body;
  return { ...body, temperature: temperature ?? 0.9 };
}

/** Anthropic ephemeral prompt cache breakpoint on a text block. */
const PROMPT_CACHE_CONTROL = { type: 'ephemeral' as const };
const PROMPT_CACHE_BETA = 'prompt-caching-2024-07-31';

function isOpenRouter(provider: ProviderConfig): boolean {
  return provider.baseUrl.includes('openrouter.ai');
}

function isClaudeModel(model: string): boolean {
  const m = model.toLowerCase();
  return m.includes('claude') || m.includes('anthropic/');
}

/**
 * True when we can attach Anthropic-style cache_control to the system prompt:
 * direct Anthropic, or OpenRouter Claude (passthrough).
 */
export function supportsAnthropicPromptCache(provider: ProviderConfig, model: string): boolean {
  if (provider.kind === 'anthropic') return true;
  return provider.kind === 'openai' && isOpenRouter(provider) && isClaudeModel(model);
}

/** Single system text block with an ephemeral cache breakpoint. */
function cachedSystemBlock(text: string) {
  return { type: 'text' as const, text, cache_control: PROMPT_CACHE_CONTROL };
}

function isLengthStop(reason: string | undefined | null): boolean {
  if (!reason) return false;
  const r = reason.toUpperCase();
  return r === 'LENGTH' || r === 'MAX_TOKENS' || r === 'MAX_TOKEN' || r === 'MAXTOKENS';
}

function isRetryableStatus(status: number | undefined): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const t = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Delay before a single retry; honor Retry-After seconds when present (capped). */
function retryDelayMs(res: Response | null): number {
  const raw = res?.headers?.get('Retry-After');
  if (raw) {
    const sec = Number(raw);
    if (Number.isFinite(sec) && sec >= 0) return Math.min(Math.max(sec * 1000, 200), 10_000);
  }
  return 800;
}

async function streamChatOnce(req: StreamRequest): Promise<StreamResult> {
  switch (req.provider.kind) {
    case 'openai': return streamOpenAI(req);
    case 'anthropic': return streamAnthropic(req);
    case 'gemini': return streamGemini(req);
  }
}

/**
 * Stream a chat completion from any configured provider.
 * One automatic retry on 429 / transient 5xx / network failure.
 */
export async function streamChat(req: StreamRequest): Promise<StreamResult> {
  try {
    return await streamChatOnce(req);
  } catch (e) {
    if (req.signal?.aborted) throw e;
    if ((e as Error)?.name === 'AbortError') throw e;

    const status = e instanceof AIError ? e.status : undefined;
    const network =
      e instanceof TypeError ||
      (e instanceof Error && /failed to fetch|network/i.test(e.message));
    if (!isRetryableStatus(status) && !network) throw e;

    const fromHeader = (e as AIError & { retryAfterMs?: number }).retryAfterMs;
    await sleep(fromHeader ?? 800, req.signal);
    return streamChatOnce(req);
  }
}

async function readSSE(
  res: Response,
  onEvent: (data: string) => void
): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data:')) {
        const data = trimmed.slice(5).trim();
        if (data && data !== '[DONE]') onEvent(data);
      }
    }
  }
}

async function throwHttpError(res: Response): Promise<never> {
  let detail = '';
  try {
    const body = await res.json();
    detail = body?.error?.message ?? body?.message ?? JSON.stringify(body);
  } catch {
    try { detail = await res.text(); } catch { /* ignore */ }
  }
  const err = new AIError(`${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`, res.status);
  // Stash Retry-After for the streamChat retry helper via a non-enumerable field.
  if (isRetryableStatus(res.status)) {
    (err as AIError & { retryAfterMs?: number }).retryAfterMs = retryDelayMs(res);
  }
  throw err;
}

async function streamOpenAI(req: StreamRequest): Promise<StreamResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (req.provider.apiKey) headers['Authorization'] = `Bearer ${req.provider.apiKey}`;
  if (isOpenRouter(req.provider)) {
    headers['HTTP-Referer'] = 'https://smallworlds.local';
    headers['X-Title'] = 'Small Worlds AI';
  }
  const cacheSystem = supportsAnthropicPromptCache(req.provider, req.model);
  const systemMessage = cacheSystem
    ? { role: 'system' as const, content: [cachedSystemBlock(req.system)] }
    : { role: 'system' as const, content: req.system };
  const res = await fetch(`${req.provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    signal: req.signal,
    body: JSON.stringify(withTemperature({
      model: req.model,
      stream: true,
      max_tokens: req.maxTokens,
      messages: [systemMessage, ...req.messages]
    }, req.model, req.temperature))
  });
  if (!res.ok) await throwHttpError(res);
  let full = '';
  let truncated = false;
  let finishReason = '';
  let sawReasoning = false;
  await readSSE(res, (data) => {
    try {
      const json = JSON.parse(data);
      const choice = json.choices?.[0];
      const delta = choice?.delta;
      // Standard content; some routers put text under `text` or array parts.
      let piece = '';
      const raw = delta?.content ?? choice?.message?.content ?? delta?.text;
      if (typeof raw === 'string') piece = raw;
      else if (Array.isArray(raw)) {
        piece = raw.map((p: { text?: string }) => p?.text ?? '').join('');
      }
      if (delta?.reasoning || delta?.reasoning_content) sawReasoning = true;
      if (piece) {
        full += piece;
        req.onDelta?.(piece);
      }
      const reason: string | undefined = choice?.finish_reason;
      if (reason) finishReason = reason;
      if (isLengthStop(reason)) truncated = true;
    } catch { /* keep-alive or malformed chunk */ }
  });
  if (!full.trim()) throwEmptyResponse(finishReason, sawReasoning);
  return { text: full, truncated };
}

async function streamAnthropic(req: StreamRequest): Promise<StreamResult> {
  const cacheSystem = supportsAnthropicPromptCache(req.provider, req.model);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': req.provider.apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true'
  };
  if (cacheSystem) headers['anthropic-beta'] = PROMPT_CACHE_BETA;
  const res = await fetch(`${req.provider.baseUrl}/messages`, {
    method: 'POST',
    signal: req.signal,
    headers,
    body: JSON.stringify(withTemperature({
      model: req.model,
      stream: true,
      max_tokens: req.maxTokens,
      system: cacheSystem ? [cachedSystemBlock(req.system)] : req.system,
      messages: req.messages
    }, req.model, req.temperature))
  });
  if (!res.ok) await throwHttpError(res);
  let full = '';
  let truncated = false;
  let finishReason = '';
  await readSSE(res, (data) => {
    try {
      const json = JSON.parse(data);
      if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
        full += json.delta.text;
        req.onDelta?.(json.delta.text);
      }
      // Final chunk: { type: 'message_delta', delta: { stop_reason: 'max_tokens' | 'end_turn' | ... } }
      if (json.type === 'message_delta') {
        const reason: string | undefined = json.delta?.stop_reason ?? json.stop_reason;
        if (reason) finishReason = reason;
        if (isLengthStop(reason)) truncated = true;
      }
      if (json.type === 'error') throw new AIError(json.error?.message ?? 'Provider error');
    } catch (e) {
      if (e instanceof AIError) throw e;
    }
  });
  if (!full.trim()) throwEmptyResponse(finishReason, false);
  return { text: full, truncated };
}

async function streamGemini(req: StreamRequest): Promise<StreamResult> {
  const url = `${req.provider.baseUrl}/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(req.provider.apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    signal: req.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: req.system }] },
      contents: req.messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      })),
      generationConfig: withTemperature({
        maxOutputTokens: req.maxTokens
      }, req.model, req.temperature)
    })
  });
  if (!res.ok) await throwHttpError(res);
  let full = '';
  let truncated = false;
  let finishReason = '';
  let sawThought = false;
  await readSSE(res, (data) => {
    try {
      const json = JSON.parse(data);
      const parts: Array<{ text?: string; thought?: boolean }> =
        json.candidates?.[0]?.content?.parts ?? [];
      // Skip Gemini thinking parts — they pad or empty the visible stream.
      const text = parts
        .filter((p) => {
          if (p.thought) {
            sawThought = true;
            return false;
          }
          return true;
        })
        .map((p) => p.text ?? '')
        .join('');
      if (text) {
        full += text;
        req.onDelta?.(text);
      }
      const reason: string | undefined = json.candidates?.[0]?.finishReason;
      if (reason) finishReason = reason;
      if (isLengthStop(reason)) truncated = true;
    } catch { /* ignore malformed chunk */ }
  });
  if (!full.trim()) throwEmptyResponse(finishReason, sawThought);
  return { text: full, truncated };
}

/** Cheap non-streaming sanity check used by "Test connection". */
export async function testConnection(provider: ProviderConfig, model: string): Promise<{ ok: true; ms: number }> {
  const started = performance.now();
  await streamChat({
    provider,
    model,
    system: 'You are a connection test. Reply with the single word: ok',
    messages: [{ role: 'user', content: 'ping' }],
    maxTokens: 20,
    temperature: 0
  });
  return { ok: true, ms: Math.round(performance.now() - started) };
}
