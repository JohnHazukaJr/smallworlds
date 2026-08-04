import type { Factor, Session, User } from '@supabase/supabase-js';
import { create } from 'zustand';
import { getSupabase, isCloudConfigured } from './supabase';

export type AuthMethod = 'phone' | 'email' | 'google';

interface AuthState {
  configured: boolean;
  ready: boolean;
  session: Session | null;
  user: User | null;
  factors: Factor[];
  error: string;
  init: () => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  signUpWithEmail: (email: string, password: string) => Promise<void>;
  signInWithPhone: (phone: string) => Promise<void>;
  verifyPhoneOtp: (phone: string, token: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  refreshFactors: () => Promise<void>;
  enrollTotp: () => Promise<{ qr: string; secret: string; factorId: string }>;
  challengeTotp: (factorId: string, code: string) => Promise<void>;
  unenrollFactor: (factorId: string) => Promise<void>;
}

export const useAuth = create<AuthState>()((set, get) => ({
  configured: isCloudConfigured(),
  ready: !isCloudConfigured(),
  session: null,
  user: null,
  factors: [],
  error: '',

  init: async () => {
    const sb = getSupabase();
    if (!sb) {
      set({ configured: false, ready: true, session: null, user: null });
      return;
    }
    const { data } = await sb.auth.getSession();
    set({
      configured: true,
      ready: true,
      session: data.session,
      user: data.session?.user ?? null
    });
    if (data.session) await get().refreshFactors();
    sb.auth.onAuthStateChange((_event, session) => {
      set({ session, user: session?.user ?? null });
      if (session) void get().refreshFactors();
      else set({ factors: [] });
    });
  },

  signInWithEmail: async (email, password) => {
    const sb = getSupabase();
    if (!sb) throw new Error('Cloud sync is not configured.');
    set({ error: '' });
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      set({ error: error.message });
      throw error;
    }
  },

  signUpWithEmail: async (email, password) => {
    const sb = getSupabase();
    if (!sb) throw new Error('Cloud sync is not configured.');
    set({ error: '' });
    const { error } = await sb.auth.signUp({ email, password });
    if (error) {
      set({ error: error.message });
      throw error;
    }
  },

  signInWithPhone: async (phone) => {
    const sb = getSupabase();
    if (!sb) throw new Error('Cloud sync is not configured.');
    set({ error: '' });
    const { error } = await sb.auth.signInWithOtp({ phone });
    if (error) {
      set({ error: error.message });
      throw error;
    }
  },

  verifyPhoneOtp: async (phone, token) => {
    const sb = getSupabase();
    if (!sb) throw new Error('Cloud sync is not configured.');
    set({ error: '' });
    const { error } = await sb.auth.verifyOtp({ phone, token, type: 'sms' });
    if (error) {
      set({ error: error.message });
      throw error;
    }
  },

  signInWithGoogle: async () => {
    const sb = getSupabase();
    if (!sb) throw new Error('Cloud sync is not configured.');
    set({ error: '' });
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin }
    });
    if (error) {
      set({ error: error.message });
      throw error;
    }
  },

  signOut: async () => {
    const sb = getSupabase();
    if (!sb) return;
    await sb.auth.signOut();
    set({ session: null, user: null, factors: [] });
  },

  refreshFactors: async () => {
    const sb = getSupabase();
    if (!sb) return;
    const { data, error } = await sb.auth.mfa.listFactors();
    if (error) return;
    set({ factors: data?.totp ?? [] });
  },

  enrollTotp: async () => {
    const sb = getSupabase();
    if (!sb) throw new Error('Cloud sync is not configured.');
    const { data, error } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Small Worlds' });
    if (error || !data) throw error ?? new Error('Could not start MFA enrollment.');
    return {
      qr: data.totp.qr_code,
      secret: data.totp.secret,
      factorId: data.id
    };
  },

  challengeTotp: async (factorId, code) => {
    const sb = getSupabase();
    if (!sb) throw new Error('Cloud sync is not configured.');
    const { data: challenge, error: cErr } = await sb.auth.mfa.challenge({ factorId });
    if (cErr || !challenge) throw cErr ?? new Error('MFA challenge failed.');
    const { error } = await sb.auth.mfa.verify({ factorId, challengeId: challenge.id, code });
    if (error) throw error;
    await get().refreshFactors();
  },

  unenrollFactor: async (factorId) => {
    const sb = getSupabase();
    if (!sb) return;
    await sb.auth.mfa.unenroll({ factorId });
    await get().refreshFactors();
  }
}));
