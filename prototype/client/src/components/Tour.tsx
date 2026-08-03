// First-run tour. Five cards, skippable, never shown twice. It exists to compress the
// learning curve: the goal is that someone who has never seen GCloud can find a file,
// prove it is really in storage, rename it and share it inside their first session.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, ArrowRight } from 'lucide-react';
import { tour } from '../app/session';
import { Tile } from './ui';

const STEPS = [
  {
    anchor: '[data-tour="search"]',
    title: 'Start by searching',
    body: 'One box searches every file, song and artist. Results are individual files — not folders — so “punjabi reels tagged viral” lands you on exactly those clips.',
  },
  {
    anchor: '[data-tour="health"]',
    title: 'The badge tells the truth',
    body: 'Every file carries a status showing whether it is genuinely in storage right now. Green means verified. Anything else tells you what to do next, in plain words.',
  },
  {
    anchor: '[data-tour="nav"]',
    title: 'Everything lives in the sidebar',
    body: 'Artists hold songs, songs hold files. You can also press ⌘K anywhere to jump straight to a screen or a file without touching the mouse.',
  },
  {
    anchor: '[data-tour="upload"]',
    title: 'Uploading is a three-step form',
    body: 'Drop a file, tell GCloud what it is, add tags. Large files upload in parallel chunks and can be paused and resumed — nothing restarts from zero.',
  },
  {
    anchor: '[data-tour="help"]',
    title: 'Help is always one click away',
    body: 'Every screen explains itself. The “How GCloud works” page walks through the whole product in five minutes, and you can replay this tour from there any time.',
  },
];

export function Tour({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [box, setBox] = useState<DOMRect | null>(null);
  const current = STEPS[step];

  useEffect(() => {
    const el = document.querySelector(current.anchor);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setTimeout(() => setBox(el.getBoundingClientRect()), 240);
    } else {
      setBox(null);
    }
  }, [step, current.anchor]);

  const finish = () => { tour.finish(); onDone(); };

  // Position the card near its anchor, clamped to the viewport.
  const style: React.CSSProperties = box
    ? {
        top: Math.min(window.innerHeight - 250, box.bottom + 14),
        left: Math.max(16, Math.min(window.innerWidth - 360, box.left)),
      }
    : { top: '50%', left: '50%', transform: 'translate(-50%,-50%)' };

  return createPortal(
    <>
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(23,23,35,.42)', zIndex: 290 }} onClick={finish} />
      {box && (
        <div
          style={{
            position: 'fixed', zIndex: 295, pointerEvents: 'none',
            top: box.top - 6, left: box.left - 6, width: box.width + 12, height: box.height + 12,
            border: '2px solid var(--spark)', borderRadius: 14,
            boxShadow: '0 0 0 9999px rgba(23,23,35,.42)', background: 'transparent',
          }}
        />
      )}
      <div className="tour-card" style={style} role="dialog" aria-label={current.title}>
        <div className="spread" style={{ marginBottom: 12 }}>
          <div className="row-tight"><Tile size="sm" /><span className="eyebrow">Step {step + 1} of {STEPS.length}</span></div>
          <button className="btn btn-ghost btn-icon" onClick={finish} aria-label="Skip the tour"><X size={15} /></button>
        </div>
        <h3 className="t-h2" style={{ marginBottom: 7 }}>{current.title}</h3>
        <p className="t-body" style={{ fontSize: 13.5, margin: 0 }}>{current.body}</p>
        <div className="spread" style={{ marginTop: 18 }}>
          <div className="tour-dots">
            {STEPS.map((_, i) => <i key={i} className={i === step ? 'on' : ''} />)}
          </div>
          <div className="row-tight">
            <button className="btn btn-ghost btn-sm" onClick={finish}>Skip</button>
            {step < STEPS.length - 1 ? (
              <button className="btn btn-primary btn-sm" onClick={() => setStep((s) => s + 1)}>
                Next <ArrowRight size={13} />
              </button>
            ) : (
              <button className="btn btn-primary btn-sm" onClick={finish}>Start using GCloud</button>
            )}
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
