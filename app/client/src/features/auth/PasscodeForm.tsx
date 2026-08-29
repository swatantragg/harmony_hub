import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Loader2, MailCheck, RotateCcw } from 'lucide-react';
import { resendPasscode, type OtpChallenge } from '../../lib/api';

/**
 * The one-field step between a password and a session.
 *
 * Six separate boxes rather than a single input, because a passcode is read off
 * a phone a digit at a time and a single field gives no sense of progress. Paste
 * still works: the paste handler spreads the whole code across the boxes.
 */
export function PasscodeForm({
  challenge,
  onSubmit,
  onCancel,
  cancelLabel = 'Use a different account',
  heading = 'Enter today’s passcode',
  length = 6,
}: {
  challenge: OtpChallenge;
  onSubmit: (code: string) => Promise<void>;
  onCancel?: () => void;
  cancelLabel?: string;
  heading?: string;
  length?: number;
}) {
  const [digits, setDigits] = useState<string[]>(() => Array(length).fill(''));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState(challenge);
  const [resent, setResent] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(challenge.expiresIn);
  const boxes = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => { boxes.current[0]?.focus(); }, []);

  useEffect(() => {
    if (secondsLeft <= 0) return undefined;
    const t = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [secondsLeft]);

  const code = digits.join('');

  const put = (index: number, value: string) => {
    const next = [...digits];
    next[index] = value;
    setDigits(next);
    setError('');
    return next;
  };

  const submit = async (value: string) => {
    if (value.length !== length || busy) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit(value);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That passcode was not accepted.');
      setDigits(Array(length).fill(''));
      boxes.current[0]?.focus();
    } finally {
      setBusy(false);
    }
  };

  const onChange = (index: number, raw: string) => {
    const cleaned = raw.replace(/\D/g, '');
    if (!cleaned) { put(index, ''); return; }

    // Pasting the whole code into any box fills the rest.
    if (cleaned.length > 1) {
      const spread = cleaned.slice(0, length).split('');
      const next = Array(length).fill('').map((_, i) => spread[i] ?? '');
      setDigits(next);
      const last = Math.min(spread.length, length) - 1;
      boxes.current[last]?.focus();
      if (spread.length >= length) void submit(next.join(''));
      return;
    }

    const next = put(index, cleaned);
    if (index < length - 1) boxes.current[index + 1]?.focus();
    if (next.every((d) => d)) void submit(next.join(''));
  };

  const onKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      boxes.current[index - 1]?.focus();
      put(index - 1, '');
    }
    if (e.key === 'ArrowLeft' && index > 0) boxes.current[index - 1]?.focus();
    if (e.key === 'ArrowRight' && index < length - 1) boxes.current[index + 1]?.focus();
  };

  const resend = async () => {
    setBusy(true);
    setError('');
    try {
      const fresh = await resendPasscode(current.otpToken);
      setCurrent({ ...current, ...fresh });
      setSecondsLeft(fresh.expiresIn);
      setDigits(Array(length).fill(''));
      setResent(true);
      boxes.current[0]?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'A new passcode could not be sent.');
    } finally {
      setBusy(false);
    }
  };

  const minutes = Math.floor(secondsLeft / 60);
  const seconds = String(secondsLeft % 60).padStart(2, '0');

  return (
    <div className="stack-3">
      <div className="col" style={{ alignItems: 'center', gap: 8, textAlign: 'center' }}>
        <MailCheck size={26} aria-hidden />
        <h2 className="t-h2" style={{ margin: 0 }}>{heading}</h2>
        <p className="t-small" style={{ margin: 0 }}>
          Sent to <strong>{current.sentTo}</strong>. Enter it once and this device stays signed in
          until midnight.
        </p>
      </div>

      <div
        className="row"
        style={{ gap: 8, justifyContent: 'center' }}
        role="group"
        aria-label={`${length}-digit passcode`}
      >
        {digits.map((digit, i) => (
          <input
            /* eslint-disable-next-line react/no-array-index-key */
            key={i}
            ref={(el) => { boxes.current[i] = el; }}
            className="input"
            style={{
              width: 46, height: 56, textAlign: 'center', fontSize: 22,
              fontFamily: 'var(--mono)', padding: 0,
            }}
            inputMode="numeric"
            autoComplete={i === 0 ? 'one-time-code' : 'off'}
            maxLength={length}
            value={digit}
            aria-label={`Digit ${i + 1}`}
            disabled={busy}
            onChange={(e) => onChange(i, e.target.value)}
            onKeyDown={(e) => onKeyDown(i, e)}
          />
        ))}
      </div>

      {current.devCode && (
        <div className="note" role="status">
          <span>
            Mail is not configured on this deployment, so the passcode is shown here instead:{' '}
            <strong style={{ fontFamily: 'var(--mono)' }}>{current.devCode}</strong>
          </span>
        </div>
      )}

      {error && <div className="note danger" role="alert"><span>{error}</span></div>}
      {resent && !error && <div className="note ok" role="status"><span>A new passcode is on its way.</span></div>}

      <button
        className="btn btn-primary btn-lg btn-block"
        disabled={busy || code.length !== length}
        onClick={() => void submit(code)}
        type="button"
      >
        {busy ? <Loader2 size={16} /> : null} Continue <ArrowRight size={15} />
      </button>

      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <button type="button" className="btn btn-ghost" onClick={() => void resend()} disabled={busy}>
          <RotateCcw size={14} /> Send another
        </button>
        <span className="t-small">
          {secondsLeft > 0 ? `Expires in ${minutes}:${seconds}` : 'This passcode has expired'}
        </span>
      </div>

      {onCancel && (
        <button type="button" className="btn btn-ghost btn-block" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </button>
      )}
    </div>
  );
}
