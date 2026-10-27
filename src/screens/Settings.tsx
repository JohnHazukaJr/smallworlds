import { useLiveQuery } from 'dexie-react-hooks';
import { useId, useRef, useState } from 'react';
import { testConnection } from '../ai/client';
import {
  BYOK_PRESETS, hostedBaseUrl, isHostedProvider, listModels, presetFor, type ProviderPreset
} from '../ai/providers';
import { COST_BEAT, COST_IMAGE, COST_UTILITY, HOSTED_IMAGE_MODEL, HOSTED_PROSE_MODEL, HOSTED_UTILITY_MODEL } from '../billing/plans';
import { PassphraseDialog } from '../components/PassphraseDialog';
import { deleteCloudAccount } from '../cloud/account';
import { useAuth } from '../cloud/authStore';
import { isCloudConfigured } from '../cloud/supabase';
import { db, safeWrite, uid, wipeAllData } from '../db';
import { formatUserError } from '../errors';
import { useVault } from '../security/vault';
import { useApp } from '../store/app';
import { useSettings } from '../store/settings';
import { LegalLinks } from './Legal';
import type { ModelRef, ProviderConfig, StoryStance, World, WorldAISettings } from '../types';
import { Bar, Chip, ErrorNote, Field, Mono, Toggle, phoneChrome, useViewport } from '../ui/bits';
import { applyStanceToAi, STORY_STANCES, storyStanceOf } from '../worldOps';

export function Settings() {
  const { band } = useViewport();
  const phone = phoneChrome(band);
  const compact = band === 'compact';
  const narrow = phone;
  const s = useSettings();
  const { currentWorldId, go } = useApp();
  const world = useLiveQuery(
    async () => {
      if (!currentWorldId) return null;
      return (await db.worlds.get(currentWorldId)) ?? null;
    },
    [currentWorldId]
  );
  const [addOpen, setAddOpen] = useState(() => !s.providers.some((p) => !isHostedProvider(p)));

  return (
    <div className="fade-in" style={{
      paddingTop: narrow ? 'calc(26px + env(safe-area-inset-top))' : 42,
      paddingRight: narrow ? 18 : 46,
      paddingBottom: narrow ? 24 : 70,
      paddingLeft: narrow ? 18 : 46,
      maxWidth: 960
    }}>
      <div style={{ marginBottom: 30, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <Mono style={{ letterSpacing: '0.16em', marginBottom: 10 }}>preferences</Mono>
          <h1 className="serif" style={{ fontWeight: 300, fontSize: compact ? 28 : phone ? 32 : 40, margin: 0, color: 'var(--ink-heading)' }}>Settings</h1>
        </div>
        <button className="btn-ghost" style={{ fontSize: 12, marginTop: 8 }} onClick={() => go('profile')}>
          Profile &amp; backups
        </button>
      </div>

      {/* providers — your own key first; hosted is optional and lives below */}
      <Section
        title="Your AI providers"
        note="keys live in this device's storage, sent only to the endpoint you name"
      >
        <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--ink-muted)', maxWidth: '68ch', marginBottom: 4 }}>
          Start here with your own key — no Small Worlds account, subscription, or credits needed. Any OpenAI-compatible
          endpoint, Anthropic, or Gemini — and any model ID, including ones released after this app was built. OpenRouter
          is the easiest start: one key, hundreds of models to compare.
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

      <HostedSection />

      {/* default models */}
      <Section title="Default models" note="per-world overrides live below">
        <div style={{ display: 'grid', gridTemplateColumns: band === 'wide' ? '1fr 1fr 1fr' : '1fr', gap: 14 }}>
          <div className="craft-row" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink-heading)' }}>Prose model</div>
            <div style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--ink-muted)' }}>
              Writes the story. Recommended: glm-5.2 (or glm-5.3-flash if you want speed).
            </div>
            <ModelPicker value={s.proseModel} onChange={s.setProseModel} />
          </div>
          <div className="craft-row" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink-heading)' }}>Utility model</div>
            <div style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--ink-muted)' }}>
              Chapter memory, drafts, live canon. Recommended: glm-5.2. Falls back to prose if unset.
            </div>
            <ModelPicker value={s.utilityModel} onChange={s.setUtilityModel} />
          </div>
          <div className="craft-row" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink-heading)' }}>Image model</div>
            <div style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--ink-muted)' }}>
              Character portraits. Recommended: glm-image. A prose model is not used for pictures.
            </div>
            <ModelPicker value={s.imageModel ?? null} onChange={s.setImageModel} />
          </div>
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--ink-muted)', marginTop: 10 }}>
          Z.ai in the browser may fail CORS — use OpenRouter’s <span className="mono">z-ai/glm-5.2</span> or sign in
          so the cloud relay can reach Z.ai. Custom still covers BigModel China
          (<span className="mono">open.bigmodel.cn/api/paas/v4</span>).
        </div>
      </Section>

      {/* world AI settings */}
      {world && <WorldSettings world={world} />}

      {/* content defaults */}
      <Section title="Content defaults">
        <div className="craft-row" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink-heading)' }}>Mature content on new worlds</div>
              <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--ink-muted)' }}>
                Unlocks graphic violence, sex, and darker themes for new worlds. Whether the model complies also
                depends on the provider you point it at. Per-world override in each world's settings.
              </div>
            </div>
            <Toggle on={s.matureDefault} onClick={() => s.setMatureDefault(!s.matureDefault)} />
          </div>
        </div>
      </Section>

      <SecuritySection />
      <div style={{ marginTop: 28 }}><LegalLinks /></div>
    </div>
  );
}

