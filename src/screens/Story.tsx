import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import {
  commitSoftEpisodeWrap, deleteTurnsAfter, deleteTurnsFrom, draftColdOpenNarration,
  rollbackTurnSnapshot,
  snapshotTurnsAfter, snapshotTurnsFrom, writeTurn,
  discardPendingPlan,
  WriteAbortedError, type StreamMeta
} from '../ai/engine';
import {
  parseDeliveryTone,
  type DeliveryTone
} from '../ai/deliveryTone';
import {
  groupSpeakParagraphs,
  parseInlineEmphasis,
  parseSpeakSegments,
  previewSpeakText,
  stripNarratorEmbeddedDialogue,
  type SpeakSegment
} from '../ai/dialogueFormat';
import {
  resolveSpeakerName,
  type DirectorBeat
} from '../ai/prompts';
import { WorldEditorSheet } from '../components/WorldEditorSheet';
import { db, recordTombstones } from '../db';
import {
  DEFAULT_DISPLAY, moodFromHue, storyAvatarHeight, useApp,
  type DialogueStyle, type StoryLayout
} from '../store/app';
import { hasWritingModel } from '../ai/models';
import { useSettings } from '../store/settings';
import type {
  Character, ComposeMode, Episode, EpisodeGuest,
  Location, Turn, TurnLength, ActionWeight
} from '../types';
import { AppError, classifyError } from '../errors';
import {
  Chip, ConfirmBar, ErrorNote, Mono, Sheet, Spinner,
  phoneChrome, sheetsFromBottom, shortStoryChrome, useViewport
} from '../ui/bits';
import { Face } from '../ui/Face';
import { attributionRun, isDialogueBlock, lastSpokenBy } from '../ui/attribution';
import { abortWriteNotice, unfinishedWriteNotice, NOTICE_ADD_MODEL, noticeNavAction } from '../ui/writeNotices';
import { avatarStyle, speakerInk, MOODS, ACCENT, ACCENT_RGBA } from '../ui/theme';
import {
  characterPortraits, evaluateWorldWriteReady, formatStoryDate,
  buildEpisodePlotTargets, latestEndedEpisode, nextEpisode, worldCalendar
} from '../worldOps';

// ---------- prose rendering ----------

interface ProseBlock {
  text: string;
  speaker?: string;
  hue?: number;
  portrait?: string | null;
  kind: 'narration' | 'dialogue' | 'direction' | 'action' | 'speak';
  /** For kind === 'speak': parsed *action* / "speech" segments */
  segments?: SpeakSegment[];
  /** Player delivery tag from leading [tone] on the turn */
  deliveryTone?: DeliveryTone | null;
}

function guestHue(guestId: string): number {
  let h = 0;
  for (let i = 0; i < guestId.length; i++) h = (h + guestId.charCodeAt(i) * 17) % 360;
  return h;
}

function SceneCastStrip({
  cast, guests, empty, onOpen
}: {
  cast: Character[];
  guests: EpisodeGuest[];
  empty: boolean;
  onOpen: () => void;
}) {
  const names = [
    ...cast.map((c) => c.name || 'unnamed'),
    ...guests.map((g) => g.name)
  ];
  const size = empty ? 44 : 32;
  const overlap = empty ? -12 : -10;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="serif"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: empty ? 10 : 7,
        marginTop: empty ? 14 : 8,
        padding: 0,
        border: 0,
        background: 'transparent',
        cursor: 'pointer',
        textAlign: 'left',
        width: '100%'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center' }}>
        {cast.map((c, i) => (
          <div key={c.id} style={{ marginLeft: i === 0 ? 0 : overlap, zIndex: i + 1 }}>
            <Face hue={c.hue} size={size} portrait={characterPortraits(c)[0]} name={c.name} />
          </div>
        ))}
        {guests.map((g, i) => (
          <div key={g.id} style={{ marginLeft: cast.length + i === 0 ? 0 : overlap, zIndex: cast.length + i + 1 }}>
            <Face hue={guestHue(g.id)} size={size} name={g.name} />
          </div>
        ))}
      </div>
      <div style={{
        fontSize: empty ? 13.5 : 12,
        fontStyle: 'italic',
        lineHeight: 1.4,
        color: 'var(--ink-muted)'
      }}>
        {names.join(' · ')}
      </div>
    </button>
  );
}

function parseTurn(turn: Turn, characters: Character[], guests: EpisodeGuest[] = []): ProseBlock[] {
  if (turn.role === 'user' && turn.asCharacterId) {
    const who = characters.find((c) => c.id === turn.asCharacterId);
    return [{
      text: turn.text,
      speaker: who?.name ?? 'they',
      hue: who?.hue ?? 200,
      portrait: who ? characterPortraits(who)[0] : null,
      kind: 'action'
    }];
  }
  if (turn.role === 'user') {
    const player = characters.find((c) => c.isPlayer);
    if (turn.mode === 'speak' || turn.mode === 'play') {
      const { tone, body } = parseDeliveryTone(turn.text);
      return [{
        text: body,
        speaker: player?.name ?? 'you',
        hue: player?.hue ?? 60,
        portrait: player ? characterPortraits(player)[0] : null,
        kind: 'speak',
        segments: parseSpeakSegments(body),
        deliveryTone: tone
      }];
    }
    if (turn.mode === 'act') {
      const { tone, body } = parseDeliveryTone(turn.text);
      return [{
        text: body,
        speaker: player?.name ?? 'you',
        hue: player?.hue ?? 60,
        portrait: player ? characterPortraits(player)[0] : null,
        kind: 'action',
        deliveryTone: tone
      }];
    }
    return [{ text: turn.text, kind: 'direction' }];
  }
  if (turn.role === 'character') {
    const who = turn.characterId
      ? characters.find((c) => c.id === turn.characterId)
      : undefined;
    const guest = turn.guestId
      ? guests.find((g) => g.id === turn.guestId)
      : undefined;
    return [{
      text: turn.text,
      speaker: who?.name ?? guest?.name ?? resolveSpeakerName(turn, characters, guests),
      hue: who?.hue ?? (guest ? guestHue(guest.id) : 200),
      portrait: who ? characterPortraits(who)[0] : null,
      kind: 'speak',
      segments: parseSpeakSegments(turn.text)
    }];
  }
  const text = stripNarratorEmbeddedDialogue(turn.text) || turn.text;
  return [{ text, kind: 'narration' }];
}

function EmphasizedText({ text }: { text: string }) {
  return (
    <>
      {parseInlineEmphasis(text).map((run, i) =>
        run.strong ? (
          <strong key={i} style={{ fontWeight: 700 }}>{run.text}</strong>
        ) : (
          <span key={i}>{run.text}</span>
        )
      )}
    </>
  );
}

function SpeakParagraph({
  segments, accent, prose, fontPx, last, lead, caret, novel
}: {
  segments: SpeakSegment[];
  accent: string;
  prose: string;
  fontPx: number;
  last: boolean;
  /** inline speaker attribution, prose layout only */
  lead?: ReactNode;
  caret?: boolean;
  /** novel page: gestures stay in the same ink as the sentence */
  novel?: boolean;
}) {
  return (
    <p
      className="serif"
      style={{
        fontSize: fontPx,
        lineHeight: 1.82,
        margin: 0,
        marginBottom: last ? 0 : 10,
        textWrap: 'pretty'
      }}
    >
      {lead}
      {segments.map((seg, i) => {
        if (seg.kind === 'action') {
          return (
            <span
              key={i}
              style={novel ? {
                fontStyle: 'italic',
                fontWeight: 400,
                color: prose,
                marginRight: 6
              } : {
                fontWeight: 600,
                fontStyle: 'normal',
                color: accent,
                marginRight: 6
              }}
            >
              {seg.text}
            </span>
          );
        }
        if (seg.kind === 'speech') {
          return (
            <span key={i} style={{ fontStyle: 'italic', color: prose }}>
              “<EmphasizedText text={seg.text} />”
              {i < segments.length - 1 ? ' ' : ''}
            </span>
          );
        }
        return (
          <span key={i} style={{ color: 'var(--ink-muted)', fontStyle: 'normal' }}>
            {seg.text}{' '}
          </span>
        );
      })}
      {last && caret && <span className="prose-caret" aria-hidden />}
    </p>
  );
}

