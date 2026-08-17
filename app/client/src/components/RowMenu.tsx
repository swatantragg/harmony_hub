// The "…" menu that hangs off a row — a folder in the folder list, a file in any file
// list. One component, because a folder and a file offer nearly the same four things and
// they must not drift into looking like two different mechanisms.
//
// It renders into a portal at fixed coordinates rather than inside the row. A row lives in
// an `overflow: hidden` panel and, for files, in a `table-scroll` container that clips
// horizontally — an absolutely-positioned menu inside either is cut in half. Fixed
// positioning off the button's own rect is the only placement that survives both.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MoreVertical } from 'lucide-react';

export interface RowAction {
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  /** Renders in danger red and sits under a separator. */
  danger?: boolean;
  /** Hidden entirely — a permission the reader does not hold. */
  hidden?: boolean;
  disabled?: boolean;
  disabledReason?: string;
}

export function RowMenu({ actions, label = 'More actions' }: { actions: RowAction[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const shown = actions.filter((a) => !a.hidden);

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const width = 226;
    // Measured after paint so a menu near the bottom of the window flips above its button
    // rather than running off the fold.
    const height = menu.current?.offsetHeight ?? shown.length * 42 + 12;
    const below = window.innerHeight - r.bottom;
    setPos({
      top: below < height + 12 ? Math.max(8, r.top - height - 6) : r.bottom + 6,
      left: Math.max(8, Math.min(window.innerWidth - width - 8, r.right - width)),
    });
  }, [open, shown.length]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    // `true` — capture phase, so a click anywhere closes this before the row underneath
    // gets a chance to treat it as "open me".
    document.addEventListener('mousedown', close, true);
    window.addEventListener('keydown', onKey);
    // A menu pinned to a coordinate is wrong the moment anything moves under it.
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', close, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  if (shown.length === 0) return null;

  return (
    <>
      <button
        ref={btn}
        type="button"
        className="btn btn-ghost btn-icon row-menu-trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        // The row itself is a button or a link. Without this, opening the menu also opens
        // the folder underneath it.
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); setOpen((v) => !v); }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <MoreVertical size={17} />
      </button>

      {open && pos && createPortal(
        <div
          ref={menu}
          className="panel row-menu"
          role="menu"
          style={{ top: pos.top, left: pos.left }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {shown.map((a, i) => (
            <button
              key={a.label}
              type="button"
              role="menuitem"
              className={`row-menu-item ${a.danger ? 'danger' : ''} ${i > 0 && a.danger && !shown[i - 1].danger ? 'separated' : ''}`}
              disabled={a.disabled}
              title={a.disabled ? a.disabledReason : undefined}
              onClick={(e) => { e.stopPropagation(); setOpen(false); a.onSelect(); }}
            >
              {a.icon}
              {a.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
