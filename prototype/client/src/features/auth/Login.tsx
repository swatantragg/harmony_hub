import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Loader2, ShieldCheck, Search, Pencil, UploadCloud } from 'lucide-react';
import { Brandmark, ThemeToggle } from '../../components/ui';
import { useSession } from '../../app/session';
import { api } from '../../lib/api';

interface DemoAccount { email: string; password: string; name: string; role: string; jobTitle: string; permissions: number }

const ROLE_BLURB: Record<string, string> = {
  Admin: 'Everything, including storage health, re-keys, purges and people',
  Editor: 'Upload, tag, rename and organise the library',
  Marketing: 'Find, download and share files with partners',
  Viewer: 'Search, preview and download — no changes',
};

export function Login() {
  const [email, setEmail] = useState('editor@maestro.app');
  const [password, setPassword] = useState('maestro');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [accounts, setAccounts] = useState<DemoAccount[]>([]);
  const login = useSession((s) => s.login);
  const navigate = useNavigate();

  useEffect(() => {
    api<DemoAccount[]>('/auth/demo-accounts').then(setAccounts).catch(() => {});
  }, []);

  const submit = async (e?: React.FormEvent, override?: DemoAccount) => {
    e?.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(override?.email ?? email, override?.password ?? password);
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)' }}>
      <div className="theme-toggle-float"><ThemeToggle /></div>
      {/* Left — the pitch, set in the display face, on the brand's indigo gradient. */}
      <div
        style={{
          background: 'linear-gradient(160deg, #3A2FB5 0%, #5546E8 52%, #6C5CF0 100%)',
          color: '#fff', padding: '48px 52px', display: 'flex', flexDirection: 'column',
          justifyContent: 'space-between', position: 'relative', overflow: 'hidden',
        }}
      >
        <div style={{ position: 'absolute', inset: '-20% -30% auto auto', width: '70%', height: '90%', background: 'radial-gradient(50% 50% at 60% 40%, rgba(255,158,68,.28), transparent 70%)' }} />
        <div className="row" style={{ gap: 13, position: 'relative' }}>
          <div className="tile on-indigo"><span className="b1" /><span className="b2" /><span className="b3 spark" /><span className="b4" /><span className="b5" /></div>
          <span className="wordmark" style={{ color: '#fff' }}>Maestro</span>
        </div>

        <div style={{ position: 'relative', maxWidth: 520 }}>
          <h1 className="t-display" style={{ fontSize: 'clamp(36px, 4.4vw, 60px)', marginBottom: 18 }}>
            Every release,<br />conducted.
          </h1>
          <p style={{ fontSize: 17, lineHeight: 1.65, color: 'rgba(255,255,255,.82)', maxWidth: '46ch', margin: 0 }}>
            Every master, cover, video, reel and lyric sheet behind a release — searchable,
            versioned, and always accounted for.
          </p>

          <div className="stack-3" style={{ marginTop: 34 }}>
            {[
              [Search, 'Find anything', 'One search box across every file, song and artist'],
              [ShieldCheck, 'Know it is really there', 'Every file proves it exists in storage, on demand'],
              [Pencil, 'Rename without fear', 'Instant, safe, and it never breaks a link'],
              [UploadCloud, 'Upload at any size', 'Parallel, resumable, straight into storage'],
            ].map(([Icon, title, body]) => {
              const I = Icon as typeof Search;
              return (
                <div key={title as string} className="row" style={{ gap: 13, alignItems: 'flex-start' }}>
                  <span style={{ width: 32, height: 32, borderRadius: 10, background: 'rgba(255,255,255,.14)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
                    <I size={16} />
                  </span>
                  <span>
                    <span style={{ display: 'block', fontWeight: 700, fontSize: 14 }}>{title as string}</span>
                    <span style={{ display: 'block', fontSize: 13, color: 'rgba(255,255,255,.7)' }}>{body as string}</span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="t-small" style={{ color: 'rgba(255,255,255,.55)', position: 'relative' }}>
          Music asset management · Amazon S3 storage · prototype build
        </div>
      </div>

      {/* Right — sign in. Demo roles are one click, so evaluating the product costs nothing. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 32px' }}>
        <div style={{ width: '100%', maxWidth: 400 }}>
          <div style={{ display: 'none' }}><Brandmark /></div>
          <h2 className="t-h1" style={{ marginBottom: 6 }}>Sign in</h2>
          <p className="t-body" style={{ marginBottom: 26 }}>Use a demo account below, or type credentials.</p>

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

          <div className="stack-2" style={{ marginTop: 30 }}>
            <div className="eyebrow">Or step into a role</div>
            {accounts.map((a) => (
              <button
                key={a.email}
                className="panel"
                style={{ width: '100%', textAlign: 'left', cursor: 'pointer', padding: 0, border: '1px solid var(--line)' }}
                onClick={() => submit(undefined, a)}
                disabled={busy}
              >
                <div className="panel-body spread" style={{ padding: '11px 14px' }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="row-tight">
                      <span style={{ fontWeight: 700, fontSize: 13.5 }}>{a.role}</span>
                      <span className="t-small" style={{ fontSize: 11.5 }}>· {a.name}</span>
                    </div>
                    <div className="t-small" style={{ fontSize: 12, whiteSpace: 'normal' }}>{ROLE_BLURB[a.role]}</div>
                  </div>
                  <ArrowRight size={15} color="var(--ink-3)" style={{ flex: 'none' }} />
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