function HostedSection() {
  const s = useSettings();
  const user = useAuth((a) => a.user);
  const go = useApp((a) => a.go);
  if (!isCloudConfigured()) return null;
  const hosted = s.providers.find(isHostedProvider);
  const proseProvider = s.proseModel
    ? s.providers.find((p) => p.id === s.proseModel?.providerId)
    : undefined;
  const byokWriting = !!proseProvider && !isHostedProvider(proseProvider);
  const hostedWritingWithByok = !!proseProvider && isHostedProvider(proseProvider)
    && s.providers.some((p) => !isHostedProvider(p));

  const enable = () => {
    if (hosted) return;
    const base = hostedBaseUrl();
    if (!base) return;
    const id = uid();
    s.addProvider({ id, kind: 'openai', label: 'Small Worlds', baseUrl: base, apiKey: '' });
    const after = useSettings.getState();
    if (after.utilityModel?.providerId === id && after.utilityModel.model === HOSTED_PROSE_MODEL) {
      s.setUtilityModel({ providerId: id, model: HOSTED_UTILITY_MODEL });
    }
    if (!after.imageModel) s.setImageModel({ providerId: id, model: HOSTED_IMAGE_MODEL });
  };

  return (
    <Section title="Small Worlds hosted" note="billed in credits — your own keys stay free">
      <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--ink-muted)', maxWidth: '68ch' }}>
        Prose costs {COST_BEAT} credits, short utility calls cost {COST_UTILITY}, images cost {COST_IMAGE}.
        Sign in to spend credits. The model key stays on the server.
      </div>
      {byokWriting ? (
        <div style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--paper)' }}>
          Your own key is in use — {proseProvider?.label} writes the story. Hosted is off for writing, so no
          Small Worlds credits or subscription are needed.
        </div>
      ) : hostedWritingWithByok ? (
        <div style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--paper)' }}>
          Your writing model still points at Small Worlds hosted, which uses credits. To use your own key instead,
          pick your provider under Default models below.
        </div>
      ) : !user ? (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ fontSize: 13, color: 'var(--paper)' }}>Sign in on Profile to use hosted models.</div>
          <button className="btn-ghost" onClick={() => go('profile')}>Open Profile</button>
        </div>
      ) : hosted ? (
        <div style={{ fontSize: 13, color: 'var(--paper)' }}>
          Hosted provider is on. Pick <span className="mono">{HOSTED_PROSE_MODEL}</span>,{' '}
          <span className="mono">{HOSTED_UTILITY_MODEL}</span>, or <span className="mono">{HOSTED_IMAGE_MODEL}</span> in
          the model lists below. Balance and checkout live on Profile.
        </div>
      ) : (
        <div><button className="btn-primary" onClick={enable}>Use Small Worlds hosted</button></div>
      )}
    </Section>
  );
}

// ---------- security ----------