function SpeakBody({
  segments, accent, prose, fontPx, lead, caret, novel
}: {
  segments: SpeakSegment[];
  accent: string;
  prose: string;
  fontPx: number;
  lead?: ReactNode;
  caret?: boolean;
  novel?: boolean;
}) {
  const paras = groupSpeakParagraphs(segments);
  return (
    <div>
      {paras.map((para, pi) => (
        <SpeakParagraph
          key={pi}
          segments={para}
          accent={accent}
          prose={prose}
          fontPx={fontPx}
          last={pi === paras.length - 1}
          lead={pi === 0 ? lead : undefined}
          caret={caret}
          novel={novel}
        />
      ))}
    </div>
  );
}

/** Inline attribution for prose layout — the speaker's own hue does the identifying. */
function SpeakerLead({ b }: { b: ProseBlock }) {
  const ink = b.hue !== undefined ? speakerInk(b.hue) : 'var(--ink-heading)';
  return (
    <span style={{
      color: ink,
      fontWeight: 600,
      fontVariant: 'small-caps',
      letterSpacing: '0.06em',
      marginRight: 8
    }}>
      {b.speaker}
      {b.deliveryTone && (
        <span style={{
          fontVariant: 'normal',
          fontWeight: 400,
          fontStyle: 'italic',
          letterSpacing: 0,
          opacity: 0.62
        }}>
          {`, ${b.deliveryTone}`}
        </span>
      )}
      {' '}
    </span>
  );
}

function OpeningNarration({
  text, prose, fontPx, caret
}: {
  text: string;
  prose: string;
  fontPx: number;
  caret?: boolean;
}) {
  const t = text.trimStart();
  const first = t.charAt(0);
  const rest = t.slice(1);
  const drop = first && /^[\p{L}]/u.test(first);
  return (
    <p
      className="serif"
      style={{
        fontSize: fontPx,
        lineHeight: 1.82,
        margin: 0,
        color: prose,
        textWrap: 'pretty'
      }}
    >
      {drop ? <span className="prose-drop">{first}</span> : first}
      <EmphasizedText text={rest} />
      {caret && <span className="prose-caret" aria-hidden />}
    </p>
  );
}

function ProseBlockView({
  b, accent, prose, fontPx, avatarPx, dialogueStyle, continues, opening, caret, fromPlayer
}: {
  b: ProseBlock;
  accent: string;
  prose: string;
  fontPx: number;
  avatarPx: number;
  dialogueStyle: DialogueStyle;
  /** previous block was the same speaker — drop the repeat attribution */
  continues?: boolean;
  /** first narration of the episode — drop-cap the opening letter */
  opening?: boolean;
  /** live stream caret at the end of this block */
  caret?: boolean;
  fromPlayer?: boolean;
}) {
  const isDialog = isDialogueBlock(b);
  const caretMark = caret ? <span className="prose-caret" aria-hidden /> : null;
  const faceHue = b.hue ?? 200;
  const face = isDialog ? (
    <Face
      hue={faceHue}
      size={continues ? Math.max(32, Math.round(avatarPx * 0.82)) : avatarPx}
      portrait={b.portrait}
      name={b.speaker}
      glow={!continues}
    />
  ) : null;

  if (dialogueStyle === 'prose') {
    const kindClass =
      b.kind === 'direction' ? 'steer'
      : isDialog ? `speak${fromPlayer ? ' player' : ''}${continues ? ' continues' : ''}`
      : '';
    const lead = isDialog && b.speaker && !continues ? <SpeakerLead b={b} /> : undefined;

    if (b.kind === 'direction') {
      return (
        <div className={`prose-block ${kindClass}`}>
          <p
            className="serif"
            style={{
              fontSize: Math.max(14, fontPx - 2),
              lineHeight: 1.7,
              margin: 0,
              fontStyle: 'italic',
              color: 'var(--ink-muted)',
              textWrap: 'pretty'
            }}
          >
            {b.text}
            {caretMark}
          </p>
        </div>
      );
    }

    if (opening && b.kind === 'narration') {
      return (
        <div className="prose-block">
          <OpeningNarration text={b.text} prose={prose} fontPx={fontPx} caret={caret} />
        </div>
      );
    }

    const copy = b.kind === 'speak' && b.segments ? (
      <SpeakBody segments={b.segments} accent={accent} prose={prose} fontPx={fontPx} lead={lead} caret={caret} novel />
    ) : (
      <p className="serif" style={{
        fontSize: fontPx,
        lineHeight: 1.82,
        margin: 0,
        color: prose,
        fontStyle: b.kind === 'dialogue' || b.kind === 'action' ? 'italic' : 'normal',
        textWrap: 'pretty'
      }}>
        {lead}
        <EmphasizedText text={b.text} />
        {caretMark}
      </p>
    );

    if (isDialog && face) {
      return (
        <div className={`prose-block ${kindClass} speak-row`.trim()}>
          {face}
          <div className="speak-copy">{copy}</div>
        </div>
      );
    }

    return (
      <div className={`prose-block ${kindClass}`.trim()}>
        {copy}
      </div>
    );
  }

  return (
    <div
      className={isDialog ? `speak-row${fromPlayer ? ' player' : ''}${continues ? ' continues' : ''}` : undefined}
      style={{
        display: 'flex',
        gap: 14,
        alignItems: 'flex-start',
        marginBottom: isDialog ? 24 : 22,
        flexDirection: isDialog && fromPlayer ? 'row-reverse' : 'row'
      }}
    >
      {face}
      <div style={{
        flex: 1, minWidth: 0,
        ...(isDialog ? { borderLeft: fromPlayer ? 0 : `1px solid ${accent}55`, borderRight: fromPlayer ? `1px solid ${accent}55` : 0, paddingLeft: fromPlayer ? 0 : 14, paddingRight: fromPlayer ? 14 : 0 } : {})
      }}>
        {isDialog && b.speaker && (
          <div style={{
            fontFamily: "'IBM Plex Mono', monospace", fontSize: 9.5, letterSpacing: '0.14em',
            textTransform: 'uppercase', color: accent, marginBottom: 6,
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
            justifyContent: fromPlayer ? 'flex-end' : 'flex-start'
          }}>
            <span>{b.speaker}{b.kind === 'action' ? ' · acts' : ''}</span>
            {b.deliveryTone && (
              <span style={{
                letterSpacing: '0.08em', fontSize: 9, fontWeight: 500,
                color: 'var(--ink-muted)',
                border: '1px solid var(--rule)',
                borderRadius: 6, padding: '2px 7px'
              }}>
                {b.deliveryTone}
              </span>
            )}
          </div>
        )}
        {b.kind === 'direction' ? (
          <p style={{
            fontFamily: "'IBM Plex Mono', monospace", fontSize: 11.5, lineHeight: 1.7, margin: 0,
            color: 'var(--ink-muted)', borderLeft: '1px solid var(--rule)', paddingLeft: 12
          }}>
            you direct: {b.text}
          </p>
        ) : b.kind === 'speak' && b.segments ? (
          <SpeakBody segments={b.segments} accent={accent} prose={prose} fontPx={fontPx} />
        ) : (
          <p className="serif" style={{
            fontSize: fontPx, lineHeight: 1.78, margin: 0, color: prose,
            fontStyle: b.kind === 'dialogue' ? 'italic' : 'normal', textWrap: 'pretty'
          }}>
            <EmphasizedText text={b.text} />
          </p>
        )}
      </div>
    </div>
  );
}

