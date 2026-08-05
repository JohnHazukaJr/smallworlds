import type { Character, Relationship } from './types';

/** Common kind chips in the Relations editor. */
export const KIND_PRESETS = [
  'ally', 'rival', 'lover', 'family', 'debt', 'mentor', 'friend', 'enemy'
] as const;

export type KindPreset = (typeof KIND_PRESETS)[number];

export interface InboundLink {
  from: Character;
  rel: Relationship;
}

/** Dedupe by targetId, drop self-links and targets not in the cast. */
export function normalizeRelationships(
  rels: Relationship[],
  castIds: Iterable<string>,
  selfId?: string
): Relationship[] {
  const allowed = new Set(castIds);
  const byTarget = new Map<string, Relationship>();
  for (const r of rels) {
    const targetId = (r.targetId ?? '').trim();
    if (!targetId || !allowed.has(targetId)) continue;
    if (selfId && targetId === selfId) continue;
    const kind = (r.kind ?? '').trim() || 'linked';
    const note = (r.note ?? '').trim();
    const prev = byTarget.get(targetId);
    if (!prev) {
      byTarget.set(targetId, { targetId, kind, note });
      continue;
    }
    // Keep earlier kind if non-empty; prefer longer note when both set.
    byTarget.set(targetId, {
      targetId,
      kind: prev.kind.trim() ? prev.kind : kind,
      note: prev.note.trim()
        ? (note && note.length > prev.note.length ? note : prev.note)
        : note
    });
  }
  return [...byTarget.values()];
}

/** Strip dead targetIds from every character after a cast member is removed. */
export function pruneRelationshipsToCast(characters: Character[]): Character[] {
  const ids = new Set(characters.map((c) => c.id));
  return characters.map((c) => ({
    ...c,
    relationships: normalizeRelationships(c.relationships, ids, c.id)
  }));
}

/** Who has an outbound link pointing at subjectId. */
export function inboundFor(subjectId: string, cast: Character[]): InboundLink[] {
  const out: InboundLink[] = [];
  for (const from of cast) {
    if (from.id === subjectId) continue;
    for (const rel of from.relationships) {
      if (rel.targetId === subjectId) out.push({ from, rel });
    }
  }
  return out;
}

/** Suggest a kind for the reverse edge (still directed / independently editable). */
export function suggestInverseKind(kind: string): string {
  const k = kind.trim().toLowerCase();
  const map: Record<string, string> = {
    ally: 'ally',
    rival: 'rival',
    lover: 'lover',
    family: 'family',
    friend: 'friend',
    enemy: 'enemy',
    mentor: 'student',
    student: 'mentor',
    debt: 'owed',
    owed: 'debt'
  };
  return map[k] ?? (kind.trim() || 'linked');
}

export function hasLink(rels: Relationship[], toId: string): boolean {
  return rels.some((r) => r.targetId === toId);
}

/** Upsert a single outbound link keyed by targetId. */
export function upsertLink(rels: Relationship[], link: Relationship): Relationship[] {
  const next = [...rels];
  const i = next.findIndex((r) => r.targetId === link.targetId);
  const row: Relationship = {
    targetId: link.targetId,
    kind: (link.kind ?? '').trim() || 'linked',
    note: (link.note ?? '').trim()
  };
  if (i >= 0) next[i] = row;
  else next.push(row);
  return next;
}

export function removeLink(rels: Relationship[], toId: string): Relationship[] {
  return rels.filter((r) => r.targetId !== toId);
}

/** Cast members not yet linked from subject (for the add picker). */
export function unlinkedOthers(subject: Character, cast: Character[]): Character[] {
  const linked = new Set(subject.relationships.map((r) => r.targetId));
  return cast.filter((c) => c.id !== subject.id && c.name.trim() && !linked.has(c.id));
}
