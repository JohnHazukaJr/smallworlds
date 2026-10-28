import { describe, expect, it } from 'vitest';
import { exactProxyHost, isZaiHost } from './proxyHosts';
import { hostedFunctionRoot, hostedOp, isHostedFunctionUrl, isZaiProvider } from './providerFetch';

describe('hosted function urls', () => {
  const root = 'https://example.supabase.co/functions/v1/hosted-ai';

  it('detects the hosted function and strips the OpenAI suffix', () => {
    const chat = `${root}/chat/completions`;
    const image = `${root}/images/generations`;
    expect(isHostedFunctionUrl(chat)).toBe(true);
    expect(isHostedFunctionUrl('https://api.openai.com/v1/chat/completions')).toBe(false);
    expect(hostedFunctionRoot(chat)).toBe(root);
    expect(hostedFunctionRoot(image)).toBe(root);
    expect(hostedOp(image)).toBe('image');
    expect(hostedOp(chat)).toBe('chat');
  });
});

describe('proxy hosts', () => {
  it('allows only the exact relay hosts', () => {
    expect(exactProxyHost('https://api.z.ai/api/paas/v4/chat/completions')).toBe(true);
    expect(exactProxyHost('https://open.bigmodel.cn/api/paas/v4/chat/completions')).toBe(true);
    expect(exactProxyHost('https://api.venice.ai/api/v1/image/edit')).toBe(true);
    expect(isZaiHost('https://api.z.ai/api/paas/v4/chat/completions')).toBe(true);
    expect(isZaiHost('https://api.venice.ai/api/v1/image/edit')).toBe(false);
    expect(isZaiProvider({
      id: 'v', kind: 'openai', label: 'Venice',
      baseUrl: 'https://api.venice.ai/api/v1', apiKey: 'k'
    })).toBe(false);
    expect(exactProxyHost('https://evil.api.z.ai/v1/chat')).toBe(false);
    expect(exactProxyHost('https://api.z.ai.evil.com/v1/chat')).toBe(false);
    expect(exactProxyHost('https://example.com/?q=api.z.ai')).toBe(false);
  });
});
