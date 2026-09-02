import { resolveModel, useSettings } from '../store/settings';
import type { ModelRef, World } from '../types';
import { AIError } from './client';

function requireModel(ref: ModelRef | null, label: string) {
  const resolved = resolveModel(ref);
  if (!resolved) {
    throw new AIError(`No ${label} model configured. Add a provider and pick a model in Settings.`);
  }
  return resolved;
}

export function proseModelFor(world: World | null) {
  const s = useSettings.getState();
  return requireModel(world?.proseModel ?? s.proseModel, 'writing');
}

export function utilityModelFor(world: World | null) {
  const s = useSettings.getState();
  return requireModel(world?.utilityModel ?? s.utilityModel ?? world?.proseModel ?? s.proseModel, 'utility');
}

export function imageModelFor(world: World | null) {
  const s = useSettings.getState();
  return requireModel(
    world?.imageModel ?? s.imageModel ?? world?.proseModel ?? s.proseModel,
    'image'
  );
}
