import type { World } from '../types';
import { AIError, streamChat, type ChatJob, type ToolSpec } from './client';
import { modelProfile, paddedMaxTokens, thinkingOnForJob } from './modelProfile';
import { utilityModelFor } from './models';

export type { ToolSpec };

/** A parse failure that carries the start of the reply, so a log shows what the model sent. */
function unreadable(message: string, raw: string): AIError {
  const err = new AIError(message);
  err.raw = raw.trim().slice(0, 300) || '(empty)';
  return err;
}

export function extractJson<T>(raw: string): T {
  const cleaned = raw.replace(/```(?:json)?/g, '').trim();
  const start = Math.min(
    ...['{', '['].map((c) => cleaned.indexOf(c)).filter((i) => i >= 0)
  );
  if (!Number.isFinite(start)) throw unreadable('The model did not return JSON.', raw);
  const open = cleaned[start];
  const close = open === '{' ? '}' : ']';
  const end = cleaned.lastIndexOf(close);
  if (end <= start) throw unreadable('The model returned malformed JSON.', raw);
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch {
    throw unreadable('The model returned malformed JSON.', raw);
  }
}

export function parseToolArguments<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return extractJson<T>(raw);
  }
}

const DEFAULT_UTILITY_TIMEOUT_MS = 60_000;

/**
 * Prompts were written for a return_json tool that is not always sent.
 * Without it, ask for plain JSON so the model does not try to call a tool.
 */
export function jsonInstruction(system: string, toolName?: string): string {
  if (toolName === 'return_json') return system;
  return system.replace(/Call return_json with/g, 'Reply with only a JSON object, with');
}

/** A slow model that is still sending gets this many times the silence limit in total. */
export const UTILITY_HARD_CAP_FACTOR = 2.5;

/**
 * Aborts after `silenceMs` with nothing from the provider, or `silenceMs * UTILITY_HARD_CAP_FACTOR`
 * in total. A model that is still writing is not cut off at the silence limit and retried
 * from nothing; that wasted every token and made slow models fail every time.
 */
export function withStallSignal(outer: AbortSignal | undefined, silenceMs: number): {
  signal: AbortSignal; activity: () => void; cancel: () => void;
} {
  const ctrl = new AbortController();
  const onOuter = () => ctrl.abort();
  outer?.addEventListener('abort', onOuter);
  const abort = () => ctrl.abort();
  let idle = setTimeout(abort, silenceMs);
  const hard = setTimeout(abort, Math.round(silenceMs * UTILITY_HARD_CAP_FACTOR));
  return {
    signal: ctrl.signal,
    activity: () => {
      if (ctrl.signal.aborted) return;
      clearTimeout(idle);
      idle = setTimeout(abort, silenceMs);
    },
    cancel: () => {
      clearTimeout(idle);
      clearTimeout(hard);
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
  try {
    return extractJson<T>(result.text);
  } catch (e) {
    const args = result.toolCalls?.map((c) => `${c.name}(${c.arguments ?? ''})`).join(' ');
    if (e instanceof AIError && args && !result.text.trim()) e.raw = `tool call: ${args}`.slice(0, 300);
    throw e;
  }
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
  const { provider, model } = utilityModelFor(opts.world);
  const profile = modelProfile(model);
  const maxTokens = paddedMaxTokens(
    model,
    opts.maxTokens ?? 3000,
    thinkingOnForJob(model, job)
  );
  // Each attempt gets the full limit; a retry does not inherit what the first one used up.
  const timeoutMs = opts.timeoutMs ?? (job === 'wrap' ? 90_000 : DEFAULT_UTILITY_TIMEOUT_MS);
  const structuredTool = toolHasProperties(opts.tool) ? opts.tool : undefined;
  const canTool = !!(structuredTool && profile.supportsTools && provider.kind === 'openai');
  const bumpTokens = Math.max(maxTokens + 2000, Math.floor(maxTokens * 1.5));

  const run = async (useTool: boolean, tokens: number): Promise<T> => {
    const { signal: timed, activity, cancel } = withStallSignal(opts.signal, timeoutMs);
    try {
      const result = await streamChat({
        onActivity: activity,
        provider,
        model,
        system: jsonInstruction(opts.system, useTool ? structuredTool?.name : undefined),
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
    } catch (e) {
      if ((e as Error).name === 'AbortError' && !opts.signal?.aborted) {
        throw new AIError(`Utility model timed out after ${timeoutMs / 1000}s.`);
      }
      throw e;
    } finally {
      cancel();
    }
  };

  try {
    return await run(canTool, maxTokens);
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    if (!isRetryableUtilityFail(e)) throw e;
  }
  return run(false, bumpTokens);
}

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
            condition: { type: 'string' },
            wearing: { type: 'string' }
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
      movedTo: {
        type: ['object', 'null'],
        description: 'Only when the scene itself has now moved to a different place.',
        properties: {
          place: { type: 'string', description: 'Exact name of a saved place from the list' },
          newPlace: { type: 'string', description: 'Short name of a place not on the list' }
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
      },
      suggestions: { type: 'array', items: { type: 'string' } },
      currents: {
        type: 'array',
        description: 'Only listed Currents the newest beats touched. Omit untouched ones.',
        items: {
          type: 'object',
          properties: {
            n: { type: 'integer' },
            status: { type: 'string', enum: ['stirred', 'bent', 'resolved', 'faded'] },
            note: { type: 'string' },
            now: { type: 'string' }
          }
        }
      },
      inventory: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['add', 'remove'] },
            name: { type: 'string' },
            note: { type: 'string' },
            qty: { type: 'integer' }
          }
        }
      },
      memories: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            text: { type: 'string' },
            feeling: { type: 'string' },
            salience: { type: 'integer' }
          }
        }
      },
      bonds: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            shift: { type: 'integer' },
            reason: { type: 'string' }
          }
        }
      },
      goals: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer' },
            text: { type: 'string' },
            shift: { type: 'integer' },
            reason: { type: 'string' }
          }
        }
      }
    }
  }
};
