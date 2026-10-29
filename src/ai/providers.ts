import { HOSTED_IMAGE_MODEL, HOSTED_PROSE_MODEL, HOSTED_UTILITY_MODEL } from '../billing/plans';
import type { ProviderConfig, ProviderKind } from '../types';

/** Venice edit model for an adult chapter picture that already has a portrait. */
export const VENICE_ADULT_EDIT_MODEL = 'qwen-edit-uncensored';

export interface ProviderPreset {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  keyUrl: string;
  /** shown at the top of the writing/utility picker — suggestions, never a ceiling */
  suggestedModels: string[];
  /** shown in the image picker — generators, not writing models */
  suggestedImageModels?: string[];
  note: string;
}

/** Writing/utility vs image catalog. OpenRouter's default /models list is text-only. */
export type ModelCatalogKind = 'text' | 'image';

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'smallworlds',
    label: 'Small Worlds',
    kind: 'openai',
    baseUrl: 'https://hosted.invalid/functions/v1/hosted-ai',
    keyUrl: '',
    suggestedModels: [HOSTED_PROSE_MODEL, HOSTED_UTILITY_MODEL],
    suggestedImageModels: [HOSTED_IMAGE_MODEL],
    note: 'Hosted models billed in credits. Sign in on Profile — no API key. Your own providers stay free.'
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/keys',
    suggestedModels: [
      'z-ai/glm-5.2',
      'z-ai/glm-5.3',
      'anthropic/claude-sonnet-4.5',
      'anthropic/claude-opus-4.1',
      'moonshotai/kimi-k2',
      'deepseek/deepseek-chat-v3.1',
      'x-ai/grok-4',
      'meta-llama/llama-4-maverick',
      'google/gemini-2.5-pro'
    ],
    suggestedImageModels: [
      'google/gemini-2.5-flash-image',
      'black-forest-labs/flux.2-pro',
      'openai/gpt-5-image',
      'google/gemini-3-pro-image-preview'
    ],
    note: 'One key, hundreds of models. Recommended: compare narrative models side by side. GLM 5.x is listed as z-ai/glm-5.2. Image models are a separate OpenRouter catalog — fetch list on the image picker, not the writing one.'
  },
  {
    id: 'zai',
    label: 'Z.ai',
    kind: 'openai',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    keyUrl: 'https://z.ai/manage-apikey/apikey-list',
    suggestedModels: ['glm-5.2', 'glm-5.3', 'glm-5.3-flash'],
    suggestedImageModels: ['glm-image'],
    note: 'Direct GLM. Pair glm-5.2 for prose and utility, glm-image for scenes. The browser may hit CORS — use OpenRouter’s z-ai/glm-5.2, or sign in so the cloud relay can reach Z.ai. China BigModel is Custom: open.bigmodel.cn/api/paas/v4.'
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    suggestedModels: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
    note: 'Direct Claude access. API billing is separate from a Claude Pro subscription.'
  },
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    suggestedModels: ['gpt-5', 'gpt-5-mini', 'gpt-4.1'],
    note: 'Direct OpenAI access.'
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    kind: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyUrl: 'https://aistudio.google.com/apikey',
    suggestedModels: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    note: 'Direct Gemini access with an AI Studio key.'
  },
  {
    id: 'moonshot',
    label: 'Moonshot (Kimi)',
    kind: 'openai',
    baseUrl: 'https://api.moonshot.ai/v1',
    keyUrl: 'https://platform.moonshot.ai/console/api-keys',
    suggestedModels: ['kimi-k2-0905-preview', 'kimi-latest'],
    note: 'Kimi direct. Also available through OpenRouter.'
  },
  {
    id: 'together',
    label: 'Together AI',
    kind: 'openai',
    baseUrl: 'https://api.together.xyz/v1',
    keyUrl: 'https://api.together.xyz/settings/api-keys',
    suggestedModels: ['moonshotai/Kimi-K2-Instruct', 'deepseek-ai/DeepSeek-V3.1'],
    note: 'Open-weight models at speed.'
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    suggestedModels: ['deepseek-chat', 'deepseek-reasoner'],
    note: 'DeepSeek direct.'
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    kind: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    keyUrl: 'https://console.x.ai',
    suggestedModels: ['grok-4', 'grok-4-fast'],
    note: 'Grok direct.'
  },
  {
    id: 'venice',
    label: 'Venice',
    kind: 'openai',
    baseUrl: 'https://api.venice.ai/api/v1',
    keyUrl: 'https://venice.ai/settings/api',
    suggestedModels: [],
    note: 'Adult chapter pictures that keep a face from a portrait you already made. This key does not write the story.'
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    kind: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    keyUrl: 'https://ollama.com',
    suggestedModels: [],
    note: 'Local models. No key needed; runs on your machine.'
  },
  {
    id: 'custom',
    label: 'Custom endpoint',
    kind: 'openai',
    baseUrl: 'http://localhost:8080/v1',
    keyUrl: '',
    suggestedModels: [],
    note: 'Any OpenAI-compatible server: LM Studio, vLLM, llama.cpp, a proxy — anything.'
  }
];

/** Presets a person adds with their own key. Hosted is enabled from Settings, not this list. */
export const BYOK_PRESETS = PROVIDER_PRESETS.filter((p) => p.id !== 'smallworlds');

export function isHostedProvider(config: ProviderConfig): boolean {
  return config.baseUrl.includes('/functions/v1/hosted-ai');
}

