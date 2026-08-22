// Choosing a language, in the one shape this field actually needs.
//
// A plain dropdown over a fixed list is wrong here: the controlled vocabulary is seven
// languages and India has rather more than seven, so the list is a shortcut rather than a
// rule. A plain text box is also wrong: left to type it freely, the same library ends up
// holding "Punjabi", "punjabi" and "Panjabi" as three different answers to the same
// question, and every filter built on the field splits three ways.
//
// So: a combobox. The suggestions are one keystroke away, anything else is still typeable,
// and the value is normalised on the way out — trimmed, and snapped to a suggestion when
// it differs from one only by case or spacing.
//
// This was a native <datalist>, which does all of the above and paints its popup with the
// operating system's own widget — a grey list with square corners, ignoring every token in
// this stylesheet, and the one control on the screen that did not look like the product.
// The list below is the same panel every other dropdown here opens.
import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import { useLanguages } from '../lib/vocabulary';
import { useAnchored } from './Select';

export function LanguagePicker({
  value, onChange, label = 'Language', hint, placeholder = 'Hindi, Punjabi, English…',
}: {
  value: string;
  onChange: (v: string) => void;
  label?: string | null;
  hint?: string;
  placeholder?: string;
}) {
  const { data: languages = [] } = useLanguages();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const field = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const pos = useAnchored(open, close, field, list);

  // What is typed narrows the list, but never empties it into a dead end: with no match
  // the popup simply closes, because the field still accepts what is being typed.
  const needle = value.trim().toLowerCase();
  const matches = needle
    ? languages.filter((l) => l.toLowerCase().includes(needle))
    : languages;

  // Snapping happens on blur rather than on every keystroke: correcting somebody mid-word
  // makes the field impossible to type in.
  const settle = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) { onChange(''); return; }
    const known = languages.find((l) => l.toLowerCase() === trimmed.toLowerCase());
    onChange(known ?? trimmed);
  };

  const pick = (language: string) => {
    onChange(language);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { setOpen(false); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { setOpen(true); setActive(0); return; }
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => Math.min(matches.length - 1, Math.max(0, i + delta)));
      return;
    }
    // Enter takes the highlighted suggestion when there is one, and otherwise leaves what
    // was typed alone — this field's whole point is that an unlisted language is valid.
    if (e.key === 'Enter' && open && matches[active]) {
      e.preventDefault();
      pick(matches[active]);
    }
  };

  return (
    <div className="field" style={{ flex: '1 1 170px', minWidth: 150 }} ref={field}>
      {label && <label className="label">{label}</label>}
      <input
        className="input"
        value={value}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        onChange={(e) => { onChange(e.target.value); setOpen(true); setActive(-1); }}
        onFocus={() => setOpen(true)}
        onBlur={(e) => settle(e.target.value)}
        onKeyDown={onKeyDown}
        aria-label={label ?? 'Language'}
      />
      {hint && <div className="hint">{hint}</div>}

      {open && matches.length > 0 && createPortal(
        <div
          ref={list}
          className="panel select-menu"
          role="listbox"
          aria-label={label ?? 'Language'}
          style={{
            top: pos?.top ?? 0,
            left: pos?.left ?? 0,
            width: pos?.width,
            visibility: pos ? 'visible' : 'hidden',
          }}
          // The input must keep focus: losing it would run the blur handler and close the
          // list out from under the press that was choosing from it.
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
        >
          {matches.map((l, i) => (
            <button
              key={l}
              type="button"
              role="option"
              aria-selected={l === value}
              className={`select-option ${l === value ? 'on' : ''} ${i === active ? 'active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(l)}
            >
              <span className="select-option-main">
                <span className="select-option-label">{l}</span>
              </span>
              <Check size={15} className="select-tick" aria-hidden />
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
