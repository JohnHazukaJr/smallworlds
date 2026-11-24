import { useLiveQuery } from 'dexie-react-hooks';
import { useState, type ReactNode } from 'react';
import { FALLBACK_BOND_MARKS, FALLBACK_GOAL_MARKS, meaningWords } from '../bonds';
import { db, safeWrite } from '../db';
import type { Character, CurrentKind, Episode, OpenThread, PlotTarget, PlotTargetStatus, Season, World } from '../types';
import { Mono, Sheet } from '../ui/bits';
import { draftChapterCurrents } from '../ai/engine';
import { currentsOn } from '../ai/currents';
import { formatUserError } from '../errors';

const TARGET_LABEL: Record<PlotTargetStatus, string> = { pending: 'open', hit: 'done', dropped: 'dropped' };
const CURRENT_LABEL: Record<PlotTargetStatus, string> = { pending: 'in motion', hit: 'settled', dropped: 'faded' };
const KIND_LABEL: Record<CurrentKind, string> = {
  agenda: 'someone\'s aim', season: 'the season', consequence: 'your doing', thread: 'a loose end', texture: 'texture'
};

function Section({ title, empty, children }: { title: string; empty?: string; children?: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Mono style={{ fontSize: 9.5, letterSpacing: '0.14em', textTransform: 'uppercase' }}>{title}</Mono>
      {children ?? <div className="label">{empty}</div>}
    </div>
  );
}

