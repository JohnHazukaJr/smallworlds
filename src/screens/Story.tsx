import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  analyzeEpisode, commitEpisodeWrap, deleteTurnsAfter, deleteTurnsFrom, proseModelFor,
  rollbackTurnSnapshot, snapshotTurnsAfter, snapshotTurnsFrom, writeTurn,
  WriteAbortedError, type EpisodeWrapDraft, type StreamMeta
} from '../ai/engine';
import { parseSpeakSegments, type SpeakSegment } from '../ai/dialogueFormat';
import { generateSceneImage } from '../ai/image';
import {
  episodeContextPressure, episodeHistoryChars, HISTORY_CHAR_BUDGET, resolveSpeakerName
} from '../ai/prompts';
import { WorldEditorSheet } from '../components/WorldEditorSheet';
import { db, guardStorage, recordTombstones, uid } from '../db';
import { AVATAR_PX, DEFAULT_DISPLAY, moodFromHue, useApp, type AvatarSize, type StoryLayout } from '../store/app';
import type {
  Character, ComposeMode, ContinuityFact, Episode, EpisodeGuest, EpisodeWrapBeat,
  Location, OpenThread, Season, Turn, TurnLength, World
} from '../types';
import { AppError, classifyError, formatUserError } from '../errors';
import { Chip, ErrorNote, Mono, Sheet, Spinner, Toggle, useVw } from '../ui/bits';
import { fileToSceneImage } from '../ui/image';
import { avatarStyle, BACKDROPS, MOODS, STRIPE } from '../ui/theme';
import {
  calendarPatch, characterPortraits, dayFromParts, emptyLocation, formatStoryDate,
  advanceMonths, formatStoryDateShort, nextEpisode, partsForDay, weekdayForDay, worldCalendar
} from '../worldOps';

/** Editable wrap draft with Keep/Drop flags for the review UI. */
interface WrapReviewDraft {
  recap: string;
  beats: Array<EpisodeWrapBeat & { keep: boolean }>;
  facts: Array<{ text: string; keep: boolean }>;
  threads: Array<{ text: string; keep: boolean }>;
  guestEffects: Array<{ text: string; keep: boolean }>;
  resolvedThreads: Array<{ text: string; keep: boolean }>;
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
}

