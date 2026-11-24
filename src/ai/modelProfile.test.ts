import { describe, expect, it } from 'vitest';
import { bumpMaxTokens, buildOpenAIChatBody, type StreamRequest } from './client';
import {
  inferContextWindowTokens,
  promptCharBudget
} from './contextBudget';
import {
  modelProfile,
  alwaysReasons,
  paddedMaxTokens,
  proseCompletionTokens,
  REASONING_COMPLETION_PAD,
  shouldReserveReasoningTokens,
  thinkingOnForJob
} from './modelProfile';
import { sceneReplyTokens } from './prompts';
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

  it('pads completion tokens for models that hide reasoning in the output budget', () => {
    expect(alwaysReasons('deepseek-reasoner')).toBe(true);
    expect(alwaysReasons('o1')).toBe(true);
    expect(alwaysReasons('glm-5.2')).toBe(false);
    expect(paddedMaxTokens('gpt-4o', 450)).toBe(450);
    expect(paddedMaxTokens('glm-5.2', 450)).toBe(450 + REASONING_COMPLETION_PAD);
    expect(paddedMaxTokens('gpt-5', 450)).toBe(450 + REASONING_COMPLETION_PAD);
    expect(proseCompletionTokens('deepseek-reasoner', 450)).toBe(450 + REASONING_COMPLETION_PAD);
    expect(proseCompletionTokens('claude-haiku-4-5', 450)).toBe(450);
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

  it('turns reasoning off through OpenRouter, with lowest effort where it is mandatory', () => {
    const viaOpenRouter = (model: string, job: 'prose' | 'utility' | 'wrap') => buildOpenAIChatBody({
      provider: { id: 'or', kind: 'openai', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k' },
      model, system: 's', messages: [], maxTokens: 200, job
    });
    expect(viaOpenRouter('qwen/qwen3.8-flash', 'utility').reasoning).toEqual({ enabled: false });
    expect(viaOpenRouter('meta-llama/llama-4-scout', 'prose').reasoning).toEqual({ enabled: false });
    expect(viaOpenRouter('z-ai/glm-5.3-flash', 'utility').reasoning).toEqual({ effort: 'minimal' });
    expect(viaOpenRouter('google/gemini-3.8-flash', 'prose').reasoning).toEqual({ effort: 'minimal' });
    expect(viaOpenRouter('z-ai/glm-5.3-flash', 'utility').thinking).toBeUndefined();
    expect(viaOpenRouter('z-ai/glm-5.3-flash', 'wrap').reasoning).toEqual({ effort: 'high' });
  });

  it('uses max_completion_tokens for GPT-5', () => {
    const body = openai('gpt-5', 'prose');
    expect(body.max_completion_tokens).toBe(200);
    expect(body.max_tokens).toBeUndefined();
  });
});

describe('output token retry math', () => {
  it('grows the completion ceiling on empty/length-stop retries', () => {
    const req: StreamRequest = {
      provider: {
        id: 'p', kind: 'openai', label: 't', baseUrl: 'https://example.test', apiKey: 'k'
      },
      model: 'gpt-4o',
      system: 's',
      messages: [],
      maxTokens: 450
    };
    expect(bumpMaxTokens(req).maxTokens).toBeGreaterThanOrEqual(2450);
  });

  it('keeps a scene reply large enough to finish a short line', () => {
    expect(sceneReplyTokens('beat')).toBeGreaterThanOrEqual(700);
    expect(sceneReplyTokens('scene')).toBeGreaterThanOrEqual(1200);
  });
});
