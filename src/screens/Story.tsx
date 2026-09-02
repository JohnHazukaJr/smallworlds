import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import {
  analyzeEpisode, commitEpisodeWrap, commitSoftEpisodeWrap, deleteTurnsAfter, deleteTurnsFrom, draftColdOpenNarration, imageModelFor,
  clearEpisodeRunningSummary, regenerateBeat, rollbackTurnSnapshot,
  snapshotTurnsAfter, snapshotTurnsFrom, writeTurn, seedSeasonCalendarEvents,
  WriteAbortedError, type EpisodeWrapDraft, type StreamMeta, type SeedCalendarEventDraft
} from '../ai/engine';
import {
  applyDeliveryTone,
  isDeliveryTone,
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
import { collectSceneImageRefs, generateSceneImage, sceneHasPortraitRefs } from '../ai/image';
import {
  episodeContextPressure, episodeHistoryChars, HISTORY_CHAR_BUDGET,
  pendingBeatLabel, preferBucketsForEpisodes, resolveSpeakerName, selectDirectorFacts, selectDirectorThreads,
  type DirectorBeat
} from '../ai/prompts';
import { DeliveryPicker } from '../components/DeliveryPicker';
import { WorldEditorSheet } from '../components/WorldEditorSheet';
import { db, guardStorage, recordTombstones, safeWrite, uid } from '../db';
import {
  CALENDAR_EVENT_KINDS, CALENDAR_EVENT_SCALES, CALENDAR_EVENT_VISIBILITIES,
  emptyCalendarEvent, evaluateCalendarEvents
} from '../calendarEvents';
import {
  AVATAR_PX, DEFAULT_DISPLAY, moodFromHue, useApp,
  type AvatarSize, type DialogueStyle, type StoryLayout
} from '../store/app';
import { hasWritingModel } from '../ai/models';
import { useSettings } from '../store/settings';
import type {
  CalendarEvent, CalendarEventKind, CalendarEventScale, CalendarEventVisibility,
  Character, ComposeMode, ContinuityFact, Episode, EpisodeGuest, EpisodeWrap, EpisodeWrapBeat,
  Location, OpenThread, PlotTarget, PlotTargetStatus, Season, Turn, TurnLength, World
} from '../types';
import {
  defaultVisibilityForKind, isPlayerAgencyMode, resolveComposeMode, TURN_LENGTH_LABELS,
  worldCalendarEventPrefs, CALENDAR_EVENT_CAP
} from '../types';
import { AppError, classifyError, formatUserError } from '../errors';
import {
  Chip, ConfirmBar, ErrorNote, Mono, Sheet, Spinner, Toggle,
  phoneChrome, sheetsFromBottom, shortStoryChrome, useViewport
} from '../ui/bits';
import { Face } from '../ui/Face';
import { fileToSceneImage } from '../ui/image';
import { attributionRun, isDialogueBlock, lastSpokenBy } from '../ui/attribution';
import {
  SCROLL_BACKDROP_LABEL, SCROLL_BACKDROPS, resolveScrollBackdrop
} from '../ui/scrollBackdrop';
import { avatarStyle, speakerInk, BACKDROPS, MOODS, STRIPE, ACCENT, ACCENT_RGBA } from '../ui/theme';
import {
  calendarPatch, characterPortraits, dayFromParts, emptyLocation, evaluateWorldWriteReady, formatStoryDate,
  advanceMonths, buildEpisodePlotTargets, formatStoryDateShort, latestEndedEpisode, nextEpisode, nextSceneCastIds, partsForDay,
  PLOT_TARGET_CAP, weekdayForDay, worldCalendar
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

function parseTurn(turn: Turn, characters: Character[], guests: EpisodeGuest[] = []): ProseBlock[] {
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
          <span key={i} style={{ color: 'rgba(236,234,230,0.55)', fontStyle: 'normal' }}>
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
  const ink = b.hue !== undefined ? speakerInk(b.hue) : 'rgba(236,234,230,0.8)';
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
              color: 'rgba(230,233,235,0.5)',
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
      className={isDialog ? `speak-row${fromPlayer ? ' player' : ''}` : undefined}
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
                color: 'rgba(236,234,230,0.55)',
                border: '1px solid rgba(255,255,255,0.14)',
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
            color: 'rgba(236,234,230,0.45)', borderLeft: '1px solid rgba(255,255,255,0.14)', paddingLeft: 12
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

export function Story() {
  const { band, height, keyboardOffset } = useViewport();
  const phone = phoneChrome(band);
  const compact = band === 'compact';
  const short = shortStoryChrome(band, height);
  const sheetBottom = sheetsFromBottom(band);
  const narrow = phone;
  const { currentWorldId, layout, setLayout, mood, setMood, backdrop, go, display, setDisplay, goLocations: openLocations, goCast: openCast, closeWorld } = useApp();
  useSettings((s) => s.proseModel);
  const M = MOODS[mood];
  const BD = BACKDROPS[backdrop];
  const readMode = layout === 'read';
  const avatarPx = AVATAR_PX[display.avatarSize];
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
  const turnsLive = useLiveQuery(
    async () => (episode ? db.turns.where('episodeId').equals(episode.id).sortBy('createdAt') : []),
    [episode?.id]
  );
  const turns = turnsLive ?? [];
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
    || (turnsLive !== undefined && charactersLive !== undefined && locationsLive !== undefined);

  // writing state — Continue/Steer exclusive; Speak/Act independent toggles → speak|act|play
  const [composeBase, setComposeBase] = useState<'continue' | 'steer'>('continue');
  const [speakOn, setSpeakOn] = useState(false);
  const [actOn, setActOn] = useState(false);
  const composeMode = resolveComposeMode(composeBase, speakOn, actOn);
  const agencyOn = isPlayerAgencyMode(composeMode);
  const [deliveryTone, setDeliveryTone] = useState<DeliveryTone | null>(() => {
    try {
      const last = localStorage.getItem('sw-last-delivery-tone');
      return last && isDeliveryTone(last) ? last : null;
    } catch { return null; }
  });
  const [length, setLength] = useState<TurnLength>(() => {
    try {
      const saved = localStorage.getItem('sw-reply-size');
      if (saved === 'beat' || saved === 'scene' || saved === 'episode') return saved;
    } catch { /* ignore */ }
    return 'scene';
  });
  /** Pin who should answer on Speak/Act — null = director chooses. */
  const [preferSpeaker, setPreferSpeaker] = useState<
    null | { kind: 'cast'; id: string } | { kind: 'guest'; id: string }
  >(null);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [partial, setPartial] = useState('');
  const [partialMeta, setPartialMeta] = useState<StreamMeta>({ role: 'narrator' });
  const [progressLabel, setProgressLabel] = useState('writing…');
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
  const [directorSheet, setDirectorSheet] = useState(false);
  const [worldEditOpen, setWorldEditOpen] = useState(false);
  const [displayOpen, setDisplayOpen] = useState(false);
  const [moreSheet, setMoreSheet] = useState(false);
  const [confirmAsk, setConfirmAsk] = useState<null | {
    kind: 'reroll' | 'delete' | 'deleteBelow' | 'retryFrom';
    turn: Turn;
  }>(null);
  const [showReadCoach, setShowReadCoach] = useState(() => {
    try { return localStorage.getItem('sw-read-coach') !== '1'; } catch { return false; }
  });
  const [composerOpen, setComposerOpen] = useState(false);
  const [composeMore, setComposeMore] = useState(false);
  const [hudTucked, setHudTucked] = useState(false);
  const [sceneFadeKey, setSceneFadeKey] = useState(0);
  /** Context-pressure nudge: dismiss until chars rise ~10% of budget or location changes. */
  const [nudgeDismissedAtChars, setNudgeDismissedAtChars] = useState(0);
  const [nudgeDismissedLocId, setNudgeDismissedLocId] = useState<string | null | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLElement>(null);

  useEffect(() => {
    try { localStorage.setItem('sw-reply-size', length); } catch { /* ignore */ }
  }, [length]);

  // Restore prefer-speaker pin per episode; clear when target leaves.
  useEffect(() => {
    if (!episode?.id) {
      setPreferSpeaker(null);
      return;
    }
    try {
      const raw = localStorage.getItem(`sw-prefer-speaker:${episode.id}`);
      if (!raw) {
        setPreferSpeaker(null);
        return;
      }
      const parsed = JSON.parse(raw) as { kind?: string; id?: string };
      if ((parsed.kind === 'cast' || parsed.kind === 'guest') && typeof parsed.id === 'string') {
        setPreferSpeaker({ kind: parsed.kind, id: parsed.id });
      } else {
        setPreferSpeaker(null);
      }
    } catch {
      setPreferSpeaker(null);
    }
  }, [episode?.id]);

  useEffect(() => {
    if (!episode?.id) return;
    try {
      if (!preferSpeaker) localStorage.removeItem(`sw-prefer-speaker:${episode.id}`);
      else localStorage.setItem(`sw-prefer-speaker:${episode.id}`, JSON.stringify(preferSpeaker));
    } catch { /* ignore */ }
  }, [episode?.id, preferSpeaker]);

  // Drop pinned speaker when they leave the scene / episode.
  useEffect(() => {
    if (!preferSpeaker || !episode) return;
    if (preferSpeaker.kind === 'cast') {
      if (!episode.castIds.includes(preferSpeaker.id)) setPreferSpeaker(null);
    } else {
      const guests = episode.guests ?? [];
      const active = episode.activeGuestIds;
      const stillThere = guests.some((g) => g.id === preferSpeaker.id)
        && (active == null || active.includes(preferSpeaker.id));
      if (!stillThere) setPreferSpeaker(null);
    }
  }, [episode?.castIds, episode?.guests, episode?.activeGuestIds, preferSpeaker]);

  const activeLocation = locations.find((l) => l.id === episode?.locationId)
    ?? locations.find((l) => episode?.location && l.name && episode.location.toLowerCase().includes(l.name.toLowerCase()));

  const episodeChars = useMemo(() => episodeHistoryChars(turns), [turns]);
  const pressure = episodeContextPressure(episodeChars);
  const locationShiftNudge = nudgeDismissedLocId !== undefined
    && (episode?.locationId ?? null) !== nudgeDismissedLocId
    && episodeChars >= HISTORY_CHAR_BUDGET * 0.25;
  const pressurePastDismiss = (pressure === 'warn' || pressure === 'escalate')
    && episodeChars >= nudgeDismissedAtChars + HISTORY_CHAR_BUDGET * 0.1;
  const showWrapNudge = !!episode && turns.length > 0 && (
    ((pressure === 'warn' || pressure === 'escalate') && (nudgeDismissedAtChars === 0 || pressurePastDismiss))
    || locationShiftNudge
  );

  useEffect(() => {
    setSceneFadeKey((k) => k + 1);
  }, [episode?.image, mood, episode?.locationId]);

  useEffect(() => {
    if (!readMode) {
      setComposerOpen(true);
      setHudTucked(false);
      setComposeMore(false);
    } else {
      setComposerOpen(false);
      setComposeMore(false);
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

  // Reset nudge baseline when the active episode changes.
  useEffect(() => {
    setNudgeDismissedAtChars(0);
    setNudgeDismissedLocId(episode?.locationId ?? null);
  }, [episode?.id]);

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
  }, [turns.length, partial]);

  const pinMood = (id: typeof mood) => {
    setMood(id);
    if (episode) {
      void safeWrite(
        () => db.episodes.update(episode.id, { moodPinned: true, updatedAt: Date.now() }),
        () => undefined
      );
    }
  };

  const dismissWrapNudge = () => {
    setNudgeDismissedAtChars(episodeChars);
    setNudgeDismissedLocId(episode?.locationId ?? null);
  };

  /** Shared streaming runner behind write / rewrite / retry / continue-plan. */
  const runNarration = async (
    mode: ComposeMode,
    text: string,
    resumeBeats?: DirectorBeat[],
    lengthOverride?: TurnLength
  ): Promise<{ status: 'ok' | 'error' | 'aborted'; beatsCompleted: number }> => {
    if (!world || !season || !episode) return { status: 'error', beatsCompleted: 0 };
    setError('');
    setNotice('');
    setStreaming(true);
    setPartial('');
    setPartialMeta({ role: 'narrator' });
    setProgressLabel(resumeBeats?.length ? 'continuing plan…' : 'planning…');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await writeTurn({
        world, season, episode, mode, input: text, length: lengthOverride ?? length,
        resumeBeats,
        preferCharacterId:
          isPlayerAgencyMode(mode) && preferSpeaker?.kind === 'cast'
            ? preferSpeaker.id
            : undefined,
        preferGuestId:
          isPlayerAgencyMode(mode) && preferSpeaker?.kind === 'guest'
            ? preferSpeaker.id
            : undefined,
        signal: controller.signal,
        onProgress: setProgressLabel,
        onNotice: setNotice,
        onDelta: (p, meta) => {
          setPartialMeta(meta);
          setPartial(p);
        }
      });
      setPartial('');
      return { status: 'ok', beatsCompleted: 1 };
    } catch (e) {
      setPartial('');
      if (e instanceof WriteAbortedError || (e as Error).name === 'AbortError') {
        const n = e instanceof WriteAbortedError ? e.beatsCompleted : 0;
        const left = e instanceof WriteAbortedError ? e.remainingBeats.length : 0;
        setNotice(
          n === 0
            ? 'Stopped before any reply — your line was not applied.'
            : left > 0
              ? `Stopped after ${n} line${n === 1 ? '' : 's'} — ${left} left in the plan. Use Continue plan to finish.`
              : `Stopped after ${n} line${n === 1 ? '' : 's'}; incomplete line discarded.`
        );
        return { status: 'aborted', beatsCompleted: n };
      }
      const n = typeof e === 'object' && e && 'beatsCompleted' in e
        ? Math.max(0, Number((e as { beatsCompleted: number }).beatsCompleted) || 0)
        : 0;
      setError(classifyError(e));
      if (n > 0) {
        setNotice(`${n} line${n === 1 ? '' : 's'} saved — Continue plan if lines remain, or retry from the last reply.`);
      }
      return { status: 'error', beatsCompleted: n };
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
      setNotice('Add a writing model in Settings first.');
      return;
    }
    if (writeReady && writeReady.missing.length > 0 && !writeAnyway) {
      setNotice('Fix the checklist above, or press Write anyway.');
      return;
    }
    if (composeMode !== 'continue' && !input.trim()) return;
    const sceneNpcs = characters.filter((c) => episode.castIds.includes(c.id) && !c.isPlayer);
    const epGuests = episode.guests ?? [];
    const activeGuests = episode.activeGuestIds == null
      ? epGuests
      : epGuests.filter((g) => episode.activeGuestIds!.includes(g.id));
    if (agencyOn && sceneNpcs.length === 0 && activeGuests.length === 0) {
      setNotice('Add someone to this scene on Cast, or open Direct.');
      return;
    }
    const tagged = agencyOn
      ? applyDeliveryTone(input, deliveryTone)
      : input;
    const text = tagged;
    const savedTone = deliveryTone;
    setInput('');
    if (deliveryTone) {
      try { localStorage.setItem('sw-last-delivery-tone', deliveryTone); } catch { /* ignore */ }
    }
    // Keep Speak/Act/Steer so back-and-forth RP does not need re-tapping mode.
    // Delivery tone stays selected for the next line unless the player clears it.
    const result = await runNarration(composeMode, text);
    if (result.status !== 'ok' && result.beatsCompleted === 0) {
      // Restore composer when nothing was applied (orphan user turn removed).
      setInput(parseDeliveryTone(text).body);
      setDeliveryTone(savedTone);
    }
  };

  const continuePlan = async () => {
    if (!world || !season || !episode || streaming) return;
    const pending = episode.pendingPlan;
    if (!pending?.beats?.length) return;
    await runNarration('continue', '', pending.beats as DirectorBeat[], pending.length);
  };

  const rerollBeat = async (turn: Turn) => {
    if (!world || !season || !episode || streaming) return;
    if (turn.role !== 'narrator' && turn.role !== 'character') return;
    setError('');
    setNotice('');
    setStreaming(true);
    setPartial('');
    setPartialMeta({
      role: turn.role === 'narrator' ? 'narrator' : 'character',
      characterId: turn.characterId,
      guestId: turn.guestId
    });
    setProgressLabel('re-rolling…');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await regenerateBeat({
        world, season, episode, turn, length,
        signal: controller.signal,
        onProgress: setProgressLabel,
        onDelta: (p, meta) => {
          setPartialMeta(meta);
          setPartial(p);
        }
      });
      setPartial('');
      setNotice('Beat re-rolled. Mid-episode summary was cleared.');
    } catch (e) {
      setPartial('');
      if (e instanceof WriteAbortedError || (e as Error).name === 'AbortError') {
        setNotice('Re-roll stopped.');
      } else {
        setError(classifyError(e));
      }
    } finally {
      setStreaming(false);
      setProgressLabel('');
      abortRef.current = null;
    }
  };

  const pickBaseMode = (m: 'continue' | 'steer') => {
    setComposeBase(m);
    setSpeakOn(false);
    setActOn(false);
    setDeliveryTone(null);
    setPreferSpeaker(null);
  };

  const toggleSpeak = () => {
    const next = !speakOn;
    setSpeakOn(next);
    if (!next && !actOn) {
      setDeliveryTone(null);
      setPreferSpeaker(null);
    }
  };

  const toggleAct = () => {
    const next = !actOn;
    setActOn(next);
    if (!next && !speakOn) {
      setDeliveryTone(null);
      setPreferSpeaker(null);
    }
  };

  /** Steer from Director nudge — exclusive base mode. */
  const setComposeModeSafe = (m: ComposeMode) => {
    if (m === 'steer' || m === 'continue') {
      pickBaseMode(m);
      return;
    }
    if (m === 'speak') {
      setSpeakOn(true);
      setActOn(false);
      return;
    }
    if (m === 'act') {
      setActOn(true);
      setSpeakOn(false);
      return;
    }
    if (m === 'play') {
      setSpeakOn(true);
      setActOn(true);
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

  /** Delete everything after a turn, keeping the turn itself. */
  const deleteBelow = async (turn: Turn) => {
    if (!episode || streaming) return;
    const idx = turns.findIndex((t) => t.id === turn.id);
    const below = turns.length - idx - 1;
    if (idx < 0 || below === 0) return;
    const snapshot = await snapshotTurnsAfter(turn.id, episode.id);
    await deleteTurnsAfter(turn.id, episode.id);
    if (snapshot.length > 0) {
      await recordTombstones(snapshot.map((t) => ({
        table: 'turns' as const,
        id: t.id,
        worldId: t.worldId,
        episodeId: t.episodeId,
        payload: t
      })));
    }
  };

  const deleteTurn = async (turn: Turn) => {
    await recordTombstones([{
      table: 'turns', id: turn.id, worldId: turn.worldId, episodeId: turn.episodeId, payload: turn
    }]);
    await db.turns.delete(turn.id);
    if (turn.episodeId) await clearEpisodeRunningSummary(turn.episodeId);
  };

  const runConfirmAsk = () => {
    if (!confirmAsk) return;
    const ask = confirmAsk;
    setConfirmAsk(null);
    if (ask.kind === 'reroll') void rerollBeat(ask.turn);
    else if (ask.kind === 'delete') void deleteTurn(ask.turn);
    else if (ask.kind === 'retryFrom') void retryFrom(ask.turn);
    else void deleteBelow(ask.turn);
  };

  const dismissReadCoach = () => {
    setShowReadCoach(false);
    try { localStorage.setItem('sw-read-coach', '1'); } catch { /* ignore */ }
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
    setNudgeDismissedAtChars(0);
    setNudgeDismissedLocId(null);
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
      const filed = 'Episode filed · next episode is open.';
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
      setNotice('Episode filed · next episode is open.');
    } catch (e) {
      setError(classifyError(e));
    } finally {
      wrapBusyRef.current = false;
      setWrapBusy(false);
    }
  };

  const blocks = useMemo(() => {
    const guestList = episode?.guests ?? [];
    const out: { turn: Turn; blocks: ProseBlock[] }[] = [];
    for (const t of turns) out.push({ turn: t, blocks: parseTurn(t, characters, guestList) });
    return out;
  }, [turns, characters, episode?.guests]);

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
        <Mono>episode filed</Mono>
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
          <button className="btn-ghost" onClick={() => go('sequel')}>Season review</button>
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
  const composerPlaceholder: Record<ComposeMode, string> = {
    continue: 'Press write on — the narrator takes the next beat from here.',
    steer: 'Tell the narrator what should happen, in your words. Everyone stays in character while it happens.',
    speak: '*smiles* "Hello." — looks and gestures in *stars*, spoken words in quotes.',
    act: 'You do something. No dialogue, no narration from you.',
    play: '*opens the door* "Anyone home?" — gesture in *stars*, words in quotes.'
  };
  const directorContent = (
    <DirectorContent
      world={world} season={season} episode={episode} characters={characters} locations={locations}
      continuity={continuity} threads={threads} accent={ACCENT} narrow={narrow}
      onGoLocations={goLocations}
      onGoCast={goCast}
      onNudge={(text) => { setComposeModeSafe('steer'); setInput(text); setDirectorSheet(false); setComposerOpen(true); }}
    />
  );

  const shellHeight = '100%';
  const locLabel = (activeLocation?.name || episode.location || '')
    .split(',')[0].split('.')[0].toLowerCase();
  const climateLine = (episode.atmosphereNote || activeLocation?.atmosphere || '')
    .split(/[.\n]/)[0].trim();
  // Chapter head: where and when this episode opens, in reading order rather than chrome.
  const sceneDate = formatStoryDate(
    worldCalendar(world),
    episode.storyDay && episode.storyDay > 0 ? episode.storyDay : worldCalendar(world).currentDay
  );
  const stageCast = inScene;
  const stageGuests = episode.activeGuestIds == null
    ? guests
    : guests.filter((g) => episode.activeGuestIds!.includes(g.id));
  const scrollBg = resolveScrollBackdrop({
    mode: display.scrollBackdrop,
    episodeImage: episode.image,
    locationPortrait: activeLocation?.portrait
  });
  const scrollPhoto = scrollBg.kind === 'image' ? scrollBg.src : null;

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
      {/* backdrop — the room fills the frame, under dim-wash glass */}
      {scrollPhoto ? (
        <>
          <div
            key={`img-${sceneFadeKey}-${scrollPhoto.slice(0, 24)}`}
            className={display.imageBlur > 0 ? 'scene-crossfade' : 'scene-crossfade scene-backdrop-drift'}
            style={{
              position: 'absolute', inset: 0, zIndex: 0,
              backgroundImage: `url(${JSON.stringify(scrollPhoto)})`, backgroundSize: 'cover', backgroundPosition: 'center',
              filter: display.imageBlur > 0 ? `blur(${display.imageBlur}px)` : undefined,
              transform: display.imageBlur > 0 ? 'scale(1.06)' : undefined
            }}
          />
          <div style={{
            position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none',
            background: `rgba(8,9,12,${(display.imageDim / 100).toFixed(2)})`,
            transition: 'background 0.35s ease'
          }} />
        </>
      ) : (
        <div
          key={`mood-${sceneFadeKey}`}
          className="scene-crossfade"
          style={{
            position: 'absolute', inset: 0, zIndex: 0,
            background: `linear-gradient(160deg, ${BD.a}, ${BD.b})`,
            opacity: scrollBg.kind === 'off' ? 0 : backdrop === 'none' ? 0.28 : 1,
            transition: 'opacity 0.45s ease'
          }}
        />
      )}
      <div
        className="scene-room-vignette"
        style={{ position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none' }}
      />
      {scrollBg.kind !== 'off' && (
        <>
          <div
            key={`tint-${mood}`}
            style={{
              position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none',
              background: M.tint,
              transition: 'background 0.45s ease'
            }}
          />
          <div
            className={`climate-layer climate-${mood}`}
            style={{ position: 'absolute', inset: 0, zIndex: 1 }}
          />
        </>
      )}

      {readMode && hudTucked && !composerOpen && (
        <div
          className="scene-hud-hotzone"
          onMouseEnter={() => setHudTucked(false)}
          onClick={() => setHudTucked(false)}
          aria-hidden
        />
      )}

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
              <div className="serif" style={{ fontSize: 13, fontStyle: 'italic', color: 'rgba(230,233,235,0.55)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
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
                  onClick={() => setDirectorSheet(true)}>Direct</button>
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
          borderBottom: '1px solid rgba(255,255,255,0.08)',
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
                Season {season.number} · episode {episode.number}{locLabel ? ` · ${locLabel}` : ''} · {formatStoryDate(worldCalendar(world), worldCalendar(world).currentDay)} · {M.label}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10, overflow: 'hidden', background: 'rgba(255,255,255,0.05)' }}>
              {([['write', 'Write'], ['read', 'Read']] as const).map(([id, label]) => (
                <button key={id} onClick={() => setLayout(id as StoryLayout)} style={{
                  border: 0, background: layout === id ? 'rgba(255,255,255,0.14)' : 'transparent',
                  color: 'inherit', opacity: layout === id ? 1 : 0.55, padding: '7px 12px',
                  fontSize: 12, fontWeight: 600, cursor: 'pointer', minHeight: 36
                }}>{label}</button>
              ))}
            </div>
            {!short && (
              <>
                <button className="btn-ghost" style={{ padding: '7px 12px', fontSize: 11, minHeight: 36 }} onClick={() => setDirectorSheet(true)}>Direct</button>
                <button className="btn-ghost" style={{ padding: '7px 12px', fontSize: 11, minHeight: 36 }} onClick={() => setWrapOpen('episode')}>End episode</button>
              </>
            )}
            {short ? (
              <button className="btn-ghost" style={{ padding: '7px 12px', fontSize: 11, minHeight: 36 }} onClick={() => setMoreSheet(true)}>More</button>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', maxWidth: '100%', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10, padding: '6px 9px' }} className="glass-clear">
                    <span className="label" style={{ fontSize: 11, opacity: 0.55 }}>Scroll</span>
                    {SCROLL_BACKDROPS.map((id) => (
                      <Chip key={id} active={display.scrollBackdrop === id} onClick={() => setDisplay({ scrollBackdrop: id })}>
                        {SCROLL_BACKDROP_LABEL[id]}
                      </Chip>
                    ))}
                  </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10, padding: '6px 9px', background: 'rgba(255,255,255,0.05)', maxWidth: '100%' }}>
                  <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', opacity: 0.45 }}>
                    mood{episode.moodPinned ? ' · pinned' : ''}
                  </span>
                  {(Object.entries(MOODS) as Array<[typeof mood, typeof M]>).map(([id, m]) => (
                    <button key={id} type="button" title={m.label} onClick={() => pinMood(id)} aria-label={m.label} style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                      height: 22, padding: '0 6px', borderRadius: 2, cursor: 'pointer',
                      background: mood === id ? m.accent : 'transparent',
                      border: `1px solid ${mood === id ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.14)'}`,
                      opacity: mood === id ? 1 : 0.55, color: mood === id ? '#0a1416' : 'rgba(230,233,235,0.7)',
                      fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, letterSpacing: '0.04em'
                    }}>
                      <span style={{ width: 8, height: 8, borderRadius: 1, background: m.accent, flexShrink: 0 }} />
                      {m.label}
                    </button>
                  ))}
                </div>
                <button className="btn-ghost" style={{ padding: '8px 14px' }} onClick={() => setDisplayOpen(true)}>Display</button>
                <button className="btn-ghost" style={{ padding: '8px 14px' }} onClick={() => setWorldEditOpen(true)}>Edit world</button>
              </>
            )}
          </div>
        </div>
      )}

      {/* body — single column; Director is always a sheet overlay */}
      <div style={{
        position: 'relative', zIndex: 2, flex: 1, display: 'grid', minHeight: 0,
        gridTemplateColumns: 'minmax(0, 1fr)'
      }}>
        <section ref={scrollRef} style={{ overflow: 'auto', display: 'flex', flexDirection: 'column', position: 'relative' }}>
          {readMode && showReadCoach && (
            <div className="glass-nudge" style={{ margin: narrow ? '12px 16px 0' : '16px 28px 0', display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, lineHeight: 1.55, color: 'rgba(236,234,230,0.78)' }}>
                End episode and Direct are in this bar. Switch to Write to compose. Turn tools appear when you hover a line.
              </div>
              <button type="button" className="btn-quiet" style={{ fontSize: 11 }} onClick={dismissReadCoach}>Got it</button>
            </div>
          )}
          {climateLine && (
            <div className="climate-breath" style={{
              padding: narrow ? '18px 20px 0' : '22px 28px 0',
              fontSize: narrow ? 14 : 16
            }}>
              {climateLine}
            </div>
          )}

          <div
            className={`page-plane glass-scroll${readMode && display.textScrim > 0 ? ' read-scrim' : ''}`}
            style={{
              maxWidth: '40rem',
              margin: readMode ? '8px auto 28px' : '8px auto 18px',
              width: 'calc(100% - 24px)',
              padding: narrow
                ? (readMode ? '28px 22px 48px' : '22px 18px 40px')
                : (readMode ? '40px 36px 80px' : '32px 32px 68px'),
              ...(readMode && display.textScrim > 0
                ? { ['--text-scrim' as string]: (display.textScrim / 100).toFixed(2) }
                : !readMode && display.textScrim > 0
                  ? {
                    background: `linear-gradient(180deg, rgba(8,9,12,${(display.textScrim / 100 * 0.35).toFixed(2)}), rgba(8,9,12,${(display.textScrim / 100).toFixed(2)}) 16%, rgba(8,9,12,${(display.textScrim / 100).toFixed(2)}) 84%, rgba(8,9,12,${(display.textScrim / 100 * 0.4).toFixed(2)}))`
                  }
                  : {})
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
                    letterSpacing: '0.16em',
                    textTransform: 'uppercase',
                    color: 'rgba(230,233,235,0.42)',
                    fontWeight: 500
                  }}>
                    Season {numberWord(season.number)} · episode {numberWord(episode.number)}
                  </div>
                  <div className="serif" style={{
                    fontSize: narrow ? 26 : 32,
                    fontWeight: 300,
                    lineHeight: 1.2,
                    margin: '12px 0 0',
                    color: '#f4f0e8'
                  }}>
                    {episode.title.trim() || activeLocation?.name || episode.location || 'Untitled scene'}
                  </div>
                  {sceneDate && (
                    <div className="serif" style={{
                      marginTop: 10, fontSize: 15, lineHeight: 1.55, fontStyle: 'italic',
                      color: 'rgba(230,233,235,0.52)'
                    }}>
                      {sceneDate}
                    </div>
                  )}
                </>
              ) : (
                <div className="serif" style={{
                  fontSize: 14, fontStyle: 'italic', lineHeight: 1.45,
                  color: 'rgba(230,233,235,0.42)'
                }}>
                  {episode.title.trim() || activeLocation?.name || episode.location}
                  {sceneDate ? ` · ${sceneDate}` : ''}
                </div>
              )}
                </div>
              </div>
              {(stageCast.length > 0 || stageGuests.length > 0) && (
                <button
                  type="button"
                  onClick={() => setDirectorSheet(true)}
                  className="serif"
                  style={{
                    display: 'block',
                    marginTop: turns.length === 0 ? 14 : 8,
                    padding: 0,
                    border: 0,
                    background: 'transparent',
                    cursor: 'pointer',
                    fontSize: 13.5,
                    fontStyle: 'italic',
                    color: 'rgba(230,233,235,0.38)',
                    textAlign: 'left'
                  }}
                >
                  {[
                    ...stageCast.map((c) => c.name || 'unnamed'),
                    ...stageGuests.map((g) => g.name)
                  ].join(' · ')}
                </button>
              )}
              {turns.length === 0 && (
                <div style={{
                  height: 1, marginTop: 22,
                  background: 'linear-gradient(90deg, rgba(236,228,214,0.22), rgba(255,255,255,0.05) 48%, transparent)'
                }} />
              )}
            </header>

            {season.bible && turns.length === 0 && (
              <div style={{ marginBottom: 32 }}>
                <div className="serif" style={{
                  fontSize: 11, letterSpacing: '0.16em', textTransform: 'uppercase',
                  color: 'rgba(230,233,235,0.38)', marginBottom: 10
                }}>
                  Previously
                </div>
                <p className="serif" style={{
                  fontSize: fontPx, lineHeight: 1.82, margin: 0, fontStyle: 'italic',
                  color: 'rgba(236,234,230,0.62)', textWrap: 'pretty'
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
                    color: 'rgba(236,234,230,0.55)', textWrap: 'pretty'
                  }}>
                    {season.premise}
                  </p>
                ) : (
                  <p className="serif" style={{
                    fontSize: fontPx, lineHeight: 1.82, margin: 0, fontWeight: 300,
                    color: 'rgba(236,234,230,0.5)'
                  }}>
                    The page is blank. Write on, and the narrator takes the first beat.
                  </p>
                )}
                {!(activeLocation?.name || episode.location) && (
                  <div className="label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="seed-mark" />
                    No place linked yet
                  </div>
                )}
                {writeReady && writeReady.missing.length > 0 && !writeAnyway && (
                  <div style={{
                    border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, padding: '12px 14px',
                    background: 'rgba(255,255,255,0.04)', display: 'flex', flexDirection: 'column', gap: 10
                  }}>
                    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.55, color: 'rgba(236,234,230,0.78)' }}>
                      {writeReady.missing.map((m) => (
                        <li key={m}>{m}</li>
                      ))}
                    </ul>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button className="btn-ghost" style={{ fontSize: 11, padding: '7px 12px' }}
                        onClick={() => setWorldEditOpen(true)}>Edit world</button>
                      <button className="btn-ghost" style={{ fontSize: 11, padding: '7px 12px' }}
                        onClick={goCast}>Cast</button>
                      <button className="btn-ghost" style={{ fontSize: 11, padding: '7px 12px' }}
                        onClick={goLocations}>Places</button>
                      <button className="btn-quiet" style={{ fontSize: 11 }}
                        onClick={() => setWriteAnyway(true)}>Write anyway</button>
                    </div>
                  </div>
                )}
                {writeReady && writeReady.warnings.length > 0 && (writeAnyway || writeReady.missing.length === 0) && (
                  <div style={{ fontSize: 12, lineHeight: 1.5, color: 'rgba(200,230,235,0.75)' }}>
                    {writeReady.warnings[0]}
                  </div>
                )}
                {(!hasAI || (writeReady && writeReady.missing.length > 0 && !writeAnyway)) && (
                <p style={{ fontSize: 14, margin: 0, color: 'rgba(236,234,230,0.78)' }}>
                  {!hasAI
                    ? 'Add a writing model in Settings before Write on.'
                    : 'Fix the checklist above, or press Write anyway, then Write on.'}
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
                          setProgressLabel('drafting cold open…');
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
                      ✦ Draft cold open
                    </button>
                  )}
                  {!hasAI && (
                    <button className="btn-ghost" style={{ fontSize: 12, padding: '7px 12px' }}
                      onClick={() => go('settings')}>
                      Add a writing model in Settings
                    </button>
                  )}
                  <button className="btn-ghost" style={{ fontSize: 12, padding: '7px 12px' }} onClick={() => setDirectorSheet(true)}>
                    Open Direct
                  </button>
                  {(continuity.length > 0 || threads.length > 0) && (
                    <span className="label" style={{ opacity: 0.5 }}>
                      {continuity.length} fact{continuity.length === 1 ? '' : 's'} · {threads.length} thread{threads.length === 1 ? '' : 's'}
                    </span>
                  )}
                </div>
              </div>
            )}

            {blocks.length > turnWindow && (
              <div style={{ margin: '0 0 28px', textAlign: 'center' }}>
                <button
                  type="button"
                  onClick={() => setTurnWindow((n) => n + 60)}
                  className="serif"
                  title={`${blocks.length - turnWindow} earlier turns`}
                  style={{
                    border: 0, background: 'transparent', cursor: 'pointer',
                    fontSize: 14, fontStyle: 'italic', color: 'rgba(230,233,235,0.42)',
                    padding: '6px 8px'
                  }}
                >
                  · · · earlier pages · · ·
                </button>
              </div>
            )}

            {blocks.slice(-turnWindow).map(({ turn, blocks: bs }, ti, visible) => (
              <TurnRow
                key={turn.id}
                turn={turn}
                blocks={bs}
                characters={characters}
                accent={M.accent}
                prose={M.prose}
                fontPx={fontPx}
                avatarPx={avatarPx}
                dialogueStyle={display.dialogueStyle}
                prevSpeaker={ti > 0 ? lastSpokenBy(visible[ti - 1].blocks) : null}
                streaming={streaming}
                hasBelow={ti < visible.length - 1 || streaming}
                opening={blocks.length <= turnWindow && ti === 0}
                onRetry={() => {
                  const idx = turns.findIndex((t) => t.id === turn.id);
                  const below = idx < 0 ? 0 : turns.length - idx - 1;
                  if (below > 0) setConfirmAsk({ kind: 'retryFrom', turn });
                  else void retryFrom(turn);
                }}
                onReroll={
                  turn.role === 'narrator' || turn.role === 'character'
                    ? () => setConfirmAsk({ kind: 'reroll', turn })
                    : undefined
                }
                onDeleteBelow={() => setConfirmAsk({ kind: 'deleteBelow', turn })}
                onDelete={() => setConfirmAsk({ kind: 'delete', turn })}
              />
            ))}

            {streaming && partial && (
              parseTurn({
                id: 'partial',
                episodeId: episode.id,
                worldId: world.id,
                role: partialMeta.role,
                mode: null,
                characterId: partialMeta.characterId,
                guestId: partialMeta.guestId,
                text: partialMeta.role === 'character' ? previewSpeakText(partial) : partial,
                createdAt: 0
              }, characters, guests)
                .map((b, i, arr) => (
                  <ProseBlockView
                    key={`p${i}`}
                    b={b}
                    accent={M.accent}
                    prose={M.prose}
                    fontPx={fontPx}
                    avatarPx={avatarPx}
                    dialogueStyle={display.dialogueStyle}
                    opening={turns.length === 0 && i === 0}
                    fromPlayer={partialMeta.role === 'user'}
                    caret={i === arr.length - 1}
                  />
                ))
            )}

            {streaming && !partial && (
              <p className="serif" style={{
                fontSize: fontPx, lineHeight: 1.82, margin: '0.4em 0 0',
                fontStyle: 'italic', color: 'rgba(230,233,235,0.42)'
              }}>
                {progressLabel || 'the scene turns'}
                <span className="prose-caret" aria-hidden />
              </p>
            )}

            {!streaming && input.trim() && composeMode !== 'continue' && (
              <div style={{ opacity: 0.46, marginTop: 10 }}>
                {parseTurn({
                  id: 'ghost',
                  episodeId: episode.id,
                  worldId: world.id,
                  role: 'user',
                  mode: composeMode,
                  text: agencyOn ? applyDeliveryTone(input, deliveryTone) : input,
                  createdAt: 0
                }, characters, guests).map((b, i, arr) => (
                  <ProseBlockView
                    key={`g${i}`}
                    b={b}
                    accent={M.accent}
                    prose={M.prose}
                    fontPx={fontPx}
                    avatarPx={avatarPx}
                    dialogueStyle={display.dialogueStyle}
                    fromPlayer
                    caret={i === arr.length - 1}
                  />
                ))}
              </div>
            )}

          </div>
        </section>
      </div>

      {(confirmAsk || error || notice || ((episode.pendingPlan?.beats?.length ?? 0) > 0 && !streaming)) && (
        <div style={{
          position: 'relative', zIndex: 3,
          padding: narrow ? '10px 12px 0' : '12px 24px 0',
          display: 'flex', flexDirection: 'column', gap: 10
        }}>
          {confirmAsk && (
            <ConfirmBar
              title={
                confirmAsk.kind === 'reroll'
                  ? 'Re-roll this line only?'
                  : confirmAsk.kind === 'deleteBelow'
                    ? 'Delete the turns below this one?'
                    : confirmAsk.kind === 'retryFrom'
                      ? (confirmAsk.turn.role === 'narrator' || confirmAsk.turn.role === 'character'
                        ? 'Rewrite this response?'
                        : 'Retry from here?')
                      : 'Delete this turn?'
              }
              body={
                confirmAsk.kind === 'reroll'
                  ? 'Later turns stay. This line is rewritten in place.'
                  : confirmAsk.kind === 'deleteBelow'
                    ? 'This cannot be undone.'
                    : confirmAsk.kind === 'retryFrom'
                      ? 'Turns after this one will be replaced. This cannot be undone.'
                      : 'Turns after it are kept. This cannot be undone.'
              }
              confirmLabel={
                confirmAsk.kind === 'reroll' ? 'Re-roll'
                  : confirmAsk.kind === 'retryFrom' ? 'Rewrite'
                    : 'Delete'
              }
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
              <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'rgba(200,230,235,0.95)', flex: 1, minWidth: 0 }}>{notice}</div>
              <button className="btn-quiet" style={{ fontSize: 11, minHeight: 28 }}
                onClick={() => {
                  setNotice('');
                  go(notice === 'Add someone to this scene on Cast, or open Direct.' ? 'cast' : 'sequel');
                }}>
                {notice === 'Add someone to this scene on Cast, or open Direct.' ? 'Open Cast' : 'Season review'}
              </button>
              <button className="btn-quiet" style={{ padding: '0 2px', fontSize: 14 }} onClick={() => setNotice('')}>×</button>
            </div>
          )}
          {(episode.pendingPlan?.beats?.length ?? 0) > 0 && !streaming && (
            <div className="glass-nudge" style={{
              display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap'
            }}>
              <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'rgba(236,234,230,0.8)', flex: 1, minWidth: 0 }}>
                <div>
                  {episode.pendingPlan!.beats.length} line{episode.pendingPlan!.beats.length === 1 ? '' : 's'} left in the plan
                  {episode.pendingPlan!.length
                    ? ` · resume as ${TURN_LENGTH_LABELS[episode.pendingPlan!.length]}`
                    : ''}.
                </div>
                <ul style={{ margin: '8px 0 0', paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {episode.pendingPlan!.beats.slice(0, 3).map((beat, i) => (
                    <li key={i} style={{ opacity: 0.85 }}>{pendingBeatLabel(beat, characters, guests)}</li>
                  ))}
                  {episode.pendingPlan!.beats.length > 3 && (
                    <li style={{ opacity: 0.55 }}>
                      and {episode.pendingPlan!.beats.length - 3} more
                    </li>
                  )}
                </ul>
              </div>
              <button className="btn-primary" style={{ padding: '7px 12px', fontSize: 12, minHeight: 40 }}
                onClick={() => void continuePlan()}>Continue plan</button>
              <button className="btn-quiet" style={{ fontSize: 11 }} onClick={() => void safeWrite(async () => {
                await db.episodes.update(episode.id, { pendingPlan: null, updatedAt: Date.now() });
              })}>Dismiss</button>
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
          {showWrapNudge && (
            <div className="glass-nudge" style={{
              width: '100%',
              display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
              background: pressure === 'escalate' ? ACCENT_RGBA.a12 : undefined
            }}>
              <div style={{ flex: 1, minWidth: narrow ? 0 : 200, fontSize: 12.5, lineHeight: 1.55, color: 'rgba(236,234,230,0.78)' }}>
                {pressure === 'escalate'
                  ? 'This chapter is getting long. Close it so the season can move — facts from play are already on file.'
                  : locationShiftNudge && (pressure === 'ok' || pressure === 'warm')
                    ? 'The scene moved. Close the chapter when you are ready; memory from play is already on file.'
                    : 'This chapter is getting long. Close it so the season can move.'}
              </div>
              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                <button className="btn-primary" style={{ padding: '7px 12px', fontSize: 12 }}
                  disabled={wrapBusy} onClick={() => setWrapOpen('episode')}>End episode</button>
                <button className="btn-quiet" style={{ fontSize: 11 }} onClick={dismissWrapNudge}>Not yet</button>
              </div>
            </div>
          )}
          <button
            onClick={() => { setComposerOpen(true); setHudTucked(false); }}
            className="serif"
            style={{
              border: 0, background: 'transparent',
              color: 'inherit', padding: '10px 18px', cursor: 'pointer',
              fontSize: 16, fontStyle: 'italic', opacity: 0.7
            }}
          >
            Continue
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
          {showWrapNudge && (
            <div className="glass-nudge" style={{
              display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
              background: pressure === 'escalate' ? ACCENT_RGBA.a12 : undefined
            }}>
              <div style={{ flex: 1, minWidth: narrow ? 0 : 200, fontSize: 12.5, lineHeight: 1.55, color: 'rgba(236,234,230,0.78)' }}>
                {pressure === 'escalate'
                  ? 'This chapter is getting long. Close it so the season can move — facts from play are already on file.'
                  : locationShiftNudge && (pressure === 'ok' || pressure === 'warm')
                    ? 'The scene moved. Close the chapter when you are ready; memory from play is already on file.'
                    : 'This chapter is getting long. Close it so the season can move.'}
              </div>
              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                <button className="btn-primary" style={{ padding: '7px 12px', fontSize: 12 }}
                  disabled={wrapBusy} onClick={() => setWrapOpen('episode')}>End episode</button>
                <button className="btn-quiet" style={{ fontSize: 11 }} onClick={dismissWrapNudge}>Not yet</button>
              </div>
            </div>
          )}
          {(!readMode || composeMore) && (
          <>
          <div style={{
            display: 'grid',
            gridTemplateColumns: compact ? 'repeat(2, minmax(0, 1fr))' : 'repeat(4, minmax(0, 1fr))',
            gap: 0,
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 4,
            overflow: 'hidden',
            background: 'rgba(255,255,255,0.03)'
          }}>
            {([
              { id: 'continue' as const, label: 'Continue', active: !agencyOn && composeBase === 'continue', onClick: () => pickBaseMode('continue') },
              { id: 'steer' as const, label: 'Steer', active: !agencyOn && composeBase === 'steer', onClick: () => pickBaseMode('steer') },
              { id: 'speak' as const, label: 'Speak', active: speakOn, onClick: () => toggleSpeak() },
              { id: 'act' as const, label: 'Act', active: actOn, onClick: () => toggleAct() }
            ]).map((m, i, arr) => (
              <button
                key={m.id}
                type="button"
                onClick={m.onClick}
                style={{
                  border: 0,
                  borderRight: i < arr.length - 1 ? '1px solid rgba(255,255,255,0.08)' : 0,
                  minHeight: 44,
                  padding: '8px 4px',
                  fontSize: compact ? 12 : 13,
                  fontWeight: m.active ? 600 : 500,
                  cursor: 'pointer',
                  color: m.active ? '#0a1416' : 'rgba(230,233,235,0.65)',
                  background: m.active ? ACCENT : 'transparent',
                  boxShadow: m.active ? `inset 0 -2px 0 ${ACCENT_RGBA.a55}` : 'none'
                }}
              >
                {m.label}
              </button>
              ))}
            </div>
          {composeMode === 'play' && (
            <Mono style={{ fontSize: 10, opacity: 0.55 }}>Play · you speak and act in one move</Mono>
          )}
          {agencyOn && (
            <DeliveryPicker value={deliveryTone} onChange={setDeliveryTone} />
          )}
          {agencyOn && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span
                style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', opacity: 0.45 }}
                title="Who should answer your line"
              >
                reply from
              </span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <Chip
                  active={preferSpeaker === null}
                  onClick={() => setPreferSpeaker(null)}
                >
                  Anyone
                </Chip>
                {inScene.filter((c) => !c.isPlayer).map((c) => (
                  <Chip
                    key={c.id}
                    active={preferSpeaker?.kind === 'cast' && preferSpeaker.id === c.id}
                    onClick={() => setPreferSpeaker(
                      preferSpeaker?.kind === 'cast' && preferSpeaker.id === c.id
                        ? null
                        : { kind: 'cast', id: c.id }
                    )}
                  >
                    {c.name}
                  </Chip>
                ))}
                {(episode.activeGuestIds == null
                  ? guests
                  : guests.filter((g) => episode.activeGuestIds!.includes(g.id))
                ).map((g) => (
                  <Chip
                    key={g.id}
                    active={preferSpeaker?.kind === 'guest' && preferSpeaker.id === g.id}
                    onClick={() => setPreferSpeaker(
                      preferSpeaker?.kind === 'guest' && preferSpeaker.id === g.id
                        ? null
                        : { kind: 'guest', id: g.id }
                    )}
                  >
                    {g.name}
                  </Chip>
                ))}
              </div>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <span
                style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', opacity: 0.45 }}
                title="How long each narration or spoken reply runs — not story structure"
              >
                reply size
              </span>
              {(['beat', 'scene', 'episode'] as const).map((l) => (
                <Chip key={l} active={length === l} onClick={() => setLength(l)}>
                  {TURN_LENGTH_LABELS[l]}
                </Chip>
              ))}
            </div>
          </div>
          </>
          )}
          {readMode && (
            <div style={{ display: 'flex', justifyContent: 'center', gap: 16 }}>
              <button className="btn-quiet" style={{ fontSize: 12, minHeight: 36 }}
                onClick={() => setComposeMore((o) => !o)}>
                {composeMore ? 'Less' : 'More'}
              </button>
              <button className="btn-quiet" style={{ fontSize: 12, minHeight: 36 }}
                onClick={() => setComposerOpen(false)}>
                collapse
              </button>
            </div>
          )}
          {composeMode === 'continue' ? (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16,
              maxWidth: '40rem', margin: '0 auto', width: '100%', padding: '6px 0 2px'
            }}>
              <p className="serif" style={{
                margin: 0, fontSize: narrow ? 16 : 18, fontStyle: 'italic',
                color: 'rgba(230,233,235,0.5)', flex: 1, textAlign: 'center'
              }}>
                the scene continues
              </p>
              {streaming ? (
                <button className="btn-quiet" style={{ minHeight: 44 }} onClick={() => abortRef.current?.abort()}>Stop</button>
              ) : (
                <button
                  className="btn-primary"
                  style={{ padding: '10px 19px', minHeight: 44 }}
                  disabled={writeBlocked}
                  onClick={() => void write()}
                >
                  Write on
                </button>
              )}
            </div>
          ) : (
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
              placeholder={composerPlaceholder[composeMode]}
              rows={2}
              disabled={streaming}
              style={{
                flex: 1, border: 0, background: 'transparent', padding: '4px 0',
                fontFamily: 'Spectral, serif', fontSize: narrow ? 16 : 18, lineHeight: 1.7,
                minHeight: 44
              }}
            />
            {streaming ? (
              <button className="btn-quiet" style={{ alignSelf: 'flex-end', minHeight: 44 }} onClick={() => abortRef.current?.abort()}>Stop</button>
            ) : (
              <button
                className="btn-primary"
                style={{ alignSelf: 'flex-end', padding: '10px 19px', minHeight: 44 }}
                disabled={
                  writeBlocked
                  || (
                    agencyOn
                    && inScene.filter((c) => !c.isPlayer).length === 0
                    && (episode.activeGuestIds == null
                      ? guests.length === 0
                      : guests.filter((g) => episode.activeGuestIds!.includes(g.id)).length === 0)
                  )
                }
                onClick={() => void write()}
              >
                Write on
              </button>
            )}
          </div>
          )}
          {!readMode && (
            <div style={{ display: 'flex', gap: 16, fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, opacity: 0.4, flexWrap: 'wrap' }}>
              <span>memory: {continuity.length} facts · {threads.length} open threads</span>
              {!narrow && <span>{world.ai.mature ? 'adult world · unrestricted' : 'general audience'}</span>}
              {!narrow && <span>{/Mac|iPhone|iPad/i.test(typeof navigator !== 'undefined' ? navigator.platform || navigator.userAgent : '') ? '⌘↵ write on' : 'Ctrl+Enter write on'}</span>}
            </div>
          )}
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
                  'Closing the chapter…'
                ) : (
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 2, lineHeight: 1.25 }}>
                    <span>Close chapter · open episode {episode.number + 1}</span>
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
                Analyze episode
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
              End the episode.
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.6, opacity: 0.62, maxWidth: '48ch', color: '#eceae6' }}>
              {wrapPhase === 'review'
                ? 'Edit the recap and time skip, Keep or Drop anything new or stale, then close the chapter. Facts from play are already on file.'
                : 'The utility model proposes a previously-on recap, how time passed, and only new or stale memory — you review before the next episode opens. Skipping still keeps a short recap.'}
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
            Season review →
          </button>
        </div>

        {error && <ErrorNote error={error} onDismiss={() => setError('')} />}
        {notice && (
          <div style={{
            fontSize: 12.5, lineHeight: 1.5, color: 'rgba(236,234,230,0.85)',
            border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10, padding: '10px 12px',
            background: 'rgba(255,255,255,0.05)', display: 'flex', gap: 10, alignItems: 'flex-start'
          }}>
            <span style={{ flex: 1 }}>{notice}</span>
            <button className="btn-quiet" style={{ fontSize: 11, minHeight: 28 }} onClick={() => setNotice('')}>dismiss</button>
          </div>
        )}

        {wrapPhase === 'analyzing' ? (
          <div style={{ padding: '20px 0' }}>
            <Spinner label="closing the chapter" />
          </div>
        ) : wrapPhase === 'review' && wrapDraft ? (
          <WrapReviewBody draft={wrapDraft} onChange={setWrapDraft} guests={guests} world={world} />
        ) : (
          <>
            <div style={{
              fontSize: 12.5, lineHeight: 1.55, color: 'rgba(236,234,230,0.7)',
              border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12, padding: '12px 14px',
              background: 'rgba(255,255,255,0.04)'
            }}>
              Analyze closes the chapter: previously-on, time skip, next opening, plus Keep/Drop only for new or stale facts and threads
              {guests.length > 0 ? ', and walk-on effects' : ''}. Episode prose stays saved; only the active episode stays in the writing loop.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              <Mono style={{ fontSize: 9 }}>already held in continuity</Mono>
              {continuity.slice(-6).map((f) => (
                <div key={f.id} className="craft-row" style={{ padding: '12px 14px', fontSize: 13, lineHeight: 1.5, color: 'var(--ink-muted)' }}>
                  {f.text}
                </div>
              ))}
              {continuity.length === 0 && (
                <div style={{ fontSize: 12.5, opacity: 0.5, color: '#eceae6' }}>
                  Nothing filed yet — play files facts as the scene unfolds.
                </div>
              )}
            </div>
          </>
        )}
      </Sheet>

      {/* director overlay — cast, places, continuity, threads (all widths) */}
      <Sheet
        open={directorSheet}
        onClose={() => setDirectorSheet(false)}
        narrow={sheetBottom}
        footer={
          <button className="btn-primary" style={{ width: '100%', minHeight: 44 }} onClick={() => setDirectorSheet(false)}>
            Done
          </button>
        }
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="serif" style={{ fontWeight: 300, fontSize: 24, color: 'var(--ink-heading)' }}>Director</div>
          <button className="btn-ghost" aria-label="Close" style={{ width: 44, height: 44, padding: 0, fontSize: 18 }} onClick={() => setDirectorSheet(false)}>×</button>
        </div>
        {directorContent}
      </Sheet>

      {/* narrow overflow: display / edit / mood */}
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
              <button className="btn-ghost" style={{ minHeight: 44, textAlign: 'left' }} onClick={() => { setMoreSheet(false); setDirectorSheet(true); }}>
                Direct
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
          <Mono style={{ fontSize: 11 }}>scroll background</Mono>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {SCROLL_BACKDROPS.map((id) => (
              <Chip key={id} active={display.scrollBackdrop === id} onClick={() => setDisplay({ scrollBackdrop: id })}>
                {SCROLL_BACKDROP_LABEL[id]}
              </Chip>
            ))}
          </div>
          <button className="btn-ghost" style={{ minHeight: 44, textAlign: 'left' }} onClick={() => { setMoreSheet(false); setWorldEditOpen(true); }}>
            Edit world
          </button>
          <button className="btn-ghost" style={{ minHeight: 44, textAlign: 'left' }} onClick={() => { setMoreSheet(false); go('cast'); }}>
            Cast
          </button>
          <button className="btn-ghost" style={{ minHeight: 44, textAlign: 'left' }} onClick={() => { setMoreSheet(false); goLocations(); }}>
            Places
          </button>
          <button className="btn-ghost" style={{ minHeight: 44, textAlign: 'left' }} onClick={() => { setMoreSheet(false); go('profile'); }}>
            Profile
          </button>
          <button className="btn-ghost" style={{ minHeight: 44, textAlign: 'left' }} onClick={() => { setMoreSheet(false); go('sequel'); }}>
            Season review
          </button>
          <Mono style={{ fontSize: 11 }}>mood{episode.moodPinned ? ' · pinned' : ''}</Mono>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {(Object.entries(MOODS) as Array<[typeof mood, typeof M]>).map(([id, m]) => (
              <button key={id} type="button" title={m.label} onClick={() => pinMood(id)} aria-label={m.label} style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                height: 28, padding: '0 10px', borderRadius: 2, cursor: 'pointer',
                background: mood === id ? m.accent : 'rgba(255,255,255,0.04)',
                border: `1px solid ${mood === id ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.12)'}`,
                opacity: mood === id ? 1 : 0.55, color: mood === id ? '#0a1416' : 'rgba(230,233,235,0.75)',
                fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, letterSpacing: '0.04em'
              }}>
                <span style={{ width: 10, height: 10, borderRadius: 1, background: m.accent, flexShrink: 0 }} />
                {m.label}
              </button>
            ))}
          </div>
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
        episode={episode} world={world} locations={locations} characters={characters}
      />
    </div>
  );
}