function draftFromAnalysis(d: EpisodeWrapDraft): WrapReviewDraft {
  return {
    recap: d.recap,
    beats: d.beats.map((b) => ({ ...b, keep: true })),
    facts: d.facts.map((text) => ({ text, keep: true })),
    threads: d.threads.map((text) => ({ text, keep: true })),
    guestEffects: d.guestEffects.map((text) => ({ text, keep: true })),
    resolvedThreads: d.resolvedThreads.map((text) => ({ text, keep: true })),
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
    dateNote: d.dateNote
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
}

const DIALOGUE_RE = /^([A-Z][^:\n]{0,48}?):\s*["“](.+?)["”]?\s*$/;

function findByName(characters: Character[], name: string): Character | undefined {
  return characters.find((c) => c.name.toLowerCase() === name.toLowerCase().trim());
}

function portraitPlate(hue: number, size: number, portrait?: string | null, border = 'rgba(255,255,255,0.2)'): CSSProperties {
  return {
    ...avatarStyle(hue, size, border),
    ...(portrait ? { backgroundImage: `url(${portrait})`, backgroundSize: 'cover', backgroundPosition: 'center' } : {})
  };
}

function guestHue(guestId: string): number {
  let h = 0;
  for (let i = 0; i < guestId.length; i++) h = (h + guestId.charCodeAt(i) * 17) % 360;
  return h;
}

function parseTurn(turn: Turn, characters: Character[], guests: EpisodeGuest[] = []): ProseBlock[] {
  if (turn.role === 'user') {
    const player = characters.find((c) => c.isPlayer);
    if (turn.mode === 'speak') {
      return [{
        text: turn.text,
        speaker: player?.name ?? 'you',
        hue: player?.hue ?? 60,
        portrait: player ? characterPortraits(player)[0] : null,
        kind: 'speak',
        segments: parseSpeakSegments(turn.text)
      }];
    }
    if (turn.mode === 'act') {
      return [{
        text: turn.text,
        speaker: player?.name ?? 'you',
        hue: player?.hue ?? 60,
        portrait: player ? characterPortraits(player)[0] : null,
        kind: 'action'
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
  // Legacy narrator turns may still embed Name: "…" dialogue.
  return turn.text
    .split(/\n{2,}|\n(?=[A-Z][^:\n]{0,48}:\s*["“])/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p): ProseBlock => {
      const m = p.match(DIALOGUE_RE);
      if (m) {
        const who = findByName(characters, m[1]);
        return {
          text: m[2],
          speaker: m[1].trim(),
          hue: who?.hue,
          portrait: who ? characterPortraits(who)[0] : null,
          kind: 'speak',
          segments: [{ kind: 'speech', text: m[2] }]
        };
      }
      return { text: p, kind: 'narration' };
    });
}

function SpeakBody({
  segments, accent, prose, fontPx
}: {
  segments: SpeakSegment[];
  accent: string;
  prose: string;
  fontPx: number;
}) {
  return (
    <p className="serif" style={{ fontSize: fontPx, lineHeight: 1.78, margin: 0, textWrap: 'pretty' }}>
      {segments.map((seg, i) => {
        if (seg.kind === 'action') {
          return (
            <span
              key={i}
              style={{
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
              “{seg.text}”
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
    </p>
  );
}

function ProseBlockView({ b, accent, prose, fontPx, avatarPx }: {
  b: ProseBlock; accent: string; prose: string; fontPx: number; avatarPx: number;
}) {
  const isDialog = b.kind === 'dialogue' || b.kind === 'action' || b.kind === 'speak';
  return (
    <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', marginBottom: isDialog ? 24 : 22 }}>
      {isDialog && b.hue !== undefined && (
        <div style={{ ...portraitPlate(b.hue, avatarPx, b.portrait), marginTop: 4 }} />
      )}
      <div style={{
        flex: 1, minWidth: 0,
        ...(isDialog ? { borderLeft: `1px solid ${accent}55`, paddingLeft: 14 } : {})
      }}>
        {isDialog && b.speaker && (
          <div style={{
            fontFamily: "'IBM Plex Mono', monospace", fontSize: 9.5, letterSpacing: '0.14em',
            textTransform: 'uppercase', color: accent, marginBottom: 6
          }}>
            {b.speaker}{b.kind === 'action' ? ' · acts' : ''}
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
            {b.text}
          </p>
        )}
      </div>
    </div>
  );
}

// ---------- main screen ----------

export function Story() {
  const vw = useVw();
  const narrow = vw < 780;
  const { currentWorldId, layout, setLayout, mood, setMood, backdrop, setBackdrop, go, display, goLocations: openLocations } = useApp();
  const M = MOODS[mood];
  const BD = BACKDROPS[backdrop];
  const readMode = layout === 'read';
  const avatarPx = AVATAR_PX[display.avatarSize];
  const fontPx = readMode ? display.textSize + 1 : display.textSize;

  const world = useLiveQuery(
    async () => (currentWorldId ? db.worlds.get(currentWorldId) : undefined),
    [currentWorldId]
  );
  const season = useLiveQuery(
    async () => (world?.activeSeasonId ? db.seasons.get(world.activeSeasonId) : undefined),
    [world?.activeSeasonId]
  );
  const episode = useLiveQuery(
    async () => season
      ? db.episodes.where('seasonId').equals(season.id).filter((e) => e.status === 'active').first()
      : undefined,
    [season?.id]
  );
  const goLocations = () => openLocations(episode?.locationId ?? null);
  const turns = useLiveQuery(
    async () => (episode ? db.turns.where('episodeId').equals(episode.id).sortBy('createdAt') : []),
    [episode?.id]
  ) ?? [];
  const characters = useLiveQuery(
    async () => (world ? db.characters.where('worldId').equals(world.id).toArray() : []),
    [world?.id]
  ) ?? [];
  const locations = useLiveQuery(
    async () => (world ? db.locations.where('worldId').equals(world.id).toArray() : []),
    [world?.id]
  ) ?? [];
  const continuity = useLiveQuery(
    async () => (season ? db.continuity.where('seasonId').equals(season.id).toArray() : []),
    [season?.id]
  ) ?? [];
  const threads = useLiveQuery(
    async () => (season ? db.threads.where('seasonId').equals(season.id).filter((t) => t.status === 'open').toArray() : []),
    [season?.id]
  ) ?? [];

  // writing state
  const [composeMode, setComposeMode] = useState<ComposeMode>('continue');
  const [length, setLength] = useState<TurnLength>('scene');
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [partial, setPartial] = useState('');
  const [partialMeta, setPartialMeta] = useState<StreamMeta>({ role: 'narrator' });
  const [progressLabel, setProgressLabel] = useState('writing…');
  const [error, setError] = useState<string | AppError>('');
  const [notice, setNotice] = useState('');
  const wrapAbortRef = useRef<AbortController | null>(null);
  /** How many turns from the end are mounted — keeps long episodes responsive. */
  const [turnWindow, setTurnWindow] = useState(60);
  useEffect(() => { setTurnWindow(60); }, [episode?.id]);
  const [wrapOpen, setWrapOpen] = useState<null | 'episode' | 'season'>(null);
  const [wrapBusy, setWrapBusy] = useState(false);
  const [wrapPhase, setWrapPhase] = useState<'ready' | 'analyzing' | 'review'>('ready');
  const [wrapDraft, setWrapDraft] = useState<WrapReviewDraft | null>(null);
  const [directorSheet, setDirectorSheet] = useState(false);
  const [worldEditOpen, setWorldEditOpen] = useState(false);
  const [displayOpen, setDisplayOpen] = useState(false);
  const [moreSheet, setMoreSheet] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const [keyboardOffset, setKeyboardOffset] = useState(0);
  const [sceneFadeKey, setSceneFadeKey] = useState(0);
  /** Context-pressure nudge: dismiss until chars rise ~10% of budget or location changes. */
  const [nudgeDismissedAtChars, setNudgeDismissedAtChars] = useState(0);
  const [nudgeDismissedLocId, setNudgeDismissedLocId] = useState<string | null | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!narrow || !composerFocused) {
      setKeyboardOffset(0);
      return;
    }
    const vv = window.visualViewport;
    if (!vv) return;
    const sync = () => {
      const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      setKeyboardOffset(covered > 40 ? covered : 0);
    };
    sync();
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    return () => {
      vv.removeEventListener('resize', sync);
      vv.removeEventListener('scroll', sync);
    };
  }, [narrow, composerFocused]);

  const activeLocation = locations.find((l) => l.id === episode?.locationId)
    ?? locations.find((l) => episode?.location && l.name && episode.location.toLowerCase().includes(l.name.toLowerCase()));

  const episodeChars = useMemo(() => episodeHistoryChars(turns), [turns]);
  const pressure = episodeContextPressure(episodeChars);
  const locationShiftNudge = nudgeDismissedLocId !== undefined
    && (episode?.locationId ?? null) !== nudgeDismissedLocId
    && episodeChars >= HISTORY_CHAR_BUDGET * 0.25;
  const pressurePastDismiss = pressure !== 'ok'
    && episodeChars >= nudgeDismissedAtChars + HISTORY_CHAR_BUDGET * 0.1;
  const showWrapNudge = !!episode && turns.length > 0 && (
    (pressure !== 'ok' && (nudgeDismissedAtChars === 0 || pressurePastDismiss))
    || locationShiftNudge
  );

  useEffect(() => {
    setSceneFadeKey((k) => k + 1);
  }, [episode?.image, mood, episode?.locationId]);

  useEffect(() => {
    if (!readMode) setComposerOpen(true);
    else setComposerOpen(false);
  }, [readMode]);

  // Reset nudge baseline when the active episode changes.
  useEffect(() => {
    setNudgeDismissedAtChars(0);
    setNudgeDismissedLocId(episode?.locationId ?? null);
  }, [episode?.id]);

  // Fresh wrap sheet each time it opens or switches Episode/Season.
  useEffect(() => {
    setWrapPhase('ready');
    setWrapDraft(null);
    setWrapBusy(false);
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
    if (episode) void db.episodes.update(episode.id, { moodPinned: true });
  };

  const dismissWrapNudge = () => {
    setNudgeDismissedAtChars(episodeChars);
    setNudgeDismissedLocId(episode?.locationId ?? null);
  };

  /** Shared streaming runner behind write / rewrite / retry. */
  const runNarration = async (
    mode: ComposeMode,
    text: string
  ): Promise<{ status: 'ok' | 'error' | 'aborted'; beatsCompleted: number }> => {
    if (!world || !season || !episode) return { status: 'error', beatsCompleted: 0 };
    setError('');
    setNotice('');
    setStreaming(true);
    setPartial('');
    setPartialMeta({ role: 'narrator' });
    setProgressLabel('planning…');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await writeTurn({
        world, season, episode, mode, input: text, length,
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
        setNotice(
          n === 0
            ? 'Stopped before any reply — your line was not applied.'
            : `Stopped after ${n} beat${n === 1 ? '' : 's'}; incomplete beat discarded.`
        );
        return { status: 'aborted', beatsCompleted: n };
      }
      setError(classifyError(e));
      return { status: 'error', beatsCompleted: 0 };
    } finally {
      setStreaming(false);
      setProgressLabel('');
      abortRef.current = null;
    }
  };

  const write = async () => {
    if (!world || !season || !episode || streaming) return;
    if (composeMode !== 'continue' && !input.trim()) return;
    const text = input;
    setInput('');
    const result = await runNarration(composeMode, text);
    if (result.status === 'ok') {
      if (composeMode !== 'continue') setComposeMode('continue');
    } else if (result.status === 'error' || result.beatsCompleted === 0) {
      // Restore composer when nothing was applied (orphan user turn removed).
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
    const below = turns.length - idx - 1;
    const replaceSelf = turn.role === 'narrator' || turn.role === 'character';
    if (below > 0) {
      const msg = replaceSelf
        ? `Rewrite this response? The ${below} turn${below > 1 ? 's' : ''} after it will be replaced.`
        : `Retry from here? The ${below} turn${below > 1 ? 's' : ''} after this will be replaced.`;
      if (!confirm(msg)) return;
    }
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
    if (!confirm(`Delete the ${below} turn${below > 1 ? 's' : ''} below this one? This cannot be undone.`)) return;
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
      if (controller.signal.aborted) {
        setWrapPhase('ready');
        setNotice('Analyze cancelled.');
        return;
      }
      setWrapDraft(draftFromAnalysis(draft));
      setWrapPhase('review');
    } catch (e) {
      setWrapPhase('ready');
      if ((e as Error).name === 'AbortError' || controller.signal.aborted) {
        setNotice('Analyze cancelled.');
      } else {
        setError(classifyError(e));
      }
    } finally {
      setWrapBusy(false);
      if (wrapAbortRef.current === controller) wrapAbortRef.current = null;
    }
  };

  /** End without filing a wrap — used when analysis fails or the author opts out. */
  const skipWrapAndEnd = async () => {
    if (!episode) return;
    setWrapBusy(true);
    setError('');
    try {
      await nextEpisode(episode);
      resetAfterEpisodeEnd();
    } catch (e) {
      setError(classifyError(e));
    } finally {
      setWrapBusy(false);
    }
  };

  /** Commit kept wrap items, file continuity, open the next episode. */
  const confirmEpisodeWrap = async () => {
    if (!world || !season || !episode || !wrapDraft) return;
    setWrapBusy(true);
    setError('');
    try {
      await commitEpisodeWrap(world, season, episode, {
        recap: wrapDraft.recap,
        beats: wrapDraft.beats
          .filter((b) => b.keep && b.text.trim())
          .map(({ text, consequence }) => ({ text, consequence })),
        facts: wrapDraft.facts.filter((f) => f.keep).map((f) => f.text),
        threads: wrapDraft.threads.filter((t) => t.keep).map((t) => t.text),
        guestEffects: wrapDraft.guestEffects.filter((g) => g.keep).map((g) => g.text),
        resolvedThreads: wrapDraft.resolvedThreads.filter((t) => t.keep).map((t) => t.text),
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
        dateNote: wrapDraft.dateNote
      });
      resetAfterEpisodeEnd();
    } catch (e) {
      setError(classifyError(e));
    } finally {
      setWrapBusy(false);
    }
  };

  const blocks = useMemo(() => {
    const guestList = episode?.guests ?? [];
    const out: { turn: Turn; blocks: ProseBlock[] }[] = [];
    for (const t of turns) out.push({ turn: t, blocks: parseTurn(t, characters, guestList) });
    return out;
  }, [turns, characters, episode?.guests]);

  if (!world) {
    return (
      <div className="fade-in" style={{ padding: narrow ? '40px 20px' : '80px 60px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 560 }}>
        <Mono>no world open</Mono>
        <div className="serif" style={{ fontWeight: 300, fontSize: 30, color: '#f8f6f2' }}>Open a world to start writing.</div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn-primary" onClick={() => go('library')}>Go to Worlds</button>
        </div>
      </div>
    );
  }
  if (!season || !episode) {
    return <div style={{ padding: 60 }}><Spinner label="opening the world" /></div>;
  }

  const inScene = characters.filter((c) => episode.castIds.includes(c.id));
  const guests = episode.guests ?? [];
  const composerPlaceholder: Record<ComposeMode, string> = {
    continue: 'Press write on — the narrator takes the next beat from here.',
    steer: 'Tell the narrator what should happen, in your words. Everyone stays in character while it happens.',
    speak: '*smiles* "Hello." — looks and gestures in *stars*, spoken words in quotes.',
    act: 'You do something. No dialogue, no narration from you.'
  };
  const modeHint: Record<ComposeMode, string> = { continue: 'continue', steer: 'you direct', speak: 'you say', act: 'you do' };

  const directorContent = (
    <DirectorContent
      world={world} season={season} episode={episode} characters={characters} locations={locations}
      continuity={continuity} threads={threads} accent={M.accent} narrow={narrow}
      onGoLocations={goLocations}
      onNudge={(text) => { setComposeMode('steer'); setInput(text); setDirectorSheet(false); }}
    />
  );

  const shellHeight = narrow && !readMode
    ? 'calc(100dvh - 58px - env(safe-area-inset-bottom))'
    : '100dvh';
  const locLabel = (activeLocation?.name || episode.location || '')
    .split(',')[0].split('.')[0].toLowerCase();

  return (
    <div style={{
      position: 'relative',
      minHeight: narrow && !readMode ? 'auto' : '100dvh',
      height: shellHeight,
      display: 'flex',
      flexDirection: 'column',
      color: M.text,
      paddingBottom: keyboardOffset > 0 ? keyboardOffset : undefined
    }}>
      {/* backdrop — scene image when the episode has one, mood gradient otherwise */}
      {episode.image ? (
        <>
          <div
            key={`img-${sceneFadeKey}`}
            className={display.imageBlur > 0 ? 'scene-crossfade' : 'scene-crossfade scene-backdrop-drift'}
            style={{
              position: 'absolute', inset: 0, zIndex: 0,
              backgroundImage: `url(${episode.image})`, backgroundSize: 'cover', backgroundPosition: 'center',
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
        <>
          <div
            key={`mood-${sceneFadeKey}`}
            className="scene-crossfade"
            style={{
              position: 'absolute', inset: 0, zIndex: 0,
              background: `linear-gradient(160deg, ${BD.a}, ${BD.b}), ${STRIPE('rgba(255,255,255,0.05)', 'rgba(255,255,255,0.01)')}`,
              opacity: backdrop === 'none' ? 0.25 : 1, transition: 'opacity 0.45s ease'
            }}
          />
          <div style={{
            position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none',
            background: 'radial-gradient(720px 520px at 50% 40%, transparent, rgba(8,9,12,0.72) 78%), linear-gradient(180deg, rgba(8,9,12,0.5), rgba(8,9,12,0.2) 30%, rgba(8,9,12,0.6))',
            backdropFilter: 'blur(3px)'
          }} />
        </>
      )}

      {/* header — thin strip in Read mode */}
      {readMode ? (
        <div style={{
          position: 'relative', zIndex: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 12,
          paddingTop: narrow ? 'calc(10px + env(safe-area-inset-top))' : 11,
          paddingBottom: narrow ? 10 : 11,
          paddingLeft: narrow ? 14 : 22,
          paddingRight: narrow ? 14 : 22,
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          background: 'rgba(8,9,12,0.28)', backdropFilter: 'blur(18px) saturate(140%)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: M.accent, boxShadow: `0 0 12px ${M.accent}` }} />
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10.5, letterSpacing: '0.08em', opacity: 0.72, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {world.title.toLowerCase()} · ep {episode.number}{locLabel ? ` · ${locLabel}` : ''}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            {!narrow && showWrapNudge && (
              <button className="btn-ghost" style={{ padding: '7px 12px', fontSize: 11 }}
                onClick={() => setWrapOpen('episode')}>File episode?</button>
            )}
            <button className="btn-ghost" style={{ padding: '7px 12px', fontSize: 12 }}
              onClick={() => setComposerOpen((o) => !o)}>
              {composerOpen ? 'Hide' : 'Write'}
            </button>
            {narrow ? (
              <button className="btn-ghost" style={{ padding: '7px 12px', fontSize: 12 }}
                onClick={() => setMoreSheet(true)}>More</button>
            ) : (
              <>
                <button className="btn-ghost" style={{ padding: '7px 12px', fontSize: 12 }}
                  onClick={() => setDirectorSheet(true)}>Direct</button>
                <button className="btn-ghost" style={{ padding: '7px 12px', fontSize: 12 }}
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
          flexWrap: 'wrap', background: 'rgba(8,9,12,0.35)', backdropFilter: 'blur(22px) saturate(140%)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 13, minWidth: 0 }}>
            <div style={{ width: 9, height: 9, borderRadius: '50%', flexShrink: 0, background: M.accent, boxShadow: `0 0 16px ${M.accent}` }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              <div className="serif" style={{ fontSize: 16, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{world.title}</div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, letterSpacing: '0.1em', opacity: 0.5 }}>
                season {season.number} · episode {episode.number}{locLabel ? ` · ${locLabel}` : ''} · {formatStoryDate(worldCalendar(world), worldCalendar(world).currentDay).toLowerCase()} · {M.label.toLowerCase()}
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
            <button className="btn-ghost" style={{ padding: '7px 12px', fontSize: 11, minHeight: 36 }} onClick={() => setDirectorSheet(true)}>Direct</button>
            <button className="btn-ghost" style={{ padding: '7px 12px', fontSize: 11, minHeight: 36 }} onClick={() => setWrapOpen('episode')}>Wrap</button>
            {narrow ? (
              <button className="btn-ghost" style={{ padding: '7px 12px', fontSize: 11, minHeight: 36 }} onClick={() => setMoreSheet(true)}>More</button>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10, padding: '6px 9px', background: 'rgba(255,255,255,0.05)' }}>
                  <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', opacity: 0.45 }}>backdrop</span>
                  {(Object.keys(BACKDROPS) as Array<keyof typeof BACKDROPS>).map((id) => (
                    <Chip key={id} active={backdrop === id} accent={M.accent} onClick={() => setBackdrop(id)}>
                      {id === 'none' ? 'Off' : id[0].toUpperCase() + id.slice(1)}
                    </Chip>
                  ))}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10, padding: '6px 9px', background: 'rgba(255,255,255,0.05)' }}>
                  <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', opacity: 0.45 }}>
                    mood{episode.moodPinned ? ' · pinned' : ''}
                  </span>
                  {(Object.entries(MOODS) as Array<[typeof mood, typeof M]>).map(([id, m]) => (
                    <button key={id} title={m.label} onClick={() => pinMood(id)} style={{
                      width: 28, height: 28, borderRadius: '50%', cursor: 'pointer', background: m.accent,
                      border: `2px solid ${mood === id ? 'rgba(255,255,255,0.85)' : 'transparent'}`,
                      opacity: mood === id ? 1 : 0.45, padding: 0
                    }} />
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
          <div style={{
            maxWidth: 740,
            margin: display.textScrim > 0 ? '18px auto' : '0 auto',
            width: display.textScrim > 0 ? 'calc(100% - 24px)' : '100%',
            padding: narrow ? '26px 18px 40px' : '52px 28px 76px',
            // Optional plate behind the text so prose stays readable over scene images.
            ...(display.textScrim > 0 ? {
              background: `rgba(8,9,12,${(display.textScrim / 100).toFixed(2)})`,
              borderRadius: 20,
              backdropFilter: 'blur(10px)'
            } : {})
          }}>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase', opacity: 0.42, marginBottom: 24 }}>
              season {numberWord(season.number)}, episode {numberWord(episode.number)}{episode.title ? ` — ${episode.title.toLowerCase()}` : ''}
            </div>

            {season.bible && turns.length === 0 && (
              <div className="glass" style={{ padding: '16px 18px', marginBottom: 26 }}>
                <Mono style={{ marginBottom: 8 }}>previously</Mono>
                <p className="serif" style={{ fontSize: 15.5, lineHeight: 1.7, margin: 0, color: 'rgba(236,234,230,0.75)' }}>{season.bible.recap}</p>
              </div>
            )}

            {turns.length === 0 && !streaming && (
              <div style={{ opacity: 0.55, fontSize: 14, lineHeight: 1.7 }}>
                <p className="serif" style={{ fontSize: 17 }}>
                  {season.premise
                    ? <>Current pressure: <em>{season.premise}</em></>
                    : 'A blank page. Steer, speak, act — or just press Write and see where the story opens.'}
                </p>
              </div>
            )}

            {blocks.length > turnWindow && (
              <div style={{ marginBottom: 22 }}>
                <button
                  className="btn-ghost"
                  style={{ fontSize: 11, padding: '8px 14px' }}
                  onClick={() => setTurnWindow((n) => n + 60)}
                >
                  Show earlier turns ({blocks.length - turnWindow} hidden)
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
                streaming={streaming}
                hasBelow={ti < visible.length - 1 || streaming}
                onRetry={() => void retryFrom(turn)}
                onDeleteBelow={() => void deleteBelow(turn)}
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
                text: partial,
                createdAt: 0
              }, characters, guests)
                .map((b, i) => <ProseBlockView key={`p${i}`} b={b} accent={M.accent} prose={M.prose} fontPx={fontPx} avatarPx={avatarPx} />)
            )}

            {streaming && (
              <div style={{ marginTop: 22 }}>
                <Spinner accent={M.accent} label={progressLabel || 'writing…'} />
              </div>
            )}

          </div>
        </section>
      </div>

      {/* composer — collapses to a handle in Read mode */}
      {readMode && !composerOpen ? (
        <div style={{
          position: 'relative', zIndex: 2, display: 'flex', justifyContent: 'center',
          padding: '10px 16px calc(12px + env(safe-area-inset-bottom))',
          background: 'linear-gradient(180deg, transparent, rgba(8,9,12,0.55))'
        }}>
          <button
            onClick={() => setComposerOpen(true)}
            style={{
              border: '1px solid rgba(255,255,255,0.16)', background: 'rgba(8,9,12,0.55)',
              color: 'inherit', borderRadius: 999, padding: '10px 22px', cursor: 'pointer',
              fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, letterSpacing: '0.12em',
              textTransform: 'uppercase', opacity: 0.85, backdropFilter: 'blur(16px)'
            }}
          >
            Write · continue
          </button>
        </div>
      ) : (
        <div style={{
          position: 'relative', zIndex: 2, borderTop: '1px solid rgba(255,255,255,0.08)',
          padding: narrow
            ? '11px 12px calc(12px + env(safe-area-inset-bottom))'
            : '15px 24px 18px',
          display: 'flex', flexDirection: 'column', gap: 11,
          background: 'rgba(8,9,12,0.42)', backdropFilter: 'blur(24px) saturate(140%)'
        }}>
          {showWrapNudge && (
            <div style={{
              display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
              border: '1px solid rgba(255,255,255,0.14)', borderRadius: 14, padding: '12px 14px',
              background: pressure === 'escalate' ? 'rgba(224,165,95,0.12)' : 'rgba(255,255,255,0.05)'
            }}>
              <div style={{ flex: 1, minWidth: 200, fontSize: 12.5, lineHeight: 1.55, color: 'rgba(236,234,230,0.78)' }}>
                {pressure === 'escalate'
                  ? 'Earlier beats may already be dropping from context. File this episode so continuity keeps them.'
                  : locationShiftNudge && pressure === 'ok'
                    ? 'The scene moved. End the episode to file key details into continuity before they crowd the narrator\'s memory.'
                    : 'This episode is getting long for the narrator\'s memory. End it to file key details into continuity.'}
              </div>
              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                <button className="btn-primary" style={{ padding: '7px 12px', fontSize: 12 }}
                  disabled={wrapBusy} onClick={() => setWrapOpen('episode')}>End episode</button>
                <button className="btn-quiet" style={{ fontSize: 11 }} onClick={dismissWrapNudge}>Not yet</button>
              </div>
            </div>
          )}
          {error && <ErrorNote error={error} onDismiss={() => setError('')} />}
          {notice && (
            <div style={{
              border: '1px solid rgba(224,165,95,0.35)', borderRadius: 12, padding: '11px 14px',
              background: 'rgba(224,165,95,0.08)', display: 'flex', gap: 12, alignItems: 'flex-start'
            }}>
              <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'rgba(236,220,190,0.95)', flex: 1 }}>{notice}</div>
              <button className="btn-quiet" style={{ padding: '0 2px', fontSize: 14 }} onClick={() => setNotice('')}>×</button>
            </div>
          )}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
            gap: 4,
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 12,
            overflow: 'hidden',
            background: 'rgba(255,255,255,0.04)'
          }}>
            {(['continue', 'steer', 'speak', 'act'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setComposeMode(m)}
                style={{
                  border: 0,
                  minHeight: 44,
                  padding: '8px 4px',
                  fontSize: narrow ? 12 : 13,
                  fontWeight: composeMode === m ? 600 : 500,
                  cursor: 'pointer',
                  color: composeMode === m ? '#181307' : 'rgba(236,234,230,0.7)',
                  background: composeMode === m ? M.accent : 'transparent'
                }}
              >
                {m[0].toUpperCase() + m.slice(1)}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', opacity: 0.45 }}>length</span>
              {(['beat', 'scene', 'episode'] as const).map((l) => (
                <Chip key={l} active={length === l} accent={M.accent} onClick={() => setLength(l)}>
                  {l[0].toUpperCase() + l.slice(1)}
                </Chip>
              ))}
            </div>
            {readMode && (
              <button className="btn-quiet" style={{ fontSize: 11, minHeight: 40 }} onClick={() => setComposerOpen(false)}>collapse</button>
            )}
          </div>
          <div style={{
            display: 'flex', gap: 13, alignItems: 'flex-end', border: '1px solid rgba(255,255,255,0.14)',
            borderRadius: 16, padding: narrow ? '10px 12px' : '14px 16px',
            background: 'rgba(255,255,255,0.06)', backdropFilter: 'blur(20px) saturate(140%)'
          }}>
            {!narrow && (
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', opacity: 0.42, paddingBottom: 8, whiteSpace: 'nowrap' }}>
                {modeHint[composeMode]}
              </div>
            )}
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onFocus={() => setComposerFocused(true)}
              onBlur={() => setComposerFocused(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void write(); }
              }}
              placeholder={composerPlaceholder[composeMode]}
              rows={2}
              disabled={streaming || composeMode === 'continue'}
              style={{
                flex: 1, border: 0, background: 'transparent', padding: '4px 0',
                fontFamily: 'Spectral, serif', fontSize: narrow ? 15 : 16.5, lineHeight: 1.6,
                minHeight: 26, opacity: composeMode === 'continue' ? 0.45 : 1
              }}
            />
            {streaming ? (
              <button className="btn-ghost" style={{ alignSelf: 'flex-end', minHeight: 44 }} onClick={() => abortRef.current?.abort()}>Stop</button>
            ) : (
              <button className="btn-primary" style={{ alignSelf: 'flex-end', padding: '10px 19px', minHeight: 44 }} onClick={() => void write()}>
                Write on
              </button>
            )}
          </div>
          {!narrow && !readMode && (
            <div style={{ display: 'flex', gap: 16, fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, opacity: 0.4, flexWrap: 'wrap' }}>
              <span>
                {[
                  ...inScene.filter((c) => !c.isPlayer).map((c) => c.name),
                  ...guests.map((g) => `${g.name} (walk-on)`)
                ].join(' · ') || 'no cast in scene'}
              </span>
              <span>memory: {continuity.length} facts · {threads.length} open threads</span>
              <span>{world.ai.mature ? 'adult world · unrestricted' : 'general audience'}</span>
              <span>⌘↵ write on</span>
            </div>
          )}
        </div>
      )}

      {/* wrap sheet — sticky footer keeps CTAs reachable in portrait */}
      <Sheet
        open={wrapOpen !== null}
        onClose={closeWrapSheet}
        narrow={narrow}
        footer={
          wrapOpen === 'season' ? (
            <button
              className="btn-primary"
              style={{ width: '100%', minHeight: 44 }}
              onClick={() => { closeWrapSheet(); go('sequel'); }}
            >
              Open the season review
            </button>
          ) : wrapPhase === 'review' ? (
            <>
              <button
                className="btn-primary"
                style={{ width: '100%', minHeight: 44 }}
                disabled={wrapBusy || !wrapDraft}
                onClick={() => void confirmEpisodeWrap()}
              >
                {wrapBusy ? (
                  'Filing continuity…'
                ) : (
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 2, lineHeight: 1.25 }}>
                    <span>Confirm · episode {episode.number + 1}</span>
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
                Skip summary · end anyway
              </button>
            </>
          ) : wrapPhase === 'analyzing' ? (
            <button
              className="btn-ghost"
              style={{ width: '100%', minHeight: 44 }}
              onClick={() => {
                wrapAbortRef.current?.abort();
                setNotice('Analyze cancelled.');
                setWrapPhase('ready');
                setWrapBusy(false);
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
                Skip summary · end anyway
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
            <div className="serif" style={{ fontWeight: 300, fontSize: 27, lineHeight: 1.15, color: '#f6f4f0' }}>
              {wrapOpen === 'season' ? 'End the season.' : 'End the episode.'}
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.6, opacity: 0.62, maxWidth: '48ch', color: '#eceae6' }}>
              {wrapOpen === 'season'
                ? 'Opens the season review to choose what carries forward into the next season.'
                : wrapPhase === 'review'
                  ? 'Edit the recap, Keep or Drop beats/facts/threads/cast state, then confirm to file memory and open the next episode.'
                  : 'The utility model reads the full episode (compressing long ones) and proposes a previously-on recap, beats, continuity, resolved threads, and cast state — you review before anything is filed.'}
            </div>
          </div>
          <button className="btn-ghost" style={{ width: 30, height: 30, padding: 0, flexShrink: 0 }} onClick={closeWrapSheet}>×</button>
        </div>

        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          <Chip active={wrapOpen === 'episode'} onClick={() => setWrapOpen('episode')}>Episode</Chip>
          <Chip active={wrapOpen === 'season'} onClick={() => setWrapOpen('season')}>Season</Chip>
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

        {wrapOpen === 'season' ? (
          <div style={{
            fontSize: 12.5, lineHeight: 1.55, color: 'rgba(236,234,230,0.7)',
            border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12, padding: '12px 14px',
            background: 'rgba(255,255,255,0.04)'
          }}>
            The season review reads every episode back, proposes beats, and asks what to Drop / Soften / Keep / Raise. It runs on your utility model.
          </div>
        ) : wrapPhase === 'analyzing' ? (
          <div style={{ padding: '20px 0' }}>
            <Spinner label="extracting recap, beats, and continuity" />
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
              Analyze builds a dense previously-on for the next episode plus Keep/Drop beats, facts, threads, resolutions, and cast state
              {guests.length > 0 ? ', and walk-on effects' : ''}. Episode prose stays saved; only the active episode stays in the writing loop.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              <Mono style={{ fontSize: 9 }}>already held in continuity</Mono>
              {continuity.slice(-6).map((f) => (
                <div key={f.id} className="glass" style={{ borderRadius: 13, padding: '12px 14px', fontSize: 13, lineHeight: 1.5, color: 'rgba(236,234,230,0.8)' }}>
                  {f.text}
                </div>
              ))}
              {continuity.length === 0 && (
                <div style={{ fontSize: 12.5, opacity: 0.5, color: '#eceae6' }}>
                  Nothing filed yet — ending an episode with a summary fills this.
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
        narrow={narrow}
        footer={
          <button className="btn-primary" style={{ width: '100%', minHeight: 44 }} onClick={() => setDirectorSheet(false)}>
            Done
          </button>
        }
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="serif" style={{ fontWeight: 300, fontSize: 24, color: '#f6f4f0' }}>Director</div>
          <button className="btn-ghost" style={{ width: 44, height: 44, padding: 0, fontSize: 18 }} onClick={() => setDirectorSheet(false)}>×</button>
        </div>
        {directorContent}
      </Sheet>

      {/* narrow overflow: display / edit / mood */}
      <Sheet open={moreSheet} onClose={() => setMoreSheet(false)} narrow={narrow}
        footer={
          <button className="btn-primary" style={{ width: '100%', minHeight: 44 }} onClick={() => setMoreSheet(false)}>Done</button>
        }
      >
        <div className="serif" style={{ fontWeight: 300, fontSize: 24, color: '#f6f4f0' }}>More</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {readMode && (
            <>
              {showWrapNudge && (
                <button className="btn-ghost" style={{ minHeight: 44, textAlign: 'left' }} onClick={() => { setMoreSheet(false); setWrapOpen('episode'); }}>
                  File episode?
                </button>
              )}
              <button className="btn-ghost" style={{ minHeight: 44, textAlign: 'left' }} onClick={() => { setMoreSheet(false); setDirectorSheet(true); }}>
                Direct
              </button>
              <button className="btn-ghost" style={{ minHeight: 44, textAlign: 'left' }} onClick={() => { setMoreSheet(false); setLayout('write'); }}>
                Exit read
              </button>
            </>
          )}
          <button className="btn-ghost" style={{ minHeight: 44, textAlign: 'left' }} onClick={() => { setMoreSheet(false); setDisplayOpen(true); }}>
            Display
          </button>
          <button className="btn-ghost" style={{ minHeight: 44, textAlign: 'left' }} onClick={() => { setMoreSheet(false); setWorldEditOpen(true); }}>
            Edit world
          </button>
          <Mono style={{ fontSize: 11 }}>mood{episode.moodPinned ? ' · pinned' : ''}</Mono>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {(Object.entries(MOODS) as Array<[typeof mood, typeof M]>).map(([id, m]) => (
              <button key={id} title={m.label} onClick={() => pinMood(id)} style={{
                width: 36, height: 36, borderRadius: '50%', cursor: 'pointer', background: m.accent,
                border: `2px solid ${mood === id ? 'rgba(255,255,255,0.9)' : 'transparent'}`,
                opacity: mood === id ? 1 : 0.5, padding: 0
              }} />
            ))}
          </div>
        </div>
      </Sheet>

      {/* live world editor */}
      <WorldEditorSheet
        open={worldEditOpen}
        onClose={() => setWorldEditOpen(false)}
        narrow={narrow}
        world={world}
        season={season}
        episode={episode}
        characters={characters}
        locations={locations}
      />

      {/* display settings */}
      <DisplaySheet
        open={displayOpen} onClose={() => setDisplayOpen(false)} narrow={narrow}
        episode={episode} world={world} locations={locations}
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
        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10.5, color: 'oklch(0.85 0.1 62)' }}>
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

function DisplaySheet({ open, onClose, narrow, episode, world, locations }: {
  open: boolean; onClose: () => void; narrow: boolean;
  episode: Episode; world: World; locations: Location[];
}) {
  const { display, setDisplay, mood, setMood } = useApp();
  const [imgError, setImgError] = useState('');
  const [imgBusy, setImgBusy] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [note, setNote] = useState(episode.atmosphereNote ?? '');
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
      const { provider, model } = proseModelFor(world);
      const image = await generateSceneImage({
        provider, model, world, location: sceneLoc,
        atmosphereNote: episode.atmosphereNote
      });
      await guardStorage(() => db.episodes.update(episode.id, { image, updatedAt: Date.now() }));
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
          <div className="serif" style={{ fontWeight: 300, fontSize: 24, color: '#f6f4f0' }}>Display</div>
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
                void db.episodes.update(episode.id, { atmosphereNote: next || undefined });
              }
            }}
            placeholder="rain on the glass · late afternoon · cold iron smell…"
            style={{ fontSize: 13 }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, opacity: 0.5 }}>
              mood {episode.moodPinned ? 'pinned' : 'follows location'}
            </span>
            <Toggle
              on={!!episode.moodPinned}
              onClick={() => {
                const next = !episode.moodPinned;
                void db.episodes.update(episode.id, { moodPinned: next });
                if (!next && sceneLoc) setMood(moodFromHue(sceneLoc.hue));
              }}
            />
            {(Object.entries(MOODS) as Array<[typeof mood, (typeof MOODS)[typeof mood]]>).map(([id, m]) => (
              <button key={id} title={m.label} onClick={() => {
                setMood(id);
                void db.episodes.update(episode.id, { moodPinned: true });
              }} style={{
                width: 13, height: 13, borderRadius: '50%', cursor: 'pointer', background: m.accent,
                border: `1px solid ${mood === id ? 'rgba(255,255,255,0.85)' : 'transparent'}`,
                opacity: mood === id ? 1 : 0.45, padding: 0
              }} />
            ))}
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
              backgroundImage: `url(${episode.image})`, backgroundSize: 'cover', backgroundPosition: 'center'
            }} />
          )}
          {imgError && <ErrorNote error={imgError} onDismiss={() => setImgError('')} />}
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
          {episode.image && (
            <>
              <SliderRow label="image darkness" value={display.imageDim} min={0} max={90} unit="%"
                onChange={(v) => setDisplay({ imageDim: v })} />
              <SliderRow label="image blur" value={display.imageBlur} min={0} max={20} unit="px"
                onChange={(v) => setDisplay({ imageBlur: v })} />
            </>
          )}
        </div>

        {/* text visibility */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 16 }}>
          <Mono style={{ fontSize: 9 }}>text</Mono>
          <SliderRow label="plate behind text" value={display.textScrim} min={0} max={80} unit="%"
            onChange={(v) => setDisplay({ textScrim: v })} />
          <SliderRow label="text size" value={display.textSize} min={15} max={24} unit="px"
            onChange={(v) => setDisplay({ textSize: v })} />
        </div>

        {/* avatars */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 16 }}>
          <Mono style={{ fontSize: 9 }}>avatar size in the story</Mono>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {(['S', 'M', 'L'] as AvatarSize[]).map((s) => (
              <Chip key={s} active={display.avatarSize === s} onClick={() => setDisplay({ avatarSize: s })}>
                {s === 'S' ? 'Small' : s === 'M' ? 'Medium' : 'Large'}
              </Chip>
            ))}
            <div style={{ ...avatarStyle(200, AVATAR_PX[display.avatarSize], 'rgba(255,255,255,0.25)'), marginLeft: 'auto' }} />
          </div>
        </div>

        <button className="btn-quiet" style={{ alignSelf: 'flex-start', fontSize: 11 }}
          onClick={() => setDisplay(DEFAULT_DISPLAY)}>reset display to defaults</button>
      </div>
    </Sheet>
  );
}

// ---------- turn row with edit / retry / delete-below ----------

function TurnRow({ turn, blocks, characters, accent, prose, fontPx, avatarPx, streaming, hasBelow, onRetry, onDeleteBelow }: {
  turn: Turn;
  blocks: ProseBlock[];
  characters: Character[];
  accent: string;
  prose: string;
  fontPx: number;
  avatarPx: number;
  streaming: boolean;
  hasBelow: boolean;
  onRetry: () => void;
  onDeleteBelow: () => void;
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
  const retryLabel = turn.role === 'user' ? 'retry from here' : 'retry';

  const save = async () => {
    const text = draft.trim();
    if (text && text !== turn.text) await db.turns.update(turn.id, { text });
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

  return (
    <div className="turn-row" style={{ position: 'relative' }}>
      {blocks.map((b, i) => <ProseBlockView key={i} b={b} accent={accent} prose={prose} fontPx={fontPx} avatarPx={avatarPx} />)}
      <div className="turn-tools" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: -4, marginBottom: 20 }}>
        <button className="btn-quiet" style={{ fontSize: 12, padding: '10px 12px', minHeight: 44 }} disabled={streaming}
          onClick={() => { setDraft(turn.text); setEditing(true); }}>Edit</button>
        <button className="btn-quiet" style={{ fontSize: 12, padding: '10px 12px', minHeight: 44 }} disabled={streaming}
          onClick={onRetry}>{retryLabel}</button>
        {hasBelow && (
          <button className="btn-quiet" style={{ fontSize: 12, padding: '10px 12px', minHeight: 44 }} disabled={streaming}
            onClick={onDeleteBelow}>Delete below</button>
        )}
        <button className="btn-quiet" style={{ fontSize: 12, padding: '10px 12px', minHeight: 44 }} disabled={streaming}
          onClick={async () => {
            if (confirm('Delete this turn? The turns after it are kept.')) {
              await recordTombstones([{
                table: 'turns', id: turn.id, worldId: turn.worldId, episodeId: turn.episodeId, payload: turn
              }]);
              await db.turns.delete(turn.id);
              if (turn.episodeId) await db.episodes.update(turn.episodeId, { runningSummary: null, runningSummaryAtChars: 0, updatedAt: Date.now() });
            }
          }}>Delete</button>
      </div>
    </div>
  );
}

// ---------- director sub-panels ----------

function SceneCastPanel({ episode, characters, accent }: { episode: Episode; characters: Character[]; accent: string }) {
  const guests = episode.guests ?? [];
  const activeGuestIds = episode.activeGuestIds;
  const toggle = async (id: string) => {
    const castIds = episode.castIds.includes(id)
      ? episode.castIds.filter((x) => x !== id)
      : [...episode.castIds, id];
    await db.episodes.update(episode.id, { castIds, updatedAt: Date.now() });
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      <Mono style={{ fontSize: 9 }}>in the scene</Mono>
      {characters.map((c) => {
        const active = episode.castIds.includes(c.id);
        return (
          <div key={c.id} onClick={() => void toggle(c.id)} style={{
            display: 'flex', gap: 10, alignItems: 'center', padding: 8, borderRadius: 12, cursor: 'pointer',
            background: active ? 'rgba(255,255,255,0.05)' : 'transparent',
            border: `1px solid ${active ? 'rgba(255,255,255,0.08)' : 'transparent'}`,
            opacity: active ? 1 : 0.45
          }}>
            <div style={portraitPlate(c.hue, 30, characterPortraits(c)[0])} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#f0eee9' }}>{c.name}</div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9.5, opacity: 0.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {active ? (c.state.emotion || c.role || 'in scene') : 'off-page'}
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
      {guests.length > 0 && (
        <>
          <Mono style={{ fontSize: 9, marginTop: 8 }}>walk-ons · this episode only</Mono>
          {guests.map((g) => {
            // Omitted activeGuestIds ⇒ all guests; explicit [] ⇒ none (matches prompts).
            const active = activeGuestIds == null || activeGuestIds.includes(g.id);
            return (
              <div key={g.id} style={{
                display: 'flex', gap: 10, alignItems: 'center', padding: 8, borderRadius: 12,
                background: active ? 'rgba(255,255,255,0.04)' : 'transparent',
                border: '1px solid rgba(255,255,255,0.06)',
                opacity: active ? 1 : 0.4
              }}>
                <div style={portraitPlate(guestHue(g.id), 30, null, 'rgba(255,255,255,0.14)')} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#f0eee9' }}>{g.name}</div>
                  <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9.5, opacity: 0.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {g.brief || 'walk-on'}
                  </div>
                </div>
                <div style={{
                  fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, letterSpacing: '0.08em',
                  textTransform: 'uppercase', opacity: 0.45, flexShrink: 0
                }}>
                  guest
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

function locationThumb(l: Location, size = 30): CSSProperties {
  if (l.portrait) {
    return {
      width: size, height: size, borderRadius: '50%', flexShrink: 0,
      backgroundImage: `url(${l.portrait})`, backgroundSize: 'cover', backgroundPosition: 'center',
      border: '1px solid rgba(255,255,255,0.18)'
    };
  }
  return avatarStyle(l.hue, size);
}

function SceneLocationsPanel({ episode, locations, accent, world, onGoLocations }: {
  episode: Episode; locations: Location[]; accent: string; world?: World; onGoLocations: () => void;
}) {
  const { setMood } = useApp();
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState('');

  const activeLoc = locations.find((l) => l.id === episode.locationId)
    ?? locations.find((l) => !!episode.location && l.name.trim()
      && (episode.location.toLowerCase().includes(l.name.toLowerCase())
        || l.name.toLowerCase().includes(episode.location.trim().toLowerCase())));

  const select = async (l: Location) => {
    const active = episode.locationId === l.id;
    if (active) {
      await db.episodes.update(episode.id, { locationId: null, location: '' });
      return;
    }
    const patch: Partial<Episode> = { locationId: l.id, location: l.name };
    if (l.portrait) patch.image = l.portrait;
    await db.episodes.update(episode.id, patch);
    if (!episode.moodPinned) setMood(moodFromHue(l.hue));
  };

  const addQuick = async () => {
    const l = emptyLocation(episode.worldId, { name: 'New location' });
    await db.locations.add(l);
    await db.episodes.update(episode.id, {
      locationId: l.id, location: l.name,
      ...(l.portrait ? { image: l.portrait } : {})
    });
    if (!episode.moodPinned) setMood(moodFromHue(l.hue));
  };

  const generate = async () => {
    if (!world || !activeLoc) return;
    setGenBusy(true);
    setGenError('');
    try {
      const { provider, model } = proseModelFor(world);
      const image = await generateSceneImage({
        provider, model, world, location: activeLoc,
        atmosphereNote: episode.atmosphereNote
      });
      await guardStorage(() => db.episodes.update(episode.id, { image, updatedAt: Date.now() }));
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
        <button className="btn-quiet" style={{ fontSize: 10, padding: '2px 4px' }} onClick={onGoLocations}>full editor → Locations</button>
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
            <button className="btn-ghost" style={{ fontSize: 11, padding: '6px 10px' }} onClick={async () => {
              // Free-text override clears the library link so the cards don't fight it.
              await db.episodes.update(episode.id, { location: value, locationId: null });
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

function ContinuityPanel({ continuity, world, season, episode }: {
  continuity: ContinuityFact[]; world: World; season: Season; episode: Episode;
}) {
  const [adding, setAdding] = useState('');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Mono style={{ fontSize: 9 }}>continuity held</Mono>
      {continuity.map((f) => (
        <div key={f.id} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
          <div style={{ fontSize: 12, lineHeight: 1.45, opacity: 0.68, paddingLeft: 12, borderLeft: '1px solid rgba(255,255,255,0.14)', flex: 1, color: '#eceae6' }}>
            {f.text}
          </div>
          <button className="btn-quiet" style={{ padding: '0 2px', fontSize: 12 }} onClick={() => void (async () => {
            await recordTombstones([{
              table: 'continuity', id: f.id, worldId: f.worldId, seasonId: f.seasonId, payload: f
            }]);
            await db.continuity.delete(f.id);
          })()}>×</button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="add a fact…"
          style={{ fontSize: 11.5, padding: '7px 9px' }}
          onKeyDown={async (e) => {
            if (e.key === 'Enter' && adding.trim()) {
              await db.continuity.add({
                id: uid(), worldId: world.id, seasonId: season.id, episodeId: episode.id,
                text: adding.trim(), source: 'manual', createdAt: Date.now()
              });
              setAdding('');
            }
          }}
        />
      </div>
    </div>
  );
}

function ThreadsPanel({ threads }: { threads: OpenThread[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      <Mono style={{ fontSize: 9 }}>open threads</Mono>
      {threads.map((t) => (
        <div key={t.id} style={{ border: '1px solid rgba(255,255,255,0.09)', borderRadius: 11, padding: '10px 12px', background: 'rgba(255,255,255,0.04)', display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div style={{ fontSize: 12.5, lineHeight: 1.4, color: '#eceae6' }}>{t.text}</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9.5, opacity: 0.45 }}>{t.openedLabel}</div>
            <button className="btn-quiet" style={{ padding: 0, fontSize: 10 }} onClick={() => void db.threads.update(t.id, { status: 'resolved' })}>resolve</button>
          </div>
        </div>
      ))}
      {threads.length === 0 && <div style={{ fontSize: 12, opacity: 0.5, color: '#eceae6' }}>No open threads yet.</div>}
    </div>
  );
}

function NudgesPanel({ threads, inScene, onNudge }: { threads: OpenThread[]; inScene: Character[]; onNudge: (t: string) => void }) {
  const nudges = [
    'Let the silence run — do not fill it for me.',
    ...inScene.filter((c) => !c.isPlayer).slice(0, 2).map((c) => `${c.name} presses toward what they want.`),
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
  onNudge: (t: string) => void;
}) {
  const inScene = props.characters.filter((c) => props.episode.castIds.includes(c.id));
  const labelSize = props.narrow ? 11 : 9;
  const [open, setOpen] = useState({ calendar: true, scene: true, memory: false, nudges: false });
  const toggle = (key: keyof typeof open) => setOpen((o) => ({ ...o, [key]: !o[key] }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, overflow: 'auto' }}>
      <DirectorAccordion title="calendar" open={open.calendar} onToggle={() => toggle('calendar')} labelSize={labelSize}>
        <CalendarTrackerPanel world={props.world} season={props.season} episode={props.episode} />
      </DirectorAccordion>
      <DirectorAccordion title="scene" open={open.scene} onToggle={() => toggle('scene')} labelSize={labelSize}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <SceneCastPanel episode={props.episode} characters={props.characters} accent={props.accent} />
          <SceneLocationsPanel
            episode={props.episode} locations={props.locations} accent={props.accent}
            world={props.world} onGoLocations={props.onGoLocations}
          />
          <ScenePlatePanel episode={props.episode} bd={BACKDROPS.scene} />
        </div>
      </DirectorAccordion>
      <DirectorAccordion title="memory" open={open.memory} onToggle={() => toggle('memory')} labelSize={labelSize}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <ContinuityPanel
            continuity={props.continuity} world={props.world} season={props.season} episode={props.episode}
          />
          <ThreadsPanel threads={props.threads} />
        </div>
      </DirectorAccordion>
      <DirectorAccordion title="nudges" open={open.nudges} onToggle={() => toggle('nudges')} labelSize={labelSize}>
        <NudgesPanel threads={props.threads} inScene={inScene} onNudge={props.onNudge} />
      </DirectorAccordion>
    </div>
  );
}

/** Controllable in-fiction calendar: day / month / year, weekday, episode stamp. */
function CalendarTrackerPanel({
  world, season, episode
}: {
  world: World;
  season: Season;
  episode: Episode;
}) {
  const cal = worldCalendar(world);
  const today = partsForDay(cal, cal.currentDay);
  const epDay = episode.storyDay && episode.storyDay > 0 ? episode.storyDay : cal.currentDay;
  const loc = episode.location.trim() || 'no location set';
  const inputStyle: CSSProperties = {
    fontFamily: "'IBM Plex Mono', monospace", fontSize: 12,
    background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 8, padding: '6px 8px', color: '#f0eee9'
  };

  // Stamp open day once for legacy episodes — do not re-stamp when "today" moves.
  useEffect(() => {
    if (episode.storyDay == null || episode.storyDay < 1) {
      void db.episodes.update(episode.id, { storyDay: cal.currentDay, updatedAt: Date.now() });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when episode id / missing storyDay
  }, [episode.id, episode.storyDay]);

  const setDay = (day: number) => {
    const next = Math.max(1, Math.floor(day));
    void db.worlds.update(world.id, {
      calendar: calendarPatch(world, { currentDay: next }),
      updatedAt: Date.now()
    });
  };

  const setParts = (year: number, monthIndex: number, dayOfMonth: number) => {
    setDay(dayFromParts(cal, year, monthIndex, dayOfMonth));
  };

  const setAdvance = (n: number) => {
    void db.worlds.update(world.id, {
      calendar: calendarPatch(world, { episodeAdvanceDays: Math.max(0, Math.min(365, Math.floor(n))) }),
      updatedAt: Date.now()
    });
  };

  const setDayOneWeekday = (idx: number) => {
    void db.worlds.update(world.id, {
      calendar: calendarPatch(world, { dayOneWeekday: idx }),
      updatedAt: Date.now()
    });
  };

  const stampEpisodeDay = () => {
    void db.episodes.update(episode.id, { storyDay: cal.currentDay, updatedAt: Date.now() });
  };

  const monthLen = cal.monthLengths[today.monthIndex] ?? 30;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Mono style={{ fontSize: 9 }}>calendar tracker</Mono>
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

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr 0.9fr', gap: 8 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <Mono style={{ fontSize: 8, opacity: 0.5 }}>day</Mono>
            <input
              type="number"
              min={1}
              max={monthLen}
              value={today.dayOfMonth}
              onChange={(e) => setParts(today.year, today.monthIndex, Number(e.target.value) || 1)}
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
              value={today.year}
              onChange={(e) => setParts(Number(e.target.value) || cal.yearOne, today.monthIndex, today.dayOfMonth)}
              style={inputStyle}
            />
          </label>
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, opacity: 0.75 }}>
          absolute day
          <input
            type="number"
            min={1}
            value={cal.currentDay}
            onChange={(e) => setDay(Number(e.target.value) || 1)}
            style={{ ...inputStyle, width: 72 }}
          />
        </label>

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

        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 0.9fr', gap: 8 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <Mono style={{ fontSize: 8, opacity: 0.5 }}>month of day 1</Mono>
            <select
              value={cal.dayOneMonth}
              onChange={(e) => {
                void db.worlds.update(world.id, {
                  calendar: calendarPatch(world, { dayOneMonth: Number(e.target.value) }),
                  updatedAt: Date.now()
                });
              }}
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
              value={cal.dayOneDate}
              onChange={(e) => {
                void db.worlds.update(world.id, {
                  calendar: calendarPatch(world, { dayOneDate: Math.max(1, Number(e.target.value) || 1) }),
                  updatedAt: Date.now()
                });
              }}
              style={inputStyle}
            />
          </label>
        </div>

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
              value={cal.episodeAdvanceDays}
              onChange={(e) => setAdvance(Math.max(0, Math.min(365, Number(e.target.value) || 0)))}
              style={{ ...inputStyle, width: 64 }}
              title="Custom advance days"
            />
          </div>
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Mono style={{ fontSize: 8, opacity: 0.5 }}>calendar system (optional notes)</Mono>
          <textarea
            key={world.id + '-dir-cal-system'}
            rows={2}
            defaultValue={cal.system}
            onBlur={(e) => {
              void db.worlds.update(world.id, {
                calendar: calendarPatch(world, { system: e.target.value }),
                updatedAt: Date.now()
              });
            }}
            placeholder="Feast days, era name — narrator follows this verbatim. Month lengths are fixed (no leap days)."
            style={{ fontSize: 12.5, lineHeight: 1.45, color: '#eceae6' }}
          />
        </label>
        <div style={{ fontSize: 11.5, opacity: 0.45, lineHeight: 1.4 }}>
          Story day 1 is the earliest date ({cal.dayOneDate} {cal.months[cal.dayOneMonth]} Y{cal.yearOne}). Dates before that clamp to day 1.
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
              void db.worlds.update(world.id, {
                calendar: calendarPatch(world, {
                  months,
                  monthLengths,
                  dayOneMonth: Math.min(cal.dayOneMonth, months.length - 1)
                }),
                updatedAt: Date.now()
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
              void db.worlds.update(world.id, {
                calendar: calendarPatch(world, { monthLengths: monthLengths.slice(0, cal.months.length) }),
                updatedAt: Date.now()
              });
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
              void db.worlds.update(world.id, {
                calendar: calendarPatch(world, { weekdays, dayOneWeekday: Math.min(cal.dayOneWeekday, weekdays.length - 1) }),
                updatedAt: Date.now()
              });
            }}
            style={{ fontSize: 12.5, color: '#eceae6' }}
          />
        </label>

        {epDay !== cal.currentDay && (
          <button className="btn-ghost" style={{ fontSize: 11, alignSelf: 'flex-start' }} onClick={stampEpisodeDay}>
            Stamp episode open day → {formatStoryDateShort(cal, cal.currentDay)}
          </button>
        )}
      </div>
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
        background: active ? 'rgba(224,165,95,0.85)' : 'rgba(255,255,255,0.05)',
        color: active ? '#181307' : 'rgba(236,234,230,0.62)',
        borderRadius: 10,
        fontSize: 13,
        fontWeight: active ? 600 : 500,
        cursor: 'pointer',
        fontFamily: "'IBM Plex Mono', monospace",
        letterSpacing: '0.06em',
        textTransform: 'uppercase'
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
    key: 'facts' | 'threads' | 'guestEffects' | 'resolvedThreads',
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
        <Mono style={{ fontSize: 9 }}>premise (current pressure) → next episode</Mono>
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

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Mono style={{ fontSize: 9 }}>beats</Mono>
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
              onDrop={() => patchBeat(i, { keep: false })}
            />
          </div>
        ))}
      </div>

      {([
        ['facts', 'continuity facts'] as const,
        ['threads', 'new open threads'] as const,
        ['resolvedThreads', 'threads resolved this episode'] as const,
        ['guestEffects', 'walk-on effects'] as const
      ]).map(([key, label]) => {
        if (key === 'guestEffects' && draft.guestEffects.length === 0 && guests.length === 0) return null;
        if (key === 'resolvedThreads' && draft.resolvedThreads.length === 0) return null;
        return (
          <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Mono style={{ fontSize: 9 }}>{label}</Mono>
            {draft[key].length === 0 && (
              <div style={{ fontSize: 12.5, opacity: 0.5 }}>None proposed.</div>
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
          <Mono style={{ fontSize: 9 }}>cast state → next episode</Mono>
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
