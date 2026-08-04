import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export function isCloudConfigured(): boolean {
  return !!(url?.trim() && anon?.trim());
}

let client: SupabaseClient | null = null;

/** Lazy singleton — null when env is missing (local-only mode). */
export function getSupabase(): SupabaseClient | null {
  if (!isCloudConfigured()) return null;
  if (!client) {
    client = createClient(url!, anon!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: 'small-worlds-auth'
      }
    });
  }
  return client;
}
