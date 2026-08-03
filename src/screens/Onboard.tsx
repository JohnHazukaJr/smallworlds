import { useState } from 'react';
import { draftCharacter, draftWorld } from '../ai/engine';
import { db } from '../db';
import { useApp } from '../store/app';
import { useSettings } from '../store/settings';
import { ErrorNote, Mono, Spinner, useVw } from '../ui/bits';
import { STRIPE } from '../ui/theme';
import { createWorld, emptyCharacter } from '../worldOps';

const SHAPES = [
  { label: 'One long story I keep returning to', line: 'Seasons, episodes, a cast that ages and remembers.' },
  { label: 'A world I want to wander', line: 'Loose scenes, many characters, no fixed plot.' },
  { label: 'A single character I want to know', line: 'One person, deeply modelled, many conversations.' },
  { label: 'I want to see what happens', line: 'Start blank. Decide later.' }
];

const SEED_KINDS = [
  { label: 'A place', line: 'Somewhere with its own weather and its own rules.' },
  { label: 'A rule', line: 'Something in this world cannot be undone.' },
  { label: 'A pressure', line: 'Something is coming and everyone knows it.' },
  { label: 'Notes I already have', line: 'Paste a paragraph of notes — it gets read into a world.' }
];

const CAST_KINDS = [
  { label: 'Describe them, get a full sheet', line: 'One sentence in, a deep NPC sheet out — editable after.' },
  { label: 'Write them myself, later', line: 'Voice and anchors when you\u2019re ready. Cast screen any time.' },
  { label: 'Only me for now', line: 'Second person, no cast yet.' }
];

const PROMISES = [
  { t: 'Characters that hold a line', d: 'Behaviour anchors ride along in every prompt. They can refuse you, and they will.' },
  { t: 'Your key, any model', d: 'OpenRouter, Anthropic, Gemini, Kimi, local models — swap engines per world, any time.' },
  { t: 'Seasons that remember selectively', d: 'At each season\u2019s end the story is read back and you decide what the next one carries.' },
  { t: 'Private by design', d: 'Everything lives on this device. Nothing is sent anywhere but the AI endpoint you name.' }
];

