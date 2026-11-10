import { useEffect, useRef, useState } from 'react'
import {
  authError,
  isAuthModuleLoadError,
  loadAuthGateway,
  type AuthGateway,
  type FirebaseSession,
} from './auth'

export function useAdminAuth(loadGateway: () => Promise<AuthGateway> = loadAuthGateway) {
  const [session, setSession] = useState<FirebaseSession | null>(null)
  const [checking, setChecking] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const [reloadRequired, setReloadRequired] = useState(false)
  const [revision, setRevision] = useState(0)
  const gateway = useRef<AuthGateway | null>(null)
  const mounted = useRef(true)
  const running = useRef(false)

  useEffect(() => {
    let closed = false
    let unsubscribe: (() => void) | undefined
    mounted.current = true
    gateway.current = null
    setReady(false)
    setChecking(true)
    setSession(null)
    setError('')
    setReloadRequired(false)
    void loadGateway()
      .then((api) => {
        if (closed) return
        gateway.current = api
        setReady(true)
        unsubscribe = api.subscribe(
          (value) => {
            if (closed) return
            setSession(value)
            setChecking(false)
            setError('')
          },
          (failure) => {
            if (closed) return
            setSession(null)
            setChecking(false)
            setError(authError(failure))
          },
        )
      })
      .catch((failure) => {
        if (closed) return
        gateway.current = null
        setReady(false)
        setChecking(false)
        setReloadRequired(isAuthModuleLoadError(failure))
        setError(authError(failure))
      })
    return () => {
      closed = true
      mounted.current = false
      gateway.current = null
      unsubscribe?.()
    }
  }, [loadGateway, revision])

  useEffect(() => {
    const lost = (event: Event) => {
      setSession(null)
      setError(authError((event as CustomEvent<unknown>).detail))
    }
    window.addEventListener('admin:access-lost', lost)
    return () => window.removeEventListener('admin:access-lost', lost)
  }, [])
  async function run(action: (api: AuthGateway) => Promise<void>) {
    if (running.current || !gateway.current) return
    running.current = true
    setBusy(true)
    setError('')
    try {
      await action(gateway.current)
    } catch (failure) {
      if (mounted.current) setError(authError(failure))
    } finally {
      running.current = false
      if (mounted.current) setBusy(false)
    }
  }

  return {
    session,
    checking,
    busy,
    error,
    ready,
    reloadRequired,
    signIn: (email: string, password: string) => run((api) => api.signIn(email, password)),
    signOut: () =>
      run(async (api) => {
        await api.signOut()
        if (mounted.current) setSession(null)
      }),
    refresh: () =>
      run(async (api) => {
        if (mounted.current) setSession(null)
        const refreshed = await api.refresh()
        if (mounted.current) setSession(refreshed)
      }),
    retrySetup: () => {
      if (reloadRequired) window.location.reload()
      else setRevision((value) => value + 1)
    },
  }
}

export type AdminAuthController = ReturnType<typeof useAdminAuth>
