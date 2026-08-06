import { useLiveQuery } from 'dexie-react-hooks';
import { useId, useState } from 'react';
import { testConnection } from '../ai/client';
import { listModels, PROVIDER_PRESETS, presetFor, type ProviderPreset } from '../ai/providers';
import { PassphraseDialog } from '../components/PassphraseDialog';
import { db, safeWrite, uid, wipeAllData } from '../db';
import { formatUserError } from '../errors';
import { useVault } from '../security/vault';
import { useApp } from '../store/app';
import { useSettings } from '../store/settings';
import type { ModelRef, ProviderConfig, World, WorldAISettings } from '../types';
import { Bar, Chip, ErrorNote, Field, Mono, Toggle, useVw } from '../ui/bits';

export function Settings() {
  const vw = useVw();
  const narrow = vw < 780;
  const s = useSettings();
  const { currentWorldId, go } = useApp();
  const world = useLiveQuery(
    async () => (currentWorldId ? db.worlds.get(currentWorldId) : undefined),
    [currentWorldId]
  );
  const [addOpen, setAddOpen] = useState(false);

  return (
    <div className="fade-in" style={{
      padding: narrow ? '26px 18px 70px' : '42px 46px 70px',
      paddingTop: narrow ? 'calc(26px + env(safe-area-inset-top))' : 42,
      maxWidth: 960
    }}>
      <div style={{ marginBottom: 30, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <Mono style={{ letterSpacing: '0.16em', marginBottom: 10 }}>preferences</Mono>
          <h1 className="serif" style={{ fontWeight: 300, fontSize: narrow ? 32 : 40, margin: 0, color: '#f8f6f2' }}>Settings</h1>
        </div>
        <button className="btn-ghost" style={{ fontSize: 12, marginTop: 8 }} onClick={() => go('profile')}>
          Profile &amp; backups
        </button>
      </div>

      {/* providers */}
      <Section
        title="Your AI providers"
        note="keys live in this device's storage, sent only to the endpoint you name"
      >
        <div style={{ fontSize: 13, lineHeight: 1.6, color: 'rgba(236,234,230,0.58)', maxWidth: '68ch', marginBottom: 4 }}>
          Small Worlds runs on your own keys. Any OpenAI-compatible endpoint, Anthropic, or Gemini — and any model ID,
          including ones released after this app was built. OpenRouter is the easiest start: one key, hundreds of
          models to compare.
        </div>
        {s.providers.map((p) => (
          <ProviderCard key={p.id} config={p} />
        ))}
        {!addOpen ? (
          <div><Chip onClick={() => setAddOpen(true)}>+ add a provider</Chip></div>
        ) : (
          <AddProvider onDone={() => setAddOpen(false)} />
        )}
      </Section>

      {/* default models */}
      <Section title="Default models" note="per-world overrides live below">
        <div style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr' : '1fr 1fr', gap: 14 }}>
          <div className="glass" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: '#f0eee9' }}>Prose model</div>
            <div style={{ fontSize: 12, lineHeight: 1.55, color: 'rgba(236,234,230,0.5)' }}>
              Writes the story. Spend your best model here.
            </div>
            <ModelPicker value={s.proseModel} onChange={s.setProseModel} />
          </div>
          <div className="glass" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: '#f0eee9' }}>Utility model</div>
            <div style={{ fontSize: 12, lineHeight: 1.55, color: 'rgba(236,234,230,0.5)' }}>
              Background work: continuity extraction, season analysis, character drafts. A cheap, fast model is ideal.
              Falls back to the prose model if unset.
            </div>
            <ModelPicker value={s.utilityModel} onChange={s.setUtilityModel} />
          </div>
        </div>
      </Section>

      {/* world AI settings */}
      {world && <WorldSettings world={world} />}

      {/* content defaults */}
      <Section title="Content defaults">
        <div className="glass" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 240, display: 'flex', flexDirection: 'column', gap: 5 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: 'rgba(236,234,230,0.92)' }}>Mature content on new worlds</div>
              <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'rgba(236,234,230,0.55)' }}>
                Unlocks graphic violence, sex, and darker themes for new worlds. Whether the model complies also
                depends on the provider you point it at. Per-world override in each world's settings.
              </div>
            </div>
            <Toggle on={s.matureDefault} onClick={() => s.setMatureDefault(!s.matureDefault)} />
          </div>
        </div>
      </Section>

      <SecuritySection />
    </div>
  );
}

