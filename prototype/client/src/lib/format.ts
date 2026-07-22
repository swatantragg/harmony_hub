// Formatting helpers. Every size, date and duration in the product goes through here,
// so a byte count never renders two different ways on two different screens.

export function bytes(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function relative(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const diff = Date.now() - Date.parse(iso);
  const abs = Math.abs(diff);
  const future = diff < 0;
  const units: [number, string][] = [
    [1000, 'second'], [60_000, 'minute'], [3_600_000, 'hour'],
    [86_400_000, 'day'], [604_800_000, 'week'], [2_592_000_000, 'month'], [31_536_000_000, 'year'],
  ];
  if (abs < 45_000) return future ? 'in a moment' : 'just now';
  let out = 'a while';
  for (let i = units.length - 1; i >= 0; i -= 1) {
    const [ms, name] = units[i];
    if (abs >= ms) {
      const n = Math.round(abs / ms);
      out = `${n} ${name}${n === 1 ? '' : 's'}`;
      break;
    }
  }
  return future ? `in ${out}` : `${out} ago`;
}

export function countdown(ms: number): string {
  if (ms <= 0) return 'expired';
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (d > 0) return `${d}d ${h}h left`;
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m left`;
}

export function date(iso: string | null | undefined, withTime = false): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const base = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  return withTime ? `${base}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : base;
}

export function duration(sec: number | null | undefined): string {
  if (sec == null) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Never truncate a hash silently — the middle is elided and the full value stays in the
// title attribute, per the brand book's typography rules.
export function midTruncate(value: string, head = 16, tail = 10): string {
  if (!value || value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export const initials = (name: string) =>
  name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('');

export const pluralise = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