function SecuritySection() {
  const vault = useVault();
  const signedIn = !!useAuth((a) => a.user);
  const vaultPersistError = useSettings((s) => s.vaultPersistError);
  const clearVaultPersistError = useSettings((s) => s.clearVaultPersistError);
  const [dialog, setDialog] = useState<'none' | 'enable' | 'change-old' | 'change-new'>('none');
  const [oldPass, setOldPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState('');
  const [sectionError, setSectionError] = useState('');
  const [vaultCorruptDismissed, setVaultCorruptDismissed] = useState(false);

  const close = () => { setDialog('none'); setDialogError(''); setOldPass(''); };

  return (
    <Section title="Security" note="everything stays on this device — this controls how it's protected here">
      {(sectionError || vaultPersistError) && (
        <ErrorNote
          error={sectionError || vaultPersistError}
          onDismiss={() => { setSectionError(''); clearVaultPersistError(); }}
        />
      )}
      {vault.corrupt && !vaultCorruptDismissed && (
        <ErrorNote
          error="Vault unreadable — restore a backup from Profile, or reset the vault. Resetting deletes the story key, so sealed worlds on this device stay unreadable until that backup is restored."
          onDismiss={() => setVaultCorruptDismissed(true)}
        />
      )}
      <div className="craft-row" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink-heading)' }}>
              App lock &amp; key encryption
              {vault.enabled && (
                <span style={{
                  fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase',
                  marginLeft: 10, padding: '3px 8px', borderRadius: 6, border: '1px solid var(--rule)',
                  color: vault.corrupt ? 'oklch(0.4 0.12 25)' : 'oklch(0.38 0.08 145)'
                }}>{vault.corrupt ? 'corrupt' : 'on'}</span>
              )}
            </div>
            <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--ink-muted)' }}>
              Sets a passphrase that locks the app and encrypts stories and API keys on this device (AES-256-GCM).
              The passphrase is never stored and cannot be recovered. If you forget it, sealed worlds on this device
              stay unreadable until you restore a backup — export one from Profile first. With the lock off, story
              text is stored in plaintext again.
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
                  ? 'Reset the corrupt vault? Encrypted keys will be wiped. Sealed worlds on this device become unreadable until you restore a backup.'
                  : 'Remove the passphrase? Worlds and API keys will be stored unencrypted on this device again.';
                if (!confirm(msg)) return;
                void (vault.corrupt ? Promise.resolve(vault.reset()) : vault.disable())
                  .catch((e) => setSectionError(formatUserError(e)));
              }}>{vault.corrupt ? 'Reset vault' : 'Remove'}</button>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap', borderTop: '1px solid var(--rule)', paddingTop: 16 }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'oklch(0.4 0.12 25)' }}>Erase everything</div>
            <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--ink-muted)' }}>
              Deletes all worlds, characters, settings and keys from this device. A cloud account, if you have one,
              is left in place. Export a backup first — this cannot be undone.
            </div>
          </div>
          <button className="btn-quiet" style={{ color: 'oklch(0.4 0.12 25)', borderColor: 'oklch(0.4 0.1 25)' }} onClick={() => {
            if (!confirm('Delete ALL data on this device? This cannot be undone. Cloud copies are kept.')) return;
            if (!confirm('Last chance — every world and key on this device will be erased. Continue?')) return;
            void wipeAllData().catch((e) => setSectionError(formatUserError(e)));
          }}>Erase this device</button>
        </div>
        {signedIn && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap', borderTop: '1px solid var(--rule)', paddingTop: 16 }}>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: 'oklch(0.4 0.12 25)' }}>Delete cloud account</div>
              <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--ink-muted)' }}>
                Deletes the signed-in account, synced stories, encrypted secrets, and credits, then erases this device.
              </div>
            </div>
            <button className="btn-quiet" style={{ color: 'oklch(0.4 0.12 25)', borderColor: 'oklch(0.4 0.1 25)' }} onClick={() => {
              if (!confirm('Delete the cloud account and erase this device? This cannot be undone.')) return;
              if (!confirm('Last chance — export a backup first if you need the stories. Continue?')) return;
              void deleteCloudAccount().catch((e) => setSectionError(formatUserError(e)));
            }}>Delete account</button>
          </div>
        )}
      </div>

      <PassphraseDialog
        open={dialog === 'enable'}
        title="Set a passphrase"
        description="Locks the app and encrypts stories and API keys on this device (AES-256-GCM). Use at least 12 characters. The passphrase cannot be recovered."
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
          setBusy(true);
          setDialogError('');
          void vault.unlock(pass).then((ok) => {
            if (!ok) {
              setDialogError('Current passphrase was wrong.');
              return;
            }
            setOldPass(pass);
            setDialog('change-new');
          }).catch((e) => setDialogError(formatUserError(e)))
            .finally(() => setBusy(false));
        }}
      />
      <PassphraseDialog
        open={dialog === 'change-new'}
        title="New passphrase"
        description="Keys and the story key are re-wrapped with the new passphrase. Worlds stay sealed and are not rewritten. Use at least 12 characters."
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
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink-heading)' }}>{title}</div>
        {note && <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: 'var(--ink-muted)' }}>{note}</div>}
      </div>
      {children}
    </div>
  );
}

