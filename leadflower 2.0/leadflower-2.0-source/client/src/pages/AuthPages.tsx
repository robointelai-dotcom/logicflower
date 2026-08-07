import React from 'react'
import { ArrowLeft, Check, KeyRound, LockKeyhole, Mail, ShieldCheck } from 'lucide-react'
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from '../router'
import { useAuth } from '../auth/AuthContext'
import { api, errorMessage, send, unwrap } from '../api/client'
import { Alert, AppLogo, Button, Field } from '../components/ui'
import type { UnknownRecord } from '../types'

function AuthLayout({ title, description, children, asideTitle = 'Automation with guardrails built in.' }: { title: string; description: string; children: React.ReactNode; asideTitle?: string }) {
  return (
    <div className="auth-shell">
      <aside className="auth-aside">
        <AppLogo />
        <div className="auth-promise"><span className="kicker">LogicFlower operations cloud</span><h1>{asideTitle}</h1><p>Connect your platforms, execute safely, and prove every change with complete audit history.</p><ul><li><Check size={17} />Tenant-isolated operations</li><li><Check size={17} />Dry-run and rollback controls</li><li><Check size={17} />Live health and incident monitoring</li></ul></div>
        <small>Secure by design · Every action traceable</small>
      </aside>
      <main className="auth-main"><div className="auth-card"><div className="mobile-auth-logo"><AppLogo /></div><header><h2>{title}</h2><p>{description}</p></header>{children}</div></main>
    </div>
  )
}

function getDestination(state: unknown): string {
  if (state && typeof state === 'object' && 'from' in state && typeof state.from === 'string' && state.from.startsWith('/') && !state.from.startsWith('//') && !state.from.includes('\\')) return state.from
  return '/dashboard'
}

export function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [email, setEmail] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null)
    try {
      const result = await login(email.trim(), password)
      if (result.mfaRequired) navigate('/mfa-challenge', { replace: true, state: { challengeId: result.challengeId, from: getDestination(location.state) } })
      else { const destination = getDestination(location.state); navigate(destination === '/dashboard' && result.session?.organization?.role === 'billing' ? '/reports' : destination, { replace: true }) }
    } catch (requestError) { setError(errorMessage(requestError)) } finally { setBusy(false) }
  }

  return <AuthLayout title="Welcome back" description="Sign in to your LogicFlower workspace."><form className="form-stack" onSubmit={submit}>{error && <Alert>{error}</Alert>}<Field label="Work email" required><div className="input-icon"><Mail size={17} /><input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@company.com" required autoFocus /></div></Field><Field label="Password" required><div className="input-icon"><LockKeyhole size={17} /><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Enter your password" minLength={8} required /></div></Field><div className="form-between"><span>Secure cookie session</span><Link to="/forgot-password">Forgot password?</Link></div><Button type="submit" variant="primary" busy={busy}>Sign in</Button><p className="auth-switch">New to LogicFlower? <Link to="/register">Create an account</Link></p></form></AuthLayout>
}

