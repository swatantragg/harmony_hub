// The dropdown, in the app's own clothes.
//
// Every one of these used to be a native <select>. A native select paints its own popup —
// the operating system does, in fact, and no stylesheet reaches inside it. On the dark
// theme that meant a grey OS list with a blue highlight and square corners appearing over
// a product whose every other surface is a rounded panel with an indigo accent. It also
// meant no room for what these lists actually want to say: a count beside a facet, a
// second line under an option, a group header that is not just bold text.
//
// So the popup is ours: a portalled panel positioned off the trigger's own rect, the same
// technique the row menu uses and for the same reason — these live inside `overflow:hidden`
// panels, modals and horizontally scrolling toolbars, and an absolutely-positioned list
// inside any of those is clipped.
//
// The trigger keeps the `.select` class, so a closed dropdown is pixel-identical to what it
// replaced and nothing on any screen shifts.
//
// What a native select gives away for free, and is therefore reimplemented here rather
// than skipped: type-ahead, Home/End, arrow keys moving a cursor that is not yet a
// selection, Escape restoring, and the selected row being scrolled into view on open.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
  /** A second line under the label — a count, a path, a reason. */
  hint?: ReactNode;
  /** Right-aligned, quiet. For counts, which read badly inside the label. */
  meta?: ReactNode;
  disabled?: boolean;
  /** Options carrying the same group render under one header, in first-seen order. */
  group?: string;
}

const GAP = 6;
const EDGE = 8;
const MIN_WIDTH = 180;

/**
 * Positions a portalled popup against the control it hangs off, and closes it on a press
 * outside, a scroll of the page, or Escape.
 *
 * Shared by this and the language combobox, because "a list under a field" has exactly one
 * correct set of behaviours and two copies of it drift apart on the first bug fix.
 *
 * The popup is placed against its own measured box, not an estimate, so it is mounted
 * hidden for one frame and positioned in a layout effect — before paint, so nothing is
 * seen at the origin.
 */
export function useAnchored(
  open: boolean,
  close: () => void,
  anchor: React.RefObject<HTMLElement | null>,
  popup: React.RefObject<HTMLElement | null>,
) {
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const place = useCallback(() => {
    const el = anchor.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const height = popup.current?.offsetHeight || 240;
    // As wide as the control it hangs off, so the list does not jump out from under a
    // narrow toolbar dropdown — but never so narrow that the labels wrap.
    const width = Math.max(MIN_WIDTH, Math.min(r.width, window.innerWidth - EDGE * 2));
    const below = window.innerHeight - r.bottom;
    const flip = below < height + GAP + EDGE && r.top > below;
    setPos({
      top: flip
        ? Math.max(EDGE, r.top - height - GAP)
        : Math.min(r.bottom + GAP, Math.max(EDGE, window.innerHeight - height - EDGE)),
      left: Math.max(EDGE, Math.min(window.innerWidth - width - EDGE, r.left)),
      width,
    });
  }, [anchor, popup]);

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    // Only a press that lands outside both the list and its control closes it. A blanket
    // capture-phase listener would fire before the press reached an option and unmount the
    // row before its click could run — the row menu shipped exactly that bug once.
    const onPointerDown = (e: Event) => {
      const t = e.target as Node | null;
      if (t && (popup.current?.contains(t) || anchor.current?.contains(t))) return;
      close();
    };
    // A list pinned to a coordinate is wrong the moment the page moves under it — but the
    // list scrolling inside itself is not the page moving.
    const onScroll = (e: Event) => {
      const t = e.target as Node | null;
      if (t && popup.current?.contains(t)) return;
      close();
    };
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('touchstart', onPointerDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('touchstart', onPointerDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', place);
    };
  }, [open, place, close, anchor, popup]);

  return pos;
}

