import { wipeAllData } from '../db';
import { invokeFunction } from './functions';

/**
 * Deletes the Supabase user (stories, secrets, and billing cascade), then wipes this device.
 * Local-only erase stays on Settings and does not call this.
 */
export async function deleteCloudAccount(): Promise<void> {
  await invokeFunction('delete-account', {});
  await wipeAllData();
}
