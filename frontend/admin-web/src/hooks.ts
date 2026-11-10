import { useCallback, useEffect, useRef, useState } from 'react'
import { message } from './lib'

export function useResource<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0),
    latest = useRef(loader),
    generation = useRef(0)
  latest.current = loader
  const reload = useCallback(() => setRevision((v) => v + 1), [])
  useEffect(() => {
    const current = ++generation.current
    setLoading(true)
    setError('')
    latest
      .current()
      .then((value) => {
        if (generation.current === current) setData(value)
      })
      .catch((e) => {
        if (generation.current === current) {
          setData(null)
          setError(message(e))
        }
      })
      .finally(() => {
        if (generation.current === current) setLoading(false)
      })
    return () => {
      generation.current++
    }
    // Callers provide stable primitive dependencies; loader identity is intentionally ignored.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, revision])
  useEffect(() => {
    window.addEventListener('admin:data', reload)
    return () => window.removeEventListener('admin:data', reload)
  }, [reload])
  return { data, error, loading, reload }
}
export function useDebounced<T>(value: T, ms = 200) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return debounced
}
export function useRoute() {
  const get = () => window.location.hash.slice(1) || '/dashboard'
  const [route, setRoute] = useState(get)
  useEffect(() => {
    const change = () => setRoute(get())
    window.addEventListener('hashchange', change)
    return () => window.removeEventListener('hashchange', change)
  }, [])
  const navigate = (path: string) => {
    window.location.hash = path
  }
  const [path, params] = route.split('?')
  return { path, params: new URLSearchParams(params), navigate }
}
