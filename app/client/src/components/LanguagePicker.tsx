// Choosing a language, in the one shape this field actually needs.
//
// A plain <select> over a fixed list is wrong here: the controlled vocabulary is seven
// languages and India has rather more than seven, so the list is a shortcut rather than a
// rule. A plain text box is also wrong: left to type it freely, the same library ends up
// holding "Punjabi", "punjabi" and "Panjabi" as three different answers to the same
// question, and every filter built on the field splits three ways.
//
// So: a datalist. The suggestions are one keystroke away, anything else is still typeable,
// and the value is normalised on the way out — trimmed, and snapped to a suggestion when
// it differs from one only by case or spacing.
import { useId } from 'react';
import { useLanguages } from '../lib/vocabulary';

export function LanguagePicker({
  value, onChange, label = 'Language', hint, placeholder = 'Hindi, Punjabi, English…',
}: {
  value: string;
  onChange: (v: string) => void;
  label?: string | null;
  hint?: string;
  placeholder?: string;
}) {
  const listId = useId();
  const { data: languages = [] } = useLanguages();

  // Snapping happens on blur rather than on every keystroke: correcting somebody mid-word
  // makes the field impossible to type in.
  const settle = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) { onChange(''); return; }
    const known = languages.find((l) => l.toLowerCase() === trimmed.toLowerCase());
    onChange(known ?? trimmed);
  };

  return (
    <div className="field" style={{ flex: '1 1 170px', minWidth: 150 }}>
      {label && <label className="label">{label}</label>}
      <input
        className="input"
        list={listId}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => settle(e.target.value)}
        aria-label={label ?? 'Language'}
      />
      <datalist id={listId}>
        {languages.map((l) => <option key={l} value={l} />)}
      </datalist>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}
