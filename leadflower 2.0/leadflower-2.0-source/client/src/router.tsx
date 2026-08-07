import React from 'react'

export interface NavigateOptions {
  replace?: boolean
  state?: unknown
}

export interface LocationValue {
  pathname: string
  search: string
  hash: string
  state: unknown
}

type NavigateFunction = (to: string | number, options?: NavigateOptions) => void

interface RouteObject {
  path?: string
  index?: boolean
  element: React.ReactElement
  children?: RouteObject[]
}

interface RouterDefinition { routes: RouteObject[] }

interface RouterContextValue extends LocationValue { navigate: NavigateFunction }

const RouterContext = React.createContext<RouterContextValue | null>(null)
const OutletContext = React.createContext<React.ReactNode>(null)
const ParamsContext = React.createContext<Record<string, string>>({})

function currentLocation(): LocationValue {
  return {
    pathname: window.location.pathname || '/',
    search: window.location.search,
    hash: window.location.hash,
    state: window.history.state?.logicflowerState,
  }
}

export function validateInternalTarget(to: string, origin: string): string {
  const candidate = String(to || '/')
  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\')) {
    throw new Error('Navigation target must be a same-origin absolute path')
  }
  const parsed = new URL(candidate, origin)
  let decodedPath: string
  try { decodedPath = decodeURIComponent(parsed.pathname) } catch { throw new Error('Navigation target has invalid encoding') }
  if (parsed.origin !== origin || decodedPath.includes('\\') || /[\u0000-\u001f\u007f]/.test(decodedPath)) throw new Error('Cross-origin navigation is not allowed')
  return `${parsed.pathname}${parsed.search}${parsed.hash}`
}

function internalTarget(to: string): string {
  return validateInternalTarget(to, window.location.origin)
}

function useRouter(): RouterContextValue {
  const value = React.useContext(RouterContext)
  if (!value) throw new Error('Router hook used outside RouterProvider')
  return value
}

export function matchPathPattern(pattern: string, pathname: string): { matched: boolean; params: Record<string, string> } {
  if (pattern === '*') return { matched: true, params: {} }
  const patternParts = pattern.split('/').filter(Boolean)
  const pathParts = pathname.split('/').filter(Boolean)
  if (patternParts.length !== pathParts.length) return { matched: false, params: {} }
  const params: Record<string, string> = {}
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index]!
    const actual = pathParts[index]!
    if (expected.startsWith(':')) {
      try {
        const value = decodeURIComponent(actual)
        if (!value || value.includes('/') || value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) return { matched: false, params: {} }
        params[expected.slice(1)] = value
      }
      catch { return { matched: false, params: {} } }
    } else if (expected !== actual) return { matched: false, params: {} }
  }
  return { matched: true, params }
}

function Layer({ element, outlet, params }: { element: React.ReactElement; outlet: React.ReactNode; params: Record<string, string> }) {
  return <ParamsContext.Provider value={params}><OutletContext.Provider value={outlet}>{element}</OutletContext.Provider></ParamsContext.Provider>
}

function matchTree(routes: RouteObject[], pathname: string, inheritedParams: Record<string, string> = {}): React.ReactNode {
  for (const route of routes) {
    if (!route.path && !route.index) {
      const child = route.children ? matchTree(route.children, pathname, inheritedParams) : null
      if (child) return <Layer element={route.element} outlet={child} params={inheritedParams} />
      continue
    }
    const match = route.index
      ? { matched: pathname === '/', params: {} }
      : matchPathPattern(String(route.path), pathname)
    if (!match.matched) continue
    const params = { ...inheritedParams, ...match.params }
    const child = route.children ? matchTree(route.children, pathname, params) : null
    return <Layer element={route.element} outlet={child} params={params} />
  }
  return null
}

export function createBrowserRouter(routes: RouteObject[]): RouterDefinition {
  return { routes }
}

export function RouterProvider({ router }: { router: RouterDefinition }) {
  const [location, setLocation] = React.useState(currentLocation)
  React.useEffect(() => {
    const onPopState = () => setLocation(currentLocation())
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])
  const navigate = React.useCallback<NavigateFunction>((to, options = {}) => {
    if (typeof to === 'number') {
      window.history.go(to)
      return
    }
    const target = internalTarget(to)
    const state = { logicflowerState: options.state }
    if (options.replace) window.history.replaceState(state, '', target)
    else window.history.pushState(state, '', target)
    setLocation(currentLocation())
    if (!options.replace) window.scrollTo({ top: 0, behavior: 'auto' })
  }, [])
  const value = React.useMemo(() => ({ ...location, navigate }), [location, navigate])
  return <RouterContext.Provider value={value}>{matchTree(router.routes, location.pathname)}</RouterContext.Provider>
}

export function Outlet() {
  return <>{React.useContext(OutletContext)}</>
}

export function useLocation(): LocationValue {
  const { navigate: _navigate, ...location } = useRouter()
  return location
}

export function useNavigate(): NavigateFunction {
  return useRouter().navigate
}

export function useParams<T extends Record<string, string | undefined> = Record<string, string>>() {
  return React.useContext(ParamsContext) as T
}

export function useSearchParams(): [URLSearchParams, (next: URLSearchParams | Record<string, string>, options?: NavigateOptions) => void] {
  const router = useRouter()
  const params = React.useMemo(() => new URLSearchParams(router.search), [router.search])
  const setParams = React.useCallback((next: URLSearchParams | Record<string, string>, options?: NavigateOptions) => {
    const value = next instanceof URLSearchParams ? next : new URLSearchParams(next)
    const query = value.toString()
    router.navigate(`${router.pathname}${query ? `?${query}` : ''}${router.hash}`, options)
  }, [router])
  return [params, setParams]
}

export function Navigate({ to, replace, state }: { to: string; replace?: boolean; state?: unknown }) {
  const navigate = useNavigate()
  React.useEffect(() => { navigate(to, { replace, state }) }, [navigate, replace, state, to])
  return null
}

type LinkProps = Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'className'> & {
  to: string
  replace?: boolean
  state?: unknown
  className?: string | ((input: { isActive: boolean }) => string)
  end?: boolean
}

function isPlainActivation(event: React.MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.defaultPrevented && !event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey
}

export function Link({ to, replace, state, onClick, className, end, ...props }: LinkProps) {
  const router = useRouter()
  const href = internalTarget(to)
  const targetPath = new URL(href, window.location.origin).pathname
  const active = end ? router.pathname === targetPath : targetPath === '/' ? router.pathname === '/' : router.pathname === targetPath || router.pathname.startsWith(`${targetPath}/`)
  const resolvedClassName = typeof className === 'function' ? className({ isActive: active }) : className
  return <a {...props} className={resolvedClassName} href={href} onClick={(event) => {
    onClick?.(event)
    if (!isPlainActivation(event) || props.target && props.target !== '_self') return
    event.preventDefault()
    router.navigate(href, { replace, state })
  }} />
}

export const NavLink = Link
