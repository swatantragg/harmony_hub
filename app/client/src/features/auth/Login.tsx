import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { ArrowRight, Loader2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { PasswordInput, ThemeToggle } from '../../components/ui';
import {
  api, googleSignInUrl, requestResumePasscode, type OtpChallenge,
} from '../../lib/api';
import { useSession } from '../../app/session';
import { BUILD_TAG } from '../../lib/version';
import { PasscodeForm } from './PasscodeForm';
import { ForgotPassword } from './ForgotPassword';
import type { AuthProviders } from '../../lib/types';

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
  const [challenge, setChallenge] = useState<OtpChallenge | null>(null);
  const [forgot, setForgot] = useState(false);
  const login = useSession((s) => s.login);
  const submitPasscode = useSession((s) => s.submitPasscode);
  const passcodeDue = useSession((s) => s.passcodeDue);
  const user = useSession((s) => s.user);
  const loading = useSession((s) => s.loading);
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const returnTo = (location.state as { from?: { pathname: string } } | null)?.from?.pathname ?? '/';

  const { data: providers } = useQuery({
    queryKey: ['auth', 'providers'],
    queryFn: () => api<AuthProviders>('/auth/providers'),
    staleTime: 5 * 60_000,
    retry: false,
  });

  const googleResult = params.get('google');
  const [pendingReturn, setPendingReturn] = useState<string | null>(null);

  useEffect(() => {
    if (!googleResult) return;
    const reason = params.get('reason') ?? 'refused';
    const detail = params.get('detail');
    const to = params.get('returnTo') || '/';
    setParams({}, { replace: true });

    if (googleResult !== 'ok') {
      setError(detail || GOOGLE_REFUSALS[reason] || GOOGLE_REFUSALS.refused);
      return;
    }
    setReturning(true);
    setPendingReturn(to);
  }, [googleResult, params, setParams]);

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

  // A new day, on a browser whose session is otherwise intact. The cookie is
  // still there and still recognised — it just needs today's passcode, not the
  // password again. Ask for one straight away rather than making somebody work
  // out why they are looking at a sign-in form.
  useEffect(() => {
    if (!passcodeDue || challenge || forgot || returning) return;
    let cancelled = false;
    void (async () => {
      const resumed = await requestResumePasscode();
      if (!cancelled && resumed) setChallenge(resumed);
    })();
    return () => { cancelled = true; };
  }, [passcodeDue, challenge, forgot, returning]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const outcome = await login(email, password);
      if (outcome.kind === 'passcode') {
        setChallenge(outcome.challenge);
        setPassword('');
        return;
      }
      navigate(outcome.user.mustChangePassword ? '/set-password' : returnTo, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  const enterPasscode = async (code: string) => {
    const signedIn = await submitPasscode(challenge!.otpToken, code);
    navigate(signedIn.mustChangePassword ? '/set-password' : returnTo, { replace: true });
  };

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

        {challenge ? (
          <PasscodeForm
            challenge={challenge}
            onSubmit={enterPasscode}
            heading={passcodeDue ? 'A new day — one passcode' : 'Enter today’s passcode'}
            cancelLabel="Sign in as somebody else"
            onCancel={() => { setChallenge(null); setError(''); }}
          />
        ) : forgot ? (
          <ForgotPassword initialEmail={email} onBack={() => { setForgot(false); setError(''); }} />
        ) : (
        <>
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
          <button
            type="button"
            className="btn btn-ghost btn-block"
            onClick={() => { setForgot(true); setError(''); }}
          >
            Forgotten your password?
          </button>
        </form>

        {providers?.google?.enabled && (
          <>
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
        </>
        )}

        <p className="t-small" style={{ textAlign: 'center', marginTop: 10, fontFamily: 'var(--mono)', letterSpacing: '.1em', opacity: .62 }}>
          {BUILD_TAG}
        </p>
      </div>
    </div>
  );
}