// ---------- display settings (scene image, text plate, sizes) ----------

function SliderRow({ label, value, min, max, unit, onChange }: {
  label: string; value: number; min: number; max: number; unit?: string; onChange: (v: number) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Mono style={{ fontSize: 9 }}>{label}</Mono>
        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10.5, color: ACCENT }}>
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

function DisplaySheet({ open, onClose, narrow, episode, world, locations, characters }: {
  open: boolean; onClose: () => void; narrow: boolean;
  episode: Episode; world: World; locations: Location[]; characters: Character[];
}) {
  const { display, setDisplay, mood, setMood } = useApp();
  const [imgError, setImgError] = useState('');
  const [imgBusy, setImgBusy] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [note, setNote] = useState(episode.atmosphereNote ?? '');
  const canMatchFaces = sceneHasPortraitRefs(characters, episode.castIds);
  const [matchCast, setMatchCast] = useState(canMatchFaces);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setNote(episode.atmosphereNote ?? ''); }, [episode.id, episode.atmosphereNote]);

  const sceneLoc = locations.find((l) => l.id === episode.locationId)
    ?? locations.find((l) => episode.location && l.name
      && (episode.location.toLowerCase().includes(l.name.toLowerCase())
        || l.name.toLowerCase().includes(episode.location.trim().toLowerCase())));

  const onFile = async (file: File) => {
    setImgBusy(true);
    setImgError('');
    try {
      const image = await fileToSceneImage(file);
      await guardStorage(() => db.episodes.update(episode.id, { image, updatedAt: Date.now() }));
      setDisplay({ scrollBackdrop: 'auto' });
    } catch (e) {
      setImgError(formatUserError(e));
    } finally {
      setImgBusy(false);
    }
  };

  const generateFromLocation = async () => {
    if (!sceneLoc) {
      setImgError('Pick a location card first — generation uses its name, atmosphere, and features.');
      return;
    }
    setGenBusy(true);
    setImgError('');
    try {
      const { provider, model } = imageModelFor(world);
      const refs = collectSceneImageRefs({
        characters, castIds: episode.castIds, location: sceneLoc
      });
      const result = await generateSceneImage({
        provider, model, world, location: sceneLoc,
        atmosphereNote: episode.atmosphereNote,
        matchCast, refs
      });
      await guardStorage(() => db.episodes.update(episode.id, { image: result.dataUrl, updatedAt: Date.now() }));
      if (result.warning) setImgError(result.warning);
      if (display.aiSetsScrollBg) setDisplay({ scrollBackdrop: 'auto' });
    } catch (e) {
      setImgError(formatUserError(e));
    } finally {
      setGenBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} narrow={narrow}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div className="serif" style={{ fontWeight: 300, fontSize: 24, color: 'var(--ink-heading)' }}>Display</div>
          <Mono style={{ fontSize: 9 }}>sizes & plate settings stay on this device · the image stays with the episode</Mono>
        </div>
        <button className="btn-ghost" style={{ width: 30, height: 30, padding: 0, flexShrink: 0 }} onClick={onClose}>×</button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 22, paddingRight: 2 }}>
        {/* atmosphere */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Mono style={{ fontSize: 9 }}>atmosphere for this scene</Mono>
          <div style={{ fontSize: 12, lineHeight: 1.55, color: 'rgba(236,234,230,0.55)' }}>
            Weather, time of day, or a sensory note the narrator should keep returning to.
            Location hue also suggests mood unless you pin it.
          </div>
          <textarea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => {
              const next = note.trim();
              if (next !== (episode.atmosphereNote ?? '')) {
                void safeWrite(
                  () => db.episodes.update(episode.id, {
                    atmosphereNote: next || undefined, updatedAt: Date.now()
                  }),
                  setImgError
                );
              }
            }}
            placeholder="rain on the glass · late afternoon · cold iron smell…"
            style={{ fontSize: 13 }}
          />

          {(episode.sceneLedger?.length ?? 0) > 0 && (
            <div className="craft-row" style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Mono style={{ fontSize: 9 }}>already true in this room</Mono>
              <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'rgba(236,234,230,0.45)' }}>
                Tracked from the prose as you play. The narrator and cast are held to these.
              </div>
              <ul style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {episode.sceneLedger!.map((d, i) => (
                  <li key={i} className="serif" style={{ fontSize: 13, lineHeight: 1.5, color: 'rgba(236,234,230,0.78)' }}>
                    {d}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, opacity: 0.5 }}>
              mood {episode.moodPinned ? 'pinned' : 'follows location'}
            </span>
            <Toggle
              label="Pin mood to this episode"
              on={!!episode.moodPinned}
              onClick={() => {
                const next = !episode.moodPinned;
                void safeWrite(
                  () => db.episodes.update(episode.id, { moodPinned: next, updatedAt: Date.now() }),
                  setImgError
                );
                if (!next && sceneLoc) setMood(moodFromHue(sceneLoc.hue));
              }}
            />
            {(Object.entries(MOODS) as Array<[typeof mood, (typeof MOODS)[typeof mood]]>).map(([id, m]) => (
              <button key={id} type="button" title={m.label} onClick={() => {
                setMood(id);
                void safeWrite(
                  () => db.episodes.update(episode.id, { moodPinned: true, updatedAt: Date.now() }),
                  setImgError
                );
              }} aria-label={m.label} style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                height: 24, padding: '0 8px', borderRadius: 2, cursor: 'pointer',
                background: mood === id ? m.accent : 'transparent',
                border: `1px solid ${mood === id ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.14)'}`,
                opacity: mood === id ? 1 : 0.5, color: mood === id ? '#0a1416' : 'rgba(230,233,235,0.7)',
                fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, letterSpacing: '0.04em'
              }}>
                <span style={{ width: 8, height: 8, borderRadius: 1, background: m.accent, flexShrink: 0 }} />
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {/* scroll background */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Mono style={{ fontSize: 9 }}>scroll background — under the glass</Mono>
          <div style={{ fontSize: 12, lineHeight: 1.55, color: 'rgba(236,234,230,0.55)' }}>
            What you see behind the story. Auto uses a scene photo you or the AI set, then the place photo, then climate.
            Dim wash keeps the type readable without hiding the room.
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {SCROLL_BACKDROPS.map((id) => (
              <Chip key={id} active={display.scrollBackdrop === id} onClick={() => setDisplay({ scrollBackdrop: id })}>
                {SCROLL_BACKDROP_LABEL[id]}
              </Chip>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, opacity: 0.5 }}>
              AI may set the scene photo
            </span>
            <Toggle
              label="AI may set the scene photo"
              on={display.aiSetsScrollBg}
              onClick={() => setDisplay({ aiSetsScrollBg: !display.aiSetsScrollBg })}
            />
          </div>
        </div>

        {/* scene image */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Mono style={{ fontSize: 9 }}>scene image — episode {episode.number}</Mono>
          <div style={{ fontSize: 12, lineHeight: 1.55, color: 'rgba(236,234,230,0.55)' }}>
            A picture of what's happening right now, shown behind the story text. Swap it whenever
            the scene changes; each episode keeps its own.
          </div>
          {episode.image && (
            <div style={{
              height: 120, borderRadius: 13, border: '1px solid rgba(255,255,255,0.12)',
              backgroundImage: `url(${JSON.stringify(episode.image)})`, backgroundSize: 'cover', backgroundPosition: 'center'
            }} />
          )}
          {imgError && <ErrorNote error={imgError} onDismiss={() => setImgError('')} />}
          {canMatchFaces && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Toggle label="Match faces in the scene image" on={matchCast} onClick={() => setMatchCast((v) => !v)} />
              <div style={{ fontSize: 12.5, lineHeight: 1.45, color: 'rgba(236,234,230,0.7)' }}>
                Match cast photos — keep uploaded faces when the image model accepts references.
              </div>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn-primary" style={{ fontSize: 12, padding: '8px 14px' }}
              disabled={genBusy || imgBusy || !sceneLoc}
              onClick={() => void generateFromLocation()}>
              {genBusy ? 'Generating…' : sceneLoc ? `Generate from ${sceneLoc.name}` : 'Generate from location'}
            </button>
            <button className="btn-ghost" style={{ fontSize: 12 }} disabled={imgBusy || genBusy} onClick={() => fileRef.current?.click()}>
              {imgBusy ? 'Processing…' : episode.image ? 'Replace image' : 'Upload image'}
            </button>
            {episode.image && (
              <button className="btn-quiet" style={{ fontSize: 11 }}
                onClick={() => void db.episodes.update(episode.id, { image: null })}>remove</button>
            )}
            <input
              ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ''; }}
            />
          </div>
          <SliderRow label="dim wash" value={display.imageDim} min={0} max={90} unit="%"
            onChange={(v) => setDisplay({ imageDim: v })} />
          <SliderRow label="image blur" value={display.imageBlur} min={0} max={20} unit="px"
            onChange={(v) => setDisplay({ imageBlur: v })} />
        </div>

        {/* text visibility */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 16 }}>
          <Mono style={{ fontSize: 9 }}>text</Mono>
          <SliderRow label="air behind text" value={display.textScrim} min={0} max={80} unit="%"
            onChange={(v) => setDisplay({ textScrim: v })} />
          <SliderRow label="text size" value={display.textSize} min={15} max={24} unit="px"
            onChange={(v) => setDisplay({ textSize: v })} />
        </div>

        {/* dialogue layout */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 16 }}>
          <Mono style={{ fontSize: 9 }}>how dialogue sits on the page</Mono>
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
          <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'rgba(236,234,230,0.45)' }}>
            {display.dialogueStyle === 'prose'
              ? 'Speech sits with a circular photo and the speaker’s name in their colour. A speaker who keeps talking is not re-announced.'
              : 'Every line gets a circular photo and a name — a conversation, not a chip list.'}
          </div>
        </div>

        {/* avatars */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 16 }}>
            <Mono style={{ fontSize: 9 }}>face size in the scroll</Mono>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {(['S', 'M', 'L'] as AvatarSize[]).map((s) => (
                <Chip key={s} active={display.avatarSize === s} onClick={() => setDisplay({ avatarSize: s })}>
                  {s === 'S' ? 'Small' : s === 'M' ? 'Medium' : 'Large'}
                </Chip>
              ))}
              <div style={{ marginLeft: 'auto' }}>
                <Face hue={200} size={AVATAR_PX[display.avatarSize]} name="Ada" />
              </div>
            </div>
          </div>

        <button className="btn-quiet" style={{ alignSelf: 'flex-start', fontSize: 11 }}
          onClick={() => setDisplay(DEFAULT_DISPLAY)}>reset display to defaults</button>
      </div>
    </Sheet>
  );
}

