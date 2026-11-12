import { useRef, useState } from 'react';
import { generateLocationPhoto } from '../ai/image';
import { formatUserError } from '../errors';
import type { Location, World } from '../types';
import { ErrorNote } from '../ui/bits';
import { fileToSceneImage } from '../ui/image';

function aborted(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

/**
 * One photo for a place. Upload or generate an establishing shot from the sheet.
 * The saved image is Location.portrait.
 */
export function PlacePhotoTools({
  location,
  world,
  onChange,
  showPreview = true
}: {
  location: Location;
  world: World | null;
  onChange: (next: { portrait: string | null }) => void | Promise<void>;
  /** Hide when the parent already shows a large plate. */
  showPreview?: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const photo = location.portrait ?? null;
  const busy = uploadBusy || generating;

  const onFile = async (file: File) => {
    setUploadBusy(true);
    setError('');
    try {
      await onChange({ portrait: await fileToSceneImage(file) });
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
      setError('Open a world before generating a photo.');
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setGenerating(true);
    setError('');
    try {
      const portrait = await generateLocationPhoto({
        world,
        location,
        signal: controller.signal
      });
      await onChange({ portrait });
    } catch (e) {
      setError(aborted(e) ? 'Photo cancelled.' : formatUserError(e));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setGenerating(false);
    }
  };

  return (
    <>
      {showPreview && photo && (
        <div style={{
          height: 140, borderRadius: 12, border: '1px solid var(--rule)',
          backgroundImage: `url(${photo})`, backgroundSize: 'cover', backgroundPosition: 'center'
        }} />
      )}
      <input
        ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ''; }}
      />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          type="button"
          className="btn-ghost"
          style={{ fontSize: 11, padding: '6px 12px', minHeight: 36 }}
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          {uploadBusy ? 'Uploading…' : photo ? 'Change photo' : 'Upload photo'}
        </button>
        <button
          type="button"
          className="btn-ghost"
          style={{ fontSize: 11, padding: '6px 12px', minHeight: 36 }}
          disabled={uploadBusy && !generating}
          onClick={() => void generate()}
        >
          {generating ? 'Stop' : photo ? 'Generate again' : 'Generate photo'}
        </button>
        {photo && (
          <button
            type="button"
            className="btn-quiet"
            style={{ fontSize: 11, minHeight: 36 }}
            disabled={busy}
            onClick={() => {
              void Promise.resolve(onChange({ portrait: null }))
                .catch((e) => setError(formatUserError(e)));
            }}
          >
            remove photo
          </button>
        )}
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.45, color: 'var(--ink-muted)' }}>
        A generated photo uses this place’s name, tagline, and atmosphere.
      </div>
      {error && <ErrorNote error={error} onDismiss={() => setError('')} />}
    </>
  );
}
