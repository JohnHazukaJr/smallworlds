import type { ProviderConfig } from '../types';
import {
  modelProfile,
  thinkingOnForJob,
  type ChatJob
} from './modelProfile';
import { isZaiProvider, providerFetch } from './providerFetch';

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type { ChatJob };

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
  job?: ChatJob;
  thinking?: boolean;
  jsonMode?: boolean;
  tools?: ToolSpec[];
  toolChoice?: 'auto' | { name: string };
}

/** Full streamed text plus whether the provider stopped for length. */
export interface StreamResult {
  text: string;
  truncated: boolean;
  toolCalls?: Array<{ name: string; arguments: string }>;
  sawReasoning?: boolean;
}

export class AIError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = 'AIError';
  }
}

export function isContextOverflowError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  if (msg.includes('context_length_exceeded')) return true;
  if (msg.includes('context length')) return true;
  if (msg.includes('maximum context')) return true;
  if (msg.includes('prompt is too long')) return true;
  if (msg.includes('too many tokens')) return true;
  if (msg.includes('token limit')) return true;
  if (msg.includes('too long') && (msg.includes('context') || msg.includes('prompt') || msg.includes('request'))) {
    return true;
  }
  return false;
}

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
    'If this keeps happening deep in a season, the context is likely too large — wrap the episode or choose a shorter reply size.'
  );
}

export function modelOmitsSamplingParams(model: string): boolean {
  return modelProfile(model).omitsSampling;
}

function withTemperature<T extends Record<string, unknown>>(
  body: T,
  model: string,
  temperature: number | undefined
): T {
  if (modelOmitsSamplingParams(model)) return body;
  return { ...body, temperature: temperature ?? 0.9 };
}

const PROMPT_CACHE_CONTROL = { type: 'ephemeral' as const };
const PROMPT_CACHE_BETA = 'prompt-caching-2024-07-31';

function isOpenRouter(provider: ProviderConfig): boolean {
  return provider.baseUrl.includes('openrouter.ai');
}

function isClaudeModel(model: string): boolean {
  const m = model.toLowerCase();
  return m.includes('claude') || m.includes('anthropic/');
}

export function supportsAnthropicPromptCache(provider: ProviderConfig, model: string): boolean {
  if (provider.kind === 'anthropic') return true;
  return provider.kind === 'openai' && isOpenRouter(provider) && isClaudeModel(model);
}

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

function retryDelayMs(res: Response | null): number {
  const raw = res?.headers?.get('Retry-After');
  if (raw) {
    const sec = Number(raw);
    if (Number.isFinite(sec) && sec >= 0) return Math.min(Math.max(sec * 1000, 200), 10_000);
  }
  return 800;
}

export function resolveThinking(req: Pick<StreamRequest, 'model' | 'job' | 'thinking'>): boolean {
  if (req.thinking !== undefined) return req.thinking;
  return thinkingOnForJob(req.model, req.job ?? 'prose');
}

/** Build the OpenAI-compatible chat body (exported for tests). */
export function buildOpenAIChatBody(req: StreamRequest): Record<string, unknown> {
  const profile = modelProfile(req.model);
  const thinking = resolveThinking(req);
  const cacheSystem = supportsAnthropicPromptCache(req.provider, req.model);
  const systemMessage = cacheSystem
    ? { role: 'system' as const, content: [cachedSystemBlock(req.system)] }
    : { role: 'system' as const, content: req.system };

  const body: Record<string, unknown> = {
    model: req.model,
    stream: true,
    messages: [systemMessage, ...req.messages]
  };
  if (profile.usesMaxCompletionTokens) body.max_completion_tokens = req.maxTokens;
  else body.max_tokens = req.maxTokens;

  if (profile.supportsThinkingToggle) {
    body.thinking = { type: thinking ? 'enabled' : 'disabled' };
    if (thinking) body.reasoning_effort = 'high';
  }
  if (req.jsonMode && profile.supportsJsonObject && !req.tools?.length) {
    body.response_format = { type: 'json_object' };
  }
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters }
    }));
    if (req.toolChoice && req.toolChoice !== 'auto') {
      body.tool_choice = { type: 'function', function: { name: req.toolChoice.name } };
    } else if (req.toolChoice === 'auto') {
      body.tool_choice = 'auto';
    }
  }
  return withTemperature(body, req.model, req.temperature);
}

function openaiHeaders(provider: ProviderConfig): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  if (isOpenRouter(provider)) {
    headers['HTTP-Referer'] = 'https://smallworlds.local';
    headers['X-Title'] = 'Small Worlds AI';
  }
  if (isZaiProvider(provider)) {
    headers['Accept-Language'] = 'en-US,en';
  }
  return headers;
}

