/** Refuse imports before JSON.parse. */
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

export function importTooLarge(file: File): boolean {
  return file.size > MAX_IMPORT_BYTES;
}

export const IMPORT_TOO_LARGE = 'That file is over 20 MB. Imports are limited to 20 MB.';
