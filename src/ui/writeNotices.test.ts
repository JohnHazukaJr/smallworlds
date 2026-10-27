import { describe, expect, it } from 'vitest';
import {
  abortWriteNotice,
  unfinishedWriteNotice,
  NOTICE_ADD_MODEL,
  noticeNavAction
} from './writeNotices';

describe('abortWriteNotice', () => {
  it('says the page stopped and nothing was kept when no reply landed', () => {
    const copy = abortWriteNotice(0, 3);
    expect(copy).toMatch(/page stopped/i);
    expect(copy).toMatch(/Nothing new was kept/);
    expect(copy).not.toMatch(/Continue plan/);
    expect(copy).not.toMatch(/plan/);
    expect(copy).not.toMatch(/was not applied/);
  });

  it('does not mention a plan when nothing remains', () => {
    expect(abortWriteNotice(0, 0)).toMatch(/was not applied/);
    expect(abortWriteNotice(0, 0)).not.toMatch(/plan/);
    expect(abortWriteNotice(2, 0)).toMatch(/incomplete line discarded/);
    expect(abortWriteNotice(2, 0)).not.toMatch(/plan/);
  });

  it('says how many lines were kept when some landed', () => {
    expect(abortWriteNotice(2, 1)).toMatch(/page stopped after 2 lines/i);
    expect(abortWriteNotice(2, 1)).toMatch(/Those lines were kept/);
    expect(abortWriteNotice(2, 1)).not.toMatch(/plan/);
  });
});

describe('unfinishedWriteNotice', () => {
  it('says the page stopped before a reply when the first beat failed', () => {
    const copy = unfinishedWriteNotice(0, 3);
    expect(copy).toMatch(/page stopped/i);
    expect(copy).toMatch(/Nothing new was kept/);
    expect(copy).not.toMatch(/Continue plan/);
    expect(copy).not.toMatch(/plan/);
  });

  it('is empty when nothing remains', () => {
    expect(unfinishedWriteNotice(0, 0)).toBe('');
    expect(unfinishedWriteNotice(2, 0)).toBe('');
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