async function streamChatOnce(req: StreamRequest): Promise<StreamResult> {
  switch (req.provider.kind) {
    case 'openai': return streamOpenAI(req);
    case 'anthropic': return streamAnthropic(req);
    case 'gemini': return streamGemini(req);
  }
}

function resultEmpty(r: StreamResult): boolean {
  return !r.text.trim() && !(r.toolCalls && r.toolCalls.length > 0);
}

/**
 * Stream a chat completion from any configured provider.
 * One automatic retry on 429 / transient 5xx / network failure.
 * Empty thinking streams retry once (thinking off for prose/test; more output for utility/wrap).
 */
export async function streamChat(req: StreamRequest): Promise<StreamResult> {
  const run = (next: StreamRequest) => streamChatOnce(next);
  try {
    const first = await run(req);
    if (!resultEmpty(first)) return first;
    const thinking = resolveThinking(req);
    if (!thinking || req.signal?.aborted) {
      throwEmptyResponse('', first.sawReasoning ?? false);
    }
    const job = req.job ?? 'prose';
    if (job === 'prose' || job === 'test') {
      return run({ ...req, thinking: false });
    }
    return run({ ...req, maxTokens: Math.max(req.maxTokens + 2000, Math.floor(req.maxTokens * 1.5)) });
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
    return run(req);
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
  if (isRetryableStatus(res.status)) {
    (err as AIError & { retryAfterMs?: number }).retryAfterMs = retryDelayMs(res);
  }
  throw err;
}

function contentPiece(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw.map((p: { text?: string }) => p?.text ?? '').join('');
  }
  return '';
}

async function streamOpenAI(req: StreamRequest): Promise<StreamResult> {
  const url = `${req.provider.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const res = await providerFetch(url, {
    method: 'POST',
    headers: openaiHeaders(req.provider),
    signal: req.signal,
    body: JSON.stringify(buildOpenAIChatBody(req))
  });
  if (!res.ok) await throwHttpError(res);
  let full = '';
  let truncated = false;
  let finishReason = '';
  let sawReasoning = false;
  const toolBuf: Record<number, { name: string; arguments: string }> = {};
  await readSSE(res, (data) => {
    try {
      const json = JSON.parse(data);
      const choice = json.choices?.[0];
      const delta = choice?.delta;
      const piece = contentPiece(delta?.content ?? choice?.message?.content ?? delta?.text);
      if (delta?.reasoning || delta?.reasoning_content || choice?.message?.reasoning_content) {
        sawReasoning = true;
      }
      if (piece) {
        full += piece;
        req.onDelta?.(piece);
      }
      const calls = delta?.tool_calls as Array<{
        index?: number;
        function?: { name?: string; arguments?: string };
      }> | undefined;
      if (Array.isArray(calls)) {
        for (const c of calls) {
          const i = c.index ?? 0;
          if (!toolBuf[i]) toolBuf[i] = { name: '', arguments: '' };
          if (c.function?.name) toolBuf[i].name += c.function.name;
          if (c.function?.arguments) toolBuf[i].arguments += c.function.arguments;
        }
      }
      const reason: string | undefined = choice?.finish_reason;
      if (reason) finishReason = reason;
      if (isLengthStop(reason)) truncated = true;
    } catch { /* keep-alive or malformed chunk */ }
  });
  const toolCalls = Object.values(toolBuf).filter((t) => t.name || t.arguments);
  if (!full.trim() && toolCalls.length === 0) throwEmptyResponse(finishReason, sawReasoning);
  return {
    text: full,
    truncated,
    sawReasoning,
    ...(toolCalls.length ? { toolCalls } : {})
  };
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
  const res = await providerFetch(`${req.provider.baseUrl.replace(/\/$/, '')}/messages`, {
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
  const url = `${req.provider.baseUrl.replace(/\/$/, '')}/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(req.provider.apiKey)}`;
  const res = await providerFetch(url, {
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
  return { text: full, truncated, sawReasoning: sawThought };
}

export async function testConnection(provider: ProviderConfig, model: string): Promise<{ ok: true; ms: number }> {
  const started = performance.now();
  await streamChat({
    provider,
    model,
    system: 'You are a connection test. Reply with the single word: ok',
    messages: [{ role: 'user', content: 'ping' }],
    maxTokens: 32,
    temperature: 0,
    job: 'test',
    thinking: false
  });
  return { ok: true, ms: Math.round(performance.now() - started) };
}