// ---------- provider management ----------

function AddProvider({ onDone }: { onDone: () => void }) {
  const s = useSettings();
  const [preset, setPreset] = useState<ProviderPreset>(BYOK_PRESETS[0]);
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(BYOK_PRESETS[0].baseUrl);

  const pick = (p: ProviderPreset) => { setPreset(p); setBaseUrl(p.baseUrl); };
  const add = () => {
    s.addProvider({ id: uid(), kind: preset.kind, label: preset.label, baseUrl, apiKey: key.trim() });
    onDone();
  };

  return (
    <div className="craft-row" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-heading)' }}>Add a provider</div>
        <button className="btn-quiet" onClick={onDone}>cancel</button>
      </div>
      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
        {BYOK_PRESETS.map((p) => (
          <Chip key={p.id} active={preset.id === p.id} onClick={() => pick(p)}>{p.label}</Chip>
        ))}
      </div>
      <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--ink-muted)' }}>
        {preset.note}
        {preset.keyUrl && (
          <> Get a key at <a href={preset.keyUrl} target="_blank" rel="noreferrer">{preset.keyUrl.replace('https://', '')}</a>.</>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 230px), 1fr))', gap: 12 }}>
        <Field label="Base URL">
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12 }} />
        </Field>
        <Field label="API key" note={preset.id === 'ollama' || preset.id === 'custom' ? 'optional for local servers' : 'required'}>
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-…" style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12 }} />
        </Field>
      </div>
      <div>
        <button
          className="btn-primary"
          onClick={add}
          disabled={!baseUrl.trim() || (preset.id !== 'ollama' && preset.id !== 'custom' && !key.trim())}
        >Save provider</button>
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
    <div className="craft-row" style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--ink-heading)' }}>{config.label}</div>
        <div style={{
          fontFamily: "'IBM Plex Mono', monospace", fontSize: 9.5, letterSpacing: '0.1em', textTransform: 'uppercase',
          borderRadius: 6, padding: '3px 8px', border: '1px solid var(--rule)',
          color: testState === 'ok' ? 'oklch(0.4 0.08 145)' : testState === 'fail' ? 'oklch(0.4 0.12 25)' : 'oklch(0.32 0.12 25)'
        }}>
          {testState === 'ok' ? 'connected' : testState === 'fail' ? 'failed' : testState === 'busy' ? 'testing…' : 'not verified'}
        </div>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: 'var(--ink-muted)', marginLeft: 'auto', wordBreak: 'break-all' }}>
          {config.baseUrl}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 12 }}>
        <Field label={isHostedProvider(config) ? 'Billing' : 'API key'}>
          {isHostedProvider(config) ? (
            <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--paper)', padding: '8px 0' }}>
              No API key. Calls are billed to your Small Worlds credits.
            </div>
          ) : editKey ? (
            <input
              type="password" defaultValue={config.apiKey} autoFocus
              onBlur={(e) => { s.updateProvider(config.id, { apiKey: e.target.value.trim() }); setEditKey(false); }}
              style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12 }}
            />
          ) : (
            <div
              onClick={() => setEditKey(true)}
              style={{
                border: '1px solid var(--rule)', borderRadius: 11, padding: '11px 13px',
                background: 'transparent', fontFamily: "'IBM Plex Mono', monospace", fontSize: 12,
                color: 'var(--paper)', cursor: 'pointer'
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
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: 'var(--ink-muted)', marginLeft: 'auto', maxWidth: '100%', wordBreak: 'break-word' }}>
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
  const [listError, setListError] = useState('');
  const listId = useId();

  const provider = providers.find((p) => p.id === value?.providerId) ?? providers[0];
  const preset = provider ? presetFor(provider) : undefined;
  const suggestions = [...new Set([...(preset?.suggestedModels ?? []), ...catalog])];

  if (providers.length === 0) {
    return <div style={{ fontSize: 12.5, color: 'var(--ink-muted)' }}>Add a provider above first.</div>;
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
            setListError('');
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
            setListError('');
            try {
              const { models, error } = await listModels(provider);
              setCatalog(models);
              if (error) setListError(error);
              else if (models.length === 0) setListError('Provider returned no models.');
            } finally {
              setLoading(false);
            }
          }}
        >
          {loading ? '…' : catalog.length > 0 ? `${catalog.length} live` : 'fetch list'}
        </button>
      </div>
      {listError && (
        <div style={{ fontSize: 11.5, lineHeight: 1.4, color: 'oklch(0.78 0.1 35)' }}>{listError}</div>
      )}
      <datalist id={listId}>
        {suggestions.map((m) => <option key={m} value={m} />)}
      </datalist>
    </div>
  );
}

