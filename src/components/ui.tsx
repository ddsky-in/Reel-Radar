'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, ArrowUpRight, Check, Loader2, X } from 'lucide-react';
import { validCreatorAvatarPath } from '@/lib/creator-avatar';
export { useResource } from '@/lib/use-resource';

export type Notify = (message: string, kind?: 'success' | 'error') => void;

export function Logo({ small = false }: { small?: boolean }) {
  return <span className={`brand ${small ? 'brand-small' : ''}`}><svg viewBox="0 0 36 36" fill="none" aria-hidden="true"><circle cx="18" cy="18" r="15" stroke="currentColor" strokeWidth="1.5"/><circle cx="18" cy="18" r="9" stroke="currentColor" strokeWidth="1.5"/><circle cx="18" cy="18" r="3" fill="currentColor"/><path d="M18 18 29 7M18 3v6M3 18h6M18 27v6M27 18h6" stroke="currentColor" strokeWidth="1.5"/><circle cx="27" cy="9" r="3" fill="#9fc2ff" stroke="#081426" strokeWidth="1.5"/></svg><span>Reel<span className="brand-light">Radar</span><span className="brand-dot">.</span></span></span>;
}

export function Status({ status }: { status: string }) {
  return <span className={`status status-${status}`}><i />{status.replaceAll('_', ' ')}</span>;
}

export function Empty({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <div className="empty-state"><h3>{title}</h3><p>{description}</p>{action}</div>;
}

export function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="error-state" role="alert"><AlertCircle size={20}/><div><strong>We couldn’t load this data</strong><p>{message}</p></div>{retry && <button className="button button-secondary" onClick={retry}>Try again</button>}</div>;
}

export function Skeleton({ cards = false }: { cards?: boolean }) {
  return <div className={cards ? 'reel-grid' : 'skeleton-stack'} aria-label="Loading data" aria-busy="true">{Array.from({ length: cards ? 6 : 4 }, (_, i) => <div key={i} className={`skeleton ${cards ? 'skeleton-card' : ''}`}/>)}</div>;
}

export function Dialog({ title, subtitle, children, onClose, wide = false, actions, className = '' }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; wide?: boolean; actions?: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; }, [onClose]);
  const id = title.toLowerCase().replaceAll(' ', '-');
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const root = ref.current;
    const selector = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]';
    const first = root?.querySelector<HTMLElement>(selector);
    first?.focus();
    function keydown(event: KeyboardEvent) {
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (dialogs[dialogs.length - 1] !== root) return;
      if (event.key === 'Escape') {
        // A control's popup handles its own Escape before the containing dialog.
        if (root?.querySelector('[popover]:popover-open, select:open') || event.target instanceof Element && event.target.closest('[popover]')) return;
        event.preventDefault(); close.current();
      }
      if (event.key !== 'Tab') return;
      const items = Array.from(root?.querySelectorAll<HTMLElement>(selector) ?? []).filter(item => item.offsetParent !== null);
      const first = items[0], last = items[items.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', keydown, true);
    return () => { document.removeEventListener('keydown', keydown, true); document.body.style.overflow = previousOverflow; prior?.focus(); };
  }, []);
  const overlay = <div className="dialog-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div ref={ref} className={['dialog', wide ? 'dialog-wide' : '', className].filter(Boolean).join(' ')} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1}><div className="dialog-header"><div><h2 id={id}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><div className="dialog-header-actions">{actions}<button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={20}/></button></div></div>{children}</div></div>;
  // Dialogs can originate inside a sticky, scrolling filter sidebar or a card.
  // Put the overlay outside those clipping and stacking contexts.
  return typeof document === 'undefined' ? overlay : createPortal(overlay, document.body);
}

