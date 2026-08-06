import React from 'react'
import { api, errorMessage, send, unwrap } from '../api/client'
import type { Organization, Session, UnknownRecord, User } from '../types'

interface LoginResult {
  mfaRequired?: boolean
  challengeId?: string
  session?: Session
}

interface AuthContextValue {
  session: Session | null
  loading: boolean
  error: string | null
  login: (email: string, password: string) => Promise<LoginResult>
  register: (input: { name: string; email: string; organizationName: string; password: string }) => Promise<void>
  verifyMfa: (challengeId: string, code: string, recoveryCode?: boolean) => Promise<Session>
  logout: () => Promise<void>
  refresh: () => Promise<void>
  switchOrganization: (organizationId: string) => Promise<void>
  updateUser: (updates: Partial<User>) => void
}

const AuthContext = React.createContext<AuthContextValue | null>(null)

function recordOf(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {}
}

function normalizeOrganization(value: unknown): Organization {
  const item = recordOf(value)
  return {
    id: String(item.id ?? item._id ?? item.organizationId ?? ''),
    name: String(item.name ?? item.organizationName ?? 'Workspace'),
    slug: typeof item.slug === 'string' ? item.slug : undefined,
    role: (String(item.role ?? 'viewer').toLowerCase() as Organization['role']),
    plan: typeof item.plan === 'string' ? item.plan : undefined,
    memberCount: typeof item.memberCount === 'number' ? item.memberCount : undefined,
  }
}

export function normalizeSession(payload: unknown): Session {
  const root = recordOf(unwrap<unknown>(payload))
  const sessionRoot = recordOf(root.session)
  const source = Object.keys(sessionRoot).length ? sessionRoot : root
  const rawUser = recordOf(source.user)
  const organizationsRaw = Array.isArray(source.organizations) ? source.organizations : Array.isArray(source.memberships) ? source.memberships : []
  const organizations = organizationsRaw.map((entry) => {
    const membership = recordOf(entry)
    const organization = membership.organization ?? membership
    return normalizeOrganization({ ...recordOf(organization), role: membership.role ?? recordOf(organization).role })
  }).filter((organization) => organization.id)
  const selected = source.organization ?? source.activeOrganization
  let organization = selected ? normalizeOrganization(selected) : undefined
  const currentOrganizationId = typeof source.currentOrganizationId === 'string' ? source.currentOrganizationId : undefined
  if (currentOrganizationId) organization = organizations.find((item) => item.id === currentOrganizationId) ?? organization
  organization ??= organizations[0]
  const user: User = {
    id: String(rawUser.id ?? rawUser._id ?? ''),
    email: String(rawUser.email ?? ''),
    name: String(rawUser.name ?? rawUser.fullName ?? rawUser.email ?? 'User'),
    avatarUrl: typeof rawUser.avatarUrl === 'string' ? rawUser.avatarUrl : undefined,
    mfaEnabled: Boolean(rawUser.mfaEnabled),
    platformRole: typeof rawUser.platformRole === 'string' ? rawUser.platformRole as User['platformRole'] : undefined,
  }
  return {
    user,
    organizations,
    organization,
    requiresMfa: Boolean(source.requiresMfa ?? source.mfaRequired),
    onboardingComplete: source.onboardingComplete === undefined ? undefined : Boolean(source.onboardingComplete),
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = React.useState<Session | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const refresh = React.useCallback(async () => {
    try {
      const response = await api.get('/auth/session')
      setSession(normalizeSession(response.data))
      setError(null)
    } catch (requestError) {
      const status = requestError && typeof requestError === 'object' && 'status' in requestError ? Number(requestError.status) : 0
      if (status !== 401) setError(errorMessage(requestError))
      setSession(null)
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void refresh()
    const onUnauthorized = () => setSession(null)
    window.addEventListener('logicflower:unauthorized', onUnauthorized)
    return () => window.removeEventListener('logicflower:unauthorized', onUnauthorized)
  }, [refresh])

  const login = React.useCallback(async (email: string, password: string): Promise<LoginResult> => {
    const response = await api.post('/auth/login', { email, password })
    const body = recordOf(unwrap<unknown>(response.data))
    if (body.mfaRequired || body.requiresMfa) {
      return { mfaRequired: true, challengeId: String(body.challengeId ?? body.mfaChallengeId ?? '') }
    }
    const next = normalizeSession(body)
    setSession(next)
    return { session: next }
  }, [])

  const register = React.useCallback(async (input: { name: string; email: string; organizationName: string; password: string }) => {
    const response = await api.post('/auth/register', input)
    setSession(normalizeSession(response.data))
    setError(null)
  }, [])

  const verifyMfa = React.useCallback(async (challengeId: string, code: string, recoveryCode = false) => {
    const response = await api.post('/auth/mfa/verify', recoveryCode ? { challengeId, recoveryCode: code } : { challengeId, code })
    const next = normalizeSession(response.data)
    setSession(next)
    return next
  }, [])

  const logout = React.useCallback(async () => {
    try { await send('post', '/auth/logout') } finally {
      setSession(null)
    }
  }, [])

  const switchOrganization = React.useCallback(async (organizationId: string) => {
    await send('post', `/organizations/${encodeURIComponent(organizationId)}/switch`)
    setSession((current) => current ? { ...current, organization: current.organizations.find((item) => item.id === organizationId) ?? current.organization } : current)
    await refresh()
  }, [refresh])

  const updateUser = React.useCallback((updates: Partial<User>) => {
    setSession((current) => current ? { ...current, user: { ...current.user, ...updates } } : current)
  }, [])

  return <AuthContext.Provider value={{ session, loading, error, login, register, verifyMfa, logout, refresh, switchOrganization, updateUser }}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const value = React.useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used within AuthProvider')
  return value
}
