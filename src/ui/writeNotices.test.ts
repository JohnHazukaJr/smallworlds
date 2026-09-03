import { describe, expect, it } from 'vitest';
import {
  abortWriteNotice,
  NOTICE_ADD_CAST,
  NOTICE_ADD_MODEL,
  noticeNavAction
} from './writeNotices';

describe('abortWriteNotice', () => {
  it('points at Continue plan when leftover beats exist and none have saved', () => {
    const copy = abortWriteNotice(0, 3);
    expect(copy).toMatch(/Continue plan/);
    expect(copy).toMatch(/3 lines left/);
    expect(copy).not.toMatch(/was not applied/);
  });

  it('does not mention Continue plan when nothing remains', () => {
    expect(abortWriteNotice(0, 0)).toMatch(/was not applied/);
    expect(abortWriteNotice(0, 0)).not.toMatch(/Continue plan/);
    expect(abortWriteNotice(2, 0)).toMatch(/incomplete line discarded/);
    expect(abortWriteNotice(2, 0)).not.toMatch(/Continue plan/);
  });

  it('keeps the existing partial-save copy when some lines landed', () => {
    expect(abortWriteNotice(2, 1)).toMatch(/Stopped after 2 lines/);
    expect(abortWriteNotice(2, 1)).toMatch(/1 left in the plan/);
  });
});

describe('noticeNavAction', () => {
  it('is null for stop copy', () => {
    expect(noticeNavAction(abortWriteNotice(0, 3))).toBeNull();
    expect(noticeNavAction(abortWriteNotice(0, 0))).toBeNull();
    expect(noticeNavAction('Fix the checklist above, or press Write anyway.')).toBeNull();
  });

  it('routes Cast and Settings only for those notices', () => {
    expect(noticeNavAction(NOTICE_ADD_CAST)).toEqual({ label: 'Open Cast', screen: 'cast' });
    expect(noticeNavAction(NOTICE_ADD_MODEL)).toEqual({ label: 'Settings', screen: 'settings' });
  });
});
