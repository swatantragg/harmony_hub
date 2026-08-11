import { create } from 'zustand';
import { api, auth } from '../lib/api';
import type { User } from '../lib/types';

interface SessionState {
  user: User | null;
  loading: boolean;
  bootstrap: () => Promise<void>;
  login: (email: string, password: string) => Promise<User>;
  /** Replaces the password on the signed-in account and clears the first-run gate. */
  setPassword: (currentPassword: string, newPassword: string) => Promise<void>;
  logout: () => Promise<void>;
  can: (permission: string) => boolean;
}

export const useSession = create<SessionState>((set, get) => ({
  user: null,
  loading: true,

  bootstrap: async () => {
    if (!auth.get()) { set({ user: null, loading: false }); return; }
    try {
      const user = await api<User>('/me');
      set({ user, loading: false });
    } catch {
      auth.clear();
      set({ user: null, loading: false });
    }
  },

  login: async (email, password) => {
    const res = await api<{ accessToken: string; user: User }>('/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    auth.set(res.accessToken);
    set({ user: res.user, loading: false });
    // Handed back so the caller can route straight to the set-a-password screen without
    // waiting for a re-render to tell it what just happened.
    return res.user;
  },

  // The server issues a fresh token here, because the one in hand was minted for an
  // account that had not yet cleared the gate.
  setPassword: async (currentPassword, newPassword) => {
    const res = await api<{ accessToken: string; user: User }>('/auth/password', {
      method: 'POST',
      body: { currentPassword, newPassword },
    });
    auth.set(res.accessToken);
    set({ user: res.user, loading: false });
  },

  logout: async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* best effort */ }
    auth.clear();
    set({ user: null });
  },

  can: (permission) => get().user?.permissions.includes(permission) ?? false,
}));

// ── First-run guidance ──────────────────────────────────────────────────────
// The product tracks what a new user has already been shown so the tour, the tips and
// the "what is this screen for" banners fade away on their own rather than nagging.
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
