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

export class AIError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = 'AIError';
  }
}

/**
 * Stream a chat completion from any configured provider.
 * Resolves with the full response text; onDelta fires as tokens arrive.
 */
export async function streamChat(req: StreamRequest): Promise<string> {
  switch (req.provider.kind) {
    case 'openai': return streamOpenAI(req);
    case 'anthropic': return streamAnthropic(req);
    case 'gemini': return streamGemini(req);
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
  throw new AIError(`${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`, res.status);
}

async function streamOpenAI(req: StreamRequest): Promise<string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (req.provider.apiKey) headers['Authorization'] = `Bearer ${req.provider.apiKey}`;
  if (req.provider.baseUrl.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = 'https://smallworlds.local';
    headers['X-Title'] = 'Small Worlds AI';
  }
  const res = await fetch(`${req.provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    signal: req.signal,
    body: JSON.stringify({
      model: req.model,
      stream: true,
      max_tokens: req.maxTokens,
      temperature: req.temperature ?? 0.9,
      messages: [{ role: 'system', content: req.system }, ...req.messages]
    })
  });
  if (!res.ok) await throwHttpError(res);
  let full = '';
  await readSSE(res, (data) => {
    try {
      const json = JSON.parse(data);
      const delta: string = json.choices?.[0]?.delta?.content ?? '';
      if (delta) {
        full += delta;
        req.onDelta?.(delta);
      }
    } catch { /* keep-alive or malformed chunk */ }
  });
  if (!full) throw new AIError('The model returned an empty response.');
  return full;
}

async function streamAnthropic(req: StreamRequest): Promise<string> {
  const res = await fetch(`${req.provider.baseUrl}/messages`, {
    method: 'POST',
    signal: req.signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': req.provider.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: req.model,
      stream: true,
      max_tokens: req.maxTokens,
      temperature: req.temperature ?? 0.9,
      system: req.system,
      messages: req.messages
    })
  });
  if (!res.ok) await throwHttpError(res);
  let full = '';
  await readSSE(res, (data) => {
    try {
      const json = JSON.parse(data);
      if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
        full += json.delta.text;
        req.onDelta?.(json.delta.text);
      }
      if (json.type === 'error') throw new AIError(json.error?.message ?? 'Provider error');
    } catch (e) {
      if (e instanceof AIError) throw e;
    }
  });
  if (!full) throw new AIError('The model returned an empty response.');
  return full;
}

async function streamGemini(req: StreamRequest): Promise<string> {
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
      generationConfig: {
        maxOutputTokens: req.maxTokens,
        temperature: req.temperature ?? 0.9
      }
    })
  });
  if (!res.ok) await throwHttpError(res);
  let full = '';
  await readSSE(res, (data) => {
    try {
      const json = JSON.parse(data);
      const text: string =
        json.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('') ?? '';
      if (text) {
        full += text;
        req.onDelta?.(text);
      }
    } catch { /* ignore malformed chunk */ }
  });
  if (!full) throw new AIError('The model returned an empty response.');
  return full;
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
