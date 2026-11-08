import { useEffect, useRef, useState } from 'react'
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
  const [inviting, setInviting] = useState(false)
  const opening = useRef(0)
  useEffect(
    () => () => {
      opening.current++
    },
    [api, search, status, page, size],
  )
  const closeDetail = () => {
    opening.current++
    setDetail(null)
  }
  const openDetail = async (user: UserRecord, edit = false) => {
    const generation = ++opening.current
    try {
      const current = await api.user(user.id)
      if (generation !== opening.current) return
      if (edit && current.status !== 'deleted' && !current.pendingOperation) setEditor(current)
      else setDetail(current)
    } catch (error) {
      if (generation === opening.current) toast(message(error), true)
    }
  }
  const q = useDebounced(search),
    query = { q, status, page, pageSize: size },
    data = useResource(() => api.users(query), [q, status, page, size])
  const exportReport = async () => {
    setExporting(true)
    try {
      const r = await api.exportReport('users', query, range)
      downloadCsv(r.filename, r.columns, r.rows)
      toast('User report exported with the current filters.')
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
        <button
          className="btn btn-primary"
          onClick={() => {
            opening.current++
            setEditor('new')
          }}
        >
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
                        <button className="person-link" onClick={() => void openDetail(u)}>
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
                          {u.status !== 'deleted' && !u.pendingOperation ? (
                            <>
                              <button
                                className="icon-btn"
                                aria-label={`Edit ${u.name}`}
                                onClick={() => void openDetail(u, true)}
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
                              aria-label={
                                u.status === 'deleted' ? 'View deleted user' : 'View pending user'
                              }
                              onClick={() => void openDetail(u)}
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
        <Modal title={detail.name} subtitle={`${detail.code} · User details`} onClose={closeDetail}>
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
              {api.mode === 'firebase' && detail.invitationStatus && (
                <div>
                  <dt>Invitation</dt>
                  <dd>{detail.invitationStatus}</dd>
                </div>
              )}
            </dl>
            {detail.reason && <p className="info-note">Account action reason: {detail.reason}</p>}
            {detail.pendingOperation && (
              <p className="info-note">
                Account update pending. Editing is paused until it finishes. Reference:{' '}
                {detail.pendingOperation}
              </p>
            )}
          </div>
          <div className="modal-footer">
            {api.mode === 'firebase' &&
              detail.status === 'active' &&
              !detail.pendingOperation &&
              detail.invitationStatus &&
              detail.invitationStatus !== 'not_requested' && (
                <button
                  className="btn"
                  disabled={inviting || ['pending', 'sending'].includes(detail.invitationStatus)}
                  onClick={async () => {
                    const generation = opening.current
                    setInviting(true)
                    try {
                      const updated = await api.saveUser(
                        { name: detail.name, email: detail.email },
                        detail.id,
                        detail.revision,
                        true,
                      )
                      if (generation !== opening.current) return
                      setDetail(updated)
                      toast(
                        'Password setup email queued. Check the invitation status after refresh.',
                      )
                    } catch (error) {
                      if (generation === opening.current) toast(message(error), true)
                    } finally {
                      setInviting(false)
                    }
                  }}
                >
                  {inviting ? 'Queuing…' : 'Resend invitation'}
                </button>
              )}
            <button className="btn" onClick={closeDetail}>
              Close
            </button>
            {detail.status !== 'deleted' && !detail.pendingOperation && (
              <button
                className="btn btn-primary"
                onClick={() => {
                  setEditor(detail)
                  closeDetail()
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
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const dirty = name !== (user?.name || '') || email !== (user?.email || ''),
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
            : 'Invite a learner by email'
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
            const saved = await api.saveUser({ name, email }, user?.id, user?.revision)
            toast(
              api.mode === 'firebase'
                ? user
                  ? 'User updated in Firebase.'
                  : `Account created. Invitation: ${saved.invitationStatus || 'pending'}.`
                : user
                  ? 'Demo user updated.'
                  : 'Demo user added. Firebase Authentication was not changed.',
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
          <p className="info-note">
            {api.mode === 'demo'
              ? 'Demo changes are local. Real account creation, email updates and access control require a backend connected to Firebase Auth.'
              : 'New learners receive a password setup email. Rating and coins are read only. Saving changes updates the Firebase account.'}
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
            await api.setUserStatus(user.id, status, reason, user.revision)
            toast(
              `${title}: ${api.mode === 'demo' ? 'demo account updated.' : 'Firebase account updated.'}`,
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
          <p>
            {api.mode === 'firebase'
              ? deleting
                ? 'The account will be disabled and anonymized. Results and valid grants remain; this action cannot be undone.'
                : status === 'banned'
                  ? 'The account will be blocked and active sessions handled by the server.'
                  : 'The account will be reopened. The learner must sign in again.'
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