export function RegisterPage() {
  const { register } = useAuth()
  const navigate = useNavigate()
  const [form, setForm] = React.useState({ name: '', email: '', organizationName: '', password: '', accept: false })
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const change = (key: keyof typeof form, value: string | boolean) => setForm((current) => ({ ...current, [key]: value }))
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!form.accept) { setError('Please accept the Terms and Privacy Policy.'); return }
    setBusy(true); setError(null)
    try { const { accept: _accepted, ...payload } = form; await register(payload); navigate('/onboarding', { replace: true }) }
    catch (requestError) { setError(errorMessage(requestError)) } finally { setBusy(false) }
  }
  return <AuthLayout title="Create your workspace" description="Start with secure defaults. No credit card required."><form className="form-stack" onSubmit={submit}>{error && <Alert>{error}</Alert>}<div className="form-grid"><Field label="Full name" required><input value={form.name} onChange={(event) => change('name', event.target.value)} autoComplete="name" required autoFocus /></Field><Field label="Work email" required><input type="email" value={form.email} onChange={(event) => change('email', event.target.value)} autoComplete="email" required /></Field></div><Field label="Workspace name" hint="Usually your agency or company name." required><input value={form.organizationName} onChange={(event) => change('organizationName', event.target.value)} required /></Field><Field label="Password" hint="Use at least 12 characters with a number and symbol." required><input type="password" minLength={12} value={form.password} onChange={(event) => change('password', event.target.value)} autoComplete="new-password" required /></Field><label className="check"><input type="checkbox" checked={form.accept} onChange={(event) => change('accept', event.target.checked)} />I agree to the Terms of Service and Privacy Policy.</label><Button type="submit" variant="primary" busy={busy}>Create workspace</Button><p className="auth-switch">Already have an account? <Link to="/login">Sign in</Link></p></form></AuthLayout>
}

export function ForgotPasswordPage() {
  const [email, setEmail] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [sent, setSent] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null)
    try { await send('post', '/auth/forgot-password', { email: email.trim() }); setSent(true) }
    catch (requestError) { setError(errorMessage(requestError)) } finally { setBusy(false) }
  }
  return <AuthLayout title="Reset your password" description="We’ll send a secure reset link if the account exists.">{sent ? <div className="auth-result"><span><Mail size={26} /></span><h3>Check your inbox</h3><p>If an account exists for {email}, a reset link is on its way. The link expires shortly.</p><Link className="button button-primary" to="/login">Return to sign in</Link></div> : <form className="form-stack" onSubmit={submit}>{error && <Alert>{error}</Alert>}<Field label="Work email" required><input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoFocus /></Field><Button variant="primary" busy={busy}>Send reset link</Button><Link className="back-link" to="/login"><ArrowLeft size={16} />Back to sign in</Link></form>}</AuthLayout>
}

export function ResetPasswordPage() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const [password, setPassword] = React.useState('')
  const [confirm, setConfirm] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [complete, setComplete] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (password !== confirm) { setError('Passwords do not match.'); return }
    if (!token) { setError('This reset link is missing its token. Request a new link.'); return }
    setBusy(true); setError(null)
    try { await send('post', '/auth/reset-password', { token, password }); setComplete(true) }
    catch (requestError) { setError(errorMessage(requestError)) } finally { setBusy(false) }
  }
  if (complete) return <AuthLayout title="Password updated" description="Your new password is ready."><div className="auth-result"><span><Check size={27} /></span><h3>Reset complete</h3><p>Sign in again on all devices using your new password.</p><Link className="button button-primary" to="/login">Continue to sign in</Link></div></AuthLayout>
  return <AuthLayout title="Choose a new password" description="Use a unique password you have not used elsewhere."><form className="form-stack" onSubmit={submit}>{error && <Alert>{error}</Alert>}<Field label="New password" hint="At least 12 characters with a number and symbol." required><input type="password" minLength={12} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required autoFocus /></Field><Field label="Confirm new password" required><input type="password" minLength={12} value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="new-password" required /></Field><Button variant="primary" busy={busy}>Update password</Button></form></AuthLayout>
}

