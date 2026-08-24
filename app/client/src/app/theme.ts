import { create } from 'zustand';

export type ThemePref = 'light' | 'dark' | 'system';
export type Resolved = 'light' | 'dark';

const KEY = 'gcloud.theme';

const query = () => window.matchMedia('(prefers-color-scheme: dark)');

export const systemTheme = (): Resolved => (query().matches ? 'dark' : 'light');

export function readPref(): ThemePref {
  const raw = localStorage.getItem(KEY);
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system';
}

export const resolve = (pref: ThemePref): Resolved => (pref === 'system' ? systemTheme() : pref);

function paint(resolved: Resolved) {
  document.documentElement.setAttribute('data-theme', resolved);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', resolved === 'dark' ? '#0C0B10' : '#5546E8');
}

interface ThemeState {
  pref: ThemePref;
  resolved: Resolved;
  set: (pref: ThemePref) => void;
  cycle: () => void;
  init: () => () => void;
}

export const useTheme = create<ThemeState>((set, get) => ({
  pref: 'system',
  resolved: 'light',

  set: (pref) => {
    localStorage.setItem(KEY, pref);
    const resolved = resolve(pref);
    paint(resolved);
    set({ pref, resolved });
  },

  cycle: () => {
    const order: ThemePref[] = ['light', 'dark', 'system'];
    get().set(order[(order.indexOf(get().pref) + 1) % order.length]);
  },

  init: () => {
    const pref = readPref();
    const resolved = resolve(pref);
    paint(resolved);
    set({ pref, resolved });

    const mq = query();
    const onChange = () => {
      if (get().pref !== 'system') return;
      const next = systemTheme();
      paint(next);
      set({ resolved: next });
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  },
}));

export function applyStoredThemeEarly() {
  paint(resolve(readPref()));
}
