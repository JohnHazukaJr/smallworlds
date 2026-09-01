/**
 * Speaker attribution runs for the prose transcript layout.
 *
 * In prose layout a name is printed only when the floor changes, the way a novel
 * drops "she said" once a exchange is established. Narration or author direction
 * between two lines breaks the run, so the next speaker is named again.
 */

/** Minimal shape needed to attribute a rendered block. */
export interface AttributableBlock {
  kind: 'narration' | 'dialogue' | 'direction' | 'action' | 'speak';
  speaker?: string;
}

export function isDialogueBlock(b: AttributableBlock): boolean {
  return b.kind === 'dialogue' || b.kind === 'action' || b.kind === 'speak';
}

/** Speaker holding the floor after this block; null for narration and direction. */
export function dialogueSpeakerOf(b: AttributableBlock): string | null {
  return isDialogueBlock(b) ? (b.speaker ?? null) : null;
}

/** Who the previous turn left holding the floor. */
export function lastSpokenBy(blocks: readonly AttributableBlock[]): string | null {
  const last = blocks[blocks.length - 1];
  return last ? dialogueSpeakerOf(last) : null;
}

/**
 * For each block, whether it continues the previous speaker and can skip its name.
 * `prevSpeaker` carries the run across turn boundaries.
 */
export function attributionRun(
  blocks: readonly AttributableBlock[],
  prevSpeaker: string | null
): boolean[] {
  let running = prevSpeaker;
  return blocks.map((b) => {
    const speaker = dialogueSpeakerOf(b);
    const continues = !!speaker && speaker === running;
    running = speaker;
    return continues;
  });
}
