import { useLiveQuery } from 'dexie-react-hooks';
import { useRef, useState } from 'react';
import { PassphraseDialog } from '../components/PassphraseDialog';
import {
  db, deleteWorld, encryptExport, exportWorld, importAnyFile, isEncryptedExport,
  type EncryptedExport
} from '../db';
import { formatUserError } from '../errors';
import { decryptDeviceExport } from '../sync/serialize';
import { seedStarterWorld } from '../data/seed';
import { useApp } from '../store/app';
import { useVw, ErrorNote } from '../ui/bits';
import { plateStyle, VIS } from '../ui/theme';

function download(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function slug(title: string) {
  return title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'world';
}

export function Library() {
  const vw = useVw();
  const narrow = vw < 780;
  const openWorld = useApp((s) => s.openWorld);
  const go = useApp((s) => s.go);
  const [error, setError] = useState('');
  const [seeding, setSeeding] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const worlds = useLiveQuery(() => db.worlds.orderBy('updatedAt').reverse().toArray(), []);
  const stats = useLiveQuery(async () => {
    const out: Record<string, { seasons: number; episodes: number; cast: number; words: number }> = {};
    for (const w of await db.worlds.toArray()) {
      const [seasons, episodes, cast, turns] = await Promise.all([
        db.seasons.where('worldId').equals(w.id).count(),
        db.episodes.where('worldId').equals(w.id).count(),
        db.characters.where('worldId').equals(w.id).count(),
        db.turns.where('worldId').equals(w.id).toArray()
      ]);
      const words = turns.reduce((n, t) => n + t.text.split(/\s+/).length, 0);
      out[w.id] = { seasons, episodes, cast, words };
    }
    return out;
  }, []);

  const onSeed = async () => {
    setSeeding(true);
    try {
      const id = await seedStarterWorld();
      openWorld(id);
    } catch (e) {
      setError(formatUserError(e));
    } finally {
      setSeeding(false);
    }
  };

  // pending state for the passphrase dialogs
  const [pendingExport, setPendingExport] = useState<{ worldId: string; title: string } | null>(null);
  const [pendingImport, setPendingImport] = useState<EncryptedExport | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState('');

  const finishImport = async (data: unknown) => {
    const ids = await importAnyFile(data);
    if (ids.length === 1) openWorld(ids[0]);
  };

  const onImportFile = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      if (isEncryptedExport(data)) {
        setPendingImport(data); // ask for the passphrase first
        return;
      }
      await finishImport(data);
    } catch (e) {
      setError(`Import failed: ${formatUserError(e)}`);
    }
  };

  const runExport = async (worldId: string, title: string, passphrase: string) => {
    const data = await exportWorld(worldId);
    if (passphrase) {
      download(await encryptExport(data, passphrase), `${slug(title)}.smallworlds.enc.json`);
    } else {
      download(data, `${slug(title)}.smallworlds.json`);
    }
  };

  return (
    <div className="fade-in" style={{
      padding: narrow ? '26px 18px 60px' : '42px 46px 70px',
      paddingTop: narrow ? 'calc(26px + env(safe-area-inset-top))' : 42,
      maxWidth: 920
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 24, flexWrap: 'wrap', marginBottom: 40 }}>
        <div style={{ maxWidth: 480 }}>
          <h1 className="serif" style={{ fontWeight: 300, fontSize: narrow ? 40 : 56, lineHeight: 1.02, margin: 0, color: '#f2f4f5' }}>
            Small Worlds
          </h1>
          <p style={{ margin: '14px 0 0', fontSize: 15, lineHeight: 1.55, color: 'rgba(230,233,235,0.58)', maxWidth: '38ch' }}>
            Make a world. Live in it.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn-ghost" onClick={() => fileRef.current?.click()}>Import</button>
          <input
            ref={fileRef} type="file" accept=".json,application/json" style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void onImportFile(f); e.target.value = ''; }}
          />
          <button className="btn-primary" onClick={() => go('onboard')}>New world</button>
        </div>
      </div>

      {error && <div style={{ marginBottom: 18 }}><ErrorNote error={error} onDismiss={() => setError('')} /></div>}

      {worlds && worlds.length === 0 && (
        <div className="craft-row" style={{ padding: narrow ? 24 : 36, display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 560 }}>
          <div className="serif" style={{ fontWeight: 300, fontSize: 28, color: '#f2f4f5', lineHeight: 1.15 }}>
            An empty workbench.
          </div>
          <div style={{ fontSize: 14, lineHeight: 1.65, color: 'rgba(230,233,235,0.58)', maxWidth: '42ch' }}>
            Create a world of your own, or open the starter — a harbour city, a false name, a debt in the public record —
            to see how cast, continuity and seasons work. Everything in it is editable.
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
            <button className="btn-primary" onClick={() => go('onboard')}>Create my world</button>
            <button className="btn-ghost" disabled={seeding} onClick={() => void onSeed()}>
              {seeding ? 'Setting up…' : 'Open the starter'}
            </button>
          </div>
        </div>
      )}

      {worlds && worlds.length > 0 && (
        <div className="label" style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="seed-mark" />
          Worlds you have made
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {(worlds ?? []).map((w) => {
          const st = stats?.[w.id];
          return (
            <div
              key={w.id}
              className="craft-row hover-bright"
              onClick={() => openWorld(w.id)}
              style={{
                overflow: 'hidden', cursor: 'pointer',
                display: 'grid',
                gridTemplateColumns: narrow ? '1fr' : '148px minmax(0, 1fr)',
                borderLeftColor: `oklch(0.55 0.06 ${w.hue} / 0.75)`
              }}
            >
              <div style={{ ...plateStyle(w.hue, narrow ? 88 : '100%'), minHeight: narrow ? 88 : 112, borderRadius: 0 }}>
                <span className="mono meta" style={{
                  color: 'rgba(230,233,235,0.75)', background: 'rgba(10,12,14,0.5)',
                  padding: '4px 7px', borderRadius: 2
                }}>
                  {st ? `S${st.seasons} · E${st.episodes}` : '—'}
                </span>
                <span className="label" style={{
                  color: 'rgba(230,233,235,0.5)', background: 'rgba(10,12,14,0.5)',
                  border: '1px solid rgba(255,255,255,0.08)', padding: '3px 7px', borderRadius: 2
                }}>
                  {VIS[w.visibility].label}
                </span>
              </div>
              <div style={{ padding: narrow ? '14px 16px 16px' : '16px 20px', display: 'flex', flexDirection: 'column', gap: 8, justifyContent: 'center' }}>
                <div className="serif" style={{ fontSize: 20, color: '#f2f4f5', lineHeight: 1.2 }}>{w.title}</div>
                <div style={{ fontSize: 13, lineHeight: 1.55, color: 'rgba(230,233,235,0.55)' }}>{w.line}</div>
                <div style={{
                  display: 'flex', gap: 14, fontSize: 11,
                  color: 'rgba(230,233,235,0.4)', paddingTop: 6, marginTop: 2,
                  borderTop: '1px solid rgba(255,255,255,0.06)',
                  alignItems: 'center'
                }}>
                  <span>{st ? `${st.cast} cast` : '…'}</span>
                  <span>{st ? `${Math.round(st.words / 100) / 10}k words` : ''}</span>
                  <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                    <button
                      className="btn-quiet" style={{ padding: '2px 4px', fontSize: 10 }}
                      onClick={(e) => { e.stopPropagation(); setPendingExport({ worldId: w.id, title: w.title }); }}
                    >export</button>
                    <button
                      className="btn-quiet" style={{ padding: '2px 4px', fontSize: 10 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`Delete "${w.title}" and everything in it? This cannot be undone.`)) {
                          void deleteWorld(w.id).catch((err) => setError(formatUserError(err)));
                        }
                      }}
                    >delete</button>
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <PassphraseDialog
        open={pendingExport !== null}
        title={`Export "${pendingExport?.title ?? ''}"`}
        description="Add a passphrase to encrypt the file (AES-256), or leave it blank for a plain-text JSON you can read and edit."
        mode="set"
        allowEmpty
        emptyLabel="blank = plain, readable JSON"
        submitLabel="Export"
        busy={dialogBusy}
        onCancel={() => setPendingExport(null)}
        onSubmit={(pass) => {
          if (!pendingExport) return;
          setDialogBusy(true);
          void runExport(pendingExport.worldId, pendingExport.title, pass)
            .catch((e) => setError(formatUserError(e)))
            .finally(() => { setDialogBusy(false); setPendingExport(null); });
        }}
      />
      <PassphraseDialog
        open={pendingImport !== null}
        title="Encrypted file"
        description="This export is encrypted. Enter the passphrase it was exported with."
        mode="enter"
        submitLabel="Decrypt & import"
        busy={dialogBusy}
        error={dialogError}
        onCancel={() => { setPendingImport(null); setDialogError(''); }}
        onSubmit={(pass) => {
          if (!pendingImport) return;
          setDialogBusy(true);
          void decryptDeviceExport(pendingImport, pass)
            .then(async (data) => {
              await finishImport(data);
              setPendingImport(null);
              setDialogError('');
            })
            .catch((e) => setDialogError(formatUserError(e)))
            .finally(() => setDialogBusy(false));
        }}
      />
    </div>
  );
}
