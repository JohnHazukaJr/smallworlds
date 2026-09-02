import type { ProviderConfig, ProviderKind } from '../types';

export interface ProviderPreset {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  keyUrl: string;
  /** shown at the top of the model picker — suggestions, never a ceiling */
  suggestedModels: string[];
  note: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
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
    note: 'One key, hundreds of models. Recommended: compare narrative models side by side. GLM 5.x is listed as z-ai/glm-5.2.'
  },
  {
    id: 'zai',
    label: 'Z.ai',
    kind: 'openai',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    keyUrl: 'https://z.ai/manage-apikey/apikey-list',
    suggestedModels: ['glm-5.2', 'glm-5.3', 'glm-5.3-flash', 'glm-image'],
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

export function presetFor(config: ProviderConfig): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => config.baseUrl.startsWith(p.baseUrl.replace(/\/v1.*$/, ''))) ||
    PROVIDER_PRESETS.find((p) => p.kind === config.kind && p.id === 'custom');
}

export interface ListModelsResult {
  models: string[];
  error?: string;
}

/** Fetch the live model catalog from a provider, where supported. */
export async function listModels(config: ProviderConfig): Promise<ListModelsResult> {
  try {
    if (config.kind === 'gemini') {
      const res = await fetch(`${config.baseUrl}/models?key=${encodeURIComponent(config.apiKey)}`);
      if (!res.ok) {
        return { models: [], error: `Could not list models (${res.status}). Check the API key.` };
      }
      const data = await res.json();
      const models = (data.models ?? [])
        .map((m: { name: string }) => m.name.replace(/^models\//, ''))
        .filter((n: string) => n.includes('gemini'));
      return { models };
    }
    const headers: Record<string, string> = {};
    if (config.kind === 'anthropic') {
      headers['x-api-key'] = config.apiKey;
      headers['anthropic-version'] = '2023-06-01';
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
    } else if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    }
    const res = await fetch(`${config.baseUrl}/models`, { headers });
    if (!res.ok) {
      return { models: [], error: `Could not list models (${res.status}). Check the API key.` };
    }
    const data = await res.json();
    const arr = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
    const models = arr.map((m: { id?: string; name?: string }) => m.id ?? m.name ?? '').filter(Boolean).sort();
    return { models };
  } catch (e) {
    return {
      models: [],
      error: e instanceof Error ? e.message : 'Could not reach the provider to list models.'
    };
  }
}