export function hostedBaseUrl(): string | null {
  const base = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, '');
  if (!base) return null;
  return `${base}/functions/v1/hosted-ai`;
}

export function presetFor(config: ProviderConfig): ProviderPreset | undefined {
  if (isHostedProvider(config)) return PROVIDER_PRESETS.find((p) => p.id === 'smallworlds');
  return BYOK_PRESETS.find((p) => config.baseUrl.startsWith(p.baseUrl.replace(/\/v1.*$/, ''))) ||
    BYOK_PRESETS.find((p) => p.kind === config.kind && p.id === 'custom');
}

export interface ListModelsResult {
  models: string[];
  error?: string;
}

export function isOpenRouterHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'openrouter.ai' || host.endsWith('.openrouter.ai');
  } catch {
    return false;
  }
}

export function suggestedModelsFor(
  preset: ProviderPreset | undefined,
  kind: ModelCatalogKind = 'text'
): string[] {
  if (!preset) return [];
  if (kind === 'image') return preset.suggestedImageModels ?? [];
  return preset.suggestedModels;
}

/** OpenRouter omits image generators unless output_modalities=image is set. */
export function modelsListUrl(config: ProviderConfig, kind: ModelCatalogKind = 'text'): string {
  const root = config.baseUrl.replace(/\/$/, '');
  if (config.kind === 'gemini') {
    return `${root}/models?key=${encodeURIComponent(config.apiKey)}`;
  }
  if (isOpenRouterHost(config.baseUrl) && kind === 'image') {
    return `${root}/models?output_modalities=image`;
  }
  return `${root}/models`;
}

const IMAGE_ID_RE = /image|flux|dall-e|dalle|imagen|stable-diffusion|sdxl|midjourney|seedream|grok-imagine|recraft|riverflow/i;

export function looksLikeImageModelId(id: string): boolean {
  return IMAGE_ID_RE.test(id);
}

type CatalogRow = {
  id: string;
  outputModalities?: string[];
  modality?: string;
};

function normalizeCatalogRow(raw: unknown): CatalogRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as {
    id?: unknown;
    name?: unknown;
    architecture?: { output_modalities?: unknown; modality?: unknown };
  };
  const id = typeof row.id === 'string' && row.id
    ? row.id
    : typeof row.name === 'string' ? row.name : '';
  if (!id) return null;
  const outs = row.architecture?.output_modalities;
  const outputModalities = Array.isArray(outs)
    ? outs.filter((x): x is string => typeof x === 'string')
    : undefined;
  const modality = typeof row.architecture?.modality === 'string' ? row.architecture.modality : undefined;
  return { id, outputModalities, modality };
}

function outputsImage(row: CatalogRow): boolean {
  if (row.outputModalities?.includes('image')) return true;
  return !!row.modality && /->[^>]*image/.test(row.modality);
}

function outputsText(row: CatalogRow): boolean {
  if (row.outputModalities) return row.outputModalities.includes('text');
  if (row.modality && /->/.test(row.modality)) return /->[^>]*text/.test(row.modality);
  return true;
}

/** Pick writing or image IDs out of a provider catalog payload. */
export function catalogModelIds(rows: unknown[], kind: ModelCatalogKind): string[] {
  const models = rows.map(normalizeCatalogRow).filter((m): m is CatalogRow => !!m);
  let picked = models;
  if (kind === 'image') {
    const fromArch = models.filter(outputsImage);
    if (fromArch.length > 0) {
      picked = fromArch;
    } else {
      const hasArch = models.some((m) => m.outputModalities || m.modality);
      const fromName = models.filter((m) => looksLikeImageModelId(m.id));
      if (fromName.length > 0 || hasArch) picked = fromName;
    }
  } else if (models.some((m) => m.outputModalities || m.modality)) {
    picked = models.filter(outputsText);
  }
  return [...new Set(picked.map((m) => m.id))].sort();
}

/** Fetch the live model catalog from a provider, where supported. */
export async function listModels(
  config: ProviderConfig,
  kind: ModelCatalogKind = 'text'
): Promise<ListModelsResult> {
  try {
    if (isHostedProvider(config)) {
      return {
        models: kind === 'image'
          ? [HOSTED_IMAGE_MODEL]
          : [HOSTED_PROSE_MODEL, HOSTED_UTILITY_MODEL]
      };
    }
    if (config.kind === 'gemini') {
      const res = await fetch(modelsListUrl(config, kind));
      if (!res.ok) {
        return { models: [], error: `Could not list models (${res.status}). Check the API key.` };
      }
      const data = await res.json();
      const names = (data.models ?? [])
        .map((m: { name?: string }) => (m.name ?? '').replace(/^models\//, ''))
        .filter((n: string) => n.includes('gemini') || looksLikeImageModelId(n));
      return { models: catalogModelIds(names.map((id: string) => ({ id })), kind) };
    }
    const headers: Record<string, string> = {};
    if (config.kind === 'anthropic') {
      headers['x-api-key'] = config.apiKey;
      headers['anthropic-version'] = '2023-06-01';
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
    } else if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    }
    const res = await fetch(modelsListUrl(config, kind), { headers });
    if (!res.ok) {
      return { models: [], error: `Could not list models (${res.status}). Check the API key.` };
    }
    const data = await res.json();
    const arr = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
    return { models: catalogModelIds(arr, kind) };
  } catch (e) {
    return {
      models: [],
      error: e instanceof Error ? e.message : 'Could not reach the provider to list models.'
    };
  }
}
