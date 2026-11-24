import { useEffect, useRef, useState } from 'react';
import { subjectAgeReading } from '../ai/portrait';
import { LOOK_SECTIONS, type LookKey } from '../looks';
import type { Character, CharacterLooks } from '../types';
import { Chip, Field } from '../ui/bits';

type AppearancePatch = Partial<Pick<Character, 'appearance' | 'looks'>>;

/**
 * Appearance as an overall line plus add-as-needed parts: face, hair, body,
 * clothing, details, voice & scent, and an intimate section in adult worlds.
 * Filled parts stay open; empty ones wait as chips. Saves on blur.
 */
export function AppearanceFields({
  appearance, looks, age, role, mature, onCommit, label = 'Appearance', note
}: {
  appearance: string;
  looks?: CharacterLooks;
  /** For the intimate section: hidden in general-audience worlds, locked for anyone who reads under 18. */
  age: string;
  role?: string;
  mature: boolean;
  onCommit: (patch: AppearancePatch) => void | Promise<void>;
  label?: string;
  note?: string;
}) {
  const [overall, setOverall] = useState(appearance);
  const [parts, setParts] = useState<CharacterLooks>(looks ?? {});
  const [opened, setOpened] = useState<Set<LookKey>>(() => new Set());
  const focused = useRef<string | null>(null);
  const refs = useRef<Partial<Record<LookKey, HTMLTextAreaElement | null>>>({});
  const focusNext = useRef<LookKey | null>(null);

  // Take outside changes (Fill in with AI, another device) without clobbering the box being typed in.
  useEffect(() => {
    if (focused.current !== 'overall') setOverall(appearance);
  }, [appearance]);
  useEffect(() => {
    setParts((current) => {
      const next: CharacterLooks = { ...(looks ?? {}) };
      const typing = focused.current as LookKey | null;
      if (typing && typing !== ('overall' as LookKey)) next[typing] = current[typing];
      return next;
    });
  }, [looks]);
  useEffect(() => {
    const key = focusNext.current;
    if (key) {
      refs.current[key]?.focus();
      focusNext.current = null;
    }
  });

  const reading = subjectAgeReading({ age, appearance: overall, role, looks: parts });
  const sections = LOOK_SECTIONS.filter((s) => !s.adultOnly || mature || (parts[s.key] ?? '').trim());

  const commitPart = (key: LookKey, raw: string) => {
    const value = raw.trim();
    const before = (looks?.[key] ?? '').trim();
    if (!value) {
      setOpened((set) => {
        const next = new Set(set);
        next.delete(key);
        return next;
      });
    }
    if (value === before) return;
    // Build from what is on screen, not the last saved copy: two parts finished in a
    // row must not overwrite each other while the first save is still on its way.
    const next: CharacterLooks = {};
    for (const section of LOOK_SECTIONS) {
      const text = (section.key === key ? value : (parts[section.key] ?? '')).trim();
      if (text) next[section.key] = text;
    }
    void onCommit({ looks: next });
  };

  const open = (key: LookKey) => {
    setOpened((set) => new Set(set).add(key));
    focusNext.current = key;
  };

  const shown = sections.filter((s) => (parts[s.key] ?? '').trim() || opened.has(s.key));
  const chips = sections.filter((s) => !shown.includes(s));

  return (
    <Field label={label} note={note ?? 'the overall look; add parts the narrator and pictures keep consistent'}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <textarea
          rows={2}
          aria-label={`${label}: overall`}
          value={overall}
          placeholder="Overall: tall, weathered, carries herself like she owns the room"
          onFocus={() => { focused.current = 'overall'; }}
          onChange={(e) => setOverall(e.target.value)}
          onBlur={(e) => {
            focused.current = null;
            if (e.target.value !== appearance) void onCommit({ appearance: e.target.value });
          }}
        />
        {shown.map((section) => {
          const locked = section.adultOnly && reading.minor;
          return (
            <div key={section.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label
                htmlFor={`look-${section.key}`}
                style={{
                  fontFamily: "'IBM Plex Mono', monospace", fontSize: 9.5, letterSpacing: '0.12em',
                  textTransform: 'uppercase', color: 'var(--ink-muted)'
                }}
              >
                {section.label}{section.adultOnly ? ' · 18+' : ''}
              </label>
              <textarea
                id={`look-${section.key}`}
                ref={(el) => { refs.current[section.key] = el; }}
                rows={2}
                value={parts[section.key] ?? ''}
                placeholder={section.placeholder}
                onFocus={() => { focused.current = section.key; }}
                onChange={(e) => {
                  const value = e.target.value;
                  setParts((p) => ({ ...p, [section.key]: value }));
                }}
                onBlur={(e) => {
                  focused.current = null;
                  commitPart(section.key, e.target.value);
                }}
              />
              {locked && (
                <div className="label" style={{ fontSize: 11 }}>
                  Not used while this character reads as under 18. Set an age of 18 or over to use it.
                </div>
              )}
            </div>
          );
        })}
        {chips.length > 0 && (
          <div role="group" aria-label="Add to appearance" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {chips.map((section) => {
              const locked = section.adultOnly && reading.minor;
              return (
                <span key={section.key} title={locked ? 'Set an age of 18 or over to add intimate details.' : undefined}>
                  <Chip disabled={locked} onClick={() => { if (!locked) open(section.key); }}>
                    + {section.label}{section.adultOnly ? ' (18+)' : ''}
                  </Chip>
                </span>
              );
            })}
          </div>
        )}
      </div>
    </Field>
  );
}
