import { useState } from 'react';
import { db, safeWrite, uid } from '../db';
import {
  DEFAULT_STATS, INVENTORY_CAP, STAT_CAP, STAT_MAX, STAT_MIN, clampStat, defaultMechanics
} from '../mechanics';
import type { Character, InventoryItem, MechanicsDifficulty, StatDef, World, WorldMechanics } from '../types';
import { Chip, Field, Toggle } from '../ui/bits';

const DIFFICULTIES: Array<{ id: MechanicsDifficulty; label: string }> = [
  { id: 'forgiving', label: 'Forgiving' },
  { id: 'fair', label: 'Fair' },
  { id: 'harsh', label: 'Harsh' }
];

function slug(name: string, taken: Set<string>): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'stat';
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
  return key;
}

/**
 * Light game rules for one world: the on/off switch, how hard the world pushes
 * back, stat names, and the player's stats and pack.
 */
export function GameRulesSection({
  world, player, onSaveFail
}: {
  world: World;
  player: Character | undefined;
  onSaveFail?: (message: string) => void;
}) {
  const rules: WorldMechanics = world.mechanics ?? defaultMechanics();
  const stats = rules.stats.length > 0 ? rules.stats : DEFAULT_STATS;
  const [newItem, setNewItem] = useState('');

  const patchRules = (patch: Partial<WorldMechanics>) =>
    void safeWrite(async () => {
      const row = await db.worlds.get(world.id);
      if (!row) return;
      const base = row.mechanics ?? defaultMechanics();
      await db.worlds.update(world.id, { mechanics: { ...base, ...patch }, updatedAt: Date.now() });
    }, onSaveFail);

  const patchPlayer = (patch: Partial<Pick<Character, 'stats' | 'inventory'>>) => {
    if (!player) return;
    void safeWrite(() => db.characters.update(player.id, { ...patch, updatedAt: Date.now() }), onSaveFail);
  };

  const renameStat = (index: number, name: string) => {
    const next = stats.map((s, i) => (i === index ? { ...s, name } : s));
    patchRules({ stats: next });
  };

  const addStat = () => {
    if (stats.length >= STAT_CAP) return;
    const taken = new Set(stats.map((s) => s.key));
    const stat: StatDef = { key: slug('New stat', taken), name: 'New stat' };
    patchRules({ stats: [...stats, stat] });
  };

  const removeStat = (index: number) => patchRules({ stats: stats.filter((_, i) => i !== index) });

  const setStat = (key: string, value: number) =>
    patchPlayer({ stats: { ...(player?.stats ?? {}), [key]: clampStat(value) } });

  const items = player?.inventory ?? [];
  const setItems = (next: InventoryItem[]) => patchPlayer({ inventory: next });
  const addItem = () => {
    const name = newItem.trim().slice(0, 60);
    if (!name || items.length >= INVENTORY_CAP) return;
    setItems([...items, { id: uid(), name, qty: 1 }]);
    setNewItem('');
  };

  return (
    <div style={{ borderTop: '1px solid var(--rule)', paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Toggle
          on={rules.enabled}
          label="Game rules"
          onClick={() => patchRules({ enabled: !rules.enabled, stats })}
        />
        <div style={{ fontSize: 12.5, color: 'var(--ink-muted)' }}>
          {rules.enabled
            ? 'Game rules on — risky moves are settled by hidden dice before the story answers'
            : 'Game rules off — the story decides every outcome'}
        </div>
      </div>

      {rules.enabled && (
        <>
          <Field label="How hard the world pushes back">
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {DIFFICULTIES.map((d) => (
                <Chip key={d.id} active={rules.difficulty === d.id} onClick={() => patchRules({ difficulty: d.id })}>
                  {d.label}
                </Chip>
              ))}
            </div>
          </Field>

          <Field
            label={player ? `Stats · ${player.name || 'player'}` : 'Stats'}
            note={`up to ${STAT_CAP}, each ${STAT_MIN} to +${STAT_MAX}`}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {stats.map((stat, index) => (
                <div key={stat.key} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    aria-label="Stat name"
                    defaultValue={stat.name}
                    onBlur={(e) => {
                      const name = e.target.value.trim();
                      if (name && name !== stat.name) renameStat(index, name);
                    }}
                    style={{ flex: 1 }}
                  />
                  <input
                    type="number"
                    min={STAT_MIN}
                    max={STAT_MAX}
                    aria-label={`${stat.name} value`}
                    disabled={!player}
                    value={clampStat(player?.stats?.[stat.key] ?? 0)}
                    onChange={(e) => setStat(stat.key, Number(e.target.value))}
                    style={{ width: 64 }}
                  />
                  <button
                    type="button"
                    className="btn-quiet"
                    style={{ fontSize: 12, minHeight: 36 }}
                    aria-label={`Remove ${stat.name}`}
                    disabled={stats.length <= 1}
                    onClick={() => removeStat(index)}
                  >×</button>
                </div>
              ))}
              {stats.length < STAT_CAP && (
                <button type="button" className="btn-quiet" style={{ alignSelf: 'flex-start', fontSize: 11 }} onClick={addStat}>
                  + add a stat
                </button>
              )}
              {!player && (
                <div className="label">Add a player character to give them stats and a pack.</div>
              )}
            </div>
          </Field>

          {player && (
            <Field label="Carried" note="the story adds and removes things as they change hands">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {items.length === 0 && <div className="label">Nothing yet.</div>}
                {items.map((item) => (
                  <div key={item.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <div style={{ flex: 1, fontSize: 13, color: 'var(--ink-heading)' }}>
                      {item.name}
                      {item.note && <span style={{ color: 'var(--ink-muted)' }}> — {item.note}</span>}
                    </div>
                    <input
                      type="number"
                      min={1}
                      max={99}
                      aria-label={`How many ${item.name}`}
                      value={item.qty}
                      onChange={(e) => {
                        const qty = Math.max(1, Math.min(99, Math.round(Number(e.target.value) || 1)));
                        setItems(items.map((row) => (row.id === item.id ? { ...row, qty } : row)));
                      }}
                      style={{ width: 64 }}
                    />
                    <button
                      type="button"
                      className="btn-quiet"
                      style={{ fontSize: 12, minHeight: 36 }}
                      aria-label={`Remove ${item.name}`}
                      onClick={() => setItems(items.filter((row) => row.id !== item.id))}
                    >×</button>
                  </div>
                ))}
                {items.length < INVENTORY_CAP && (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      aria-label="New item"
                      placeholder="add an item"
                      value={newItem}
                      onChange={(e) => setNewItem(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') addItem(); }}
                      style={{ flex: 1 }}
                    />
                    <button type="button" className="btn-quiet" style={{ fontSize: 12, minHeight: 36 }} onClick={addItem}>
                      add
                    </button>
                  </div>
                )}
              </div>
            </Field>
          )}
        </>
      )}
    </div>
  );
}
