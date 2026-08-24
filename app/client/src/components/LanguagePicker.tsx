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

  const needle = value.trim().toLowerCase();
  const matches = needle
    ? languages.filter((l) => l.toLowerCase().includes(needle))
    : languages;

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
