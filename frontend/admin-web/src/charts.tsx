import { useEffect, useId, useRef, useState } from 'react'
import type { Overview } from './domain'
import { number } from './lib'

function linePath(points: { x: number; y: number }[]) {
  if (points.length < 2) return points.length ? `M${points[0].x},${points[0].y}` : ''
  return points
    .map((p, i) =>
      i === 0
        ? `M${p.x},${p.y}`
        : `C${(points[i - 1].x + p.x) / 2},${points[i - 1].y} ${(points[i - 1].x + p.x) / 2},${p.y} ${p.x},${p.y}`,
    )
    .join(' ')
}
export function Sparkline({ color = '#665cff', values }: { color?: string; values: number[] }) {
  const id = useId().replaceAll(':', ''),
    min = Math.min(...values),
    max = Math.max(...values),
    delta = max - min
  const d = linePath(
    values.map((n, i) => ({
      x: (i * 108) / Math.max(1, values.length - 1),
      y: delta ? 32 - ((n - min) / delta) * 26 : 22,
    })),
  )
  return (
    <svg className="sparkline" width="120" height="44" viewBox="0 0 110 40" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop stopColor={color} stopOpacity=".1" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${d} L108,40 L0,40 Z`} fill={`url(#${id})`} />
      <path d={d} fill="none" stroke={color} strokeWidth="1.8" />
    </svg>
  )
}
export function GrowthChart({
  series,
  group,
  preAggregated = false,
}: {
  series: Overview['series']
  group: string
  preAggregated?: boolean
}) {
  const svg = useRef<SVGSVGElement>(null),
    [width, setWidth] = useState(960)
  useEffect(() => {
    if (!svg.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w && w >= 200) setWidth(w)
    })
    observer.observe(svg.current)
    return () => observer.disconnect()
  }, [])
  const id = useId().replaceAll(':', ''),
    step = group === 'weekly' ? 7 : group === 'monthly' ? 30 : 1
  const rows = preAggregated
    ? series
    : series.filter((_, i) => i % step === 0 || i === series.length - 1)
  const max = Math.max(5, ...rows.flatMap((d) => [d.users, d.previous])) + 5,
    height = 172
  const points = (key: 'users' | 'previous') =>
    rows.map((d, i) => ({
      x: 45 + (i * (width - 55)) / Math.max(1, rows.length - 1),
      y: height - 25 - (d[key] / max) * (height - 35),
    }))
  const d = linePath(points('users')),
    baseline = height - 25
  return (
    <svg
      ref={svg}
      className="growth-chart"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`User growth, ${group}. ${rows.length ? rows[rows.length - 1].users : 0} users at the end of the selected period.`}
    >
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop stopColor="#665cff" stopOpacity=".08" />
          <stop offset="1" stopColor="#665cff" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0, 1, 2, 3, 4].map((i) => {
        const y = 10 + (i * (height - 35)) / 4
        return (
          <g key={i}>
            <line x1="45" x2={width - 10} y1={y} y2={y} stroke="#eef0f6" />
            <text x="5" y={y + 4} fill="#8893a8" fontSize="10">
              {Math.round((max * (4 - i)) / 4)}
            </text>
          </g>
        )
      })}
      {d && (
        <>
          <path
            d={`${d} L${points('users').at(-1)!.x},${baseline} L45,${baseline} Z`}
            fill={`url(#${id})`}
          />
          <path
            d={linePath(points('previous'))}
            fill="none"
            stroke="#bcc5dd"
            strokeWidth="1.5"
            strokeDasharray="4 4"
          />
          <path d={d} fill="none" stroke="#665cff" strokeWidth="2" />
        </>
      )}
      {rows
        .filter(
          (_, i) =>
            i === 0 || i === rows.length - 1 || i % Math.max(1, Math.floor(rows.length / 5)) === 0,
        )
        .map((row) => {
          const i = rows.indexOf(row)
          return (
            <text
              key={row.date}
              x={45 + (i * (width - 55)) / Math.max(1, rows.length - 1)}
              y={height - 4}
              fill="#8893a8"
              fontSize="9"
              textAnchor={i === rows.length - 1 ? 'end' : 'start'}
            >
              {new Date(`${row.date}T12:00:00`).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
              })}
            </text>
          )
        })}
    </svg>
  )
}
export function ActivityBars({ series }: { series: Overview['series'] }) {
  const groups = new Map<string, { lessons: number; battles: number }>()
  for (const d of series) {
    const key = d.date.slice(0, 7),
      old = groups.get(key) || { lessons: 0, battles: 0 }
    old.lessons += d.lessons
    old.battles += d.battles
    groups.set(key, old)
  }
  const rows = Array.from(groups.entries()),
    max = Math.max(4, ...rows.map(([, n]) => n.lessons + n.battles))
  return (
    <svg
      className="bar-chart"
      viewBox="0 0 490 180"
      role="img"
      aria-label="Completed lessons and battles by month"
    >
      {[0, 1, 2, 3].map((i) => (
        <g key={i}>
          <line x1="34" x2="480" y1={15 + i * 45} y2={15 + i * 45} stroke="#eef0f6" />
          <text x="4" y={19 + i * 45} fill="#8893a8" fontSize="10">
            {Math.round((max * (3 - i)) / 3)}
          </text>
        </g>
      ))}
      {rows.map(([month, n], i) => {
        const x = 45 + ((i + 0.5) * 420) / rows.length,
          h1 = (n.lessons / max) * 135,
          h2 = (n.battles / max) * 135,
          w = Math.min(58, 230 / rows.length)
        return (
          <g key={month}>
            <rect x={x - w / 2} y={150 - h1} width={w} height={h1} rx="3" fill="#8c84f6" />
            <rect x={x - w / 2} y={150 - h1 - h2} width={w} height={h2} rx="3" fill="#655cf3" />
            <text x={x} y={143 - h1 - h2} textAnchor="middle" fill="#7e899f" fontSize="10">
              {number(n.lessons + n.battles)}
            </text>
            <text x={x} y="171" textAnchor="middle" fill="#7e899f" fontSize="10">
              {new Date(`${month}-15`).toLocaleDateString('en-US', { month: 'short' })}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
export function SkillDonut({
  categories,
  basis = 'lessons',
}: {
  categories: Overview['categories']
  basis?: 'lessons' | 'answers'
}) {
  const value = (c: Overview['categories'][number]) =>
    basis === 'answers' ? c.answered : c.lessons
  const total = categories.reduce((n, c) => n + value(c), 0),
    colors = ['#665cf3', '#a39bff', '#d2ccff', '#e3e6f4']
  let offset = 0
  return (
    <div className="donut-layout">
      <div className="donut-wrap">
        <svg
          viewBox="0 0 180 180"
          role="img"
          aria-label={`Skill distribution: ${total} ${basis === 'answers' ? 'answered questions' : 'completed lessons'}`}
        >
          <circle cx="90" cy="90" r="69" fill="none" stroke="#eef0f6" strokeWidth="18" />
          {categories.map((c, i) => {
            const size = total ? (value(c) / total) * 100 : 0,
              start = offset
            offset += size
            return (
              <circle
                key={c.id}
                cx="90"
                cy="90"
                r="69"
                pathLength="100"
                fill="none"
                stroke={colors[i]}
                strokeWidth="18"
                strokeDasharray={`${size} ${100 - size}`}
                strokeDashoffset={-start}
                transform="rotate(-90 90 90)"
              />
            )
          })}
        </svg>
        <div className="donut-label">
          <strong>{number(total)}</strong>
          <span>{basis === 'answers' ? 'Answers' : 'Lessons completed'}</span>
        </div>
      </div>
      <div className="donut-legend">
        {categories.map((c, i) => (
          <div key={c.id}>
            <i style={{ background: colors[i] }} />
            <span>
              <strong>{c.name}</strong>
              <small>
                {number(value(c))} {basis === 'answers' ? 'answers' : 'lessons'}
              </small>
            </span>
            <b>{total ? Math.round((value(c) / total) * 100) : 0}%</b>
          </div>
        ))}
      </div>
    </div>
  )
}
