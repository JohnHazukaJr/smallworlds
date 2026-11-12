import type { CharacterImportance } from '../types';

export const CHARACTER_IMPORTANCE: readonly CharacterImportance[] = [
  'lead',
  'regular',
  'occasional',
  'background'
];

export function parseCharacterImportance(value: unknown): CharacterImportance | undefined {
  if (value === 'lead' || value === 'regular' || value === 'occasional' || value === 'background') {
    return value;
  }
  return undefined;
}

/** Missing, blank, or the player card reads as regular. */
export function characterImportance(
  character: { importance?: string | null; isPlayer?: boolean }
): CharacterImportance {
  if (character.isPlayer) return 'regular';
  return parseCharacterImportance(character.importance) ?? 'regular';
}

/** Higher is more central. Used when a crowded room must choose. */
export function importanceRank(
  character: { importance?: string | null; isPlayer?: boolean }
): number {
  switch (characterImportance(character)) {
    case 'lead': return 3;
    case 'regular': return 2;
    case 'occasional': return 1;
    case 'background': return 0;
  }
}

/**
 * Fallback speak score. Regular stays at the old flat cast bonus.
 * Address (70/100), an open question (55), and the last voice (24) all outrank these.
 */
export function importanceSpeakScore(
  character: { importance?: string | null; isPlayer?: boolean }
): number {
  switch (characterImportance(character)) {
    case 'lead': return 8;
    case 'regular': return 2;
    case 'occasional': return 0;
    case 'background': return -6;
  }
}

/**
 * Who may walk on because the place fits.
 * Leads and regulars do. Occasionals do only when nobody more central fits.
 * Background never does.
 */
export function autoStagePool<T extends { importance?: string | null; isPlayer?: boolean }>(
  fitting: T[]
): T[] {
  const core = fitting.filter((c) => {
    const weight = characterImportance(c);
    return weight === 'lead' || weight === 'regular';
  });
  if (core.length > 0) return core;
  return fitting.filter((c) => characterImportance(c) === 'occasional');
}
