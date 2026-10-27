import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import {
  analyzeEpisode, commitEpisodeWrap, commitSoftEpisodeWrap, deleteTurnsAfter, deleteTurnsFrom, draftColdOpenNarration,
  rollbackTurnSnapshot,
  snapshotTurnsAfter, snapshotTurnsFrom, writeTurn,
  discardPendingPlan,
  WriteAbortedError, type EpisodeWrapDraft, type StreamMeta
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
  Character, ComposeMode, Episode, EpisodeGuest, EpisodeWrapBeat,
  Location, Turn, TurnLength, World, ActionWeight
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

/** Editable wrap draft with Keep/Drop flags for the review UI. */
interface WrapReviewDraft {
  recap: string;
  beats: Array<EpisodeWrapBeat & { keep: boolean; aim: boolean }>;
  facts: Array<{ text: string; keep: boolean }>;
  threads: Array<{ text: string; keep: boolean }>;
  guestEffects: Array<{ text: string; keep: boolean }>;
  resolvedThreads: Array<{ text: string; keep: boolean }>;
  staleFacts: Array<{ text: string; keep: boolean }>;
  hitTargets: Array<{ text: string; keep: boolean }>;
  hitCalendarEvents: Array<{ id: string; title: string; kind?: string; storyDay?: number; keep: boolean }>;
  characterUpdates: Array<{
    name: string;
    goal: string;
    emotion: string;
    location: string;
    condition: string;
    keep: boolean;
  }>;
  knowledgeUpdates: Array<{
    name: string;
    nowKnows: string;
    clearMustNotKnow: string;
    keep: boolean;
  }>;
  relationshipUpdates: Array<{
    from: string;
    to: string;
    kind: string;
    note: string;
    keep: boolean;
  }>;
  premisePreview: string;
  storyDayStart: number;
  storyDayEnd: number;
  /** Day the next episode opens on */
  nextStoryDay: number;
  dateNote: string;
  place: {
    name: string;
    currentState: string;
    atmosphere: string;
    keep: boolean;
  } | null;
  elsewhere: Array<{
    name: string;
    currentState: string;
    atmosphere: string;
    keep: boolean;
  }>;
  meanwhile: string;
  meanwhileKeep: boolean;
}

function draftFromAnalysis(d: EpisodeWrapDraft): WrapReviewDraft {
  return {
    recap: d.recap,
    beats: d.beats.map((b) => ({ ...b, keep: true, aim: false })),
    facts: d.facts.map((text) => ({ text, keep: true })),
    threads: d.threads.map((text) => ({ text, keep: true })),
    guestEffects: d.guestEffects.map((text) => ({ text, keep: true })),
    resolvedThreads: d.resolvedThreads.map((text) => ({ text, keep: true })),
    staleFacts: (d.staleFacts ?? []).map((text) => ({ text, keep: true })),
    hitTargets: (d.hitTargets ?? []).map((text) => ({ text, keep: true })),
    hitCalendarEvents: (d.hitCalendarEvents ?? []).map((row) => ({
      id: row.id,
      title: row.title,
      kind: row.kind,
      storyDay: row.storyDay,
      keep: true
    })),
    characterUpdates: d.characterUpdates.map((u) => ({
      name: u.name,
      goal: u.goal ?? '',
      emotion: u.emotion ?? '',
      location: u.location ?? '',
      condition: u.condition ?? '',
      keep: true
    })),
    knowledgeUpdates: d.knowledgeUpdates.map((u) => ({
      name: u.name,
      nowKnows: u.nowKnows ?? '',
      clearMustNotKnow: u.clearMustNotKnow ?? '',
      keep: true
    })),
    relationshipUpdates: d.relationshipUpdates.map((u) => ({
      from: u.from,
      to: u.to,
      kind: u.kind ?? '',
      note: u.note ?? '',
      keep: true
    })),
    premisePreview: d.premisePreview,
    storyDayStart: d.storyDayStart,
    storyDayEnd: d.storyDayEnd,
    nextStoryDay: Math.max(d.storyDayEnd, d.nextStoryDay),
    dateNote: d.dateNote,
    place: d.place
      ? {
        name: d.place.name,
        currentState: d.place.currentState ?? '',
        atmosphere: d.place.atmosphere ?? '',
        keep: true
      }
      : null,
    elsewhere: d.elsewhere.map((p) => ({
      name: p.name,
      currentState: p.currentState ?? '',
      atmosphere: p.atmosphere ?? '',
      keep: true
    })),
    meanwhile: d.meanwhile,
    meanwhileKeep: !!d.meanwhile.trim()
  };
}

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
  const wrapAbortRef = useRef<AbortController | null>(null);
  /** How many turns from the end are mounted — keeps long episodes responsive. */
  const [turnWindow, setTurnWindow] = useState(60);
  useEffect(() => { setTurnWindow(60); }, [episode?.id]);
  useEffect(() => { setWriteAnyway(false); }, [episode?.id, world?.id]);
  useEffect(() => {
    if (!currentWorldId || world === undefined) return;
    if (world === null) closeWorld();
  }, [currentWorldId, world, closeWorld]);
  const [wrapOpen, setWrapOpen] = useState<null | 'episode'>(null);
  const [wrapBusy, setWrapBusy] = useState(false);
  const [wrapPhase, setWrapPhase] = useState<'ready' | 'analyzing' | 'review'>('ready');
  const [wrapDraft, setWrapDraft] = useState<WrapReviewDraft | null>(null);
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

  // Fresh wrap draft only when opening from closed.
  const prevWrapOpen = useRef(wrapOpen);
  useEffect(() => {
    const wasClosed = prevWrapOpen.current === null;
    prevWrapOpen.current = wrapOpen;
    if (wrapOpen !== null && wasClosed) {
      setWrapPhase('ready');
      setWrapDraft(null);
      setWrapBusy(false);
    }
  }, [wrapOpen]);

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

  const closeWrapSheet = () => {
    wrapAbortRef.current?.abort();
    wrapAbortRef.current = null;
    setWrapOpen(null);
    setWrapPhase('ready');
    setWrapDraft(null);
  };

  const resetAfterEpisodeEnd = () => {
    closeWrapSheet();
  };

  /** Analyze the episode transcript into a reviewable wrap draft. */
  const runEpisodeAnalyze = async () => {
    if (!world || !season || !episode) return;
    wrapAbortRef.current?.abort();
    const controller = new AbortController();
    wrapAbortRef.current = controller;
    setWrapBusy(true);
    setWrapPhase('analyzing');
    setError('');
    try {
      const draft = await analyzeEpisode(world, season, episode, controller.signal);
      // Stale run (superseded by a newer Analyze) — do not touch UI.
      if (wrapAbortRef.current !== controller) return;
      if (controller.signal.aborted) {
        setWrapPhase('ready');
        setNotice('Analyze cancelled.');
        return;
      }
      setWrapDraft(draftFromAnalysis(draft));
      setWrapPhase('review');
    } catch (e) {
      if (wrapAbortRef.current !== controller) return;
      setWrapPhase('ready');
      if ((e as Error).name === 'AbortError' || controller.signal.aborted) {
        setNotice('Analyze cancelled.');
      } else {
        setError(classifyError(e));
      }
    } finally {
      // Only the active controller clears busy — avoids cancel racing a second Analyze.
      if (wrapAbortRef.current === controller) {
        setWrapBusy(false);
        wrapAbortRef.current = null;
      }
    }
  };

  /** End with a minimal recap so prior-episode memory survives (no full analyze review). */
  const skipWrapAndEnd = async () => {
    if (!world || !season || !episode) return;
    if (wrapBusyRef.current) return;
    wrapBusyRef.current = true;
    setWrapBusy(true);
    setError('');
    let memoryNote = '';
    try {
      // Soft wrap does not advance; nextEpisode below opens the next active episode.
      await commitSoftEpisodeWrap(world, season, episode, {
        onNotice: (m) => { memoryNote = m; }
      });
      await nextEpisode(episode);
      resetAfterEpisodeEnd();
      const filed = 'Episode ended. The next episode is open.';
      setNotice(memoryNote ? `${memoryNote} ${filed}` : filed);
    } catch (e) {
      setError(classifyError(e));
    } finally {
      wrapBusyRef.current = false;
      setWrapBusy(false);
    }
  };

  /** Commit kept wrap items, file continuity, open the next episode. */
  const confirmEpisodeWrap = async () => {
    if (!world || !season || !episode || !wrapDraft) return;
    if (wrapBusyRef.current) return;
    wrapBusyRef.current = true;
    setWrapBusy(true);
    setError('');
    try {
      // commitEpisodeWrap advances via nextEpisode; do not call nextEpisode again here.
      await commitEpisodeWrap(world, season, episode, {
        recap: wrapDraft.recap,
        beats: wrapDraft.beats
          .filter((b) => b.keep && b.text.trim())
          .map(({ text, consequence }) => ({ text, consequence })),
        aimedBeatTexts: wrapDraft.beats
          .filter((b) => b.keep && b.aim && b.text.trim())
          .map((b) => `${b.text.trim()}${b.consequence.trim() ? ` → ${b.consequence.trim()}` : ''}`),
        hitTargets: wrapDraft.hitTargets.filter((t) => t.keep).map((t) => t.text),
        hitCalendarEvents: wrapDraft.hitCalendarEvents
          .filter((t) => t.keep)
          .map((t) => ({ id: t.id, title: t.title })),
        facts: wrapDraft.facts.filter((f) => f.keep).map((f) => f.text),
        threads: wrapDraft.threads.filter((t) => t.keep).map((t) => t.text),
        guestEffects: wrapDraft.guestEffects.filter((g) => g.keep).map((g) => g.text),
        resolvedThreads: wrapDraft.resolvedThreads.filter((t) => t.keep).map((t) => t.text),
        staleFacts: wrapDraft.staleFacts.filter((t) => t.keep).map((t) => t.text),
        characterUpdates: wrapDraft.characterUpdates
          .filter((u) => u.keep && u.name.trim())
          .map(({ name, goal, emotion, location, condition }) => ({
            name,
            goal: goal || undefined,
            emotion: emotion || undefined,
            location: location || undefined,
            condition: condition || undefined
          })),
        knowledgeUpdates: wrapDraft.knowledgeUpdates
          .filter((u) => u.keep && u.name.trim())
          .map(({ name, nowKnows, clearMustNotKnow }) => ({
            name,
            nowKnows: nowKnows || undefined,
            clearMustNotKnow: clearMustNotKnow || undefined
          })),
        relationshipUpdates: wrapDraft.relationshipUpdates
          .filter((u) => u.keep && u.from.trim() && u.to.trim())
          .map(({ from, to, kind, note }) => ({
            from, to,
            kind: kind || undefined,
            note: note || undefined
          })),
        premisePreview: wrapDraft.premisePreview,
        storyDayStart: wrapDraft.storyDayStart,
        storyDayEnd: wrapDraft.storyDayEnd,
        nextStoryDay: wrapDraft.nextStoryDay,
        dateNote: wrapDraft.dateNote,
        place: wrapDraft.place?.keep
          ? {
            name: wrapDraft.place.name,
            currentState: wrapDraft.place.currentState || undefined,
            atmosphere: wrapDraft.place.atmosphere || undefined
          }
          : null,
        elsewhere: wrapDraft.elsewhere
          .filter((p) => p.keep && (p.currentState.trim() || p.atmosphere.trim()))
          .map((p) => ({
            name: p.name,
            currentState: p.currentState || undefined,
            atmosphere: p.atmosphere || undefined
          })),
        meanwhile: wrapDraft.meanwhileKeep ? wrapDraft.meanwhile : ''
      });
      resetAfterEpisodeEnd();
      setNotice('Episode ended. The next episode is open.');
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
        <Mono>no season</Mono>
        <div className="serif" style={{ fontWeight: 300, fontSize: 30, color: 'var(--ink-heading)' }}>This world has no season open.</div>
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
        <Mono>episode ended</Mono>
        <div className="serif" style={{ fontWeight: 300, fontSize: 30, color: 'var(--ink-heading)' }}>
          {lastEndedEpisode
            ? `Episode ${lastEndedEpisode.number} is filed. Open the next, or review the season.`
            : 'No episodes in this season yet.'}
        </div>
        {error && <ErrorNote error={error} onDismiss={() => setError('')} />}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {lastEndedEpisode && (
            <button className="btn-primary" disabled={recoverBusy} onClick={() => void openNextFromEnded()}>
              {recoverBusy ? 'Opening…' : 'Open the next episode'}
            </button>
          )}
          <button className="btn-ghost" onClick={() => go('sequel')}>Next season</button>
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
                  onClick={() => setWrapOpen('episode')}>End episode</button>
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
                Season {season.number} · Episode {episode.number}{locLabel ? ` · ${locLabel}` : ''} · {formatStoryDate(worldCalendar(world), worldCalendar(world).currentDay)}
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
              <button className="btn-ghost" style={{ padding: '7px 12px', fontSize: 11, minHeight: 36 }} onClick={() => setWrapOpen('episode')}>End episode</button>
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
                    Season {numberWord(season.number)} · Episode {numberWord(episode.number)}
                  </div>
                  <div className="serif" style={{
                    fontSize: narrow ? 26 : 32,
                    fontWeight: 400,
                    lineHeight: 1.2,
                    margin: '12px 0 0',
                    color: 'var(--ink-heading)'
                  }}>
                    {episode.title.trim() || activeLocation?.name || episode.location || 'Untitled episode'}
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

            {season.bible && turns.length === 0 && (
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
                  {season.bible.recap}
                </p>
              </div>
            )}

            {turns.length === 0 && !streaming && (
              <div style={{ fontSize: 14, lineHeight: 1.7, display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 8 }}>
                {season.premise ? (
                  <p className="serif" style={{
                    fontSize: fontPx, lineHeight: 1.82, margin: 0, fontStyle: 'italic',
                    color: 'var(--ink-muted)', textWrap: 'pretty'
                  }}>
                    {season.premise}
                  </p>
                ) : (
                  <p className="serif" style={{
                    fontSize: fontPx, lineHeight: 1.82, margin: 0, fontWeight: 300,
                    color: 'var(--ink-muted)'
                  }}>
                    Nothing here yet. Write the first turn.
                  </p>
                )}
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
                const chapterTitle = chapter.title.trim() || chapter.location || `Episode ${chapter.number}`;
                return (
                  <div key={turn.id}>
                    {showBreak && (
                      <div style={{ margin: '2.6em 0 1.4em', textAlign: 'center' }}>
                        <div className="serif" style={{
                          fontSize: 11, letterSpacing: '0.2em', textTransform: 'uppercase',
                          color: 'var(--ink-muted)'
                        }}>
                          Episode {chapter.number}
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

      {/* wrap sheet — sticky footer keeps CTAs reachable in portrait */}
      <Sheet
        open={wrapOpen !== null}
        onClose={closeWrapSheet}
        narrow={sheetBottom}
        footer={
          wrapPhase === 'review' ? (
            <>
              <button
                className="btn-primary"
                style={{ width: '100%', minHeight: 44 }}
                disabled={wrapBusy || !wrapDraft}
                onClick={() => void confirmEpisodeWrap()}
              >
                {wrapBusy ? (
                  'Ending episode…'
                ) : (
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 2, lineHeight: 1.25 }}>
                    <span>Close episode · open episode {episode.number + 1}</span>
                    <span style={{ fontSize: 11, fontWeight: 500, opacity: 0.8 }}>
                      {formatStoryDate(worldCalendar(world), wrapDraft?.nextStoryDay ?? worldCalendar(world).currentDay).toLowerCase()}
                    </span>
                  </span>
                )}
              </button>
              <button
                className="btn-quiet"
                style={{ width: '100%', minHeight: 40, fontSize: 12 }}
                disabled={wrapBusy}
                onClick={() => void skipWrapAndEnd()}
              >
                Skip full review · keep a short recap
              </button>
            </>
          ) : wrapPhase === 'analyzing' ? (
            <button
              className="btn-ghost"
              style={{ width: '100%', minHeight: 44 }}
              onClick={() => {
                // Abort only — leave wrapBusy/ref for the run's finally so a
                // follow-up Analyze cannot look idle while the old request settles.
                wrapAbortRef.current?.abort();
                setNotice('Analyze cancelled.');
                setWrapPhase('ready');
              }}
            >
              Cancel analyze
            </button>
          ) : (
            <>
              <button
                className="btn-primary"
                style={{ width: '100%', minHeight: 44 }}
                disabled={wrapBusy}
                onClick={() => void runEpisodeAnalyze()}
              >
                Review episode
              </button>
              <button
                className="btn-quiet"
                style={{ width: '100%', minHeight: 40, fontSize: 12 }}
                disabled={wrapBusy}
                onClick={() => void skipWrapAndEnd()}
              >
                Skip full review · keep a short recap
              </button>
            </>
          )
        }
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9.5, letterSpacing: '0.14em', textTransform: 'uppercase', opacity: 0.5 }}>
              season {season.number} · episode {episode.number}
            </div>
            <div className="serif" style={{ fontWeight: 300, fontSize: 27, lineHeight: 1.15, color: 'var(--ink-heading)' }}>
              End episode.
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.6, opacity: 0.62, maxWidth: '48ch', color: 'var(--paper)' }}>
              {wrapPhase === 'review'
                ? 'Edit the recap and time skip, Keep or Drop anything new or stale, then close the episode. Facts from play are already saved.'
                : 'Review the episode, then open the next one. Skipping still keeps a short recap.'}
            </div>
          </div>
          <button className="btn-ghost" aria-label="Close" style={{ width: 30, height: 30, padding: 0, flexShrink: 0 }} onClick={closeWrapSheet}>×</button>
        </div>

        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center' }}>
          <Chip active>Episode wrap</Chip>
          <button
            className="btn-quiet"
            style={{ fontSize: 12, minHeight: 36 }}
            onClick={() => { closeWrapSheet(); go('sequel'); }}
          >
            Next season →
          </button>
        </div>

        {error && <ErrorNote error={error} onDismiss={() => setError('')} />}
        {notice && (
          <div style={{
            fontSize: 12.5, lineHeight: 1.5, color: 'var(--paper)',
            border: '1px solid var(--rule)', borderRadius: 10, padding: '10px 12px',
            background: 'rgba(0,0,0,0.04)', display: 'flex', gap: 10, alignItems: 'flex-start'
          }}>
            <span style={{ flex: 1 }}>{notice}</span>
            <button className="btn-quiet" style={{ fontSize: 11, minHeight: 28 }} onClick={() => setNotice('')}>dismiss</button>
          </div>
        )}

        {wrapPhase === 'analyzing' ? (
          <div style={{ padding: '20px 0' }}>
            <Spinner label="ending episode" />
          </div>
        ) : wrapPhase === 'review' && wrapDraft ? (
          <WrapReviewBody draft={wrapDraft} onChange={setWrapDraft} guests={guests} world={world} />
        ) : (
          <>
            <div style={{
              fontSize: 12.5, lineHeight: 1.55, color: 'var(--paper)',
              border: '1px solid var(--rule)', borderRadius: 12, padding: '12px 14px',
              background: 'transparent'
            }}>
              Analyze closes the episode: recap, time skip, next opening, plus Keep/Drop only for new or stale facts and threads
              {guests.length > 0 ? ', and walk-on effects' : ''}. Episode prose stays saved; only the active episode stays in the writing loop.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              <Mono style={{ fontSize: 9 }}>saved facts</Mono>
              {continuity.slice(-6).map((f) => (
                <div key={f.id} className="craft-row" style={{ padding: '12px 14px', fontSize: 13, lineHeight: 1.5, color: 'var(--ink-muted)' }}>
                  {f.text}
                </div>
              ))}
              {continuity.length === 0 && (
                <div style={{ fontSize: 12.5, opacity: 0.5, color: 'var(--paper)' }}>
                  Nothing saved yet. Facts are saved as the scene unfolds.
                </div>
              )}
            </div>
          </>
        )}
      </Sheet>

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
              <button className="btn-ghost" style={{ minHeight: 44, textAlign: 'left' }} onClick={() => { setMoreSheet(false); setWrapOpen('episode'); }}>
                End episode
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
          <button className="btn-ghost" style={{ minHeight: 44, textAlign: 'left' }} onClick={() => { setMoreSheet(false); go('sequel'); }}>
            Next season
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

// ---------- director sub-panels ----------

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

function KeepDropChips({
  keep, onKeep, onDrop
}: {
  keep: boolean;
  onKeep: () => void;
  onDrop: () => void;
}) {
  const btn = (active: boolean, label: string, onClick: () => void) => (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: 1,
        minHeight: 44,
        border: `1px solid ${active ? 'rgba(0,0,0,0.28)' : 'var(--rule)'}`,
        background: active ? ACCENT_RGBA.a85 : 'rgba(0,0,0,0.04)',
        color: active ? 'var(--accent-ink)' : 'var(--paper)',
        borderRadius: 4,
        fontSize: 13,
        fontWeight: active ? 600 : 500,
        cursor: 'pointer'
      }}
    >
      {label}
    </button>
  );
  return (
    <div style={{ display: 'flex', gap: 8, width: '100%' }}>
      {btn(keep, 'Keep', onKeep)}
      {btn(!keep, 'Drop', onDrop)}
    </div>
  );
}