function Row({ text, meta, actions, faded }: { text: string; meta?: string; actions?: ReactNode; faded?: boolean }) {
  return (
    <div style={{
      display: 'flex', gap: 10, alignItems: 'flex-start',
      borderTop: '1px solid var(--rule)', paddingTop: 8, opacity: faded ? 0.6 : 1
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="serif" style={{ fontSize: 15, lineHeight: 1.5, color: 'var(--ink-heading)' }}>{text}</div>
        {meta && <div className="label" style={{ marginTop: 2 }}>{meta}</div>}
      </div>
      {actions && <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>{actions}</div>}
    </div>
  );
}

/**
 * The player's journal: what is unresolved, what this chapter is reaching
 * for, and how their goals and closest ties stand.
 */
export function JournalSheet({
  open, onClose, narrow, world, season, episode, characters
}: {
  open: boolean;
  onClose: () => void;
  narrow: boolean;
  world: World;
  season: Season;
  episode: Episode;
  characters: Character[];
}) {
  const [showResolved, setShowResolved] = useState(false);
  // Hidden until asked: knowing what is in motion spoils finding it in play.
  const [showCurrents, setShowCurrents] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [saveError, setSaveError] = useState('');
  const threads = useLiveQuery(
    async () => (open ? db.threads.where('seasonId').equals(season.id).toArray() : []),
    [open, season.id]
  ) ?? [];
  const openThreads = threads
    .filter((t) => t.status === 'open')
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.createdAt - a.createdAt);
  const resolved = threads.filter((t) => t.status === 'resolved').sort((a, b) => b.createdAt - a.createdAt);
  const targets = (episode.plotTargets ?? []).filter((t) => t.source !== 'outline');
  const currents = (episode.plotTargets ?? []).filter((t) => t.source === 'outline');
  const liveCount = currents.filter((t) => t.status === 'pending').length;
  const player = characters.find((c) => c.isPlayer);

  const patchTarget = (id: string, patch: (t: PlotTarget) => PlotTarget) =>
    void safeWrite(async () => {
      const fresh = await db.episodes.get(episode.id);
      if (!fresh) return;
      await db.episodes.update(episode.id, {
        plotTargets: (fresh.plotTargets ?? []).map((t) => (t.id === id ? patch(t) : t)),
        updatedAt: Date.now()
      });
    }, setSaveError);
  // Yours now: an author target, which outranks currents and is never redrafted.
  const adopt = (id: string) => patchTarget(id, ({ id: keep, text }) => ({ id: keep, text, status: 'pending', source: 'manual' }));
  const fade = (id: string) => patchTarget(id, (t) => ({ ...t, status: 'dropped', note: 'dropped by you' }));
  const redraft = async () => {
    setDrafting(true);
    setSaveError('');
    try {
      await draftChapterCurrents(world, season, episode.id, { force: true });
    } catch (e) {
      setSaveError(formatUserError(e));
    } finally {
      setDrafting(false);
    }
  };
  const goals = (player?.goals ?? []).filter((g) => g.text.trim());
  const bonds = player
    ? characters.flatMap((c) => c.isPlayer ? [] : c.relationships
      .filter((r) => r.track && r.targetId === player.id)
      .map((r) => ({ name: c.name, words: meaningWords(r.score ?? 0, r.marks, FALLBACK_BOND_MARKS) })))
    : [];

  const patchThread = (thread: OpenThread, patch: Partial<OpenThread>) =>
    void safeWrite(() => db.threads.update(thread.id, { ...patch, updatedAt: Date.now() }), setSaveError);

  const small = { fontSize: 11, padding: '4px 8px', minHeight: 30 } as const;

  return (
    <Sheet open={open} onClose={onClose} narrow={narrow} width={480}
      footer={<button className="btn-primary" style={{ width: '100%', minHeight: 44 }} onClick={onClose}>Done</button>}
    >
      <div className="serif" style={{ fontWeight: 300, fontSize: 24, color: 'var(--ink-heading)' }}>Journal</div>
      {saveError && <div className="label" style={{ color: 'var(--danger, inherit)' }}>{saveError}</div>}

      <Section title={`Open threads · ${openThreads.length}`} empty="Nothing unresolved yet.">
        {openThreads.length > 0 ? openThreads.map((t) => (
          <Row
            key={t.id}
            text={t.text}
            meta={`${t.openedLabel}${t.pinned ? ' · pinned' : ''}`}
            actions={(
              <>
                <button type="button" className="btn-quiet" style={small} aria-pressed={!!t.pinned}
                  title="A pinned thread is always kept in the story's memory"
                  onClick={() => patchThread(t, { pinned: !t.pinned })}>
                  {t.pinned ? 'Unpin' : 'Pin'}
                </button>
                <button type="button" className="btn-quiet" style={small}
                  onClick={() => patchThread(t, { status: 'resolved', pinned: false })}>
                  Resolve
                </button>
              </>
            )}
          />
        )) : undefined}
        {resolved.length > 0 && (
          <button type="button" className="btn-quiet" style={{ alignSelf: 'flex-start', fontSize: 11 }}
            onClick={() => setShowResolved((v) => !v)}>
            {showResolved ? 'Hide' : 'Show'} resolved ({resolved.length})
          </button>
        )}
        {showResolved && resolved.map((t) => (
          <Row key={t.id} text={t.text} meta={t.openedLabel} faded actions={(
            <button type="button" className="btn-quiet" style={small} onClick={() => patchThread(t, { status: 'open' })}>
              Reopen
            </button>
          )} />
        ))}
      </Section>

      <Section title={`This chapter is reaching for`} empty="No plot targets for this chapter.">
        {targets.length > 0 ? targets.map((t) => (
          <Row key={t.id} text={t.text} meta={TARGET_LABEL[t.status]} faded={t.status !== 'pending'} />
        )) : undefined}
      </Section>

      {currentsOn(world) && (
        <Section title={`In motion · ${liveCount}`}>
          <div className="label" style={{ lineHeight: 1.5 }}>
            What the world is doing on its own: people&rsquo;s aims, the season, what your actions set off.
            The story lets these surface; it never pushes you toward them.
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button type="button" className="btn-quiet" style={small} aria-expanded={showCurrents}
              onClick={() => setShowCurrents((v) => !v)}>
              {showCurrents ? 'Hide' : 'Show'} (may spoil)
            </button>
            <button type="button" className="btn-quiet" style={small} disabled={drafting} onClick={() => void redraft()}
              title="Read the story so far again and redraft what is in motion">
              {drafting ? 'Redrafting…' : 'Redraft'}
            </button>
          </div>
          {showCurrents && (currents.length === 0
            ? <div className="label">Nothing yet. Currents are drafted after the first reply of a chapter.</div>
            : currents.map((t) => (
              <Row
                key={t.id}
                text={t.text}
                faded={t.status !== 'pending'}
                meta={[
                  CURRENT_LABEL[t.status],
                  t.kind ? KIND_LABEL[t.kind] : '',
                  t.who?.length ? t.who.join(', ') : '',
                  t.note ? `lately: ${t.note}` : '',
                  t.status === 'pending' && t.could?.length ? `could go: ${t.could.join(' / ')}` : ''
                ].filter(Boolean).join(' · ')}
                actions={t.status === 'pending' ? (
                  <>
                    <button type="button" className="btn-quiet" style={small}
                      title="Make this one of your own plot targets"
                      onClick={() => adopt(t.id)}>Make it mine</button>
                    <button type="button" className="btn-quiet" style={small} onClick={() => fade(t.id)}>Drop</button>
                  </>
                ) : undefined}
              />
            )))}
        </Section>
      )}

      {player && (
        <Section title={`${player.name || 'Your'} goals`} empty="No goals yet. Add them on the character card.">
          {goals.length > 0 ? goals.map((g) => {
            const words = meaningWords(g.score, g.marks, FALLBACK_GOAL_MARKS);
            return <Row key={g.id} text={g.text} meta={words.next ? `${words.current} → next: ${words.next}` : words.current} />;
          }) : undefined}
        </Section>
      )}

      {bonds.length > 0 && (
        <Section title="How they feel about you">
          {bonds.map((b) => (
            <Row key={b.name} text={b.name} meta={b.words.next ? `${b.words.current} → next: ${b.words.next}` : b.words.current} />
          ))}
        </Section>
      )}
    </Sheet>
  );
}
