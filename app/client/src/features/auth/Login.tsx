// Sign in. One column, one surface, no split panel and no pitch — the name, two fields
// and a button.
//
// The one-click role buttons that used to sit under the form are gone. They existed to
// demonstrate four roles that no longer exist, and they published working credentials on
// an unauthenticated page, which is not a thing a real sign-in screen does.
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { ArrowRight, Loader2 } from 'lucide-react';
import { ThemeToggle } from '../../components/ui';
import { useSession } from '../../app/session';

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const login = useSession((s) => s.login);
  const navigate = useNavigate();
  const location = useLocation();
  // Someone who arrived on a gated share link is sent back to it after signing in, rather
  // than being dropped on a dashboard and left to find the link again in their email.
  const returnTo = (location.state as { from?: { pathname: string } } | null)?.from?.pathname ?? '/';

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

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '40px 24px' }}>
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
            <input
              id="password"
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          {error && <div className="note danger" role="alert"><span>{error}</span></div>}
          <button className="btn btn-primary btn-lg btn-block" disabled={busy || !email || !password}>
            {busy ? <Loader2 size={16} /> : null} Sign in <ArrowRight size={15} />
          </button>
        </form>

        <p className="t-small" style={{ textAlign: 'center', marginTop: 22 }}>
          Accounts are created by an administrator. If you do not have one, ask them to add you.
        </p>
      </div>
    </div>
  );
}
