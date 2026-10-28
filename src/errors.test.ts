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

  it('keeps a missing picture model instead of a generic model failure', () => {
    const err = classifyError(new AIError('Set an image model in Settings before making a picture.'));
    expect(err.userMessage).toBe('Set an image model in Settings before making a picture.');
  });

  it('keeps portrait instructions instead of a generic model failure', () => {
    const err = classifyError(new AIError('Set an image model in Settings before generating a portrait.'));
    expect(err.userMessage).toBe('Set an image model in Settings before generating a portrait.');
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
    expect(err.userMessage).toMatch(/too large|end the chapter/i);
  });

  it('uses overflow copy for HTTP 400 context_length_exceeded', () => {
    const err = classifyError(new AIError('context_length_exceeded', 400));
    expect(err.userMessage).toMatch(/too large|end the chapter/i);
    expect(err.userMessage).not.toMatch(/rejected the request/i);
  });

  it('keeps empty-reply copy when the provider returns HTTP 400', () => {
    const err = classifyError(new AIError('The model returned an empty reply.', 400));
    expect(err.userMessage).toMatch(/empty reply/i);
    expect(err.userMessage).not.toMatch(/rejected the request/i);
    expect(err.userMessage).not.toMatch(/wrap the episode/i);
  });

  it('maps hosted credit and sign-in failures to their own copy', () => {
    const credits = classifyError(new AIError('Not enough Small Worlds credits. Subscribe or buy a pack in Profile.', 402));
    expect(credits.userMessage).toMatch(/credits/i);
    expect(credits.userMessage).toMatch(/Profile/);

    const hostedTagged = classifyError(new AIError('402 Payment Required', 402, { label: 'Small Worlds', hosted: true }));
    expect(hostedTagged.userMessage).toMatch(/Small Worlds credits/i);
    expect(hostedTagged.userMessage).toMatch(/Profile/);

    const signedOut = classifyError(new AIError('401 — Sign in required.', 401));
    expect(signedOut.userMessage).toMatch(/Sign in/i);
    expect(signedOut.userMessage).not.toMatch(/API key/);
  });

  it('does not call a BYOK provider 402 a Small Worlds credit shortage', () => {
    const err = classifyError(new AIError(
      '402 Payment Required — Insufficient credits for this key.',
      402,
      { label: 'OpenRouter', hosted: false }
    ));
    expect(err.userMessage).toMatch(/OpenRouter/);
    expect(err.userMessage).toMatch(/balance or key limit/i);
    expect(err.userMessage).not.toMatch(/Small Worlds credits/i);
    expect(err.userMessage).not.toMatch(/Subscribe/i);
    expect(err.userMessage).not.toMatch(/buy a pack/i);
    expect(err.detail).toMatch(/Insufficient credits/);
  });

  it('does not send a BYOK 401 to hosted sign-in', () => {
    const err = classifyError(new AIError(
      '401 Unauthorized — Sign in failed for this key.',
      401,
      { label: 'OpenRouter', hosted: false }
    ));
    expect(err.userMessage).toMatch(/Provider rejected the key/);
    expect(err.userMessage).not.toMatch(/Small Worlds hosted/);
  });

  it('keeps write-loop AIError copy instead of generic Settings', () => {
    const spoken = classifyError(new AIError(
      'No character replied aloud. Try again, or add someone to this chapter.'
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