function WrapReviewBody({
  draft, onChange, guests, world
}: {
  draft: WrapReviewDraft;
  onChange: (d: WrapReviewDraft) => void;
  guests: EpisodeGuest[];
  world: World;
}) {
  const cal = worldCalendar(world);
  const patchBeat = (i: number, p: Partial<WrapReviewDraft['beats'][number]>) => {
    onChange({ ...draft, beats: draft.beats.map((b, j) => (j === i ? { ...b, ...p } : b)) });
  };
  const patchLine = (
    key: 'facts' | 'threads' | 'guestEffects' | 'resolvedThreads' | 'staleFacts',
    i: number,
    p: Partial<{ text: string; keep: boolean }>
  ) => {
    onChange({
      ...draft,
      [key]: draft[key].map((row, j) => (j === i ? { ...row, ...p } : row))
    });
  };
  const patchCast = (i: number, p: Partial<WrapReviewDraft['characterUpdates'][number]>) => {
    onChange({
      ...draft,
      characterUpdates: draft.characterUpdates.map((u, j) => (j === i ? { ...u, ...p } : u))
    });
  };
  const setNextDay = (day: number) => {
    onChange({ ...draft, nextStoryDay: Math.max(draft.storyDayEnd, Math.floor(day)) });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Mono style={{ fontSize: 9 }}>previously-on · next episode</Mono>
        <textarea
          className="serif"
          rows={7}
          value={draft.recap}
          onChange={(e) => onChange({ ...draft, recap: e.target.value })}
          style={{
            fontSize: 15.5, lineHeight: 1.65, color: 'var(--paper)',
            width: '100%', background: 'transparent'
          }}
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Mono style={{ fontSize: 9 }}>what's live → next episode</Mono>
        <textarea
          className="serif"
          rows={4}
          value={draft.premisePreview}
          onChange={(e) => onChange({ ...draft, premisePreview: e.target.value })}
          style={{
            fontSize: 14.5, lineHeight: 1.6, color: 'var(--paper)',
            width: '100%', background: 'transparent'
          }}
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Mono style={{ fontSize: 9 }}>episode date</Mono>
        <div style={{
          border: '1px solid var(--rule)', borderRadius: 14, padding: '12px 14px',
          background: 'transparent', display: 'flex', flexDirection: 'column', gap: 10
        }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 100px' }}>
              <Mono style={{ fontSize: 8, opacity: 0.5 }}>opens day</Mono>
              <input
                type="number"
                min={1}
                value={draft.storyDayStart}
                onChange={(e) => {
                  const start = Math.max(1, Number(e.target.value) || 1);
                  const end = Math.max(start, draft.storyDayEnd);
                  onChange({
                    ...draft,
                    storyDayStart: start,
                    storyDayEnd: end,
                    nextStoryDay: Math.max(end, draft.nextStoryDay)
                  });
                }}
                style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, color: 'var(--paper)' }}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 100px' }}>
              <Mono style={{ fontSize: 8, opacity: 0.5 }}>ends day</Mono>
              <input
                type="number"
                min={draft.storyDayStart}
                value={draft.storyDayEnd}
                onChange={(e) => {
                  const end = Math.max(draft.storyDayStart, Number(e.target.value) || draft.storyDayStart);
                  onChange({
                    ...draft,
                    storyDayEnd: end,
                    nextStoryDay: Math.max(end, draft.nextStoryDay)
                  });
                }}
                style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, color: 'var(--paper)' }}
              />
            </label>
          </div>
          <textarea
            rows={2}
            value={draft.dateNote}
            onChange={(e) => onChange({ ...draft, dateNote: e.target.value })}
            placeholder="How time passed — overnight, two days on the road, same afternoon…"
            style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--paper)', background: 'transparent', border: 0, padding: 0 }}
          />

          <div style={{
            borderTop: '1px solid var(--rule)', paddingTop: 12,
            display: 'flex', flexDirection: 'column', gap: 10
          }}>
            <Mono style={{ fontSize: 8, opacity: 0.5 }}>next episode opens</Mono>
            <div className="serif" style={{ fontSize: 17, color: 'var(--paper)' }}>
              {formatStoryDate(cal, draft.nextStoryDay)}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <Chip
                active={draft.nextStoryDay === draft.storyDayEnd}
                onClick={() => setNextDay(draft.storyDayEnd)}
              >
                same day
              </Chip>
              <Chip
                active={draft.nextStoryDay === draft.storyDayEnd + 1}
                onClick={() => setNextDay(draft.storyDayEnd + 1)}
              >
                +1 day
              </Chip>
              <Chip
                active={draft.nextStoryDay === draft.storyDayEnd + 2}
                onClick={() => setNextDay(draft.storyDayEnd + 2)}
              >
                +2
              </Chip>
              <Chip
                active={draft.nextStoryDay === draft.storyDayEnd + 7}
                onClick={() => setNextDay(draft.storyDayEnd + 7)}
              >
                +7
              </Chip>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, opacity: 0.8 }}>
                day
                <input
                  type="number"
                  min={draft.storyDayEnd}
                  value={draft.nextStoryDay}
                  onChange={(e) => setNextDay(Number(e.target.value) || draft.storyDayEnd)}
                  style={{
                    width: 64, fontFamily: "'IBM Plex Mono', monospace", fontSize: 12,
                    background: 'rgba(0,0,0,0.05)', border: '1px solid var(--rule)',
                    borderRadius: 8, padding: '6px 8px', color: 'var(--paper)'
                  }}
                />
              </label>
            </div>
            <div style={{ fontSize: 12, opacity: 0.55, lineHeight: 1.4 }}>
              Confirm opens the next episode on {formatStoryDate(cal, draft.nextStoryDay).toLowerCase()}.
            </div>
          </div>
        </div>
      </div>

      {(draft.place || draft.elsewhere.length > 0) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Mono style={{ fontSize: 9 }}>the world as you left it</Mono>
          <div style={{ fontSize: 12, lineHeight: 1.45, opacity: 0.5 }}>
            Places keep this condition into the next episode. Weather is only for the next opening.
          </div>
          {draft.place && (
            <div style={{
              display: 'flex', flexDirection: 'column', gap: 10,
              border: '1px solid var(--rule)', borderRadius: 14, padding: '14px 14px',
              background: 'transparent',
              opacity: draft.place.keep ? 1 : 0.42
            }}>
              <Mono style={{ fontSize: 8, opacity: 0.5 }}>
                {draft.place.name || 'this scene'}
              </Mono>
              <textarea
                rows={2}
                value={draft.place.currentState}
                onChange={(e) => onChange({
                  ...draft,
                  place: { ...draft.place!, currentState: e.target.value }
                })}
                placeholder="How the place is left — lamp smashed, quay empty…"
                style={{ fontSize: 13.5, lineHeight: 1.5, background: 'transparent', border: 0, padding: 0, color: 'var(--paper)' }}
              />
              <textarea
                rows={2}
                value={draft.place.atmosphere}
                onChange={(e) => onChange({
                  ...draft,
                  place: { ...draft.place!, atmosphere: e.target.value }
                })}
                placeholder="Weather / light for the next opening (optional)"
                style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--ink-muted)', background: 'transparent', border: 0, padding: 0 }}
              />
              <KeepDropChips
                keep={draft.place.keep}
                onKeep={() => onChange({ ...draft, place: { ...draft.place!, keep: true } })}
                onDrop={() => onChange({ ...draft, place: { ...draft.place!, keep: false } })}
              />
            </div>
          )}
          {draft.elsewhere.map((p, i) => (
            <div key={`${p.name}-${i}`} style={{
              display: 'flex', flexDirection: 'column', gap: 10,
              border: '1px solid var(--rule)', borderRadius: 14, padding: '14px 14px',
              background: 'transparent',
              opacity: p.keep ? 1 : 0.42
            }}>
              <input
                value={p.name}
                onChange={(e) => {
                  const elsewhere = draft.elsewhere.map((row, j) =>
                    j === i ? { ...row, name: e.target.value } : row
                  );
                  onChange({ ...draft, elsewhere });
                }}
                placeholder="Place name"
                style={{ fontSize: 13, background: 'transparent', border: 0, padding: 0, color: 'var(--paper)' }}
              />
              <textarea
                rows={2}
                value={p.currentState}
                onChange={(e) => {
                  const elsewhere = draft.elsewhere.map((row, j) =>
                    j === i ? { ...row, currentState: e.target.value } : row
                  );
                  onChange({ ...draft, elsewhere });
                }}
                placeholder="How that place changed"
                style={{ fontSize: 13, lineHeight: 1.5, background: 'transparent', border: 0, padding: 0, color: 'var(--paper)' }}
              />
              <KeepDropChips
                keep={p.keep}
                onKeep={() => {
                  const elsewhere = draft.elsewhere.map((row, j) =>
                    j === i ? { ...row, keep: true } : row
                  );
                  onChange({ ...draft, elsewhere });
                }}
                onDrop={() => {
                  const elsewhere = draft.elsewhere.map((row, j) =>
                    j === i ? { ...row, keep: false } : row
                  );
                  onChange({ ...draft, elsewhere });
                }}
              />
            </div>
          ))}
        </div>
      )}

      {draft.nextStoryDay > draft.storyDayEnd && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Mono style={{ fontSize: 9 }}>meanwhile</Mono>
          <div style={{ fontSize: 12, lineHeight: 1.45, opacity: 0.5 }}>
            Off-screen life during the {draft.nextStoryDay - draft.storyDayEnd} day
            {draft.nextStoryDay - draft.storyDayEnd === 1 ? '' : 's'} before the next episode opens.
          </div>
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 10,
            border: '1px solid var(--rule)', borderRadius: 14, padding: '14px 14px',
            background: 'transparent',
            opacity: draft.meanwhileKeep ? 1 : 0.42
          }}>
            <textarea
              className="serif"
              rows={4}
              value={draft.meanwhile}
              onChange={(e) => onChange({ ...draft, meanwhile: e.target.value })}
              placeholder="Who waited, who travelled, what healed, what got worse…"
              style={{
                fontSize: 15, lineHeight: 1.6, color: 'var(--paper)',
                width: '100%', background: 'transparent', border: 0, padding: 0
              }}
            />
            <KeepDropChips
              keep={draft.meanwhileKeep}
              onKeep={() => onChange({ ...draft, meanwhileKeep: true })}
              onDrop={() => onChange({ ...draft, meanwhileKeep: false })}
            />
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Mono style={{ fontSize: 9 }}>beats</Mono>
        <div style={{ fontSize: 12, lineHeight: 1.45, opacity: 0.5 }}>
          Aimed beats become the next episode’s plot targets.
        </div>
        {draft.beats.length === 0 && (
          <div style={{ fontSize: 12.5, opacity: 0.5 }}>No standout beats proposed — you can still confirm.</div>
        )}
        {draft.beats.map((b, i) => (
          <div key={i} style={{
            display: 'flex', flexDirection: 'column', gap: 10,
            border: '1px solid var(--rule)', borderRadius: 14, padding: '14px 14px',
            background: 'transparent',
            opacity: b.keep ? 1 : 0.42
          }}>
            <textarea
              className="serif"
              rows={2}
              value={b.text}
              onChange={(e) => patchBeat(i, { text: e.target.value })}
              style={{ fontSize: 16, lineHeight: 1.45, background: 'transparent', border: 0, padding: 0, color: 'var(--paper)' }}
            />
            <textarea
              rows={2}
              value={b.consequence}
              onChange={(e) => patchBeat(i, { consequence: e.target.value })}
              placeholder="what it leaves for later…"
              style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--ink-muted)', background: 'transparent', border: 0, padding: 0 }}
            />
            <KeepDropChips
              keep={b.keep}
              onKeep={() => patchBeat(i, { keep: true })}
              onDrop={() => patchBeat(i, { keep: false, aim: false })}
            />
            {b.keep && (
              <Chip
                active={b.aim}
                onClick={() => patchBeat(i, { aim: !b.aim })}
              >
                {b.aim ? 'Aim next · on' : 'Aim next'}
              </Chip>
            )}
          </div>
        ))}
      </div>

      {draft.hitTargets.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Mono style={{ fontSize: 9 }}>plot targets hit this episode</Mono>
          <div style={{ fontSize: 12, lineHeight: 1.45, opacity: 0.5 }}>
            Keep to mark these pending targets as hit. Drop to leave them pending for the next episode.
          </div>
          {draft.hitTargets.map((row, i) => (
            <div key={i} style={{
              display: 'flex', flexDirection: 'column', gap: 10,
              border: '1px solid var(--rule)', borderRadius: 14, padding: '12px 14px',
              background: 'transparent',
              opacity: row.keep ? 1 : 0.42
            }}>
              <textarea
                rows={2}
                value={row.text}
                onChange={(e) => {
                  const hitTargets = draft.hitTargets.map((r, j) =>
                    j === i ? { ...r, text: e.target.value } : r
                  );
                  onChange({ ...draft, hitTargets });
                }}
                style={{ fontSize: 13.5, lineHeight: 1.5, background: 'transparent', border: 0, padding: 0, color: 'var(--paper)' }}
              />
              <KeepDropChips
                keep={row.keep}
                onKeep={() => {
                  const hitTargets = draft.hitTargets.map((r, j) =>
                    j === i ? { ...r, keep: true } : r
                  );
                  onChange({ ...draft, hitTargets });
                }}
                onDrop={() => {
                  const hitTargets = draft.hitTargets.map((r, j) =>
                    j === i ? { ...r, keep: false } : r
                  );
                  onChange({ ...draft, hitTargets });
                }}
              />
            </div>
          ))}
        </div>
      )}

      {draft.hitCalendarEvents.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Mono style={{ fontSize: 9 }}>calendar events played this episode</Mono>
          <div style={{ fontSize: 12, lineHeight: 1.45, opacity: 0.5 }}>
            Keep to mark these dated events as played (and file a continuity note). Drop to leave them due.
          </div>
          {draft.hitCalendarEvents.map((row, i) => (
            <div key={row.id || i} style={{
              display: 'flex', flexDirection: 'column', gap: 10,
              border: '1px solid var(--rule)', borderRadius: 14, padding: '12px 14px',
              background: 'transparent',
              opacity: row.keep ? 1 : 0.42
            }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--paper)' }}>{row.title}</div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, opacity: 0.45 }}>
                {[row.kind, row.storyDay != null ? `day ${row.storyDay}` : null].filter(Boolean).join(' · ')}
              </div>
              <KeepDropChips
                keep={row.keep}
                onKeep={() => {
                  const hitCalendarEvents = draft.hitCalendarEvents.map((r, j) =>
                    j === i ? { ...r, keep: true } : r
                  );
                  onChange({ ...draft, hitCalendarEvents });
                }}
                onDrop={() => {
                  const hitCalendarEvents = draft.hitCalendarEvents.map((r, j) =>
                    j === i ? { ...r, keep: false } : r
                  );
                  onChange({ ...draft, hitCalendarEvents });
                }}
              />
            </div>
          ))}
        </div>
      )}

      {([
        ['facts', 'new continuity facts'] as const,
        ['staleFacts', 'facts no longer true — Keep to drop from memory'] as const,
        ['threads', 'new open threads'] as const,
        ['resolvedThreads', 'threads resolved this episode'] as const,
        ['guestEffects', 'walk-on effects'] as const
      ]).map(([key, label]) => {
        if (key === 'guestEffects' && draft.guestEffects.length === 0 && guests.length === 0) return null;
        if (key === 'resolvedThreads' && draft.resolvedThreads.length === 0) return null;
        if (key === 'staleFacts' && draft.staleFacts.length === 0) return null;
        return (
          <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Mono style={{ fontSize: 9 }}>{label}</Mono>
            {draft[key].length === 0 && (
              <div style={{ fontSize: 12.5, opacity: 0.5 }}>
                {key === 'facts' || key === 'threads'
                  ? 'Already on file from play — nothing new or conflicting to review.'
                  : 'None proposed.'}
              </div>
            )}
            {draft[key].map((row, i) => (
              <div key={i} style={{
                display: 'flex', flexDirection: 'column', gap: 10,
                border: '1px solid var(--rule)', borderRadius: 14, padding: '12px 14px',
                background: 'transparent',
                opacity: row.keep ? 1 : 0.42
              }}>
                <textarea
                  rows={2}
                  value={row.text}
                  onChange={(e) => patchLine(key, i, { text: e.target.value })}
                  style={{ fontSize: 13.5, lineHeight: 1.5, background: 'transparent', border: 0, padding: 0, color: 'var(--paper)' }}
                />
                <KeepDropChips
                  keep={row.keep}
                  onKeep={() => patchLine(key, i, { keep: true })}
                  onDrop={() => patchLine(key, i, { keep: false })}
                />
              </div>
            ))}
          </div>
        );
      })}

      {draft.characterUpdates.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Mono style={{ fontSize: 9 }}>live state → next episode · voice & anchors unchanged</Mono>
          {draft.characterUpdates.map((u, i) => (
            <div key={i} style={{
              display: 'flex', flexDirection: 'column', gap: 8,
              border: '1px solid var(--rule)', borderRadius: 14, padding: '12px 14px',
              background: 'transparent',
              opacity: u.keep ? 1 : 0.42
            }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--paper)' }}>{u.name}</div>
              {([
                ['goal', 'goal'] as const,
                ['emotion', 'emotion'] as const,
                ['location', 'location'] as const,
                ['condition', 'condition'] as const
              ]).map(([field, label]) => (
                <label key={field} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <Mono style={{ fontSize: 8, opacity: 0.55 }}>{label}</Mono>
                  <input
                    value={u[field]}
                    onChange={(e) => patchCast(i, { [field]: e.target.value })}
                    style={{
                      fontSize: 13, lineHeight: 1.4, color: 'var(--paper)',
                      background: 'transparent', border: 0, padding: 0
                    }}
                  />
                </label>
              ))}
              <KeepDropChips
                keep={u.keep}
                onKeep={() => patchCast(i, { keep: true })}
                onDrop={() => patchCast(i, { keep: false })}
              />
            </div>
          ))}
        </div>
      )}

      {draft.knowledgeUpdates.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Mono style={{ fontSize: 9 }}>knowledge updates</Mono>
          {draft.knowledgeUpdates.map((u, i) => (
            <div key={i} style={{
              display: 'flex', flexDirection: 'column', gap: 8,
              border: '1px solid var(--rule)', borderRadius: 14, padding: '12px 14px',
              background: 'transparent',
              opacity: u.keep ? 1 : 0.42
            }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--paper)' }}>{u.name}</div>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <Mono style={{ fontSize: 8, opacity: 0.55 }}>now knows</Mono>
                <textarea
                  rows={2}
                  value={u.nowKnows}
                  onChange={(e) => {
                    const knowledgeUpdates = draft.knowledgeUpdates.map((row, j) =>
                      j === i ? { ...row, nowKnows: e.target.value } : row
                    );
                    onChange({ ...draft, knowledgeUpdates });
                  }}
                  style={{ fontSize: 13, lineHeight: 1.45, color: 'var(--paper)', background: 'transparent', border: 0, padding: 0 }}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <Mono style={{ fontSize: 8, opacity: 0.55 }}>clear from must-not-know</Mono>
                <input
                  value={u.clearMustNotKnow}
                  onChange={(e) => {
                    const knowledgeUpdates = draft.knowledgeUpdates.map((row, j) =>
                      j === i ? { ...row, clearMustNotKnow: e.target.value } : row
                    );
                    onChange({ ...draft, knowledgeUpdates });
                  }}
                  style={{ fontSize: 13, color: 'var(--paper)', background: 'transparent', border: 0, padding: 0 }}
                />
              </label>
              <KeepDropChips
                keep={u.keep}
                onKeep={() => {
                  const knowledgeUpdates = draft.knowledgeUpdates.map((row, j) =>
                    j === i ? { ...row, keep: true } : row
                  );
                  onChange({ ...draft, knowledgeUpdates });
                }}
                onDrop={() => {
                  const knowledgeUpdates = draft.knowledgeUpdates.map((row, j) =>
                    j === i ? { ...row, keep: false } : row
                  );
                  onChange({ ...draft, knowledgeUpdates });
                }}
              />
            </div>
          ))}
        </div>
      )}

      {draft.relationshipUpdates.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Mono style={{ fontSize: 9 }}>relationship shifts</Mono>
          {draft.relationshipUpdates.map((u, i) => (
            <div key={i} style={{
              display: 'flex', flexDirection: 'column', gap: 8,
              border: '1px solid var(--rule)', borderRadius: 14, padding: '12px 14px',
              background: 'transparent',
              opacity: u.keep ? 1 : 0.42
            }}>
              <div style={{ fontSize: 14, color: 'var(--paper)' }}>
                <strong>{u.from}</strong> → <strong>{u.to}</strong>
              </div>
              <input
                value={u.kind}
                onChange={(e) => {
                  const relationshipUpdates = draft.relationshipUpdates.map((row, j) =>
                    j === i ? { ...row, kind: e.target.value } : row
                  );
                  onChange({ ...draft, relationshipUpdates });
                }}
                placeholder="kind (ally, rival…)"
                style={{ fontSize: 13, color: 'var(--paper)', background: 'transparent', border: 0, padding: 0 }}
              />
              <textarea
                rows={2}
                value={u.note}
                onChange={(e) => {
                  const relationshipUpdates = draft.relationshipUpdates.map((row, j) =>
                    j === i ? { ...row, note: e.target.value } : row
                  );
                  onChange({ ...draft, relationshipUpdates });
                }}
                placeholder="what changed…"
                style={{ fontSize: 13, lineHeight: 1.45, color: 'var(--paper)', background: 'transparent', border: 0, padding: 0 }}
              />
              <KeepDropChips
                keep={u.keep}
                onKeep={() => {
                  const relationshipUpdates = draft.relationshipUpdates.map((row, j) =>
                    j === i ? { ...row, keep: true } : row
                  );
                  onChange({ ...draft, relationshipUpdates });
                }}
                onDrop={() => {
                  const relationshipUpdates = draft.relationshipUpdates.map((row, j) =>
                    j === i ? { ...row, keep: false } : row
                  );
                  onChange({ ...draft, relationshipUpdates });
                }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function numberWord(n: number): string {
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  return words[n] ?? String(n);
}
