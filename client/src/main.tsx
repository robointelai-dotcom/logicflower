import React from 'react'
import ReactDOM from 'react-dom/client'
import { createBrowserRouter, Navigate, RouterProvider } from './router'
import { AuthProvider, useAuth } from './auth/AuthContext'
import Shell from './components/Shell'
import { AdminRoute, ProtectedRoute, PublicOnlyRoute, RoleRoute } from './components/RouteGuards'
import { LoadingState } from './components/ui'
import './styles.css'

const HomePage = React.lazy(() => import('./pages/HomePage'))
const LoginPage = React.lazy(() => import('./pages/AuthPages').then((module) => ({ default: module.LoginPage })))
const RegisterPage = React.lazy(() => import('./pages/AuthPages').then((module) => ({ default: module.RegisterPage })))
const ForgotPasswordPage = React.lazy(() => import('./pages/AuthPages').then((module) => ({ default: module.ForgotPasswordPage })))
const ResetPasswordPage = React.lazy(() => import('./pages/AuthPages').then((module) => ({ default: module.ResetPasswordPage })))
const MfaChallengePage = React.lazy(() => import('./pages/AuthPages').then((module) => ({ default: module.MfaChallengePage })))
const MfaSetupPage = React.lazy(() => import('./pages/AuthPages').then((module) => ({ default: module.MfaSetupPage })))
const DashboardPage = React.lazy(() => import('./pages/DashboardPage'))
const TeamPage = React.lazy(() => import('./pages/TeamPage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))
const OAuthReturnPage = React.lazy(() => import('./pages/ConnectionsPage').then((module) => ({ default: module.OAuthReturnPage })))
const WorkflowsPage = React.lazy(() => import('./pages/WorkflowsPage'))
const WorkflowBuilderPage = React.lazy(() => import('./pages/WorkflowBuilderPage'))
const ExecutionsPage = React.lazy(() => import('./pages/ExecutionsPage'))
const BatchesPage = React.lazy(() => import('./pages/BatchesPage'))
const MonitoringPage = React.lazy(() => import('./pages/MonitoringPage'))
const VaultPage = React.lazy(() => import('./pages/VaultPage'))
const NotificationsPage = React.lazy(() => import('./pages/NotificationsPage'))
const ReportsPage = React.lazy(() => import('./pages/ReportsPage'))
const BillingPage = React.lazy(() => import('./pages/BillingPage'))
const AuditPage = React.lazy(() => import('./pages/AuditPage'))
const SettingsPage = React.lazy(() => import('./pages/SettingsPage'))
const AdminPage = React.lazy(() => import('./pages/AdminPage'))
const OnboardingPage = React.lazy(() => import('./pages/OnboardingPage'))
const ForbiddenPage = React.lazy(() => import('./pages/SystemPages').then((module) => ({ default: module.ForbiddenPage })))
const NotFoundPage = React.lazy(() => import('./pages/SystemPages').then((module) => ({ default: module.NotFoundPage })))
const HelpCenterPage = React.lazy(() => import('./pages/SystemPages').then((module) => ({ default: module.HelpCenterPage })))
const StatusPage = React.lazy(() => import('./pages/SystemPages').then((module) => ({ default: module.StatusPage })))

function WorkspaceHome() {
  const { session } = useAuth()
  if (session?.organization?.role === 'billing') return <Navigate to="/reports" replace />
  return <DashboardPage />
}

const router = createBrowserRouter([
  { path: '/', element: <HomePage /> },
  { path: '/help', element: <HelpCenterPage /> },
  { path: '/status', element: <StatusPage /> },
  { element: <PublicOnlyRoute />, children: [
    { path: '/login', element: <LoginPage /> },
    { path: '/register', element: <RegisterPage /> },
    { path: '/forgot-password', element: <ForgotPasswordPage /> },
    { path: '/reset-password', element: <ResetPasswordPage /> },
    { path: '/mfa-challenge', element: <MfaChallengePage /> },
  ] },
  { element: <ProtectedRoute />, children: [
    { path: '/mfa-setup', element: <MfaSetupPage /> },
    { path: '/connections/oauth/return', element: <OAuthReturnPage /> },
    { element: <Shell />, children: [
      { path: '/dashboard', element: <WorkspaceHome /> },
      { element: <RoleRoute roles={['owner', 'admin', 'operator', 'viewer']} />, children: [
        { path: '/connections', element: <ConnectionsPage /> },
        { path: '/workflows', element: <WorkflowsPage /> },
        { path: '/workflows/:id/builder', element: <WorkflowBuilderPage /> },
        { path: '/executions', element: <ExecutionsPage /> },
        { path: '/batches', element: <BatchesPage /> },
        { path: '/monitoring', element: <MonitoringPage /> },
        { path: '/vault', element: <VaultPage /> },
        { path: '/notifications', element: <NotificationsPage /> },
        { path: '/audit', element: <AuditPage /> },
        { path: '/onboarding', element: <OnboardingPage /> },
      ] },
      { path: '/reports', element: <ReportsPage /> },
      { path: '/settings', element: <SettingsPage /> },
      { element: <RoleRoute roles={['owner', 'admin']} />, children: [
        { path: '/team', element: <TeamPage /> },
      ] },
      { element: <RoleRoute roles={['owner', 'billing']} />, children: [
        { path: '/billing', element: <BillingPage /> },
      ] },
      { element: <AdminRoute />, children: [{ path: '/admin', element: <AdminPage /> }] },
      { path: '/forbidden', element: <ForbiddenPage /> },
    ] },
  ] },
  { path: '*', element: <NotFoundPage /> },
])

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><AuthProvider><React.Suspense fallback={<LoadingState label="Opening LogicFlower" />}><RouterProvider router={router} /></React.Suspense></AuthProvider></React.StrictMode>,
)
