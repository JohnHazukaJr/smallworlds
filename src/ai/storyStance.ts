import type { StoryStance } from '../types';

/** Injected into director, narrator, interview, and flesh so stance is not only a Shape: tag. */
export function stancePlaybook(stance: StoryStance): string {
  switch (stance) {
    case 'wander':
      return (
        'Story stance: wander. Play lives in place and people. ' +
        'Do not invent a plot clock, ticking crisis, or a pressure that will not wait. Let scenes breathe.'
      );
    case 'intimate':
      return (
        'Story stance: intimate. Situation is who the player is with — relationship, conversation, attention. ' +
        'Do not invent a crisis to justify the scene.'
      );
    case 'sandbox':
      return (
        'Story stance: sandbox. Discover in play. Do not invent a plot or demand tension every beat.'
      );
    default:
      return (
        'Story stance: longform. A through-line is welcome. ' +
        'Do not demand a crisis or ticking clock every beat — stakes and desire are enough.'
      );
  }
}

export function directorCloseGuidance(stance: StoryStance): string {
  const heard =
    'An opening is a pause, a look, or a next move — not repeating a question the player just answered.';
  if (stance === 'longform') {
    return `End the plan on an opening for the player. Stakes may be present; do not require a crisis beat. ${heard}`;
  }
  return `End the plan on an opening for the player. Do not end on manufactured tension or a ticking clock. ${heard}`;
}

export function narratorCloseGuidance(stance: StoryStance): string {
  const heard = 'Do not pose a question they already answered.';
  if (stance === 'longform') {
    return `End every response on an opening for the player, never on a tidy resolution. Stakes may hang; do not invent a crisis. ${heard}`;
  }
  return `End every response on an opening for the player, never on a tidy resolution. Do not invent tension or a plot clock. ${heard}`;
}
