import React from 'react'
import { AlertCircle, CheckCircle2, Inbox, Info, Loader2, Sprout, X } from 'lucide-react'
import { titleCase } from '../utils/format'

export function AppLogo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand" aria-label="LogicFlower">
      <span className="brand-mark"><Sprout size={22} strokeWidth={2.25} aria-hidden="true" /></span>
      {!compact && <span className="brand-word">Logic<span>Flower</span></span>}
    </div>
  )
}

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
  size?: 'sm' | 'md'
  busy?: boolean
}

export function Button({ variant = 'secondary', size = 'md', busy = false, children, disabled, className = '', ...props }: ButtonProps) {
  return (
    <button className={`button button-${variant} button-${size} ${className}`} disabled={disabled || busy} {...props}>
      {busy && <Loader2 className="spin" size={16} aria-hidden="true" />}
      {children}
    </button>
  )
}

export function Card({ children, className = '', title, subtitle, actions }: { children: React.ReactNode; className?: string; title?: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <section className={`card ${className}`}>
      {(title || subtitle || actions) && (
        <header className="card-header">
          <div>{title && <h2>{title}</h2>}{subtitle && <p>{subtitle}</p>}</div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  )
}

export function PageHeader({ title, description, eyebrow, actions }: { title: string; description?: string; eyebrow?: string; actions?: React.ReactNode }) {
  return (
    <header className="page-header">
      <div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1>{description && <p>{description}</p>}</div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  )
}

const successStatuses = new Set(['connected', 'published', 'succeeded', 'completed', 'resolved', 'active', 'verified', 'healthy'])
const warningStatuses = new Set(['attention', 'partial', 'paused', 'waiting', 'preview_ready', 'cancel_requested', 'completed_with_errors', 'awaiting approval', 'awaiting_approval', 'draft', 'acknowledged'])
const dangerStatuses = new Set(['failed', 'critical', 'disconnected', 'cancelled', 'open', 'expired'])

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const normalized = status.toLowerCase()
  const tone = successStatuses.has(normalized) ? 'success' : warningStatuses.has(normalized) ? 'warning' : dangerStatuses.has(normalized) ? 'danger' : normalized === 'running' || normalized === 'connecting' ? 'info' : 'neutral'
  return <span className={`status status-${tone}`}><span aria-hidden="true" />{label ?? titleCase(status)}</span>
}

export function Alert({ tone = 'error', children, onDismiss }: { tone?: 'error' | 'success' | 'info' | 'warning'; children: React.ReactNode; onDismiss?: () => void }) {
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'info' ? Info : AlertCircle
  return (
    <div className={`alert alert-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon size={18} aria-hidden="true" /><div>{children}</div>
      {onDismiss && <button className="icon-button" aria-label="Dismiss" onClick={onDismiss}><X size={16} /></button>}
    </div>
  )
}

export function LoadingState({ label = 'Loading' }: { label?: string }) {
  return <div className="state-block" role="status"><Loader2 className="spin" size={24} /><span>{label}…</span></div>
}

export function EmptyState({ title, description, action, icon }: { title: string; description?: string; action?: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon ?? <Inbox size={24} />}</div>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  )
}

export function Field({ label, hint, error, required, children }: { label: string; hint?: string; error?: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}{required && <span aria-hidden="true"> *</span>}</span>
      {children}
      {hint && !error && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  )
}

export function Progress({ value, label }: { value: number; label?: string }) {
  const safe = Math.max(0, Math.min(100, value))
  return (
    <div className="progress-wrap">
      {label && <div className="progress-label"><span>{label}</span><strong>{safe}%</strong></div>}
      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={safe}><span style={{ width: `${safe}%` }} /></div>
    </div>
  )
}

export function Modal({ open, title, description, children, onClose, footer, wide = false }: { open: boolean; title: string; description?: string; children: React.ReactNode; onClose: () => void; footer?: React.ReactNode; wide?: boolean }) {
  React.useEffect(() => {
    if (!open) return
    const listener = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}>
      <section className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <header className="modal-header"><div><h2 id="modal-title">{title}</h2>{description && <p>{description}</p>}</div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={20} /></button></header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </section>
    </div>
  )
}

export function ConfirmDialog({ open, title, description, confirmLabel = 'Confirm', danger = false, busy = false, onConfirm, onClose }: { open: boolean; title: string; description: string; confirmLabel?: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Modal open={open} title={title} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant={danger ? 'danger' : 'primary'} busy={busy} onClick={onConfirm}>{confirmLabel}</Button></>}>
      <p className="modal-copy">{description}</p>
    </Modal>
  )
}

export function SkeletonRows({ rows = 4, columns = 4 }: { rows?: number; columns?: number }) {
  return <div className="skeleton-table" aria-label="Loading"><div className="sr-only">Loading</div>{Array.from({ length: rows }).map((_, row) => <div key={row}>{Array.from({ length: columns }).map((__, column) => <span key={column} />)}</div>)}</div>
}
