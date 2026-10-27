import { useRef, useState } from 'react';
import { generateCharacterPortrait } from '../ai/image';
import type { PortraitStyle } from '../ai/portrait';
import { formatUserError } from '../errors';
import type { Character, World } from '../types';
import { ErrorNote } from '../ui/bits';
import { fileToPortraitImage } from '../ui/image';
import { ACCENT } from '../ui/theme';
import { characterPortraits, MAX_CHARACTER_PORTRAITS, portraitsPatch } from '../worldOps';

const STYLE_KEY = 'sw-portrait-style';

function storedStyle(): PortraitStyle {
  try {
    return localStorage.getItem(STYLE_KEY) === 'comic' ? 'comic' : 'realistic';
  } catch {
    return 'realistic';
  }
}

function rememberStyle(style: PortraitStyle) {
  try {
    localStorage.setItem(STYLE_KEY, style);
  } catch { /* private mode */ }
}

function aborted(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

/**
 * Photo gallery for one character. The first photo is the avatar.
 * Tap another thumb to make it the main photo. Generated portraits join this same list.
 */
export function CharacterPortraitTools({
  character,
  world,
  onChange
}: {
  character: Character;
  world: World | null;
  onChange: (next: Pick<Character, 'portraits' | 'portrait'>) => void | Promise<void>;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [style, setStyle] = useState<PortraitStyle>(storedStyle);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const gallery = characterPortraits(character);
  const full = gallery.length >= MAX_CHARACTER_PORTRAITS;
  const busy = uploadBusy || generating;

  const chooseStyle = (next: PortraitStyle) => {
    setStyle(next);
    rememberStyle(next);
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
    if (full) {
      setError(`Up to ${MAX_CHARACTER_PORTRAITS} photos per character.`);
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
        signal: controller.signal
      });
      await onChange(portraitsPatch([...gallery, url]));
    } catch (e) {
      setError(aborted(e) ? 'Portrait cancelled.' : formatUserError(e));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setGenerating(false);
    }
  };

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
            style={{
              fontSize: 11, padding: '6px 12px', minHeight: 36,
              borderColor: style === id ? ACCENT : undefined,
              fontWeight: style === id ? 600 : 500
            }}
            onClick={() => chooseStyle(id)}
          >
            {id === 'realistic' ? 'Realistic' : 'Comic'}
          </button>
        ))}
      </div>
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
          disabled={(uploadBusy || full) && !generating}
          onClick={() => void generate()}
        >
          {generating ? 'Stop' : gallery.length ? 'Generate another' : 'Generate portrait'}
        </button>
        {gallery.length > 0 && (
          <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, opacity: 0.55 }}>
            {gallery.length}/{MAX_CHARACTER_PORTRAITS}
          </span>
        )}
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.45, color: 'var(--ink-muted)' }}>
        {gallery.length > 0
          ? 'The highlighted photo is the avatar. Tap another to make it the main photo.'
          : 'A generated portrait becomes this character’s avatar. You can add more and choose the main photo.'}
      </div>
      {error && <ErrorNote error={error} onDismiss={() => setError('')} />}
    </>
  );
}
