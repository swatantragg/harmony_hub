import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { Select } from './Select';

export const PAGE_SIZES = [50, 100, 200, 250, 0] as const;
export const ALL_ROWS = 0;

const sizeLabel = (n: number) => (n === ALL_ROWS ? 'All rows' : `${n} rows`);

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
  nounPlural?: string;
}) {
  const plural = nounPlural ?? `${noun}s`;
  const showingAll = pageSize === ALL_ROWS;
  const pages = showingAll ? 1 : Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : showingAll ? 1 : (page - 1) * pageSize + 1;
  const last = showingAll ? total : Math.min(total, page * pageSize);

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
