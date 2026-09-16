import { create } from 'zustand';
import { BUILD_TAG } from '../lib/version';
import { releaseFor, type ReleaseNote } from '../lib/releaseNotes';

/** What `dist/version.json` holds. Written by the pwa plugin in vite.config.ts. */
export interface VersionManifest {
  version: string;
  revision: string;
  builtAt: string;
  release: ReleaseNote | null;
}

interface PwaState {
  updateReady: boolean;
  /** The version waiting to be loaded — what the Reload button is about to give you. */
  incoming: VersionManifest | null;
  /** Set once after a reload that changed the build tag, so we can say what changed. */
  whatsNew: ReleaseNote | null;
  offline: boolean;
  installable: boolean;
  standalone: boolean;
  applyUpdate: () => void;
  checkForUpdate: () => Promise<void>;
  dismissWhatsNew: () => void;
  install: () => Promise<void>;
  dismissInstall: () => void;
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const INSTALL_DISMISSED = 'gcloud.install.dismissed';
const SEEN_VERSION = 'gcloud.version.seen';
const VERSION_URL = '/version.json';

let waiting: ServiceWorker | null = null;
let registration: ServiceWorkerRegistration | null = null;
let deferredPrompt: BeforeInstallPromptEvent | null = null;
let updateAccepted = false;

/**
 * The manifest as it was when this tab loaded. Everything later is compared
 * against it: the running bundle cannot know its own revision (the revision is
 * a hash of the built output, computed after bundling), but the first answer
 * it gets is by definition the revision it is running.
 */
let baseline: VersionManifest | null = null;

const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches ||
  window.matchMedia?.('(display-mode: window-controls-overlay)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

const readStore = (key: string) => {
  try { return localStorage.getItem(key); } catch { return null; }
};
const writeStore = (key: string, value: string) => {
  try { localStorage.setItem(key, value); } catch { /* private mode, blocked storage */ }
};

async function fetchManifest(): Promise<VersionManifest | null> {
  try {
    const res = await fetch(`${VERSION_URL}?t=${Date.now()}`, { cache: 'no-store', credentials: 'omit' });
    if (!res.ok) return null;
    const body = await res.json() as VersionManifest;
    return body && typeof body.revision === 'string' ? body : null;
  } catch {
    // Offline, or a dev server with no built dist. Neither is an error here.
    return null;
  }
}

/**
 * Whether a plain reload would actually pick up the new build.
 *
 * With a service worker in charge, navigations are answered from the shell
 * cache, so a reload before the new worker has installed hands back the very
 * same app. Only offer the reload once the new worker is waiting — or when no
 * worker controls this page at all, where a reload goes to the network.
 */
const reloadWouldHelp = () =>
  Boolean(waiting) || !('serviceWorker' in navigator) || !navigator.serviceWorker.controller;

export const usePwa = create<PwaState>((set, get) => ({
  updateReady: false,
  incoming: null,
  whatsNew: null,
  offline: typeof navigator !== 'undefined' && !navigator.onLine,
  installable: false,
  standalone: typeof window !== 'undefined' && isStandalone(),

  applyUpdate: () => {
    if (!waiting) { window.location.reload(); return; }
    updateAccepted = true;
    waiting.postMessage({ type: 'SKIP_WAITING' });
    set({ updateReady: false });
  },

  /**
   * Asks the server what is deployed. A different revision means a deploy has
   * landed since this tab loaded; the new worker is nudged into installing so
   * that the reload we are about to offer actually lands on the new build.
   */
  checkForUpdate: async () => {
    const found = await fetchManifest();
    if (!found) return;
    if (!baseline) { baseline = found; return; }
    if (found.revision === baseline.revision) return;

    set({ incoming: found });
    if (registration) void registration.update().catch(() => {});
    if (reloadWouldHelp()) set({ updateReady: true });
  },

  dismissWhatsNew: () => {
    writeStore(SEEN_VERSION, BUILD_TAG);
    set({ whatsNew: null });
  },

  install: async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    deferredPrompt = null;
    set({ installable: false });
    if (outcome === 'dismissed') writeStore(INSTALL_DISMISSED, String(Date.now()));
  },

  dismissInstall: () => {
    writeStore(INSTALL_DISMISSED, String(Date.now()));
    set({ installable: false });
  },
}));

const DISMISSAL_HOLDS_FOR = 30 * 24 * 60 * 60 * 1000;
function recentlyDismissed() {
  const at = Number(readStore(INSTALL_DISMISSED) || 0);
  return at > 0 && Date.now() - at < DISMISSAL_HOLDS_FOR;
}

/** Fills in what the pending update contains, if the poll has not already. */
async function describeIncoming() {
  if (usePwa.getState().incoming) return;
  const found = await fetchManifest();
  if (found) usePwa.setState({ incoming: found });
}

/**
 * First run after a build tag changes: say what changed.
 *
 * Deliberately keyed on the tag rather than the revision, because a rebuild of
 * the same release has nothing worth announcing.
 */
function announceIfUpdated() {
  const seen = readStore(SEEN_VERSION);
  if (seen === BUILD_TAG) return;
  if (!seen) { writeStore(SEEN_VERSION, BUILD_TAG); return; }
  const note = releaseFor(BUILD_TAG);
  if (note) usePwa.setState({ whatsNew: note });
  else writeStore(SEEN_VERSION, BUILD_TAG);
}

const POLL_MS = 5 * 60 * 1000;

export function initPwa() {
  window.addEventListener('online', () => {
    usePwa.setState({ offline: false });
    void usePwa.getState().checkForUpdate();
  });
  window.addEventListener('offline', () => usePwa.setState({ offline: true }));

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    if (!recentlyDismissed()) usePwa.setState({ installable: true });
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    usePwa.setState({ installable: false, standalone: true });
  });

  const displayMode = window.matchMedia?.('(display-mode: standalone)');
  displayMode?.addEventListener('change', (e) => usePwa.setState({ standalone: e.matches }));

  announceIfUpdated();

  // The deploy poll runs whether or not a service worker is available, so an
  // installed PWA, a plain tab and a browser that refused to register the
  // worker all learn about a new version the same way.
  const check = () => { void usePwa.getState().checkForUpdate(); };
  check();
  setInterval(check, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });

  if (!('serviceWorker' in navigator)) return;

  if (import.meta.env.DEV) {
    void navigator.serviceWorker.getRegistrations().then((regs) => {
      for (const reg of regs) void reg.unregister();
    });
    void window.caches?.keys().then((keys) => {
      for (const key of keys) if (key.startsWith('gcloud-')) void window.caches.delete(key);
    });
    return;
  }

  const wasControlled = Boolean(navigator.serviceWorker.controller);
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !(wasControlled || updateAccepted)) return;
    reloading = true;
    window.location.reload();
  });

  const ready = (worker: ServiceWorker) => {
    waiting = worker;
    usePwa.setState({ updateReady: true });
    void describeIncoming();
  };

  const register = () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).then((reg) => {
      registration = reg;
      if (reg.waiting && navigator.serviceWorker.controller) ready(reg.waiting);

      reg.addEventListener('updatefound', () => {
        const next = reg.installing;
        if (!next) return;
        next.addEventListener('statechange', () => {
          if (next.state === 'installed' && navigator.serviceWorker.controller) ready(next);
        });
      });

      setInterval(() => { void reg.update(); }, 30 * 60 * 1000);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void reg.update();
      });
    }).catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  };

  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
