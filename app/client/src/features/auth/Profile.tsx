// Your own account: who you are, who let you in, and the one thing you can change here.
//
// Deliberately not an editor. Name, email and role are an administrator's to set — a
// person renaming themselves mid-audit-trail is a worse problem than the convenience is
// worth — so everything on this page is read-only except the password.
import { useEffect, useState } from 'react';
import { KeyRound, Loader2, Mail, ShieldCheck, UserCircle2, UserPlus } from 'lucide-react';
import { PasswordInput, useToast } from '../../components/ui';
import { api } from '../../lib/api';
import { useSession } from '../../app/session';
import { date, initials, relative } from '../../lib/format';


export function Profile() {
  const { user, setPassword } = useSession();
  const toast = useToast();

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!user) return null;

  // The server is the authority on this; the form only avoids offering something it
  // already knows will be refused.
  const MIN_LENGTH = user.minPasswordLength ?? 8;

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
      setCurrent(''); setNext(''); setConfirm('');
      toast({
        kind: 'ok',
        title: 'Password changed',
        body: 'This session stays signed in. Every other session on your account has been ended — which is the point of changing a password.',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page stack-5" style={{ maxWidth: 720 }}>
      <div className="page-head">
        <h1 className="t-h1">Your profile</h1>
      </div>

      <div className="panel">
        <div className="panel-body profile-head">
          <span className="profile-avatar">{initials(user.name)}</span>
          <div className="grow" style={{ minWidth: 0 }}>
            <h2 className="t-h2" style={{ overflowWrap: 'anywhere' }}>{user.name}</h2>
            <div className="t-small row-tight" style={{ marginTop: 2, overflowWrap: 'anywhere' }}>
              <Mail size={14} /> {user.email}
            </div>
            <div className="wrap-gap" style={{ marginTop: 10 }}>
              <span className="pill"><b>Role</b> · {user.role}</span>
              <span className="pill"><b>Status</b> · {user.status}</span>
            </div>
          </div>
        </div>

        <div className="panel-body" style={{ borderTop: '1px solid var(--line)' }}>
          <dl style={{ margin: 0 }}>
            <div className="def">
              <dt className="row-tight"><UserCircle2 size={14} /> Name</dt>
              <dd>{user.name}</dd>
            </div>
            <div className="def">
              <dt className="row-tight"><Mail size={14} /> Email</dt>
              <dd style={{ overflowWrap: 'anywhere' }}>{user.email}</dd>
            </div>
            <div className="def">
              <dt className="row-tight"><UserPlus size={14} /> Added by</dt>
              <dd>
                {user.createdByName ?? (
                  // The founding administrator is created by the server on an empty
                  // database, and seeded accounts predate the field. Saying so is better
                  // than naming somebody who did not do it.
                  <span className="muted">Created when the library was set up</span>
                )}
                {user.createdAt && <span className="t-small"> · {date(user.createdAt)}</span>}
              </dd>
            </div>
            <div className="def">
              <dt className="row-tight"><ShieldCheck size={14} /> Last signed in</dt>
              <dd>{user.lastLoginAt ? relative(user.lastLoginAt) : 'This is your first session'}</dd>
            </div>
            <div className="def">
              <dt className="row-tight"><KeyRound size={14} /> Password set</dt>
              <dd>
                {user.passwordChangedAt
                  ? relative(user.passwordChangedAt)
                  : <span className="muted">Still the one you were handed</span>}
              </dd>
            </div>
          </dl>
        </div>
      </div>

      <form className="panel" onSubmit={submit}>
        <div className="panel-head"><span className="t-h3">Change your password</span></div>
        <div className="panel-body stack-3">
          <div className="field">
            <label className="label" htmlFor="current">Current password</label>
            <PasswordInput
              id="current"
              value={current}
              onChange={setCurrent}
              autoComplete="current-password"
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="next">New password</label>
            <PasswordInput
              id="next"
              value={next}
              onChange={setNext}
              autoComplete="new-password"
              placeholder={`At least ${MIN_LENGTH} characters`}
              invalid={tooShort || unchanged}
            />
            {tooShort && <div className="hint" style={{ color: 'var(--danger)' }}>At least {MIN_LENGTH} characters.</div>}
            {unchanged && <div className="hint" style={{ color: 'var(--danger)' }}>That is the password you already have.</div>}
          </div>

          <div className="field">
            <label className="label" htmlFor="confirm">Confirm new password</label>
            <PasswordInput
              id="confirm"
              value={confirm}
              onChange={setConfirm}
              autoComplete="new-password"
              invalid={mismatch}
            />
            {mismatch && <div className="hint" style={{ color: 'var(--danger)' }}>The two do not match.</div>}
          </div>

          {error && <div className="note danger" role="alert"><span>{error}</span></div>}
        </div>
        <div className="modal-foot" style={{ borderTop: '1px solid var(--line)' }}>
          <button className="btn btn-primary" disabled={!ready || busy}>
            {busy ? <Loader2 size={15} className="spin" /> : <KeyRound size={15} />} Change password
          </button>
        </div>
      </form>

      <SessionsPanel />
    </div>
  );
}

// Where this account is signed in. The point of the list is recognising a row that should
// not be there — and the button under it, which ends all of them at once.
function SessionsPanel() {
  const logoutEverywhere = useSession((s) => s.logoutEverywhere);
  const [rows, setRows] = useState<Session[] | null>(null);

  useEffect(() => {
    api<{ data: Session[] }>('/me/sessions').then((r) => setRows(r.data)).catch(() => setRows([]));
  }, []);

  return (
    <section className="panel">
      <div className="panel-head"><span className="t-h3">Where you are signed in</span></div>
      <div className="panel-body stack-3">
        {rows === null && <span className="muted">Loading…</span>}
        {rows?.length === 0 && <span className="muted">No other sessions.</span>}
        {rows && rows.length > 0 && (
          <dl className="kv">
            {rows.map((s) => (
              <div key={s.familyId}>
                <dt>{s.ip ?? 'unknown address'}</dt>
                <dd>
                  Last used {relative(s.lastUsedAt)}
                  <div className="t-small muted" style={{ marginTop: 2 }}>{s.userAgent || 'unknown device'}</div>
                </dd>
              </div>
            ))}
          </dl>
        )}
        <p className="t-small" style={{ margin: 0, maxWidth: '70ch' }}>
          Signing out everywhere ends every session on every device, and invalidates every
          download and preview link already handed out. Use it if a device goes missing.
        </p>
        <div>
          <button className="btn btn-secondary" onClick={() => logoutEverywhere()}>Sign out everywhere</button>
        </div>
      </div>
    </section>
  );
}

interface Session {
  familyId: string;
  startedAt: string;
  lastUsedAt: string;
  ip: string | null;
  userAgent: string;
}