// ---------- world-level AI settings ----------

function WorldSettings({ world }: { world: World }) {
  const [saveError, setSaveError] = useState('');
  const aiWrites = useRef(Promise.resolve());
  const enqueueAI = (task: () => Promise<unknown>) => {
    aiWrites.current = aiWrites.current.then(task, task).then(() => undefined);
  };
  const patchWorld = (p: Partial<World>) =>
    void safeWrite(() => db.worlds.update(world.id, { ...p, updatedAt: Date.now() }), setSaveError);
  const patchAI = (p: Partial<WorldAISettings>) => {
    enqueueAI(() => safeWrite(async () => {
      const row = await db.worlds.get(world.id);
      if (!row) return;
      await db.worlds.update(world.id, { ai: { ...row.ai, ...p }, updatedAt: Date.now() });
    }, setSaveError));
  };
  const patchStance = (stance: StoryStance) => {
    enqueueAI(() => safeWrite(async () => {
      const row = await db.worlds.get(world.id);
      if (!row) return;
      await db.worlds.update(world.id, {
        storyStance: stance,
        ai: applyStanceToAi(row.ai, stance),
        updatedAt: Date.now()
      });
    }, setSaveError));
  };

  return (
    <Section title={`This world — ${world.title}`} note="instructions the narrator follows in this world only">
      {saveError && <ErrorNote error={saveError} onDismiss={() => setSaveError('')} />}
      <div className="craft-row" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))', gap: 14 }}>
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
              <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: 'var(--ink-muted)' }}>
                {world.ai.mature ? 'adult world · unrestricted' : 'general audience'}
              </span>
            </div>
          </Field>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: 13 }}>
          <SliderCard
            label="Prose detail"
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
            placeholder={'Never skip time without asking.\nNever kill a named character without the player in the chapter.'}
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
        <Field label="Story shape" note="how this world wants to play">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {STORY_STANCES.map((row) => (
              <Chip
                key={row.id}
                active={storyStanceOf(world) === row.id}
                onClick={() => patchStance(row.id)}
              >
                {row.label}
              </Chip>
            ))}
          </div>
        </Field>
        <Field label="World instructions" note="verbatim in narrator, character, and guest prompts (not the lean director plan)">
          <textarea
            rows={4}
            defaultValue={world.ai.customInstructions}
            key={world.id + '-custom-' + storyStanceOf(world)}
            onBlur={(e) => patchAI({ customInstructions: e.target.value })}
            placeholder="Anything else the narrator should hold: themes to circle, imagery to reuse, what the story is really about…"
          />
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: 14, borderTop: '1px solid var(--rule)', paddingTop: 16 }}>
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
          <Field label="Image model override" note="unset = global default">
            <ModelPicker
              value={world.imageModel ?? null}
              onChange={(m) => patchWorld({ imageModel: m })}
            />
            {world.imageModel && (
              <button className="btn-quiet" style={{ alignSelf: 'flex-start', fontSize: 11 }}
                onClick={() => patchWorld({ imageModel: null })}>use global default</button>
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
    <div className="craft-row" style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink-heading)' }}>{label}</div>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10.5, color: 'oklch(0.32 0.12 25)' }}>{valueLabel}</div>
      </div>
      <Bar pct={value} />
      <input
        type="range" min={0} max={100} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ padding: 0, height: 4 }}
      />
      <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--ink-muted)' }}>{note}</div>
    </div>
  );
}

function WorldBibleEditor({ world, onError }: { world: World; onError: (msg: string) => void }) {
  return (
    <div className="craft-row" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Field label="World bible" note="setting, rules — packed into narrator, character, and guest prompts">
        <textarea
          rows={6}
          className="serif"
          key={world.id + '-bible'}
          defaultValue={world.bible}
          onBlur={(e) => void safeWrite(
            () => db.worlds.update(world.id, { bible: e.target.value, updatedAt: Date.now() }),
            onError
          )}
          style={{ fontSize: 15, lineHeight: 1.7 }}
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
