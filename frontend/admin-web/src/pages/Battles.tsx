import { useEffect, useState } from 'react'
import { Download, Eye, RefreshCw, Swords } from 'lucide-react'
import { useAdmin } from '../context'
import { useDebounced, useResource } from '../hooks'
import {
  Avatar,
  Badge,
  Empty,
  ErrorState,
  Loading,
  Modal,
  Pagination,
  SearchInput,
} from '../components'
import { dateTime, downloadCsv, message, number } from '../lib'
import { statusLabels } from '../domain'
import { ActivityDialog } from './Overview'

export function BattlesPage({ initialSearch = '' }: { initialSearch?: string }) {
  const { api, toast, range } = useAdmin(),
    [search, setSearch] = useState(initialSearch),
    [status, setStatus] = useState(''),
    [mode, setMode] = useState(''),
    [page, setPage] = useState(1),
    [size, setSize] = useState(10),
    [detail, setDetail] = useState(''),
    [activitiesOpen, setActivitiesOpen] = useState(false),
    [exporting, setExporting] = useState(false)
  const q = useDebounced(search),
    query = { q, status, mode, page, pageSize: size },
    data = useResource(() => api.battles(query), [q, status, mode, page, size])
  const exportReport = async () => {
    setExporting(true)
    try {
      const r = await api.exportReport('battles', query, range)
      downloadCsv(r.filename, r.columns, r.rows)
      toast('Filtered matches exported.')
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
          <h1>Battle & Moderation</h1>
          <p>Monitor multiplayer matches and review player activity.</p>
        </div>
        <button className="btn" onClick={() => setActivitiesOpen(true)}>
          View activities
        </button>
      </div>
      <div className="toolbar">
        <SearchInput
          value={search}
          onChange={(v) => {
            setSearch(v)
            setPage(1)
          }}
          placeholder="Search by match ID…"
        />
        <select
          aria-label="Battle status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value)
            setPage(1)
          }}
        >
          <option value="">All statuses</option>
          {['ongoing', 'completed', 'abandoned'].map((s) => (
            <option key={s} value={s}>
              {statusLabels[s]}
            </option>
          ))}
        </select>
        <select
          aria-label="Battle mode"
          value={mode}
          onChange={(e) => {
            setMode(e.target.value)
            setPage(1)
          }}
        >
          <option value="">All modes</option>
          {['quick', 'daily', 'private'].map((m) => (
            <option value={m} key={m}>
              {statusLabels[m]}
              {api.mode === 'firebase' && m !== 'quick' ? ' (not implemented)' : ''}
            </option>
          ))}
        </select>
        <span className="toolbar-spacer" />
        <button className="text-btn muted" onClick={data.reload} disabled={data.loading}>
          <RefreshCw size={14} className={data.loading ? 'spin' : ''} />
          {api.mode === 'demo' ? 'Refresh sample data' : 'Refresh matches'}
        </button>
        <button
          className="btn"
          aria-label="Export matches"
          onClick={exportReport}
          disabled={exporting}
          title={api.mode === 'firebase' ? 'Report export is not available yet' : 'Export matches'}
        >
          <Download size={15} />
        </button>
      </div>
      <section className="panel data-panel">
        <div className="panel-heading">
          <div className="heading-inline">
            <h2>Recent matches</h2>
            {data.data && !data.loading && (
              <span className="count-chip">{number(data.data.total)}</span>
            )}
          </div>
          <span className="muted small-text">Newest matches first</span>
        </div>
        {data.loading ? (
          <Loading />
        ) : data.error ? (
          <ErrorState error={data.error} retry={data.reload} />
        ) : !data.data?.items.length ? (
          <Empty
            title="No matches found"
            action={
              <button
                className="btn"
                onClick={() => {
                  setSearch('')
                  setStatus('')
                  setMode('')
                  setPage(1)
                }}
              >
                Clear search & filters
              </button>
            }
          />
        ) : (
          <>
            <div className="table-scroll">
              <table className="battles-table">
                <thead>
                  <tr>
                    <th>Match ID</th>
                    <th>Player 1</th>
                    <th>Player 2</th>
                    <th>Score</th>
                    <th>Status</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {data.data.items.map((b) => (
                    <tr key={b.id}>
                      <td className="muted nowrap">
                        {b.code}
                        <span className="record-id">{statusLabels[b.mode]}</span>
                      </td>
                      <td>
                        <span className="person">
                          <Avatar name={b.player1Name} small />
                          <strong>{b.player1Name}</strong>
                        </span>
                      </td>
                      <td>
                        <span className="person">
                          <Avatar name={b.player2Name} small />
                          <strong>{b.player2Name}</strong>
                        </span>
                      </td>
                      <td className="score-cell">
                        {b.score1}–{b.score2}
                      </td>
                      <td>
                        <Badge value={b.status} />
                      </td>
                      <td>
                        <button
                          className="text-btn nowrap"
                          onClick={() => setDetail(b.id)}
                          aria-label={`View logs ${b.code}`}
                        >
                          <Eye size={14} />
                          View Logs
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={data.data}
              label="matches"
              onPage={setPage}
              onSize={(s) => {
                setSize(s)
                setPage(1)
              }}
            />
          </>
        )}
      </section>
      <p className="metrics-note">
        <Swords size={13} />
        {api.mode === 'demo'
          ? 'Daily and private matches here are sample records. Live matchmaking and moderation actions require a backend.'
          : 'Quick battles use server data. Daily and private battles are not implemented. Monitoring is read only; results cannot be changed here.'}
      </p>
      {api.mode === 'firebase' && data.data?.asOf && (
        <p className="metrics-note">
          Index as of {dateTime(data.data.asOf)}. Refresh to load a new snapshot; open a match for
          its current state.
        </p>
      )}
      {detail && <BattleDialog id={detail} onClose={() => setDetail('')} />}
      {activitiesOpen && <ActivityDialog onClose={() => setActivitiesOpen(false)} />}
    </>
  )
}
function BattleDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { api } = useAdmin(),
    data = useResource(() => api.battle(id), [id])
  useEffect(() => {
    if (api.mode !== 'firebase') return
    const timer = setInterval(data.reload, 10000)
    return () => clearInterval(timer)
  }, [api.mode, data.reload])
  return (
    <Modal
      title="Battle log"
      subtitle={
        data.data
          ? `${data.data.battle.code} · ${statusLabels[data.data.battle.mode]}`
          : 'Loading match details'
      }
      onClose={onClose}
      wide
    >
      {data.loading ? (
        <Loading />
      ) : data.error ? (
        <ErrorState error={data.error} retry={data.reload} />
      ) : (
        data.data &&
        (() => {
          const { battle: b, player1, player2 } = data.data
          return (
            <div className="modal-body">
              <div className="battle-summary">
                <div>
                  <Avatar name={player1.name} />
                  <strong>{player1.name}</strong>
                  <small>{player1.code}</small>
                  {b.outcome1 && <small>{b.outcome1}</small>}
                </div>
                <div className="battle-score">
                  <strong>
                    {b.score1} <span>–</span> {b.score2}
                  </strong>
                  <Badge value={b.status} />
                </div>
                <div>
                  <Avatar name={player2.name} />
                  <strong>{player2.name}</strong>
                  <small>{player2.code}</small>
                  {b.outcome2 && <small>{b.outcome2}</small>}
                </div>
              </div>
              <dl className="detail-grid">
                <div>
                  <dt>Started</dt>
                  <dd>
                    {api.mode === 'demo'
                      ? dateTime(b.startedAt)
                      : b.playStartedAt
                        ? dateTime(b.playStartedAt)
                        : 'Not recorded / awaiting start'}
                  </dd>
                </div>
                <div>
                  <dt>Ended</dt>
                  <dd>{b.endedAt ? dateTime(b.endedAt) : 'In progress'}</dd>
                </div>
                <div>
                  <dt>Question count</dt>
                  <dd>{b.questionCount ?? 10} shared questions</dd>
                </div>
                <div>
                  <dt>Round time limit</dt>
                  <dd>{b.roundTimeLimitSeconds ?? 30} seconds</dd>
                </div>
                {api.mode === 'firebase' && (
                  <>
                    <div>
                      <dt>Server phase</dt>
                      <dd>
                        {b.phase === 'reconnecting'
                          ? 'Heartbeat overdue; awaiting server reconciliation'
                          : b.phase}
                      </dd>
                    </div>
                    <div>
                      <dt>End reason</dt>
                      <dd>{b.endReason || '—'}</dd>
                    </div>
                    <div>
                      <dt>Settlement</dt>
                      <dd>{b.settlementStatus?.replaceAll('_', ' ')}</dd>
                    </div>
                  </>
                )}
              </dl>
              <h3 className="section-title">Match events</h3>
              {!b.logs.length && <p className="muted">No recorded server events are available.</p>}
              <ol className="timeline">
                {b.logs.map((log) => (
                  <li key={log.id}>
                    <span className="timeline-dot" />
                    <div>
                      <strong>
                        {log.type.replaceAll('_', ' ')}
                        {log.actorId &&
                          ` · ${log.actorId === b.player1 ? player1.name : player2.name}`}
                      </strong>
                      <p>{log.message}</p>
                      <small>{dateTime(log.at)}</small>
                    </div>
                  </li>
                ))}
              </ol>
              <p className="info-note">
                {api.mode === 'demo'
                  ? 'This log is simulated. Results cannot be changed from this frontend.'
                  : 'Only recorded server events are shown; older history may be incomplete. Live scores include resolved rounds only. Details refresh every 10 seconds.'}
              </p>
            </div>
          )
        })()
      )}
      <div className="modal-footer">
        <button className="btn" onClick={onClose}>
          Close log
        </button>
      </div>
    </Modal>
  )
}
