import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { GrowthChart, SkillDonut } from '../charts'

it('keeps every server-aggregated week instead of sampling it again as daily data', () => {
  const series = ['2026-10-19', '2026-10-26', '2026-11-02'].map((date, i) => ({
    date,
    users: i + 1,
    previous: 0,
    lessons: 1,
    battles: 1,
    active: 1,
  }))
  render(<GrowthChart series={series} group="weekly" preAggregated />)
  expect(screen.getByRole('img')).toHaveAttribute(
    'aria-label',
    'User growth, weekly. 3 users at the end of the selected period.',
  )
  expect(screen.getByText('Oct 26')).toBeInTheDocument()
})

it('skill distribution displays answer counts when mixed sessions belong to multiple skills', () => {
  render(
    <SkillDonut
      basis="answers"
      categories={[
        {
          id: 'vocabulary',
          name: 'Vocabulary',
          lessons: 1,
          battles: 1,
          answered: 6,
          correct: 4,
          started: 1,
          completed: 1,
        },
        {
          id: 'reading',
          name: 'Reading',
          lessons: 1,
          battles: 1,
          answered: 4,
          correct: 2,
          started: 1,
          completed: 1,
        },
      ]}
    />,
  )
  expect(screen.getByRole('img')).toHaveAttribute(
    'aria-label',
    'Skill distribution: 10 answered questions',
  )
  expect(screen.getByText('6 answers')).toBeInTheDocument()
  expect(screen.getByText('60%')).toBeInTheDocument()
})
