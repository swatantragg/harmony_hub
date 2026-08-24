
const BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') || '/api';

let accessToken: string | null = null;
let stepUpTicket: string | null = null;

export const auth = {
  get: () => accessToken,
  set: (t: string) => { accessToken = t; },
  clear: () => { accessToken = null; stepUpTicket = null; },
  setStepUp: (t: string) => { stepUpTicket = t; },
  hasStepUp: () => Boolean(stepUpTicket),
};

export class ApiError extends Error {
  status: number;
  title: string;
  stepUp: boolean;
  passcodeRequired: boolean;
  constructor(status: number, title: string, detail: string, extra: Record<string, unknown> = {}) {
    super(detail || title);
    this.status = status;
    this.title = title;
    this.stepUp = Boolean(extra.stepUp);
    this.passcodeRequired = Boolean(extra.passcodeRequired);
  }
}

type Options = { method?: string; body?: unknown; signal?: AbortSignal; headers?: Record<string, string> };

let refreshing: Promise<boolean> | null = null;

async function refresh(): Promise<boolean> {
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const res = await fetch(`${BASE}/auth/refresh`, {
          method: 'POST',
          credentials: 'same-origin',
        });
        if (!res.ok) return false;
        const payload = await res.json();
        accessToken = payload.accessToken;
        return true;
      } catch {
        return false;
      } finally {
        setTimeout(() => { refreshing = null; }, 0);
      }
    })();
  }
  return refreshing;
}

async function send(path: string, opts: Options): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: opts.method || 'GET',
    headers: {
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(stepUpTicket ? { 'x-step-up': stepUpTicket } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
    credentials: 'same-origin',
  });
}

export async function api<T>(path: string, opts: Options = {}): Promise<T> {
  let res = await send(path, opts);

  if (res.status === 401 && !path.startsWith('/auth')) {
    if (await refresh()) res = await send(path, opts);
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const payload = text ? JSON.parse(text) : null;

  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth') && !payload?.stepUp) {
      auth.clear();
      window.location.hash = '#/login';
    }
    throw new ApiError(res.status, payload?.title || 'Request failed', payload?.detail || '', payload || {});
  }
  return payload as T;
}

export async function stepUp(password: string): Promise<boolean> {
  try {
    const out = await api<{ ticket: string }>('/auth/step-up', { method: 'POST', body: { password } });
    auth.setStepUp(out.ticket);
    return true;
  } catch {
    return false;
  }
}
export const resume = refresh;

export const googleSignInUrl = (email?: string) =>
  `${BASE}/auth/google${email ? `?email=${encodeURIComponent(email)}` : ''}`;
export async function downloadFile(
  path: string,
  fallbackName: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<void> {
  let res = await send(path, opts);
  if (res.status === 401) {
    if (await refresh()) res = await send(path, opts);
  }
  if (!res.ok) {
    const text = await res.text();
    let payload: Record<string, unknown> = {};
    try { payload = text ? JSON.parse(text) : {}; } catch {}
    throw new ApiError(
      res.status,
      String(payload.title || 'Export failed'),
      String(payload.detail || 'The server would not produce the file.'),
      payload,
    );
  }
  const disposition = res.headers.get('content-disposition') || '';
  const named = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1]
    ?? /filename="([^"]+)"/i.exec(disposition)?.[1];
  const filename = named ? decodeURIComponent(named) : fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
export const qs = (params: Record<string, unknown>) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    sp.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
};