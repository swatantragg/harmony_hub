// Typed fetch client. Attaches the access token, unwraps RFC 7807 problem responses
// into readable Error messages, and keeps every URL in one place.

const TOKEN_KEY = 'gcloud.token';

// Same-origin by default: in development Vite proxies /api, and in the deployed
// architecture the built bundle is served by the same task that answers /api. Set
// VITE_API_BASE (e.g. https://hub.example.com/api) only when the two are split, and add
// that origin to the API's CORS_ORIGINS.
const BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') || '/api';

export const auth = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

export class ApiError extends Error {
  status: number;
  title: string;
  constructor(status: number, title: string, detail: string) {
    super(detail || title);
    this.status = status;
    this.title = title;
  }
}

type Options = { method?: string; body?: unknown; signal?: AbortSignal };

export async function api<T>(path: string, opts: Options = {}): Promise<T> {
  const token = auth.get();
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method || 'GET',
    headers: {
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const payload = text ? JSON.parse(text) : null;

  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth')) {
      auth.clear();
      window.location.hash = '#/login';
    }
    throw new ApiError(res.status, payload?.title || 'Request failed', payload?.detail || '');
  }
  return payload as T;
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
