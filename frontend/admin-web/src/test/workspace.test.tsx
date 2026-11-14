import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import App from '../App'
import { MockAdminService } from '../data/mock-service'
import { adminSession, createAuthStub } from './auth-stub'

async function demo() {
  const api = new MockAdminService(localStorage, 0),
    user = userEvent.setup(),
    auth = createAuthStub(adminSession)
  render(<App api={api} authLoader={auth.load} />)
  await screen.findByRole('heading', { name: 'Dashboard', level: 1 })
  await screen.findByText('Total Users')
  return { api, user, auth }
}
async function page(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(
    within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('link', {
      name: label,
    }),
  )
}

describe('Admin workspace frontend', () => {
  it('opens Dashboard after verified admin sign-in and signs out of Firebase', async () => {
    const api = new MockAdminService(undefined, 0),
      user = userEvent.setup(),
      auth = createAuthStub()
    render(<App api={api} authLoader={auth.load} />)
    await user.type(screen.getByLabelText('Email address'), 'admin@example.test')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByRole('alert')
    expect(screen.getByRole('alert')).toHaveTextContent('email or password is incorrect')
    expect(auth.gateway.signIn).toHaveBeenCalledWith('admin@example.test', 'password123')
    vi.mocked(auth.gateway.signIn).mockImplementation(async () => auth.emit(adminSession))
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByRole('heading', { name: 'Dashboard', level: 1 })
    expect(screen.getAllByText(adminSession.name).length).toBeGreaterThan(0)
    expect(
      within(screen.getByRole('navigation', { name: 'Main navigation' })).getAllByRole('link'),
    ).toHaveLength(6)
    await user.click(screen.getByRole('button', { name: 'English Battle' }))
    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    await screen.findByRole('heading', { name: 'Welcome back' })
    expect(auth.gateway.signOut).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem('english-battle.admin.demo-session')).toBeNull()
  })
  it('keeps all five sample pages accessible to a verified administrator', async () => {
    const { user } = await demo()
    for (const [nav, title] of [
      ['Dashboard', 'Dashboard'],
      ['Users', 'User Management'],
      ['Content', 'Question & Content'],
      ['Battles', 'Battle & Moderation'],
      ['Analytics', 'Analytics'],
    ]) {
      await page(user, nav)
      await screen.findByRole('heading', { name: title, level: 1 })
    }
    await screen.findByText('Most Popular Categories')
    expect(screen.getByRole('button', { name: 'Preview details' })).toHaveAttribute(
      'title',
      expect.stringContaining('No live admin data'),
    )
  })
  it('does not let a stale demo marker or a non-admin session open the workspace', async () => {
    sessionStorage.setItem('english-battle.admin.demo-session', 'demo')
    const api = new MockAdminService(undefined, 0)
    const profile = vi.spyOn(api, 'profile')
    const auth = createAuthStub({ ...adminSession, isAdmin: false })
    render(<App api={api} authLoader={auth.load} />)
    await screen.findByRole('heading', { name: 'Administrator access required' })
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open demo workspace' })).not.toBeInTheDocument()
    expect(profile).not.toHaveBeenCalled()
  })
  it('closes the workspace when server authorization fails while the session is active', async () => {
    const { auth } = await demo()
    act(() => auth.fail({ code: 'backend/access-denied' }))
    await screen.findByRole('heading', { name: 'Welcome back' })
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Administrator access was denied')
  })
  it('adds a user, filters and finds it, edits it and bans it with a reason', async () => {
    const { api, user } = await demo()
    await page(user, 'Users')
    await screen.findByRole('heading', { name: 'User Management' })
    await user.click(screen.getByRole('button', { name: 'Add User' }))
    let dialog = screen.getByRole('dialog')
    await user.type(within(dialog).getByLabelText('Full name'), 'Frontend Test Learner')
    await user.type(within(dialog).getByLabelText('Email address'), 'frontend-test@example.test')
    await user.click(within(dialog).getByRole('button', { name: 'Add user' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await user.type(
      screen.getByRole('searchbox', { name: 'Search by name, email or ID…' }),
      'frontend-test@example.test',
    )
    await screen.findByRole('button', { name: 'Edit Frontend Test Learner' })
    await user.click(screen.getByRole('button', { name: 'Edit Frontend Test Learner' }))
    dialog = screen.getByRole('dialog')
    await user.clear(within(dialog).getByLabelText('Full name'))
    await user.type(within(dialog).getByLabelText('Full name'), 'Edited Learner')
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }))
    await screen.findByRole('button', { name: 'Edit Edited Learner' })
    await user.click(screen.getByRole('button', { name: 'Edit Edited Learner' }))
    await user.click(screen.getByRole('button', { name: 'Ban user' }))
    dialog = screen.getByRole('dialog')
    await user.type(within(dialog).getByLabelText('Reason'), 'Review requested by admin')
    await user.click(within(dialog).getByRole('button', { name: 'Ban user' }))
    await waitFor(async () =>
      expect((await api.users({ q: 'frontend-test@example.test' })).items[0].status).toBe('banned'),
    )
    await screen.findByText('Banned')
  })
  it('requires an explicit account code before deleting and records the action', async () => {
    const { api, user } = await demo()
    await page(user, 'Users')
    await screen.findByRole('button', { name: 'Delete Emma Wilson' })
    await user.click(screen.getByRole('button', { name: 'Delete Emma Wilson' }))
    const dialog = screen.getByRole('dialog'),
      confirm = within(dialog).getByRole('button', { name: 'Delete user' })
    expect(confirm).toBeDisabled()
    await user.type(within(dialog).getByLabelText('Reason'), 'Account deletion requested')
    expect(confirm).toBeDisabled()
    await user.type(within(dialog).getByLabelText('Type #24892 to confirm'), '#24892')
    await user.click(confirm)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect((await api.user('demo-user-1')).status).toBe('deleted')
    expect((await api.audit()).items[0].action).toBe('user.deleted')
  })
  it('creates a published question with a correct answer, previews it and archives it', async () => {
    const { api, user } = await demo()
    await page(user, 'Content')
    await screen.findByRole('button', { name: 'Add Question' })
    await user.click(screen.getByRole('button', { name: 'Add Question' }))
    await screen.findByLabelText('Question text')
    await user.type(screen.getByLabelText('Question text'), 'Which word means a close friend?')
    for (const [i, text] of ['Companion', 'Mountain', 'Calendar', 'Window'].entries())
      await user.type(screen.getByLabelText(`Option ${String.fromCharCode(65 + i)} text`), text)
    await user.click(screen.getByRole('radio', { name: 'Option A is correct' }))
    await user.type(
      screen.getByLabelText('Answer explanation'),
      'A companion is a friend you spend time with.',
    )
    await user.selectOptions(screen.getByLabelText('Publication status'), 'published')
    await user.click(screen.getByRole('button', { name: 'Learner preview' }))
    expect(
      screen.queryByText('A companion is a friend you spend time with.'),
    ).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Back to details' }))
    await user.click(screen.getByRole('button', { name: 'Save question' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const q = (await api.questions({ q: 'close friend' })).items[0]
    expect(q.status).toBe('published')
    await user.type(
      screen.getByRole('searchbox', { name: 'Search by question text or ID…' }),
      q.code,
    )
    await screen.findByRole('button', { name: `Archive ${q.code}` })
    await user.click(screen.getByRole('button', { name: `Archive ${q.code}` }))
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Archive question' }),
    )
    await waitFor(async () => expect((await api.question(q.id)).status).toBe('archived'))
  })
  it('supports content tabs, new topics and lessons with their parent relationship', async () => {
    const { api, user } = await demo()
    await page(user, 'Content')
    await screen.findByRole('tab', { name: /Topics/ })
    await user.click(screen.getByRole('tab', { name: /Topics/ }))
    await user.click(screen.getByRole('button', { name: 'Add Topic' }))
    await user.type(screen.getByLabelText('Title'), 'Frontend topic')
    await user.click(screen.getByRole('button', { name: 'Save content' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await user.click(screen.getByRole('tab', { name: /Lessons/ }))
    await user.click(screen.getByRole('button', { name: 'Add Lesson' }))
    await user.type(screen.getByLabelText('Title'), 'Frontend lesson')
    const topic = (await api.catalog()).topics.find((t) => t.title === 'Frontend topic')!
    await screen.findByRole('option', { name: 'Frontend topic' })
    await user.selectOptions(screen.getByLabelText('Topic'), topic.id)
    await user.click(screen.getByRole('button', { name: 'Save content' }))
    await waitFor(async () =>
      expect(
        (await api.catalog()).lessons.some(
          (l) => l.title === 'Frontend lesson' && l.topicId === topic.id,
        ),
      ).toBe(true),
    )
  })
  it('filters private matches and opens a real mock event log, then handles a no-results query', async () => {
    const { user } = await demo()
    await page(user, 'Battles')
    await screen.findByLabelText('Battle mode')
    await user.selectOptions(screen.getByLabelText('Battle mode'), 'private')
    await screen.findByRole('button', { name: 'View logs #B18640' })
    await user.click(screen.getByRole('button', { name: 'View logs #B18640' }))
    await screen.findByText('Room created with a fixed set of 10 questions.')
    expect(screen.getByText('30 seconds')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Close log' }))
    await user.type(
      screen.getByRole('searchbox', { name: 'Search by match ID…' }),
      'does-not-exist',
    )
    await screen.findByRole('heading', { name: 'No matches found' })
    await user.click(screen.getByRole('button', { name: 'Clear search & filters' }))
    await screen.findByRole('button', { name: 'View logs #B18642' })
  })
  it('uses global search, marks notifications read and previews a recoverable error', async () => {
    const { api, user } = await demo()
    await user.type(screen.getByRole('textbox', { name: 'Search anything' }), '#B18642')
    await screen.findByRole('button', { name: /#B18642.*Battle/ })
    await user.click(screen.getByRole('button', { name: /#B18642.*Battle/ }))
    await screen.findByRole('heading', { name: 'Battle & Moderation' })
    await user.click(screen.getByRole('button', { name: 'Notifications, 2 unread' }))
    await user.click(screen.getByRole('button', { name: 'Mark all read' }))
    await waitFor(async () => expect((await api.notifications()).unreadTotal).toBe(0))
    await user.click(screen.getByRole('button', { name: 'Preview details' }))
    await user.click(screen.getByRole('button', { name: 'Preview loading error' }))
    await screen.findByRole('heading', { name: 'We couldn’t load this data' })
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByRole('heading', { name: 'Battle & Moderation' })
  })
  it('loads another user page, exports a CSV and changes the analytics period', async () => {
    const { user } = await demo()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await page(user, 'Users')
    await screen.findByRole('button', { name: 'Next page' })
    await user.click(screen.getByRole('button', { name: 'Next page' }))
    await screen.findByText('Showing 11–20 of 54 users')
    await user.click(screen.getByRole('button', { name: 'Export report' }))
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1))
    expect(URL.createObjectURL).toHaveBeenCalled()
    await page(user, 'Analytics')
    await screen.findByLabelText('Quick date range')
    await user.selectOptions(screen.getByLabelText('Quick date range'), '180')
    await screen.findByText('Most Popular Categories')
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-10-24' } })
    await screen.findByText('Most Popular Categories')
  })
})
