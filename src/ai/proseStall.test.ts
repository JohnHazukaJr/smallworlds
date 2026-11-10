import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PROSE_IDLE_MS,
  StreamStallError,
  isTimeoutFailure,
  proseIdleMs,
  streamChat,
  type StreamRequest
} from './client';
import type { ProviderConfig } from '../types';

const provider: ProviderConfig = {
  id: 'p',
  kind: 'openai',
  label: 'Test',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'k'
};

function request(extra: Partial<StreamRequest> = {}): StreamRequest {
  return {
    provider,
    model: 'glm-5.2',
    system: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 200,
    job: 'prose',
    idleMs: 40,
    ...extra
  };
}

function silentBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull() {
      return new Promise(() => undefined);
    }
  });
}

function chunkThenSilence(sse: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(sse);
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(bytes);
        return;
      }
      return new Promise(() => undefined);
    }
  });
}

function sseResponse(body: BodyInit | null, status = 200, statusText = 'OK'): Response {
  return new Response(body, {
    status,
    statusText,
    headers: { 'Content-Type': status === 200 ? 'text/event-stream' : 'application/json' }
  });
}

const fetchMock = vi.fn();

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe('prose idle limit', () => {
  it('applies only to prose', () => {
    expect(proseIdleMs({ job: 'prose' })).toBe(PROSE_IDLE_MS);
    expect(proseIdleMs({ job: 'prose', idleMs: 40 })).toBe(40);
    expect(proseIdleMs({ job: 'prose', idleMs: 0 })).toBeUndefined();
    expect(proseIdleMs({ job: 'utility' })).toBeUndefined();
    expect(proseIdleMs({ job: 'wrap' })).toBeUndefined();
    expect(proseIdleMs({ job: 'test' })).toBeUndefined();
  });

  it('stalls a silent prose read and retries once with thinking off', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return sseResponse(silentBody());
    });
    vi.stubGlobal('fetch', fetchMock);

    const pending = streamChat(request({ thinking: true }));
    await expect(pending).rejects.toBeInstanceOf(StreamStallError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies[0]?.thinking).toEqual({ type: 'enabled' });
    expect(bodies[1]?.thinking).toEqual({ type: 'disabled' });
    expect(isTimeoutFailure(new StreamStallError())).toBe(true);
  });

  it('keeps visible text when the stream goes quiet mid-reply', async () => {
    const line = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n';
    fetchMock.mockResolvedValue(sseResponse(chunkThenSilence(line)));
    vi.stubGlobal('fetch', fetchMock);

    const result = await streamChat(request());
    expect(result.text).toBe('Hello');
    expect(result.truncated).toBe(true);
    expect(result.stalled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a reasoning chunk as activity, then stalls if no reply follows', async () => {
    const line = 'data: {"choices":[{"delta":{"reasoning_content":"..."}}]}\n\n';
    fetchMock.mockImplementation(async () => sseResponse(chunkThenSilence(line)));
    vi.stubGlobal('fetch', fetchMock);

    await expect(streamChat(request())).rejects.toBeInstanceOf(StreamStallError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not send a 504 again', async () => {
    fetchMock.mockResolvedValue(sseResponse(
      JSON.stringify({ error: { message: 'Gateway Timeout' } }),
      504,
      'Gateway Timeout'
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(streamChat(request())).rejects.toMatchObject({ status: 504 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not send a timeout error again', async () => {
    fetchMock.mockRejectedValue(new TypeError('The request timed out.'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(streamChat(request())).rejects.toThrow(/timed out/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps Stop as an abort and does not retry it', async () => {
    fetchMock.mockResolvedValue(sseResponse(silentBody()));
    vi.stubGlobal('fetch', fetchMock);
    const signal = new AbortController();
    const pending = streamChat(request({ signal: signal.signal, idleMs: 500 }));
    setTimeout(() => signal.abort(), 20);

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
