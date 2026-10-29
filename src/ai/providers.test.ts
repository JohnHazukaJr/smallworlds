import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOSTED_IMAGE_MODEL, HOSTED_PROSE_MODEL, HOSTED_UTILITY_MODEL } from '../billing/plans';
import type { ProviderConfig } from '../types';
import {
  catalogModelIds,
  isOpenRouterHost,
  listModels,
  modelsListUrl,
  PROVIDER_PRESETS,
  suggestedModelsFor
} from './providers';

const openRouter: ProviderConfig = {
  id: 'or',
  kind: 'openai',
  label: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'sk-or-test'
};

const zai: ProviderConfig = {
  id: 'z',
  kind: 'openai',
  label: 'Z.ai',
  baseUrl: 'https://api.z.ai/api/paas/v4',
  apiKey: 'k'
};

const hosted: ProviderConfig = {
  id: 'h',
  kind: 'openai',
  label: 'Small Worlds',
  baseUrl: 'https://example.supabase.co/functions/v1/hosted-ai',
  apiKey: ''
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenRouter catalog URLs', () => {
  it('asks OpenRouter for image output models, not the default LLM list', () => {
    expect(isOpenRouterHost(openRouter.baseUrl)).toBe(true);
    expect(modelsListUrl(openRouter, 'text')).toBe('https://openrouter.ai/api/v1/models');
    expect(modelsListUrl(openRouter, 'image')).toBe(
      'https://openrouter.ai/api/v1/models?output_modalities=image'
    );
    expect(modelsListUrl(zai, 'image')).toBe('https://api.z.ai/api/paas/v4/models');
  });
});

describe('catalogModelIds', () => {
  const mixed = [
    { id: 'z-ai/glm-5.2', architecture: { output_modalities: ['text'], modality: 'text->text' } },
    {
      id: 'google/gemini-2.5-flash-image',
      architecture: { output_modalities: ['image'], modality: 'text+image->image' }
    },
    {
      id: 'black-forest-labs/flux.2-pro',
      architecture: { output_modalities: ['image'], modality: 'text->image' }
    }
  ];

  it('keeps writing models out of an image catalog', () => {
    expect(catalogModelIds(mixed, 'image')).toEqual([
      'black-forest-labs/flux.2-pro',
      'google/gemini-2.5-flash-image'
    ]);
  });

  it('keeps image-only models out of a writing catalog', () => {
    expect(catalogModelIds(mixed, 'text')).toEqual(['z-ai/glm-5.2']);
  });

  it('does not dump LLMs into the image picker when the catalog is text-only', () => {
    expect(catalogModelIds([
      { id: 'anthropic/claude-sonnet-4.5', architecture: { output_modalities: ['text'] } }
    ], 'image')).toEqual([]);
  });

  it('picks glm-image from a Z.ai-style list with no architecture', () => {
    expect(catalogModelIds(
      [{ id: 'glm-5.2' }, { id: 'glm-5.3-flash' }, { id: 'glm-image' }],
      'image'
    )).toEqual(['glm-image']);
  });
});

describe('suggestedModelsFor', () => {
  it('uses image generators for the image picker', () => {
    const or = PROVIDER_PRESETS.find((p) => p.id === 'openrouter');
    expect(suggestedModelsFor(or, 'text')[0]).toBe('z-ai/glm-5.2');
    expect(suggestedModelsFor(or, 'image')).toContain('google/gemini-2.5-flash-image');
    expect(suggestedModelsFor(or, 'image').some((m) => m.includes('glm-5'))).toBe(false);
  });
});

describe('listModels', () => {
  it('returns only the hosted image model for the image picker', async () => {
    await expect(listModels(hosted, 'image')).resolves.toEqual({ models: [HOSTED_IMAGE_MODEL] });
    await expect(listModels(hosted, 'text')).resolves.toEqual({
      models: [HOSTED_PROSE_MODEL, HOSTED_UTILITY_MODEL]
    });
  });

  it('fetches OpenRouter with output_modalities=image', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(String(url)).toBe('https://openrouter.ai/api/v1/models?output_modalities=image');
      return new Response(JSON.stringify({
        data: [
          {
            id: 'google/gemini-2.5-flash-image',
            architecture: { output_modalities: ['image'] }
          },
          {
            id: 'anthropic/claude-sonnet-4.5',
            architecture: { output_modalities: ['text'] }
          }
        ]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { models, error } = await listModels(openRouter, 'image');
    expect(error).toBeUndefined();
    expect(models).toEqual(['google/gemini-2.5-flash-image']);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not add the image filter when listing writing models', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(String(url)).toBe('https://openrouter.ai/api/v1/models');
      return new Response(JSON.stringify({
        data: [{ id: 'z-ai/glm-5.2', architecture: { output_modalities: ['text'] } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { models } = await listModels(openRouter, 'text');
    expect(models).toEqual(['z-ai/glm-5.2']);
  });
});
