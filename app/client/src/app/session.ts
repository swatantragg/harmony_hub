import { create } from 'zustand';
import { api, auth, resume } from '../lib/api';
import type { User } from '../lib/types';

interface SessionState {
  user: User | null;
  loading: boolean;
  bootstrap: () => Promise<void>;
  login: (email: string, password: string) => Promise<User>;
  setPassword: (currentPassword: string, newPassword: string) => Promise<void>;
  logout: () => Promise<void>;
  logoutEverywhere: () => Promise<void>;
  can: (permission: string) => boolean;
}
export const useSession = create<SessionState>((set, get) => ({
  user: null,
  loading: true,

  bootstrap: async () => {
    const restored = await resume();
    if (!restored) { set({ user: null, loading: false }); return; }
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
    set({ user: null });
  },
  logoutEverywhere: async () => {
    try { await api('/auth/logout-all', { method: 'POST' }); } catch {}
    auth.clear();
    set({ user: null });
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