// ---------- turn row with edit / retry / delete-below ----------

function TurnRow({ turn, blocks, characters, accent, prose, fontPx, avatarPx, dialogueStyle, prevSpeaker, streaming, hasBelow, opening, onRetry, onReroll, onDeleteBelow, onDelete }: {
  turn: Turn;
  blocks: ProseBlock[];
  characters: Character[];
  accent: string;
  prose: string;
  fontPx: number;
  avatarPx: number;
  dialogueStyle: DialogueStyle;
  /** who held the floor just before this turn, so prose layout can skip a repeat name */
  prevSpeaker: string | null;
  streaming: boolean;
  hasBelow: boolean;
  opening?: boolean;
  onRetry: () => void;
  onReroll?: () => void;
  onDeleteBelow: () => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const characterName = turn.role === 'character'
    ? (characters.find((c) => c.id === turn.characterId)?.name ?? 'character')
    : null;
  const editLabel =
    turn.role === 'narrator' ? 'the narrator'
    : turn.role === 'character' ? characterName!
    : `your ${turn.mode ?? 'turn'}`;
  const retryLabel = 'Retry from here';
  const retryTitle = 'Deletes this turn and everything below, then rewrites from here';

  const save = async () => {
    const text = draft.trim();
    if (text && text !== turn.text) {
      await db.turns.update(turn.id, { text, updatedAt: Date.now() });
      if (turn.episodeId) await clearEpisodeRunningSummary(turn.episodeId);
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <div style={{ marginBottom: 22, display: 'flex', flexDirection: 'column', gap: 9 }}>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9.5, letterSpacing: '0.12em', textTransform: 'uppercase', opacity: 0.5 }}>
          editing {editLabel} — saved into story memory
        </div>
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={Math.min(16, Math.max(4, Math.ceil(draft.length / 70)))}
          style={{ fontFamily: 'Spectral, serif', fontSize: 15.5, lineHeight: 1.7, width: '100%' }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); }
            if (e.key === 'Escape') setEditing(false);
          }}
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn-primary" style={{ padding: '7px 14px', fontSize: 12 }} onClick={() => void save()}>Save</button>
          <button className="btn-quiet" style={{ fontSize: 11 }} onClick={() => setEditing(false)}>cancel</button>
          <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9.5, opacity: 0.4, marginLeft: 'auto' }}>⌘↵ save · esc cancel</span>
        </div>
      </div>
    );
  }

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
      <div className="turn-tools" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 0, marginBottom: 8 }}>
        <button className="btn-quiet" style={{ fontSize: 12, padding: '10px 12px', minHeight: 44 }} disabled={streaming}
          onClick={() => { setDraft(turn.text); setEditing(true); }}>Edit</button>
        <button className="btn-quiet" style={{ fontSize: 12, padding: '10px 12px', minHeight: 44 }} disabled={streaming}
          title={retryTitle}
          onClick={onRetry}>{retryLabel}</button>
        {onReroll && (
          <button className="btn-quiet" style={{ fontSize: 12, padding: '10px 12px', minHeight: 44 }} disabled={streaming}
            onClick={onReroll} title="Replace this line only — later turns stay">Re-roll line</button>
        )}
        {hasBelow && (
          <button className="btn-quiet" style={{ fontSize: 12, padding: '10px 12px', minHeight: 44 }} disabled={streaming}
            onClick={onDeleteBelow}>Delete below</button>
        )}
        <button className="btn-quiet" style={{ fontSize: 12, padding: '10px 12px', minHeight: 44 }} disabled={streaming}
          onClick={onDelete}>Delete</button>
      </div>
    </div>
  );
}

