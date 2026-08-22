// Pagination, in the shape a long list actually needs.
//
// "Show more" is fine for a feed and wrong for a catalogue: it can only move forwards, it
// forgets where you were the moment you navigate away, and reaching page 10 means pressing
// it nine times. This does the three things that replaces — jump to any page directly,
// choose how many rows to load, and say plainly which slice of the whole you are looking at.
import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { Select } from './Select';

/** 0 means "every row" — a real choice on a library this size, and named as such. */
export const PAGE_SIZES = [50, 100, 200, 250, 0] as const;
export const ALL_ROWS = 0;

const sizeLabel = (n: number) => (n === ALL_ROWS ? 'All rows' : `${n} rows`);

// Which page numbers to render. Always the first, the last, and a window around the
// current one — with gaps marked rather than silently skipped, so the scale of the list
// stays visible even when most of it is not listed.
function pageNumbers(page: number, pages: number): (number | 'gap')[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const out: (number | 'gap')[] = [1];
  const from = Math.max(2, page - 1);
  const to = Math.min(pages - 1, page + 1);
  if (from > 2) out.push('gap');
  for (let i = from; i <= to; i += 1) out.push(i);
  if (to < pages - 1) out.push('gap');
  out.push(pages);
  return out;
}

export function Pagination({
  page, pageSize, total, onPage, onPageSize, noun = 'row', nounPlural,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
  noun?: string;
  /** For nouns that do not pluralise by adding an s — "entry" becomes "entries". */
  nounPlural?: string;
}) {
  const plural = nounPlural ?? `${noun}s`;
  const showingAll = pageSize === ALL_ROWS;
  const pages = showingAll ? 1 : Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : showingAll ? 1 : (page - 1) * pageSize + 1;
  const last = showingAll ? total : Math.min(total, page * pageSize);

  // The jump box is free text while being typed — clamping every keystroke makes "12"
  // impossible to type on a 9-page list, because "1" is committed before the "2" arrives.
  const [jump, setJump] = useState(String(page));
  useEffect(() => { setJump(String(page)); }, [page]);

  const commitJump = () => {
    const n = Number(jump);
    if (!Number.isFinite(n) || n < 1) { setJump(String(page)); return; }
    onPage(Math.min(pages, Math.max(1, Math.round(n))));
  };

  return (
    <div className="pagination">
      <div className="pagination-status">
        <span className="t-small">
          {total === 0
            ? `No ${plural}`
            : <>Showing <b>{first.toLocaleString()}–{last.toLocaleString()}</b> of {total.toLocaleString()} {total === 1 ? noun : plural}</>}
        </span>
        <Select
          style={{ width: 'auto' }}
          value={String(pageSize)}
          onChange={(v) => onPageSize(Number(v))}
          options={PAGE_SIZES.map((n) => ({ value: String(n), label: sizeLabel(n) }))}
          ariaLabel={`How many ${plural} per page`}
        />
      </div>

      {pages > 1 && (
        <div className="pagination-pages">
          <button className="btn btn-ghost btn-icon" disabled={page === 1} onClick={() => onPage(1)} aria-label="First page">
            <ChevronsLeft size={16} />
          </button>
          <button className="btn btn-ghost btn-icon" disabled={page === 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
            <ChevronLeft size={16} />
          </button>

          {pageNumbers(page, pages).map((n, i) =>
            n === 'gap' ? (
              <span key={`gap${i}`} className="pagination-gap" aria-hidden>…</span>
            ) : (
              <button
                key={n}
                className={`pagination-page ${n === page ? 'on' : ''}`}
                onClick={() => onPage(n)}
                aria-label={`Page ${n}`}
                aria-current={n === page ? 'page' : undefined}
              >
                {n}
              </button>
            ),
          )}

          <button className="btn btn-ghost btn-icon" disabled={page === pages} onClick={() => onPage(page + 1)} aria-label="Next page">
            <ChevronRight size={16} />
          </button>
          <button className="btn btn-ghost btn-icon" disabled={page === pages} onClick={() => onPage(pages)} aria-label="Last page">
            <ChevronsRight size={16} />
          </button>

          {/* The point of the whole component: page 1 to page 10 without nine clicks. */}
          <label className="pagination-jump">
            <span className="t-small">Go to</span>
            <input
              className="input"
              value={jump}
              onChange={(e) => setJump(e.target.value.replace(/[^\d]/g, ''))}
              onBlur={commitJump}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitJump(); } }}
              inputMode="numeric"
              aria-label={`Go to page, 1 to ${pages}`}
            />
            <span className="t-small">of {pages}</span>
          </label>
        </div>
      )}
    </div>
  );
}
