import { useState } from 'react';
import { ArrowLeft, ArrowRight, KeyRound, Loader2 } from 'lucide-react';
import { PasswordInput } from '../../components/ui';
import { api, type OtpChallenge } from '../../lib/api';

type Stage = 'ask' | 'verify' | 'done';

/**
 * Reset in two steps: prove the address with an emailed code, then set the
 * password in the same request that spends the code.
 *
 * The first step answers identically whether or not the address has an account.
 * Saying "no such account" here would turn the screen into a free membership
 * check for anybody holding a list of company addresses.
 */
export function ForgotPassword({ onBack, initialEmail = '' }: { onBack: () => void; initialEmail?: string }) {
  const [stage, setStage] = useState<Stage>('ask');
  const [email, setEmail] = useState(initialEmail);
  const [challenge, setChallenge] = useState<OtpChallenge | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const ask = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api<{ message: string; resetToken?: string; devCode?: string; expiresIn: number }>(
        '/auth/forgot',
        { method: 'POST', body: { email: email.trim().toLowerCase() } },
      );
      // No resetToken means the address has no account here. The screen moves on
      // regardless — the next step simply will not accept any code.
      setChallenge({
        otpToken: res.resetToken ?? '',
        expiresIn: res.expiresIn,
        sentTo: email.trim().toLowerCase(),
        devCode: res.devCode,
      });
      setStage('verify');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That request could not be sent.');
    } finally {
      setBusy(false);
    }
  };

  const reset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) { setError('Those two passwords do not match.'); return; }
    setBusy(true);
    setError('');
    try {
      await api('/auth/reset', {
        method: 'POST',
        body: { resetToken: challenge?.otpToken, code, newPassword: password },
      });
      setStage('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That reset could not be completed.');
    } finally {
      setBusy(false);
    }
  };

  if (stage === 'done') {
    return (
      <div className="stack-3">
        <div className="col" style={{ alignItems: 'center', gap: 8, textAlign: 'center' }}>
          <KeyRound size={26} aria-hidden />
          <h2 className="t-h2" style={{ margin: 0 }}>Password set</h2>
          <p className="t-small" style={{ margin: 0 }}>
            Every session on the account was ended. Sign in with the new password — you will be
            asked for today’s passcode as usual.
          </p>
        </div>
        <button type="button" className="btn btn-primary btn-lg btn-block" onClick={onBack}>
          Back to sign in <ArrowRight size={15} />
        </button>
      </div>
    );
  }

  if (stage === 'verify') {
    return (
      <form onSubmit={reset} className="stack-3">
        <div className="col" style={{ alignItems: 'center', gap: 8, textAlign: 'center' }}>
          <h2 className="t-h2" style={{ margin: 0 }}>Check your email</h2>
          <p className="t-small" style={{ margin: 0 }}>
            If <strong>{challenge?.sentTo}</strong> has an account here, a code is on its way to it.
            Enter the code and choose a new password.
          </p>
        </div>

        {challenge?.devCode && (
          <div className="note" role="status">
            <span>
              Mail is not configured here, so the code is shown instead:{' '}
              <strong style={{ fontFamily: 'var(--mono)' }}>{challenge.devCode}</strong>
            </span>
          </div>
        )}

        <div className="field">
          <label className="label" htmlFor="reset-code">Code from the email</label>
          <input
            id="reset-code"
            className="input"
            inputMode="numeric"
            autoComplete="one-time-code"
            style={{ fontFamily: 'var(--mono)', letterSpacing: '.3em' }}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
            required
          />
        </div>
        <div className="field">
          <label className="label" htmlFor="reset-password">New password</label>
          <PasswordInput id="reset-password" value={password} onChange={setPassword} autoComplete="new-password" required />
        </div>
        <div className="field">
          <label className="label" htmlFor="reset-confirm">Repeat it</label>
          <PasswordInput id="reset-confirm" value={confirm} onChange={setConfirm} autoComplete="new-password" required />
        </div>

        {error && <div className="note danger" role="alert"><span>{error}</span></div>}

        <button className="btn btn-primary btn-lg btn-block" disabled={busy || !code || !password || !confirm}>
          {busy ? <Loader2 size={16} /> : null} Set password <ArrowRight size={15} />
        </button>
        <button type="button" className="btn btn-ghost btn-block" onClick={onBack}>
          <ArrowLeft size={14} /> Back to sign in
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={ask} className="stack-3">
      <div className="col" style={{ alignItems: 'center', gap: 8, textAlign: 'center' }}>
        <KeyRound size={26} aria-hidden />
        <h2 className="t-h2" style={{ margin: 0 }}>Forgotten password</h2>
        <p className="t-small" style={{ margin: 0 }}>
          Give the address on your account and a one-time code will be sent to it.
        </p>
      </div>

      <div className="field">
        <label className="label" htmlFor="forgot-email">Email</label>
        <input
          id="forgot-email"
          className="input"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="username"
          autoFocus
          required
        />
      </div>

      {error && <div className="note danger" role="alert"><span>{error}</span></div>}

      <button className="btn btn-primary btn-lg btn-block" disabled={busy || !email}>
        {busy ? <Loader2 size={16} /> : null} Send a code <ArrowRight size={15} />
      </button>
      <button type="button" className="btn btn-ghost btn-block" onClick={onBack}>
        <ArrowLeft size={14} /> Back to sign in
      </button>
    </form>
  );
}