export function Select({
  value, onChange, options, placeholder = 'Choose…', ariaLabel, id, style, className = '',
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  ariaLabel?: string;
  id?: string;
  style?: CSSProperties;
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Where the keyboard cursor is, which is not the same as what is selected — moving it
  // with the arrows must not commit anything until Enter.
  const [active, setActive] = useState(-1);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const typed = useRef({ buffer: '', at: 0 });
  const pos = useAnchored(open, useCallback(() => setOpen(false), []), btn, menu);

  const selected = options.find((o) => o.value === value) ?? null;
  const pickable = useMemo(
    () => options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0),
    [options],
  );

  // Opening lands the cursor on what is already chosen and scrolls it into view, so a
  // list of two hundred artists does not open at the top with the current one off-screen.
  useEffect(() => {
    if (!open) return;
    const start = options.findIndex((o) => o.value === value && !o.disabled);
    setActive(start >= 0 ? start : (pickable[0] ?? -1));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open || active < 0) return;
    menu.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const commit = (option: SelectOption) => {
    if (option.disabled) return;
    setOpen(false);
    btn.current?.focus();
    if (option.value !== value) onChange(option.value);
  };

  const step = (delta: number) => {
    if (pickable.length === 0) return;
    const at = pickable.indexOf(active);
    const next = at === -1
      ? pickable[delta > 0 ? 0 : pickable.length - 1]
      : pickable[Math.min(pickable.length - 1, Math.max(0, at + delta))];
    setActive(next);
  };

  // Typing jumps to the next option starting with what was typed — the one affordance of a
  // native select people reach for without knowing they are doing it.
  const typeAhead = (key: string) => {
    const now = Date.now();
    typed.current.buffer = now - typed.current.at > 600 ? key : typed.current.buffer + key;
    typed.current.at = now;
    const needle = typed.current.buffer.toLowerCase();
    // Search from just after the cursor, so pressing the same letter walks the matches.
    const order = [...pickable.slice(pickable.indexOf(active) + 1), ...pickable];
    const hit = order.find((i) => options[i].label.toLowerCase().startsWith(needle));
    if (hit !== undefined) setActive(hit);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); setOpen(true); }
      return;
    }
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); step(1); break;
      case 'ArrowUp': e.preventDefault(); step(-1); break;
      case 'Home': e.preventDefault(); setActive(pickable[0] ?? -1); break;
      case 'End': e.preventDefault(); setActive(pickable[pickable.length - 1] ?? -1); break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (options[active]) commit(options[active]);
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        btn.current?.focus();
        break;
      case 'Tab': setOpen(false); break;
      default:
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); typeAhead(e.key); }
    }
  };

  const listId = id ? `${id}-list` : undefined;
  let lastGroup: string | undefined;

  return (
    <>
      <button
        ref={btn}
        id={id}
        type="button"
        className={`select select-trigger ${selected ? '' : 'placeholder'} ${className}`}
        style={style}
        disabled={disabled}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); setOpen((v) => !v); }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <span className="select-value">{selected ? selected.label : placeholder}</span>
      </button>

      {open && createPortal(
        <div
          ref={menu}
          id={listId}
          className="panel select-menu"
          role="listbox"
          aria-label={ariaLabel}
          aria-activedescendant={active >= 0 && id ? `${id}-opt-${active}` : undefined}
          // Mounted before it is placed so `place` has a real box to measure; hidden for
          // that one frame, which a layout effect resolves before the reader sees it.
          style={{
            top: pos?.top ?? 0,
            left: pos?.left ?? 0,
            width: pos?.width,
            visibility: pos ? 'visible' : 'hidden',
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          {options.length === 0 && <div className="select-empty">Nothing to choose from</div>}
          {options.map((o, i) => {
            const header = o.group && o.group !== lastGroup ? o.group : null;
            lastGroup = o.group;
            return (
              <div key={`${o.value}-${i}`}>
                {header && <div className="select-group">{header}</div>}
                <button
                  type="button"
                  id={id ? `${id}-opt-${i}` : undefined}
                  data-index={i}
                  role="option"
                  aria-selected={o.value === value}
                  disabled={o.disabled}
                  className={`select-option ${o.value === value ? 'on' : ''} ${i === active ? 'active' : ''}`}
                  // Hovering moves the cursor too, so the mouse and the keyboard never
                  // disagree about which row is next.
                  onMouseEnter={() => !o.disabled && setActive(i)}
                  onClick={(e) => { e.stopPropagation(); e.preventDefault(); commit(o); }}
                >
                  <span className="select-option-main">
                    <span className="select-option-label">{o.label}</span>
                    {o.hint && <span className="select-option-hint">{o.hint}</span>}
                  </span>
                  {o.meta != null && <span className="select-option-meta">{o.meta}</span>}
                  <Check size={15} className="select-tick" aria-hidden />
                </button>
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}

/** The common shape: a list of `[value, label]` pairs, as most of these already hold. */
export const pairs = (list: readonly (readonly [string, string])[]): SelectOption[] =>
  list.map(([value, label]) => ({ value, label }));