// ---------- director sub-panels ----------

function SceneCastPanel({ episode, characters, accent, onGoCast }: {
  episode: Episode; characters: Character[]; accent: string; onGoCast: () => void;
}) {
  const guests = episode.guests ?? [];
  const activeGuestIds = episode.activeGuestIds;
  const [castError, setCastError] = useState('');
  const [addingWalkOn, setAddingWalkOn] = useState(false);
  const [walkName, setWalkName] = useState('');
  const [walkBrief, setWalkBrief] = useState('');
  const [walkVoice, setWalkVoice] = useState('');
  const [editGuestId, setEditGuestId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editBrief, setEditBrief] = useState('');
  const [editVoice, setEditVoice] = useState('');

  const toggleCast = async (id: string, isPlayer: boolean) => {
    if (isPlayer) return;
    const castIds = nextSceneCastIds(episode.castIds, id, isPlayer);
    await safeWrite(
      () => db.episodes.update(episode.id, { castIds, updatedAt: Date.now() }),
      setCastError
    );
  };
  const toggleGuest = async (guestId: string) => {
    const allIds = guests.map((g) => g.id);
    // Materialize omitted (= all active) into an explicit list before toggling.
    const current = activeGuestIds == null ? [...allIds] : [...activeGuestIds];
    const next = current.includes(guestId)
      ? current.filter((x) => x !== guestId)
      : [...current, guestId];
    await safeWrite(
      () => db.episodes.update(episode.id, { activeGuestIds: next, updatedAt: Date.now() }),
      setCastError
    );
  };

  const addWalkOn = async () => {
    const name = walkName.trim();
    if (!name) return;
    const guest: EpisodeGuest = {
      id: uid(),
      name,
      brief: walkBrief.trim() || 'A temporary walk-on in this episode.',
      ...(walkVoice.trim() ? { voice: walkVoice.trim() } : {})
    };
    const nextGuests = [...guests, guest];
    const nextActive = activeGuestIds == null
      ? undefined
      : [...activeGuestIds, guest.id];
    await safeWrite(
      () => db.episodes.update(episode.id, {
        guests: nextGuests,
        ...(nextActive ? { activeGuestIds: nextActive } : {}),
        updatedAt: Date.now()
      }),
      setCastError
    );
    setWalkName('');
    setWalkBrief('');
    setWalkVoice('');
    setAddingWalkOn(false);
  };

  const beginEditGuest = (g: EpisodeGuest) => {
    setEditGuestId(g.id);
    setEditName(g.name);
    setEditBrief(g.brief);
    setEditVoice(g.voice ?? '');
  };

  const saveGuestEdit = async (g: EpisodeGuest) => {
    const next = guests.map((x) => (x.id === g.id ? {
      ...x,
      name: editName.trim() || g.name,
      brief: editBrief.trim() || g.brief,
      ...(editVoice.trim() ? { voice: editVoice.trim() } : { voice: undefined })
    } : x));
    await safeWrite(
      () => db.episodes.update(episode.id, { guests: next, updatedAt: Date.now() }),
      setCastError
    );
    setEditGuestId(null);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <Mono style={{ fontSize: 9 }}>in the scene</Mono>
        <button className="btn-quiet" style={{ fontSize: 10, padding: '2px 4px' }} onClick={onGoCast}>full editor → Cast</button>
      </div>
      {castError && <ErrorNote error={castError} onDismiss={() => setCastError('')} />}
      {characters.map((c) => {
        const active = c.isPlayer || episode.castIds.includes(c.id);
        return (
          <div
            key={c.id}
            onClick={() => void toggleCast(c.id, !!c.isPlayer)}
            style={{
              display: 'flex', gap: 10, alignItems: 'center', padding: 8, borderRadius: 12,
              cursor: c.isPlayer ? 'default' : 'pointer',
              background: active ? 'rgba(255,255,255,0.05)' : 'transparent',
              border: `1px solid ${active ? 'rgba(255,255,255,0.08)' : 'transparent'}`,
              opacity: active ? 1 : 0.45
            }}
          >
            <Face hue={c.hue} size={30} portrait={characterPortraits(c)[0]} name={c.name} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#f0eee9' }}>{c.name}</div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9.5, opacity: 0.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {c.isPlayer
                  ? 'player · always in scene'
                  : active ? (c.state.emotion || c.role || 'in scene') : 'off-page'}
              </div>
            </div>
            <div style={{
              width: 14, height: 14, borderRadius: 5, flexShrink: 0,
              border: `1px solid ${active ? accent : 'rgba(255,255,255,0.18)'}`,
              background: active ? accent : 'transparent',
              opacity: c.isPlayer ? 0.85 : 1
            }} />
          </div>
        );
      })}
      <Mono style={{ fontSize: 9, marginTop: 8 }}>walk-ons · this episode only</Mono>
      {guests.map((g) => {
        // Omitted activeGuestIds ⇒ all guests; explicit [] ⇒ none (matches prompts).
        const active = activeGuestIds == null || activeGuestIds.includes(g.id);
        const editing = editGuestId === g.id;
        return (
          <div key={g.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div
              style={{
                display: 'flex', gap: 10, alignItems: 'center', padding: 8, borderRadius: 12,
                background: active ? 'rgba(255,255,255,0.04)' : 'transparent',
                border: `1px solid ${active ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.06)'}`,
                opacity: active ? 1 : 0.4
              }}
            >
              <div
                onClick={() => void toggleGuest(g.id)}
                style={{ display: 'flex', gap: 10, alignItems: 'center', flex: 1, minWidth: 0, cursor: 'pointer' }}
              >
                <Face hue={guestHue(g.id)} size={30} name={g.name} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#f0eee9' }}>{g.name}</div>
                  <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9.5, opacity: 0.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {active ? (g.brief || 'walk-on') : 'off-page'}
                  </div>
                </div>
              </div>
              <button
                type="button"
                className="btn-quiet"
                style={{ fontSize: 10, padding: '4px 8px', minHeight: 32 }}
                onClick={() => (editing ? setEditGuestId(null) : beginEditGuest(g))}
              >
                {editing ? 'close' : 'edit'}
              </button>
              <div
                onClick={() => void toggleGuest(g.id)}
                style={{
                  width: 14, height: 14, borderRadius: 5, flexShrink: 0, cursor: 'pointer',
                  border: `1px solid ${active ? accent : 'rgba(255,255,255,0.18)'}`,
                  background: active ? accent : 'transparent'
                }}
              />
            </div>
            {editing && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '0 4px 8px' }}>
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="Name"
                  style={{ fontSize: 13 }}
                />
                <textarea
                  value={editBrief}
                  onChange={(e) => setEditBrief(e.target.value)}
                  placeholder="Who they are this episode"
                  rows={2}
                  style={{ fontSize: 12.5 }}
                />
                <input
                  value={editVoice}
                  onChange={(e) => setEditVoice(e.target.value)}
                  placeholder="Voice note (optional)"
                  style={{ fontSize: 12.5 }}
                />
                <button
                  type="button"
                  className="btn-primary"
                  style={{ alignSelf: 'flex-start', padding: '6px 12px', fontSize: 12 }}
                  onClick={() => void saveGuestEdit(g)}
                >
                  Save walk-on
                </button>
              </div>
            )}
          </div>
        );
      })}
      {addingWalkOn ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 8, borderRadius: 12, border: '1px solid rgba(255,255,255,0.1)' }}>
          <input value={walkName} onChange={(e) => setWalkName(e.target.value)} placeholder="Walk-on name" style={{ fontSize: 13 }} />
          <textarea value={walkBrief} onChange={(e) => setWalkBrief(e.target.value)} placeholder="Who they are (one sentence)" rows={2} style={{ fontSize: 12.5 }} />
          <input value={walkVoice} onChange={(e) => setWalkVoice(e.target.value)} placeholder="Voice note (optional)" style={{ fontSize: 12.5 }} />
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn-primary" style={{ padding: '6px 12px', fontSize: 12 }} disabled={!walkName.trim()} onClick={() => void addWalkOn()}>
              Add
            </button>
            <button type="button" className="btn-quiet" style={{ fontSize: 11 }} onClick={() => setAddingWalkOn(false)}>cancel</button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="btn-ghost"
          style={{ alignSelf: 'flex-start', fontSize: 12, minHeight: 40 }}
          onClick={() => setAddingWalkOn(true)}
        >
          + Add walk-on
        </button>
      )}
    </div>
  );
}

