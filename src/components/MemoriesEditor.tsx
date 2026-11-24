import { db, safeWrite } from '../db';
import { NPC_MEMORY_CAP } from '../npcMemory';
import type { Character, NpcMemory } from '../types';
import { Field } from '../ui/bits';

const WEIGHT_LABEL: Record<NpcMemory['salience'], string> = { 1: 'passing', 2: 'notable', 3: 'never forgets' };

/**
 * What this person remembers of the story. The story files these after each
 * turn; here the author can see them, drop a wrong one, or change how much it
 * matters. Writes go straight to the stored row: the card's draft never holds them.
 */
export function MemoriesEditor({
  character, onError
}: {
  /** The live stored row, not an editing draft. */
  character: Character;
  onError: (message: string) => void;
}) {
  const memories = [...(character.memories ?? [])].sort((a, b) => b.createdAt - a.createdAt);

  const rewrite = (change: (list: NpcMemory[]) => NpcMemory[]) =>
    void safeWrite(async () => {
      const row = await db.characters.get(character.id);
      if (!row) return;
      await db.characters.update(character.id, { memories: change(row.memories ?? []), updatedAt: Date.now() });
    }, onError);

  const forget = (id: string) => rewrite((list) => list.filter((m) => m.id !== id));
  const reweigh = (id: string) => rewrite((list) => list.map((m) =>
    m.id === id ? { ...m, salience: (m.salience === 3 ? 1 : m.salience + 1) as NpcMemory['salience'] } : m
  ));

  return (
    <Field
      label={`What ${character.name || 'they'} remember${character.name ? 's' : ''}`}
      note={`${memories.length} of ${NPC_MEMORY_CAP} · filed by the story after each turn`}
    >
      {memories.length === 0 ? (
        <div className="label">Nothing yet. Memories appear as they live through scenes.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {memories.map((m) => (
            <div key={m.id} style={{
              display: 'flex', gap: 8, alignItems: 'flex-start',
              borderTop: '1px solid var(--rule)', paddingTop: 8
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="serif" style={{ fontSize: 15, lineHeight: 1.5, color: 'var(--ink-heading)' }}>{m.text}</div>
                {m.feeling && <div className="label" style={{ marginTop: 2 }}>left them {m.feeling}</div>}
              </div>
              <button
                type="button"
                className="btn-quiet"
                style={{ fontSize: 11, padding: '4px 8px', minHeight: 30, flexShrink: 0 }}
                title="How much this marked them. Stronger memories surface more often and are kept longest."
                onClick={() => reweigh(m.id)}
              >
                {WEIGHT_LABEL[m.salience]}
              </button>
              <button
                type="button"
                className="btn-quiet"
                style={{ fontSize: 12, padding: '4px 8px', minHeight: 30, flexShrink: 0 }}
                aria-label={`Forget: ${m.text}`}
                onClick={() => forget(m.id)}
              >×</button>
            </div>
          ))}
        </div>
      )}
    </Field>
  );
}
