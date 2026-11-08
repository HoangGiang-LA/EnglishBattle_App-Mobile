import { useState } from 'react'
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  CalendarDays,
  RefreshCw,
  Swords,
  TrendingDown,
  TrendingUp,
  UserCheck,
  Users,
} from 'lucide-react'
import { useAdmin } from '../context'
import { useResource } from '../hooks'
import { ActivityBars, GrowthChart, SkillDonut, Sparkline } from '../charts'
import {
  Avatar,
  Badge,
  Empty,
  ErrorState,
  ExportButton,
  Loading,
  Modal,
  Pagination,
  RangePicker,
} from '../components'
import { dateTime, dayKey, downloadCsv, message, number } from '../lib'
import type { Activity, DateRange, Overview } from '../domain'

function OverviewFreshness({ value }: { value: Overview }) {
  if (!value.coverage) return null
  return (
    <p className="metrics-note" role="status">
      Data through {dateTime(value.asOf)} · {Math.ceil((value.lagMs || 0) / 1000)}s lag.
      {value.coverage.partialPeriod && ' The selected period includes time beyond this update.'}
      {value.coverage.unknownStartSessions > 0 &&
        ' Some historical sessions lack a start time; affected completion rates show N/A.'}
      {!value.coverage.skillBreakdownComplete &&
        ' Skill breakdown is unavailable for this history.'}
      {value.coverage.unknownAnswers &&
        ' Accuracy is unavailable because historical answer counts are incomplete.'}
    </p>
  )
}