// ---------- security ----------

function SecuritySection() {
  const vault = useVault();
  const vaultPersistError = useSettings((s) => s.vaultPersistError);
  const clearVaultPersistError = useSettings((s) => s.clearVaultPersistError);
  const [dialog, setDialog] = useState<'none' | 'enable' | 'change-old' | 'change-new'>('none');
  const [oldPass, setOldPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState('');
  const [sectionError, setSectionError] = useState('');

  const close = () => { setDialog('none'); setDialogError(''); setOldPass(''); };

  return (
    <Section title="Security" note="everything stays on this device — this controls how it's protected here">
      {(sectionError || vaultPersistError) && (
        <ErrorNote
          error={sectionError || vaultPersistError}
          onDismiss={() => { setSectionError(''); clearVaultPersistError(); }}
        />
      )}
      {vault.corrupt && (
        <ErrorNote
          error="Vault unreadable — restore a backup from Profile, or reset the vault (stories are kept; keys on this device are lost)."
          onDismiss={() => undefined}
        />
      )}
      <div className="glass" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 240, display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'rgba(236,234,230,0.92)' }}>
              App lock &amp; key encryption
              {vault.enabled && (
                <span style={{
                  fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase',
                  marginLeft: 10, padding: '3px 8px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.16)',
                  color: vault.corrupt ? 'oklch(0.75 0.12 25)' : 'oklch(0.85 0.09 140)'
                }}>{vault.corrupt ? 'corrupt' : 'on'}</span>
              )}
            </div>
            <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'rgba(236,234,230,0.55)' }}>
              Sets a passphrase that locks the app UI and encrypts your API keys at rest (AES-256-GCM; the key is
              derived from your passphrase and never stored). Story text in IndexedDB is not encrypted by this lock —
              only keys are. Anyone with device access can still read worlds via DevTools. If you forget the
              passphrase, keys on this device are wiped — export a device backup from Profile first. Stories stay
              either way.
            </div>
          </div>
          {!vault.enabled ? (
            <button className="btn-primary" onClick={() => setDialog('enable')}>Set a passphrase</button>
          ) : (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {!vault.corrupt && (
                <button className="btn-ghost" onClick={() => {
                  void vault.lock().catch((e) => setSectionError(formatUserError(e)));
                }}>Lock now</button>
              )}
              {!vault.corrupt && (
                <button className="btn-ghost" onClick={() => setDialog('change-old')}>Change passphrase</button>
              )}
              <button className="btn-quiet" onClick={() => {
                const msg = vault.corrupt
                  ? 'Reset the corrupt vault? Encrypted keys on this device will be wiped. Stories stay.'
                  : 'Remove the passphrase? Your API keys will be stored unencrypted on this device again.';
                if (!confirm(msg)) return;
                void (vault.corrupt ? Promise.resolve(vault.reset()) : vault.disable())
                  .catch((e) => setSectionError(formatUserError(e)));
              }}>{vault.corrupt ? 'Reset vault' : 'Remove'}</button>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 16 }}>
          <div style={{ flex: 1, minWidth: 240, display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'oklch(0.75 0.12 25)' }}>Erase everything</div>
            <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'rgba(236,234,230,0.55)' }}>
              Deletes all worlds, characters, settings and keys from this device. Export a backup first — this cannot
              be undone.
            </div>
          </div>
          <button className="btn-quiet" style={{ color: 'oklch(0.75 0.12 25)', borderColor: 'oklch(0.4 0.1 25)' }} onClick={() => {
            if (!confirm('Delete ALL data on this device? This cannot be undone.')) return;
            if (!confirm('Last chance — every world, season and key will be erased. Continue?')) return;
            void wipeAllData().catch((e) => setSectionError(formatUserError(e)));
          }}>Erase all data</button>
        </div>
      </div>

      <PassphraseDialog
        open={dialog === 'enable'}
        title="Set a passphrase"
        description="Locks the app UI and encrypts your API keys on this device. Story text in IndexedDB is not encrypted. Pick a passphrase you won't lose — it can't be recovered without wiping the keys."
        mode="set"
        submitLabel="Encrypt & lock in"
        busy={busy}
        error={dialogError}
        onCancel={close}
        onSubmit={(pass) => {
          setBusy(true);
          setDialogError('');
          void vault.enable(pass)
            .then(close)
            .catch((e) => setDialogError(formatUserError(e)))
            .finally(() => setBusy(false));
        }}
      />
      <PassphraseDialog
        open={dialog === 'change-old'}
        title="Change passphrase"
        description="First, confirm your current passphrase."
        mode="enter"
        submitLabel="Continue"
        busy={busy}
        error={dialogError}
        onCancel={close}
        onSubmit={(pass) => {
          setOldPass(pass);
          setDialogError('');
          setDialog('change-new');
        }}
      />
      <PassphraseDialog
        open={dialog === 'change-new'}
        title="New passphrase"
        description="Your keys will be re-encrypted with the new passphrase."
        mode="set"
        submitLabel="Change passphrase"
        busy={busy}
        error={dialogError}
        onCancel={close}
        onSubmit={(pass) => {
          setBusy(true);
          setDialogError('');
          void vault.changePassphrase(oldPass, pass).then((ok) => {
            if (ok) close();
            else { setDialogError('Current passphrase was wrong.'); setDialog('change-old'); }
          }).catch((e) => setDialogError(formatUserError(e)))
            .finally(() => setBusy(false));
        }}
      />
    </Section>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 13, marginBottom: 34 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: '#f6f4f0' }}>{title}</div>
        {note && <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: 'rgba(236,234,230,0.4)' }}>{note}</div>}
      </div>
      {children}
    </div>
  );
}

