import React from 'react'
import { Navigate, Outlet, useLocation } from '../router'
import { useAuth } from '../auth/AuthContext'
import type { OrganizationRole } from '../types'
import { AppLogo, LoadingState } from './ui'

export function ProtectedRoute() {
  const { session, loading } = useAuth()
  const location = useLocation()
  if (loading) return <div className="boot-screen"><AppLogo /><LoadingState label="Opening your workspace" /></div>
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  return <Outlet />
}

export function PublicOnlyRoute() {
  const { session, loading } = useAuth()
  if (loading) return <div className="boot-screen"><AppLogo /><LoadingState label="Checking your session" /></div>
  if (session) {
    const role = session.organization?.role
    const dest = role === 'billing' ? '/reports' : role === 'agency_owner' ? '/clients' : '/dashboard'
    return <Navigate to={dest} replace />
  }
  return <Outlet />
}

export function RoleRoute({ roles }: { roles: OrganizationRole[] }) {
  const { session } = useAuth()
  if (!session?.organization || !roles.includes(session.organization.role)) return <Navigate to="/forbidden" replace />
  return <Outlet />
}

export function AdminRoute() {
  const { session } = useAuth()
  const platformRole = session?.user.platformRole
  if (!['owner', 'admin'].includes(platformRole ?? 'user') || !session?.user.mfaEnabled) return <Navigate to="/forbidden" replace />
  return <Outlet />
}
