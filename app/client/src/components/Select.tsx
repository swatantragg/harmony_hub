import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
  hint?: ReactNode;
  meta?: ReactNode;
  disabled?: boolean;
  group?: string;
}

const GAP = 6;
const EDGE = 8;
const MIN_WIDTH = 180;

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

    const onPointerDown = (e: Event) => {
      const t = e.target as Node | null;
      if (t && (popup.current?.contains(t) || anchor.current?.contains(t))) return;
      close();
    };
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
  useEffect(() => {
    if (!open) return;
    const start = options.findIndex((o) => o.value === value && !o.disabled);
    setActive(start >= 0 ? start : (pickable[0] ?? -1));
  }, [open]);
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

  const typeAhead = (key: string) => {
    const now = Date.now();
    typed.current.buffer = now - typed.current.at > 600 ? key : typed.current.buffer + key;
    typed.current.at = now;
    const needle = typed.current.buffer.toLowerCase();
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
export const pairs = (list: readonly (readonly [string, string])[]): SelectOption[] =>
  list.map(([value, label]) => ({ value, label }));