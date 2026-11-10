import { useState } from 'react'
import { Ban, CheckCircle2, Eye, Pencil, Plus, SlidersHorizontal, Trash2 } from 'lucide-react'
import { useAdmin } from '../context'
import { useDebounced, useResource } from '../hooks'
import {
  Avatar,
  Badge,
  Empty,
  ErrorState,
  ExportButton,
  Field,
  FormError,
  Loading,
  Modal,
  Pagination,
  SearchInput,
} from '../components'
import { dateTime, downloadCsv, message, number } from '../lib'
import type { UserRecord, UserStatus } from '../domain'

export function UsersPage({ initialSearch = '' }: { initialSearch?: string }) {
  const { api, toast, range } = useAdmin(),
    [search, setSearch] = useState(initialSearch),
    [status, setStatus] = useState(''),
    [page, setPage] = useState(1),
    [size, setSize] = useState(10),
    [filters, setFilters] = useState(false)
  const [editor, setEditor] = useState<UserRecord | 'new' | null>(null),
    [detail, setDetail] = useState<UserRecord | null>(null),
    [action, setAction] = useState<{ user: UserRecord; status: UserStatus } | null>(null),
    [exporting, setExporting] = useState(false)
  const q = useDebounced(search),
    query = { q, status, page, pageSize: size },
    data = useResource(() => api.users(query), [q, status, page, size])
  const exportReport = async () => {
    setExporting(true)
    try {
      const r = await api.exportReport('users', query, range)
      downloadCsv(r.filename, r.columns, r.rows)
      toast('Demo users exported with the current filters.')
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
          <h1>User Management</h1>
          <p>Manage your learning community and account access.</p>
        </div>
      </div>
      <div className="toolbar">
        <SearchInput
          value={search}
          placeholder="Search by name, email or ID…"
          onChange={(v) => {
            setSearch(v)
            setPage(1)
          }}
        />
        <button
          className={`btn ${filters || status ? 'filter-active' : ''}`}
          onClick={() => setFilters((v) => !v)}
          aria-expanded={filters}
        >
          <SlidersHorizontal size={15} />
          Filter{status && <span className="filter-dot" />}
        </button>
        <span className="toolbar-spacer" />
        <ExportButton busy={exporting} onClick={exportReport} />
        <button className="btn btn-primary" onClick={() => setEditor('new')}>
          <Plus size={16} />
          Add User
        </button>
      </div>
      {filters && (
        <div className="filter-bar">
          <Field label="Account status">
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value)
                setPage(1)
              }}
            >
              <option value="">Active & banned</option>
              <option value="active">Active</option>
              <option value="banned">Banned</option>
              <option value="deleted">Deleted</option>
            </select>
          </Field>
          <button
            className="text-btn"
            onClick={() => {
              setStatus('')
              setSearch('')
              setPage(1)
            }}
          >
            Clear filters
          </button>
        </div>
      )}
      <section className="panel data-panel">
        <div className="panel-heading">
          <div className="heading-inline">
            <h2>{status ? `${status[0].toUpperCase() + status.slice(1)} users` : 'All users'}</h2>
            {data.data && !data.loading && (
              <span className="count-chip">{number(data.data.total)}</span>
            )}
          </div>
          <span className="muted small-text">Newest users first</span>
        </div>
        {data.loading ? (
          <Loading />
        ) : data.error ? (
          <ErrorState error={data.error} retry={data.reload} />
        ) : !data.data?.items.length ? (
          <Empty
            title="No users found"
            action={
              <button
                className="btn"
                onClick={() => {
                  setSearch('')
                  setStatus('')
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
              <table className="users-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>User</th>
                    <th>Email</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {data.data.items.map((u) => (
                    <tr key={u.id}>
                      <td className="muted">{u.code}</td>
                      <td>
                        <button className="person-link" onClick={() => setDetail(u)}>
                          <Avatar name={u.name} small />
                          <strong>{u.name}</strong>
                        </button>
                      </td>
                      <td className="muted">{u.email || '—'}</td>
                      <td>
                        <Badge value={u.status} />
                      </td>
                      <td>
                        <div className="row-actions">
                          {u.status !== 'deleted' ? (
                            <>
                              <button
                                className="icon-btn"
                                aria-label={`Edit ${u.name}`}
                                onClick={() => setEditor(u)}
                              >
                                <Pencil size={15} />
                              </button>
                              <button
                                className="icon-btn danger"
                                aria-label={`Delete ${u.name}`}
                                onClick={() => setAction({ user: u, status: 'deleted' })}
                              >
                                <Trash2 size={15} />
                              </button>
                            </>
                          ) : (
                            <button
                              className="icon-btn"
                              aria-label="View deleted user"
                              onClick={() => setDetail(u)}
                            >
                              <Eye size={15} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={data.data}
              label="users"
              onPage={setPage}
              onSize={(s) => {
                setSize(s)
                setPage(1)
              }}
            />
          </>
        )}
      </section>
      {editor && (
        <UserEditor
          user={editor === 'new' ? undefined : editor}
          onClose={() => setEditor(null)}
          onStatus={(status) => {
            if (editor !== 'new') setAction({ user: editor, status })
            setEditor(null)
          }}
        />
      )}
      {detail && (
        <Modal
          title={detail.name}
          subtitle={`${detail.code} · User details`}
          onClose={() => setDetail(null)}
        >
          <div className="modal-body">
            <div className="profile-preview">
              <Avatar name={detail.name} />
              <span>
                <strong>{detail.name}</strong>
                <small>{detail.email || 'Deleted account'}</small>
              </span>
              <Badge value={detail.status} />
            </div>
            <dl className="detail-grid">
              <div>
                <dt>Joined</dt>
                <dd>{dateTime(detail.createdAt)}</dd>
              </div>
              <div>
                <dt>Last updated</dt>
                <dd>{dateTime(detail.updatedAt)}</dd>
              </div>
              <div>
                <dt>Rating</dt>
                <dd>{number(detail.rating)}</dd>
              </div>
              <div>
                <dt>Coins</dt>
                <dd>{number(detail.coins)}</dd>
              </div>
            </dl>
            {detail.reason && <p className="info-note">Account action reason: {detail.reason}</p>}
          </div>
          <div className="modal-footer">
            <button className="btn" onClick={() => setDetail(null)}>
              Close
            </button>
            {detail.status !== 'deleted' && (
              <button
                className="btn btn-primary"
                onClick={() => {
                  setEditor(detail)
                  setDetail(null)
                }}
              >
                Edit user
              </button>
            )}
          </div>
        </Modal>
      )}
      {action && (
        <AccountAction user={action.user} status={action.status} onClose={() => setAction(null)} />
      )}
    </>
  )
}
function UserEditor({
  user,
  onClose,
  onStatus,
}: {
  user?: UserRecord
  onClose: () => void
  onStatus: (s: UserStatus) => void
}) {
  const { api, toast } = useAdmin(),
    [name, setName] = useState(user?.name || ''),
    [email, setEmail] = useState(user?.email || ''),
    [password, setPassword] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const dirty = name !== (user?.name || '') || email !== (user?.email || '') || !!password,
    close = () => {
      if (!dirty || window.confirm('Discard unsaved user changes?')) onClose()
    }
  return (
    <Modal
      title={user ? 'Edit user' : 'Add user'}
      subtitle={
        user
          ? `${user.code} · Account details`
          : api.mode === 'demo'
            ? 'Add a learner to the demo workspace'
            : 'Add a learner'
      }
      onClose={close}
      busy={busy}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          if (busy) return
          setBusy(true)
          setError('')
          try {
            await api.saveUser(
              { name, email, ...(!user && api.mode === 'firebase' ? { password } : {}) },
              user?.id,
            )
            toast(
              user
                ? api.mode === 'demo'
                  ? 'Demo user updated.'
                  : 'User updated.'
                : api.mode === 'demo'
                  ? 'Demo user added. Firebase Authentication was not changed.'
                  : 'User saved through Firebase API.',
            )
            onClose()
          } catch (e) {
            setError(message(e))
          } finally {
            setBusy(false)
          }
        }}
      >
        <div className="modal-body">
          <Field label="Full name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              minLength={2}
              maxLength={80}
              required
              autoComplete="off"
            />
          </Field>
          <Field label="Email address">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              maxLength={254}
              required
              autoComplete="off"
            />
          </Field>
          {!user && api.mode === 'firebase' && (
            <Field
              label="Initial password"
              hint="12–128 characters with uppercase, lowercase, a number and a symbol. Share it securely with the learner."
            >
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={128}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
          )}
          <p className="info-note">
            {api.mode === 'demo'
              ? 'Demo changes are local. Real account creation, email updates and access control require a backend connected to Firebase Auth.'
              : 'The server validates account changes. Rating, coins and admin permissions cannot be edited here.'}
          </p>
          <FormError error={error} />
          {user && (
            <div className="account-state">
              <div>
                <strong>Account access</strong>
                <p>
                  Current status: <Badge value={user.status} />
                </p>
              </div>
              <button
                type="button"
                className={`btn ${user.status === 'banned' ? '' : 'btn-danger-outline'}`}
                disabled={busy}
                onClick={() => {
                  if (
                    dirty &&
                    !window.confirm('Discard unsaved changes before changing account access?')
                  )
                    return
                  onStatus(user.status === 'banned' ? 'active' : 'banned')
                }}
              >
                {user.status === 'banned' ? <CheckCircle2 size={15} /> : <Ban size={15} />}
                {user.status === 'banned' ? 'Restore access' : 'Ban user'}
              </button>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : user ? 'Save changes' : 'Add user'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
function AccountAction({
  user,
  status,
  onClose,
}: {
  user: UserRecord
  status: UserStatus
  onClose: () => void
}) {
  const { api, toast } = useAdmin(),
    [reason, setReason] = useState(''),
    [confirm, setConfirm] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const deleting = status === 'deleted',
    title = deleting ? 'Delete user' : status === 'banned' ? 'Ban user' : 'Restore access'
  return (
    <Modal
      title={`${title}?`}
      subtitle={`${user.name} · ${user.code}`}
      onClose={onClose}
      busy={busy}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          if (busy || (deleting && confirm !== user.code)) return
          setBusy(true)
          setError('')
          try {
            await api.setUserStatus(user.id, status, reason)
            toast(`${title}: ${api.mode === 'demo' ? 'demo account' : 'account'} updated.`)
            onClose()
          } catch (e) {
            setError(message(e))
          } finally {
            setBusy(false)
          }
        }}
      >
        <div className="modal-body">
          <p>
            {api.mode === 'firebase'
              ? 'The server will apply this account access change and record the reason.'
              : deleting
                ? 'The demo account will be removed from the user list. Historical records remain linked to an anonymized user.'
                : status === 'banned'
                  ? 'The account will be marked as banned in this local preview.'
                  : 'The account will be marked as active in this local preview.'}
          </p>
          <Field label="Reason">
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
              minLength={5}
              maxLength={500}
              rows={3}
              placeholder="Explain this account action…"
            />
          </Field>
          {deleting && (
            <Field label={`Type ${user.code} to confirm`}>
              <input
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="off"
              />
            </Field>
          )}
          <FormError error={error} />
        </div>
        <div className="modal-footer">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            className={`btn ${status === 'active' ? 'btn-primary' : 'btn-danger'}`}
            disabled={busy || reason.trim().length < 5 || (deleting && confirm !== user.code)}
          >
            {busy ? 'Updating…' : title}
          </button>
        </div>
      </form>
    </Modal>
  )
}
