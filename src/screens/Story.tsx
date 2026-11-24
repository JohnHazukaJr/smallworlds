import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import {
  commitSoftEpisodeWrap, draftColdOpenNarration,
  deleteTurn, deleteTurnsFrom, rewindTo, switchTurnAlt, undoRewind, type RewindUndo,
  endStoryWrite,
  canRewriteFromHere,
  finalizeChapterMemory,
  regenerateBeat,
  tryBeginStoryWrite, writeTurn,
  WriteAbortedError, type StreamMeta
} from '../ai/engine';
import {
  parseDeliveryTone,
  DELIVERY_TONE_GROUPS,
  type DeliveryTone
} from '../ai/deliveryTone';
import { composeOutgoingLine } from '../ai/composeLine';
import { namesPhrase } from '../ai/offscreenLife';
import {
  groupSpeakParagraphs,
  parseInlineEmphasis,
  parseSpeakSegments,
  previewSpeakText,
  stripNarratorEmbeddedDialogue,
  type SpeakSegment
} from '../ai/dialogueFormat';
import {
  episodeSceneDay,
  resolveSpeakerName
} from '../ai/prompts';
import { StoryDateFields } from '../components/StoryDateFields';
import { WorldEditorSheet } from '../components/WorldEditorSheet';
import { db, safeWrite } from '../db';
import { useShallow } from 'zustand/react/shallow';
import { onSceneMoved, placeTree, placeWhereLine, resolveScenePlace, setScenePlace, type SceneMove } from '../places';
import {
  AVATAR_MAX, AVATAR_MIN, AVATAR_STEP,
  DEFAULT_DISPLAY, moodFromHue, storyAvatarHeight, useApp,
  type DialogueStyle, type MoodId, type StoryLayout
} from '../store/app';
import { generateChapterPicture } from '../ai/image';
import { rememberedPortraitStyle } from '../ai/portrait';
import type { SceneSpeaker } from '../ai/sceneReply';
import { checkChipDetail, checkChipText } from '../mechanics';
import { altPosition, editAltPatch } from '../turnAlts';
import { JournalSheet } from '../components/JournalSheet';
import { scenePiecesOf, validBeats } from '../ai/beatProtocol';
import { hasWritingModel } from '../ai/models';
import { useSettings } from '../store/settings';
import type {
  ChapterIllustration, Character, CheckResult, ComposeMode, Episode, EpisodeGuest,
  Location, Turn, TurnLength, ActionWeight
} from '../types';
import { AppError, classifyError } from '../errors';
import {
  Chip, ErrorNote, Mono, Sheet, Spinner,
  bookStageOpen, phoneChrome, sheetsFromBottom, shortStoryChrome, tuckSceneHudOnScroll, useViewport
} from '../ui/bits';
import { BookStage, type BookPiece } from '../ui/BookStage';
import { placeChapterPictures } from '../ui/chapterPictures';
import { writingLineText } from '../ui/bookPage';
import { Face } from '../ui/Face';
import { attributionRun, isDialogueBlock, lastSpokenBy } from '../ui/attribution';
import { abortWriteNotice, NOTICE_ADD_MODEL, noticeNavAction } from '../ui/writeNotices';
import { avatarStyle, speakerInk, MOODS, ACCENT, ACCENT_RGBA } from '../ui/theme';
import {
  characterPortraits, evaluateWorldWriteReady, formatStoryDate,
  buildEpisodePlotTargets, latestEndedEpisode, nextEpisode, pendingPlotTargets, worldCalendar
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
  /** Hidden check settled for this player move */
  check?: CheckResult;
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

function speakersOnPage(characters: Character[], guests: EpisodeGuest[]): SceneSpeaker[] {
  return [
    ...characters.flatMap((c) => {
      const name = c.name.trim();
      if (!name || c.isPlayer) return [];
      const aliases = (c.aliases ?? []).map((alias) => alias.trim()).filter(Boolean);
      return [{
        id: c.id,
        name,
        kind: 'cast' as const,
        ...(aliases.length > 0 ? { aliases } : {}),
        ...(c.role?.trim() ? { role: c.role } : {})
      }];
    }),
    ...guests.flatMap((g) => {
      const name = g.name.trim();
      if (!name) return [];
      return [{ id: g.id, name, kind: 'guest' as const }];
    })
  ];
}

function parseTurn(turn: Turn, characters: Character[], guests: EpisodeGuest[] = []): ProseBlock[] {
  if (turn.role === 'user' && turn.asCharacterId) {
    const who = characters.find((c) => c.id === turn.asCharacterId);
    const { tone, body } = parseDeliveryTone(turn.text);
    const spoken = /["“”*]/.test(body);
    return [{
      text: body,
      speaker: who?.name ?? 'they',
      hue: who?.hue ?? 200,
      portrait: who ? characterPortraits(who)[0] : null,
      kind: spoken ? 'speak' : 'action',
      ...(spoken ? { segments: parseSpeakSegments(body) } : {}),
      deliveryTone: tone
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
        deliveryTone: tone,
        ...(turn.check ? { check: turn.check } : {})
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
        deliveryTone: tone,
        ...(turn.check ? { check: turn.check } : {})
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
  const speakers = speakersOnPage(characters, guests);
  const speakerLabels = speakers.flatMap((speaker) => [speaker.name, ...(speaker.aliases ?? [])]);
  const pieces = speakers.length > 0 || validBeats(turn) ? scenePiecesOf(turn, speakers) : [];
  const spokenQuotes = new Set(
    pieces
      .filter((piece) => piece.role === 'character')
      .flatMap((piece) => [...piece.text.matchAll(/[“"]([^“”"]+)[”"]/g)].map((m) => m[1].trim()))
  );
  /** Drop a `Name: "..."` echo only when that line already shows in a speech block. Never lose words. */
  const stripNarration = (text: string) => {
    const stripped = speakers.length > 0
      ? stripNarratorEmbeddedDialogue(text, speakerLabels)
      : stripNarratorEmbeddedDialogue(text);
    if (!stripped || stripped === text.trim()) return text;
    const kept = new Set([...stripped.matchAll(/[“"]([^“”"]+)[”"]/g)].map((m) => m[1].trim()));
    const removed = [...text.matchAll(/[“"]([^“”"]+)[”"]/g)].map((m) => m[1].trim()).filter((q) => !kept.has(q));
    return removed.every((q) => spokenQuotes.has(q)) ? stripped : text;
  };
  if (!pieces.some((piece) => piece.role === 'character' && piece.speakerId)) {
    return [{ text: turn.text, kind: 'narration' }];
  }
  const blocks: ProseBlock[] = [];
  for (const piece of pieces) {
    const text = piece.text.trim();
    if (!text) continue;
    if (piece.role === 'character' && piece.speakerId) {
      const who = piece.kind === 'guest' ? undefined : characters.find((c) => c.id === piece.speakerId);
      const guest = piece.kind === 'guest' ? guests.find((g) => g.id === piece.speakerId) : undefined;
      blocks.push({
        text,
        speaker: who?.name ?? guest?.name ?? 'Someone',
        hue: who?.hue ?? (guest ? guestHue(guest.id) : 200),
        portrait: who ? characterPortraits(who)[0] : null,
        kind: 'speak',
        segments: parseSpeakSegments(text)
      });
      continue;
    }
    const narration = stripNarration(text);
    if (!narration.trim()) continue;
    blocks.push({ text: narration, kind: 'narration' });
  }
  return blocks.length > 0 ? blocks : [{ text: turn.text, kind: 'narration' }];
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
      <span data-book-copy>
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
      </span>
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
      data-book-copy
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

/** The settled outcome of a risky move, under the player's line. */
function CheckChip({ check, fromPlayer }: { check: CheckResult; fromPlayer?: boolean }) {
  const tone = check.tier === 'fail' ? 'var(--ink-muted)' : 'var(--ink-heading)';
  return (
    <div
      className="check-chip"
      title={checkChipDetail(check)}
      aria-label={`Check: ${checkChipDetail(check)}`}
      style={{
        display: 'flex',
        justifyContent: fromPlayer ? 'flex-end' : 'flex-start',
        margin: '2px 0 16px'
      }}
    >
      <span style={{
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 10,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: tone,
        border: '1px solid var(--rule)',
        borderRadius: 999,
        padding: '3px 9px',
        opacity: check.tier === 'fail' ? 0.85 : 1
      }}>
        {checkChipText(check)}
      </span>
    </div>
  );
}

type ProseBlockProps = Parameters<typeof ProseBlockBody>[0];

function ProseBlockView(props: ProseBlockProps) {
  if (!props.b.check) return <ProseBlockBody {...props} />;
  return (
    <>
      <ProseBlockBody {...props} />
      <CheckChip check={props.b.check} fromPlayer={props.fromPlayer} />
    </>
  );
}

function ProseBlockBody({
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
    const lead = b.speaker && !continues && (isDialog || (b.kind === 'action' && b.deliveryTone))
      ? <SpeakerLead b={b} />
      : undefined;

    if (b.kind === 'direction') {
      return (
        <div className={`prose-block ${kindClass}`}>
          <div className="label" style={{ fontSize: 11, marginBottom: 4 }}>Direction</div>
          <p
            className="serif"
            data-book-copy
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
        <span data-book-copy><EmphasizedText text={b.text} /></span>
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

type SpeakTarget =
  | { kind: 'cast'; id: string }
  | { kind: 'guest'; id: string }
  | { kind: 'player' };

type LineAddress = { toCharacterId?: string; toGuestId?: string; toPlayer?: boolean };

/** The person this line is aimed at, or nothing when the choice no longer fits the room. */
function lineAddress(opts: {
  direct: boolean;
  asCharacterId: string | null;
  target: SpeakTarget | null;
  characters: Character[];
  castIds: string[];
  guests: EpisodeGuest[];
  activeGuestIds?: string[];
}): LineAddress | undefined {
  const target = opts.target;
  if (opts.direct || !target) return undefined;
  if (opts.asCharacterId) {
    if (target.kind !== 'player') return undefined;
    const player = opts.characters.find((c) => c.isPlayer);
    return player ? { toCharacterId: player.id, toPlayer: true } : { toPlayer: true };
  }
  if (target.kind === 'cast') {
    const id = target.id;
    const npc = opts.characters.find((c) => c.id === id && opts.castIds.includes(c.id) && !c.isPlayer);
    return npc ? { toCharacterId: npc.id } : undefined;
  }
  if (target.kind === 'guest') {
    const id = target.id;
    const active = opts.activeGuestIds == null
      ? opts.guests
      : opts.guests.filter((g) => opts.activeGuestIds?.includes(g.id));
    return active.some((g) => g.id === id) ? { toGuestId: id } : undefined;
  }
  return undefined;
}

/** Identity for parsed blocks. Speaker name, hue, and portrait change the markup. */
function castParseKey(characters: Character[], guests: EpisodeGuest[]): string {
  const cast = characters.map((c) =>
    `${c.id}\t${c.isPlayer ? 1 : 0}\t${c.name}\t${c.role ?? ''}\t${(c.aliases ?? []).join('|')}\t${c.hue}\t${c.portrait ?? ''}\t${(c.portraits ?? []).length}`
  ).join('\n');
  const guest = guests.map((g) => `${g.id}\t${g.name}`).join('\n');
  return `${cast}\n--\n${guest}`;
}

/**
 * The live line. Token updates stay here so the mounted chapter does not
 * re-render on every chunk, and the scroll moves once per frame.
 */
function WritingLine({ text, fontPx }: { text: string; fontPx: number }) {
  return (
    <p
      className="serif writing-line"
      role="status"
      data-writing-line
      style={{ fontSize: fontPx, lineHeight: 1.82 }}
    >
      {text}
      <span className="prose-caret" aria-hidden />
    </p>
  );
}

function sceneStreamBlocks(
  partial: string,
  meta: StreamMeta,
  characters: Character[],
  guests: EpisodeGuest[],
  episodeId: string,
  worldId: string
): ProseBlock[] {
  return parseTurn({
    id: 'partial',
    episodeId,
    worldId,
    role: meta.role,
    mode: null,
    characterId: meta.characterId,
    guestId: meta.guestId,
    text: meta.role === 'character' ? previewSpeakText(partial) : partial,
    ...(meta.role === 'narrator' && meta.beats ? { beats: meta.beats } : {}),
    createdAt: 0
  }, characters, guests);
}

function StreamTail({
  sinkRef, active, scrollRef, followRef, pinRef, onHasText, characters, guests, episodeId, worldId,
  accent, prose, fontPx, avatarPx, dialogueStyle, opening
}: {
  sinkRef: RefObject<StreamSink>;
  active: boolean;
  scrollRef: RefObject<HTMLElement | null>;
  /** When false, a reader who moved up the page stays there. */
  followRef?: RefObject<boolean>;
  /** Shared with the page's scroll listener so a programmatic pin is not a user scroll. */
  pinRef?: RefObject<number>;
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
        if (el && followRef?.current !== false) {
          if (pinRef) pinRef.current += 1;
          el.scrollTop = el.scrollHeight;
          if (pinRef) {
            requestAnimationFrame(() => {
              pinRef.current = Math.max(0, pinRef.current - 1);
              if (pinRef.current === 0 && followRef) {
                const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
                followRef.current = gap < 48;
              }
            });
          }
        }
      });
    };
    return () => {
      sinkRef.current = () => {};
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, [sinkRef, scrollRef, followRef, pinRef, onHasText]);

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
  const blocks = sceneStreamBlocks(partial, meta, characters, guests, episodeId, worldId);
  const continued = attributionRun(blocks, null);
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
          continues={continued[i]}
          opening={opening && i === 0}
          fromPlayer={meta.role === 'user'}
          caret={i === arr.length - 1}
        />
      ))}
    </>
  );
}

function StoryDateButton({
  date, onEdit, opening
}: {
  date: string;
  onEdit: () => void;
  opening?: boolean;
}) {
  if (!date) return null;
  return (
    <button
      type="button"
      className="serif"
      onClick={onEdit}
      title="Edit the story date"
      style={opening
        ? {
          marginTop: 10, fontSize: 15, lineHeight: 1.55, fontStyle: 'italic',
          color: 'var(--ink-muted)', border: 0, background: 'transparent',
          padding: 0, cursor: 'pointer', textAlign: 'left'
        }
        : {
          border: 0, background: 'transparent', padding: 0, cursor: 'pointer',
          color: 'inherit', font: 'inherit', letterSpacing: 'inherit', textTransform: 'inherit'
        }}
    >
      {date}
    </button>
  );
}

function ChapterFigure({ picture }: { picture: ChapterIllustration }) {
  return (
    <figure style={{ margin: '1.2em 0 1.4em' }} data-chapter-picture={picture.id}>
      <div style={{ width: '100%', aspectRatio: '4 / 3', overflow: 'hidden', background: 'var(--rule)' }}>
        <img
          src={picture.dataUrl}
          alt={picture.prompt}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      </div>
      <figcaption className="serif" style={{
        fontSize: 13, fontStyle: 'italic', color: 'var(--ink-muted)', marginTop: 8
      }}>
        {picture.prompt}
      </figcaption>
    </figure>
  );
}

const WRITE_BUSY_NOTE = 'The last reply is still finishing its notes — try again in a moment.';

export function Story() {
  const { band, height, keyboardOffset, keyboardOpen } = useViewport();
  const book = bookStageOpen(band, keyboardOpen, height);
  const phone = phoneChrome(band);
  /** Phone width (and a Fold's cover screen): the composer stacks instead of squeezing. */
  const compactComposer = band === 'compact';
  const short = shortStoryChrome(band, height);
  const sheetBottom = sheetsFromBottom(band);
  const narrow = phone;
  const { currentWorldId, layout, setLayout, mood, setMood, go, display, goLocations: openLocations, goCast: openCast, closeWorld } = useApp(useShallow((s) => ({
    currentWorldId: s.currentWorldId, layout: s.layout, setLayout: s.setLayout, mood: s.mood, setMood: s.setMood,
    go: s.go, display: s.display, goLocations: s.goLocations, goCast: s.goCast, closeWorld: s.closeWorld
  })));
  useSettings((s) => s.proseModel);
  const M = MOODS[mood];
  const readMode = layout === 'read';
  const avatarPx = storyAvatarHeight(display.avatarSize);
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
  const [speakTo, setSpeakTo] = useState<SpeakTarget | null>(null);
  const [direct, setDirect] = useState(false);
  useEffect(() => {
    if (!episode) return;
    setSpeakTo((current) => {
      if (!current) return current;
      if (direct) return null;
      if (asCharacterId) return current.kind === 'player' ? current : null;
      if (current.kind === 'player') return null;
      if (current.kind === 'cast') {
        const here = characters.some((c) =>
          c.id === current.id && episode.castIds.includes(c.id) && !c.isPlayer
        );
        return here ? current : null;
      }
      const list = episode.guests ?? [];
      const active = episode.activeGuestIds == null
        ? list
        : list.filter((g) => episode.activeGuestIds?.includes(g.id));
      return active.some((g) => g.id === current.id) ? current : null;
    });
  }, [asCharacterId, direct, episode, characters]);
  const [speechTone, setSpeechTone] = useState<DeliveryTone | null>(null);
  const [toneGroup, setToneGroup] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [pictureOpen, setPictureOpen] = useState(false);
  const [picturePrompt, setPicturePrompt] = useState('');
  const [pictureBusy, setPictureBusy] = useState(false);
  const pictureAbortRef = useRef<AbortController | null>(null);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [tailHasText, setTailHasText] = useState(false);
  const streamSink = useRef<StreamSink>(() => {});
  const onTailText = useCallback((hasText: boolean) => setTailHasText(hasText), []);
  const [progressLabel, setProgressLabel] = useState('');
  const [pageReveal, setPageReveal] = useState(0);
  const [error, setError] = useState<string | AppError>('');
  const [notice, setNotice] = useState('');
  const [placeMenuOpen, setPlaceMenuOpen] = useState(false);
  /** The last automatic move, so it can be undone. */
  const [sceneMove, setSceneMove] = useState<SceneMove | null>(null);
  const episodeIdForMoves = episode?.id;
  useEffect(() => {
    if (!episodeIdForMoves) return;
    return onSceneMoved((move) => {
      if (move.episodeId === episodeIdForMoves) setSceneMove(move);
    });
  }, [episodeIdForMoves]);
  useEffect(() => { setSceneMove(null); setPlaceMenuOpen(false); }, [episodeIdForMoves]);
  /** The last rewind, while Undo can still put it back. */
  const [rewound, setRewound] = useState<RewindUndo | null>(null);
  const [journalOpen, setJournalOpen] = useState(false);
  const [writeAnyway, setWriteAnyway] = useState(false);
  const [recoverBusy, setRecoverBusy] = useState(false);
  const recoverBusyRef = useRef(false);
  const wrapBusyRef = useRef(false);
  /** How many turns from the end are mounted — keeps long episodes responsive. */
  const [turnWindow, setTurnWindow] = useState(60);
  useEffect(() => { setTurnWindow(60); setRewound(null); }, [episode?.id]);
  useEffect(() => { setWriteAnyway(false); }, [episode?.id, world?.id]);
  useEffect(() => {
    if (!currentWorldId || world === undefined) return;
    if (world === null) closeWorld();
  }, [currentWorldId, world, closeWorld]);
  const [wrapBusy, setWrapBusy] = useState(false);
  const [worldEditOpen, setWorldEditOpen] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);
  const [displayOpen, setDisplayOpen] = useState(false);
  const [moreSheet, setMoreSheet] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [hudTucked, setHudTucked] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // Leaving Story mid-reply stops the reply, so the write lock is not held by a screen nobody can see.
  useEffect(() => () => { abortRef.current?.abort(); }, []);
  const scrollRef = useRef<HTMLElement>(null);
  const followScroll = useRef(true);
  const scrollEpisode = useRef<string | undefined>(undefined);
  const scrollPin = useRef(0);
  /** First turn of the reply in progress. While set, the column does not jump to the end. */
  const replyFrom = useRef(0);
  const replyAnchor = useRef<'idle' | 'await'>('idle');
  const streamingScroll = useRef(false);

  useEffect(() => {
    try { localStorage.setItem('sw-reply-size', length); } catch { /* ignore */ }
  }, [length]);

  const activeLocation = resolveScenePlace(episode, locations);

  // A title card when the chapter moves from one place to another. Not on first load,
  // not when a chapter opens, and not when a place first resolves.
  const [placeCard, setPlaceCard] = useState<PlaceCardInfo | null>(null);
  const placeSeen = useRef<{ episodeId?: string; locationId: string | null }>({ locationId: null });
  useEffect(() => {
    const episodeId = episode?.id;
    const locationId = activeLocation?.id ?? null;
    const prev = placeSeen.current;
    placeSeen.current = { episodeId, locationId };
    if (!activeLocation || !locationId || !prev.locationId) return;
    if (prev.episodeId !== episodeId || prev.locationId === locationId) return;
    const parent = activeLocation.parentId ? locations.find((l) => l.id === activeLocation.parentId) : undefined;
    setPlaceCard({
      key: `${locationId}:${Date.now()}`,
      name: activeLocation.name,
      within: parent?.name,
      line: firstSentence(activeLocation.atmosphere || activeLocation.summary, 110)
    });
  }, [episode?.id, activeLocation?.id]);

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
    const onScroll = () => {
      if (!composerOpen && tuckSceneHudOnScroll(scrollPin.current > 0)) setHudTucked(true);
    };
    el?.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el?.removeEventListener('scroll', onScroll);
    };
  }, [readMode, composerOpen, episode?.id]);

  // Location hue → mood when the episode hasn't pinned a mood.
  useEffect(() => {
    if (!episode || !activeLocation || episode.moodPinned) return;
    setMood(moodFromHue(activeLocation.hue));
  }, [episode?.id, episode?.locationId, episode?.moodPinned, activeLocation?.id, activeLocation?.hue, setMood]);

  if (scrollEpisode.current !== episode?.id) {
    scrollEpisode.current = episode?.id;
    followScroll.current = true;
    replyAnchor.current = 'idle';
  }
  if (streaming && !streamingScroll.current && followScroll.current) {
    replyFrom.current = turns.length;
    replyAnchor.current = 'await';
    followScroll.current = false;
  }
  if (!streaming && replyAnchor.current === 'await' && turns.length <= replyFrom.current) {
    replyAnchor.current = 'idle';
  }
  streamingScroll.current = streaming;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || book) return;
    let lastHeight = el.scrollHeight;
    const pin = () => {
      lastHeight = el.scrollHeight;
      if (replyAnchor.current === 'await') {
        const anchor = turns[replyFrom.current];
        const node = anchor
          ? el.querySelector(`[data-turn-id="${anchor.id}"]`)
          : null;
        if (!(node instanceof HTMLElement)) return;
        const top = node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
        scrollPin.current += 1;
        el.scrollTop = Math.max(0, top);
        followScroll.current = false;
        replyAnchor.current = 'idle';
        requestAnimationFrame(() => {
          scrollPin.current = Math.max(0, scrollPin.current - 1);
        });
        return;
      }
      if (!followScroll.current) return;
      scrollPin.current += 1;
      el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => {
        scrollPin.current = Math.max(0, scrollPin.current - 1);
        if (scrollPin.current > 0) return;
        const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
        followScroll.current = gap < 48;
      });
    };
    pin();
    const observer = new ResizeObserver(pin);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    const onScroll = () => {
      const height = el.scrollHeight;
      const shrank = height < lastHeight;
      lastHeight = height;
      const gap = height - el.scrollTop - el.clientHeight;
      // When a reply finishes, the live tail unmounts a render before its saved
      // turn arrives from the database. The column shrinks, the browser clamps
      // scrollTop to the new bottom and fires a scroll event. That is not the
      // reader asking to follow; treating it as one jumps them to the end once
      // the saved turn lands.
      if (scrollPin.current > 0 || shrank) {
        if (gap >= 48) followScroll.current = false;
        return;
      }
      followScroll.current = gap < 48;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener('scroll', onScroll);
    };
  }, [book, turns.length, episode?.id, storyRowsReady, fontPx, height]);

  /** Shared streaming runner behind write / rewrite / retry. */
  const runNarration = async (
    mode: ComposeMode,
    text: string,
    lengthOverride?: TurnLength,
    actionWeight?: ActionWeight,
    handsId?: string | null,
    writeToken?: symbol,
    keepExistingUserTurn?: boolean,
    address?: LineAddress,
    worldMove?: boolean
  ): Promise<{ status: 'ok' | 'error' | 'aborted'; beatsCompleted: number; remaining: number }> => {
    if (!world || !season || !episode) return { status: 'error', beatsCompleted: 0, remaining: 0 };
    setError('');
    setNotice('');
    // Undo would remove whatever is written next, so the offer ends here.
    setRewound(null);
    setStreaming(true);
    setTailHasText(false);
    setProgressLabel('Writing…');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await writeTurn({
        world, season, episode, mode, input: text, length: lengthOverride ?? length,
        weight: actionWeight ?? weight,
        asCharacterId: handsId === undefined ? (asCharacterId ?? undefined) : (handsId ?? undefined),
        ...(address?.toCharacterId ? { toCharacterId: address.toCharacterId } : {}),
        ...(address?.toGuestId ? { toGuestId: address.toGuestId } : {}),
        ...(address?.toPlayer ? { toPlayer: true } : {}),
        ...(worldMove ? { worldMove: true } : {}),
        signal: controller.signal,
        writeToken,
        keepExistingUserTurn,
        onProgress: (label) => setProgressLabel(label),
        onNotice: setNotice,
        onDelta: (p, meta) => {
          streamSink.current(p, meta);
        }
      });
      setTailHasText(false);
      setPageReveal((n) => n + 1);
      return { status: 'ok', beatsCompleted: 1, remaining: 0 };
    } catch (e) {
      setTailHasText(false);
      if (e instanceof WriteAbortedError || (e as Error).name === 'AbortError') {
        const n = e instanceof WriteAbortedError ? e.beatsCompleted : 0;
        setNotice(abortWriteNotice(n, 0));
        return { status: 'aborted', beatsCompleted: n, remaining: 0 };
      }
      setError(classifyError(e));
      return { status: 'error', beatsCompleted: 0, remaining: 0 };
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
    const token = tryBeginStoryWrite();
    if (!token) { setNotice(WRITE_BUSY_NOTE); return; }
    const sceneNpcs = characters.filter((c) => episode.castIds.includes(c.id) && !c.isPlayer);
    const outgoing = composeOutgoingLine({
      direct,
      asCharacterId,
      sceneHasOthers: sceneNpcs.length > 0,
      tone: speechTone,
      text: input
    });
    const address = lineAddress({
      direct,
      asCharacterId,
      target: speakTo,
      characters,
      castIds: episode.castIds,
      guests: episode.guests ?? [],
      activeGuestIds: episode.activeGuestIds
    });
    const text = input;
    setInput('');
    try {
      const result = await runNarration(
        outgoing.mode,
        outgoing.text,
        undefined,
        weight,
        outgoing.asCharacterId,
        token,
        undefined,
        address
      );
      if (result.status !== 'ok' && result.beatsCompleted === 0 && result.remaining === 0) {
        setInput(text);
      }
    } finally {
      endStoryWrite(token);
    }
  };

  /** Advance the chapter from where it left off. The draft in the box stays unsent. */
  const continueStory = async () => {
    if (!world || !season || !episode || streaming) return;
    if (!hasAI) {
      setNotice(NOTICE_ADD_MODEL);
      return;
    }
    if (writeReady && writeReady.missing.length > 0 && !writeAnyway) {
      setNotice('Add the missing items above, or press Write anyway.');
      return;
    }
    const token = tryBeginStoryWrite();
    if (!token) { setNotice(WRITE_BUSY_NOTE); return; }
    try {
      await runNarration('continue', '', undefined, weight, null, token);
    } finally {
      endStoryWrite(token);
    }
  };

  const lastTurnId = turns[turns.length - 1]?.id;
  // Ideas belong to the turn they were written after; a newer turn makes them stale.
  const nextIdeas = episode?.suggestions && episode.suggestions.afterTurnId === lastTurnId
    ? episode.suggestions.items
    : [];
  const canRewindHere = (turn: Turn) =>
    !!episode && turn.episodeId === episode.id && turn.id !== lastTurnId;

  /** The world takes a turn: someone here acts on what they want. */
  const passTime = async () => {
    if (!world || !season || !episode || streaming) return;
    if (!hasAI) {
      setNotice(NOTICE_ADD_MODEL);
      return;
    }
    const token = tryBeginStoryWrite();
    if (!token) { setNotice(WRITE_BUSY_NOTE); return; }
    try {
      await runNarration('continue', '', undefined, weight, null, token, undefined, undefined, true);
    } finally {
      endStoryWrite(token);
    }
  };

  /** Drop everything after this line, with Undo. */
  const rewindHere = async (turn: Turn) => {
    if (!episode || streaming) return;
    const token = tryBeginStoryWrite();
    if (!token) { setNotice(WRITE_BUSY_NOTE); return; }
    setError('');
    setNotice('');
    try {
      const undo = await rewindTo(turn);
      setRewound(undo);
      if (editing && undo?.removed.some((t) => t.id === editing.id)) setEditing(null);
    } catch (e) {
      setError(classifyError(e));
    } finally {
      endStoryWrite(token);
    }
  };

  const undoLastRewind = async () => {
    const undo = rewound;
    if (!undo || streaming) return;
    const token = tryBeginStoryWrite();
    if (!token) { setNotice(WRITE_BUSY_NOTE); return; }
    setRewound(null);
    try {
      await undoRewind(undo);
    } catch (e) {
      setError(classifyError(e));
    } finally {
      endStoryWrite(token);
    }
  };

  /** Show another kept version of a rewritten reply. */
  const flipAlt = async (turn: Turn, index: number) => {
    if (streaming) return;
    try {
      await switchTurnAlt(turn.id, turn.episodeId, index);
    } catch (e) {
      setError(classifyError(e));
    }
  };

  const beginEdit = (turn: Turn) => {
    flushSync(() => {
      setComposerOpen(true);
      setEditing({ id: turn.id, text: turn.text });
    });
    const field = document.querySelector('textarea[aria-label="Edit this line"]');
    if (field instanceof HTMLTextAreaElement) {
      field.focus();
      const end = field.value.length;
      field.setSelectionRange(end, end);
    }
  };

  const saveEdit = async () => {
    if (!editing || !episode || editBusy) return;
    const text = editing.text.trim();
    if (!text) return;
    const current = turns.find((turn) => turn.id === editing.id);
    if (current?.text === text) {
      setEditing(null);
      return;
    }
    setEditBusy(true);
    setError('');
    try {
      // Tagged beats described the old wording; the prose splitter reads the edit.
      const now = Date.now();
      const versioned = current ? editAltPatch(current, text, now) : null;
      await db.turns.update(editing.id, { text, beats: undefined, ...(versioned ?? {}), updatedAt: now });
      await finalizeChapterMemory(episode.id);
      setEditing(null);
    } catch (e) {
      setError(classifyError(e));
    } finally {
      setEditBusy(false);
    }
  };

  const deletePassage = async (turn: Turn, fromHere: boolean) => {
    if (!episode || streaming) return;
    if (turn.role !== 'narrator' && turn.role !== 'character') return;
    const ok = fromHere
      ? window.confirm('Delete this line and everything after it in this chapter?')
      : window.confirm('Delete this line?');
    if (!ok) return;
    setError('');
    setNotice('');
    try {
      if (fromHere) await deleteTurnsFrom(turn.id, episode.id);
      else await deleteTurn(turn.id, episode.id);
      await finalizeChapterMemory(episode.id);
      if (editing?.id === turn.id) setEditing(null);
    } catch (e) {
      setError(classifyError(e));
    }
  };

  const makePicture = async () => {
    if (!world || !episode || pictureBusy) return;
    const text = picturePrompt.trim();
    if (!text) return;
    const controller = new AbortController();
    pictureAbortRef.current = controller;
    setPictureBusy(true);
    setError('');
    try {
      const dataUrl = await generateChapterPicture({
        world,
        characters,
        castIds: episode.castIds,
        userPrompt: text,
        style: rememberedPortraitStyle(),
        place: activeLocation ?? null,
        signal: controller.signal
      });
      if (controller.signal.aborted) return;
      const illustration: ChapterIllustration = {
        id: crypto.randomUUID(),
        prompt: text,
        dataUrl,
        createdAt: Date.now()
      };
      await db.episodes.update(episode.id, {
        illustrations: [...(episode.illustrations ?? []), illustration],
        updatedAt: Date.now()
      });
      setPicturePrompt('');
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return;
      setError(classifyError(e));
    } finally {
      if (pictureAbortRef.current === controller) pictureAbortRef.current = null;
      setPictureBusy(false);
    }
  };

  /** Replace one narrator or character line. Later lines stay. */
  const rewritePassage = async (turn: Turn) => {
    if (!world || !season || !episode || streaming) return;
    if (turn.role !== 'narrator' && turn.role !== 'character') return;
    const token = tryBeginStoryWrite();
    if (!token) { setNotice(WRITE_BUSY_NOTE); return; }
    setError('');
    setNotice('');
    setStreaming(true);
    setTailHasText(false);
    setProgressLabel('Rewriting…');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await regenerateBeat({
        world, season, episode, turn, length,
        signal: controller.signal,
        onProgress: (label) => setProgressLabel(label),
        onDelta: (partial, meta) => { streamSink.current(partial, meta); }
      });
      setTailHasText(false);
      setPageReveal((n) => n + 1);
    } catch (e) {
      setTailHasText(false);
      if (e instanceof WriteAbortedError || (e as Error).name === 'AbortError') {
        setNotice('Rewrite stopped. The previous line is still there.');
      } else {
        setError(classifyError(e));
      }
    } finally {
      setStreaming(false);
      setProgressLabel('');
      abortRef.current = null;
      endStoryWrite(token);
    }
  };

  /** Keep a You or Write-as line and write the reply after it again. */
  const rewriteFromInjection = async (turn: Turn) => {
    if (!world || !season || !episode || streaming) return;
    if (!canRewriteFromHere(turn)) return;
    if (!hasAI) {
      setNotice(NOTICE_ADD_MODEL);
      return;
    }
    const ok = window.confirm('Rewrite everything after this line? This line stays.');
    if (!ok) return;
    const token = tryBeginStoryWrite();
    if (!token) { setNotice(WRITE_BUSY_NOTE); return; }
    // The same snapshot as Rewind, so a failed rewrite also gives back what
    // people remembered of the lines it removed.
    let undo: RewindUndo | null = null;
    try {
      undo = await rewindTo(turn);
      const result = await runNarration(
        turn.mode && turn.mode !== 'continue' ? turn.mode : 'play',
        turn.text,
        undefined,
        turn.weight ?? 'matters',
        turn.asCharacterId ?? null,
        token,
        true,
        {
          ...(turn.toCharacterId ? { toCharacterId: turn.toCharacterId } : {}),
          ...(turn.toGuestId ? { toGuestId: turn.toGuestId } : {})
        }
      );
      if (result.status !== 'ok' && result.beatsCompleted === 0 && undo) {
        await undoRewind(undo);
        setError('');
        setNotice('The rewrite did not land. The earlier lines are back.');
      }
    } catch (e) {
      if (undo) await undoRewind(undo).catch(() => undefined);
      setError(classifyError(e));
    } finally {
      endStoryWrite(token);
    }
  };

  /** End with a minimal recap so the next chapter still has memory. An empty chapter just opens the next one. */
  const skipWrapAndEnd = async () => {
    if (!world || !season || !episode) return;
    if (wrapBusyRef.current) return;
    wrapBusyRef.current = true;
    setWrapBusy(true);
    setError('');
    try {
      let atmosphereNote: string | undefined;
      let movedOn: string[] = [];
      if (turns.length > 0) {
        const filed = await commitSoftEpisodeWrap(world, season, episode);
        atmosphereNote = filed.atmosphereNote;
        movedOn = (filed.wrap.offscreen ?? []).map((o) => o.name);
      }
      const carried = pendingPlotTargets(episode.plotTargets);
      await nextEpisode(episode, {
        ...(atmosphereNote ? { atmosphereNote } : {}),
        ...(carried.length > 0 ? { plotTargets: carried } : {})
      });
      // Say who moved, never what they did: that is for the story to reveal.
      setNotice(movedOn.length > 0
        ? `Chapter ended. While you were away, ${namesPhrase(movedOn)} went on with their lives.`
        : 'Chapter ended. The next chapter is open.');
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
      const guestKey = guestList.map((g) => `${g.id}\t${g.name}`).join('\n');
      const textKey = `${t.text}\t${t.asCharacterId ?? ''}\t${guestKey}`;
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
  const sceneCalendar = worldCalendar(world);
  const sceneDate = formatStoryDate(sceneCalendar, episodeSceneDay(episode, sceneCalendar));
  const stageCast = inScene;
  const stageGuests = episode.activeGuestIds == null
    ? guests
    : guests.filter((g) => episode.activeGuestIds!.includes(g.id));
  const writing = writingLineText(streaming, tailHasText, progressLabel);
  const speakingAs = direct
    ? 'Direct'
    : asCharacterId
      ? (characters.find((c) => c.id === asCharacterId)?.name.trim() || 'Them')
      : 'You';
  const aimed = lineAddress({
    direct,
    asCharacterId,
    target: speakTo,
    characters,
    castIds: episode.castIds,
    guests: episode.guests ?? [],
    activeGuestIds: episode.activeGuestIds
  });
  const toName = !aimed
    ? ''
    : aimed.toPlayer
      ? 'you'
      : aimed.toCharacterId
        ? (characters.find((c) => c.id === aimed.toCharacterId)?.name.trim() || '')
        : (stageGuests.find((g) => g.id === aimed.toGuestId)?.name.trim() || '');
  const speakingLabel = toName ? `${speakingAs} to ${toName}` : speakingAs;
  const composePrompt = direct
    ? 'What should happen next?'
    : asCharacterId
      ? 'What do they do?'
      : 'What do you do, or what do you say?';
  const composeStatus = `${speakingLabel} · ${weight === 'moment' ? 'Just this moment' : 'Changes things'} · ${
    length === 'beat' ? 'Short' : length === 'episode' ? 'Long' : 'Normal'
  }`;
  const sendTitle = `Send (${/Mac|iPhone|iPad|iPod/.test(navigator.platform) ? 'Cmd' : 'Ctrl'}+Enter)`;
  const chapters = seasonEpisodes ?? [];
  const picturePlacement = placeChapterPictures({
    turns: manuscript.map((entry) => ({
      id: entry.turn.id,
      episodeId: entry.episode.id,
      createdAt: entry.turn.createdAt
    })),
    episodeOrder: chapters.map((chapter) => chapter.id),
    pictures: chapters.flatMap((chapter) =>
      (chapter.illustrations ?? []).map((picture) => ({ episodeId: chapter.id, picture }))
    ),
    windowSize: turnWindow
  });
  const bookPieces: BookPiece[] = [];
  if (book) {
    const visible = manuscript.slice(-turnWindow);
    const chapterTitle = episode.title.trim() || activeLocation?.name || episode.location || 'Untitled chapter';
    if (manuscript.length > turnWindow) {
      bookPieces.push({
        key: 'earlier',
        node: (
          <div style={{ textAlign: 'center', marginBottom: 16 }}>
            <button
              type="button"
              className="serif"
              onClick={() => setTurnWindow((n) => n + 60)}
              style={{
                border: 0, background: 'transparent', cursor: 'pointer',
                fontSize: 14, fontStyle: 'italic', color: 'var(--ink-muted)', padding: '6px 8px'
              }}
            >
              Show earlier turns
            </button>
          </div>
        )
      });
    }
    bookPieces.push({
      key: 'head',
      node: (
        <header style={{ marginBottom: turns.length === 0 ? 22 : 16 }}>
          <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
            {activeLocation && (
              <div style={{ ...locationThumb(activeLocation, turns.length === 0 ? 52 : 32), marginTop: turns.length === 0 ? 12 : 2 }} />
            )}
            <div style={{ minWidth: 0, flex: 1 }}>
              {turns.length === 0 ? (
                <>
                  <div className="serif" style={{ fontSize: 11, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--ink-muted)', fontWeight: 500 }}>
                    Chapter {numberWord(episode.number)}
                  </div>
                  <div className="serif" style={{ fontSize: 32, fontWeight: 400, lineHeight: 1.2, margin: '12px 0 0', color: 'var(--ink-heading)' }}>
                    {chapterTitle}
                  </div>
                  <StoryDateButton date={sceneDate} opening onEdit={() => setDateOpen(true)} />
                </>
              ) : (
                <div className="serif" style={{ fontSize: 13, letterSpacing: '0.14em', textTransform: 'uppercase', lineHeight: 1.45, color: 'var(--ink-muted)' }}>
                  {chapterTitle}{sceneDate ? ' · ' : ''}
                  <StoryDateButton date={sceneDate} onEdit={() => setDateOpen(true)} />
                </div>
              )}
            </div>
          </div>
          {(stageCast.length > 0 || stageGuests.length > 0) && (
            <SceneCastStrip cast={stageCast} guests={stageGuests} empty={turns.length === 0} onOpen={goCast} />
          )}
        </header>
      )
    });
    if (openingNote && turns.length === 0) {
      const noteStyle: CSSProperties = {
        fontSize: fontPx, lineHeight: 1.82, margin: '0 0 18px', fontStyle: 'italic', color: 'var(--paper)'
      };
      bookPieces.push({
        key: 'opening',
        text: openingNote,
        node: <p className="serif" style={noteStyle}>{openingNote}</p>,
        renderSlice: (slice) => <p className="serif" style={noteStyle}>{slice}</p>
      });
    }
    if (turns.length === 0) {
      bookPieces.push({
        key: 'empty',
        node: (
          <div style={{ fontSize: 14, lineHeight: 1.7, display: 'flex', flexDirection: 'column', gap: 16 }}>
            {episode.number === 1 && season.premise ? (
              <p className="serif" style={{ fontSize: fontPx, lineHeight: 1.82, margin: 0, fontStyle: 'italic', color: 'var(--ink-muted)' }}>
                {season.premise}
              </p>
            ) : !openingNote ? (
              <p className="serif" style={{ fontSize: fontPx, lineHeight: 1.82, margin: 0, fontWeight: 300, color: 'var(--ink-muted)' }}>
                Nothing here yet. Write the first turn.
              </p>
            ) : null}
            {hasAI && (
              <button
                className="btn-ghost"
                style={{ fontSize: 12, padding: '8px 14px', alignSelf: 'flex-start' }}
                disabled={!!streaming}
                onClick={() => {
                  void (async () => {
                    setError('');
                    setProgressLabel('Writing opening…');
                    setStreaming(true);
                    let opened = false;
                    try {
                      await draftColdOpenNarration(world, season, episode);
                      opened = true;
                    } catch (e) {
                      setError(classifyError(e));
                    } finally {
                      setStreaming(false);
                      setProgressLabel('');
                      if (opened) setPageReveal((n) => n + 1);
                    }
                  })();
                }}
              >
                Draft opening
              </button>
            )}
          </div>
        )
      });
    }
    for (const picture of picturePlacement.leading) {
      bookPieces.push({
        key: `picture-${picture.id}`,
        node: <ChapterFigure picture={picture} />
      });
    }
    let prevEpisodeId = '';
    visible.forEach(({ episode: chapter, turn, blocks }, ti) => {
      const showBreak = chapter.id !== prevEpisodeId && !(prevEpisodeId === '' && chapter.id === episode.id);
      prevEpisodeId = chapter.id;
      if (showBreak) {
        const breakTitle = chapter.title.trim() || chapter.location || `Chapter ${chapter.number}`;
        bookPieces.push({
          key: `break-${chapter.id}`,
          node: (
            <div style={{ margin: '1.6em 0 1.2em', textAlign: 'center' }}>
              <div className="serif" style={{ fontSize: 11, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'var(--ink-muted)' }}>
                Chapter {chapter.number}
              </div>
              <div className="serif" style={{ fontSize: 26, fontWeight: 400, marginTop: 10, color: 'var(--ink-heading)' }}>{breakTitle}</div>
            </div>
          )
        });
      }
      for (const picture of picturePlacement.before.get(turn.id) ?? []) {
        bookPieces.push({
          key: `picture-${picture.id}`,
          node: <ChapterFigure picture={picture} />
        });
      }
      const continued = attributionRun(blocks, ti > 0 ? lastSpokenBy(visible[ti - 1].blocks) : null);
      blocks.forEach((block, bi) => {
        const opening = manuscript.length <= turnWindow && ti === 0 && bi === 0;
        const fromPlayer = turn.role === 'user';
        const renderBlock = (b: ProseBlock, isOpening: boolean) => (
          <ProseBlockView
            b={b}
            accent={M.accent}
            prose={M.prose}
            fontPx={fontPx}
            avatarPx={avatarPx}
            dialogueStyle="prose"
            continues={continued[bi]}
            opening={isOpening}
            fromPlayer={fromPlayer}
          />
        );
        bookPieces.push({
          key: `${turn.id}:${bi}`,
          text: block.text,
          node: renderBlock(block, opening),
          renderSlice: (slice) => renderBlock(
            { ...block, text: slice, segments: block.segments ? parseSpeakSegments(slice) : undefined },
            opening && block.text.startsWith(slice)
          )
        });
      });
      const canEdit = turn.role === 'narrator' || turn.role === 'character';
      const fromUser = canRewriteFromHere(turn);
      if (canEdit || fromUser) {
        bookPieces.push({
          key: `tools-${turn.id}`,
          node: (
            <TurnTools
              streaming={streaming}
              canEdit={canEdit}
              editing={editing?.id === turn.id}
              onEdit={() => beginEdit(turn)}
              onRewrite={canEdit ? () => { void rewritePassage(turn); } : undefined}
              onRewriteFromHere={fromUser ? () => { void rewriteFromInjection(turn); } : undefined}
              onDeleteLine={canEdit ? () => { void deletePassage(turn, false); } : undefined}
              onDeleteFromHere={canEdit ? () => { void deletePassage(turn, true); } : undefined}
              alt={canEdit ? altPosition(turn) : null}
              onAlt={canEdit ? (index) => { void flipAlt(turn, index); } : undefined}
              onRewindHere={canRewindHere(turn) ? () => { void rewindHere(turn); } : undefined}
            />
          )
        });
      }
      for (const picture of picturePlacement.after.get(turn.id) ?? []) {
        bookPieces.push({
          key: `picture-${picture.id}`,
          node: <ChapterFigure picture={picture} />
        });
      }
    });
    if (writing) {
      bookPieces.push({
        key: 'writing',
        node: <WritingLine text={writing} fontPx={fontPx} />
      });
    }
  }
  const bookSignature = book
    ? `${episode.id}\n${fontPx}\n${turnWindow}\n${writing ?? ''}\n${editing?.id ?? ''}\n${chapters.flatMap((chapter) => (chapter.illustrations ?? []).map((picture) => picture.id)).join(',')}\n${manuscript.map((entry) => `${entry.turn.id}:${entry.turn.text.length}`).join('|')}`
    : '';

  return (
    <div
      key="story-shell"
      className={readMode ? 'read-mode' : undefined}
      style={{
      position: 'relative',
      flex: 1,
      minHeight: 0,
      height: shellHeight,
      overflow: 'hidden',
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
          position: 'relative', zIndex: 5, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
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
            <button className="btn-quiet" style={{ padding: '7px 12px', fontSize: 12 }}
              onClick={() => { setJournalOpen(true); setHudTucked(false); }}>
              Journal
            </button>
            <button className="btn-quiet" style={{ padding: '7px 12px', fontSize: 12 }}
              onClick={() => { setWorldEditOpen(true); setHudTucked(false); }}>
              Edit world
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
          position: 'relative', zIndex: 2, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
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
                Chapter {episode.number}{locLabel ? ` · ${locLabel}` : ''} ·{' '}
                <StoryDateButton date={sceneDate} onEdit={() => setDateOpen(true)} />
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', borderBottom: '1px solid var(--rule)' }}>
              {([['write', 'Write'], ['read', 'Read']] as const).map(([id, label]) => (
                <button key={id} aria-pressed={layout === id} onClick={() => setLayout(id as StoryLayout)} style={{
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
            <button className="btn-ghost" style={{ padding: '8px 14px' }} onClick={() => setJournalOpen(true)}>Journal</button>
            <button className="btn-ghost" style={{ padding: '8px 14px' }} onClick={() => setWorldEditOpen(true)}>Edit world</button>
            {short ? (
              <button className="btn-ghost" style={{ padding: '7px 12px', fontSize: 11, minHeight: 36 }} onClick={() => setMoreSheet(true)}>More</button>
            ) : (
              <button className="btn-ghost" style={{ padding: '8px 14px' }} onClick={() => setDisplayOpen(true)}>Display</button>
            )}
          </div>
        </div>
      )}

      {/* body — the manuscript column, or a book on the open Fold */}
      <div
        aria-busy={streaming}
        style={{
          position: 'relative', zIndex: 2, flex: 1, display: 'grid', minHeight: 0, overflow: 'hidden',
          gridTemplateColumns: 'minmax(0, 1fr)',
          gridTemplateRows: 'minmax(0, 1fr)'
        }}
      >
        {book ? (
          <BookStage
            episodeId={episode.id}
            reveal={pageReveal}
            streaming={streaming}
            fontPx={fontPx}
            signature={bookSignature}
            pieces={bookPieces}
            stain={<PageStain mood={mood} />}
            tail={(
              <StreamTail
                sinkRef={streamSink}
                active={streaming}
                scrollRef={scrollRef}
                followRef={followScroll}
                pinRef={scrollPin}
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
            )}
          />
        ) : null}
        {!book && (
        <section ref={scrollRef} style={{ overflow: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>

          <div
            className="page-plane"
            style={{
              position: 'relative',
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
            <PageStain mood={mood} />
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
                  <StoryDateButton date={sceneDate} opening onEdit={() => setDateOpen(true)} />
                </>
              ) : (
                <div className="serif" style={{
                  fontSize: 13, letterSpacing: '0.14em', textTransform: 'uppercase', lineHeight: 1.45,
                  color: 'var(--ink-muted)'
                }}>
                  {episode.title.trim() || activeLocation?.name || episode.location}
                  {sceneDate ? ' · ' : ''}
                  <StoryDateButton date={sceneDate} onEdit={() => setDateOpen(true)} />
                </div>
              )}
                </div>
              </div>
              <div style={{ position: 'relative', marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn-quiet"
                  aria-haspopup="menu"
                  aria-expanded={placeMenuOpen}
                  onClick={() => setPlaceMenuOpen((open) => !open)}
                  style={{ fontSize: 12, padding: '4px 8px', display: 'inline-flex', gap: 6, alignItems: 'center' }}
                >
                  <span aria-hidden>⌖</span>
                  {activeLocation
                    ? `${activeLocation.name.trim() || 'Unnamed place'}${placeWhereLine(activeLocation, locations) ? ` · ${placeWhereLine(activeLocation, locations)}` : ''}`
                    : 'Choose where this happens'}
                  <span aria-hidden style={{ fontSize: 9 }}>▾</span>
                </button>
                {sceneMove && sceneMove.toId === episode.locationId && (
                  <span style={{ fontSize: 12, color: 'var(--ink-muted)', display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                    {sceneMove.created ? `New place: ${sceneMove.toName}` : `Moved to ${sceneMove.toName}`}
                    <button type="button" className="btn-quiet" style={{ fontSize: 11 }} onClick={() => {
                      const back = sceneMove.fromId;
                      setSceneMove(null);
                      void safeWrite(() => setScenePlace(episode.id, back), setError);
                    }}>undo</button>
                    <button type="button" className="btn-quiet" style={{ fontSize: 11 }} onClick={() => setSceneMove(null)}>ok</button>
                  </span>
                )}
                {placeMenuOpen && (
                  <div role="menu" className="glass-clear" style={{
                    position: 'absolute', top: '100%', left: 0, zIndex: 30, marginTop: 6,
                    minWidth: 240, maxWidth: 'min(360px, calc(100vw - 48px))', maxHeight: 320, overflowY: 'auto',
                    padding: 8, borderRadius: 12, border: '1px solid var(--glass-rim)', background: 'var(--page)',
                    display: 'flex', flexDirection: 'column', gap: 2
                  }}>
                    {locations.length === 0 && (
                      <div style={{ fontSize: 12.5, color: 'var(--ink-muted)', padding: '6px 8px' }}>No places yet.</div>
                    )}
                    {placeTree(locations).map(({ place, depth }) => {
                      const here = place.id === activeLocation?.id;
                      return (
                        <button
                          key={place.id}
                          type="button"
                          role="menuitem"
                          disabled={here}
                          onClick={() => {
                            setPlaceMenuOpen(false);
                            setSceneMove(null);
                            void safeWrite(() => setScenePlace(episode.id, place.id), setError);
                          }}
                          style={{
                            textAlign: 'left', border: 0, background: here ? 'var(--rule)' : 'transparent',
                            padding: '7px 8px', paddingLeft: 8 + depth * 14, borderRadius: 8, cursor: here ? 'default' : 'pointer',
                            fontSize: 13, color: 'var(--ink-heading)'
                          }}
                        >
                          {place.name.trim() || 'Unnamed place'}{here ? ' · here' : ''}
                        </button>
                      );
                    })}
                    <div style={{ borderTop: '1px solid var(--rule)', marginTop: 4, paddingTop: 4 }}>
                      <button type="button" role="menuitem" className="btn-quiet" style={{ fontSize: 12 }}
                        onClick={() => { setPlaceMenuOpen(false); goLocations(); }}>
                        Add or edit places…
                      </button>
                    </div>
                  </div>
                )}
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
                          let opened = false;
                          try {
                            await draftColdOpenNarration(world, season, episode);
                            opened = true;
                          } catch (e) {
                            setError(classifyError(e));
                          } finally {
                            setStreaming(false);
                            setProgressLabel('');
                            if (opened) setPageReveal((n) => n + 1);
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
                    <button type="button" className="btn-quiet label" style={{ opacity: 0.7, fontSize: 11 }}
                      onClick={() => setJournalOpen(true)} title="Open the journal">
                      {continuity.length} fact{continuity.length === 1 ? '' : 's'} · {threads.length} thread{threads.length === 1 ? '' : 's'}
                    </button>
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

            {picturePlacement.leading.map((picture) => (
              <ChapterFigure key={picture.id} picture={picture} />
            ))}

            {(() => {
              const visible = manuscript.slice(-turnWindow);
              let prevEpisodeId = '';
              return visible.map(({ episode: chapter, turn, blocks: bs }, ti) => {
                const showBreak = chapter.id !== prevEpisodeId
                  && !(prevEpisodeId === '' && chapter.id === episode.id);
                prevEpisodeId = chapter.id;
                const chapterTitle = chapter.title.trim() || chapter.location || `Chapter ${chapter.number}`;
                const canEdit = turn.role === 'narrator' || turn.role === 'character';
                const fromUser = canRewriteFromHere(turn);
                return (
                  <div key={turn.id} data-turn-id={turn.id}>
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
                    {(picturePlacement.before.get(turn.id) ?? []).map((picture) => (
                      <ChapterFigure key={picture.id} picture={picture} />
                    ))}
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
                      onRewrite={canEdit ? () => { void rewritePassage(turn); } : undefined}
                      onRewriteFromHere={fromUser ? () => { void rewriteFromInjection(turn); } : undefined}
                      onEdit={canEdit ? () => beginEdit(turn) : undefined}
                      onDeleteLine={canEdit ? () => { void deletePassage(turn, false); } : undefined}
                      onDeleteFromHere={canEdit ? () => { void deletePassage(turn, true); } : undefined}
                      editing={editing?.id === turn.id}
                      onAlt={canEdit ? (index) => { void flipAlt(turn, index); } : undefined}
                      onRewindHere={canRewindHere(turn) ? () => { void rewindHere(turn); } : undefined}
                    />
                    {(picturePlacement.after.get(turn.id) ?? []).map((picture) => (
                      <ChapterFigure key={picture.id} picture={picture} />
                    ))}
                  </div>
                );
              });
            })()}

            <StreamTail
              sinkRef={streamSink}
              active={streaming}
              scrollRef={scrollRef}
              followRef={followScroll}
              pinRef={scrollPin}
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
            {writing && <WritingLine text={writing} fontPx={fontPx} />}

          </div>
        </section>
        )}
        {placeCard && (
          <PlaceCard
            key={placeCard.key}
            card={placeCard}
            tint={M.tint}
            onDone={() => setPlaceCard((cur) => (cur?.key === placeCard.key ? null : cur))}
          />
        )}
      </div>

      {(error || notice || rewound) && (
        <div style={{
          position: 'relative', zIndex: 3, flexShrink: 0,
          padding: narrow ? '10px 12px 0' : '12px 24px 0',
          display: 'flex', flexDirection: 'column', gap: 10
        }}>
          {error && <ErrorNote error={error} onDismiss={() => setError('')} />}
          {rewound && !streaming && (
            <div className="glass-nudge" role="status" style={{
              border: `1px solid ${ACCENT_RGBA.a35}`,
              background: ACCENT_RGBA.a08, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap'
            }}>
              <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--paper)', flex: 1, minWidth: 0 }}>
                Rewound {rewound.removed.length} line{rewound.removed.length === 1 ? '' : 's'}.
              </div>
              <button className="btn-quiet" style={{ fontSize: 11, minHeight: 28 }} onClick={() => void undoLastRewind()}>Undo</button>
              <button className="btn-quiet" style={{ padding: '0 2px', fontSize: 14 }} aria-label="Dismiss" onClick={() => setRewound(null)}>×</button>
            </div>
          )}
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
            position: 'relative', zIndex: 4, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
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
          position: 'relative', zIndex: 4,
          flexShrink: 0,
          maxHeight: editing ? '70%' : '45%',
          minHeight: 0,
          overflow: 'hidden',
          padding: narrow
            ? (readMode ? '10px 16px 12px' : '11px 12px 12px')
            : '12px 24px 16px',
          display: 'flex', flexDirection: 'column', gap: 10
        }}>
          <div style={{
            overflow: 'auto', minHeight: 0, flex: '1 1 auto',
            display: 'flex', flexDirection: 'column', gap: 10
          }}>
          {!hasAI && turns.length > 0 && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', maxWidth: '40rem', margin: '0 auto', width: '100%' }}>
              <p style={{ fontSize: 14, margin: 0, color: 'var(--paper)', flex: 1, minWidth: 180 }}>
                Add a writing model in Settings to write.
              </p>
              <button className="btn-ghost" style={{ fontSize: 12, padding: '7px 12px' }}
                onClick={() => go('settings')}>
                Add a writing model in Settings
              </button>
            </div>
          )}
          <div style={{ maxWidth: '40rem', margin: '0 auto', width: '100%', display: 'flex', gap: 8 }}>
            <button className="btn-quiet" style={{ fontSize: 12, minHeight: 32, padding: '4px 6px' }}
              onClick={() => setOptionsOpen((o) => !o)}>
              {optionsOpen ? 'Hide options' : 'Options'}
            </button>
            <button className="btn-quiet" style={{ fontSize: 12, minHeight: 32, padding: '4px 6px' }}
              onClick={() => setPictureOpen((o) => !o)}>
              {pictureOpen ? 'Hide picture' : 'Picture'}
            </button>
          </div>
          {pictureOpen && (
            <div style={{ maxWidth: '40rem', margin: '0 auto', width: '100%', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <textarea
                value={picturePrompt}
                onChange={(e) => setPicturePrompt(e.target.value)}
                placeholder="Who is in the picture, and what are they doing?"
                rows={2}
                aria-label="Picture prompt"
                disabled={pictureBusy}
                style={{
                  width: '100%', resize: 'vertical',
                  fontFamily: 'var(--serif)', fontSize: 16, lineHeight: 1.5,
                  padding: '8px 10px', border: '1px solid var(--rule)', borderRadius: 8,
                  background: 'var(--page)', color: 'var(--page-ink)'
                }}
              />
              <div className="label" style={{ fontSize: 11 }}>
                Name characters to keep their face and written look. Add “full body” for head to toe.
              </div>
              {pictureBusy ? (
                <button className="btn-quiet" style={{ alignSelf: 'flex-start', minHeight: 36 }}
                  onClick={() => pictureAbortRef.current?.abort()}>Stop</button>
              ) : (
                <button className="btn-ghost" style={{ alignSelf: 'flex-start', fontSize: 12, padding: '7px 12px' }}
                  disabled={!picturePrompt.trim()}
                  onClick={() => { void makePicture(); }}>
                  Generate
                </button>
              )}
            </div>
          )}
          {optionsOpen && (
          <div style={{ maxWidth: '40rem', margin: '0 auto', width: '100%', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="label" style={{ fontSize: 11 }}>
              Write as
            </span>
            <Chip active={!direct && asCharacterId === null} onClick={() => { setDirect(false); setAsCharacterId(null); }}>You</Chip>
            {inScene.filter((c) => !c.isPlayer).map((c) => (
              <Chip
                key={c.id}
                active={!direct && asCharacterId === c.id}
                onClick={() => { setDirect(false); setAsCharacterId(asCharacterId === c.id ? null : c.id); }}
              >
                {c.name}
              </Chip>
            ))}
            <Chip active={direct} onClick={() => setDirect(true)}>Direct</Chip>
          </div>
          {!direct && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="label" style={{ fontSize: 11 }}>
                How it's said
              </span>
              <Chip active={speechTone === null} onClick={() => setSpeechTone(null)}>Plain</Chip>
              {DELIVERY_TONE_GROUPS.map((group) => (
                <Chip
                  key={group.id}
                  active={toneGroup === group.id || (!!speechTone && group.tones.includes(speechTone))}
                  onClick={() => setToneGroup((current) => current === group.id ? null : group.id)}
                >
                  {group.label}
                </Chip>
              ))}
            </div>
            {toneGroup && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                {DELIVERY_TONE_GROUPS.find((group) => group.id === toneGroup)?.tones.map((tone) => (
                  <Chip
                    key={tone}
                    active={speechTone === tone}
                    onClick={() => setSpeechTone((current) => current === tone ? null : tone)}
                  >
                    {tone}
                  </Chip>
                ))}
              </div>
            )}
          </div>
          )}
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
          </div>
          {editing && (
            <div style={{
              flexShrink: 0,
              maxWidth: '40rem', margin: '0 auto', width: '100%',
              display: 'flex', flexDirection: 'column', gap: 8
            }}>
              <textarea
                className="line-edit"
                value={editing.text}
                rows={4}
                aria-label="Edit this line"
                onChange={(e) => {
                  const text = e.target.value;
                  setEditing((current) => current ? { ...current, text } : current);
                }}
                style={{
                  width: '100%', resize: 'vertical', touchAction: 'manipulation',
                  fontFamily: 'var(--serif)', fontSize: 16, lineHeight: 1.6,
                  padding: '10px 12px', border: '1px solid var(--rule)', borderRadius: 8,
                  background: 'var(--page)', color: 'var(--page-ink)'
                }}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn-primary" style={{ minHeight: 40, padding: '8px 14px' }}
                  disabled={editBusy || !editing.text.trim()}
                  onClick={() => { void saveEdit(); }}>Save</button>
                <button className="btn-quiet" style={{ minHeight: 40 }} disabled={editBusy}
                  onClick={() => setEditing(null)}>Cancel</button>
              </div>
            </div>
          )}
          {!direct && (
            <div style={{
              flexShrink: 0,
              maxWidth: '40rem', margin: '0 auto', width: '100%',
              display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap'
            }}>
              <span className="label" style={{ fontSize: 11 }}>To</span>
              {asCharacterId ? (
                <>
                  <Chip active={speakTo?.kind !== 'player'} onClick={() => setSpeakTo(null)}>The room</Chip>
                  <Chip active={speakTo?.kind === 'player'} onClick={() => setSpeakTo({ kind: 'player' })}>You</Chip>
                </>
              ) : (
                <>
                  <Chip active={speakTo === null} onClick={() => setSpeakTo(null)}>Anyone</Chip>
                  {inScene.filter((c) => !c.isPlayer).map((c) => (
                    <Chip
                      key={c.id}
                      active={speakTo?.kind === 'cast' && speakTo.id === c.id}
                      onClick={() => setSpeakTo((current) =>
                        current?.kind === 'cast' && current.id === c.id ? null : { kind: 'cast', id: c.id }
                      )}
                    >
                      {c.name}
                    </Chip>
                  ))}
                  {stageGuests.map((g) => (
                    <Chip
                      key={g.id}
                      active={speakTo?.kind === 'guest' && speakTo.id === g.id}
                      onClick={() => setSpeakTo((current) =>
                        current?.kind === 'guest' && current.id === g.id ? null : { kind: 'guest', id: g.id }
                      )}
                    >
                      {g.name}
                    </Chip>
                  ))}
                </>
              )}
            </div>
          )}
          <div className="label" style={{
            flexShrink: 0,
            maxWidth: '40rem', margin: '0 auto', width: '100%',
            fontSize: 12
          }}>
            {composeStatus}
          </div>
          {!streaming && nextIdeas.length > 0 && (
            <div role="group" aria-label="Ideas for your next move" className="idea-row" style={{
              flexShrink: 0, display: 'flex', gap: 6,
              // On a phone the ideas scroll sideways in one line instead of stacking three rows.
              flexWrap: compactComposer ? 'nowrap' : 'wrap',
              overflowX: compactComposer ? 'auto' : undefined,
              maxWidth: '40rem', margin: '0 auto', width: '100%'
            }}>
              {nextIdeas.map((idea) => (
                <span key={idea} style={{ flexShrink: 0, whiteSpace: compactComposer ? 'nowrap' : undefined }}>
                  <Chip active={input.trim() === idea} onClick={() => setInput(idea)}>{idea}</Chip>
                </span>
              ))}
            </div>
          )}
          <div style={{
            flexShrink: 0,
            display: 'flex', gap: compactComposer ? 8 : 13, alignItems: 'flex-end',
            // On a phone the text gets its own full line and the buttons sit beneath it.
            flexWrap: compactComposer ? 'wrap' : 'nowrap',
            maxWidth: '40rem', margin: '0 auto', width: '100%',
            padding: '4px 0'
          }}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void write(); }
              }}
              aria-label={composePrompt}
              placeholder={composePrompt}
              rows={2}
              disabled={streaming}
              style={{
                flex: compactComposer ? '1 1 100%' : 1, border: 0, background: 'transparent', padding: '4px 0',
                fontSize: narrow ? 16 : 18, lineHeight: 1.7,
                minHeight: 44
              }}
            />
            {streaming ? (
              <button className="btn-quiet" style={{ alignSelf: 'flex-end', minHeight: 44 }} onClick={() => abortRef.current?.abort()}>Stop</button>
            ) : (
              <>
                <button
                  className="btn-quiet"
                  style={{ alignSelf: 'flex-end', minHeight: 44, ...(compactComposer ? { marginLeft: 'auto' } : {}) }}
                  title="Continue the story from here"
                  onClick={() => void continueStory()}
                >
                  Continue
                </button>
                {turns.length > 0 && (
                  <button
                    className="btn-quiet"
                    style={{ alignSelf: 'flex-end', minHeight: 44 }}
                    title="Let time pass: someone here acts on what they want"
                    onClick={() => void passTime()}
                  >
                    Let time pass
                  </button>
                )}
                <button
                  className="btn-primary"
                  style={{ alignSelf: 'flex-end', padding: '10px 19px', minHeight: 44 }}
                  title={sendTitle}
                  disabled={!input.trim()}
                  onClick={() => void write()}
                >
                  Send
                </button>
              </>
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
          <button className="btn-ghost" style={{ minHeight: 44, textAlign: 'left' }} onClick={() => { setMoreSheet(false); setJournalOpen(true); }}>
            Journal
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

      <Sheet open={dateOpen} onClose={() => setDateOpen(false)} narrow={sheetBottom} width={420}
        footer={
          <button className="btn-primary" style={{ width: '100%', minHeight: 44 }} onClick={() => setDateOpen(false)}>Done</button>
        }
      >
        <div className="serif" style={{ fontWeight: 300, fontSize: 24, color: 'var(--ink-heading)' }}>Story date</div>
        <StoryDateFields world={world} season={season} episode={episode} narrow={sheetBottom} />
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

      <JournalSheet
        open={journalOpen}
        onClose={() => setJournalOpen(false)}
        narrow={sheetBottom}
        world={world}
        season={season}
        episode={episode}
        characters={characters}
      />

      {/* display settings */}
      <DisplaySheet
        open={displayOpen} onClose={() => setDisplayOpen(false)} narrow={sheetBottom}
      />
    </div>
  );
}

// ---------- display settings ----------

function SliderRow({ label, value, min, max, step, unit, onChange }: {
  label: string; value: number; min: number; max: number; step?: number; unit?: string;
  onChange: (v: number) => void;
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
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ padding: 0, height: 4 }}
      />
    </div>
  );
}

function DisplaySheet({ open, onClose, narrow }: {
  open: boolean; onClose: () => void; narrow: boolean;
}) {
  const { display, setDisplay } = useApp(useShallow((s) => ({ display: s.display, setDisplay: s.setDisplay })));
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
          <SliderRow
            label="Portrait size" value={display.avatarSize}
            min={AVATAR_MIN} max={AVATAR_MAX} step={AVATAR_STEP} unit="px"
            onChange={(v) => setDisplay({ avatarSize: v })}
          />
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

function TurnTools({
  streaming, canEdit, editing, onEdit, onRewrite, onRewriteFromHere, onDeleteLine, onDeleteFromHere,
  alt, onAlt, onRewindHere
}: {
  streaming: boolean;
  canEdit: boolean;
  editing: boolean;
  onEdit: () => void;
  onRewrite?: () => void;
  onRewriteFromHere?: () => void;
  onDeleteLine?: () => void;
  onDeleteFromHere?: () => void;
  /** Kept versions of this reply, when there is more than one. */
  alt?: { index: number; count: number } | null;
  onAlt?: (index: number) => void;
  onRewindHere?: () => void;
}) {
  if (!canEdit && !onRewrite && !onRewriteFromHere && !onDeleteLine && !onDeleteFromHere && !alt && !onRewindHere) return null;
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4, marginBottom: 10, flexWrap: 'wrap' }}>
      {alt && onAlt && (
        <div role="group" aria-label="Versions of this passage" style={{ display: 'flex', alignItems: 'center', gap: 2, marginRight: 'auto' }}>
          <button className="btn-quiet" style={{ fontSize: 14, padding: '6px 10px', minHeight: 36 }}
            aria-label="Previous version" disabled={streaming || alt.index === 0}
            onClick={() => onAlt(alt.index - 1)}>‹</button>
          <span className="label" style={{ fontSize: 11, minWidth: 34, textAlign: 'center' }}>{alt.index + 1} / {alt.count}</span>
          <button className="btn-quiet" style={{ fontSize: 14, padding: '6px 10px', minHeight: 36 }}
            aria-label="Next version" disabled={streaming || alt.index >= alt.count - 1}
            onClick={() => onAlt(alt.index + 1)}>›</button>
        </div>
      )}
      {canEdit && (
        <button className="btn-quiet" style={{ fontSize: 12, padding: '6px 10px', minHeight: 36 }} disabled={streaming || editing} onClick={onEdit}>
          {editing ? 'Editing' : 'Edit'}
        </button>
      )}
      {onRewrite && (
        <button className="btn-quiet" style={{ fontSize: 12, padding: '6px 10px', minHeight: 36 }} disabled={streaming} onClick={onRewrite}>
          Rewrite this passage
        </button>
      )}
      {onRewriteFromHere && (
        <button className="btn-quiet" style={{ fontSize: 12, padding: '6px 10px', minHeight: 36 }} disabled={streaming} onClick={onRewriteFromHere}>
          Rewrite from here
        </button>
      )}
      {onDeleteLine && (
        <button className="btn-quiet" style={{ fontSize: 12, padding: '6px 10px', minHeight: 36 }} disabled={streaming} onClick={onDeleteLine}>
          Delete line
        </button>
      )}
      {onRewindHere && (
        <button className="btn-quiet" style={{ fontSize: 12, padding: '6px 10px', minHeight: 36 }} disabled={streaming} onClick={onRewindHere}
          title="Remove everything after this line. You can undo it.">
          Rewind to here
        </button>
      )}
      {onDeleteFromHere && (
        <button className="btn-quiet" style={{ fontSize: 12, padding: '6px 10px', minHeight: 36 }} disabled={streaming} onClick={onDeleteFromHere}>
          Delete from here
        </button>
      )}
    </div>
  );
}

function TurnRow({
  turn, blocks, accent, prose, fontPx, avatarPx, dialogueStyle, prevSpeaker, streaming, opening,
  onRewrite, onRewriteFromHere, onEdit, onDeleteLine, onDeleteFromHere, editing, onAlt, onRewindHere
}: {
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
  onRewriteFromHere?: () => void;
  onEdit?: () => void;
  onDeleteLine?: () => void;
  onDeleteFromHere?: () => void;
  editing?: boolean;
  onAlt?: (index: number) => void;
  onRewindHere?: () => void;
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
      <TurnTools
        streaming={streaming}
        canEdit={!!onEdit}
        editing={!!editing}
        onEdit={onEdit ?? (() => undefined)}
        onRewrite={onRewrite}
        onRewriteFromHere={onRewriteFromHere}
        onDeleteLine={onDeleteLine}
        onDeleteFromHere={onDeleteFromHere}
        alt={onAlt ? altPosition(turn) : null}
        onAlt={onAlt}
        onRewindHere={onRewindHere}
      />
    </div>
  );
}

/** The place's mood laid over the sheet: a flat wash plus that climate's edge stain. */
function PageStain({ mood }: { mood: MoodId }) {
  return (
    <div
      key={mood}
      className={`page-stain climate-${mood}`}
      style={{ backgroundColor: MOODS[mood].tint }}
      aria-hidden
    />
  );
}

interface PlaceCardInfo {
  key: string;
  name: string;
  /** The place this one sits inside. */
  within?: string;
  /** One line of feel. */
  line?: string;
}

function firstSentence(text: string | undefined, max: number): string | undefined {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  const cut = flat.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? flat;
  return cut.length > max ? `${cut.slice(0, max - 1).trimEnd()}…` : cut;
}

/** A brief title card when the scene moves to a new place. Never blocks input. */
function PlaceCard({ card, tint, onDone }: { card: PlaceCardInfo; tint: string; onDone: () => void }) {
  return (
    <div className="place-card-wrap" aria-hidden>
      <div
        className="place-card"
        style={{ backgroundImage: `linear-gradient(${tint}, ${tint})` }}
        onAnimationEnd={onDone}
      >
        {card.within && (
          <div className="serif" style={{ fontSize: 11, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'var(--ink-muted)' }}>
            {card.within}
          </div>
        )}
        <div className="serif" style={{ fontSize: 26, fontWeight: 400, marginTop: card.within ? 8 : 0, color: 'var(--ink-heading)' }}>
          {card.name}
        </div>
        {card.line && (
          <div className="serif" style={{ fontSize: 14, fontStyle: 'italic', marginTop: 10, color: 'var(--ink-muted)', lineHeight: 1.5 }}>
            {card.line}
          </div>
        )}
      </div>
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
