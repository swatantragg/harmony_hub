// Theme preference.
//
// Three settings, not two: light, dark, and "match my system". The third is the default,
// because most people have already made this decision once at the OS level and should not
// have to make it again here — but an explicit choice always wins and always persists.
//
// The resolved value is written to <html data-theme>, so CSS never has to reason about
// preference at all: there is exactly one selector for dark.
import { create } from 'zustand';

export type ThemePref = 'light' | 'dark' | 'system';
export type Resolved = 'light' | 'dark';

const KEY = 'harmonyhub.theme';

const query = () => window.matchMedia('(prefers-color-scheme: dark)');

export const systemTheme = (): Resolved => (query().matches ? 'dark' : 'light');

export function readPref(): ThemePref {
  const raw = localStorage.getItem(KEY);
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system';
}

export const resolve = (pref: ThemePref): Resolved => (pref === 'system' ? systemTheme() : pref);

function paint(resolved: Resolved) {
  document.documentElement.setAttribute('data-theme', resolved);
  // Keeps the browser chrome — address bar on mobile, form controls, scrollbars — in step
  // with the page rather than flashing white against a dark UI.
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

  // Light → dark → system → light. One control, every option, no menu.
  cycle: () => {
    const order: ThemePref[] = ['light', 'dark', 'system'];
    get().set(order[(order.indexOf(get().pref) + 1) % order.length]);
  },

  init: () => {
    const pref = readPref();
    const resolved = resolve(pref);
    paint(resolved);
    set({ pref, resolved });

    // While following the system, track it live — someone flipping their OS to dark at
    // dusk should see this follow without a reload.
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

// Applied before React mounts so the first paint is already the right colour — without
// this the page flashes light for a frame on a dark-theme reload.
export function applyStoredThemeEarly() {
  paint(resolve(readPref()));
}