// ---------- provider management ----------

function AddProvider({ onDone }: { onDone: () => void }) {
  const s = useSettings();
  const [preset, setPreset] = useState<ProviderPreset>(PROVIDER_PRESETS[0]);
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(PROVIDER_PRESETS[0].baseUrl);

  const pick = (p: ProviderPreset) => { setPreset(p); setBaseUrl(p.baseUrl); };
  const add = () => {
    s.addProvider({ id: uid(), kind: preset.kind, label: preset.label, baseUrl, apiKey: key.trim() });
    onDone();
  };

  return (
    <div className="glass-hot" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#f6f4f0' }}>Add a provider</div>
        <button className="btn-quiet" onClick={onDone}>cancel</button>
      </div>
      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
        {PROVIDER_PRESETS.map((p) => (
          <Chip key={p.id} active={preset.id === p.id} onClick={() => pick(p)}>{p.label}</Chip>
        ))}
      </div>
      <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'rgba(236,234,230,0.6)' }}>
        {preset.note}
        {preset.keyUrl && (
          <> Get a key at <a href={preset.keyUrl} target="_blank" rel="noreferrer">{preset.keyUrl.replace('https://', '')}</a>.</>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 12 }}>
        <Field label="Base URL">
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12 }} />
        </Field>
        <Field label="API key" note={preset.id === 'ollama' || preset.id === 'custom' ? 'optional for local servers' : 'required'}>
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-…" style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12 }} />
        </Field>
      </div>
      <div>
        <button className="btn-primary" onClick={add} disabled={!baseUrl.trim()}>Save provider</button>
      </div>
    </div>
  );
}