export function Onboard() {
  const vw = useVw();
  const narrow = vw < 1000;
  const { go, openWorld } = useApp();
  const providers = useSettings((s) => s.providers);

  const [step, setStep] = useState(0);
  const [shape, setShape] = useState(0);
  const [seedKind, setSeedKind] = useState(0);
  const [seed, setSeed] = useState('');
  const [title, setTitle] = useState('');
  const [castKind, setCastKind] = useState(0);
  const [castDesc, setCastDesc] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const hasAI = providers.length > 0;

  const finish = async () => {
    setError('');
    try {
      let worldInput = {
        title: title.trim(),
        line: seed.trim().slice(0, 140),
        bible: seed.trim(),
        premise: ''
      };
      if (hasAI && seed.trim()) {
        setBusy('Reading your seed into a world…');
        try {
          const drafted = await draftWorld(seed.trim(), SHAPES[shape].label);
          worldInput = {
            title: title.trim() || drafted.title,
            line: drafted.line,
            bible: drafted.bible,
            premise: drafted.premise
          };
        } catch (e) {
          // AI drafting is optional — fall back to the raw seed.
          console.warn('world drafting failed, using raw seed', e);
        }
      }
      if (!worldInput.title && !worldInput.bible) {
        setError('Give the world at least one true thing (or a title) first.');
        setBusy(null);
        return;
      }

      setBusy('Building the world…');
      const world = await createWorld(worldInput);

      if (castKind === 0 && castDesc.trim()) {
        if (hasAI) {
          setBusy('Drafting the first character…');
          try {
            const sheet = await draftCharacter(world, castDesc.trim());
            const c = emptyCharacter(world.id, sheet);
            await db.characters.add(c);
            const episode = await db.episodes.where('worldId').equals(world.id).first();
            if (episode) await db.episodes.update(episode.id, { castIds: [...episode.castIds, c.id] });
          } catch (e) {
            console.warn('character drafting failed', e);
          }
        } else {
          const c = emptyCharacter(world.id, { name: castDesc.trim().slice(0, 40), summary: castDesc.trim() });
          await db.characters.add(c);
        }
      }

      setBusy(null);
      openWorld(world.id);
    } catch (e) {
      setBusy(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const steps = [
    {
      title: 'Start from nothing.',
      body: 'Small Worlds does not hand you a story. It gives you a world that behaves consistently and characters who hold their own line — then gets out of the way while you write into it.',
      cta: 'Next — the world',
      content: (
        <OptionList options={SHAPES} value={shape} onChange={setShape} />
      )
    },
    {
      title: 'Give the world one true thing.',
      body: 'A place, a rule, a pressure. One sentence is enough — the rest gets asked about as the story needs it, rather than making you fill in a form now.',
      cta: 'Next — the first character',
      content: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <OptionList options={SEED_KINDS} value={seedKind} onChange={setSeedKind} />
          <textarea
            rows={3} value={seed} onChange={(e) => setSeed(e.target.value)}
            placeholder={[
              'A port where every debt is public record, and yours is written under a false name.',
              'In this valley, a promise spoken aloud cannot be broken — only traded.',
              'The ice is going out three weeks early, and the town owes its god a winter.',
              'Paste your notes here — a paragraph or a page.'
            ][seedKind]}
            className="serif" style={{ fontFamily: 'Spectral, serif', fontSize: 15.5, lineHeight: 1.65 }}
          />
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional — one gets drafted if blank)" />
        </div>
      )
    },
    {
      title: 'Who is in it with you?',
      body: hasAI
        ? 'Give them one sentence and the utility model drafts a full sheet — voice, desires, secrets, anchors — that you can edit on the Cast screen. Anchors are what stop them dissolving into an agreeable assistant.'
        : 'No AI provider configured yet — you can still create the world now and add a key in Settings before writing.',
      cta: busy ? busy : 'Enter the world',
      content: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <OptionList options={CAST_KINDS} value={castKind} onChange={setCastKind} />
          {castKind === 0 && (
            <textarea
              rows={2} value={castDesc} onChange={(e) => setCastDesc(e.target.value)}
              placeholder="e.g. The harbour registrar who has already noticed your handwriting"
            />
          )}
        </div>
      )
    }
  ];
  const ob = steps[step];

  return (
    <div className="fade-in" style={{ minHeight: '100vh', display: 'grid', gridTemplateColumns: narrow ? 'minmax(0, 1fr)' : '1.05fr 1fr' }}>
      <div style={{ padding: narrow ? '30px 20px 46px' : '52px 44px 56px', display: 'flex', flexDirection: 'column', gap: 28, maxWidth: 660 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {[0, 1, 2].map((i) => (
            <div key={i} style={{
              width: i === step ? 26 : 9, height: 4, borderRadius: 2,
              background: i <= step ? 'oklch(0.85 0.1 62)' : 'rgba(255,255,255,0.14)',
              transition: 'all 0.3s ease'
            }} />
          ))}
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, letterSpacing: '0.12em', color: 'rgba(236,234,230,0.4)', marginLeft: 8 }}>
            step {step + 1} of 3
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h1 className="serif" style={{ fontWeight: 300, fontSize: narrow ? 32 : 42, lineHeight: 1.1, margin: 0, color: '#f8f6f2' }}>{ob.title}</h1>
          <div style={{ fontSize: 15, lineHeight: 1.7, color: 'rgba(236,234,230,0.58)', maxWidth: '54ch' }}>{ob.body}</div>
        </div>

        {ob.content}

        {error && <ErrorNote error={error} onDismiss={() => setError('')} />}
        {busy && <Spinner label={busy} />}

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 'auto', flexWrap: 'wrap' }}>
          {step > 0 && <button className="btn-ghost" disabled={!!busy} onClick={() => setStep(step - 1)}>Back</button>}
          <button
            className="btn-primary" style={{ padding: '12px 24px', fontSize: 13.5 }}
            disabled={!!busy}
            onClick={() => (step < 2 ? setStep(step + 1) : void finish())}
          >
            {ob.cta}
          </button>
          <button className="btn-quiet" disabled={!!busy} onClick={() => go('library')}>Skip — back to worlds</button>
        </div>
      </div>

      {!narrow && (
        <div style={{
          borderLeft: '1px solid rgba(255,255,255,0.07)', padding: '46px 40px', display: 'flex',
          flexDirection: 'column', gap: 20, justifyContent: 'center', background: 'rgba(255,255,255,0.03)', backdropFilter: 'blur(20px)'
        }}>
          <Mono>what you get</Mono>
          <div style={{
            height: 244, borderRadius: 18, border: '1px solid rgba(255,255,255,0.11)',
            display: 'flex', alignItems: 'flex-end', padding: 14,
            background: `linear-gradient(155deg, rgba(224,165,95,0.18), rgba(8,9,12,0.9)), ${STRIPE('rgba(255,255,255,0.06)', 'rgba(255,255,255,0.015)')}`
          }}>
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: 'rgba(236,234,230,0.62)', background: 'rgba(8,9,12,0.5)', backdropFilter: 'blur(6px)', padding: '5px 9px', borderRadius: 6 }}>
              world plate
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {PROMISES.map((p) => (
              <div key={p.t} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <div style={{ width: 5, height: 5, borderRadius: '50%', background: 'oklch(0.85 0.1 62)', marginTop: 8, flexShrink: 0 }} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: '#f0eee9' }}>{p.t}</div>
                  <div style={{ fontSize: 12.5, lineHeight: 1.6, color: 'rgba(236,234,230,0.55)' }}>{p.d}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function OptionList({ options, value, onChange }: {
  options: Array<{ label: string; line: string }>; value: number; onChange: (i: number) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {options.map((o, i) => {
        const active = value === i;
        return (
          <button key={o.label} onClick={() => onChange(i)} style={{
            display: 'flex', alignItems: 'center', gap: 14,
            border: `1px solid rgba(255,255,255,${active ? '0.2' : '0.09'})`,
            background: active ? 'linear-gradient(150deg, rgba(224,165,95,0.13), rgba(255,255,255,0.05))' : 'rgba(255,255,255,0.03)',
            color: active ? '#f6f4f0' : 'rgba(236,234,230,0.62)',
            borderRadius: 14, padding: '15px 17px', cursor: 'pointer', backdropFilter: 'blur(16px)'
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, textAlign: 'left', flex: 1 }}>
              <div style={{ fontSize: 14.5, fontWeight: 600 }}>{o.label}</div>
              <div style={{ fontSize: 12.5, lineHeight: 1.55, opacity: 0.68 }}>{o.line}</div>
            </div>
            <div style={{
              width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
              border: `1px solid ${active ? 'oklch(0.85 0.1 62)' : 'rgba(255,255,255,0.18)'}`,
              background: active ? 'oklch(0.85 0.1 62)' : 'transparent',
              boxShadow: active ? 'inset 0 0 0 3px rgba(8,9,12,0.9)' : 'none'
            }} />
          </button>
        );
      })}
    </div>
  );
}