// ---------- main screen ----------

type StreamSink = (text: string, meta: StreamMeta) => void;

/** Identity for parsed blocks. Speaker name, hue, and portrait change the markup. */
function castParseKey(characters: Character[], guests: EpisodeGuest[]): string {
  const cast = characters.map((c) =>
    `${c.id}\t${c.isPlayer ? 1 : 0}\t${c.name}\t${c.hue}\t${c.portrait ?? ''}\t${(c.portraits ?? []).length}`
  ).join('\n');
  const guest = guests.map((g) => `${g.id}\t${g.name}`).join('\n');
  return `${cast}\n--\n${guest}`;
}

/**
 * The live line. Token updates stay here so the mounted chapter does not
 * re-render on every chunk, and the scroll moves once per frame.
 */
function StreamTail({
  sinkRef, active, scrollRef, onHasText, characters, guests, episodeId, worldId,
  accent, prose, fontPx, avatarPx, dialogueStyle, opening
}: {
  sinkRef: RefObject<StreamSink>;
  active: boolean;
  scrollRef: RefObject<HTMLElement | null>;
  onHasText: (hasText: boolean) => void;
  characters: Character[];
  guests: EpisodeGuest[];
  episodeId: string;
  worldId: string;
  accent: string;
  prose: string;
  fontPx: number;
  avatarPx: number;
  dialogueStyle: DialogueStyle;
  opening: boolean;
}) {
  const [partial, setPartial] = useState('');
  const [meta, setMeta] = useState<StreamMeta>({ role: 'narrator' });
  const pending = useRef<{ text: string; meta: StreamMeta } | null>(null);
  const frame = useRef(0);
  const hasText = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    sinkRef.current = (text, nextMeta) => {
      pending.current = { text, meta: nextMeta };
      if (frame.current) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        const next = pending.current;
        pending.current = null;
        if (!next || !activeRef.current) return;
        setPartial(next.text);
        setMeta(next.meta);
        const filled = next.text.length > 0;
        if (filled !== hasText.current) {
          hasText.current = filled;
          onHasText(filled);
        }
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    };
    return () => {
      sinkRef.current = () => {};
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, [sinkRef, scrollRef, onHasText]);

  useEffect(() => {
    if (active) return;
    if (frame.current) {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    }
    pending.current = null;
    setPartial('');
    if (hasText.current) {
      hasText.current = false;
      onHasText(false);
    }
  }, [active, onHasText]);

  if (!active || !partial) return null;
  const blocks = parseTurn({
    id: 'partial',
    episodeId,
    worldId,
    role: meta.role,
    mode: null,
    characterId: meta.characterId,
    guestId: meta.guestId,
    text: meta.role === 'character' ? previewSpeakText(partial) : partial,
    createdAt: 0
  }, characters, guests);
  return (
    <>
      {blocks.map((b, i, arr) => (
        <ProseBlockView
          key={`p${i}`}
          b={b}
          accent={accent}
          prose={prose}
          fontPx={fontPx}
          avatarPx={avatarPx}
          dialogueStyle={dialogueStyle}
          opening={opening && i === 0}
          fromPlayer={meta.role === 'user'}
          caret={i === arr.length - 1}
        />
      ))}
    </>
  );
}

