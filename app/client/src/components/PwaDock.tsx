import { Download, RefreshCw, Sparkles, WifiOff, X } from 'lucide-react';
import { usePwa } from '../app/pwa';
import { BUILD_TAG } from '../lib/version';

const MAX_HIGHLIGHTS = 5;

function Highlights({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="pwa-notes">
      {items.slice(0, MAX_HIGHLIGHTS).map((line) => <li key={line}>{line}</li>)}
      {items.length > MAX_HIGHLIGHTS && (
        <li className="muted">…and {items.length - MAX_HIGHLIGHTS} more.</li>
      )}
    </ul>
  );
}

export function PwaDock() {
  const {
    offline, updateReady, incoming, whatsNew, installable, standalone,
    applyUpdate, dismissWhatsNew, install, dismissInstall,
  } = usePwa();

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
    const release = incoming?.release ?? null;
    const version = release?.version ?? incoming?.version ?? null;
    return (
      <div className="pwa-dock" role="status" aria-live="polite">
        <div className="pwa-card wide">
          <RefreshCw size={17} style={{ color: 'var(--indigo)' }} />
          <div className="grow">
            <div className="pwa-title">
              A new version is ready{version ? <> · <span className="pwa-version">{version}</span></> : null}
            </div>
            <div className="pwa-body">
              {release?.headline
                ?? 'Reloading takes a second. Anything uploading will need starting again.'}
            </div>
            <Highlights items={release?.highlights ?? []} />
            <div className="pwa-body" style={{ marginTop: 8 }}>
              Reloading takes a second. Anything uploading will need starting again.
            </div>
          </div>
          <button className="btn btn-primary btn-sm" onClick={applyUpdate}>Reload</button>
        </div>
      </div>
    );
  }

  if (whatsNew) {
    return (
      <div className="pwa-dock" role="status" aria-live="polite">
        <div className="pwa-card wide">
          <Sparkles size={17} style={{ color: 'var(--indigo)' }} />
          <div className="grow">
            <div className="pwa-title">
              Updated to <span className="pwa-version">{whatsNew.version || BUILD_TAG}</span>
            </div>
            <div className="pwa-body">{whatsNew.headline}</div>
            <Highlights items={whatsNew.highlights} />
          </div>
          <button className="btn btn-primary btn-sm" onClick={dismissWhatsNew}>Got it</button>
        </div>
      </div>
    );
  }

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