export function Avatar({ username, index = 0, url, fallbackUrl }: { username: string; index?: number; url?: string | null; fallbackUrl?: string | null }) {
  const [failure, setFailure] = useState<{ source: string; url: string } | null>(null);
  const [version, setVersion] = useState(0);
  const recovery = useRef({ source: '', retries: 0, failedAt: 0, version: 0, displayed: null as string | null, pending: false });
  const initials = username.replace(/[_.]/g, ' ').split(' ').filter(Boolean).map(s => s[0]).slice(0, 2).join('').toUpperCase();
  let image: string | null = null;
  try { const parsed = new URL(url ?? ''); if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) image = parsed.href; } catch { /* Missing image uses initials. */ }
  const fallback = validCreatorAvatarPath(fallbackUrl);
  const source = `${image ?? ''}|${fallback ?? ''}`;
  const failedUrl = failure?.source === source ? failure.url : null;
  const primary = image ?? fallback;
  const displayed = failedUrl ? failedUrl === primary && fallback !== primary ? fallback : null : primary;
  useEffect(() => {
    if (recovery.current.source !== source) recovery.current = { source, retries: 0, failedAt: 0, version, displayed, pending: false };
    recovery.current.version = version;
    recovery.current.displayed = displayed;
  }, [source, version, displayed]);
  useEffect(() => {
    if (displayed || !primary) return;
    const retry = () => {
      const current = recovery.current;
      if (current.source !== source || current.pending || current.retries >= 2 || Date.now() - current.failedAt < 2_000) return;
      current.pending = true;
      current.retries++;
      setFailure(null);
      setVersion(value => value + 1);
    };
    const timer = setTimeout(retry, 2_000);
    window.addEventListener('online', retry);
    window.addEventListener('focus', retry);
    return () => { clearTimeout(timer); window.removeEventListener('online', retry); window.removeEventListener('focus', retry); };
  }, [displayed, primary, source, version]);
  const unavailable = Boolean(primary && !displayed);
  return <span className={`avatar avatar-${index % 5}`} title={unavailable ? `@${username} · Profile photo unavailable. Existing research is preserved.` : `@${username}`}>
    {/* Retry signed sources unchanged; the optional stored-image fallback never collects profiles. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    {displayed ? <img key={`${source}:${version}:${displayed}`} src={displayed} alt={`Profile picture of @${username}`} loading="lazy" referrerPolicy="no-referrer" onError={() => {
      const current = recovery.current;
      if (current.source !== source || current.version !== version || current.displayed !== displayed) return;
      current.failedAt = Date.now();
      current.displayed = null;
      current.pending = false;
      setFailure({ source, url: displayed });
    }}/> : <span aria-hidden="true">{initials}</span>}
    {unavailable && <span className="sr-only">Profile photo unavailable for @{username}</span>}
  </span>;
}

export function Toasts({ messages, dismiss }: { messages: { id: number; message: string; kind: 'success' | 'error' }[]; dismiss: (id: number) => void }) {
  return <div className="toast-region" aria-live="polite">{messages.map(toast => <div className={`toast toast-${toast.kind}`} key={toast.id}>{toast.kind === 'success' ? <Check size={18}/> : <AlertCircle size={18}/>}<span>{toast.message}</span><button className="icon-button" aria-label="Dismiss notification" onClick={() => dismiss(toast.id)}><X size={16}/></button></div>)}</div>;
}

export function SubmitButton({ busy, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return <button className="button button-accent" disabled={busy || props.disabled} {...props}>{busy ? <Loader2 size={16} className="spin"/> : null}{children}</button>;
}

export function SourceLink({ url, label = 'Original Reel', iconOnly = false }: { url: string | null; label?: string; iconOnly?: boolean }) {
  return url && /^https:\/\/(www\.)?instagram\.com\//i.test(url) ? <a className={`source-link${iconOnly ? ' source-link-icon' : ''}`} href={url} target="_blank" rel="noopener noreferrer" aria-label={iconOnly ? label : undefined} title={iconOnly ? label : undefined}>{!iconOnly && label}<ArrowUpRight size={iconOnly ? 16 : 14} aria-hidden="true"/></a> : iconOnly ? null : <span className="synthetic-source" title="Synthetic fixture. No original Instagram media exists.">Synthetic fixture</span>;
}
