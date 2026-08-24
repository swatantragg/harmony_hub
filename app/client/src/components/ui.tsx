import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import {
  X, Check, Copy, Info, AlertTriangle, CircleCheck, CircleAlert, Sun, Moon, Monitor, Eye, EyeOff,
} from 'lucide-react';
import type { Availability, Family } from '../lib/types';
import { STATUS_COPY } from '../lib/assetTypes';
import { auth, stepUp } from '../lib/api';
import { useTheme } from '../app/theme';

export function Tile({ size = 'md', onIndigo = false }: { size?: 'sm' | 'md' | 'lg'; onIndigo?: boolean }) {
  return (
    <div className={`tile ${size === 'md' ? '' : size} ${onIndigo ? 'on-indigo' : ''}`} aria-hidden>
      <span className="b1" /><span className="b2" /><span className="b3 spark" /><span className="b4" /><span className="b5" />
    </div>
  );
}

export function Brandmark({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  return (
    <div className="row" style={{ gap: size === 'lg' ? 14 : 11 }}>
      <Tile size={size} />
      <span className="wordmark" style={{ fontSize: size === 'lg' ? 30 : size === 'sm' ? 17 : 20 }}>GCloud</span>
    </div>
  );
}

export function AvailabilityBadge({
  status, size = 'sm', showHelp = false,
}: { status: Availability; size?: 'sm' | 'lg'; showHelp?: boolean }) {
  const copy = STATUS_COPY[status] ?? STATUS_COPY.UNVERIFIED;
  return (
    <span className="row-tight">
      <span className={`badge ${size === 'lg' ? 'lg' : ''}`} data-status={status} title={copy.meaning}>
        <span className="dot" />
        {copy.label}
      </span>
      {showHelp && <HelpTip text={`${copy.meaning} ${copy.next}`} />}
    </span>
  );
}

export function ThemeToggle() {
  const { pref, resolved, cycle } = useTheme();

  const Icon = pref === 'system' ? Monitor : resolved === 'dark' ? Moon : Sun;
  const label =
    pref === 'system'
      ? `Following your system — currently ${resolved}. Switch to light.`
      : pref === 'light'
        ? 'Light. Switch to dark.'
        : 'Dark. Switch to matching your system.';

  return (
    <button
      className="btn btn-ghost btn-icon theme-toggle"
      onClick={cycle}
      title={label}
      aria-label={label}
    >
      <Icon size={17} />
    </button>
  );
}

export function PasswordInput({
  value, onChange, id, autoComplete, placeholder, autoFocus, invalid, required,
}: {
  value: string;
  onChange: (v: string) => void;
  id?: string;
  autoComplete?: string;
  placeholder?: string;
  autoFocus?: boolean;
  invalid?: boolean;
  required?: boolean;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="password-field">
      <input
        id={id}
        className={`input ${invalid ? 'invalid' : ''}`}
        type={shown ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        placeholder={placeholder}
        autoFocus={autoFocus}
        required={required}
      />
      <button
        type="button"
        className="password-toggle"
        onClick={() => setShown((v) => !v)}
        aria-label={shown ? 'Hide password' : 'Show password'}
        aria-pressed={shown}
        title={shown ? 'Hide password' : 'Show password'}
      >
        {shown ? <EyeOff size={17} /> : <Eye size={17} />}
      </button>
    </div>
  );
}
export function HelpTip({ text }: { text: string }) {
  return (
    <span className="help" tabIndex={0} role="note" aria-label={text}>
      ?<span className="bubble">{text}</span>
    </span>
  );
}
export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      title={`${label}: ${value}`}
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(value);
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      }}
    >
      {done ? <Check size={13} /> : <Copy size={13} />}
      {done ? 'Copied' : label}
    </button>
  );
}
let scrollLocks = 0;
function useOverlay(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    scrollLocks += 1;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      scrollLocks = Math.max(0, scrollLocks - 1);
      if (scrollLocks === 0) document.body.style.overflow = '';
    };
  }, [onClose]);
}
export function Modal({
  title, subtitle, onClose, children, footer, width = 'default',
}: {
  title: string; subtitle?: ReactNode; onClose: () => void; children: ReactNode;
  footer?: ReactNode; width?: 'narrow' | 'default' | 'wide';
}) {
  useOverlay(onClose);
  return createPortal(
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${width === 'wide' ? 'wide' : width === 'narrow' ? 'narrow' : ''}`} role="dialog" aria-modal aria-label={title}>
        <div className="modal-head spread">
          <div>
            <h2 className="t-h2">{title}</h2>
            {subtitle && <div className="t-small" style={{ marginTop: 3 }}>{subtitle}</div>}
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close"><X size={17} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
export function Drawer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useOverlay(onClose);
  return createPortal(
    <div className="drawer-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal aria-label="Asset details">{children}</aside>
    </div>,
    document.body,
  );
}

type Toast = { id: number; kind: 'ok' | 'danger' | 'warn' | 'info'; title: string; body?: string };
type ToastApi = (t: Omit<Toast, 'id'>) => void;
const ToastCtx = createContext<ToastApi>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastHost({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback<ToastApi>((t) => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev, { ...t, id }]);
    setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== id)), t.kind === 'danger' ? 7000 : 4200);
  }, []);
  const icons = { ok: CircleCheck, danger: CircleAlert, warn: AlertTriangle, info: Info };
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts">
        {items.map((t) => {
          const Icon = icons[t.kind];
          return (
            <div key={t.id} className={`toast ${t.kind}`} role="status">
              <Icon size={17} style={{ flex: 'none', marginTop: 1 }} />
              <div className="grow">
                <div className="toast-title">{t.title}</div>
                {t.body && <div className="toast-body">{t.body}</div>}
              </div>
              <button className="btn btn-ghost btn-icon" onClick={() => setItems((p) => p.filter((x) => x.id !== t.id))} aria-label="Dismiss">
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}
export function EmptyState({
  icon, title, body, action,
}: { icon: ReactNode; title: string; body: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="glyph">{icon}</div>
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}

export const Skeleton = ({ h = 16, w = '100%', style }: { h?: number; w?: number | string; style?: CSSProperties }) => (
  <div className="skel" style={{ height: h, width: w, ...style }} />
);
export function RowSkeletons({ n = 5 }: { n?: number }) {
  return (
    <div className="panel rows">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="row-item" style={{ cursor: 'default' }}>
          <Skeleton h={42} w={42} style={{ borderRadius: 13, flex: 'none' }} />
          <div className="row-main stack-2">
            <Skeleton h={14} w="42%" />
            <Skeleton h={12} w="26%" />
          </div>
        </div>
      ))}
    </div>
  );
}
export function CardSkeletons({ n = 8 }: { n?: number }) {
  return (
    <div className="cards">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="panel" style={{ overflow: 'hidden' }}>
          <Skeleton h={126} style={{ borderRadius: 0 }} />
          <div className="panel-body stack-2">
            <Skeleton h={13} w="78%" /><Skeleton h={11} w="52%" /><Skeleton h={20} w={92} />
          </div>
        </div>
      ))}
    </div>
  );
}
const CONTROLLED = new Set([
  'Romantic', 'Sad', 'Party', 'Acoustic', 'Viral', 'Festive', 'Devotional',
  'Promo', 'Reel', 'Teaser', 'BTS', 'Master', 'Demo', 'Lyric Video',
]);
export const TagChip = ({ name }: { name: string }) => (
  <span className={`tag ${CONTROLLED.has(name) ? 'controlled' : ''}`}>{name}</span>
);
export function FamilyArt({ family, seed, children }: { family: Family; seed: string; children?: ReactNode }) {
  const bars = useMemo(() => {
    let h = 0;
    for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) | 0;
    return Array.from({ length: 22 }, (_, i) => {
      h = (h * 1103515245 + 12345) & 0x7fffffff;
      const base = family === 'Image' ? 26 : family === 'Document' ? 18 : 22;
      return base + (h % (100 - base));
    });
  }, [seed, family]);
  return (
    <div className="card-art" data-family={family}>
      <div className="wave">
        {bars.map((b, i) => <i key={i} style={{ height: `${family === 'Document' ? 22 : b}%` }} />)}
      </div>
      {children}
    </div>
  );
}
export function ConfirmDialog({
  title, body, confirmLabel, danger, requireTyped, requirePassword, onConfirm, onClose,
}: {
  title: string; body: ReactNode; confirmLabel: string; danger?: boolean;
  requireTyped?: string;
  requirePassword?: boolean;
  onConfirm: () => void; onClose: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [password, setPassword] = useState('');
  const [checking, setChecking] = useState(false);
  const [wrong, setWrong] = useState(false);
  const needsPassword = Boolean(requirePassword) && !auth.hasStepUp();
  const ready = (!requireTyped || typed === requireTyped) && (!needsPassword || password.length > 0);
  const go = async () => {
    if (needsPassword) {
      setChecking(true);
      const ok = await stepUp(password);
      setChecking(false);
      if (!ok) { setWrong(true); setPassword(''); return; }
    }
    onConfirm();
    onClose();
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      width="narrow"
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className={`btn ${danger ? 'btn-danger-solid' : 'btn-primary'}`}
            disabled={!ready || checking}
            onClick={go}
          >
            {checking ? 'Checking…' : confirmLabel}
          </button>
        </>
      }
    >
      <div className="stack-3">
        <div className="t-body">{body}</div>
        {requireTyped && (
          <div className="field">
            <label className="label">Type <span className="keytext">{requireTyped}</span> to confirm</label>
            <input
              className="input mono"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={requireTyped}
              autoFocus
            />
          </div>
        )}
        {needsPassword && (
          <div className="field">
            <label className="label">Your password</label>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setWrong(false); }}
              placeholder="The password for your own account"
            />
            <div className="t-meta" style={{ marginTop: 6 }}>
              {wrong
                ? <span style={{ color: 'var(--danger, #c0392b)' }}>That is not the password for this account.</span>
                : 'Asked because this cannot be undone — a signed-in tab is not enough on its own.'}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
export function useClickOutside<T extends HTMLElement>(onOut: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOut();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onOut]);
  return ref;
}
export function useDebounced<T>(value: T, ms = 260): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}