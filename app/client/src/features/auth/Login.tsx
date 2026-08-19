// Sign in. One column, one surface, no split panel and no pitch — the name, two fields
// and a button.
//
// The one-click role buttons that used to sit under the form are gone. They existed to
// demonstrate four roles that no longer exist, and they published working credentials on
// an unauthenticated page, which is not a thing a real sign-in screen does.
//
// Two ways in, and they reach the same account. A password is what an administrator hands
// over; Google is what most people already have open in the next tab. Neither replaces
// the other — an account created for user01@gmail.com answers to both from the moment it
// exists, and using one never switches the other off.
import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { ArrowRight, Loader2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { PasswordInput, ThemeToggle } from '../../components/ui';
import { api, googleSignInUrl } from '../../lib/api';
import { useSession } from '../../app/session';
import { BUILD_TAG } from '../../lib/version';
import type { AuthProviders } from '../../lib/types';

// Google's mark, inline. The sign-in page loads nothing from another origin — that is the
// content security policy's whole point — so the logo is four paths rather than an <img>
// pointed at a Google CDN.
function GoogleMark() {
  return (
    <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden focusable="false">
      <path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-3.2-.4-4.7H24v8.9h11.8c-.5 2.7-2.1 5-4.4 6.6v5.500h7.1c4.2-3.8 6.6-9.5 6.6-16.3z" />
      <path fill="#34A853" d="M24 46c6 0 11-2 14.6-5.4l-7.1-5.5c-2 1.3-4.5 2.1-7.5 2.1-5.8 0-10.6-3.9-12.4-9.1H4.3v5.7C7.9 41.1 15.4 46 24 46z" />
      <path fill="#FBBC05" d="M11.6 28.1c-.4-1.3-.7-2.7-.7-4.1s.3-2.8.7-4.1v-5.7H4.3C2.8 17.1 2 20.5 2 24s.8 6.9 2.3 9.8l7.3-5.7z" />
      <path fill="#EA4335" d="M24 10.8c3.3 0 6.2 1.1 8.5 3.3l6.3-6.3C35 4.3 30 2 24 2 15.4 2 7.9 6.9 4.3 14.2l7.3 5.7c1.8-5.2 6.6-9.1 12.4-9.1z" />
    </svg>
  );
}

// Every way the round trip to Google can come back unhappy, in the words the person
// standing there needs. The server sends a reason rather than a sentence, so the copy
// lives here with the rest of the copy.
const GOOGLE_REFUSALS: Record<string, string> = {
  'no-account': 'That Google account has no access to this library yet. Ask an administrator to add the address, then try again.',
  suspended: 'That account has been suspended. An administrator can reactivate it.',
  locked: 'That account is temporarily locked after repeated failed sign-ins. Try again shortly.',
  mismatch: 'That address is already linked to a different Google account. An administrator can sort this out.',
  unverified: 'Google has not verified that address, so it cannot be used to sign in.',
  domain: 'That Google account is not on the domain this library accepts.',
  state: 'That sign-in could not be verified — it may have been started in another browser or left too long. Start again here.',
  expired: 'That sign-in took too long. Try again.',
  cancelled: 'The Google sign-in was cancelled.',
  disabled: 'Signing in with Google is not switched on for this deployment.',
  unreachable: 'Google could not be reached. Sign in with your password, or try again in a moment.',
  misconfigured: 'Google sign-in is not finished being set up on this deployment. Use your password for now.',
  refused: 'Google refused that sign-in. Try again, or use your password.',
};

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [returning, setReturning] = useState(false);
  const login = useSession((s) => s.login);
  const user = useSession((s) => s.user);
  const loading = useSession((s) => s.loading);
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  // Someone who arrived on a gated share link is sent back to it after signing in, rather
  // than being dropped on a dashboard and left to find the link again in their email.
  const returnTo = (location.state as { from?: { pathname: string } } | null)?.from?.pathname ?? '/';

  // Whether the button is worth showing at all. A deployment with no OAuth client
  // configured would otherwise offer a route that can only end in an error page.
  const { data: providers } = useQuery({
    queryKey: ['auth', 'providers'],
    queryFn: () => api<AuthProviders>('/auth/providers'),
    staleTime: 5 * 60_000,
    retry: false,
  });

  // Coming back from Google. The callback has already set the refresh cookie, so there is
  // no token in this URL to read and nothing to exchange here: the session is picked up by
  // the one bootstrap the app already runs at start-up, and this screen only waits for it.
  //
  // Deliberately not calling bootstrap() again. A refresh token is good for exactly one
  // use, and a second redemption of the same one is indistinguishable from a stolen token
  // being replayed — the server would correctly destroy the whole session family and sign
  // the person out at the moment they signed in.
  const googleResult = params.get('google');
  const [pendingReturn, setPendingReturn] = useState<string | null>(null);

  useEffect(() => {
    if (!googleResult) return;
    const reason = params.get('reason') ?? 'refused';
    const detail = params.get('detail');
    const to = params.get('returnTo') || '/';
    // Cleared straight away so a reload does not replay the result — and so the effect
    // does not fire twice on the same one.
    setParams({}, { replace: true });

    if (googleResult !== 'ok') {
      setError(detail || GOOGLE_REFUSALS[reason] || GOOGLE_REFUSALS.refused);
      return;
    }
    setReturning(true);
    setPendingReturn(to);
  }, [googleResult, params, setParams]);

  // The session has landed — or it has not, and the cookie the callback set was rejected.
  useEffect(() => {
    if (!returning || loading) return;
    if (!user) {
      setReturning(false);
      setPendingReturn(null);
      setError('That sign-in did not complete. Try again.');
      return;
    }
    navigate(user.mustChangePassword ? '/set-password' : pendingReturn || '/', { replace: true });
  }, [returning, loading, user, pendingReturn, navigate]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const user = await login(email, password);
      // An account still holding the password an administrator handed over goes nowhere
      // else until it has one of its own.
      navigate(user.mustChangePassword ? '/set-password' : returnTo, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  // A full navigation, not a fetch. The flow is redirects end to end, and it is the
  // top-level window that has to make the trip.
  const continueWithGoogle = () => {
    setError('');
    window.location.href = googleSignInUrl(email.trim() || undefined);
  };

  if (returning) {
    return (
      <div className="plain-page" style={{ display: 'grid', placeItems: 'center' }}>
        <div className="col" style={{ alignItems: 'center', gap: 14 }}>
          <Loader2 size={22} />
          <span className="t-small">Finishing your Google sign-in…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="plain-page" style={{ display: 'grid', placeItems: 'center' }}>
      <div className="theme-toggle-float"><ThemeToggle /></div>

      <div style={{ width: '100%', maxWidth: 380 }}>
        <h1
          className="t-display"
          style={{ fontSize: 'clamp(52px, 9vw, 86px)', textAlign: 'center', marginBottom: 44, color: 'var(--ink)' }}
        >
          GCloud
        </h1>

        <form onSubmit={submit} className="stack-3">
          <div className="field">
            <label className="label" htmlFor="email">Email</label>
            <input
              id="email"
              className="input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              autoFocus
              required
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="password">Password</label>
            <PasswordInput
              id="password"
              value={password}
              onChange={setPassword}
              autoComplete="current-password"
              required
            />
          </div>
          {error && <div className="note danger" role="alert"><span>{error}</span></div>}
          <button className="btn btn-primary btn-lg btn-block" disabled={busy || !email || !password}>
            {busy ? <Loader2 size={16} /> : null} Sign in <ArrowRight size={15} />
          </button>
        </form>

        {providers?.google?.enabled && (
          <>
            {/* A separator rather than two buttons side by side: they are alternatives,
                not a primary and a secondary, and the same account is behind both. */}
            <div className="row" style={{ gap: 12, alignItems: 'center', margin: '18px 0' }}>
              <span style={{ height: 1, background: 'var(--edge)', flex: 1 }} />
              <span className="t-small" style={{ textTransform: 'uppercase', letterSpacing: '.08em', fontSize: 12 }}>or</span>
              <span style={{ height: 1, background: 'var(--edge)', flex: 1 }} />
            </div>

            <button type="button" className="btn btn-secondary btn-lg btn-block" onClick={continueWithGoogle}>
              <GoogleMark /> Continue with Google
            </button>

            <p className="t-small" style={{ textAlign: 'center', marginTop: 10 }}>
              {providers?.google?.hostedDomain
                ? `Use your ${providers.google.hostedDomain} account — the same one your GCloud access was set up under.`
                : 'Use the Google account with the same email address as your GCloud account. Your password keeps working either way.'}
            </p>
          </>
        )}

        <p className="t-small" style={{ textAlign: 'center', marginTop: 22 }}>
          Accounts are created by an administrator. If you do not have one, ask them to add you.
        </p>

        {/* The one screen everybody reaches before signing in, so it is the one place a
            build number can be read off a phone that is misbehaving. */}
        <p className="t-small" style={{ textAlign: 'center', marginTop: 10, fontFamily: 'var(--mono)', letterSpacing: '.1em', opacity: .62 }}>
          {BUILD_TAG}
        </p>
      </div>
    </div>
  );
}