function ProviderCard({ config }: { config: ProviderConfig }) {
  const s = useSettings();
  const preset = presetFor(config);
  const [testState, setTestState] = useState<'idle' | 'busy' | 'ok' | 'fail'>('idle');
  const [testMsg, setTestMsg] = useState('');
  const [testModel, setTestModel] = useState(preset?.suggestedModels[0] ?? '');
  const [editKey, setEditKey] = useState(false);

  const runTest = async () => {
    if (!testModel.trim()) { setTestMsg('Enter a model ID to test with.'); setTestState('fail'); return; }
    setTestState('busy');
    setTestMsg('');
    try {
      const r = await testConnection(config, testModel.trim());
      setTestState('ok');
      setTestMsg(`last check: ${r.ms}ms · streaming OK`);
    } catch (e) {
      setTestState('fail');
      setTestMsg(formatUserError(e));
    }
  };

  return (
    <div className="glass" style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 14.5, fontWeight: 600, color: '#f0eee9' }}>{config.label}</div>
        <div style={{
          fontFamily: "'IBM Plex Mono', monospace", fontSize: 9.5, letterSpacing: '0.1em', textTransform: 'uppercase',
          borderRadius: 6, padding: '3px 8px', border: '1px solid rgba(255,255,255,0.16)',
          color: testState === 'ok' ? 'oklch(0.85 0.09 140)' : testState === 'fail' ? 'oklch(0.75 0.12 25)' : 'oklch(0.85 0.1 62)'
        }}>
          {testState === 'ok' ? 'connected' : testState === 'fail' ? 'failed' : testState === 'busy' ? 'testing…' : 'not verified'}
        </div>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: 'rgba(236,234,230,0.4)', marginLeft: 'auto', wordBreak: 'break-all' }}>
          {config.baseUrl}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <Field label="API key">
          {editKey ? (
            <input
              type="password" defaultValue={config.apiKey} autoFocus
              onBlur={(e) => { s.updateProvider(config.id, { apiKey: e.target.value.trim() }); setEditKey(false); }}
              style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12 }}
            />
          ) : (
            <div
              onClick={() => setEditKey(true)}
              style={{
                border: '1px solid rgba(255,255,255,0.11)', borderRadius: 11, padding: '11px 13px',
                background: 'rgba(8,9,12,0.5)', fontFamily: "'IBM Plex Mono', monospace", fontSize: 12,
                color: 'rgba(236,234,230,0.85)', cursor: 'pointer'
              }}
            >
              {config.apiKey ? `${config.apiKey.slice(0, 5)}•••• ${config.apiKey.slice(-4)}` : 'no key — click to add'}
            </div>
          )}
        </Field>
        <Field label="Test with model">
          <input
            value={testModel} onChange={(e) => setTestModel(e.target.value)}
            placeholder="model id" style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12 }}
          />
        </Field>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn-ghost" disabled={testState === 'busy'} onClick={() => void runTest()}>
          {testState === 'busy' ? 'Testing…' : 'Test connection'}
        </button>
        <button className="btn-quiet" onClick={() => {
          if (confirm(`Remove ${config.label}? Worlds pointing at it will need a new model.`)) s.removeProvider(config.id);
        }}>Remove</button>
        {testState !== 'fail' && (
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: 'rgba(236,234,230,0.4)', marginLeft: 'auto', maxWidth: '100%', wordBreak: 'break-word' }}>
            {testMsg || 'run a test before writing a chapter'}
          </div>
        )}
      </div>
      {testState === 'fail' && testMsg && (
        <ErrorNote error={testMsg} onDismiss={() => { setTestState('idle'); setTestMsg(''); }} />
      )}
    </div>
  );
}

// ---------- model picker ----------

