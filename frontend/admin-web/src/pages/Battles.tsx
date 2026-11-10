import { useState } from 'react'
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

export function BattlesPage({ initialSearch = '' }: { initialSearch?: string }) {
  const { api, toast, range } = useAdmin(),
    [search, setSearch] = useState(initialSearch),
    [status, setStatus] = useState(''),
    [mode, setMode] = useState(''),
    [page, setPage] = useState(1),
    [size, setSize] = useState(10),
    [detail, setDetail] = useState(''),
    [exporting, setExporting] = useState(false)
  const q = useDebounced(search),
    query = { q, status, mode, page, pageSize: size },
    data = useResource(() => api.battles(query), [q, status, mode, page, size])
  const exportReport = async () => {
    setExporting(true)
    try {
      const r = await api.exportReport('battles', query, range)
      downloadCsv(r.filename, r.columns, r.rows)
      toast(api.mode === 'demo' ? 'Filtered demo matches exported.' : 'Filtered matches exported.')
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
            </option>
          ))}
        </select>
        <span className="toolbar-spacer" />
        <button className="text-btn muted" onClick={data.reload} disabled={data.loading}>
          <RefreshCw size={14} className={data.loading ? 'spin' : ''} />
          Refresh sample data
        </button>
        <button
          className="btn"
          aria-label="Export matches"
          onClick={exportReport}
          disabled={exporting}
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
        Daily and private matches here are sample records. Live matchmaking and moderation actions
        require a backend.
      </p>
      {detail && <BattleDialog id={detail} onClose={() => setDetail('')} />}
    </>
  )
}
function BattleDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { api } = useAdmin(),
    data = useResource(() => api.battle(id), [id])
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
                </div>
              </div>
              <dl className="detail-grid">
                <div>
                  <dt>Started</dt>
                  <dd>{dateTime(b.startedAt)}</dd>
                </div>
                <div>
                  <dt>Ended</dt>
                  <dd>{b.endedAt ? dateTime(b.endedAt) : 'In progress (sample)'}</dd>
                </div>
                <div>
                  <dt>Question count</dt>
                  <dd>10 shared questions</dd>
                </div>
                <div>
                  <dt>Round time limit</dt>
                  <dd>30 seconds</dd>
                </div>
              </dl>
              <h3 className="section-title">Match events</h3>
              <ol className="timeline">
                {b.logs.map((log) => (
                  <li key={log.id}>
                    <span className="timeline-dot" />
                    <div>
                      <strong>{log.type.replaceAll('_', ' ')}</strong>
                      <p>{log.message}</p>
                      <small>{dateTime(log.at)}</small>
                    </div>
                  </li>
                ))}
              </ol>
              <p className="info-note">
                This log is simulated. Results cannot be changed from this frontend.
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
