// Service worker registration, update flow, install prompt, and connectivity.
//
// Three things the shell needs to know about and none of them are React's business, so
// they live in one store the UI subscribes to.
//
//   updateReady   a newer build has finished installing and is parked in `waiting`. It
//                 takes over when the reader says so and not before — swapping the bundle
//                 out from under an upload in progress is how you lose a 40 GB master.
//   offline       the browser has lost the network. The shell is cached; the catalogue is
//                 not, and every screen in this product reads from /api, so this is worth
//                 saying out loud rather than letting queries fail one by one.
//   installable   the browser has offered an install prompt and we stashed it.
import { create } from 'zustand';

interface PwaState {
  updateReady: boolean;
  offline: boolean;
  installable: boolean;
  /** Standalone means launched from a home screen or a dock, not a browser tab. */
  standalone: boolean;
  applyUpdate: () => void;
  install: () => Promise<void>;
  dismissInstall: () => void;
}

// The event is not in lib.dom yet; this is the shape the spec defines.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const INSTALL_DISMISSED = 'gcloud.install.dismissed';

let waiting: ServiceWorker | null = null;
let deferredPrompt: BeforeInstallPromptEvent | null = null;
// Set when the reader accepts an update, so the controllerchange handler below knows the
// swap that follows was asked for. See the comment there for why that is not the only case.
let updateAccepted = false;

const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches ||
  window.matchMedia?.('(display-mode: window-controls-overlay)').matches ||
  // iOS never implemented display-mode and reports this instead.
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

export const usePwa = create<PwaState>((set) => ({
  updateReady: false,
  offline: typeof navigator !== 'undefined' && !navigator.onLine,
  installable: false,
  standalone: typeof window !== 'undefined' && isStandalone(),

  applyUpdate: () => {
    if (!waiting) { window.location.reload(); return; }
    // The page reloads on controllerchange, below — not here. Reloading before the new
    // worker has claimed the client just loads the old bundle again.
    updateAccepted = true;
    waiting.postMessage({ type: 'SKIP_WAITING' });
    set({ updateReady: false });
  },

  install: async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    deferredPrompt = null;
    set({ installable: false });
    if (outcome === 'dismissed') localStorage.setItem(INSTALL_DISMISSED, String(Date.now()));
  },

  dismissInstall: () => {
    localStorage.setItem(INSTALL_DISMISSED, String(Date.now()));
    set({ installable: false });
  },
}));

// Asked once a month at most. An install banner that reappears on every visit is an advert.
const DISMISSAL_HOLDS_FOR = 30 * 24 * 60 * 60 * 1000;
function recentlyDismissed() {
  const at = Number(localStorage.getItem(INSTALL_DISMISSED) || 0);
  return at > 0 && Date.now() - at < DISMISSAL_HOLDS_FOR;
}

/** Wired up once, from main.tsx, before React mounts. */
export function initPwa() {
  window.addEventListener('online', () => usePwa.setState({ offline: false }));
  window.addEventListener('offline', () => usePwa.setState({ offline: true }));

  window.addEventListener('beforeinstallprompt', (e) => {
    // Without this the browser shows its own mini-infobar and never fires again, so the
    // prompt cannot be raised from a button where it belongs.
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

  if (!('serviceWorker' in navigator)) return;

  // In development there is no sw.js to register, and a worker left behind by a production
  // build on the same origin — localhost, most often — would serve a stale bundle over the
  // top of Vite's. Clear it out instead.
  if (import.meta.env.DEV) {
    void navigator.serviceWorker.getRegistrations().then((regs) => {
      for (const reg of regs) void reg.unregister();
    });
    // window.caches, not a bare `caches`: an identifier that does not exist throws a
    // ReferenceError that `?.` cannot catch, while a missing property is just undefined.
    void window.caches?.keys().then((keys) => {
      for (const key of keys) if (key.startsWith('gcloud-')) void window.caches.delete(key);
    });
    return;
  }

  // One reload, and only when the swap that caused it means this document is now stale.
  //
  // `controllerchange` fires in three situations and they are not the same event:
  //
  //   · a first install, where the freshly activated worker claims a page that until then
  //     had no controller. Nothing has been replaced — reloading here would bounce every
  //     reader on their very first visit, for nothing. This is the case to ignore.
  //   · the reader accepted the update prompt. Asked for, and the point of the exercise.
  //   · another tab accepted it, and this tab's controller changed underneath it. The
  //     document is now running a bundle the worker no longer serves, so it reloads too.
  //
  // The first is told apart by whether a controller existed when the page loaded; the
  // third by nothing, which is why the second sets a flag rather than relying on one.
  const wasControlled = Boolean(navigator.serviceWorker.controller);
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !(wasControlled || updateAccepted)) return;
    reloading = true;
    window.location.reload();
  });

  // Registration waits for `load` so it never competes with the first paint for bandwidth.
  // The readyState check is what makes that safe to say: this module runs before `load`
  // today, but an already-fired event never fires again, and the failure would be a
  // service worker that silently never registers.
  const register = () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).then((reg) => {
      // Already parked from a previous visit.
      if (reg.waiting && navigator.serviceWorker.controller) {
        waiting = reg.waiting;
        usePwa.setState({ updateReady: true });
      }

      reg.addEventListener('updatefound', () => {
        const next = reg.installing;
        if (!next) return;
        next.addEventListener('statechange', () => {
          // `installed` with a controller already present means this is an update rather
          // than a first install — the first install has nothing to interrupt and should
          // say nothing.
          if (next.state === 'installed' && navigator.serviceWorker.controller) {
            waiting = next;
            usePwa.setState({ updateReady: true });
          }
        });
      });

      // A tab left open for a week should still notice a deploy. The browser also checks on
      // navigation, which for a hash-routed app happens exactly once.
      setInterval(() => { void reg.update(); }, 60 * 60 * 1000);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void reg.update();
      });
    }).catch((err) => {
      // A failed registration costs the offline shell and nothing else — the app runs.
      console.warn('Service worker registration failed:', err);
    });
  };

  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
