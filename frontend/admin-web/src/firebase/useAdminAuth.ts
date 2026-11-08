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
  const currentSession = useRef<FirebaseSession | null>(null)
  const identity = useRef(0)
  const actionGeneration = useRef(0)

  const publish = (value: FirebaseSession | null) => {
    const previous = currentSession.current
    if (previous?.uid !== value?.uid || previous?.isAdmin !== value?.isAdmin) identity.current++
    currentSession.current = value
    setSession(value)
  }
  useEffect(() => {
    let closed = false
    let unsubscribe: (() => void) | undefined
    mounted.current = true
    gateway.current = null
    actionGeneration.current++
    running.current = false
    setBusy(false)
    setReady(false)
    setChecking(true)
    publish(null)
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
            publish(value)
            setChecking(false)
            setError('')
          },
          (failure) => {
            if (closed) return
            publish(null)
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
      actionGeneration.current++
      running.current = false
      unsubscribe?.()
    }
  }, [loadGateway, revision])

  async function run(action: (api: AuthGateway, isCurrent: () => boolean) => Promise<void>) {
    const api = gateway.current
    if (running.current || !api) return
    const generation = ++actionGeneration.current
    const account = identity.current
    const isCurrent = () =>
      mounted.current &&
      gateway.current === api &&
      actionGeneration.current === generation &&
      identity.current === account
    running.current = true
    setBusy(true)
    setError('')
    try {
      await action(api, isCurrent)
    } catch (failure) {
      if (isCurrent()) setError(authError(failure))
    } finally {
      if (gateway.current === api && actionGeneration.current === generation) {
        running.current = false
        if (mounted.current) setBusy(false)
      }
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
      run(async (api, isCurrent) => {
        await api.signOut()
        if (isCurrent()) publish(null)
      }),
    refresh: () =>
      run(async (api, isCurrent) => {
        const refreshed = await api.refresh()
        if (isCurrent()) publish(refreshed)
      }),
    invalidate: (failure: string) => {
      actionGeneration.current++
      running.current = false
      publish(null)
      setBusy(false)
      setError(failure)
    },
    retrySetup: () => {
      if (reloadRequired) window.location.reload()
      else setRevision((value) => value + 1)
    },
  }
}

export type AdminAuthController = ReturnType<typeof useAdminAuth>
