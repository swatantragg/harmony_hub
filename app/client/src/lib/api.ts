// Typed fetch client. Attaches the access token, unwraps RFC 7807 problem responses
// into readable Error messages, and keeps every URL in one place.
//
// ── Where the session lives, and why it moved ───────────────────────────────
//
// The access token used to be kept in localStorage. That is readable by any script that
// runs on this origin, and this application serves user-uploaded files from this origin —
// so a single stored HTML or SVG file was a complete session theft. The server no longer
// serves those inline, but a token in localStorage is a standing invitation for the next
// such bug, and it survives closing the tab.
//
// So the access token lives in a module variable — gone when the tab closes, unreachable
// from any other script context — and is deliberately short-lived. What keeps a person
// signed in is a refresh token in an HttpOnly cookie, which script cannot read at all,
// scoped to /api/auth so it is not attached to any other request. This module refreshes
// it silently: on start-up, and once on any 401.

const BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') || '/api';

let accessToken: string | null = null;
// A step-up ticket, held the same way: in memory, short-lived, never persisted. It is what
// lets somebody confirm three deletions after typing their password once.
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
  /** Set when the server is asking for the account password before it will proceed. */
  stepUp: boolean;
  /** Set when a share link is protected by a passcode. */
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

// One refresh in flight at a time, however many requests hit a 401 together — otherwise a
// page with six queries on it rotates the refresh token six times and five of those look
// like token reuse to the server, which is exactly the alarm it should raise.
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
        // Cleared on the next tick so concurrent callers all observe the same result.
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
    // The refresh cookie is same-origin and scoped to /api/auth; nothing else needs it.
    credentials: 'same-origin',
  });
}

export async function api<T>(path: string, opts: Options = {}): Promise<T> {
  let res = await send(path, opts);

  // An expired access token is the normal case now, not an error: it lasts fifteen
  // minutes. One silent refresh, one retry, and the reader never sees it.
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

/**
 * Re-authenticates for a destructive action, then remembers the ticket for a few minutes.
 * Returns false when the password was wrong, so a dialog can say so and stay open.
 */
export async function stepUp(password: string): Promise<boolean> {
  try {
    const out = await api<{ ticket: string }>('/auth/step-up', { method: 'POST', body: { password } });
    auth.setStepUp(out.ticket);
    return true;
  } catch {
    return false;
  }
}

/** Restores a session from the refresh cookie. Called once, at start-up. */
export const resume = refresh;

export const qs = (params: Record<string, unknown>) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    sp.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
};
