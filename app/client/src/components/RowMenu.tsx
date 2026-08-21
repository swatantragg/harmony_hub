// The "…" menu that hangs off a row — a folder in the folder list, a file in any file
// list. One component, because a folder and a file offer nearly the same four things and
// they must not drift into looking like two different mechanisms.
//
// It renders into a portal at fixed coordinates rather than inside the row. A row lives in
// an `overflow: hidden` panel and, for files, in a `table-scroll` container that clips
// horizontally — an absolutely-positioned menu inside either is cut in half. Fixed
// positioning off the button's own rect is the only placement that survives both.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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

const MENU_WIDTH = 226;
const GAP = 6;
const EDGE = 8;

export function RowMenu({ actions, label = 'More actions' }: { actions: RowAction[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const shown = actions.filter((a) => !a.hidden);

  // Placement runs against the menu's real box, which only exists once it is in the DOM.
  // So the menu is mounted first — hidden, at the origin — and this measures it before
  // paint. Estimating the height instead put a menu near the bottom of the window in the
  // wrong place, because the estimate and the rendered height disagree the moment an
  // entry wraps onto a second line.
  const place = useCallback(() => {
    const anchor = btn.current;
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const height = menu.current?.offsetHeight || shown.length * 42 + 12;
    const width = menu.current?.offsetWidth || MENU_WIDTH;
    const below = window.innerHeight - r.bottom;
    const flip = below < height + GAP + EDGE && r.top > below;
    setPos({
      top: flip
        ? Math.max(EDGE, r.top - height - GAP)
        : Math.min(r.bottom + GAP, Math.max(EDGE, window.innerHeight - height - EDGE)),
      left: Math.max(EDGE, Math.min(window.innerWidth - width - EDGE, r.right - width)),
    });
  }, [shown.length]);

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;

    // Only a click that lands *outside* both the menu and its trigger closes it.
    //
    // This used to close on any mousedown anywhere, in the capture phase, on `document`.
    // That fires before the event has even reached the menu — so pressing an entry
    // unmounted it, the `click` that would have run the entry's handler was never
    // dispatched, and every verb behind the dots (share, move, rename, edit, delete) did
    // nothing at all. Stopping propagation on the menu could not save it: a capture
    // listener on `document` has already run by then.
    const onPointerDown = (e: Event) => {
      const t = e.target as Node | null;
      if (t && (menu.current?.contains(t) || btn.current?.contains(t))) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // The menu is opened from inside dialogs that also close on Escape. Whichever is on
      // top should be the one that closes, so this one stops here.
      e.stopPropagation();
      setOpen(false);
      btn.current?.focus();
    };
    // A menu pinned to a coordinate is wrong the moment anything moves under it — but the
    // menu scrolling inside itself is not the page moving.
    const onScroll = (e: Event) => {
      const t = e.target as Node | null;
      if (t && menu.current?.contains(t)) return;
      setOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('touchstart', onPointerDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('touchstart', onPointerDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', place);
    };
  }, [open, place]);

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

      {open && createPortal(
        <div
          ref={menu}
          className="panel row-menu"
          role="menu"
          // Mounted before it is placed, so `place` has a real box to measure. Hidden
          // rather than unmounted for that one frame — it is measured in a layout effect,
          // so the reader never sees the origin position.
          style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          {shown.map((a, i) => (
            <button
              key={a.label}
              type="button"
              role="menuitem"
              className={`row-menu-item ${a.danger ? 'danger' : ''} ${i > 0 && a.danger && !shown[i - 1].danger ? 'separated' : ''}`}
              disabled={a.disabled}
              title={a.disabled ? a.disabledReason : undefined}
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                setOpen(false);
                a.onSelect();
              }}
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
