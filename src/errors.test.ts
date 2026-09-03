import { describe, expect, it } from 'vitest';
import { AIError } from './ai/client';
import { classifyError } from './errors';

describe('classifyError', () => {
  it('maps missing utility/writing models to Settings copy, not cloud sync', () => {
    const err = classifyError(new AIError('No utility model configured. Add a provider and pick a model in Settings.'));
    expect(err.code).not.toBe('sync');
    expect(err.code).toBe('provider');
    expect(err.userMessage).toMatch(/model/i);
    expect(err.userMessage).not.toMatch(/cloud sync/i);
  });

  it('maps missing writing model the same way', () => {
    const err = classifyError(new Error('No writing model configured. Add a provider and pick a model in Settings.'));
    expect(err.code).toBe('provider');
    expect(err.userMessage).not.toMatch(/cloud sync/i);
  });

  it('keeps explicit cloud-sync phrasing as sync', () => {
    const err = classifyError(new Error('Cloud sync is not configured on this build.'));
    expect(err.code).toBe('sync');
    expect(err.userMessage).toMatch(/cloud sync is not configured/i);
  });

  it('does not treat empty replies as mid-season context overflow', () => {
    const err = classifyError(new AIError(
      'The model returned an empty response. The prompt may be too long for this model mid-season, or a reasoning model used its token budget on thinking. Try again, wrap the episode, or pick a larger-context model in Settings.'
    ));
    expect(err.code).not.toBe('sync');
    expect(err.userMessage).not.toMatch(/this deep in the season/i);
    expect(err.userMessage).not.toMatch(/wrap the episode/i);
    expect(err.userMessage).toMatch(/empty reply/i);
    expect(err.userMessage).toMatch(/settings/i);
  });

  it('keeps real overflow copy for context_length_exceeded', () => {
    const err = classifyError(new Error('context_length_exceeded'));
    expect(err.userMessage).toMatch(/too large|wrap the episode/i);
  });

  it('uses overflow copy for HTTP 400 context_length_exceeded', () => {
    const err = classifyError(new AIError('context_length_exceeded', 400));
    expect(err.userMessage).toMatch(/too large|wrap the episode/i);
    expect(err.userMessage).not.toMatch(/rejected the request/i);
  });

  it('keeps empty-reply copy when the provider returns HTTP 400', () => {
    const err = classifyError(new AIError('The model returned an empty reply.', 400));
    expect(err.userMessage).toMatch(/empty reply/i);
    expect(err.userMessage).not.toMatch(/rejected the request/i);
    expect(err.userMessage).not.toMatch(/wrap the episode/i);
  });

  it('keeps write-loop AIError copy instead of generic Settings', () => {
    const spoken = classifyError(new AIError(
      'No character replied aloud. Try again, pin who should answer, or add cast to the scene.'
    ));
    expect(spoken.userMessage).toMatch(/No character replied aloud/);
    expect(spoken.userMessage).not.toMatch(/Check Settings/);

    const narr = classifyError(new AIError(
      'The model produced no usable narration or dialogue. Try again, or choose a shorter reply size.'
    ));
    expect(narr.userMessage).toMatch(/no usable narration/i);
    expect(narr.userMessage).not.toMatch(/Check Settings/);
  });
});
