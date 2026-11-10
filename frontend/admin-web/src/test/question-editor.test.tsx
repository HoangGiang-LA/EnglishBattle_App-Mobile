import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { QuestionEditor } from '../pages/QuestionEditor'
import { AdminContext } from '../context'
import { MockAdminService } from '../data/mock-service'
import { createSeed } from '../data/seed'
import { defaultRange } from '../lib'

it('direct Save after editing forwards the new text and expectedVersion without requiring preview', async () => {
  const api = new MockAdminService(undefined, 0),
    question = createSeed().questions[0]
  const save = vi
    .spyOn(api, 'saveQuestion')
    .mockResolvedValue({ ...question, prompt: 'Updated question directly' })
  render(
    <AdminContext.Provider
      value={{ api, toast: vi.fn(), navigate: vi.fn(), range: defaultRange(), setRange: vi.fn() }}
    >
      <QuestionEditor question={question} onClose={vi.fn()} />
    </AdminContext.Provider>,
  )
  const input = await screen.findByLabelText('Question text'),
    user = userEvent.setup()
  await user.clear(input)
  await user.type(input, 'Updated question directly')
  await user.click(screen.getByRole('button', { name: /^Save question$/ }))
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'Updated question directly' }),
      question.id,
      question.version,
    ),
  )
})

it('keeps draft fields editable while the parent refreshes its catalog and avoids another API read', async () => {
  const api = new MockAdminService(undefined, 0),
    seed = createSeed(),
    question = seed.questions[0]
  const catalog = { categories: seed.categories, topics: seed.topics, lessons: seed.lessons }
  const load = vi.spyOn(api, 'catalog').mockImplementation(() => new Promise(() => {}))
  const save = vi
    .spyOn(api, 'saveQuestion')
    .mockResolvedValue({ ...question, prompt: 'Preserved draft through refresh' })
  const value = { api, toast: vi.fn(), navigate: vi.fn(), range: defaultRange(), setRange: vi.fn() }
  const view = render(
    <AdminContext.Provider value={value}>
      <QuestionEditor question={question} catalogData={catalog} onClose={vi.fn()} />
    </AdminContext.Provider>,
  )
  const user = userEvent.setup(),
    input = await screen.findByLabelText('Question text')
  await user.clear(input)
  await user.type(input, 'Preserved draft through refresh')
  view.rerender(
    <AdminContext.Provider value={value}>
      <QuestionEditor question={question} catalogData={{ ...catalog }} onClose={vi.fn()} />
    </AdminContext.Provider>,
  )
  expect(screen.getByLabelText('Question text')).toHaveValue('Preserved draft through refresh')
  await user.click(screen.getByRole('button', { name: /^Save question$/ }))
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'Preserved draft through refresh' }),
      question.id,
      question.version,
    ),
  )
  expect(load).not.toHaveBeenCalled()
})
