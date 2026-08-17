// The three things an installed app has to say for itself, docked at the bottom of the
// screen where a phone's thumb already is.
//
// Only one is ever shown at a time, in the order they matter: losing the network changes
// what the reader can trust on screen right now; a pending update matters next; an install
// offer is the least urgent thing in the product and behaves like it.
import { Download, RefreshCw, WifiOff, X } from 'lucide-react';
import { usePwa } from '../app/pwa';

export function PwaDock() {
  const { offline, updateReady, installable, standalone, applyUpdate, install, dismissInstall } = usePwa();

  if (offline) {
    return (
      <div className="pwa-dock" role="status" aria-live="polite">
        <div className="pwa-card offline">
          <WifiOff size={17} />
          <div className="grow">
            <div className="pwa-title">You are offline</div>
            <div className="pwa-body">
              GCloud is still open, but the library lives on the server — nothing will load
              or upload until the connection is back.
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (updateReady) {
    return (
      <div className="pwa-dock" role="status" aria-live="polite">
        <div className="pwa-card">
          <RefreshCw size={17} style={{ color: 'var(--indigo)' }} />
          <div className="grow">
            <div className="pwa-title">A new version is ready</div>
            <div className="pwa-body">Reloading takes a second. Anything uploading will need starting again.</div>
          </div>
          <button className="btn btn-primary btn-sm" onClick={applyUpdate}>Reload</button>
        </div>
      </div>
    );
  }

  // Nothing to offer once it is already installed, and nothing to offer on a browser that
  // never fired the prompt event — Safari among them, which installs from the share sheet.
  if (!installable || standalone) return null;

  return (
    <div className="pwa-dock">
      <div className="pwa-card">
        <Download size={17} style={{ color: 'var(--indigo)' }} />
        <div className="grow">
          <div className="pwa-title">Install GCloud</div>
          <div className="pwa-body">Opens full screen from your home screen, and starts faster.</div>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => void install()}>Install</button>
        <button className="btn btn-ghost btn-icon" onClick={dismissInstall} aria-label="Not now">
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
