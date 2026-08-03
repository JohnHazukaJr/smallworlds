import { useState } from 'react';
import { db } from '../db';
import { useApp } from '../store/app';
import type { Character, Episode, Season, World, WorldAISettings } from '../types';
import { Chip, Field, Mono, Sheet, Toggle } from '../ui/bits';
import { avatarStyle } from '../ui/theme';
import { emptyCharacter } from '../worldOps';

type Tab = 'lore' | 'plot' | 'instructions' | 'cast';

const MONO_INPUT = { fontFamily: "'IBM Plex Mono', monospace", fontSize: 12 } as const;

/**
 * Live world editing without leaving the story. Every field writes straight to the
 * database on blur; prompts are rebuilt from the database each turn, so changes
 * take effect on the very next AI response.
 */
export function WorldEditorSheet({ open, onClose, narrow, world, season, episode, characters }: {
  open: boolean;
  onClose: () => void;
  narrow: boolean;
  world: World;
  season: Season;
  episode: Episode;
  characters: Character[];
}) {
  const go = useApp((s) => s.go);
  const [tab, setTab] = useState<Tab>('lore');
  const [charId, setCharId] = useState<string | null>(null);
  const selected = characters.find((c) => c.id === charId) ?? null;

  const patchWorld = (p: Partial<World>) => void db.worlds.update(world.id, { ...p, updatedAt: Date.now() });
  const patchAI = (p: Partial<WorldAISettings>) => patchWorld({ ai: { ...world.ai, ...p } });
  const patchSeason = (p: Partial<Season>) => void db.seasons.update(season.id, p);
  const patchEpisode = (p: Partial<Episode>) => void db.episodes.update(episode.id, p);
  const patchChar = (id: string, p: Partial<Character>) =>
    void db.characters.update(id, { ...p, updatedAt: Date.now() });

  return (
    <Sheet open={open} onClose={onClose} narrow={narrow} width={520}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div className="serif" style={{ fontWeight: 300, fontSize: 24, color: '#f6f4f0' }}>Edit the world</div>
          <Mono style={{ fontSize: 9 }}>changes apply from the next turn</Mono>
        </div>
        <button className="btn-ghost" style={{ width: 30, height: 30, padding: 0, flexShrink: 0 }} onClick={onClose}>×</button>
      </div>

      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
        {(['lore', 'plot', 'instructions', 'cast'] as const).map((t) => (
          <Chip key={t} active={tab === t} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</Chip>
        ))}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 16, paddingRight: 2 }}>
        {tab === 'lore' && (
          <>
            <Field label="Title">
              <input key={world.id + '-title'} defaultValue={world.title}
                onBlur={(e) => patchWorld({ title: e.target.value.trim() || world.title })} />
            </Field>
            <Field label="Logline" note="the one-line pitch">
              <input key={world.id + '-line'} defaultValue={world.line}
                onBlur={(e) => patchWorld({ line: e.target.value })} />
            </Field>
            <Field label="World bible — lore" note="setting, rules, pressures · in every prompt">
              <textarea key={world.id + '-bible'} rows={14} defaultValue={world.bible}
                onBlur={(e) => patchWorld({ bible: e.target.value })}
                style={{ fontFamily: 'Spectral, serif', fontSize: 14.5, lineHeight: 1.65 }} />
            </Field>
          </>
        )}

        {tab === 'plot' && (
          <>
            <Field label={`Season ${season.number} premise`} note="the plot the narrator is steering toward">
              <textarea key={season.id + '-premise'} rows={5} defaultValue={season.premise}
                onBlur={(e) => patchSeason({ premise: e.target.value })}
                style={{ fontFamily: 'Spectral, serif', fontSize: 14.5, lineHeight: 1.65 }} />
            </Field>
            <Field label="Season title" note="optional">
              <input key={season.id + '-title'} defaultValue={season.title}
                onBlur={(e) => patchSeason({ title: e.target.value })} />
            </Field>
            <Field label={`Episode ${episode.number} title`} note="optional">
              <input key={episode.id + '-title'} defaultValue={episode.title}
                onBlur={(e) => patchEpisode({ title: e.target.value })} />
            </Field>
            <Field label="Episode location" note="where the scene is · feeds the prompt">
              <textarea key={episode.id + '-loc'} rows={2} defaultValue={episode.location}
                onBlur={(e) => patchEpisode({ location: e.target.value })} />
            </Field>
            {season.bible && (
              <Field label="Season recap — previously on" note="carried from the last season">
                <textarea key={season.id + '-recap'} rows={6} defaultValue={season.bible.recap}
                  onBlur={(e) => patchSeason({ bible: { ...season.bible!, recap: e.target.value } })}
                  style={{ fontFamily: 'Spectral, serif', fontSize: 14, lineHeight: 1.6 }} />
              </Field>
            )}
          </>
        )}

        {tab === 'instructions' && (
          <>
            <Field label="World instructions" note="passed to the model verbatim, every request">
              <textarea key={world.id + '-custom'} rows={6} defaultValue={world.ai.customInstructions}
                onBlur={(e) => patchAI({ customInstructions: e.target.value })}
                placeholder="Themes to circle, imagery to reuse, what the story is really about…" />
            </Field>
            <Field label="Narrator hard rules" note="one per line — never broken">
              <textarea key={world.id + '-rules'} rows={4} defaultValue={world.ai.narratorRules.join('\n')}
                onBlur={(e) => patchAI({ narratorRules: e.target.value.split('\n').filter((l) => l.trim()) })}
                placeholder={'Never skip time without asking.\nNever kill a named character without the player in the scene.'} />
            </Field>
            <Field label="Content boundaries" note="lines that are never crossed">
              <textarea key={world.id + '-content'} rows={3} defaultValue={world.ai.contentNotes}
                onBlur={(e) => patchAI({ contentNotes: e.target.value })} />
            </Field>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
              <Field label="Point of view">
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {(['second', 'first', 'third'] as const).map((pov) => (
                    <Chip key={pov} active={world.ai.pov === pov} onClick={() => patchAI({ pov })}>{pov}</Chip>
                  ))}
                </div>
              </Field>
              <Field label="Tense">
                <div style={{ display: 'flex', gap: 6 }}>
                  {(['present', 'past'] as const).map((tense) => (
                    <Chip key={tense} active={world.ai.tense === tense} onClick={() => patchAI({ tense })}>{tense}</Chip>
                  ))}
                </div>
              </Field>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Toggle on={world.ai.mature} onClick={() => patchAI({ mature: !world.ai.mature })} />
              <div style={{ fontSize: 12.5, color: 'rgba(236,234,230,0.6)' }}>
                {world.ai.mature ? 'Adult world — unrestricted' : 'General audience'}
              </div>
            </div>
            <button className="btn-quiet" style={{ alignSelf: 'flex-start', fontSize: 11 }}
              onClick={() => { onClose(); go('settings'); }}>
              prose density, pacing & models → Settings
            </button>
          </>
        )}

        {tab === 'cast' && !selected && (
          <>
            <Mono style={{ fontSize: 9 }}>pick a character to edit</Mono>
            {characters.map((c) => (
              <div key={c.id} onClick={() => setCharId(c.id)} className="hover-bright" style={{
                display: 'flex', gap: 11, alignItems: 'center', padding: '10px 12px', borderRadius: 13,
                cursor: 'pointer', border: '1px solid rgba(255,255,255,0.09)', background: 'rgba(255,255,255,0.04)'
              }}>
                <div style={avatarStyle(c.hue, 34)} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: '#f0eee9' }}>
                    {c.name || 'unnamed'}{c.isPlayer ? ' · player' : ''}
                  </div>
                  <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9.5, opacity: 0.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {c.role || 'no role set'}
                  </div>
                </div>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Chip onClick={() => {
                const c = emptyCharacter(world.id, { name: 'New character' });
                void db.characters.add(c).then(() => setCharId(c.id));
              }}>+ new character</Chip>
              <Chip onClick={() => { onClose(); go('cast'); }}>full editor → Cast</Chip>
            </div>
          </>
        )}

        {tab === 'cast' && selected && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
              <button className="btn-quiet" style={{ fontSize: 11, padding: '4px 6px' }} onClick={() => setCharId(null)}>← cast</button>
              <div style={avatarStyle(selected.hue, 30)} />
              <div style={{ fontSize: 14, fontWeight: 600, color: '#f0eee9', flex: 1 }}>
                {selected.name || 'unnamed'}{selected.isPlayer ? ' · player' : ''}
              </div>
              <button className="btn-quiet" style={{ fontSize: 10 }} onClick={() => { onClose(); go('cast'); }}>full editor</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="Name">
                <input key={selected.id + '-name'} defaultValue={selected.name}
                  onBlur={(e) => patchChar(selected.id, { name: e.target.value })} />
              </Field>
              <Field label="Role">
                <input key={selected.id + '-role'} defaultValue={selected.role}
                  onBlur={(e) => patchChar(selected.id, { role: e.target.value })} />
              </Field>
            </div>
            <Field label="Who they are" note="summary in every prompt when in scene">
              <textarea key={selected.id + '-summary'} rows={4} defaultValue={selected.summary}
                onBlur={(e) => patchChar(selected.id, { summary: e.target.value })} />
            </Field>
            <Field label="Appearance">
              <textarea key={selected.id + '-appearance'} rows={2} defaultValue={selected.appearance}
                onBlur={(e) => patchChar(selected.id, { appearance: e.target.value })} />
            </Field>
            <Field label="Mannerisms" note="recurring physical habits and tics">
              <textarea key={selected.id + '-mannerisms'} rows={2} defaultValue={selected.mannerisms ?? ''}
                onBlur={(e) => patchChar(selected.id, { mannerisms: e.target.value })} />
            </Field>
            <Field label="Backstory" note="revealed only in earned fragments">
              <textarea key={selected.id + '-backstory'} rows={3} defaultValue={selected.backstory ?? ''}
                onBlur={(e) => patchChar(selected.id, { backstory: e.target.value })} />
            </Field>
            <Field label="Voice" note="how they talk">
              <textarea key={selected.id + '-voice'} rows={2} defaultValue={selected.speechStyle}
                onBlur={(e) => patchChar(selected.id, { speechStyle: e.target.value })} />
            </Field>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="Desires">
                <textarea key={selected.id + '-desires'} rows={2} defaultValue={selected.desires}
                  onBlur={(e) => patchChar(selected.id, { desires: e.target.value })} />
              </Field>
              <Field label="Fears">
                <textarea key={selected.id + '-fears'} rows={2} defaultValue={selected.fears}
                  onBlur={(e) => patchChar(selected.id, { fears: e.target.value })} />
              </Field>
            </div>
            <Field label="Secrets" note="acted on, never announced">
              <textarea key={selected.id + '-secrets'} rows={2} defaultValue={selected.secrets}
                onBlur={(e) => patchChar(selected.id, { secrets: e.target.value })} />
            </Field>
            <Field label="Must not know yet" note="the AI never lets them learn this">
              <textarea key={selected.id + '-mnk'} rows={2} defaultValue={selected.mustNotKnow}
                onBlur={(e) => patchChar(selected.id, { mustNotKnow: e.target.value })} />
            </Field>
            <Field label="Behaviour anchors" note="one per line — never broken">
              <textarea key={selected.id + '-anchors'} rows={3} defaultValue={selected.anchors.join('\n')}
                onBlur={(e) => patchChar(selected.id, { anchors: e.target.value.split('\n').filter((l) => l.trim()) })} />
            </Field>
            <Field label="AI directives for this character" note="passed verbatim">
              <textarea key={selected.id + '-ci'} rows={3} defaultValue={selected.customInstructions}
                onBlur={(e) => patchChar(selected.id, { customInstructions: e.target.value })} />
            </Field>
            <Mono style={{ fontSize: 9 }}>current state — right now in the story</Mono>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {([['goal', 'Goal'], ['emotion', 'Emotion'], ['location', 'Location'], ['condition', 'Condition']] as const).map(([k, label]) => (
                <Field key={k} label={label}>
                  <input key={selected.id + '-st-' + k} defaultValue={selected.state[k]} style={MONO_INPUT}
                    onBlur={(e) => patchChar(selected.id, { state: { ...selected.state, [k]: e.target.value } })} />
                </Field>
              ))}
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}
