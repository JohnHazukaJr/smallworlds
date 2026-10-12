/** A debounced put must not resurrect a row the user just removed. */
export function shouldFlushAutosave(
  id: string,
  removedIds: ReadonlySet<string>,
  rowStillExists: boolean
): boolean {
  return rowStillExists && !removedIds.has(id);
}