function locationThumb(l: Location, size = 30): CSSProperties {
  if (l.portrait) {
    return {
      width: size, height: size, borderRadius: '50%', flexShrink: 0,
      backgroundImage: `url(${JSON.stringify(l.portrait)})`, backgroundSize: 'cover', backgroundPosition: 'center',
      border: '1px solid rgba(255,255,255,0.22)',
      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.2)'
    };
  }
  return { ...avatarStyle(l.hue, size), borderRadius: '50%' };
}

function SceneLocationsPanel({ episode, locations, accent, world, characters, onGoLocations }: {
  episode: Episode; locations: Location[]; accent: string; world?: World;
  characters: Character[]; onGoLocations: () => void;
}) {
  const { setMood, display, setDisplay } = useApp();
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState('');

  const activeLoc = locations.find((l) => l.id === episode.locationId)
    ?? locations.find((l) => !!episode.location && l.name.trim()
      && (episode.location.toLowerCase().includes(l.name.toLowerCase())
        || l.name.toLowerCase().includes(episode.location.trim().toLowerCase())));

  const select = async (l: Location) => {
    const active = episode.locationId === l.id;
    if (active) {
      await safeWrite(
        () => db.episodes.update(episode.id, {
          locationId: null, location: '', updatedAt: Date.now()
        }),
        setGenError
      );
      return;
    }
    const patch: Partial<Episode> = {
      locationId: l.id,
      location: l.name,
      updatedAt: Date.now(),
      // Keep place and picture honest — portrait if any, else clear stale image.
      image: l.portrait || null
    };
    if (!(episode.atmosphereNote ?? '').trim() && l.atmosphere.trim()) {
      patch.atmosphereNote = l.atmosphere.trim();
    }
    await safeWrite(() => db.episodes.update(episode.id, patch), setGenError);
    if (!episode.moodPinned) setMood(moodFromHue(l.hue));
  };

  const addQuick = async () => {
    const l = emptyLocation(episode.worldId, { name: 'New location' });
    await safeWrite(async () => {
      await db.locations.add(l);
      await db.episodes.update(episode.id, {
        locationId: l.id, location: l.name, updatedAt: Date.now(),
        ...(l.portrait ? { image: l.portrait } : {})
      });
    }, setGenError);
    if (!episode.moodPinned) setMood(moodFromHue(l.hue));
  };

  const generate = async () => {
    if (!world || !activeLoc) return;
    setGenBusy(true);
    setGenError('');
    try {
      const { provider, model } = imageModelFor(world);
      const refs = collectSceneImageRefs({
        characters, castIds: episode.castIds, location: activeLoc
      });
      const result = await generateSceneImage({
        provider, model, world, location: activeLoc,
        atmosphereNote: episode.atmosphereNote,
        matchCast: sceneHasPortraitRefs(characters, episode.castIds),
        refs
      });
      await guardStorage(() => db.episodes.update(episode.id, { image: result.dataUrl, updatedAt: Date.now() }));
      if (result.warning) setGenError(result.warning);
      if (display.aiSetsScrollBg) setDisplay({ scrollBackdrop: 'auto' });
    } catch (e) {
      setGenError(formatUserError(e));
    } finally {
      setGenBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      <Mono style={{ fontSize: 9 }}>locations</Mono>
      {locations.map((l) => {
        const active = episode.locationId === l.id
          || (!episode.locationId && !!episode.location && l.name.trim()
            && (episode.location.toLowerCase().includes(l.name.toLowerCase())
              || l.name.toLowerCase().includes(episode.location.trim().toLowerCase())));
        return (
          <div key={l.id} onClick={() => void select(l)} style={{
            display: 'flex', gap: 10, alignItems: 'center', padding: 8, borderRadius: 12, cursor: 'pointer',
            background: active ? 'rgba(255,255,255,0.05)' : 'transparent',
            border: `1px solid ${active ? 'rgba(255,255,255,0.08)' : 'transparent'}`,
            opacity: active ? 1 : 0.45
          }}>
            <div style={locationThumb(l, 30)} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#f0eee9' }}>{l.name || 'unnamed'}</div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9.5, opacity: 0.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {active ? (l.tagline || l.currentState || 'scene setting') : (l.tagline || 'off-scene')}
              </div>
            </div>
            <div style={{
              width: 14, height: 14, borderRadius: 5, flexShrink: 0,
              border: `1px solid ${active ? accent : 'rgba(255,255,255,0.18)'}`,
              background: active ? accent : 'transparent'
            }} />
          </div>
        );
      })}
      {locations.length === 0 && (
        <div style={{ fontSize: 12, opacity: 0.5, color: '#eceae6' }}>No saved locations yet.</div>
      )}
      {genError && <ErrorNote error={genError} onDismiss={() => setGenError('')} />}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn-quiet" style={{ fontSize: 10, padding: '2px 4px' }} onClick={() => void addQuick()}>+ new</button>
        {activeLoc && world && (
          <button className="btn-quiet" style={{ fontSize: 10, padding: '2px 4px' }} disabled={genBusy}
            onClick={() => void generate()}>
            {genBusy ? 'generating…' : 'generate scene image'}
          </button>
        )}
        <button className="btn-quiet" style={{ fontSize: 10, padding: '2px 4px' }} onClick={onGoLocations}>full editor → Places</button>
      </div>
    </div>
  );
}

function ScenePlatePanel({ episode, bd }: { episode: Episode; bd: { tag: string; a: string; b: string } }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(episode.location);
  useEffect(() => setValue(episode.location), [episode.id, episode.location]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      <Mono style={{ fontSize: 9 }}>scene note — free text</Mono>
      <div style={{ border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12, overflow: 'hidden', background: 'rgba(255,255,255,0.04)' }}>
        <div style={{
          height: 98, display: 'flex', alignItems: 'flex-end', padding: 9,
          background: episode.image
            ? `linear-gradient(rgba(8,9,12,0.15), rgba(8,9,12,0.3)), url(${episode.image}) center / cover`
            : `linear-gradient(155deg, ${bd.a}, ${bd.b}), ${STRIPE('rgba(255,255,255,0.06)', 'rgba(255,255,255,0.015)')}`
        }}>
          <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: 'rgba(236,234,230,0.6)', background: 'rgba(8,9,12,0.5)', padding: '4px 7px', borderRadius: 5 }}>
            {bd.tag}
          </span>
        </div>
        {editing ? (
          <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <textarea rows={2} value={value} onChange={(e) => setValue(e.target.value)} style={{ fontSize: 12 }}
              placeholder="One-off spot not in the library…" />
            <button className="btn-ghost" style={{ fontSize: 11, padding: '6px 10px' }} onClick={() => {
              // Free-text override clears the library link so the cards don't fight it.
              void safeWrite(
                () => db.episodes.update(episode.id, {
                  location: value, locationId: null, updatedAt: Date.now()
                }),
                () => undefined
              );
              setEditing(false);
            }}>Save</button>
          </div>
        ) : (
          <div onClick={() => setEditing(true)} style={{ padding: '10px 12px', fontSize: 12, lineHeight: 1.5, opacity: 0.7, cursor: 'pointer', color: '#eceae6' }}>
            {episode.location || 'Optional free-text override — or pick a location card above.'}
          </div>
        )}
      </div>
    </div>
  );
}

/** Mid-episode digest injected into prompts — edit or clear so junk does not keep resurfacing. */
function RunningSummaryPanel({ episode }: { episode: Episode }) {
  const [error, setError] = useState('');
  const running = episode.runningSummary?.trim();
  if (!running && !episode.runningSummary) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Mono style={{ fontSize: 9 }}>this episode · running summary</Mono>
        <div style={{ fontSize: 12, opacity: 0.45, color: '#eceae6' }}>
          None yet — built automatically when the transcript grows long.
        </div>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <Mono style={{ fontSize: 9 }}>this episode · running summary</Mono>
        <button
          type="button"
          className="btn-quiet"
          style={{ padding: 0, fontSize: 10 }}
          onClick={() => void safeWrite(
            () => db.episodes.update(episode.id, {
              runningSummary: null, runningSummaryAtChars: 0, updatedAt: Date.now()
            }),
            setError
          )}
        >
          Clear
        </button>
      </div>
      {error && <ErrorNote error={error} onDismiss={() => setError('')} />}
      <textarea
        key={episode.id + '-running-' + (episode.runningSummaryAtChars ?? 0)}
        rows={4}
        defaultValue={episode.runningSummary ?? ''}
        onBlur={(e) => {
          const next = e.target.value;
          if (next === (episode.runningSummary ?? '')) return;
          void safeWrite(
            () => db.episodes.update(episode.id, {
              runningSummary: next.trim() ? next : null,
              runningSummaryAtChars: next.trim() ? (episode.runningSummaryAtChars ?? 0) : 0,
              updatedAt: Date.now()
            }),
            setError
          );
        }}
        placeholder="Compressed earlier beats for this episode…"
        style={{ fontSize: 12.5, lineHeight: 1.45, color: '#eceae6' }}
      />
    </div>
  );
}

