import { create } from 'zustand';

interface PwaState {
  updateReady: boolean;
  offline: boolean;
  installable: boolean;
  standalone: boolean;
  applyUpdate: () => void;
  install: () => Promise<void>;
  dismissInstall: () => void;
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const INSTALL_DISMISSED = 'gcloud.install.dismissed';

let waiting: ServiceWorker | null = null;
let deferredPrompt: BeforeInstallPromptEvent | null = null;
let updateAccepted = false;

const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches ||
  window.matchMedia?.('(display-mode: window-controls-overlay)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

export const usePwa = create<PwaState>((set) => ({
  updateReady: false,
  offline: typeof navigator !== 'undefined' && !navigator.onLine,
  installable: false,
  standalone: typeof window !== 'undefined' && isStandalone(),

  applyUpdate: () => {
    if (!waiting) { window.location.reload(); return; }
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

const DISMISSAL_HOLDS_FOR = 30 * 24 * 60 * 60 * 1000;
function recentlyDismissed() {
  const at = Number(localStorage.getItem(INSTALL_DISMISSED) || 0);
  return at > 0 && Date.now() - at < DISMISSAL_HOLDS_FOR;
}

export function initPwa() {
  window.addEventListener('online', () => usePwa.setState({ offline: false }));
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

  const register = () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).then((reg) => {
      if (reg.waiting && navigator.serviceWorker.controller) {
        waiting = reg.waiting;
        usePwa.setState({ updateReady: true });
      }

      reg.addEventListener('updatefound', () => {
        const next = reg.installing;
        if (!next) return;
        next.addEventListener('statechange', () => {
          if (next.state === 'installed' && navigator.serviceWorker.controller) {
            waiting = next;
            usePwa.setState({ updateReady: true });
          }
        });
      });

      setInterval(() => { void reg.update(); }, 60 * 60 * 1000);
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
