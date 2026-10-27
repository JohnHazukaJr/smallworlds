import type { CSSProperties } from 'react';
import type { Character } from '../types';
import { characterPortraits } from '../worldOps';
import { avatarStyle } from './theme';

/** List avatar. The main photo is portraits[0], kept in sync by portraitsPatch. */
export function characterAvatarStyle(
  c: Pick<Character, 'hue' | 'portrait' | 'portraits'>,
  size: number,
  ring?: string
): CSSProperties {
  const face = characterPortraits(c)[0];
  const base = avatarStyle(c.hue, size, ring);
  if (!face) return base;
  return {
    ...base,
    background: `center / cover no-repeat url(${face})`
  };
}