export function ModelPicker({ value, onChange }: { value: ModelRef | null; onChange: (m: ModelRef | null) => void }) {
  const providers = useSettings((st) => st.providers);
  const [catalog, setCatalog] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const listId = useId();

  const provider = providers.find((p) => p.id === value?.providerId) ?? providers[0];
  const preset = provider ? presetFor(provider) : undefined;
  const suggestions = [...new Set([...(preset?.suggestedModels ?? []), ...catalog])];

  if (providers.length === 0) {
    return <div style={{ fontSize: 12.5, color: 'rgba(236,234,230,0.5)' }}>Add a provider above first.</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <select
        value={provider?.id ?? ''}
        onChange={(e) => {
          const p = providers.find((x) => x.id === e.target.value);
          if (p) {
            const ps = presetFor(p);
            onChange({ providerId: p.id, model: value?.providerId === p.id ? value.model : (ps?.suggestedModels[0] ?? '') });
            setCatalog([]);
          }
        }}
      >
        {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          list={listId}
          value={value?.providerId === provider?.id ? value?.model ?? '' : ''}
          placeholder="model id — type anything"
          onChange={(e) => provider && onChange({ providerId: provider.id, model: e.target.value })}
          style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, flex: 1 }}
        />
        <button
          className="btn-ghost" style={{ fontSize: 11, padding: '7px 10px', whiteSpace: 'nowrap' }}
          disabled={loading || !provider}
          onClick={async () => {
            if (!provider) return;
            setLoading(true);
            const models = await listModels(provider);
            setCatalog(models);
            setLoading(false);
          }}
        >
          {loading ? '…' : catalog.length > 0 ? `${catalog.length} live` : 'fetch list'}
        </button>
      </div>
      <datalist id={listId}>
        {suggestions.map((m) => <option key={m} value={m} />)}
      </datalist>
    </div>
  );
}

// ---------- world-level AI settings ----------

function WorldSettings({ world }: { world: World }) {
  const [saveError, setSaveError] = useState('');
  const patchWorld = (p: Partial<World>) =>
    void safeWrite(() => db.worlds.update(world.id, { ...p, updatedAt: Date.now() }), setSaveError);
  const patchAI = (p: Partial<WorldAISettings>) =>
    patchWorld({ ai: { ...world.ai, ...p } });

  return (
    <Section title={`This world — ${world.title}`} note="instructions the narrator follows in this world only">
      {saveError && <ErrorNote error={saveError} onDismiss={() => setSaveError('')} />}
      <div className="glass" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 }}>
          <Field label="Point of view">
            <div style={{ display: 'flex', gap: 6 }}>
              {(['second', 'first', 'third'] as const).map((pov) => (
                <Chip key={pov} active={world.ai.pov === pov} onClick={() => patchAI({ pov })}>{pov}</Chip>
              ))}
            </div>
          </Field>
          <Field label="Tense">
            <div style={{ display: 'flex', gap: 6 }}>
              {(['present', 'past'] as const).map((tense) => (
                <Chip key={tense} active={world.ai.tense === tense} onClick={() => patchAI({ tense })}>{tense}</Chip>
              ))}
            </div>
          </Field>
          <Field label="Mature content">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Toggle on={world.ai.mature} onClick={() => patchAI({ mature: !world.ai.mature })} />
              <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: 'rgba(236,234,230,0.5)' }}>
                {world.ai.mature ? 'adult world · unrestricted' : 'general audience'}
              </span>
            </div>
          </Field>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 13 }}>
          <SliderCard
            label="Purple-ness"
            value={world.ai.proseDensity}
            onChange={(v) => patchAI({ proseDensity: v })}
            note={world.ai.proseDensity < 34 ? 'Concrete over ornamental. Few adverbs.' : world.ai.proseDensity < 67 ? 'Balanced. Texture where it earns its place.' : 'Rich and atmospheric. Imagery leans in.'}
            valueLabel={world.ai.proseDensity < 34 ? 'restrained' : world.ai.proseDensity < 67 ? 'balanced' : 'ornamental'}
          />
          <SliderCard
            label="Pacing"
            value={world.ai.pacing}
            onChange={(v) => patchAI({ pacing: v })}
            note={world.ai.pacing < 34 ? 'Linger. Tension accumulates slowly.' : world.ai.pacing < 67 ? 'Scenes develop naturally.' : 'Propulsive. Cut the connective tissue.'}
            valueLabel={world.ai.pacing < 34 ? 'slow-burn' : world.ai.pacing < 67 ? 'measured' : 'propulsive'}
          />
        </div>

        <Field label="Narrator hard rules" note="one per line — the narrator never breaks these">
          <textarea
            rows={3}
            defaultValue={world.ai.narratorRules.join('\n')}
            key={world.id + '-rules'}
            onBlur={(e) => patchAI({ narratorRules: e.target.value.split('\n').filter((l) => l.trim()) })}
            placeholder={'Never skip time without asking.\nNever kill a named character without the player in the scene.'}
          />
        </Field>
        <Field label="Content boundaries" note="free text, e.g. lines that are never crossed">
          <textarea
            rows={2}
            defaultValue={world.ai.contentNotes}
            key={world.id + '-content'}
            onBlur={(e) => patchAI({ contentNotes: e.target.value })}
          />
        </Field>
        <Field label="World instructions" note="passed to the model verbatim, every request in this world">
          <textarea
            rows={4}
            defaultValue={world.ai.customInstructions}
            key={world.id + '-custom'}
            onBlur={(e) => patchAI({ customInstructions: e.target.value })}
            placeholder="Anything else the narrator should hold: themes to circle, imagery to reuse, what the story is really about…"
          />
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 16 }}>
          <Field label="Prose model override" note="unset = global default">
            <ModelPicker
              value={world.proseModel}
              onChange={(m) => patchWorld({ proseModel: m })}
            />
            {world.proseModel && (
              <button className="btn-quiet" style={{ alignSelf: 'flex-start', fontSize: 11 }}
                onClick={() => patchWorld({ proseModel: null })}>use global default</button>
            )}
          </Field>
          <Field label="Utility model override" note="unset = global default">
            <ModelPicker
              value={world.utilityModel}
              onChange={(m) => patchWorld({ utilityModel: m })}
            />
            {world.utilityModel && (
              <button className="btn-quiet" style={{ alignSelf: 'flex-start', fontSize: 11 }}
                onClick={() => patchWorld({ utilityModel: null })}>use global default</button>
            )}
          </Field>
        </div>
      </div>

      <WorldBibleEditor world={world} onError={setSaveError} />
    </Section>
  );
}

