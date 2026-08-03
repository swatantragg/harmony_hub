// Sign in. One column, one surface, no split panel and no pitch — the name, two fields
// and a button. The demo roles stay as a single line of text links, because the product's
// documented one-click evaluation path runs through them; nothing else is on the page.
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight, Loader2 } from 'lucide-react';
import { ThemeToggle } from '../../components/ui';
import { useSession } from '../../app/session';
import { api } from '../../lib/api';

interface DemoAccount { email: string; password: string; name: string; role: string; jobTitle: string; permissions: number }

export function Login() {
  const [email, setEmail] = useState('editor@gcloud.app');
  const [password, setPassword] = useState('gcloud');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [accounts, setAccounts] = useState<DemoAccount[]>([]);
  const login = useSession((s) => s.login);
  const navigate = useNavigate();
  const location = useLocation();
  // Someone who arrived on a gated share link is sent back to it after signing in, rather
  // than being dropped on a dashboard and left to find the link again in their email.
  const returnTo = (location.state as { from?: { pathname: string } } | null)?.from?.pathname ?? '/';

  useEffect(() => {
    api<DemoAccount[]>('/auth/demo-accounts').then(setAccounts).catch(() => {});
  }, []);

  const submit = async (e?: React.FormEvent, override?: DemoAccount) => {
    e?.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(override?.email ?? email, override?.password ?? password);
      navigate(returnTo, { replace: true });
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
            <input id="email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
          </div>
          <div className="field">
            <label className="label" htmlFor="password">Password</label>
            <input id="password" className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </div>
          {error && <div className="note danger" role="alert"><span>{error}</span></div>}
          <button className="btn btn-primary btn-lg btn-block" disabled={busy}>
            {busy ? <Loader2 size={16} /> : null} Sign in <ArrowRight size={15} />
          </button>
        </form>

        {accounts.length > 0 && (
          <div className="row-tight" style={{ justifyContent: 'center', flexWrap: 'wrap', marginTop: 26, gap: 4 }}>
            {accounts.map((a, i) => (
              <span key={a.email} className="row-tight" style={{ gap: 4 }}>
                {i > 0 && <span className="t-small" style={{ opacity: .5 }}>·</span>}
                <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => submit(undefined, a)}>
                  {a.role}
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
