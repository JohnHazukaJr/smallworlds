import { describe, expect, it } from 'vitest';
import { placeChapterPictures } from './chapterPictures';

const pic = (id: string, createdAt: number) => ({ id, createdAt, prompt: id });

const turns = [
  { id: 'a1', episodeId: 'early', createdAt: 10 },
  { id: 'a2', episodeId: 'early', createdAt: 20 },
  { id: 'b1', episodeId: 'late', createdAt: 30 },
  { id: 'b2', episodeId: 'late', createdAt: 40 }
];

describe('placeChapterPictures', () => {
  it('puts a picture after the earlier line it follows', () => {
    const placed = placeChapterPictures({
      turns,
      episodeOrder: ['early', 'late'],
      pictures: [
        { episodeId: 'late', picture: pic('between', 35) },
        { episodeId: 'late', picture: pic('after-last', 50) }
      ],
      windowSize: 60
    });
    expect(placed.after.get('b1')?.map((p) => p.id)).toEqual(['between']);
    expect(placed.after.get('b2')?.map((p) => p.id)).toEqual(['after-last']);
    expect(placed.leading).toEqual([]);
  });

  it('drops a picture once the line it follows leaves the window', () => {
    const placed = placeChapterPictures({
      turns,
      episodeOrder: ['early', 'late'],
      pictures: [{ episodeId: 'early', picture: pic('old', 15) }],
      windowSize: 2
    });
    expect(placed.after.size).toBe(0);
    expect(placed.before.size).toBe(0);
    expect(placed.leading).toEqual([]);
  });

  it('keeps a picture after the last line while that line is still visible', () => {
    const placed = placeChapterPictures({
      turns,
      episodeOrder: ['early', 'late'],
      pictures: [{ episodeId: 'late', picture: pic('fresh', 50) }],
      windowSize: 2
    });
    expect([...placed.after.keys()]).toEqual(['b2']);
    expect(placed.after.get('b2')?.map((p) => p.id)).toEqual(['fresh']);
  });

  it('keeps an earlier chapter picture with that chapter', () => {
    const wide = placeChapterPictures({
      turns,
      episodeOrder: ['early', 'late'],
      pictures: [
        { episodeId: 'early', picture: pic('harbour', 15) },
        { episodeId: 'late', picture: pic('desk', 35) }
      ],
      windowSize: 60
    });
    expect(wide.after.get('a1')?.map((p) => p.id)).toEqual(['harbour']);
    expect(wide.after.get('b1')?.map((p) => p.id)).toEqual(['desk']);

    const tail = placeChapterPictures({
      turns,
      episodeOrder: ['early', 'late'],
      pictures: [
        { episodeId: 'early', picture: pic('harbour', 15) },
        { episodeId: 'late', picture: pic('desk', 35) }
      ],
      windowSize: 2
    });
    expect(tail.after.get('a1')).toBeUndefined();
    expect(tail.after.get('b1')?.map((p) => p.id)).toEqual(['desk']);
  });

  it('shows a picture made before any line only while the chapter start is on the page', () => {
    const open = placeChapterPictures({
      turns,
      episodeOrder: ['early', 'late'],
      pictures: [{ episodeId: 'early', picture: pic('opening', 1) }],
      windowSize: 60
    });
    expect(open.leading.map((p) => p.id)).toEqual(['opening']);

    const scrolled = placeChapterPictures({
      turns,
      episodeOrder: ['early', 'late'],
      pictures: [{ episodeId: 'early', picture: pic('opening', 1) }],
      windowSize: 2
    });
    expect(scrolled.leading).toEqual([]);
    expect(scrolled.before.size).toBe(0);
  });
});
