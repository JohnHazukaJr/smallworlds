import type { StoryStance } from '../types';

/** Injected into the scene writer, season handoff, and flesh so stance is not only a Shape: tag. */
export function stancePlaybook(stance: StoryStance): string {
  switch (stance) {
    case 'wander':
      return (
        'Story stance: wander. Play lives in place and people. ' +
        'Do not invent a plot clock, ticking crisis, or a pressure that will not wait. Let the chapter breathe.'
      );
    case 'intimate':
      return (
        'Story stance: intimate. Situation is who the player is with — relationship, conversation, attention. ' +
        'Do not invent a crisis to justify the moment.'
      );
    case 'sandbox':
      return (
        'Story stance: sandbox. Discover in play. Do not invent a plot or demand tension every turn.'
      );
    default:
      return (
        'Story stance: longform. A through-line is welcome. ' +
        'Do not demand a crisis or ticking clock every turn — stakes and desire are enough.'
      );
  }
}