export function MfaChallengePage() {
  const { verifyMfa } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const state = location.state && typeof location.state === 'object' ? location.state as { challengeId?: string; from?: string } : {}
  const [code, setCode] = React.useState('')
  const [recovery, setRecovery] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  if (!state.challengeId) return <Navigate to="/login" replace />
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null)
    try { const next = await verifyMfa(state.challengeId ?? '', code.replace(/\s/g, ''), recovery); const destination = state.from ?? '/dashboard'; navigate(destination === '/dashboard' && next.organization?.role === 'billing' ? '/reports' : destination, { replace: true }) }
    catch (requestError) { setError(errorMessage(requestError)); setCode('') } finally { setBusy(false) }
  }
  return <AuthLayout title="Two-step verification" description={recovery ? 'Enter one of your unused recovery codes.' : 'Enter the six-digit code from your authenticator app.'}><form className="form-stack" onSubmit={submit}>{error && <Alert>{error}</Alert>}<div className="mfa-symbol"><ShieldCheck size={30} /></div><Field label={recovery ? 'Recovery code' : 'Verification code'} required><input className="code-input" inputMode={recovery ? 'text' : 'numeric'} autoComplete="one-time-code" maxLength={recovery ? 20 : 6} value={code} onChange={(event) => setCode(event.target.value)} placeholder={recovery ? 'XXXX-XXXX-XXXX' : '000000'} required autoFocus /></Field><Button variant="primary" busy={busy}>Verify and continue</Button><button type="button" className="link-button" onClick={() => { setRecovery((value) => !value); setCode(''); setError(null) }}>{recovery ? 'Use authenticator code' : 'Use a recovery code instead'}</button></form></AuthLayout>
}

export function MfaSetupPage() {
  const { refresh } = useAuth()
  const navigate = useNavigate()
  const [setup, setSetup] = React.useState<{ manualKey?: string; otpauthUrl?: string } | null>(null)
  const [currentPassword, setCurrentPassword] = React.useState('')
  const [code, setCode] = React.useState('')
  const [recoveryCodes, setRecoveryCodes] = React.useState<string[]>([])
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const begin = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null)
    try {
      const response = await api.post('/auth/mfa/setup', { password: currentPassword })
      const body = unwrap<UnknownRecord>(response.data)
      setSetup({ manualKey: String(body.secret ?? ''), otpauthUrl: String(body.otpauthUrl ?? '') })
      setCurrentPassword('')
    } catch (requestError) { setError(errorMessage(requestError)) } finally { setBusy(false) }
  }
  const confirm = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null)
    try {
      const body = await send<UnknownRecord>('post', '/auth/mfa/setup/confirm', { code })
      const codes = Array.isArray(body.recoveryCodes) ? body.recoveryCodes.map(String) : []
      setRecoveryCodes(codes); await refresh()
    } catch (requestError) { setError(errorMessage(requestError)) } finally { setBusy(false) }
  }
  return <div className="narrow-page"><div className="standalone-brand"><AppLogo /></div><div className="setup-card"><span className="setup-icon"><KeyRound /></span><h1>Secure your account</h1><p>Use an authenticator app to add a second layer of protection.</p>{error && <Alert>{error}</Alert>}{recoveryCodes.length ? <><Alert tone="success">Multi-factor authentication is active.</Alert><h2>Save your recovery codes</h2><p>Store these one-time codes in a secure password manager. They will not be shown again.</p><div className="recovery-codes">{recoveryCodes.map((item) => <code key={item}>{item}</code>)}</div><Button variant="primary" onClick={() => navigate('/settings')}>I saved my codes</Button></> : !setup ? <form className="form-stack" onSubmit={begin}><Field label="Current password" hint="Required before creating a new authenticator secret." required><input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required autoFocus /></Field><Button variant="primary" busy={busy}>Continue securely</Button></form> : <form className="form-stack" onSubmit={confirm}><Alert tone="info">Add the account using the manual key or otpauth URI below. The secret exists only on this page until setup is confirmed.</Alert>{setup.manualKey && <Field label="Manual setup key" hint="Enter this key in your authenticator app."><code className="manual-key">{setup.manualKey}</code></Field>}{setup.otpauthUrl && <Field label="Authenticator URI" hint="Password managers can import this URI directly."><code className="manual-key">{setup.otpauthUrl}</code></Field>}<Field label="Six-digit code" required><input className="code-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(event) => setCode(event.target.value)} required /></Field><Button variant="primary" busy={busy}>Enable MFA</Button></form>}</div></div>
}
