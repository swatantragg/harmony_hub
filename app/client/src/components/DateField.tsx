// A date field with a calendar the product actually owns.
//
// This was `<input type="date">`, whose picker — like a native select's popup — is drawn by
// the browser and reachable by no stylesheet. Firefox paints one thing, Chrome another,
// Safari a third, and on the dark theme all three arrived as a pale square-cornered widget
// over a product built from rounded panels. The `mm/dd/yyyy` mask was not ours either: it
// follows the browser's locale rather than the format the rest of these screens use.
//
// Timezones are the trap in every date picker, and the reason this parses and formats by
// hand. `new Date('2026-08-22')` is parsed as UTC midnight, so west of Greenwich it renders
// as the 21st — a filter that silently moves a day is worse than no filter. Every value
// here is a local calendar date, built with `new Date(y, m, d)` and serialised by reading
// the local parts back out.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, X } from 'lucide-react';
import { useAnchored } from './Select';

const pad = (n: number) => String(n).padStart(2, '0');

/** Local calendar date → `YYYY-MM-DD`. Never `toISOString`, which converts to UTC first. */
export const toISO = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** `YYYY-MM-DD` → a Date at local midnight, or null when it is not one. */
export function fromISO(value: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
const addMonths = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth() + n, 1);
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

// Weekday initials in the reader's own language, taken from the platform rather than
// hard-coded — the rest of this file's dates already come from `toLocaleDateString`.
const WEEKDAYS = Array.from({ length: 7 }, (_, i) =>
  new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(new Date(2024, 8, 1 + i)));

const monthLabel = (d: Date) =>
  d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

const readable = (d: Date) =>
  d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

// Six weeks, always. A grid that is five rows one month and six the next makes the panel
// jump height as you page through it, and the buttons move under the cursor.
function monthGrid(cursor: Date): Date[] {
  const first = startOfMonth(cursor);
  const start = addDays(first, -first.getDay());
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

export function DateField({
  value, onChange, min, max, ariaLabel, placeholder = 'Any date', style, id,
}: {
  /** `YYYY-MM-DD`, or '' for unset. */
  value: string;
  onChange: (value: string) => void;
  /** `YYYY-MM-DD` bounds, inclusive. Used to keep a range's two ends in order. */
  min?: string;
  max?: string;
  ariaLabel?: string;
  placeholder?: string;
  style?: CSSProperties;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const pos = useAnchored(open, close, btn, panel);

  const selected = fromISO(value);
  const lower = fromISO(min);
  const upper = fromISO(max);
  const today = useMemo(() => new Date(), []);

  // Where the grid is looking, and where the keyboard cursor sits — the same date, because
  // paging with the arrows has to move the month when it walks off the edge of one.
  const [cursor, setCursor] = useState<Date>(selected ?? today);
  useEffect(() => { if (open) setCursor(selected ?? today); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const days = useMemo(() => monthGrid(cursor), [cursor]);
  const blocked = (d: Date) => (lower && d < lower) || (upper && d > upper);

  const pick = (d: Date) => {
    if (blocked(d)) return;
    onChange(toISO(d));
    setOpen(false);
    btn.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (['Enter', ' ', 'ArrowDown'].includes(e.key)) { e.preventDefault(); setOpen(true); }
      return;
    }
    const move = (d: Date) => { e.preventDefault(); setCursor(d); };
    switch (e.key) {
      case 'ArrowLeft': move(addDays(cursor, -1)); break;
      case 'ArrowRight': move(addDays(cursor, 1)); break;
      case 'ArrowUp': move(addDays(cursor, -7)); break;
      case 'ArrowDown': move(addDays(cursor, 7)); break;
      case 'PageUp': move(addMonths(cursor, e.shiftKey ? -12 : -1)); break;
      case 'PageDown': move(addMonths(cursor, e.shiftKey ? 12 : 1)); break;
      case 'Home': move(startOfMonth(cursor)); break;
      case 'End': move(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0)); break;
      case 'Enter':
      case ' ': e.preventDefault(); pick(cursor); break;
      case 'Escape': e.preventDefault(); e.stopPropagation(); setOpen(false); btn.current?.focus(); break;
      case 'Tab': setOpen(false); break;
      default:
    }
  };

  const step = (n: number) => setCursor((c) => addMonths(c, n));

  return (
    <>
      <button
        ref={btn}
        id={id}
        type="button"
        className={`input date-trigger ${selected ? '' : 'placeholder'}`}
        style={style}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); setOpen((v) => !v); }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <CalendarDays size={15} className="date-icon" aria-hidden />
        <span className="date-value">{selected ? readable(selected) : placeholder}</span>
        {/* Clearing is the second most common thing done to a filter date, and burying it
            inside the panel means opening the panel to undo opening the panel. */}
        {selected && (
          <span
            role="button"
            tabIndex={-1}
            className="date-clear"
            aria-label="Clear the date"
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
            onClick={(e) => { e.stopPropagation(); e.preventDefault(); onChange(''); }}
          >
            <X size={13} />
          </span>
        )}
      </button>

      {open && createPortal(
        <div
          ref={panel}
          className="panel calendar"
          role="dialog"
          aria-modal={false}
          aria-label={ariaLabel ?? 'Choose a date'}
          style={{
            top: pos?.top ?? 0,
            left: pos?.left ?? 0,
            visibility: pos ? 'visible' : 'hidden',
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="calendar-head">
            {/* A year at a time as well as a month. Reaching 2023 from here is two presses
                rather than thirty-six. */}
            <button type="button" className="btn btn-ghost btn-icon" aria-label="Previous year" onClick={() => step(-12)}>
              <ChevronsLeft size={16} />
            </button>
            <button type="button" className="btn btn-ghost btn-icon" aria-label="Previous month" onClick={() => step(-1)}>
              <ChevronLeft size={16} />
            </button>
            <span className="calendar-title" aria-live="polite">{monthLabel(cursor)}</span>
            <button type="button" className="btn btn-ghost btn-icon" aria-label="Next month" onClick={() => step(1)}>
              <ChevronRight size={16} />
            </button>
            <button type="button" className="btn btn-ghost btn-icon" aria-label="Next year" onClick={() => step(12)}>
              <ChevronsRight size={16} />
            </button>
          </div>

          <div className="calendar-grid" role="grid">
            {WEEKDAYS.map((w) => <span key={w} className="calendar-weekday" role="columnheader">{w}</span>)}
            {days.map((d) => {
              const outside = d.getMonth() !== cursor.getMonth();
              const off = blocked(d);
              return (
                <button
                  key={toISO(d)}
                  type="button"
                  role="gridcell"
                  disabled={Boolean(off)}
                  aria-label={readable(d)}
                  aria-selected={selected ? sameDay(d, selected) : false}
                  className={[
                    'calendar-day',
                    outside ? 'outside' : '',
                    sameDay(d, today) ? 'today' : '',
                    selected && sameDay(d, selected) ? 'on' : '',
                    sameDay(d, cursor) ? 'cursor' : '',
                  ].filter(Boolean).join(' ')}
                  onClick={(e) => { e.stopPropagation(); e.preventDefault(); pick(d); }}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>

          <div className="calendar-foot">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={Boolean(blocked(today))}
              onClick={() => pick(today)}
            >
              Today
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={!value}
              onClick={() => { onChange(''); setOpen(false); }}
            >
              Clear
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