/** Filed wrap memory from recent priors — prune recap / beats / walk-on effects that keep returning. */
function PriorWrapMemoryPanel({ priorEpisodes }: { priorEpisodes: Episode[] }) {
  const [error, setError] = useState('');
  const patchWrap = (ep: Episode, wrap: EpisodeWrap) => {
    void safeWrite(
      () => db.episodes.update(ep.id, { wrap, updatedAt: Date.now() }),
      setError
    );
  };
  if (priorEpisodes.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Mono style={{ fontSize: 9 }}>recent episode memory</Mono>
        <div style={{ fontSize: 12, opacity: 0.45, color: '#eceae6' }}>
          No filed episode wraps yet.
        </div>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Mono style={{ fontSize: 9 }}>recent episode memory · last {priorEpisodes.length}</Mono>
      {error && <ErrorNote error={error} onDismiss={() => setError('')} />}
      {[...priorEpisodes].reverse().map((ep, idx) => {
        const wrap = ep.wrap ?? { recap: '', beats: [], guestEffects: [] };
        return (
          <div
            key={ep.id}
            style={{
              border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12, padding: '12px 12px',
              background: 'rgba(255,255,255,0.03)', display: 'flex', flexDirection: 'column', gap: 10
            }}
          >
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, opacity: 0.65 }}>
              E{ep.number}{ep.title ? ` — ${ep.title}` : ''}{idx === 0 ? ' · immediate prior' : ''}
            </div>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <Mono style={{ fontSize: 8, opacity: 0.5 }}>recap</Mono>
              <textarea
                key={ep.id + '-recap-' + (ep.updatedAt ?? ep.id)}
                rows={3}
                defaultValue={wrap.recap}
                onBlur={(e) => {
                  if (e.target.value === wrap.recap) return;
                  patchWrap(ep, { ...wrap, recap: e.target.value });
                }}
                style={{ fontSize: 12.5, lineHeight: 1.45, color: '#eceae6' }}
              />
            </label>
            {(wrap.beats.length > 0 || wrap.guestEffects.length > 0) && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {wrap.beats.map((b, i) => (
                  <div key={`b${i}`} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                    <div style={{
                      fontSize: 12, lineHeight: 1.4, flex: 1, color: '#eceae6', opacity: 0.88,
                      paddingLeft: 10, borderLeft: '1px solid rgba(255,255,255,0.14)'
                    }}>
                      {b.text}
                      {b.consequence ? (
                        <span style={{ opacity: 0.55 }}> → {b.consequence}</span>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className="btn-quiet"
                      style={{ padding: '0 2px', fontSize: 12 }}
                      title="Remove beat from memory"
                      onClick={() => patchWrap(ep, {
                        ...wrap,
                        beats: wrap.beats.filter((_, j) => j !== i)
                      })}
                    >
                      ×
                    </button>
                  </div>
                ))}
                {wrap.guestEffects.map((g, i) => (
                  <div key={`g${i}`} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                    <div style={{
                      fontSize: 12, lineHeight: 1.4, flex: 1, color: '#eceae6', opacity: 0.75,
                      paddingLeft: 10, borderLeft: `1px solid ${ACCENT_RGBA.a28}`
                    }}>
                      <span style={{
                        fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, opacity: 0.6,
                        display: 'block', marginBottom: 2
                      }}>walk-on</span>
                      {g}
                    </div>
                    <button
                      type="button"
                      className="btn-quiet"
                      style={{ padding: '0 2px', fontSize: 12 }}
                      title="Remove walk-on effect"
                      onClick={() => patchWrap(ep, {
                        ...wrap,
                        guestEffects: wrap.guestEffects.filter((_, j) => j !== i)
                      })}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function PlotTargetsPanel({ episode, season }: { episode: Episode; season: Season }) {
  const [error, setError] = useState('');
  const [adding, setAdding] = useState('');
  const [addScope, setAddScope] = useState<'episode' | 'season'>('episode');

  const writeEpisode = (plotTargets: PlotTarget[]) => {
    void safeWrite(
      () => db.episodes.update(episode.id, { plotTargets, updatedAt: Date.now() }),
      setError
    );
  };
  const writeSeason = (plotTargets: PlotTarget[]) => {
    void safeWrite(
      () => db.seasons.update(season.id, { plotTargets, updatedAt: Date.now() }),
      setError
    );
  };

  const setStatus = (
    scope: 'episode' | 'season',
    id: string,
    status: PlotTargetStatus
  ) => {
    if (scope === 'episode') {
      writeEpisode((episode.plotTargets ?? []).map((t) => (t.id === id ? { ...t, status } : t)));
    } else {
      writeSeason((season.plotTargets ?? []).map((t) => (t.id === id ? { ...t, status } : t)));
    }
  };

  const patchText = (scope: 'episode' | 'season', id: string, text: string) => {
    if (scope === 'episode') {
      writeEpisode((episode.plotTargets ?? []).map((t) => (t.id === id ? { ...t, text } : t)));
    } else {
      writeSeason((season.plotTargets ?? []).map((t) => (t.id === id ? { ...t, text } : t)));
    }
  };

  const addManual = () => {
    const text = adding.trim();
    if (!text) return;
    const row: PlotTarget = {
      id: uid(), text, status: 'pending', source: 'manual'
    };
    if (addScope === 'episode') {
      const cur = episode.plotTargets ?? [];
      if (cur.filter((t) => t.status === 'pending').length >= PLOT_TARGET_CAP) return;
      writeEpisode([...cur, row]);
    } else {
      const cur = season.plotTargets ?? [];
      if (cur.filter((t) => t.status === 'pending').length >= PLOT_TARGET_CAP) return;
      writeSeason([...cur, row]);
    }
    setAdding('');
  };

  const renderRow = (t: PlotTarget, scope: 'episode' | 'season') => (
    <div
      key={`${scope}-${t.id}`}
      style={{
        display: 'flex', flexDirection: 'column', gap: 6,
        border: '1px solid rgba(255,255,255,0.1)', borderRadius: 11, padding: '10px 12px',
        background: 'rgba(255,255,255,0.04)',
        opacity: t.status === 'pending' ? 1 : 0.5
      }}
    >
      <textarea
        key={t.id + t.status}
        rows={2}
        defaultValue={t.text}
        onBlur={(e) => {
          if (e.target.value !== t.text) patchText(scope, t.id, e.target.value);
        }}
        style={{
          fontSize: 12.5, lineHeight: 1.4, color: '#eceae6',
          background: 'transparent', border: 0, padding: 0
        }}
      />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        <span style={{
          fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, opacity: 0.45, flex: 1
        }}>
          {scope === 'season' ? 'season arc' : 'episode'} · {t.source} · {t.status}
        </span>
        {t.status !== 'pending' && (
          <button type="button" className="btn-quiet" style={{ padding: 0, fontSize: 10 }}
            onClick={() => setStatus(scope, t.id, 'pending')}>pending</button>
        )}
        {t.status !== 'hit' && (
          <button type="button" className="btn-quiet" style={{ padding: 0, fontSize: 10 }}
            onClick={() => setStatus(scope, t.id, 'hit')}>hit</button>
        )}
        {t.status !== 'dropped' && (
          <button type="button" className="btn-quiet" style={{ padding: 0, fontSize: 10 }}
            onClick={() => setStatus(scope, t.id, 'dropped')}>drop</button>
        )}
      </div>
    </div>
  );

  const epList = episode.plotTargets ?? [];
  const seaList = season.plotTargets ?? [];
  const epPending = epList.filter((t) => t.status === 'pending');
  const seaPending = seaList.filter((t) => t.status === 'pending');
  const settled = [
    ...epList.filter((t) => t.status !== 'pending').map((t) => ({ t, scope: 'episode' as const })),
    ...seaList.filter((t) => t.status !== 'pending').map((t) => ({ t, scope: 'season' as const }))
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Mono style={{ fontSize: 9 }}>
        plot targets · {epPending.length} episode · {seaPending.length} season pending
      </Mono>
      <div style={{ fontSize: 11.5, lineHeight: 1.45, opacity: 0.45, color: '#eceae6' }}>
        Author-selected beats the director works toward. Stronger than open threads; weaker than a one-shot steer.
      </div>
      {error && <ErrorNote error={error} onDismiss={() => setError('')} />}
      {epList.length === 0 && seaPending.length === 0 && (
        <div style={{ fontSize: 12, opacity: 0.5, color: '#eceae6' }}>
          None yet — Aim beats at episode wrap, or Raise at season review.
        </div>
      )}
      {epList.filter((t) => t.status === 'pending').map((t) => renderRow(t, 'episode'))}
      {seaPending.map((t) => renderRow(t, 'season'))}
      {settled.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Mono style={{ fontSize: 8, opacity: 0.5 }}>hit / dropped</Mono>
          {settled.map(({ t, scope }) => renderRow(t, scope))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <Chip active={addScope === 'episode'} onClick={() => setAddScope('episode')}>episode</Chip>
        <Chip active={addScope === 'season'} onClick={() => setAddScope('season')}>season</Chip>
        <input
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          placeholder="add a target…"
          style={{ fontSize: 11.5, padding: '7px 9px', flex: 1, minWidth: 140 }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addManual();
          }}
        />
      </div>
    </div>
  );
}

function ContinuityPanel({ continuity, world, season, episode, priorEpisodes }: {
  continuity: ContinuityFact[]; world: World; season: Season; episode: Episode;
  priorEpisodes?: Episode[];
}) {
  const [adding, setAdding] = useState('');
  const [error, setError] = useState('');
  const prefer = preferBucketsForEpisodes(priorEpisodes ?? [], episode);
  const inPlanIds = new Set(selectDirectorFacts(continuity, prefer).map((f) => f.id));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Mono style={{ fontSize: 9 }}>
        continuity held · {inPlanIds.size}/{continuity.length} in director plan
      </Mono>
      <div style={{ fontSize: 11, lineHeight: 1.4, opacity: 0.45, color: '#eceae6' }}>
        Held facts outside the director cap may still reach narration (up to 24).
      </div>
      {error && <ErrorNote error={error} onDismiss={() => setError('')} />}
      {continuity.map((f) => {
        const inPlan = inPlanIds.has(f.id);
        return (
          <div key={f.id} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
            <div style={{
              fontSize: 12, lineHeight: 1.45, paddingLeft: 12,
              borderLeft: `1px solid ${f.pinned || inPlan ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.08)'}`,
              flex: 1, color: '#eceae6', opacity: f.pinned || inPlan ? 0.88 : 0.45
            }}>
              {f.text}
              <span style={{
                display: 'block', marginTop: 2,
                fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, opacity: 0.7
              }}>
                {f.pinned ? 'pinned · always in director plan' : inPlan ? 'in director plan' : 'held · not in director cap'}
              </span>
            </div>
            <button
              className="btn-quiet"
              style={{ padding: '0 6px', fontSize: 11, minHeight: 36 }}
              title={f.pinned ? 'Unpin from director plan' : 'Pin into director plan'}
              onClick={() => void safeWrite(
                () => db.continuity.update(f.id, { pinned: !f.pinned, updatedAt: Date.now() }),
                setError
              )}
            >{f.pinned ? 'unpin' : 'pin'}</button>
            <button className="btn-quiet" style={{ padding: '0 2px', fontSize: 12 }} onClick={() => void safeWrite(async () => {
              await recordTombstones([{
                table: 'continuity', id: f.id, worldId: f.worldId, seasonId: f.seasonId, payload: f
              }]);
              await db.continuity.delete(f.id);
            }, setError)}>×</button>
          </div>
        );
      })}
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="add a fact…"
          style={{ fontSize: 11.5, padding: '7px 9px' }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && adding.trim()) {
              const text = adding.trim();
              void safeWrite(async () => {
                await db.continuity.add({
                  id: uid(), worldId: world.id, seasonId: season.id, episodeId: episode.id,
                  text, source: 'manual', createdAt: Date.now(), updatedAt: Date.now()
                });
              }, setError);
              setAdding('');
            }
          }}
        />
      </div>
    </div>
  );
}

function ThreadsPanel({ threads, episode, priorEpisodes }: {
  threads: OpenThread[]; episode: Episode; priorEpisodes?: Episode[];
}) {
  const [error, setError] = useState('');
  const prefer = preferBucketsForEpisodes(priorEpisodes ?? [], episode);
  const inPlanIds = new Set(selectDirectorThreads(threads, prefer).map((t) => t.id));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      <Mono style={{ fontSize: 9 }}>
        open threads · {inPlanIds.size}/{threads.length} in director plan
      </Mono>
      {error && <ErrorNote error={error} onDismiss={() => setError('')} />}
      {threads.map((t) => {
        const inPlan = inPlanIds.has(t.id);
        return (
          <div key={t.id} style={{
            border: `1px solid ${t.pinned || inPlan ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.06)'}`,
            borderRadius: 11, padding: '10px 12px',
            background: 'rgba(255,255,255,0.04)', display: 'flex', flexDirection: 'column', gap: 5,
            opacity: t.pinned || inPlan ? 1 : 0.55
          }}>
            <div style={{ fontSize: 12.5, lineHeight: 1.4, color: '#eceae6' }}>{t.text}</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9.5, opacity: 0.45 }}>
                {t.openedLabel}{t.pinned ? ' · pinned' : !inPlan ? ' · held' : ''}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn-quiet"
                  style={{ padding: 0, fontSize: 10 }}
                  onClick={() => void safeWrite(
                    () => db.threads.update(t.id, { pinned: !t.pinned, updatedAt: Date.now() }),
                    setError
                  )}
                >
                  {t.pinned ? 'unpin' : 'pin'}
                </button>
                <button
                  className="btn-quiet"
                  style={{ padding: 0, fontSize: 10 }}
                  onClick={() => void safeWrite(
                    () => db.threads.update(t.id, { status: 'resolved', updatedAt: Date.now() }),
                    setError
                  )}
                >
                  resolve
                </button>
              </div>
            </div>
          </div>
        );
      })}
      {threads.length === 0 && <div style={{ fontSize: 12, opacity: 0.5, color: '#eceae6' }}>No open threads yet.</div>}
    </div>
  );
}

function NudgesPanel({
  threads, inScene, episodeTargets, seasonTargets, onNudge
}: {
  threads: OpenThread[];
  inScene: Character[];
  episodeTargets?: PlotTarget[];
  seasonTargets?: PlotTarget[];
  onNudge: (t: string) => void;
}) {
  const topTarget =
    (episodeTargets ?? []).find((t) => t.status === 'pending' && t.text.trim())
    ?? (seasonTargets ?? []).find((t) => t.status === 'pending' && t.text.trim());
  const nudges = [
    'Let the silence run — do not fill it for me.',
    ...inScene.filter((c) => !c.isPlayer).slice(0, 2).map((c) => `${c.name} presses toward what they want.`),
    ...(topTarget ? [`Advance toward: ${topTarget.text}`] : []),
    ...threads.slice(0, 2).map((t) => `Bring this to the surface: ${t.text}`),
    'Cut away — a different place, right after.'
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      <Mono style={{ fontSize: 9 }}>nudge the scene</Mono>
      {nudges.map((n, i) => (
        <button key={i} onClick={() => onNudge(n)} style={{
          textAlign: 'left', border: '1px solid rgba(255,255,255,0.09)', background: 'rgba(255,255,255,0.03)',
          color: 'inherit', borderRadius: 11, padding: '10px 12px', fontSize: 12.5, cursor: 'pointer', lineHeight: 1.4
        }} className="hover-border">
          {n}
        </button>
      ))}
    </div>
  );
}

function DirectorAccordion({
  title, open, onToggle, children, labelSize
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  labelSize: number;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: open ? 12 : 0 }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          minHeight: 44, padding: '10px 0', border: 0, borderBottom: '1px solid rgba(255,255,255,0.1)',
          background: 'transparent', color: 'inherit', cursor: 'pointer', textAlign: 'left'
        }}
      >
        <Mono style={{ fontSize: labelSize }}>{title}</Mono>
        <span style={{ opacity: 0.5, fontSize: 14 }}>{open ? '−' : '+'}</span>
      </button>
      {open && children}
    </div>
  );
}

function DirectorContent(props: {
  world: World; season: Season; episode: Episode; characters: Character[]; locations: Location[];
  continuity: ContinuityFact[]; threads: OpenThread[]; accent: string;
  narrow?: boolean;
  onGoLocations: () => void;
  onGoCast: () => void;
  onNudge: (t: string) => void;
}) {
  const inScene = props.characters.filter((c) => props.episode.castIds.includes(c.id));
  const labelSize = props.narrow ? 11 : 9;
  const hasPlotTargets = [
    ...(props.episode.plotTargets ?? []),
    ...(props.season.plotTargets ?? [])
  ].some((t) => t.status === 'pending' && t.text.trim());
  const [open, setOpen] = useState(() => {
    let openMemory = false;
    if (hasPlotTargets) {
      try {
        if (localStorage.getItem('sw-direct-memory-opened') !== '1') {
          openMemory = true;
          localStorage.setItem('sw-direct-memory-opened', '1');
        }
      } catch { /* ignore */ }
    }
    return { calendar: true, scene: true, memory: openMemory, nudges: false };
  });
  const toggle = (key: keyof typeof open) => {
    setOpen((o) => ({ ...o, [key]: !o[key] }));
    if (key === 'memory') {
      try { localStorage.setItem('sw-direct-memory-opened', '1'); } catch { /* ignore */ }
    }
  };
  // Wrap presence for prune UI; recap-bearing for director-cap badges (matches prompts).
  const priorForPrune = useLiveQuery(
    async () => {
      const all = await db.episodes.where('seasonId').equals(props.season.id).toArray();
      return all
        .filter((e) => e.number < props.episode.number && !!e.wrap)
        .sort((a, b) => a.number - b.number)
        .slice(-3);
    },
    [props.season.id, props.episode.number]
  ) ?? [];
  const priorForCaps = useLiveQuery(
    async () => {
      const all = await db.episodes.where('seasonId').equals(props.season.id).toArray();
      return all
        .filter((e) => e.number < props.episode.number && e.status === 'ended' && !!e.wrap?.recap?.trim())
        .sort((a, b) => a.number - b.number)
        .slice(-3);
    },
    [props.season.id, props.episode.number]
  ) ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, overflow: 'auto' }}>
      <DirectorAccordion title="calendar" open={open.calendar} onToggle={() => toggle('calendar')} labelSize={labelSize}>
        <CalendarTrackerPanel
          world={props.world} season={props.season} episode={props.episode}
          narrow={!!props.narrow}
        />
      </DirectorAccordion>
      <DirectorAccordion title="scene" open={open.scene} onToggle={() => toggle('scene')} labelSize={labelSize}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <SceneCastPanel episode={props.episode} characters={props.characters} accent={props.accent} onGoCast={props.onGoCast} />
          <SceneLocationsPanel
            episode={props.episode} locations={props.locations} accent={props.accent}
            world={props.world} characters={props.characters} onGoLocations={props.onGoLocations}
          />
          <ScenePlatePanel episode={props.episode} bd={BACKDROPS.scene} />
        </div>
      </DirectorAccordion>
      <DirectorAccordion title="memory" open={open.memory} onToggle={() => toggle('memory')} labelSize={labelSize}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <RunningSummaryPanel episode={props.episode} />
          <PriorWrapMemoryPanel priorEpisodes={priorForPrune} />
          <PlotTargetsPanel episode={props.episode} season={props.season} />
          <div style={{ fontSize: 11.5, lineHeight: 1.45, opacity: 0.45, color: '#eceae6' }}>
            Older worlds may still have walk-on effects filed as continuity facts — delete those separately if they linger.
          </div>
          <ContinuityPanel
            continuity={props.continuity} world={props.world} season={props.season} episode={props.episode}
            priorEpisodes={priorForCaps}
          />
          <ThreadsPanel threads={props.threads} episode={props.episode} priorEpisodes={priorForCaps} />
        </div>
      </DirectorAccordion>
      <DirectorAccordion title="nudges" open={open.nudges} onToggle={() => toggle('nudges')} labelSize={labelSize}>
        <NudgesPanel
          threads={props.threads}
          inScene={inScene}
          episodeTargets={props.episode.plotTargets}
          seasonTargets={props.season.plotTargets}
          onNudge={props.onNudge}
        />
      </DirectorAccordion>
    </div>
  );
}

