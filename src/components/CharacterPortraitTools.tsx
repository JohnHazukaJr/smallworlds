import { useRef, useState } from 'react';
import { generateCharacterPortrait } from '../ai/image';
import {
  rememberedPortraitFraming, rememberedPortraitStyle, rememberPortraitFraming, rememberPortraitStyle,
  type PortraitFraming, type PortraitStyle
} from '../ai/portrait';
import { formatUserError } from '../errors';
import type { Character, World } from '../types';
import { ErrorNote } from '../ui/bits';
import { fileToPortraitImage } from '../ui/image';
import { ACCENT } from '../ui/theme';
import { characterPortraits, MAX_CHARACTER_PORTRAITS, portraitsPatch } from '../worldOps';

function aborted(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

type PortraitPatch = Partial<Pick<Character, 'portraits' | 'portrait' | 'figures'>>;

const chipStyle = (on: boolean) => ({
  fontSize: 11, padding: '6px 12px', minHeight: 36,
  borderColor: on ? ACCENT : undefined,
  fontWeight: on ? 600 : 500
});

/**
 * Photo gallery for one character. The first photo is the avatar and the face
 * the story's pictures keep. Head-and-shoulders portraits join that list.
 * Full-body and scene pictures go to their own row and never become the avatar.
 */
export function CharacterPortraitTools({
  character,
  world,
  onChange
}: {
  character: Character;
  world: World | null;
  onChange: (next: PortraitPatch) => void | Promise<void>;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [style, setStyle] = useState<PortraitStyle>(rememberedPortraitStyle);
  const [framing, setFraming] = useState<PortraitFraming>(rememberedPortraitFraming);
  const [scene, setScene] = useState('');
  const [uploadBusy, setUploadBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const [error, setError] = useState('');
  const gallery = characterPortraits(character);
  const figures = character.figures ?? [];
  const full = gallery.length >= MAX_CHARACTER_PORTRAITS;
  const figuresFull = figures.length >= MAX_CHARACTER_PORTRAITS;
  /** Head and shoulders with no scene is a portrait; anything else is a figure. */
  const makesFigure = framing === 'full' || !!scene.trim();
  const targetFull = makesFigure ? figuresFull : full;
  const busy = uploadBusy || generating;

  const chooseStyle = (next: PortraitStyle) => {
    setStyle(next);
    rememberPortraitStyle(next);
  };
  const chooseFraming = (next: PortraitFraming) => {
    setFraming(next);
    rememberPortraitFraming(next);
  };

  const onFile = async (file: File) => {
    if (full) {
      setError(`Up to ${MAX_CHARACTER_PORTRAITS} photos per character.`);
      return;
    }
    setUploadBusy(true);
    setError('');
    try {
      const url = await fileToPortraitImage(file);
      await onChange(portraitsPatch([...gallery, url]));
    } catch (e) {
      setError(formatUserError(e));
    } finally {
      setUploadBusy(false);
    }
  };

  const generate = async () => {
    if (generating) {
      abortRef.current?.abort();
      return;
    }
    if (!world) {
      setError('Open a world before generating a portrait.');
      return;
    }
    if (targetFull) {
      setError(makesFigure
        ? `Up to ${MAX_CHARACTER_PORTRAITS} full-body and scene pictures per character. Remove one first.`
        : `Up to ${MAX_CHARACTER_PORTRAITS} photos per character.`);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setGenerating(true);
    setError('');
    try {
      const url = await generateCharacterPortrait({
        world,
        character,
        style,
        framing,
        scene,
        signal: controller.signal
      });
      if (makesFigure) await onChange({ figures: [...figures, url] });
      else await onChange(portraitsPatch([...gallery, url]));
    } catch (e) {
      setError(aborted(e) ? 'Portrait cancelled.' : formatUserError(e));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setGenerating(false);
    }
  };

  const generateLabel = generating
    ? 'Stop'
    : scene.trim()
      ? 'Generate scene'
      : framing === 'full'
        ? 'Generate full body'
        : gallery.length ? 'Generate another' : 'Generate portrait';

  return (
    <>
      {gallery.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {gallery.map((url, i) => (
            <div key={`${i}-${url.slice(0, 24)}`} style={{ position: 'relative' }}>
              <button
                type="button"
                aria-pressed={i === 0}
                aria-label={i === 0 ? 'Main photo, used as the avatar' : 'Make this the main photo'}
                title={i === 0 ? 'Main photo' : 'Make this the main photo'}
                onClick={() => {
                  if (i === 0 || busy) return;
                  void Promise.resolve(onChange(portraitsPatch([url, ...gallery.filter((_, j) => j !== i)])))
                    .catch((e) => setError(formatUserError(e)));
                }}
                style={{
                  width: 52, height: 52, borderRadius: 10, padding: 0, cursor: i === 0 ? 'default' : 'pointer',
                  border: i === 0 ? `2px solid ${ACCENT}` : '1px solid var(--rule)',
                  backgroundImage: `url(${url})`, backgroundSize: 'cover', backgroundPosition: 'center'
                }}
              />
              {i === 0 && (
                <span style={{
                  position: 'absolute', left: 4, bottom: 4, fontFamily: "'IBM Plex Mono', monospace",
                  fontSize: 8, letterSpacing: '0.04em', color: '#fff', background: 'rgba(0,0,0,0.55)',
                  padding: '1px 4px', borderRadius: 3, pointerEvents: 'none'
                }}>main</span>
              )}
              <button
                type="button"
                className="btn-quiet"
                title="Remove photo"
                aria-label={i === 0 ? 'Remove main photo' : 'Remove photo'}
                disabled={busy}
                onClick={() => void onChange(portraitsPatch(gallery.filter((_, j) => j !== i)))}
                style={{
                  position: 'absolute', top: -6, right: -6, width: 18, height: 18, padding: 0,
                  borderRadius: '50%', fontSize: 10, lineHeight: '18px',
                  background: 'var(--page)', border: '1px solid var(--rule)'
                }}
              >×</button>
            </div>
          ))}
        </div>
      )}
      <input
        ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ''; }}
      />
      <div role="radiogroup" aria-label="Portrait style" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {(['realistic', 'comic'] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={style === id}
            className="btn-ghost"
            style={chipStyle(style === id)}
            onClick={() => chooseStyle(id)}
          >
            {id === 'realistic' ? 'Realistic' : 'Comic'}
          </button>
        ))}
      </div>
      <div role="radiogroup" aria-label="Framing" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {(['head', 'full'] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={framing === id}
            className="btn-ghost"
            style={chipStyle(framing === id)}
            onClick={() => chooseFraming(id)}
          >
            {id === 'head' ? 'Head & shoulders' : 'Full body'}
          </button>
        ))}
      </div>
      <input
        aria-label="Scene or pose"
        placeholder="Scene or pose (optional)"
        title="e.g. reading by lamplight at the docks"
        value={scene}
        onChange={(e) => setScene(e.target.value)}
        disabled={generating}
        style={{ fontSize: 13 }}
      />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          type="button"
          className="btn-ghost"
          style={{ fontSize: 11, padding: '6px 12px', minHeight: 36 }}
          disabled={busy || full}
          onClick={() => fileRef.current?.click()}
        >
          {uploadBusy ? 'Uploading…' : gallery.length ? 'Add photo' : 'Upload photo'}
        </button>
        <button
          type="button"
          className="btn-ghost"
          style={{ fontSize: 11, padding: '6px 12px', minHeight: 36 }}
          disabled={(uploadBusy || targetFull) && !generating}
          onClick={() => void generate()}
        >
          {generateLabel}
        </button>
        {gallery.length > 0 && (
          <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, opacity: 0.55 }}>
            {gallery.length}/{MAX_CHARACTER_PORTRAITS}
          </span>
        )}
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.45, color: 'var(--ink-muted)' }}>
        {makesFigure
          ? 'Full-body and scene pictures keep the main photo’s face and the written appearance. They go in their own row and never replace the avatar.'
          : gallery.length > 0
            ? 'The highlighted photo is the avatar. Tap another to make it the main photo.'
            : 'A generated portrait becomes this character’s avatar. You can add more and choose the main photo.'}
      </div>

      {figures.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9.5, letterSpacing: '0.12em', textTransform: 'uppercase', opacity: 0.7 }}>
            Full body &amp; scenes · {figures.length}/{MAX_CHARACTER_PORTRAITS}
          </div>
          <div role="list" aria-label="Full body and scene pictures" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {figures.map((url, i) => (
              <div key={`${i}-${url.slice(0, 24)}`} role="listitem" style={{ position: 'relative' }}>
                <button
                  type="button"
                  aria-label={`Open picture ${i + 1}`}
                  onClick={() => setViewing(url)}
                  style={{
                    width: 52, height: 78, borderRadius: 8, padding: 0, cursor: 'zoom-in',
                    border: '1px solid var(--rule)',
                    backgroundImage: `url(${url})`, backgroundSize: 'cover', backgroundPosition: 'center top'
                  }}
                />
                <button
                  type="button"
                  className="btn-quiet"
                  title="Remove picture"
                  aria-label={`Remove picture ${i + 1}`}
                  disabled={busy}
                  onClick={() => void onChange({ figures: figures.filter((_, j) => j !== i) })}
                  style={{
                    position: 'absolute', top: -6, right: -6, width: 18, height: 18, padding: 0,
                    borderRadius: '50%', fontSize: 10, lineHeight: '18px',
                    background: 'var(--page)', border: '1px solid var(--rule)'
                  }}
                >×</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {viewing && (
        <div
          role="dialog"
          aria-label="Picture"
          onClick={() => setViewing(null)}
          onKeyDown={(e) => { if (e.key === 'Escape') setViewing(null); }}
          tabIndex={-1}
          style={{
            position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(0,0,0,0.82)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, cursor: 'zoom-out'
          }}
        >
          <img src={viewing} alt={`${character.name || 'Character'}, full picture`}
            style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 8, objectFit: 'contain' }} />
        </div>
      )}

      {error && <ErrorNote error={error} onDismiss={() => setError('')} />}
    </>
  );
}
