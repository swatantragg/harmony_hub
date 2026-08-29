import { create } from 'zustand';
import {
  api, auth, clearDailyPasscodeFlag, needsDailyPasscode, resume,
  type OtpChallenge,
} from '../lib/api';
import type { User } from '../lib/types';

/** What a sign-in attempt produced: a session, or a passcode still to enter. */
export type SignInOutcome =
  | { kind: 'signed-in'; user: User }
  | { kind: 'passcode'; challenge: OtpChallenge };

interface SessionState {
  user: User | null;
  loading: boolean;
  /** Set when a session exists but today's passcode has not been entered yet. */
  passcodeDue: boolean;
  bootstrap: () => Promise<void>;
  login: (email: string, password: string) => Promise<SignInOutcome>;
  submitPasscode: (otpToken: string, code: string) => Promise<User>;
  setPassword: (currentPassword: string, newPassword: string) => Promise<void>;
  logout: () => Promise<void>;
  logoutEverywhere: () => Promise<void>;
  can: (permission: string) => boolean;
}
export const useSession = create<SessionState>((set, get) => ({
  user: null,
  loading: true,
  passcodeDue: false,

  bootstrap: async () => {
    const restored = await resume();
    if (!restored) {
      // A refused refresh means one of two things, and they need different
      // screens: the session is gone, or it is intact but a new day started.
      set({ user: null, loading: false, passcodeDue: needsDailyPasscode() });
      return;
    }
    try {
      const user = await api<User>('/me');
      set({ user, loading: false, passcodeDue: false });
    } catch {
      auth.clear();
      set({ user: null, loading: false });
    }
  },
  login: async (email, password) => {
    const res = await api<{
      accessToken?: string; user?: User; otpRequired?: boolean;
    } & Partial<OtpChallenge>>('/auth/login', {
      method: 'POST',
      body: { email, password },
    });

    if (res.otpRequired && res.otpToken) {
      return {
        kind: 'passcode',
        challenge: {
          otpToken: res.otpToken,
          expiresIn: res.expiresIn ?? 600,
          sentTo: res.sentTo ?? '',
          validUntil: res.validUntil,
          devCode: res.devCode,
        },
      };
    }

    auth.set(res.accessToken!);
    set({ user: res.user!, loading: false, passcodeDue: false });
    return { kind: 'signed-in', user: res.user! };
  },
  submitPasscode: async (otpToken, code) => {
    const res = await api<{ accessToken: string; user: User }>('/auth/otp', {
      method: 'POST',
      body: { otpToken, code },
    });
    auth.set(res.accessToken);
    clearDailyPasscodeFlag();
    set({ user: res.user, loading: false, passcodeDue: false });
    return res.user;
  },
  setPassword: async (currentPassword, newPassword) => {
    const res = await api<{ accessToken: string; user: User }>('/auth/password', {
      method: 'POST',
      body: { currentPassword, newPassword },
    });
    auth.set(res.accessToken);
    set({ user: res.user, loading: false });
  },
  logout: async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch {}
    auth.clear();
    clearDailyPasscodeFlag();
    set({ user: null, passcodeDue: false });
  },
  logoutEverywhere: async () => {
    try { await api('/auth/logout-all', { method: 'POST' }); } catch {}
    auth.clear();
    clearDailyPasscodeFlag();
    set({ user: null, passcodeDue: false });
  },
  can: (permission) => get().user?.permissions.includes(permission) ?? false,
}));

const TOUR_KEY = 'gcloud.tour.done';
const SEEN_KEY = 'gcloud.seen';
export const tour = {
  done: () => localStorage.getItem(TOUR_KEY) === '1',
  finish: () => localStorage.setItem(TOUR_KEY, '1'),
  reset: () => { localStorage.removeItem(TOUR_KEY); localStorage.removeItem(SEEN_KEY); },
};
export function useSeen(key: string): [boolean, () => void] {
  const read = (): string[] => {
    try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '[]'); } catch { return []; }
  };
  const seen = read().includes(key);
  const mark = () => {
    const next = [...new Set([...read(), key])];
    localStorage.setItem(SEEN_KEY, JSON.stringify(next));
  };
  return [seen, mark];
}