function ActivityTable({ rows }: { rows: (Activity & { userName?: string })[] }) {
  const { navigate } = useAdmin()
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>User</th>
            <th>Activity</th>
            <th>Type</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id}>
              <td>
                <button
                  className="person-link"
                  onClick={() => navigate(`/users?q=${encodeURIComponent(a.userName || '')}`)}
                >
                  <Avatar name={a.userName || 'User'} small />
                  <strong>{a.userName || 'User'}</strong>
                </button>
              </td>
              <td className="muted activity-text">{a.text}</td>
              <td>
                <Badge value={a.type === 'user' ? 'draft' : a.completed ? 'completed' : 'ongoing'}>
                  {a.type === 'user'
                    ? 'New user'
                    : a.type === 'lesson'
                      ? a.completed
                        ? 'Lesson completed'
                        : a.outcome === 'abandoned'
                          ? 'Lesson abandoned'
                          : 'Lesson started'
                      : a.completed
                        ? 'Battle completed'
                        : 'Battle activity'}
                </Badge>
              </td>
              <td className="muted nowrap">{dateTime(a.at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
export function ActivityDialog({ onClose, range }: { onClose: () => void; range?: DateRange }) {
  const { api } = useAdmin(),
    [page, setPage] = useState(1),
    [size, setSize] = useState(10),
    [type, setType] = useState('')
  const activities = useResource(
    () => api.activities({ page, pageSize: size, status: type, ...(range ? { range } : {}) }),
    [page, size, type, range?.from, range?.to],
  )
  return (
    <Modal
      title="Recent activities"
      subtitle={
        api.mode === 'demo'
          ? 'Simulated registrations, lessons and battle events'
          : 'Recorded registrations, learning and battle activity'
      }
      onClose={onClose}
      wide
    >
      <div className="modal-body">
        {api.mode === 'firebase' && activities.data?.asOf && (
          <p className="info-note">
            Index as of {dateTime(activities.data.asOf)}. Names reflect current account visibility.
          </p>
        )}
        <label className="inline-filter">
          Activity type
          <select
            value={type}
            onChange={(e) => {
              setType(e.target.value)
              setPage(1)
            }}
          >
            <option value="">All activities</option>
            <option value="user">New users</option>
            <option value="lesson">Learning</option>
            <option value="battle">Battles</option>
          </select>
        </label>
      </div>
      {activities.loading ? (
        <Loading />
      ) : activities.error ? (
        <ErrorState error={activities.error} retry={activities.reload} />
      ) : activities.data?.items.length ? (
        <>
          <ActivityTable rows={activities.data.items} />
          <Pagination
            page={activities.data}
            onPage={setPage}
            onSize={(s) => {
              setSize(s)
              setPage(1)
            }}
            label="activities"
          />
        </>
      ) : (
        <Empty />
      )}
    </Modal>
  )
}
export function Dashboard() {
  const { api, range, setRange, toast } = useAdmin(),
    [group, setGroup] = useState('daily'),
    [activitiesOpen, setActivitiesOpen] = useState(false),
    [exporting, setExporting] = useState(false)
  const granularity = group === 'weekly' ? 'week' : group === 'monthly' ? 'month' : 'day'
  const overview = useResource(
    () => api.overview(range, undefined, granularity),
    [range.from, range.to, granularity],
  )
  const exportReport = async () => {
    setExporting(true)
    try {
      const report = await api.exportReport(
        'analytics',
        { granularity: granularity, generation: overview.data?.generation },
        range,
      )
      downloadCsv(report.filename, report.columns, report.rows)
      toast('Dashboard report downloaded.')
    } catch (e) {
      toast(message(e), true)
    } finally {
      setExporting(false)
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Dashboard</h1>
          <p>Your learning community, at a glance.</p>
        </div>
        <div className="page-actions">
          <RangePicker range={range} onChange={setRange} />
          <button
            className="btn"
            aria-label="Refresh statistics"
            onClick={overview.reload}
            disabled={overview.loading}
          >
            <RefreshCw size={15} />
          </button>
          <ExportButton onClick={exportReport} busy={exporting} />
        </div>
      </div>
      {overview.loading ? (
        <Loading />
      ) : overview.error ? (
        <ErrorState error={overview.error} retry={overview.reload} />
      ) : (
        overview.data &&
        (() => {
          const o = overview.data
          const cards = [
            { title: 'Total Users', value: o.totalUsers, growth: o.growth.users, icon: Users },
            {
              title: 'Active Users',
              value: o.activeUsers,
              growth: o.growth.active,
              icon: UserCheck,
            },
            {
              title: 'Battles Completed',
              value: o.completedBattles,
              growth: o.growth.battles,
              icon: Swords,
            },
          ]
          return (
            <>
              <div className="stat-grid">
                {cards.map((card, i) => (
                  <section className="stat-card" key={card.title}>
                    <div className="stat-top">
                      <span>{card.title}</span>
                      <card.icon size={17} />
                    </div>
                    <strong className="stat-number">{number(card.value)}</strong>
                    <div
                      className={`stat-growth ${card.growth !== null && card.growth < 0 ? 'negative' : ''}`}
                    >
                      {card.growth === null ? (
                        <span className="muted">N/A</span>
                      ) : (
                        <>
                          <span>
                            {card.growth >= 0 ? (
                              <TrendingUp size={12} />
                            ) : (
                              <TrendingDown size={12} />
                            )}
                            {Math.abs(card.growth)}%
                          </span>
                        </>
                      )}
                      <small>
                        {i === 0 ? 'new users vs. prior period' : 'vs. previous period'}
                      </small>
                    </div>
                    <Sparkline
                      color={i === 1 ? '#36aab3' : '#665cff'}
                      values={o.series.map((d) =>
                        i === 0 ? d.users : i === 1 ? d.active : d.battles,
                      )}
                    />
                  </section>
                ))}
              </div>
              <section className="panel growth-panel">
                <div className="panel-heading">
                  <div>
                    <h2>User growth</h2>
                    <p>{number(o.newUsers)} new learners joined during this period</p>
                  </div>
                  <div className="chart-controls">
                    <span className="chart-legend">
                      <i />
                      Selected period
                    </span>
                    <span className="chart-legend previous">
                      <i />
                      Previous period
                    </span>
                    <div className="segmented" aria-label="Chart interval">
                      {['daily', 'weekly', 'monthly'].map((g) => (
                        <button
                          key={g}
                          className={group === g ? 'selected' : ''}
                          aria-pressed={group === g}
                          onClick={() => setGroup(g)}
                        >
                          {g[0].toUpperCase() + g.slice(1)}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <GrowthChart
                  series={o.series}
                  group={group}
                  preAggregated={api.mode === 'firebase'}
                />
              </section>
              <section className="panel activities-panel">
                <div className="panel-heading">
                  <div className="heading-inline">
                    <h2>Recent Activities</h2>
                    <span className="muted small-text">Latest updates</span>
                  </div>
                  <button className="text-btn" onClick={() => setActivitiesOpen(true)}>
                    View all activities
                    <ArrowRight size={14} />
                  </button>
                </div>
                {o.recent.length ? (
                  <ActivityTable rows={o.recent} />
                ) : (
                  <Empty
                    title="No activity in this period"
                    description="Choose a wider date range to explore activity."
                  />
                )}
              </section>
              <OverviewFreshness value={o} />
              <p className="metrics-note">
                <CalendarDays size={13} />
                Dates use Asia/Ho_Chi_Minh. Active users are distinct learners with learning or
                battle activity; total users is the current account count.
                {api.mode === 'firebase' &&
                  ` ${number(o.completedLessons)} learning sessions completed. Account totals exclude deleted accounts; growth charts track cumulative registrations.`}
              </p>
            </>
          )
        })()
      )}
      {activitiesOpen && <ActivityDialog range={range} onClose={() => setActivitiesOpen(false)} />}
    </>
  )
}
export function Analytics() {
  const { api, range, setRange, toast } = useAdmin(),
    [category, setCategory] = useState(''),
    [exporting, setExporting] = useState(false)
  const data = useResource(
      () => api.overview(range, category, 'month'),
      [range.from, range.to, category],
    ),
    catalog = useResource(() => api.catalog())
  const exportReport = async () => {
    setExporting(true)
    try {
      const r = await api.exportReport(
        'analytics',
        { categoryId: category, granularity: 'month', generation: data.data?.generation },
        range,
      )
      downloadCsv(r.filename, r.columns, r.rows)
      toast('Analytics report downloaded.')
    } catch (e) {
      toast(message(e), true)
    } finally {
      setExporting(false)
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Analytics</h1>
          <p>Understand your learners and discover what drives engagement.</p>
        </div>
      </div>
      <div className="toolbar analytics-toolbar">
        <RangePicker range={range} onChange={setRange} />
        <select
          aria-label="Analytics skill"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">All skills</option>
          {catalog.data?.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Quick date range"
          value=""
          onChange={(e) => {
            if (e.target.value)
              setRange({
                from: dayKey(Date.now() - (Number(e.target.value) - 1) * 86400000),
                to: dayKey(Date.now()),
              })
          }}
        >
          <option value="">Date presets</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
          <option value="180">Last 180 days</option>
        </select>
        <span className="toolbar-spacer" />
        <span className="muted small-text">
          {api.mode === 'demo'
            ? 'Sample data · updated locally'
            : data.data
              ? `Updated ${dateTime(data.data.asOf)}`
              : 'Preparing statistics'}
        </span>
        <button
          className="btn"
          aria-label="Refresh statistics"
          onClick={data.reload}
          disabled={data.loading}
        >
          <RefreshCw size={15} />
        </button>
        <ExportButton primary busy={exporting} onClick={exportReport} />
      </div>
      {data.loading ? (
        <Loading />
      ) : data.error ? (
        <ErrorState error={data.error} retry={data.reload} />
      ) : (
        data.data &&
        (() => {
          const o = data.data,
            totalActivity = o.completedBattles + o.completedLessons,
            ranked = [...o.categories].sort((a, b) => b.battles - a.battles),
            skillBattles = ranked.reduce((n, c) => n + c.battles, 0)
          return (
            <>
              <div className="analytics-grid">
                <section className="panel analytics-card">
                  <div className="panel-heading">
                    <h2>Learning & Battle Activity</h2>
                    <span className="chart-legend">
                      <i />
                      Completed activities
                    </span>
                  </div>
                  <div className="analytics-total">
                    <strong>{number(totalActivity)}</strong>
                    <span className="mini-tag">
                      <ArrowUpRight size={12} />
                      In selected period
                    </span>
                  </div>
                  <ActivityBars series={o.series} />
                  <p className="chart-caption">
                    <BookOpen size={12} />
                    {number(o.completedLessons)}{' '}
                    {api.mode === 'firebase' ? 'learning sessions' : 'lessons'} <span>·</span>
                    <Swords size={12} />
                    {number(o.completedBattles)} battles
                  </p>
                </section>
                <section className="panel analytics-card">
                  <div className="panel-heading">
                    <div>
                      <h2>{api.mode === 'firebase' ? 'Answers by Skill' : 'Learning by Skill'}</h2>
                      <p>
                        {api.mode === 'firebase'
                          ? 'Finalized learning and battle answers, including mixed-skill sessions.'
                          : 'Completed practice across the four learning skills.'}
                      </p>
                    </div>
                  </div>
                  {o.coverage?.skillBreakdownComplete === false ? (
                    <Empty title="Skill history is incomplete" />
                  ) : (
                    <SkillDonut
                      categories={o.categories}
                      basis={api.mode === 'firebase' ? 'answers' : 'lessons'}
                    />
                  )}
                  <p className="chart-caption">
                    Accuracy:{' '}
                    <strong>{o.accuracy === null ? 'N/A' : `${o.accuracy.toFixed(1)}%`}</strong>
                    <span>·</span>Completion:{' '}
                    <strong>{o.completion === null ? 'N/A' : `${o.completion.toFixed(1)}%`}</strong>
                  </p>
                </section>
              </div>
              <section className="panel">
                <div className="panel-heading">
                  <div className="heading-inline">
                    <h2>Most Popular Categories</h2>
                    <span className="count-chip">
                      {o.coverage?.skillBreakdownComplete === false
                        ? 'Unavailable'
                        : `${ranked.length} skills`}
                    </span>
                  </div>
                  <span className="muted small-text">Ranked by battles played</span>
                </div>
                {o.coverage?.skillBreakdownComplete === false ? (
                  <Empty title="Skill history is incomplete" />
                ) : (
                  <>
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Rank</th>
                            <th>Category</th>
                            <th>
                              {api.mode === 'firebase'
                                ? 'Completed battles involving skill'
                                : 'Battles played'}
                            </th>
                            <th>
                              {api.mode === 'firebase'
                                ? 'Share of skill appearances'
                                : 'Share of skill-specific battles'}
                            </th>
                            <th>Completion rate</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ranked.map((c, i) => (
                            <tr key={c.id}>
                              <td className="muted">{String(i + 1).padStart(2, '0')}</td>
                              <td>
                                <strong>{c.name}</strong>
                              </td>
                              <td>{number(c.battles)}</td>
                              <td>
                                <div className="progress-cell">
                                  <span className="progress-track">
                                    <i
                                      style={{
                                        width: `${skillBattles ? (c.battles / skillBattles) * 100 : 0}%`,
                                      }}
                                    />
                                  </span>
                                  <small>
                                    {skillBattles
                                      ? Math.round((c.battles / skillBattles) * 100)
                                      : 0}
                                    %
                                  </small>
                                </div>
                              </td>
                              <td>
                                {api.mode === 'firebase'
                                  ? c.completion == null
                                    ? 'N/A'
                                    : `${Math.round(c.completion)}%`
                                  : c.started
                                    ? `${Math.round((c.completed / c.started) * 100)}%`
                                    : 'N/A'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="table-footer">
                      <span>
                        {number(skillBattles)}{' '}
                        {api.mode === 'firebase'
                          ? 'skill appearances · mixed-skill matches appear in each applicable skill'
                          : 'skill-specific battles · mixed-skill matches excluded'}
                      </span>
                      <span>
                        {range.from} – {range.to}
                      </span>
                    </div>
                  </>
                )}
              </section>
              <OverviewFreshness value={o} />
              <p className="metrics-note">
                {api.mode === 'firebase'
                  ? 'Completion rate uses sessions started in the selected period and their completed outcomes as of the update. '
                  : 'Completion rate = completed learning/battle activities ÷ started activities. '}
                Accuracy uses total correct answers ÷ total answers. Empty denominators show N/A.
              </p>
            </>
          )
        })()
      )}
    </>
  )
}
