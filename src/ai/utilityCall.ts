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

/** True when parsed JSON is null/empty-object/empty-array — not a usable utility payload. */
export function jsonValueIsEmpty(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.length === 0;
  return Object.keys(value as Record<string, unknown>).length === 0;
}

function toolHasProperties(tool: ToolSpec | undefined): boolean {
  if (!tool) return false;
  const props = tool.parameters?.properties;
  return !!props && typeof props === 'object' && Object.keys(props as object).length > 0;
}

function isRetryableUtilityFail(e: unknown): boolean {
  if ((e as Error)?.name === 'AbortError') return false;
  if (e instanceof AIError && e.status != null) return false;
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    msg.includes('did not return json') ||
    msg.includes('malformed json') ||
    msg.includes('empty response') ||
    msg.includes('empty reply')
  );
}

function parseUtilityResult<T>(
  result: { text: string; toolCalls?: Array<{ name: string; arguments: string }> },
  tool?: ToolSpec
): T {
  if (tool && result.toolCalls?.length) {
    const match = result.toolCalls.find((c) => c.name === tool.name) ?? result.toolCalls[0];
    const args = (match.arguments ?? '').trim();
    if (args) {
      try {
        const parsed = parseToolArguments<T>(args);
        if (!jsonValueIsEmpty(parsed)) return parsed;
      } catch {
        // Empty or invalid tool args — try the text body.
      }
    }
  }
  return extractJson<T>(result.text);
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
  const structuredTool = toolHasProperties(opts.tool) ? opts.tool : undefined;
  const canTool = !!(structuredTool && profile.supportsTools && provider.kind === 'openai');
  const bumpTokens = Math.max(maxTokens + 2000, Math.floor(maxTokens * 1.5));

  const run = async (useTool: boolean, tokens: number): Promise<T> => {
    const result = await streamChat({
      provider,
      model,
      system: opts.system,
      messages: [{ role: 'user', content: opts.user }],
      maxTokens: tokens,
      temperature: 0.4,
      signal: timed,
      job,
      jsonMode: !useTool && profile.supportsJsonObject,
      tools: useTool && structuredTool ? [structuredTool] : undefined,
      toolChoice: useTool && structuredTool ? { name: structuredTool.name } : undefined
    });
    const parsed = parseUtilityResult<T>(result, useTool ? structuredTool : undefined);
    if (jsonValueIsEmpty(parsed)) {
      throw new AIError('The model returned an empty reply. Try again or pick a different model in Settings.');
    }
    return parsed;
  };

  try {
    try {
      return await run(canTool, maxTokens);
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      if (!isRetryableUtilityFail(e)) throw e;
    }
    return await run(false, bumpTokens);
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

/** Live scene state + canon in one post-write pass. */
export const LIVE_MEMORY_TOOL: ToolSpec = {
  name: 'update_live_memory',
  description: 'Update live cast state, the room ledger, and file new durable canon from recent play.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      updates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            goal: { type: 'string' },
            emotion: { type: 'string' },
            location: { type: 'string' },
            condition: { type: 'string' }
          }
        }
      },
      scene: { type: 'array', items: { type: 'string' } },
      ties: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            from: { type: 'string' },
            to: { type: 'string' },
            kind: { type: 'string' },
            note: { type: 'string' }
          }
        }
      },
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
