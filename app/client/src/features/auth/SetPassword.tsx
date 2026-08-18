// The one screen an account sees between its first sign-in and the rest of the product.
//
// A starting password is a handover value: an administrator typed it, spoke it aloud or
// sent it over something, and at least two people know it. It is good for exactly one
// sign-in. The server enforces that — every route except this one and /me is closed while
// `mustChangePassword` is set — so this screen is the only way forward, not a suggestion.
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { KeyRound, Loader2, ArrowRight, LogOut } from 'lucide-react';
import { PasswordInput, ThemeToggle } from '../../components/ui';
import { useSession } from '../../app/session';


export function SetPassword() {
  const { user, setPassword, logout } = useSession();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  // The server is the authority on this, and it sends it with the account. Hardcoding it
  // is how the number ends up saying one thing here and another in the API.
  const MIN_LENGTH = user?.minPasswordLength ?? 8;

  // Checked here so the reader is told before submitting, and again on the server, which
  // is the check that actually counts.
  const tooShort = next.length > 0 && next.length < MIN_LENGTH;
  const mismatch = confirm.length > 0 && next !== confirm;
  const unchanged = next.length > 0 && next === current;
  const ready = current.length > 0 && next.length >= MIN_LENGTH && next === confirm && !unchanged;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError('');
    try {
      await setPassword(current, next);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set the password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="plain-page" style={{ display: 'grid', placeItems: 'center' }}>
      <div className="theme-toggle-float"><ThemeToggle /></div>

      <div style={{ width: '100%', maxWidth: 420 }}>
        <div className="row-tight" style={{ justifyContent: 'center', marginBottom: 14 }}>
          <span
            style={{
              width: 44, height: 44, borderRadius: 14, background: 'var(--indigo-soft)',
              color: 'var(--indigo-deep)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <KeyRound size={21} />
          </span>
        </div>

        <h1 className="t-h1" style={{ textAlign: 'center' }}>Choose your password</h1>
        <p className="t-body" style={{ textAlign: 'center', margin: '8px 0 26px' }}>
          {user?.name ? `${user.name}, this` : 'This'} is your first sign-in. The password you were
          given works once — set one only you know, and you will not be asked again.
        </p>

        <form onSubmit={submit} className="stack-3">
          <div className="field">
            <label className="label" htmlFor="current">The password you were given</label>
            <PasswordInput
              id="current"
              value={current}
              onChange={setCurrent}
              autoComplete="current-password"
              autoFocus
              required
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="next">Your new password</label>
            <PasswordInput
              id="next"
              value={next}
              onChange={setNext}
              autoComplete="new-password"
              invalid={tooShort || unchanged}
              required
            />
            <div className="hint">
              {tooShort
                ? `At least ${MIN_LENGTH} characters — ${MIN_LENGTH - next.length} to go.`
                : unchanged
                  ? 'That is the password you were given. Pick a different one.'
                  : `At least ${MIN_LENGTH} characters. Length is the only rule; a phrase beats a puzzle.`}
            </div>
          </div>

          <div className="field">
            <label className="label" htmlFor="confirm">Type it again</label>
            <PasswordInput
              id="confirm"
              value={confirm}
              onChange={setConfirm}
              autoComplete="new-password"
              invalid={mismatch}
              required
            />
            {mismatch && <div className="hint" style={{ color: 'var(--danger-ink)' }}>The two do not match yet.</div>}
          </div>

          {error && <div className="note danger" role="alert"><span>{error}</span></div>}

          <button className="btn btn-primary btn-lg btn-block" disabled={!ready || busy}>
            {busy ? <Loader2 size={16} /> : null} Set password and continue <ArrowRight size={15} />
          </button>
        </form>

        <button
          className="btn btn-ghost btn-sm btn-block"
          style={{ marginTop: 14 }}
          onClick={async () => { await logout(); navigate('/login', { replace: true }); }}
        >
          <LogOut size={14} /> Sign out instead
        </button>
      </div>
    </div>
  );
}
