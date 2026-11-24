import { describe, expect, it } from 'vitest';
import { gradeReply, narratorVoicesPlayer, worstStatus, type EvalPiece } from './grade';
import { judgePrompt, meanScore, parseVerdict } from './judge';
import { CAST, SCENARIOS, type EvalScenario } from './scenarios';

const scene = (id: string): EvalScenario => SCENARIOS.find((s) => s.id === id)!;
const status = (checks: ReturnType<typeof gradeReply>, id: string) => checks.find((c) => c.id === id)?.status;
const opts = { playerName: 'Rowan' };

describe('gradeReply', () => {
  it('fails an empty reply and stops there', () => {
    const checks = gradeReply(scene('address-by-name'), [], opts);
    expect(checks).toEqual([{ id: 'reply', status: 'fail', detail: 'empty reply' }]);
  });

  it('passes when the addressed person speaks', () => {
    const pieces: EvalPiece[] = [
      { role: 'narrator', text: 'Ada does not look up.' },
      { role: 'character', who: 'ada', name: 'Ada Vey', text: '"Who signed for it?"' }
    ];
    const checks = gradeReply(scene('address-by-name'), pieces, opts);
    expect(status(checks, 'replier')).toBe('pass');
    expect(status(checks, 'spoken')).toBe('pass');
    expect(worstStatus(checks)).toBe('pass');
  });

  it('fails when someone else answers, and names who did', () => {
    const pieces: EvalPiece[] = [{ role: 'character', who: 'brannoc', name: 'Brannoc Hale', text: '"Aye, lad."' }];
    const replier = gradeReply(scene('address-by-name'), pieces, opts).find((c) => c.id === 'replier')!;
    expect(replier.status).toBe('fail');
    expect(replier.detail).toContain('Brannoc Hale');
  });

  it('warns when the addressed person only gestures', () => {
    const pieces: EvalPiece[] = [{ role: 'character', who: 'ada', text: '*taps the page twice*' }];
    expect(status(gradeReply(scene('address-by-name'), pieces, opts), 'replier')).toBe('warn');
  });

  it('fails a person who should be elsewhere', () => {
    const pieces: EvalPiece[] = [
      { role: 'character', who: 'brannoc', text: '"Him? Slippery as an eel."' },
      { role: 'character', who: 'corin', text: '"I heard my name."' }
    ];
    const checks = gradeReply(scene('offstage-silent'), pieces, opts);
    expect(status(checks, 'silent:corin')).toBe('fail');
    expect(status(checks, 'silent:ada')).toBe('pass');
  });

  it('catches a forbidden phrase only in the scoped speaker, ignoring curly quotes and case', () => {
    const leak: EvalPiece[] = [{ role: 'character', who: 'ada', text: '“Fine. I Signed It. The Council left me no choice.”' }];
    expect(status(gradeReply(scene('secret-pressed'), leak, opts), 'forbidden:ada#1')).toBe('fail');
    const narratorOnly: EvalPiece[] = [
      { role: 'narrator', text: 'Everyone in Saltmere would say I signed it, if asked.' },
      { role: 'character', who: 'ada', text: '"Who told you that?"' }
    ];
    expect(status(gradeReply(scene('secret-pressed'), narratorOnly, opts), 'forbidden:ada#1')).toBe('pass');
  });

  it('fails a line credited to the player card', () => {
    const pieces: EvalPiece[] = [{ role: 'character', who: 'player', text: '"I did it."' }];
    expect(status(gradeReply(scene('player-agency'), pieces, opts), 'player-voice')).toBe('fail');
  });

  it('warns on uncredited speech left in narration', () => {
    const pieces: EvalPiece[] = [{ role: 'narrator', text: 'Somebody mutters, "the bell is late tonight again."' }];
    expect(status(gradeReply(scene('continue-scene'), pieces, opts), 'attribution')).toBe('warn');
  });
});

describe('narratorVoicesPlayer', () => {
  it('spots words put in the player’s mouth', () => {
    expect(narratorVoicesPlayer('You say, "I was never there."', 'Rowan')).toBe(true);
    expect(narratorVoicesPlayer('"I was never there," Rowan said.', 'Rowan')).toBe(true);
  });
  it('leaves NPC speech and plain narration alone', () => {
    expect(narratorVoicesPlayer('Ada says, "Explain."', 'Rowan')).toBe(false);
    expect(narratorVoicesPlayer('You feel the cold through the floor.', 'Rowan')).toBe(false);
  });
});

describe('judge', () => {
  it('shows the judge secrets and walls the writer must keep', () => {
    const { user } = judgePrompt(scene('knowledge-wall'), [{ role: 'character', who: 'ilse', name: 'Sister Ilse', text: '"Never."' }]);
    expect(user).toContain('MUST NOT KNOW');
    expect(user).toContain('[Sister Ilse] "Never."');
    expect(user).toContain('NOT PRESENT');
  });

  it('parses and clamps scores, zeroing what is missing', () => {
    const v = parseVerdict({ scores: { voice: 7, character: '4', address: 0.4, walls: 'x' }, notes: { voice: 'ok' }, worst: '' });
    expect(v.scores).toEqual({ voice: 5, character: 4, address: 1, walls: 0, agency: 0, craft: 0 });
    expect(v.worst).toBe('none');
    expect(meanScore(v)).toBeCloseTo(10 / 3);
  });
});

describe('scenarios', () => {
  it('only name people and guests that exist', () => {
    const cast = new Set(CAST.map((p) => p.key));
    for (const s of SCENARIOS) {
      const guests = new Set((s.guests ?? []).map((g) => g.key));
      const known = (k: string) => cast.has(k) || guests.has(k);
      for (const k of s.present) expect(cast.has(k), `${s.id}: present ${k}`).toBe(true);
      for (const l of s.history) if (l.who !== 'player' && l.who !== 'narrator') expect(known(l.who), `${s.id}: ${l.who}`).toBe(true);
      if (s.move.to) expect(known(s.move.to), `${s.id}: to ${s.move.to}`).toBe(true);
      if (s.expect.replier) expect(known(s.expect.replier), `${s.id}: replier`).toBe(true);
      for (const k of s.expect.silent ?? []) expect(s.present.includes(k), `${s.id}: silent ${k} is in the room`).toBe(false);
    }
  });

  it('have unique ids', () => {
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
  });
});