function SliderCard({ label, value, onChange, note, valueLabel }: {
  label: string; value: number; onChange: (v: number) => void; note: string; valueLabel: string;
}) {
  return (
    <div className="glass" style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'rgba(236,234,230,0.92)' }}>{label}</div>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10.5, color: 'oklch(0.85 0.1 62)' }}>{valueLabel}</div>
      </div>
      <Bar pct={value} />
      <input
        type="range" min={0} max={100} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ padding: 0, height: 4 }}
      />
      <div style={{ fontSize: 12, lineHeight: 1.5, color: 'rgba(236,234,230,0.5)' }}>{note}</div>
    </div>
  );
}

function WorldBibleEditor({ world, onError }: { world: World; onError: (msg: string) => void }) {
  return (
    <div className="glass" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Field label="World bible" note="the setting, rules and pressures — packed into every prompt">
        <textarea
          rows={6}
          className="serif"
          key={world.id + '-bible'}
          defaultValue={world.bible}
          onBlur={(e) => void safeWrite(
            () => db.worlds.update(world.id, { bible: e.target.value, updatedAt: Date.now() }),
            onError
          )}
          style={{ fontFamily: 'Spectral, serif', fontSize: 15, lineHeight: 1.7 }}
        />
      </Field>
      <Field label="Logline" note="the one-line pitch on the world card">
        <input
          key={world.id + '-line'}
          defaultValue={world.line}
          onBlur={(e) => void safeWrite(
            () => db.worlds.update(world.id, { line: e.target.value, updatedAt: Date.now() }),
            onError
          )}
        />
      </Field>
    </div>
  );
}
