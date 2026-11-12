import { CHARACTER_IMPORTANCE, characterImportance } from '../ai/characterWeight';
import type { CharacterImportance } from '../types';
import { Chip, Field } from '../ui/bits';

const LABEL: Record<CharacterImportance, string> = {
  lead: 'Lead',
  regular: 'Regular',
  occasional: 'Occasional',
  background: 'Background'
};

/** Four-way story weight. Missing reads as regular. */
export function StoryWeightPicker({
  value,
  onChange
}: {
  value: CharacterImportance | undefined;
  onChange: (next: CharacterImportance) => void;
}) {
  const current = characterImportance({ importance: value });
  return (
    <Field label="Story weight">
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {CHARACTER_IMPORTANCE.map((weight) => (
          <Chip key={weight} active={current === weight} onClick={() => onChange(weight)}>
            {LABEL[weight]}
          </Chip>
        ))}
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--ink-muted)' }}>
        Lead is often. Regular when the place fits. Occasional when the moment needs them. Background unless called on.
      </div>
    </Field>
  );
}
