import { describe, expect, it } from 'vitest';
import { drainSSEBuffer } from './client';

describe('drainSSEBuffer', () => {
  it('keeps the last event when the provider closes without a trailing newline', () => {
    const chunk = 'data: {"choices":[{"delta":{"content":" Hello"}}]}\n'
      + 'data: {"choices":[{"delta":{"content":" there."},"finish_reason":"stop"}]}';
    const held = drainSSEBuffer(chunk, false);
    expect(held.events).toHaveLength(1);
    expect(held.rest).toContain('there.');

    const flushed = drainSSEBuffer(held.rest, true);
    expect(flushed.events).toEqual([
      '{"choices":[{"delta":{"content":" there."},"finish_reason":"stop"}]}'
    ]);
    expect(flushed.rest).toBe('');
  });

  it('does not emit a partial line until the stream is finished', () => {
    const open = drainSSEBuffer('data: {"partial":', false);
    expect(open.events).toEqual([]);
    expect(open.rest).toBe('data: {"partial":');
  });

  it('ignores the done sentinel and blank keepalives', () => {
    const drained = drainSSEBuffer('data: [DONE]\n\ndata: {"ok":true}\n', true);
    expect(drained.events).toEqual(['{"ok":true}']);
  });
});
