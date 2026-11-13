import { describe, expect, it } from 'vitest';
import {
  abortWriteNotice,
  unfinishedWriteNotice,
  NOTICE_ADD_MODEL,
  noticeNavAction
} from './writeNotices';

describe('abortWriteNotice', () => {
  it('says the line was not applied when nothing landed', () => {
    const copy = abortWriteNotice(0, 0);
    expect(copy).toMatch(/stopped/i);
    expect(copy).toMatch(/was not applied/);
    expect(copy).not.toMatch(/continue finishes/i);
    expect(copy).not.toMatch(/lines saved/i);
  });

  it('keeps the same stop copy when an old queue count is passed', () => {
    expect(abortWriteNotice(0, 3)).toMatch(/was not applied/);
    expect(abortWriteNotice(0, 3)).not.toMatch(/continue finishes/i);
  });

  it('says what was written stays when a reply landed', () => {
    expect(abortWriteNotice(2, 0)).toMatch(/Stopped\. What was written stays\./);
    expect(abortWriteNotice(2, 1)).not.toMatch(/lines saved/i);
    expect(abortWriteNotice(2, 1)).not.toMatch(/continue finishes/i);
  });
});

describe('unfinishedWriteNotice', () => {
  it('says the line was not applied when nothing landed', () => {
    const copy = unfinishedWriteNotice(0, 3);
    expect(copy).toMatch(/was not applied/);
    expect(copy).not.toMatch(/continue finishes/i);
  });

  it('is empty when nothing remains and nothing landed', () => {
    expect(unfinishedWriteNotice(0, 0)).toBe('');
  });

  it('keeps a landed reply without a queue', () => {
    expect(unfinishedWriteNotice(2, 0)).toMatch(/What was written stays/);
  });
});

describe('noticeNavAction', () => {
  it('is null for stop copy', () => {
    expect(noticeNavAction(abortWriteNotice(0, 3))).toBeNull();
    expect(noticeNavAction(abortWriteNotice(0, 0))).toBeNull();
    expect(noticeNavAction('Fix the checklist above, or press Write anyway.')).toBeNull();
  });

  it('routes Settings only for that notice', () => {
    expect(noticeNavAction(NOTICE_ADD_MODEL)).toEqual({ label: 'Settings', screen: 'settings' });
  });
});