/** Season calendar events — dated texture with spoil/hide + optional AI seed. */
function CalendarSeasonEventsPanel({ world, season }: { world: World; season: Season }) {
  const prefs = worldCalendarEventPrefs(world);
  const events = useLiveQuery(
    () => db.calendarEvents.where('seasonId').equals(season.id).toArray(),
    [season.id]
  ) ?? [];
  const cal = worldCalendar(world);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [peeked, setPeeked] = useState<Set<string>>(() => new Set());
  const [drafts, setDrafts] = useState<Array<SeedCalendarEventDraft & { keep: boolean }>>([]);
  const sorted = useMemo(
    () => [...events].sort((a, b) => a.storyDay - b.storyDay || a.title.localeCompare(b.title)),
    [events]
  );
  const dueCount = events.filter((e) => e.status === 'due').length;
  const scheduledCount = events.filter((e) => e.status === 'scheduled').length;
  const selectStyle: CSSProperties = {
    fontFamily: "'IBM Plex Mono', monospace", fontSize: 12,
    background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 8, padding: '6px 8px', color: '#f0eee9', width: '100%'
  };

  const patchPrefs = (patch: Partial<typeof prefs>) => {
    void safeWrite(
      () => db.worlds.update(world.id, {
        calendarEventPrefs: { ...prefs, ...patch },
        updatedAt: Date.now()
      }),
      setErr
    );
  };

  const addManual = () => {
    const ev = emptyCalendarEvent(
      world.id,
      season.id,
      {
        title: 'New beat',
        summary: '',
        kind: 'mundane',
        storyDay: cal.currentDay,
        visibility: prefs.defaultVisibility,
        source: 'manual'
      },
      { currentDay: cal.currentDay }
    );
    void safeWrite(async () => {
      await db.calendarEvents.add(ev);
      setEditId(ev.id);
    }, setErr);
  };

  const generate = async () => {
    setBusy(true);
    setErr('');
    try {
      const proposed = await seedSeasonCalendarEvents(world, season, { autoCommit: false });
      setDrafts(proposed.map((d) => ({ ...d, keep: true })));
      if (proposed.length === 0) {
        const active = events.filter((e) => e.status === 'scheduled' || e.status === 'due').length;
        setErr(`No room or no proposals — ${active}/${CALENDAR_EVENT_CAP} active. Cancel some events first.`);
      }
    } catch (e) {
      setErr(formatUserError(e));
    } finally {
      setBusy(false);
    }
  };

  const commitDrafts = () => {
    const kept = drafts.filter((d) => d.keep);
    if (kept.length === 0) {
      setDrafts([]);
      return;
    }
    void safeWrite(async () => {
      const active = events.filter((e) => e.status === 'scheduled' || e.status === 'due').length;
      const room = Math.max(0, CALENDAR_EVENT_CAP - active);
      if (room === 0) {
        setErr(`Season already has ${CALENDAR_EVENT_CAP} active events.`);
        return;
      }
      const now = Date.now();
      const toAdd = kept.slice(0, room).map((d) => emptyCalendarEvent(
        world.id,
        season.id,
        {
          ...d,
          visibility: defaultVisibilityForKind(d.kind),
          source: 'ai-seed',
          createdAt: now,
          updatedAt: now
        },
        { currentDay: cal.currentDay }
      ));
      await db.calendarEvents.bulkAdd(toAdd);
      setDrafts([]);
      if (kept.length > room) {
        setErr(`Committed ${room}; ${kept.length - room} skipped (cap ${CALENDAR_EVENT_CAP}).`);
      }
    }, setErr);
  };

  const patchEvent = (id: string, patch: Partial<CalendarEvent>) => {
    void safeWrite(
      () => db.calendarEvents.update(id, { ...patch, updatedAt: Date.now() }),
      setErr
    );
  };

  const deleteEvent = (ev: CalendarEvent) => {
    void safeWrite(async () => {
      await recordTombstones([{
        table: 'calendarEvents',
        id: ev.id,
        worldId: ev.worldId,
        seasonId: ev.seasonId,
        payload: ev
      }]);
      await db.calendarEvents.delete(ev.id);
      setEditId((cur) => (cur === ev.id ? null : cur));
    }, setErr);
  };

  const togglePeek = (id: string) => {
    setPeeked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div style={{
      marginTop: 8, paddingTop: 14, borderTop: '1px solid rgba(255,255,255,0.1)',
      display: 'flex', flexDirection: 'column', gap: 12
    }}>
      <Mono style={{ fontSize: 9 }}>
        season calendar · {dueCount} due · {scheduledCount} scheduled
      </Mono>
      <div style={{ fontSize: 12, lineHeight: 1.45, color: 'rgba(236,234,230,0.5)' }}>
        Dated texture as the calendar ticks. Peek shows a summary once; visibility is the lasting spoil policy.
        The narrator always gets the full beat when due.
      </div>

      {err && <ErrorNote error={err} onDismiss={() => setErr('')} />}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
          <Toggle label="Enable calendar events" on={prefs.enabled} onClick={() => patchPrefs({ enabled: !prefs.enabled })} />
          enable calendar events
        </label>
        {!prefs.enabled && (
          <Mono style={{ fontSize: 10, opacity: 0.5 }}>Ignored by narrator while off.</Mono>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
          <Toggle label="AI-seed calendar on season start" on={prefs.aiSeedOnSeasonStart} onClick={() => patchPrefs({ aiSeedOnSeasonStart: !prefs.aiSeedOnSeasonStart })} />
          AI-seed on season start
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Mono style={{ fontSize: 8, opacity: 0.5 }}>default visibility</Mono>
          <select
            value={prefs.defaultVisibility}
            onChange={(e) => patchPrefs({ defaultVisibility: e.target.value as CalendarEventVisibility })}
            style={selectStyle}
          >
            {CALENDAR_EVENT_VISIBILITIES.map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        </label>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <button className="btn-ghost" style={{ fontSize: 12, minHeight: 36 }} onClick={addManual} disabled={!prefs.enabled || busy}>
          Add event
        </button>
        <button className="btn-ghost" style={{ fontSize: 12, minHeight: 36 }} onClick={() => void generate()} disabled={!prefs.enabled || busy}>
          Generate season texture
        </button>
        {busy && <Spinner label="seeding calendar" />}
      </div>

      {drafts.length > 0 && (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 8, padding: 12,
          border: '1px solid rgba(255,255,255,0.12)', borderRadius: 11,
          background: 'rgba(255,255,255,0.04)'
        }}>
          <Mono style={{ fontSize: 9 }}>review generated</Mono>
          {drafts.map((d, i) => (
            <div key={i} style={{ opacity: d.keep ? 1 : 0.4, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{d.title} · day {d.storyDay} · {d.kind}</div>
              <div style={{ fontSize: 12, opacity: 0.65 }}>{d.summary}</div>
              <KeepDropChips
                keep={d.keep}
                onKeep={() => setDrafts((rows) => rows.map((r, j) => j === i ? { ...r, keep: true } : r))}
                onDrop={() => setDrafts((rows) => rows.map((r, j) => j === i ? { ...r, keep: false } : r))}
              />
            </div>
          ))}
          <button className="btn-primary" style={{ minHeight: 40 }} onClick={commitDrafts}>Commit kept</button>
          <button className="btn-quiet" style={{ fontSize: 12 }} onClick={() => setDrafts([])}>Discard</button>
        </div>
      )}

      {sorted.length === 0 && prefs.enabled && (
        <div style={{ fontSize: 12, opacity: 0.55, lineHeight: 1.45 }}>
          No events yet this season.{' '}
          <button className="btn-quiet" style={{ fontSize: 12 }} onClick={addManual}>Add event</button>
          {' · '}
          <button className="btn-quiet" style={{ fontSize: 12 }} onClick={() => void generate()} disabled={busy}>
            Generate…
          </button>
        </div>
      )}
      {sorted.length === 0 && !prefs.enabled && (
        <div style={{ fontSize: 12, opacity: 0.45 }}>Enable calendar events to add season texture.</div>
      )}

      {sorted.map((ev) => {
        const open = editId === ev.id;
        const peekedOn = peeked.has(ev.id);
        const settled = ev.status === 'played' || ev.status === 'missed' || ev.status === 'cancelled';
        const hiddenCollapsed = ev.visibility === 'hidden' && !peekedOn && !open;
        const title = hiddenCollapsed ? 'Hidden beat' : (ev.title || '(untitled)');
        const showSummary = ev.visibility === 'spoiler' || peekedOn;
        return (
          <div key={ev.id} style={{
            border: '1px solid rgba(255,255,255,0.1)', borderRadius: 11, padding: '12px 14px',
            background: 'rgba(255,255,255,0.04)', display: 'flex', flexDirection: 'column', gap: 8,
            opacity: settled ? 0.45 : 1
          }}>
            <button
              type="button"
              onClick={() => setEditId(open ? null : ev.id)}
              style={{
                border: 0, background: 'transparent', color: 'inherit', textAlign: 'left',
                cursor: 'pointer', padding: 0, display: 'flex', flexDirection: 'column', gap: 2
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 600 }}>
                {formatStoryDateShort(cal, ev.storyDay)} · {title}
              </span>
              <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, opacity: 0.45 }}>
                {hiddenCollapsed
                  ? ev.status
                  : `${ev.status}${ev.kind ? ` · ${ev.kind}` : ''}${ev.scale !== 'small' ? ` · ${ev.scale}` : ''}`}
              </span>
              {showSummary && !hiddenCollapsed && ev.summary.trim() && (
                <span style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>{ev.summary}</span>
              )}
            </button>
            {(ev.visibility === 'hidden' || ev.visibility === 'title') && (
              <button className="btn-quiet" style={{ fontSize: 11, alignSelf: 'flex-start' }}
                onClick={() => togglePeek(ev.id)}>
                {peekedOn ? 'Hide peek' : 'Peek'}
              </button>
            )}
            {open && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <input
                  value={ev.title}
                  onChange={(e) => patchEvent(ev.id, { title: e.target.value })}
                  placeholder="Title"
                  style={{ fontSize: 13 }}
                />
                <textarea
                  rows={3}
                  value={ev.summary}
                  onChange={(e) => patchEvent(ev.id, { summary: e.target.value })}
                  placeholder="Full beat (model always sees this when due)"
                  style={{ fontSize: 12.5, lineHeight: 1.45 }}
                />
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <Mono style={{ fontSize: 8, opacity: 0.5 }}>kind</Mono>
                  <select value={ev.kind} onChange={(e) => patchEvent(ev.id, { kind: e.target.value as CalendarEventKind })} style={selectStyle}>
                    {CALENDAR_EVENT_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                  </select>
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <Mono style={{ fontSize: 8, opacity: 0.5 }}>scale</Mono>
                  <select value={ev.scale} onChange={(e) => patchEvent(ev.id, { scale: e.target.value as CalendarEventScale })} style={selectStyle}>
                    {CALENDAR_EVENT_SCALES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <Mono style={{ fontSize: 8, opacity: 0.5 }}>visibility (lasting)</Mono>
                  <select value={ev.visibility} onChange={(e) => patchEvent(ev.id, { visibility: e.target.value as CalendarEventVisibility })} style={selectStyle}>
                    {CALENDAR_EVENT_VISIBILITIES.map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <Mono style={{ fontSize: 8, opacity: 0.5 }}>prompt policy</Mono>
                  <select value={ev.promptPolicy} onChange={(e) => patchEvent(ev.id, { promptPolicy: e.target.value as 'soft' | 'hard' })} style={selectStyle}>
                    <option value="soft">soft</option>
                    <option value="hard">hard</option>
                  </select>
                </label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {(['scheduled', 'due', 'played', 'cancelled'] as const).map((st) => (
                    <button
                      key={st}
                      type="button"
                      className="btn-quiet"
                      style={{ fontSize: 11, opacity: ev.status === st ? 1 : 0.55, fontWeight: ev.status === st ? 600 : 500 }}
                      onClick={() => patchEvent(ev.id, { status: st })}
                    >
                      {st}
                    </button>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                    day
                    <input
                      type="number"
                      min={1}
                      value={ev.storyDay}
                      onChange={(e) => patchEvent(ev.id, { storyDay: Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
                      style={{ width: 72, fontFamily: "'IBM Plex Mono', monospace", fontSize: 12 }}
                    />
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                    end day
                    <input
                      type="number"
                      min={ev.storyDay}
                      value={ev.endDay ?? ''}
                      placeholder="—"
                      onChange={(e) => {
                        const v = e.target.value.trim();
                        if (!v) {
                          patchEvent(ev.id, { endDay: undefined });
                          return;
                        }
                        const n = Math.floor(Number(v));
                        if (Number.isFinite(n) && n >= ev.storyDay) patchEvent(ev.id, { endDay: n });
                      }}
                      style={{ width: 72, fontFamily: "'IBM Plex Mono', monospace", fontSize: 12 }}
                    />
                  </label>
                </div>
                <button className="btn-quiet" style={{ fontSize: 11, alignSelf: 'flex-start' }}
                  onClick={() => deleteEvent(ev)}>
                  Delete
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Controllable in-fiction calendar: day / month / year, weekday, episode stamp. */
function CalendarTrackerPanel({
  world, season, episode, narrow
}: {
  world: World;
  season: Season;
  episode: Episode;
  narrow?: boolean;
}) {
  const cal = worldCalendar(world);
  const today = partsForDay(cal, cal.currentDay);
  const epDay = episode.storyDay && episode.storyDay > 0 ? episode.storyDay : cal.currentDay;
  const loc = episode.location.trim() || 'no location set';
  const [calError, setCalError] = useState('');
  const [setupOpen, setSetupOpen] = useState(false);
  // Number fields draft locally; commit on blur/Enter (avoids intermediate DB writes).
  const [dayDraft, setDayDraft] = useState(String(today.dayOfMonth));
  const [yearDraft, setYearDraft] = useState(String(today.year));
  const [absDraft, setAbsDraft] = useState(String(cal.currentDay));
  const [dayOneDateDraft, setDayOneDateDraft] = useState(String(cal.dayOneDate));
  const [advanceDraft, setAdvanceDraft] = useState(String(cal.episodeAdvanceDays));
  useEffect(() => { setDayDraft(String(today.dayOfMonth)); }, [today.dayOfMonth, world.id]);
  useEffect(() => { setYearDraft(String(today.year)); }, [today.year, world.id]);
  useEffect(() => { setAbsDraft(String(cal.currentDay)); }, [cal.currentDay, world.id]);
  useEffect(() => { setDayOneDateDraft(String(cal.dayOneDate)); }, [cal.dayOneDate, world.id]);
  useEffect(() => { setAdvanceDraft(String(cal.episodeAdvanceDays)); }, [cal.episodeAdvanceDays, world.id]);

  const inputStyle: CSSProperties = {
    fontFamily: "'IBM Plex Mono', monospace", fontSize: 12,
    background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 8, padding: '6px 8px', color: '#f0eee9'
  };
  const ymdGrid = narrow ? '1fr' : '1fr 1.4fr 0.9fr';
  const day1Grid = narrow ? '1fr' : '1.4fr 0.9fr';

  const patchCal = (p: Parameters<typeof calendarPatch>[1]) => {
    setCalError('');
    void safeWrite(
      () => db.worlds.update(world.id, { calendar: calendarPatch(world, p), updatedAt: Date.now() }),
      setCalError
    );
  };

  // Stamp open day once for legacy episodes — do not re-stamp when "today" moves.
  useEffect(() => {
    if (episode.storyDay == null || episode.storyDay < 1) {
      void safeWrite(
        () => db.episodes.update(episode.id, { storyDay: cal.currentDay, updatedAt: Date.now() }),
        setCalError
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when episode id / missing storyDay
  }, [episode.id, episode.storyDay]);

  const setDay = (day: number) => {
    const next = Math.max(1, Math.floor(day));
    const fromDay = cal.currentDay;
    setCalError('');
    void safeWrite(async () => {
      await db.worlds.update(world.id, {
        calendar: calendarPatch(world, { currentDay: next }),
        updatedAt: Date.now()
      });
      // Keep active episode scene day in sync when the author advances "today".
      if (episode.status === 'active') {
        await db.episodes.update(episode.id, { storyDay: next, updatedAt: Date.now() });
      }
      if (next > fromDay) {
        await evaluateCalendarEvents({
          worldId: world.id,
          seasonId: season.id,
          fromDay,
          toDay: next,
          mode: 'advance',
          world
        });
      }
    }, setCalError);
  };

  const setParts = (year: number, monthIndex: number, dayOfMonth: number) => {
    setDay(dayFromParts(cal, year, monthIndex, dayOfMonth));
  };

  const monthLen = cal.monthLengths[today.monthIndex] ?? 30;

  const commitDayDraft = () => {
    const n = Math.max(1, Math.min(monthLen, Math.floor(Number(dayDraft) || 1)));
    setDayDraft(String(n));
    if (n !== today.dayOfMonth) setParts(today.year, today.monthIndex, n);
  };
  const commitYearDraft = () => {
    const n = Math.floor(Number(yearDraft) || cal.yearOne);
    setYearDraft(String(n));
    if (n !== today.year) setParts(n, today.monthIndex, today.dayOfMonth);
  };
  const commitAbsDraft = () => {
    const n = Math.max(1, Math.floor(Number(absDraft) || 1));
    setAbsDraft(String(n));
    if (n !== cal.currentDay) setDay(n);
  };
  const commitDayOneDateDraft = () => {
    const max = cal.monthLengths[cal.dayOneMonth] ?? 30;
    const n = Math.max(1, Math.min(max, Math.floor(Number(dayOneDateDraft) || 1)));
    setDayOneDateDraft(String(n));
    if (n !== cal.dayOneDate) patchCal({ dayOneDate: n });
  };
  const setAdvance = (n: number) => {
    patchCal({ episodeAdvanceDays: Math.max(0, Math.min(365, Math.floor(n))) });
  };
  const commitAdvanceDraft = () => {
    const n = Math.max(0, Math.min(365, Math.floor(Number(advanceDraft) || 0)));
    setAdvanceDraft(String(n));
    if (n !== cal.episodeAdvanceDays) setAdvance(n);
  };

  const onNumKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') e.currentTarget.blur();
  };

  const setDayOneWeekday = (idx: number) => {
    patchCal({ dayOneWeekday: idx });
  };

  const stampEpisodeDay = () => {
    setCalError('');
    void safeWrite(
      () => db.episodes.update(episode.id, { storyDay: cal.currentDay, updatedAt: Date.now() }),
      setCalError
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Mono style={{ fontSize: 9 }}>calendar tracker</Mono>
      {calError && <ErrorNote error={calError} onDismiss={() => setCalError('')} />}
      <div style={{
        border: '1px solid rgba(255,255,255,0.1)', borderRadius: 14, padding: '14px 14px',
        background: 'rgba(255,255,255,0.04)', display: 'flex', flexDirection: 'column', gap: 12
      }}>
        <div className="serif" style={{ fontSize: 20, lineHeight: 1.3, color: '#f0eee9' }}>
          {formatStoryDateShort(cal, cal.currentDay)}
        </div>
        <div style={{ fontSize: 12.5, lineHeight: 1.45, opacity: 0.65, color: '#eceae6' }}>
          Absolute day {cal.currentDay} · S{season.number} · E{episode.number} · {loc}
          <br />
          Episode opened {formatStoryDateShort(cal, epDay)}
          {episode.storyDayEnd ? ` → ended ${formatStoryDateShort(cal, episode.storyDayEnd)}` : ''}
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <Chip onClick={() => setDay(cal.currentDay - 1)}>−1</Chip>
          <Chip onClick={() => setDay(cal.currentDay + 1)}>+1 day</Chip>
          <Chip onClick={() => setDay(cal.currentDay + 7)}>+7</Chip>
          <Chip onClick={() => setDay(advanceMonths(cal, cal.currentDay, 1))}>+1 month</Chip>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: ymdGrid, gap: 8 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <Mono style={{ fontSize: 8, opacity: 0.5 }}>day</Mono>
            <input
              type="number"
              min={1}
              max={monthLen}
              value={dayDraft}
              onChange={(e) => setDayDraft(e.target.value)}
              onBlur={commitDayDraft}
              onKeyDown={onNumKeyDown}
              style={inputStyle}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <Mono style={{ fontSize: 8, opacity: 0.5 }}>month</Mono>
            <select
              value={today.monthIndex}
              onChange={(e) => setParts(today.year, Number(e.target.value), today.dayOfMonth)}
              style={{ ...inputStyle, width: '100%' }}
            >
              {cal.months.map((name, i) => (
                <option key={name + i} value={i}>{name}</option>
              ))}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <Mono style={{ fontSize: 8, opacity: 0.5 }}>year</Mono>
            <input
              type="number"
              value={yearDraft}
              onChange={(e) => setYearDraft(e.target.value)}
              onBlur={commitYearDraft}
              onKeyDown={onNumKeyDown}
              style={inputStyle}
            />
          </label>
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, opacity: 0.75 }}>
          absolute day
          <input
            type="number"
            min={1}
            value={absDraft}
            onChange={(e) => setAbsDraft(e.target.value)}
            onBlur={commitAbsDraft}
            onKeyDown={onNumKeyDown}
            style={{ ...inputStyle, width: 72 }}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Mono style={{ fontSize: 8, opacity: 0.5 }}>days to advance when episode ends</Mono>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            {[0, 1, 2, 7, 14].map((n) => (
              <Chip key={n} active={cal.episodeAdvanceDays === n} onClick={() => setAdvance(n)}>
                {n === 0 ? 'same day' : n === 1 ? '+1 day' : `+${n}`}
              </Chip>
            ))}
            <input
              type="number"
              min={0}
              max={365}
              value={advanceDraft}
              onChange={(e) => setAdvanceDraft(e.target.value)}
              onBlur={commitAdvanceDraft}
              onKeyDown={onNumKeyDown}
              style={{ ...inputStyle, width: 64 }}
              title="Custom advance days"
            />
          </div>
        </label>

        {epDay !== cal.currentDay && (
          <button className="btn-ghost" style={{ fontSize: 11, alignSelf: 'flex-start' }} onClick={stampEpisodeDay}>
            Stamp episode open day → {formatStoryDateShort(cal, cal.currentDay)}
          </button>
        )}

        <button
          type="button"
          className="btn-quiet"
          style={{ fontSize: 11, alignSelf: 'flex-start' }}
          onClick={() => setSetupOpen((o) => !o)}
        >
          {setupOpen ? 'Hide calendar setup' : 'Calendar setup'}
        </button>

        {setupOpen && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 4 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <Mono style={{ fontSize: 8, opacity: 0.5 }}>weekday of day 1</Mono>
              <select
                value={cal.dayOneWeekday}
                onChange={(e) => setDayOneWeekday(Number(e.target.value))}
                style={{ ...inputStyle, width: '100%', fontSize: 13, padding: '8px 10px' }}
              >
                {cal.weekdays.map((name, i) => (
                  <option key={name + i} value={i}>
                    Day 1 = {name} → today {weekdayForDay({ ...cal, dayOneWeekday: i }, cal.currentDay)}
                  </option>
                ))}
              </select>
            </label>

            <div style={{ display: 'grid', gridTemplateColumns: day1Grid, gap: 8 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <Mono style={{ fontSize: 8, opacity: 0.5 }}>month of day 1</Mono>
                <select
                  value={cal.dayOneMonth}
                  onChange={(e) => patchCal({ dayOneMonth: Number(e.target.value) })}
                  style={{ ...inputStyle, width: '100%' }}
                >
                  {cal.months.map((name, i) => (
                    <option key={name + i} value={i}>{name}</option>
                  ))}
                </select>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <Mono style={{ fontSize: 8, opacity: 0.5 }}>date of day 1</Mono>
                <input
                  type="number"
                  min={1}
                  max={cal.monthLengths[cal.dayOneMonth] ?? 30}
                  value={dayOneDateDraft}
                  onChange={(e) => setDayOneDateDraft(e.target.value)}
                  onBlur={commitDayOneDateDraft}
                  onKeyDown={onNumKeyDown}
                  style={inputStyle}
                />
              </label>
            </div>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <Mono style={{ fontSize: 8, opacity: 0.5 }}>calendar system (optional notes)</Mono>
              <textarea
                key={world.id + '-dir-cal-system'}
                rows={2}
                defaultValue={cal.system}
                onBlur={(e) => patchCal({ system: e.target.value })}
                placeholder="Feast days, era name — narrator follows this verbatim. Month lengths are fixed (no leap days)."
                style={{ fontSize: 12.5, lineHeight: 1.45, color: '#eceae6' }}
              />
            </label>
            <div style={{ fontSize: 11.5, opacity: 0.45, lineHeight: 1.4 }}>
              Story day 1 is the earliest date ({cal.dayOneDate} {cal.months[cal.dayOneMonth]} Y{cal.yearOne}). Dates before that clamp to day 1.
              Advancing today on an active episode also stamps the episode open day.
            </div>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <Mono style={{ fontSize: 8, opacity: 0.5 }}>months (comma-separated)</Mono>
              <input
                key={world.id + '-months'}
                defaultValue={cal.months.join(', ')}
                onBlur={(e) => {
                  const months = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
                  if (months.length === 0) return;
                  const monthLengths = months.map((_, i) => cal.monthLengths[i] ?? 30);
                  patchCal({
                    months,
                    monthLengths,
                    dayOneMonth: Math.min(cal.dayOneMonth, months.length - 1)
                  });
                }}
                style={{ fontSize: 12.5, color: '#eceae6' }}
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <Mono style={{ fontSize: 8, opacity: 0.5 }}>days per month (comma-separated, same order)</Mono>
              <input
                key={world.id + '-month-lengths'}
                defaultValue={cal.monthLengths.join(', ')}
                onBlur={(e) => {
                  const monthLengths = e.target.value.split(',').map((s) => Math.max(1, Math.min(90, Number(s.trim()) || 30)));
                  if (monthLengths.length === 0) return;
                  while (monthLengths.length < cal.months.length) monthLengths.push(30);
                  patchCal({ monthLengths: monthLengths.slice(0, cal.months.length) });
                }}
                style={{ fontSize: 12.5, color: '#eceae6' }}
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <Mono style={{ fontSize: 8, opacity: 0.5 }}>custom weekdays (comma-separated)</Mono>
              <input
                key={world.id + '-weekdays'}
                defaultValue={cal.weekdays.join(', ')}
                onBlur={(e) => {
                  const weekdays = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
                  if (weekdays.length === 0) return;
                  patchCal({
                    weekdays,
                    dayOneWeekday: Math.min(cal.dayOneWeekday, weekdays.length - 1)
                  });
                }}
                style={{ fontSize: 12.5, color: '#eceae6' }}
              />
            </label>
          </div>
        )}
      </div>

      <CalendarSeasonEventsPanel world={world} season={season} />
    </div>
  );
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
        border: `1px solid ${active ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.11)'}`,
        background: active ? ACCENT_RGBA.a85 : 'rgba(255,255,255,0.05)',
        color: active ? '#0a1416' : 'rgba(230,233,235,0.62)',
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
            fontFamily: 'Spectral, serif', fontSize: 15.5, lineHeight: 1.65, color: '#f0eee9',
            width: '100%', background: 'rgba(255,255,255,0.04)'
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
            fontFamily: 'Spectral, serif', fontSize: 14.5, lineHeight: 1.6, color: '#f0eee9',
            width: '100%', background: 'rgba(255,255,255,0.04)'
          }}
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Mono style={{ fontSize: 9 }}>episode date</Mono>
        <div style={{
          border: '1px solid rgba(255,255,255,0.1)', borderRadius: 14, padding: '12px 14px',
          background: 'rgba(255,255,255,0.04)', display: 'flex', flexDirection: 'column', gap: 10
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
                style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, color: '#f0eee9' }}
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
                style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, color: '#f0eee9' }}
              />
            </label>
          </div>
          <textarea
            rows={2}
            value={draft.dateNote}
            onChange={(e) => onChange({ ...draft, dateNote: e.target.value })}
            placeholder="How time passed — overnight, two days on the road, same afternoon…"
            style={{ fontSize: 13, lineHeight: 1.5, color: '#eceae6', background: 'transparent', border: 0, padding: 0 }}
          />

          <div style={{
            borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 12,
            display: 'flex', flexDirection: 'column', gap: 10
          }}>
            <Mono style={{ fontSize: 8, opacity: 0.5 }}>next episode opens</Mono>
            <div className="serif" style={{ fontSize: 17, color: '#f0eee9' }}>
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
                    background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(255,255,255,0.12)',
                    borderRadius: 8, padding: '6px 8px', color: '#f0eee9'
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
              border: '1px solid rgba(255,255,255,0.1)', borderRadius: 14, padding: '14px 14px',
              background: 'rgba(255,255,255,0.04)',
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
                style={{ fontSize: 13.5, lineHeight: 1.5, background: 'transparent', border: 0, padding: 0, color: '#eceae6' }}
              />
              <textarea
                rows={2}
                value={draft.place.atmosphere}
                onChange={(e) => onChange({
                  ...draft,
                  place: { ...draft.place!, atmosphere: e.target.value }
                })}
                placeholder="Weather / light for the next opening (optional)"
                style={{ fontSize: 12.5, lineHeight: 1.5, color: 'rgba(236,234,230,0.55)', background: 'transparent', border: 0, padding: 0 }}
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
              border: '1px solid rgba(255,255,255,0.1)', borderRadius: 14, padding: '14px 14px',
              background: 'rgba(255,255,255,0.04)',
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
                style={{ fontSize: 13, background: 'transparent', border: 0, padding: 0, color: '#f0eee9' }}
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
                style={{ fontSize: 13, lineHeight: 1.5, background: 'transparent', border: 0, padding: 0, color: '#eceae6' }}
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
            border: '1px solid rgba(255,255,255,0.1)', borderRadius: 14, padding: '14px 14px',
            background: 'rgba(255,255,255,0.04)',
            opacity: draft.meanwhileKeep ? 1 : 0.42
          }}>
            <textarea
              className="serif"
              rows={4}
              value={draft.meanwhile}
              onChange={(e) => onChange({ ...draft, meanwhile: e.target.value })}
              placeholder="Who waited, who travelled, what healed, what got worse…"
              style={{
                fontFamily: 'Spectral, serif', fontSize: 15, lineHeight: 1.6, color: '#f0eee9',
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
            border: '1px solid rgba(255,255,255,0.1)', borderRadius: 14, padding: '14px 14px',
            background: 'rgba(255,255,255,0.04)',
            opacity: b.keep ? 1 : 0.42
          }}>
            <textarea
              className="serif"
              rows={2}
              value={b.text}
              onChange={(e) => patchBeat(i, { text: e.target.value })}
              style={{ fontFamily: 'Spectral, serif', fontSize: 16, lineHeight: 1.45, background: 'transparent', border: 0, padding: 0, color: '#f0eee9' }}
            />
            <textarea
              rows={2}
              value={b.consequence}
              onChange={(e) => patchBeat(i, { consequence: e.target.value })}
              placeholder="what it leaves for later…"
              style={{ fontSize: 12.5, lineHeight: 1.5, color: 'rgba(236,234,230,0.55)', background: 'transparent', border: 0, padding: 0 }}
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
              border: '1px solid rgba(255,255,255,0.1)', borderRadius: 14, padding: '12px 14px',
              background: 'rgba(255,255,255,0.04)',
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
                style={{ fontSize: 13.5, lineHeight: 1.5, background: 'transparent', border: 0, padding: 0, color: '#eceae6' }}
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
              border: '1px solid rgba(255,255,255,0.1)', borderRadius: 14, padding: '12px 14px',
              background: 'rgba(255,255,255,0.04)',
              opacity: row.keep ? 1 : 0.42
            }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#eceae6' }}>{row.title}</div>
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
                border: '1px solid rgba(255,255,255,0.1)', borderRadius: 14, padding: '12px 14px',
                background: 'rgba(255,255,255,0.04)',
                opacity: row.keep ? 1 : 0.42
              }}>
                <textarea
                  rows={2}
                  value={row.text}
                  onChange={(e) => patchLine(key, i, { text: e.target.value })}
                  style={{ fontSize: 13.5, lineHeight: 1.5, background: 'transparent', border: 0, padding: 0, color: '#eceae6' }}
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
              border: '1px solid rgba(255,255,255,0.1)', borderRadius: 14, padding: '12px 14px',
              background: 'rgba(255,255,255,0.04)',
              opacity: u.keep ? 1 : 0.42
            }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#f0eee9' }}>{u.name}</div>
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
                      fontSize: 13, lineHeight: 1.4, color: '#eceae6',
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
              border: '1px solid rgba(255,255,255,0.1)', borderRadius: 14, padding: '12px 14px',
              background: 'rgba(255,255,255,0.04)',
              opacity: u.keep ? 1 : 0.42
            }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#f0eee9' }}>{u.name}</div>
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
                  style={{ fontSize: 13, lineHeight: 1.45, color: '#eceae6', background: 'transparent', border: 0, padding: 0 }}
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
                  style={{ fontSize: 13, color: '#eceae6', background: 'transparent', border: 0, padding: 0 }}
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
              border: '1px solid rgba(255,255,255,0.1)', borderRadius: 14, padding: '12px 14px',
              background: 'rgba(255,255,255,0.04)',
              opacity: u.keep ? 1 : 0.42
            }}>
              <div style={{ fontSize: 14, color: '#f0eee9' }}>
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
                style={{ fontSize: 13, color: '#eceae6', background: 'transparent', border: 0, padding: 0 }}
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
                style={{ fontSize: 13, lineHeight: 1.45, color: '#eceae6', background: 'transparent', border: 0, padding: 0 }}
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
