import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import App from '../App'
import { MockAdminService } from '../data/mock-service'
import { FirebaseAdminService } from '../data/firebase-service'
import { adminSession, createAuthStub } from './auth-stub'

async function open(campaignError?: Error) {
  window.location.hash = '/notifications'
  const api = new MockAdminService(undefined, 0),
    auth = createAuthStub(adminSession)
  if (campaignError) vi.spyOn(api, 'campaigns').mockRejectedValue(campaignError)
  render(<App api={api} authLoader={auth.load} />)
  await screen.findByRole('heading', { name: 'Notifications', level: 1 })
  return { api, user: userEvent.setup() }
}
async function message(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Title'), 'November reward')
  await user.type(screen.getByLabelText('Message'), 'Keep learning every day.')
  await user.type(screen.getByLabelText('Admin reason'), 'Monthly learning campaign')
}

describe('Notifications page', () => {
  it('shows a history error without falsely claiming there were no sends, and can retry', async () => {
    const { api, user } = await open(new Error('Campaign indexes are missing'))
    await screen.findByText('Campaign indexes are missing')
    expect(screen.queryByText('No sends yet')).not.toBeInTheDocument()
    vi.mocked(api.campaigns).mockResolvedValue([])
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByText('No sends yet')
    expect(screen.queryByText('Campaign indexes are missing')).not.toBeInTheDocument()
  })
  it('reviews an all-account notification and shows its accepted history', async () => {
    const { api, user } = await open(),
      send = vi.spyOn(api, 'createCampaign')
    expect(screen.getByRole('button', { name: 'Review send' })).toBeDisabled()
    await user.selectOptions(screen.getByLabelText('Recipients'), 'all')
    await message(user)
    await user.click(screen.getByRole('button', { name: 'Review send' }))
    const review = screen.getByRole('dialog', { name: 'Review your send' })
    expect(within(review).getByText(/Only opted-in accounts/)).toBeVisible()
    expect(send).not.toHaveBeenCalled()
    await user.click(within(review).getByRole('button', { name: 'Confirm send' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ audience: 'all', kind: 'notification', recipientIds: [] }),
      'Monthly learning campaign',
    )
    expect(await screen.findByText('November reward')).toBeVisible()
  })

  it('credits only the selected wallet and preserves a selection across account search', async () => {
    const { api, user } = await open(),
      send = vi.spyOn(api, 'createCampaign')
    await user.click(screen.getByRole('button', { name: /Coin gift/ }))
    await waitFor(() => expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(0))
    await user.click(screen.getAllByRole('checkbox')[0])
    await user.type(screen.getByRole('searchbox'), 'no-matching-person')
    expect(screen.getByText(/1\/50 selected/)).toBeVisible()
    await user.clear(screen.getByLabelText('Coins per account'))
    await user.type(screen.getByLabelText('Coins per account'), '25')
    await message(user)
    await user.click(screen.getByRole('button', { name: 'Review send' }))
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm send' }),
    )
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    const sent = send.mock.calls[0][0]
    expect(sent.recipientIds).toHaveLength(1)
    expect(sent).toMatchObject({ kind: 'coins', coinAmount: 25, destination: 'Wallet' })
  })

  it('keeps an uncertain request locked and retries the same content', async () => {
    const { api, user } = await open(),
      original = api.createCampaign.bind(api)
    const send = vi
      .spyOn(api, 'createCampaign')
      .mockRejectedValueOnce(new Error('Network timeout'))
      .mockImplementationOnce(original)
    await user.selectOptions(screen.getByLabelText('Recipients'), 'all')
    await message(user)
    await user.click(screen.getByRole('button', { name: 'Review send' }))
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm send' }),
    )
    await within(screen.getByRole('dialog')).findByText('Network timeout')
    expect(screen.getByLabelText('Title')).toBeDisabled()
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Retry same request' }),
    )
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    expect(send.mock.calls[1]).toEqual(send.mock.calls[0])
  })

  it('restores the campaign requestId after a timeout and reload', async () => {
    const payloads: Record<string, unknown>[] = []
    const transport = vi.fn(async (_action: string, data: Record<string, unknown>) => {
      payloads.push(data)
      if (payloads.length === 1) throw new Error('Network timeout')
      return { campaign: { id: 'accepted' } }
    })
    const input = {
      kind: 'coins' as const,
      audience: 'selected' as const,
      title: 'Gift',
      body: 'A gift',
      destination: 'Wallet' as const,
      coinAmount: 10,
      recipientIds: ['learner'],
    }
    const first = new FirebaseAdminService('admin', transport, sessionStorage)
    await expect(first.createCampaign(input, 'Support')).rejects.toThrow()
    const restored = new FirebaseAdminService('admin', transport, sessionStorage)
    expect(restored.pendingCampaign()?.input).toEqual(input)
    await restored.createCampaign(input, 'Support')
    expect(payloads[1]).toEqual(payloads[0])
    expect(restored.pendingCampaign()).toBeNull()
  })
})
