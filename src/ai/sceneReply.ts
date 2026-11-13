/**
 * Split one scene reply into narrator prose and lines that clearly belong
 * to someone who is here. A quote with no name stays in the narration.
 */

export interface SceneSpeaker {
  id: string;
  name: string;
  aliases?: string[];
  kind: 'cast' | 'guest';
}

export interface ScenePiece {
  role: 'narrator' | 'character';
  text: string;
  speakerId?: string;
  kind?: 'cast' | 'guest';
}

const QUOTE_RE = /[“"]([^“”"]+)[”"]/g;

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function labelsOf(speaker: SceneSpeaker): string[] {
  return [speaker.name, ...(speaker.aliases ?? [])]
    .map((label) => label.trim())
    .filter((label) => label.length >= 2);
}

function nearestSpeaker(before: string, after: string, speakers: SceneSpeaker[]): SceneSpeaker | undefined {
  let best: { speaker: SceneSpeaker; dist: number; len: number } | undefined;
  const consider = (window: string, fromEnd: boolean) => {
    for (const speaker of speakers) {
      for (const label of labelsOf(speaker)) {
        const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(label)}([^\\p{L}\\p{N}]|$)`, 'giu');
        let match: RegExpExecArray | null;
        while ((match = re.exec(window))) {
          const at = match.index + (match[1]?.length ?? 0);
          const dist = fromEnd ? window.length - (at + label.length) : at;
          if (
            !best ||
            dist < best.dist ||
            (dist === best.dist && label.length > best.len)
          ) {
            best = { speaker, dist, len: label.length };
          }
        }
      }
    }
  };
  consider(before, true);
  consider(after, false);
  return best?.speaker;
}

function pushNarration(pieces: ScenePiece[], raw: string) {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return;
  const last = pieces[pieces.length - 1];
  if (last?.role === 'narrator') last.text = `${last.text} ${text}`.trim();
  else pieces.push({ role: 'narrator', text });
}

/** Narration stays narration. Quoted speech with a nearby name becomes that person's line. */
export function splitSceneReply(text: string, speakers: SceneSpeaker[]): ScenePiece[] {
  const source = text.replace(/\r\n/g, '\n').trim();
  if (!source) return [];
  const hits: Array<{ start: number; end: number; quote: string; speaker?: SceneSpeaker }> = [];
  for (const match of source.matchAll(QUOTE_RE)) {
    const start = match.index ?? 0;
    const quote = match[0];
    const before = source.slice(Math.max(0, start - 160), start);
    const after = source.slice(start + quote.length, start + quote.length + 80);
    hits.push({
      start,
      end: start + quote.length,
      quote: quote.trim(),
      speaker: nearestSpeaker(before, after, speakers)
    });
  }
  if (hits.length === 0) return [{ role: 'narrator', text: source }];

  const pieces: ScenePiece[] = [];
  let cursor = 0;
  for (const hit of hits) {
    pushNarration(pieces, source.slice(cursor, hit.start));
    if (hit.speaker && hit.quote) {
      pieces.push({
        role: 'character',
        text: hit.quote,
        speakerId: hit.speaker.id,
        kind: hit.speaker.kind
      });
    } else {
      pushNarration(pieces, source.slice(hit.start, hit.end));
    }
    cursor = hit.end;
  }
  pushNarration(pieces, source.slice(cursor));
  return pieces;
}
