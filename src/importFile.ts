/** World ids carried by a world export, a worlds backup, or a device bundle. */
export function worldIdsInImport(data: unknown): string[] {
  if (!data || typeof data !== 'object') return [];
  const rec = data as {
    format?: string;
    world?: { id?: string };
    worlds?: Array<{ world?: { id?: string } }>;
  };
  if (rec.format === 'small-worlds-world') return rec.world?.id ? [rec.world.id] : [];
  if (rec.format === 'small-worlds-backup' || rec.format === 'small-worlds-device') {
    return (rec.worlds ?? []).map((w) => w.world?.id).filter((id): id is string => !!id);
  }
  return [];
}

/** Prompt shown before an import overwrites worlds already on this device. Null when nothing collides. */
export function replaceImportMessage(titles: string[]): string | null {
  if (titles.length === 0) return null;
  if (titles.length === 1) {
    return `Replace "${titles[0]}"?\n\nThe copy already on this device will be overwritten.`;
  }
  return `Replace these worlds already on this device?\n\n${titles.join('\n')}`;
}
