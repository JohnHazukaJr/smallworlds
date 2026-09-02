import type { World } from '../types';
import { AIError, streamChat, type ChatJob, type ToolSpec } from './client';
import { modelProfile } from './modelProfile';
import { utilityModelFor } from './models';

export type { ToolSpec };

export function extractJson<T>(raw: string): T {
  const cleaned = raw.replace(/```(?:json)?/g, '').trim();
  const start = Math.min(
    ...['{', '['].map((c) => cleaned.indexOf(c)).filter((i) => i >= 0)
  );
  if (!Number.isFinite(start)) throw new AIError('The model did not return JSON.');
  const open = cleaned[start];
  const close = open === '{' ? '}' : ']';
  const end = cleaned.lastIndexOf(close);
  if (end <= start) throw new AIError('The model returned malformed JSON.');
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch {
    throw new AIError('The model returned malformed JSON.');
  }
}

export function parseToolArguments<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return extractJson<T>(raw);
  }
}

const DEFAULT_UTILITY_TIMEOUT_MS = 45_000;

function withTimeoutSignal(outer: AbortSignal | undefined, ms: number): { signal: AbortSignal; cancel: () => void } {
  const ctrl = new AbortController();
  const onOuter = () => ctrl.abort();
  outer?.addEventListener('abort', onOuter);
  const t = window.setTimeout(() => ctrl.abort(), ms);
  return {
    signal: ctrl.signal,
    cancel: () => {
      window.clearTimeout(t);
      outer?.removeEventListener('abort', onOuter);
    }
  };
}

export async function utilityCall<T>(opts: {
  world: World | null;
  system: string;
  user: string;
  maxTokens?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  job?: Exclude<ChatJob, 'prose' | 'test'>;
  tool?: ToolSpec;
}): Promise<T> {
  const job = opts.job ?? 'utility';
  const maxTokens = opts.maxTokens ?? 3000;
  const timeoutMs = opts.timeoutMs ?? (job === 'wrap' ? 90_000 : DEFAULT_UTILITY_TIMEOUT_MS);
  const { provider, model } = utilityModelFor(opts.world);
  const profile = modelProfile(model);
  const { signal: timed, cancel } = withTimeoutSignal(opts.signal, timeoutMs);
  const tool = opts.tool ?? RETURN_JSON_TOOL;
  try {
    const useTool = !!(profile.supportsTools && provider.kind === 'openai');
    const result = await streamChat({
      provider,
      model,
      system: opts.system,
      messages: [{ role: 'user', content: opts.user }],
      maxTokens,
      temperature: 0.4,
      signal: timed,
      job,
      jsonMode: !useTool && profile.supportsJsonObject,
      tools: useTool ? [tool] : undefined,
      toolChoice: useTool ? { name: tool.name } : undefined
    });
    if (useTool && result.toolCalls?.length) {
      const match = result.toolCalls.find((c) => c.name === tool.name) ?? result.toolCalls[0];
      return parseToolArguments<T>(match.arguments);
    }
    return extractJson<T>(result.text);
  } catch (e) {
    if ((e as Error).name === 'AbortError' && !opts.signal?.aborted) {
      throw new AIError(`Utility model timed out after ${timeoutMs / 1000}s.`);
    }
    throw e;
  } finally {
    cancel();
  }
}

export const RETURN_JSON_TOOL: ToolSpec = {
  name: 'return_json',
  description: 'Return the requested structured result. Do not write story prose.',
  parameters: {
    type: 'object',
    additionalProperties: true
  }
};

export const ANALYZE_EPISODE_TOOL: ToolSpec = {
  name: 'analyze_episode',
  description: 'Close an episode or season: recap, beats, new facts, threads, and state updates. Do not write story prose.',
  parameters: {
    type: 'object',
    additionalProperties: true
  }
};

export const PLAN_TURN_TOOL: ToolSpec = {
  name: 'plan_turn',
  description: 'Plan cast changes and an ordered list of narration/speak beats. Do not write story prose.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      castDelta: {
        type: 'object',
        properties: {
          enter: { type: 'array', items: { type: 'string' } },
          leave: { type: 'array', items: { type: 'string' } },
          introduce: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                brief: { type: 'string' },
                voice: { type: 'string' }
              }
            }
          }
        }
      },
      beats: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            brief: { type: 'string' },
            characterId: { type: 'string' },
            guestId: { type: 'string' }
          }
        }
      }
    },
    required: ['beats']
  }
};

export const FILE_CANON_TOOL: ToolSpec = {
  name: 'file_canon',
  description: 'File new durable facts, threads, place, and knowledge from recent play.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      facts: { type: 'array', items: { type: 'string' } },
      threads: { type: 'array', items: { type: 'string' } },
      place: {
        type: ['object', 'null'],
        properties: {
          name: { type: 'string' },
          currentState: { type: 'string' },
          atmosphere: { type: 'string' }
        }
      },
      knowledge: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            nowKnows: { type: 'string' }
          }
        }
      }
    }
  }
};
