import { describe, expect, it } from 'vitest';
import {
  bandForWidth,
  editorsStacked,
  measureViewport,
  phoneChrome,
  sheetsFromBottom,
  shortStoryChrome,
  tabBarInset
} from './viewport';

describe('bandForWidth', () => {
  it('marks iPhone and Fold cover as compact', () => {
    expect(bandForWidth(320)).toBe('compact');
    expect(bandForWidth(375)).toBe('compact');
    expect(bandForWidth(390)).toBe('compact');
    expect(bandForWidth(430)).toBe('compact');
    expect(bandForWidth(360)).toBe('compact');
    expect(bandForWidth(599)).toBe('compact');
  });

  it('marks Fold inner as regular', () => {
    expect(bandForWidth(600)).toBe('regular');
    expect(bandForWidth(645)).toBe('regular');
    expect(bandForWidth(752)).toBe('regular');
    expect(bandForWidth(816)).toBe('regular');
    expect(bandForWidth(959)).toBe('regular');
  });

  it('marks desktop as wide', () => {
    expect(bandForWidth(960)).toBe('wide');
    expect(bandForWidth(1280)).toBe('wide');
  });
});

describe('chrome helpers', () => {
  it('uses tabs on compact and regular, rail only on wide', () => {
    expect(phoneChrome('compact')).toBe(true);
    expect(phoneChrome('regular')).toBe(true);
    expect(phoneChrome('wide')).toBe(false);
  });

  it('stacks editors only on compact', () => {
    expect(editorsStacked('compact')).toBe(true);
    expect(editorsStacked('regular')).toBe(false);
    expect(editorsStacked('wide')).toBe(false);
  });

  it('docks sheets to the bottom only on compact', () => {
    expect(sheetsFromBottom('compact')).toBe(true);
    expect(sheetsFromBottom('regular')).toBe(false);
  });

  it('uses a More sheet on compact or short Fold landscape', () => {
    expect(shortStoryChrome('compact', 844)).toBe(true);
    expect(shortStoryChrome('regular', 616)).toBe(true);
    expect(shortStoryChrome('regular', 715)).toBe(false);
    expect(shortStoryChrome('wide', 800)).toBe(false);
  });

  it('reserves tab-bar + safe area when the bar is showing', () => {
    expect(tabBarInset(true)).toContain('58px');
    expect(tabBarInset(false)).toBe('0px');
  });
});

describe('measureViewport', () => {
  it('reports keyboard cover from visualViewport', () => {
    const closed = measureViewport({ innerWidth: 390, innerHeight: 844, visualViewport: { height: 844, offsetTop: 0 } });
    expect(closed.keyboardOpen).toBe(false);
    const open = measureViewport({ innerWidth: 390, innerHeight: 844, visualViewport: { height: 500, offsetTop: 0 } });
    expect(open.keyboardOpen).toBe(true);
    expect(open.keyboardOffset).toBe(344);
  });
});
