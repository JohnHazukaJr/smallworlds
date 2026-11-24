import type { Factor, Session, User } from '@supabase/supabase-js';
import { create } from 'zustand';
import { formatUserError } from '../errors';
import { getSupabase, isCloudConfigured } from './supabase';

export type AuthMethod = 'phone' | 'email' | 'google';

interface AuthState {
  configured: boolean;
  ready: boolean;
  session: Session | null;
  user: User | null;
  factors: Factor[];
  /** Signed in with a password/phone/Google but the account has an authenticator: the code is still owed. */
  mfaRequired: boolean;
  error: string;
  init: () => Promise<void>;
  /** Re-read whether this session still owes an authenticator code. */
  checkAssurance: () => Promise<void>;
  /** Finish a sign-in for an account with an authenticator. */
  verifyMfa: (code: string) => Promise<void>;
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

let authUnsubscribe: (() => void) | null = null;

export const useAuth = create<AuthState>()((set, get) => ({
  configured: isCloudConfigured(),
  ready: !isCloudConfigured(),
  session: null,
  user: null,
  factors: [],
  mfaRequired: false,
  error: '',

  init: async () => {
    const sb = getSupabase();
    if (!sb) {
      set({ configured: false, ready: true, session: null, user: null });
      return;
    }
    // One listener for the app's lifetime, even when init runs twice (React StrictMode).
    authUnsubscribe?.();
    const { data } = await sb.auth.getSession();
    set({
      configured: true,
      ready: true,
      session: data.session,
      user: data.session?.user ?? null
    });
    if (data.session) await Promise.all([get().refreshFactors(), get().checkAssurance()]);
    const { data: sub } = sb.auth.onAuthStateChange((_event, session) => {
      set({ session, user: session?.user ?? null });
      if (session) {
        void get().refreshFactors();
        void get().checkAssurance();
      } else {
        set({ factors: [], mfaRequired: false });
      }
    });
    authUnsubscribe = () => sub.subscription.unsubscribe();
  },

  checkAssurance: async () => {
    const sb = getSupabase();
    if (!sb) return;
    const { data, error } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error || !data) return;
    set({ mfaRequired: data.nextLevel === 'aal2' && data.currentLevel !== 'aal2' });
  },

  verifyMfa: async (code) => {
    const sb = getSupabase();
    if (!sb) throw new Error('Cloud sync is not configured.');
    const { data, error } = await sb.auth.mfa.listFactors();
    if (error) throw error;
    const factor = (data?.totp ?? []).find((f) => f.status === 'verified');
    if (!factor) throw new Error('No authenticator is set up on this account.');
    const { data: challenge, error: cErr } = await sb.auth.mfa.challenge({ factorId: factor.id });
    if (cErr || !challenge) throw cErr ?? new Error('MFA challenge failed.');
    const { error: vErr } = await sb.auth.mfa.verify({ factorId: factor.id, challengeId: challenge.id, code });
    if (vErr) throw vErr;
    await get().checkAssurance();
  },

  signInWithEmail: async (email, password) => {
    const sb = getSupabase();
    if (!sb) throw new Error('Cloud sync is not configured.');
    set({ error: '' });
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      set({ error: formatUserError(error) });
      throw error;
    }
  },

  signUpWithEmail: async (email, password) => {
    const sb = getSupabase();
    if (!sb) throw new Error('Cloud sync is not configured.');
    set({ error: '' });
    const { error } = await sb.auth.signUp({ email, password });
    if (error) {
      set({ error: formatUserError(error) });
      throw error;
    }
  },

  signInWithPhone: async (phone) => {
    const sb = getSupabase();
    if (!sb) throw new Error('Cloud sync is not configured.');
    set({ error: '' });
    const { error } = await sb.auth.signInWithOtp({ phone });
    if (error) {
      set({ error: formatUserError(error) });
      throw error;
    }
  },

  verifyPhoneOtp: async (phone, token) => {
    const sb = getSupabase();
    if (!sb) throw new Error('Cloud sync is not configured.');
    set({ error: '' });
    const { error } = await sb.auth.verifyOtp({ phone, token, type: 'sms' });
    if (error) {
      set({ error: formatUserError(error) });
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
      set({ error: formatUserError(error) });
      throw error;
    }
  },

  signOut: async () => {
    const sb = getSupabase();
    if (!sb) return;
    await sb.auth.signOut();
    set({ session: null, user: null, factors: [], mfaRequired: false });
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
    await Promise.all([get().refreshFactors(), get().checkAssurance()]);
  },

  unenrollFactor: async (factorId) => {
    const sb = getSupabase();
    if (!sb) return;
    const { error } = await sb.auth.mfa.unenroll({ factorId });
    if (error) {
      throw new Error(/aal2|assurance/i.test(error.message)
        ? 'Enter a code from your authenticator first (sign out and back in), then remove it.'
        : error.message);
    }
    await Promise.all([get().refreshFactors(), get().checkAssurance()]);
  }
}));
