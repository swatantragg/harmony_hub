import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MoreVertical } from 'lucide-react';

export interface RowAction {
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  danger?: boolean;
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

    const onPointerDown = (e: Event) => {
      const t = e.target as Node | null;
      if (t && (menu.current?.contains(t) || btn.current?.contains(t))) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      btn.current?.focus();
    };
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
