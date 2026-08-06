import React from 'react'
import { errorMessage } from '../api/client'

export interface QueryState<T> {
  data: T | null
  loading: boolean
  error: string | null
  reload: () => Promise<void>
  setData: React.Dispatch<React.SetStateAction<T | null>>
}

export function useApi<T>(loader: () => Promise<T>, dependencies: React.DependencyList = []): QueryState<T> {
  const [data, setData] = React.useState<T | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const mounted = React.useRef(true)

  React.useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const reload = React.useCallback(async () => {
    setLoading(true)
    try {
      const value = await loader()
      if (!mounted.current) return
      setData(value)
      setError(null)
    } catch (loadError) {
      if (mounted.current) setError(errorMessage(loadError))
    } finally {
      if (mounted.current) setLoading(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies)

  React.useEffect(() => { void reload() }, [reload])
  return { data, loading, error, reload, setData }
}

export function useAction() {
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [success, setSuccess] = React.useState<string | null>(null)

  const run = React.useCallback(async <T,>(action: () => Promise<T>, successMessage?: string): Promise<T | undefined> => {
    setLoading(true)
    setError(null)
    setSuccess(null)
    try {
      const result = await action()
      if (successMessage) setSuccess(successMessage)
      return result
    } catch (actionError) {
      setError(errorMessage(actionError))
      return undefined
    } finally {
      setLoading(false)
    }
  }, [])

  return { loading, error, success, run, clear: () => { setError(null); setSuccess(null) } }
}
