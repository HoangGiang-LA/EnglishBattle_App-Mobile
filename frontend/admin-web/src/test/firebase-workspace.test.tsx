import { act, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import App from '../App'
import { FirebaseAdminService, type CallableTransport } from '../data/firebase-service'
import { service as demo } from '../data/mock-service'
import { createSeed } from '../data/seed'
import { calculateOverview } from '../data/metrics'
import { defaultRange } from '../lib'
import { adminSession, createAuthStub } from './auth-stub'

// These UI tests inject the transport/auth; they do not claim emulator coverage.
describe('Firebase workspace integration with injected transport', () => {
  it('shows API failure and retry without falling back to sample data or exposing demo tools', async () => {
    const fallback = vi.spyOn(demo, 'overview')
    const transport = vi
      .fn<CallableTransport>()
      .mockRejectedValue(new Error('Admin callable unavailable'))
    const api = new FirebaseAdminService(transport),
      auth = createAuthStub(adminSession)
    render(<App api={api} authLoader={auth.load} />)
    await screen.findByText('Firebase workspace')
    await screen.findByText('Admin callable unavailable')
    expect(fallback).not.toHaveBeenCalled()
    expect(screen.queryByText('Demo workspace')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reset demo data' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    fallback.mockRestore()
  })
  it.each(['functions/permission-denied', 'functions/unauthenticated'])(
    'unmounts old admin data on %s',
    async (code) => {
      const seed = createSeed(),
        auth = createAuthStub(adminSession)
      const api = new FirebaseAdminService(async (name) => {
        if (name === 'adminGetUser') throw { code }
        const data =
          name === 'adminGetProfile'
            ? { profile: seed.profile }
            : name === 'adminGetOverview'
              ? { overview: calculateOverview(seed, defaultRange()) }
              : name === 'adminListActivities'
                ? { page: { items: [], total: 0, page: 1, pageSize: 10 } }
                : { items: [] }
        return { data: { serverNow: 1, ...data } }
      })
      render(<App api={api} authLoader={auth.load} />)
      await screen.findByText('Total Users')
      await act(async () => {
        await expect(api.user('denied')).rejects.toEqual({ code })
      })
      await waitFor(() => expect(screen.queryByRole('navigation')).not.toBeInTheDocument())
      expect(screen.queryByText('Total Users')).not.toBeInTheDocument()
      expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument()
    },
  )
})