export function Story() {
  const { band, height, keyboardOffset } = useViewport();
  const phone = phoneChrome(band);
  const compact = band === 'compact';
  const short = shortStoryChrome(band, height);
  const sheetBottom = sheetsFromBottom(band);
  const narrow = phone;
  const { currentWorldId, layout, setLayout, mood, setMood, go, display, goLocations: openLocations, goCast: openCast, closeWorld } = useApp();
  useSettings((s) => s.proseModel);
  const M = MOODS[mood];
  const readMode = layout === 'read';
  const avatarPx = storyAvatarHeight(display.avatarSize, compact);
  const fontPx = readMode ? display.textSize + 1 : display.textSize;

  const world = useLiveQuery(
    async () => {
      if (!currentWorldId) return null;
      return (await db.worlds.get(currentWorldId)) ?? null;
    },
    [currentWorldId]
  );
  const hasAI = hasWritingModel(world);
  const season = useLiveQuery(
    async () => {
      if (!world) return undefined;
      if (!world.activeSeasonId) return null;
      return (await db.seasons.get(world.activeSeasonId)) ?? null;
    },
    [world?.id, world?.activeSeasonId]
  );
  const seasonEpisodes = useLiveQuery(
    async () => {
      if (season === undefined) return undefined;
      if (season === null) return [] as Episode[];
      return db.episodes.where('seasonId').equals(season.id).toArray();
    },
    [season === null ? 'none' : season?.id]
  );
  const episode = seasonEpisodes?.find((e) => e.status === 'active');
  const lastEndedEpisode = seasonEpisodes ? latestEndedEpisode(seasonEpisodes) : undefined;
  const goLocations = () => openLocations(episode?.locationId ?? null);
  const goCast = () => openCast(null);
  const bookKey = seasonEpisodes?.map((e) => `${e.id}:${e.number}:${e.title}:${e.status}`).join('|') ?? '';
  const bookTurnsLive = useLiveQuery(
    async () => {
      if (!seasonEpisodes || seasonEpisodes.length === 0) return [] as Array<{ episode: Episode; turn: Turn }>;
      const ordered = [...seasonEpisodes].sort((a, b) => a.number - b.number);
      const chunks = await Promise.all(ordered.map(async (ep) => {
        const rows = await db.turns.where('episodeId').equals(ep.id).sortBy('createdAt');
        return rows.map((turn) => ({ episode: ep, turn }));
      }));
      return chunks.flat();
    },
    [bookKey]
  );
  const bookEntries = bookTurnsLive ?? [];
  const turns = episode ? bookEntries.filter((e) => e.episode.id === episode.id).map((e) => e.turn) : [];
  const charactersLive = useLiveQuery(
    async () => (world ? db.characters.where('worldId').equals(world.id).toArray() : []),
    [world?.id]
  );
  const characters = charactersLive ?? [];
  const locationsLive = useLiveQuery(
    async () => (world ? db.locations.where('worldId').equals(world.id).toArray() : []),
    [world?.id]
  );
  const locations = locationsLive ?? [];
  const continuity = useLiveQuery(
    async () => (season ? db.continuity.where('seasonId').equals(season.id).toArray() : []),
    [season?.id]
  ) ?? [];
  const threads = useLiveQuery(
    async () => (season ? db.threads.where('seasonId').equals(season.id).filter((t) => t.status === 'open').toArray() : []),
    [season?.id]
  ) ?? [];
  const storyRowsReady = !episode
    || (bookTurnsLive !== undefined && charactersLive !== undefined && locationsLive !== undefined);

  // writing state — whose hands, how much this action matters, how long the page is
  const [length, setLength] = useState<TurnLength>(() => {
    try {
      const saved = localStorage.getItem('sw-reply-size');
      if (saved === 'beat' || saved === 'scene' || saved === 'episode') return saved;
    } catch { /* ignore */ }
    return 'scene';
  });
  const [weight, setWeight] = useState<ActionWeight>('matters');
  const [asCharacterId, setAsCharacterId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [, setTailHasText] = useState(false);
  const streamSink = useRef<StreamSink>(() => {});
  const onTailText = useCallback((hasText: boolean) => setTailHasText(hasText), []);
  const [, setProgressLabel] = useState('writing…');
  const [error, setError] = useState<string | AppError>('');
  const [notice, setNotice] = useState('');
  const [writeAnyway, setWriteAnyway] = useState(false);
  const [recoverBusy, setRecoverBusy] = useState(false);
  const recoverBusyRef = useRef(false);
  const wrapBusyRef = useRef(false);
  /** How many turns from the end are mounted — keeps long episodes responsive. */
  const [turnWindow, setTurnWindow] = useState(60);
  useEffect(() => { setTurnWindow(60); }, [episode?.id]);
  useEffect(() => { setWriteAnyway(false); }, [episode?.id, world?.id]);
  useEffect(() => {
    if (!currentWorldId || world === undefined) return;
    if (world === null) closeWorld();
  }, [currentWorldId, world, closeWorld]);
  const [wrapBusy, setWrapBusy] = useState(false);
  const [worldEditOpen, setWorldEditOpen] = useState(false);
  const [displayOpen, setDisplayOpen] = useState(false);
  const [moreSheet, setMoreSheet] = useState(false);
  const [confirmAsk, setConfirmAsk] = useState<null | {
    kind: 'retryFrom';
    turn: Turn;
  }>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [hudTucked, setHudTucked] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLElement>(null);

  useEffect(() => {
    try { localStorage.setItem('sw-reply-size', length); } catch { /* ignore */ }
  }, [length]);

  const activeLocation = locations.find((l) => l.id === episode?.locationId)
    ?? locations.find((l) => episode?.location && l.name && episode.location.toLowerCase().includes(l.name.toLowerCase()));

  useEffect(() => {
    if (!readMode) {
      setComposerOpen(true);
      setHudTucked(false);
    } else {
      setComposerOpen(false);
    }
  }, [readMode]);

  useEffect(() => {
    if (!readMode) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const el = scrollRef.current;
    const tuck = () => { if (!composerOpen) setHudTucked(true); };
    const onScroll = () => tuck();
    el?.addEventListener('scroll', onScroll, { passive: true });
    const idle = window.setTimeout(tuck, 2400);
    return () => {
      el?.removeEventListener('scroll', onScroll);
      window.clearTimeout(idle);
    };
  }, [readMode, composerOpen, episode?.id]);

  // Location hue → mood when the episode hasn't pinned a mood.
  useEffect(() => {
    if (!episode || !activeLocation || episode.moodPinned) return;
    setMood(moodFromHue(activeLocation.hue));
  }, [episode?.id, episode?.locationId, episode?.moodPinned, activeLocation?.id, activeLocation?.hue, setMood]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [turns.length]);

  /** Shared streaming runner behind write / rewrite / retry. */
  const runNarration = async (
    mode: ComposeMode,
    text: string,
    resumeBeats?: DirectorBeat[],
    lengthOverride?: TurnLength,
    actionWeight?: ActionWeight,
    handsId?: string | null
  ): Promise<{ status: 'ok' | 'error' | 'aborted'; beatsCompleted: number; remaining: number }> => {
    if (!world || !season || !episode) return { status: 'error', beatsCompleted: 0, remaining: 0 };
    setError('');
    setNotice('');
    setStreaming(true);
    setTailHasText(false);
    setProgressLabel('Writing…');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await writeTurn({
        world, season, episode, mode, input: text, length: lengthOverride ?? length,
        resumeBeats,
        weight: actionWeight ?? weight,
        asCharacterId: handsId === undefined ? (asCharacterId ?? undefined) : (handsId ?? undefined),
        signal: controller.signal,
        onProgress: () => setProgressLabel('Writing…'),
        onNotice: setNotice,
        onDelta: (p, meta) => {
          streamSink.current(p, meta);
        }
      });
      setTailHasText(false);
      return { status: 'ok', beatsCompleted: 1, remaining: 0 };
    } catch (e) {
      setTailHasText(false);
      if (e instanceof WriteAbortedError || (e as Error).name === 'AbortError') {
        const n = e instanceof WriteAbortedError ? e.beatsCompleted : 0;
        const left = e instanceof WriteAbortedError ? e.remainingBeats.length : 0;
        if (left > 0) void discardPendingPlan(episode.id);
        setNotice(abortWriteNotice(n, left));
        return { status: 'aborted', beatsCompleted: n, remaining: left };
      }
      const n = typeof e === 'object' && e && 'beatsCompleted' in e
        ? Math.max(0, Number((e as { beatsCompleted: number }).beatsCompleted) || 0)
        : 0;
      const left = typeof e === 'object' && e && 'remainingBeats' in e
        ? Math.max(0, ((e as { remainingBeats?: unknown[] }).remainingBeats ?? []).length)
        : 0;
      if (left > 0) {
        void discardPendingPlan(episode.id);
        setNotice(unfinishedWriteNotice(n, left));
      } else {
        setError(classifyError(e));
        if (n > 0) {
          setNotice(
            `${n} line${n === 1 ? '' : 's'} saved — retry from the last reply.`
          );
        }
      }
      return { status: 'error', beatsCompleted: n, remaining: left };
    } finally {
      setStreaming(false);
      setProgressLabel('');
      abortRef.current = null;
    }
  };

  const writeReady = useMemo(() => {
    if (!storyRowsReady || turns.length > 0 || !world || !season || !episode) return null;
    return evaluateWorldWriteReady({
      world, season, episode, characters, locations, continuityCount: continuity.length
    });
  }, [storyRowsReady, turns.length, world, season, episode, characters, locations, continuity.length]);
  const writeBlocked = !hasAI || !!(writeReady && writeReady.missing.length > 0 && !writeAnyway);

  const write = async () => {
    if (!world || !season || !episode || streaming) return;
    if (!hasAI) {
      setNotice(NOTICE_ADD_MODEL);
      return;
    }
    if (writeReady && writeReady.missing.length > 0 && !writeAnyway) {
      setNotice('Add the missing items above, or press Write anyway.');
      return;
    }
    if (!input.trim()) return;
    const sceneNpcs = characters.filter((c) => episode.castIds.includes(c.id) && !c.isPlayer);
    const mode: ComposeMode = asCharacterId || sceneNpcs.length === 0 ? 'act' : 'play';
    const text = input;
    setInput('');
    const result = await runNarration(mode, text, undefined, undefined, weight, asCharacterId);
    if (result.status !== 'ok' && result.beatsCompleted === 0 && result.remaining === 0) {
      setInput(text);
    }
  };

  /**
   * Retry from a turn. For narrator/character turns: that response and everything
   * after are rewritten. For a player turn: the turn is kept and everything after
   * is rewritten from it. Deletion commits only after a successful regenerate;
   * on failure the prior turns are restored.
   */
  const retryFrom = async (turn: Turn) => {
    if (!episode || streaming) return;
    const idx = turns.findIndex((t) => t.id === turn.id);
    if (idx < 0) return;
    const replaceSelf = turn.role === 'narrator' || turn.role === 'character';
    const snapshot = replaceSelf
      ? await snapshotTurnsFrom(turn.id, episode.id)
      : await snapshotTurnsAfter(turn.id, episode.id);
    const retryStartedAt = Date.now();
    if (replaceSelf) await deleteTurnsFrom(turn.id, episode.id);
    else await deleteTurnsAfter(turn.id, episode.id);
    const result = await runNarration('continue', '');
    if (result.status === 'ok') {
      if (snapshot.length > 0) {
        await recordTombstones(snapshot.map((t) => ({
          table: 'turns' as const,
          id: t.id,
          worldId: t.worldId,
          episodeId: t.episodeId,
          payload: t
        })));
      }
    } else {
      await rollbackTurnSnapshot(episode.id, snapshot, retryStartedAt);
      if (result.status === 'error') {
        setError((prev) => prev || 'Retry failed — previous turns were restored.');
      } else {
        setNotice('Retry cancelled — previous turns were restored.');
      }
    }
  };

  const runConfirmAsk = () => {
    if (!confirmAsk) return;
    const ask = confirmAsk;
    setConfirmAsk(null);
    void retryFrom(ask.turn);
  };

  /** End with a minimal recap so the next chapter still has memory. An empty chapter just opens the next one. */
  const skipWrapAndEnd = async () => {
    if (!world || !season || !episode) return;
    if (wrapBusyRef.current) return;
    wrapBusyRef.current = true;
    setWrapBusy(true);
    setError('');
    try {
      if (turns.length > 0) {
        await commitSoftEpisodeWrap(world, season, episode);
      }
      await nextEpisode(episode);
      setNotice('Chapter ended. The next chapter is open.');
    } catch (e) {
      setError(classifyError(e));
    } finally {
      wrapBusyRef.current = false;
      setWrapBusy(false);
    }
  };

  const blockCache = useRef<{ key: string; map: Map<string, { text: string; blocks: ProseBlock[] }> }>({
    key: '',
    map: new Map()
  });
  const manuscript = useMemo(() => {
    const key = castParseKey(characters, []);
    if (blockCache.current.key !== key) {
      blockCache.current = { key, map: new Map() };
    }
    const cache = blockCache.current.map;
    const seen = new Set<string>();
    const out: { episode: Episode; turn: Turn; blocks: ProseBlock[] }[] = [];
    for (const entry of bookEntries) {
      const t = entry.turn;
      const guestList = entry.episode.guests ?? [];
      seen.add(t.id);
      const hit = cache.get(t.id);
      const textKey = `${t.text}\t${t.asCharacterId ?? ''}`;
      if (hit && hit.text === textKey) {
        out.push({ episode: entry.episode, turn: t, blocks: hit.blocks });
        continue;
      }
      const parsed = parseTurn(t, characters, guestList);
      cache.set(t.id, { text: textKey, blocks: parsed });
      out.push({ episode: entry.episode, turn: t, blocks: parsed });
    }
    for (const id of cache.keys()) if (!seen.has(id)) cache.delete(id);
    return out;
  }, [bookEntries, characters]);

  const recoverPad: CSSProperties = {
    padding: narrow ? '40px 20px' : '80px 60px',
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    maxWidth: 560
  };

  const openNextFromEnded = async () => {
    if (!lastEndedEpisode) return;
    if (recoverBusyRef.current) return;
    recoverBusyRef.current = true;
    setRecoverBusy(true);
    setError('');
    try {
      await nextEpisode(lastEndedEpisode, {
        plotTargets: buildEpisodePlotTargets({
          aimedTexts: [],
          carried: lastEndedEpisode.plotTargets
        })
      });
    } catch (e) {
      setError(classifyError(e));
    } finally {
      recoverBusyRef.current = false;
      setRecoverBusy(false);
    }
  };

  if (currentWorldId && world === undefined) {
    return <div key="story-opening" style={{ padding: 60 }}><Spinner label="opening the world" /></div>;
  }
  if (!world) {
    return (
      <div key="story-empty" className="fade-in" style={{ padding: narrow ? '40px 20px' : '80px 60px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 560 }}>
        <Mono>no world open</Mono>
        <div className="serif" style={{ fontWeight: 300, fontSize: 30, color: 'var(--ink-heading)' }}>Open a world to start writing.</div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn-primary" onClick={() => go('library')}>Go to Worlds</button>
        </div>
      </div>
    );
  }
  if (season === undefined || (season !== null && seasonEpisodes === undefined)) {
    return <div key="story-season" style={{ padding: 60 }}><Spinner label="opening the world" /></div>;
  }
  if (season === null) {
    return (
      <div className="fade-in" style={recoverPad}>
        <Mono>no chapter</Mono>
        <div className="serif" style={{ fontWeight: 300, fontSize: 30, color: 'var(--ink-heading)' }}>This world has no chapter open.</div>
        {error && <ErrorNote error={error} onDismiss={() => setError('')} />}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn-primary" onClick={() => go('library')}>Worlds</button>
        </div>
      </div>
    );
  }
  if (!episode) {
    return (
      <div className="fade-in" style={recoverPad}>
        <Mono>chapter ended</Mono>
        <div className="serif" style={{ fontWeight: 300, fontSize: 30, color: 'var(--ink-heading)' }}>
          {lastEndedEpisode
            ? `Chapter ${lastEndedEpisode.number} is filed. Open the next chapter.`
            : 'No chapters yet.'}
        </div>
        {error && <ErrorNote error={error} onDismiss={() => setError('')} />}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {lastEndedEpisode && (
            <button className="btn-primary" disabled={recoverBusy} onClick={() => void openNextFromEnded()}>
              {recoverBusy ? 'Opening…' : 'Open the next chapter'}
            </button>
          )}
          <button className="btn-quiet" onClick={() => go('library')}>Worlds</button>
        </div>
      </div>
    );
  }
  if (!storyRowsReady) {
    return <div key="story-rows" style={{ padding: 60 }}><Spinner label="opening the world" /></div>;
  }

  const inScene = characters.filter((c) => episode.castIds.includes(c.id));
  const guests = episode.guests ?? [];

  const shellHeight = '100%';
  const locLabel = (activeLocation?.name || episode.location || '')
    .split(',')[0].split('.')[0].toLowerCase();
  // Chapter head: where and when this episode opens, in reading order rather than chrome.
  const openingNote = (episode.number === 1
    ? season.bible?.recap
    : seasonEpisodes?.find((e) => e.number === episode.number - 1)?.wrap?.recap
  )?.trim() || '';
  const sceneDate = formatStoryDate(
    worldCalendar(world),
    episode.storyDay && episode.storyDay > 0 ? episode.storyDay : worldCalendar(world).currentDay
  );
  const stageCast = inScene;
  const stageGuests = episode.activeGuestIds == null
    ? guests
    : guests.filter((g) => episode.activeGuestIds!.includes(g.id));

  return (
    <div
      key="story-shell"
      className={readMode ? 'read-mode' : undefined}
      style={{
      position: 'relative',
      flex: 1,
      minHeight: 0,
      height: shellHeight,
      display: 'flex',
      flexDirection: 'column',
      color: M.text,
      paddingTop: 0,
      paddingRight: 0,
      paddingBottom: keyboardOffset > 0 ? keyboardOffset : 0,
      paddingLeft: 0
    }}>
      {/* The frame is paper. Mood is a stain on the page, not a room. */}

      {/* header — thin strip in Read mode */}
      {readMode ? (
        <div
          className={`scene-hud glass-clear${hudTucked && !composerOpen ? ' tucked' : ''}`}
          onMouseEnter={() => setHudTucked(false)}
          style={{
          position: 'relative', zIndex: 5, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 12,
          paddingTop: narrow ? 'calc(10px + env(safe-area-inset-top))' : 11,
          paddingBottom: narrow ? 10 : 11,
          paddingLeft: narrow ? 14 : 22,
          paddingRight: narrow ? 14 : 22
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
            <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div className="serif" style={{ fontSize: 13, fontStyle: 'italic', color: 'var(--ink-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {world.title}{locLabel ? ` · ${locLabel}` : ''}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <button className="btn-quiet" style={{ padding: '7px 12px', fontSize: 12 }}
              onClick={() => { setComposerOpen((o) => !o); setHudTucked(false); }}>
              {composerOpen ? 'Hide' : 'Write'}
            </button>
            {short ? (
              <button className="btn-quiet" style={{ padding: '7px 12px', fontSize: 12 }}
                onClick={() => setMoreSheet(true)}>More</button>
            ) : (
              <>
                <button className="btn-quiet" style={{ padding: '7px 12px', fontSize: 12 }}
                  disabled={wrapBusy} onClick={() => void skipWrapAndEnd()}>End chapter</button>
                <button className="btn-quiet" style={{ padding: '7px 12px', fontSize: 12 }}
                  onClick={() => setLayout('write')}>Exit read</button>
              </>
            )}
          </div>
        </div>
      ) : (
        <div style={{
          position: 'relative', zIndex: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 14,
          paddingTop: narrow ? 'calc(11px + env(safe-area-inset-top))' : 13,
          paddingBottom: narrow ? 11 : 13,
          paddingLeft: narrow ? 14 : 24,
          paddingRight: narrow ? 14 : 24,
          borderBottom: '1px solid var(--rule)',
          flexWrap: 'wrap'
        }}
        className="glass-clear">
          <div style={{ display: 'flex', alignItems: 'center', gap: 13, minWidth: 0 }}>
            <div style={{
              width: 3, height: 28, borderRadius: 1, flexShrink: 0,
              background: ACCENT, opacity: 0.9
            }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              <div className="serif" style={{ fontSize: 16, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{world.title}</div>
              <div className="label" style={{ fontSize: 11 }}>
                Chapter {episode.number}{locLabel ? ` · ${locLabel}` : ''} · {formatStoryDate(worldCalendar(world), worldCalendar(world).currentDay)}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', borderBottom: '1px solid var(--rule)' }}>
              {([['write', 'Write'], ['read', 'Read']] as const).map(([id, label]) => (
                <button key={id} onClick={() => setLayout(id as StoryLayout)} style={{
                  border: 0, background: 'transparent',
                  color: 'inherit', opacity: layout === id ? 1 : 0.5, padding: '7px 12px',
                  fontSize: 12, fontWeight: layout === id ? 600 : 500, cursor: 'pointer', minHeight: 36,
                  boxShadow: layout === id ? 'inset 0 -2px 0 var(--accent)' : 'none'
                }}>{label}</button>
              ))}
            </div>
            {!short && (
              <button className="btn-ghost" style={{ padding: '7px 12px', fontSize: 11, minHeight: 36 }} disabled={wrapBusy} onClick={() => void skipWrapAndEnd()}>End chapter</button>
            )}
            {short ? (
              <button className="btn-ghost" style={{ padding: '7px 12px', fontSize: 11, minHeight: 36 }} onClick={() => setMoreSheet(true)}>More</button>
            ) : (
              <>
                <button className="btn-ghost" style={{ padding: '8px 14px' }} onClick={() => setDisplayOpen(true)}>Display</button>
                <button className="btn-ghost" style={{ padding: '8px 14px' }} onClick={() => setWorldEditOpen(true)}>Edit world</button>
              </>
            )}
          </div>
        </div>
      )}

      {/* body — the manuscript column */}
      <div style={{
        position: 'relative', zIndex: 2, flex: 1, display: 'grid', minHeight: 0,
        gridTemplateColumns: 'minmax(0, 1fr)'
      }}>
        <section ref={scrollRef} style={{ overflow: 'auto', display: 'flex', flexDirection: 'column', position: 'relative' }}>

          <div
            className="page-plane"
            style={{
              maxWidth: '40rem',
              margin: readMode ? '12px auto 28px' : '12px auto 18px',
              width: 'calc(100% - 32px)',
              background: 'var(--page)',
              border: '1px solid var(--rule)',
              padding: narrow
                ? (readMode ? '28px 22px 48px' : '22px 18px 40px')
                : (readMode ? '44px 48px 80px' : '36px 44px 68px')
            }}
          >
            <header style={{ marginBottom: turns.length === 0 ? 28 : 22 }}>
              <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
                {activeLocation && (
                  <div style={{
                    ...locationThumb(activeLocation, turns.length === 0 ? 52 : 32),
                    marginTop: turns.length === 0 ? 18 : 2
                  }} />
                )}
                <div style={{ minWidth: 0, flex: 1 }}>
              {turns.length === 0 ? (
                <>
                  <div className="serif" style={{
                    fontSize: 11,
                    letterSpacing: '0.18em',
                    textTransform: 'uppercase',
                    color: 'var(--ink-muted)',
                    fontWeight: 500
                  }}>
                    Chapter {numberWord(episode.number)}
                  </div>
                  <div className="serif" style={{
                    fontSize: narrow ? 26 : 32,
                    fontWeight: 400,
                    lineHeight: 1.2,
                    margin: '12px 0 0',
                    color: 'var(--ink-heading)'
                  }}>
                    {episode.title.trim() || activeLocation?.name || episode.location || 'Untitled chapter'}
                  </div>
                  {sceneDate && (
                    <div className="serif" style={{
                      marginTop: 10, fontSize: 15, lineHeight: 1.55, fontStyle: 'italic',
                      color: 'var(--ink-muted)'
                    }}>
                      {sceneDate}
                    </div>
                  )}
                </>
              ) : (
                <div className="serif" style={{
                  fontSize: 13, letterSpacing: '0.14em', textTransform: 'uppercase', lineHeight: 1.45,
                  color: 'var(--ink-muted)'
                }}>
                  {episode.title.trim() || activeLocation?.name || episode.location}
                  {sceneDate ? ` · ${sceneDate}` : ''}
                </div>
              )}
                </div>
              </div>
              {(stageCast.length > 0 || stageGuests.length > 0) && (
                <SceneCastStrip
                  cast={stageCast}
                  guests={stageGuests}
                  empty={turns.length === 0}
                  onOpen={goCast}
                />
              )}
              {turns.length === 0 && (
                <div style={{
                  width: 72, height: 1, marginTop: 22,
                  background: 'var(--rule)'
                }} />
              )}
            </header>

            {openingNote && turns.length === 0 && (
              <div style={{ marginBottom: 32 }}>
                <div className="serif" style={{
                  fontSize: 11, letterSpacing: '0.16em', textTransform: 'uppercase',
                  color: 'var(--ink-muted)', marginBottom: 10
                }}>
                  Previously
                </div>
                <p className="serif" style={{
                  fontSize: fontPx, lineHeight: 1.82, margin: 0, fontStyle: 'italic',
                  color: 'var(--paper)', textWrap: 'pretty'
                }}>
                  {openingNote}
                </p>
              </div>
            )}

            {turns.length === 0 && !streaming && (
              <div style={{ fontSize: 14, lineHeight: 1.7, display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 8 }}>
                {episode.number === 1 && season.premise ? (
                  <p className="serif" style={{
                    fontSize: fontPx, lineHeight: 1.82, margin: 0, fontStyle: 'italic',
                    color: 'var(--ink-muted)', textWrap: 'pretty'
                  }}>
                    {season.premise}
                  </p>
                ) : !openingNote ? (
                  <p className="serif" style={{
                    fontSize: fontPx, lineHeight: 1.82, margin: 0, fontWeight: 300,
                    color: 'var(--ink-muted)'
                  }}>
                    Nothing here yet. Write the first turn.
                  </p>
                ) : null}
                {!(activeLocation?.name || episode.location) && (
                  <div className="label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    No place linked yet
                  </div>
                )}
                {writeReady && writeReady.missing.length > 0 && !writeAnyway && (
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5, lineHeight: 1.55, color: 'var(--paper)' }}>
                    <span>Still missing: {writeReady.missing.join(' ')}</span>
                    <button className="btn-quiet" style={{ fontSize: 11 }}
                      onClick={() => setWriteAnyway(true)}>Write anyway</button>
                  </div>
                )}
                {writeReady && writeReady.warnings.length > 0 && (writeAnyway || writeReady.missing.length === 0) && (
                  <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--ink-muted)' }}>
                    {writeReady.warnings[0]}
                  </div>
                )}
                {(!hasAI || (writeReady && writeReady.missing.length > 0 && !writeAnyway)) && (
                <p style={{ fontSize: 14, margin: 0, color: 'var(--paper)' }}>
                  {!hasAI
                    ? 'Add a writing model in Settings to write.'
                    : 'Add the missing items above, or press Write anyway.'}
                </p>
                )}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  {hasAI && (
                    <button
                      className="btn-ghost"
                      style={{ fontSize: 12, padding: '8px 14px' }}
                      disabled={!!streaming}
                      onClick={() => {
                        void (async () => {
                          setError('');
                          setProgressLabel('Writing opening…');
                          setStreaming(true);
                          try {
                            await draftColdOpenNarration(world, season, episode);
                          } catch (e) {
                            setError(classifyError(e));
                          } finally {
                            setStreaming(false);
                            setProgressLabel('writing…');
                          }
                        })();
                      }}
                    >
                      Draft opening
                    </button>
                  )}
                  {!hasAI && (
                    <button className="btn-ghost" style={{ fontSize: 12, padding: '7px 12px' }}
                      onClick={() => go('settings')}>
                      Add a writing model in Settings
                    </button>
                  )}
                  {(continuity.length > 0 || threads.length > 0) && (
                    <span className="label" style={{ opacity: 0.5 }}>
                      {continuity.length} fact{continuity.length === 1 ? '' : 's'} · {threads.length} thread{threads.length === 1 ? '' : 's'}
                    </span>
                  )}
                </div>
              </div>
            )}

            {manuscript.length > turnWindow && (
              <div style={{ margin: '0 0 28px', textAlign: 'center' }}>
                <button
                  type="button"
                  onClick={() => setTurnWindow((n) => n + 60)}
                  className="serif"
                  title={`${manuscript.length - turnWindow} earlier turns`}
                  style={{
                    border: 0, background: 'transparent', cursor: 'pointer',
                    fontSize: 14, fontStyle: 'italic', color: 'var(--ink-muted)',
                    padding: '6px 8px'
                  }}
                >
                  Show earlier turns
                </button>
              </div>
            )}

            {(() => {
              const visible = manuscript.slice(-turnWindow);
              const latestPassageId = [...turns].reverse().find((t) => t.role === 'user')?.id ?? null;
              let prevEpisodeId = '';
              return visible.map(({ episode: chapter, turn, blocks: bs }, ti) => {
                const showBreak = chapter.id !== prevEpisodeId
                  && !(prevEpisodeId === '' && chapter.id === episode.id);
                prevEpisodeId = chapter.id;
                const chapterTitle = chapter.title.trim() || chapter.location || `Chapter ${chapter.number}`;
                return (
                  <div key={turn.id}>
                    {showBreak && (
                      <div style={{ margin: '2.6em 0 1.4em', textAlign: 'center' }}>
                        <div className="serif" style={{
                          fontSize: 11, letterSpacing: '0.2em', textTransform: 'uppercase',
                          color: 'var(--ink-muted)'
                        }}>
                          Chapter {chapter.number}
                        </div>
                        <div style={{ width: 48, height: 1, margin: '10px auto 0', background: 'var(--rule)' }} />
                        <div className="serif" style={{
                          fontSize: narrow ? 22 : 26, fontWeight: 400, marginTop: 10, color: 'var(--ink-heading)'
                        }}>
                          {chapterTitle}
                        </div>
                      </div>
                    )}
                    <TurnRow
                      turn={turn}
                      blocks={bs}
                      accent={M.accent}
                      prose={M.prose}
                      fontPx={fontPx}
                      avatarPx={avatarPx}
                      dialogueStyle="prose"
                      prevSpeaker={ti > 0 ? lastSpokenBy(visible[ti - 1].blocks) : null}
                      streaming={streaming}
                      opening={manuscript.length <= turnWindow && ti === 0}
                      onRewrite={turn.id === latestPassageId ? () => {
                        const idx = turns.findIndex((t) => t.id === turn.id);
                        const below = idx < 0 ? 0 : turns.length - idx - 1;
                        if (below > 0) setConfirmAsk({ kind: 'retryFrom', turn });
                        else void retryFrom(turn);
                      } : undefined}
                    />
                  </div>
                );
              });
            })()}

            <StreamTail
              sinkRef={streamSink}
              active={streaming}
              scrollRef={scrollRef}
              onHasText={onTailText}
              characters={characters}
              guests={guests}
              episodeId={episode.id}
              worldId={world.id}
              accent={M.accent}
              prose={M.prose}
              fontPx={fontPx}
              avatarPx={avatarPx}
              dialogueStyle="prose"
              opening={turns.length === 0}
            />

  
          </div>
        </section>
      </div>

      {(confirmAsk || error || notice) && (
        <div style={{
          position: 'relative', zIndex: 3,
          padding: narrow ? '10px 12px 0' : '12px 24px 0',
          display: 'flex', flexDirection: 'column', gap: 10
        }}>
          {confirmAsk && (
            <ConfirmBar
              title={confirmAsk.turn.role === 'narrator' || confirmAsk.turn.role === 'character'
                ? 'Rewrite this response?'
                : 'Retry from here?'}
              body="Turns after this one will be replaced. This cannot be undone."
              confirmLabel="Rewrite"
              onConfirm={runConfirmAsk}
              onCancel={() => setConfirmAsk(null)}
            />
          )}
          {error && <ErrorNote error={error} onDismiss={() => setError('')} />}
          {notice && (
            <div className="glass-nudge" style={{
              border: `1px solid ${ACCENT_RGBA.a35}`,
              background: ACCENT_RGBA.a08, display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap'
            }}>
              <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--paper)', flex: 1, minWidth: 0 }}>{notice}</div>
              {noticeNavAction(notice) && (
                <button className="btn-quiet" style={{ fontSize: 11, minHeight: 28 }}
                  onClick={() => {
                    const nav = noticeNavAction(notice);
                    setNotice('');
                    if (nav) go(nav.screen);
                  }}>
                  {noticeNavAction(notice)?.label}
                </button>
              )}
              <button className="btn-quiet" style={{ padding: '0 2px', fontSize: 14 }} onClick={() => setNotice('')}>×</button>
            </div>
          )}
        </div>
      )}

      {/* composer — collapses to a handle in Read mode */}
      {readMode && !composerOpen ? (
        <div
          className="compose-air"
          style={{
            position: 'relative', zIndex: 2, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
            padding: '8px 16px 12px'
          }}
        >
          <button
            onClick={() => { setComposerOpen(true); setHudTucked(false); }}
            className="serif"
            style={{
              border: 0, background: 'transparent',
              color: 'inherit', padding: '10px 18px', cursor: 'pointer',
              fontSize: 16, fontStyle: 'italic', opacity: 0.7
            }}
          >
            Write
          </button>
        </div>
      ) : (
        <div className="compose-air" style={{
          position: 'relative', zIndex: 2,
          padding: narrow
            ? (readMode ? '10px 16px 12px' : '11px 12px 12px')
            : '12px 24px 16px',
          display: 'flex', flexDirection: 'column', gap: 10
        }}>
          {!hasAI && turns.length > 0 && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <p style={{ fontSize: 14, margin: 0, color: 'var(--paper)', flex: 1, minWidth: 180 }}>
                Add a writing model in Settings to write.
              </p>
              <button className="btn-ghost" style={{ fontSize: 12, padding: '7px 12px' }}
                onClick={() => go('settings')}>
                Add a writing model in Settings
              </button>
            </div>
          )}
          <div style={{ maxWidth: '40rem', margin: '0 auto', width: '100%' }}>
            <button className="btn-quiet" style={{ fontSize: 12, minHeight: 32, padding: '4px 6px' }}
              onClick={() => setOptionsOpen((o) => !o)}>
              {optionsOpen ? 'Hide options' : 'Options'}
            </button>
          </div>
          {optionsOpen && (
          <div style={{ maxWidth: '40rem', margin: '0 auto', width: '100%', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="label" style={{ fontSize: 11 }}>
              Write as
            </span>
            <Chip active={asCharacterId === null} onClick={() => setAsCharacterId(null)}>You</Chip>
            {inScene.filter((c) => !c.isPlayer).map((c) => (
              <Chip
                key={c.id}
                active={asCharacterId === c.id}
                onClick={() => setAsCharacterId(asCharacterId === c.id ? null : c.id)}
              >
                {c.name}
              </Chip>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="label" style={{ fontSize: 11 }}>
              This turn
            </span>
            <Chip active={weight === 'matters'} onClick={() => setWeight('matters')}>Changes things</Chip>
            <Chip active={weight === 'moment'} onClick={() => setWeight('moment')}>Just this moment</Chip>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="label" style={{ fontSize: 11 }}>
              Reply length
            </span>
            <Chip active={length === 'beat'} onClick={() => setLength('beat')}>Short</Chip>
            <Chip active={length === 'scene'} onClick={() => setLength('scene')}>Normal</Chip>
            <Chip active={length === 'episode'} onClick={() => setLength('episode')}>Long</Chip>
          </div>
          </div>
          )}
          <div style={{
            display: 'flex', gap: 13, alignItems: 'flex-end',
            maxWidth: '40rem', margin: '0 auto', width: '100%',
            padding: '4px 0'
          }}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void write(); }
              }}
              placeholder={asCharacterId
                ? 'What do they do?'
                : 'What do you do, or what do you say?'}
              rows={2}
              disabled={streaming}
              style={{
                flex: 1, border: 0, background: 'transparent', padding: '4px 0',
                fontSize: narrow ? 16 : 18, lineHeight: 1.7,
                minHeight: 44
              }}
            />
            {streaming ? (
              <button className="btn-quiet" style={{ alignSelf: 'flex-end', minHeight: 44 }} onClick={() => abortRef.current?.abort()}>Stop</button>
            ) : (
              <button
                className="btn-primary"
                style={{ alignSelf: 'flex-end', padding: '10px 19px', minHeight: 44 }}
                disabled={writeBlocked || !input.trim()}
                onClick={() => void write()}
              >
                Send
              </button>
            )}
          </div>
        </div>
      )}

      {/* narrow overflow: the rest of the binding */}
      <Sheet open={moreSheet} onClose={() => setMoreSheet(false)} narrow={sheetBottom}
        footer={
          <button className="btn-primary" style={{ width: '100%', minHeight: 44 }} onClick={() => setMoreSheet(false)}>Done</button>
        }
      >
        <div className="serif" style={{ fontWeight: 300, fontSize: 24, color: 'var(--ink-heading)' }}>More</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {(readMode || short) && (
            <>
              <button className="btn-ghost" style={{ minHeight: 44, textAlign: 'left' }} disabled={wrapBusy} onClick={() => { setMoreSheet(false); void skipWrapAndEnd(); }}>
                End chapter
              </button>
              {readMode && (
                <button className="btn-ghost" style={{ minHeight: 44, textAlign: 'left' }} onClick={() => { setMoreSheet(false); setLayout('write'); }}>
                  Exit read
                </button>
              )}
            </>
          )}
          <button className="btn-ghost" style={{ minHeight: 44, textAlign: 'left' }} onClick={() => { setMoreSheet(false); setDisplayOpen(true); }}>
            Display
          </button>
          <button className="btn-ghost" style={{ minHeight: 44, textAlign: 'left' }} onClick={() => { setMoreSheet(false); setWorldEditOpen(true); }}>
            Edit world
          </button>
          <button className="btn-ghost" style={{ minHeight: 44, textAlign: 'left' }} onClick={() => { setMoreSheet(false); go('cast'); }}>
            Characters
          </button>
          <button className="btn-ghost" style={{ minHeight: 44, textAlign: 'left' }} onClick={() => { setMoreSheet(false); goLocations(); }}>
            Places
          </button>
          <button className="btn-ghost" style={{ minHeight: 44, textAlign: 'left' }} onClick={() => { setMoreSheet(false); go('profile'); }}>
            Profile
          </button>
        </div>
      </Sheet>

      {/* live world editor */}
      <WorldEditorSheet
        open={worldEditOpen}
        onClose={() => setWorldEditOpen(false)}
        narrow={sheetBottom}
        world={world}
        season={season}
        episode={episode}
        characters={characters}
        locations={locations}
      />

      {/* display settings */}
      <DisplaySheet
        open={displayOpen} onClose={() => setDisplayOpen(false)} narrow={sheetBottom}
      />
    </div>
  );
}

// ---------- display settings ----------

function SliderRow({ label, value, min, max, unit, onChange }: {
  label: string; value: number; min: number; max: number; unit?: string; onChange: (v: number) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Mono style={{ fontSize: 9 }}>{label}</Mono>
        <span style={{ fontSize: 10.5, color: 'var(--accent-strong)' }}>
          {value}{unit ?? ''}
        </span>
      </div>
      <input
        type="range" min={min} max={max} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ padding: 0, height: 4 }}
      />
    </div>
  );
}

function DisplaySheet({ open, onClose, narrow }: {
  open: boolean; onClose: () => void; narrow: boolean;
}) {
  const { display, setDisplay } = useApp();
  return (
    <Sheet open={open} onClose={onClose} narrow={narrow}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div className="serif" style={{ fontWeight: 500, fontSize: 20, color: 'var(--ink-heading)' }}>Display</div>
        <button className="btn-ghost" style={{ width: 30, height: 30, padding: 0, flexShrink: 0 }} onClick={onClose}>x</button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Mono style={{ fontSize: 9 }}>text</Mono>
          <SliderRow label="Text size" value={display.textSize} min={15} max={24} unit="px"
            onChange={(v) => setDisplay({ textSize: v })} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, borderTop: '1px solid var(--rule)', paddingTop: 16 }}>
          <Mono style={{ fontSize: 9 }}>dialogue</Mono>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Chip
              active={display.dialogueStyle === 'prose'}
              onClick={() => setDisplay({ dialogueStyle: 'prose' })}
            >
              Prose
            </Chip>
            <Chip
              active={display.dialogueStyle === 'staged'}
              onClick={() => setDisplay({ dialogueStyle: 'staged' })}
            >
              Staged
            </Chip>
          </div>
          <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--ink-muted)' }}>
            {display.dialogueStyle === 'prose'
              ? 'Speech runs in the text with the speaker named once.'
              : 'Every line gets a name and portrait.'}
          </div>
        </div>

        <button className="btn-quiet" style={{ alignSelf: 'flex-start', fontSize: 11 }}
          onClick={() => setDisplay(DEFAULT_DISPLAY)}>Reset display to defaults</button>
      </div>
    </Sheet>
  );
}

// ---------- turn row ----------

function TurnRow({ turn, blocks, accent, prose, fontPx, avatarPx, dialogueStyle, prevSpeaker, streaming, opening, onRewrite }: {
  turn: Turn;
  blocks: ProseBlock[];
  accent: string;
  prose: string;
  fontPx: number;
  avatarPx: number;
  dialogueStyle: DialogueStyle;
  prevSpeaker: string | null;
  streaming: boolean;
  opening?: boolean;
  onRewrite?: () => void;
}) {
  const continued = attributionRun(blocks, prevSpeaker);
  return (
    <div className="turn-row" style={{ position: 'relative' }}>
      {blocks.map((b, i) => (
        <ProseBlockView
          key={i}
          b={b}
          accent={accent}
          prose={prose}
          fontPx={fontPx}
          avatarPx={avatarPx}
          dialogueStyle={dialogueStyle}
          continues={continued[i]}
          opening={opening && i === 0}
          fromPlayer={turn.role === 'user'}
        />
      ))}
      {onRewrite && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4, marginBottom: 10 }}>
          <button className="btn-quiet" style={{ fontSize: 12, padding: '6px 10px', minHeight: 36 }} disabled={streaming}
            onClick={onRewrite}>Rewrite this passage</button>
        </div>
      )}
    </div>
  );
}

function locationThumb(l: Location, size = 30): CSSProperties {
  if (l.portrait) {
    return {
      width: size, height: size, borderRadius: '50%', flexShrink: 0,
      backgroundImage: `url(${JSON.stringify(l.portrait)})`, backgroundSize: 'cover', backgroundPosition: 'center',
      border: '1px solid rgba(0,0,0,0.28)',
      boxShadow: 'none'
    };
  }
  return { ...avatarStyle(l.hue, size), borderRadius: '50%' };
}

function numberWord(n: number): string {
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  return words[n] ?? String(n);
}
