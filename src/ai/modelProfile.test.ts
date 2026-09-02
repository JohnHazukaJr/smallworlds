import { describe, expect, it } from 'vitest';
import { buildOpenAIChatBody } from './client';
import {
  inferContextWindowTokens,
  promptCharBudget
} from './contextBudget';
import {
  modelProfile,
  shouldReserveReasoningTokens,
  thinkingOnForJob
} from './modelProfile';
import type { ProviderConfig } from '../types';

const openai = (model: string, job: 'prose' | 'utility' | 'wrap' | 'test' = 'prose') =>
  buildOpenAIChatBody({
    provider: {
      id: 'p',
      kind: 'openai',
      label: 'Z.ai',
      baseUrl: 'https://api.z.ai/api/paas/v4',
      apiKey: 'k'
    } satisfies ProviderConfig,
    model,
    system: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 200,
    job
  });

describe('modelProfile', () => {
  it('treats GLM 5.x slugs as 1M thinking-toggle models', () => {
    for (const slug of ['glm-5.2', 'glm-5.3', 'glm-5.3-flash', 'z-ai/glm-5.2', 'zhipu/glm-5.3']) {
      const p = modelProfile(slug);
      expect(p.windowTokens).toBe(1_048_576);
      expect(p.isGlm5).toBe(true);
      expect(p.supportsThinkingToggle).toBe(true);
      expect(p.usesMaxCompletionTokens).toBe(false);
      expect(inferContextWindowTokens(slug)).toBe(1_048_576);
    }
  });

  it('uses max_completion_tokens only for GPT-5-class', () => {
    expect(modelProfile('gpt-5').usesMaxCompletionTokens).toBe(true);
    expect(modelProfile('glm-5.2').usesMaxCompletionTokens).toBe(false);
  });

  it('turns thinking on only for wrap jobs', () => {
    expect(thinkingOnForJob('glm-5.2', 'prose')).toBe(false);
    expect(thinkingOnForJob('glm-5.2', 'utility')).toBe(false);
    expect(thinkingOnForJob('glm-5.2', 'test')).toBe(false);
    expect(thinkingOnForJob('glm-5.2', 'wrap')).toBe(true);
    expect(thinkingOnForJob('gpt-5', 'wrap')).toBe(false);
  });

  it('reserves extra output tokens only when thinking is on', () => {
    expect(shouldReserveReasoningTokens('glm-5.2', false)).toBe(false);
    expect(shouldReserveReasoningTokens('glm-5.2', true)).toBe(true);
    // 1M GLM hits the send ceiling either way; a 32k reasoner shows the reserve.
    const off = promptCharBudget('deepseek-reasoner', 400, { thinking: false });
    const on = promptCharBudget('deepseek-reasoner', 400, { thinking: true });
    expect(on).toBeLessThan(off);
  });
});

describe('buildOpenAIChatBody', () => {
  it('disables GLM thinking on prose and uses max_tokens', () => {
    const body = openai('glm-5.2', 'prose');
    expect(body.max_tokens).toBe(200);
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('enables GLM thinking on wrap with high effort', () => {
    const body = openai('glm-5.2', 'wrap');
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.reasoning_effort).toBe('high');
  });

  it('uses max_completion_tokens for GPT-5', () => {
    const body = openai('gpt-5', 'prose');
    expect(body.max_completion_tokens).toBe(200);
    expect(body.max_tokens).toBeUndefined();
  });
});
