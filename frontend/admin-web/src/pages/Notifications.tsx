import { useEffect, useRef, useState } from 'react'
import { Bell, Coins, RefreshCw, Send, X } from 'lucide-react'
import { useAdmin } from '../context'
import { useDebounced, useResource } from '../hooks'
import {
  Avatar,
  Badge,
  Empty,
  ErrorState,
  Field,
  FormError,
  Loading,
  Modal,
  Pagination,
  SearchInput,
} from '../components'
import type { CampaignInput } from '../domain'
import { dateTime, message, number } from '../lib'

const initialInput: CampaignInput = {
  kind: 'notification',
  audience: 'selected',
  title: '',
  body: '',
  destination: 'Practice',
  coinAmount: 0,
  recipientIds: [],
}

export function NotificationsPage() {
  const { api, toast } = useAdmin()
  const [recovered] = useState(() => api.pendingCampaign?.() || null)
  const [input, setInput] = useState<CampaignInput>(recovered?.input || initialInput)
  const [reason, setReason] = useState(recovered?.reason || '')
  const [search, setSearch] = useState(''),
    [page, setPage] = useState(1)
  const [size, setSize] = useState(10)
  const [names, setNames] = useState<Record<string, string>>({})
  const [review, setReview] = useState(false),
    [busy, setBusy] = useState(false)
  const [pending, setPending] = useState(Boolean(recovered)),
    [error, setError] = useState('')
  const mounted = useRef(true),
    submitting = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const q = useDebounced(search)
  const accounts = useResource(
    () =>
      input.audience === 'selected'
        ? api.users({ q, status: 'active', page, pageSize: size })
        : Promise.resolve(null),
    [q, page, size, input.audience],
  )
  const history = useResource(() => api.campaigns(), [])
  useEffect(() => {
    const timer = window.setInterval(history.reload, 5000)
    return () => window.clearInterval(timer)
  }, [history.reload])
  const valid =
    input.title.trim().length > 0 &&
    input.body.trim().length > 0 &&
    reason.trim().length > 0 &&
    (input.audience === 'all' || input.recipientIds.length > 0) &&
    (input.kind !== 'coins' ||
      (Number.isSafeInteger(input.coinAmount) &&
        input.coinAmount >= 1 &&
        input.coinAmount <= 1000000))
  const update = (patch: Partial<CampaignInput>) => {
    setError('')
    setInput((current) => ({ ...current, ...patch }))
  }
  const submit = async () => {
    if (!valid || submitting.current) return
    submitting.current = true
    setBusy(true)
    setError('')
    setPending(true)
    try {
      await api.createCampaign(
        {
          ...input,
          title: input.title.trim(),
          body: input.body.trim(),
          recipientIds: input.audience === 'all' ? [] : [...input.recipientIds].sort(),
        },
        reason.trim(),
      )
      if (!mounted.current) return
      setReview(false)
      setPending(false)
      setInput(initialInput)
      setReason('')
      setNames({})
      toast('Request accepted. Delivery progress appears in Recent sends.')
      history.reload()
    } catch (cause) {
      if (mounted.current) setError(message(cause))
    } finally {
      submitting.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Notifications</h1>
          <p>Reach your learners, or add a little encouragement to their wallets.</p>
        </div>
        <span className="campaign-heading-icon">
          <Bell size={24} />
        </span>
      </div>
      <div className="campaign-layout">
        <section className="panel campaign-compose">
          <div className="panel-heading">
            <div>
              <h2>Create a send</h2>
              <p>Choose a message or a coin gift.</p>
            </div>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (valid) setReview(true)
            }}
          >
            <fieldset disabled={busy || pending}>
              <div className="campaign-kind" role="group" aria-label="Send type">
                <button
                  type="button"
                  className={input.kind === 'notification' ? 'selected' : ''}
                  aria-pressed={input.kind === 'notification'}
                  onClick={() =>
                    update({ kind: 'notification', coinAmount: 0, destination: 'Practice' })
                  }
                >
                  <Bell size={18} />
                  <strong>Notification</strong>
                  <span>A message in the app inbox</span>
                </button>
                <button
                  type="button"
                  className={input.kind === 'coins' ? 'selected' : ''}
                  aria-pressed={input.kind === 'coins'}
                  onClick={() => update({ kind: 'coins', coinAmount: 10, destination: 'Wallet' })}
                >
                  <Coins size={18} />
                  <strong>Coin gift</strong>
                  <span>Credit coins to each account</span>
                </button>
              </div>
              <Field label="Recipients">
                <select
                  value={input.audience}
                  onChange={(event) => {
                    update({ audience: event.target.value as CampaignInput['audience'] })
                    setPage(1)
                  }}
                >
                  <option value="selected">Selected accounts</option>
                  <option value="all">All active accounts</option>
                </select>
              </Field>
              {input.audience === 'selected' && (
                <div className="campaign-recipients">
                  <SearchInput
                    value={search}
                    onChange={(value) => {
                      setSearch(value)
                      setPage(1)
                    }}
                    placeholder="Find accounts by name, email or UID"
                  />
                  {input.recipientIds.length > 0 && (
                    <div className="campaign-chips">
                      {input.recipientIds.map((id) => (
                        <button
                          type="button"
                          key={id}
                          onClick={() =>
                            update({
                              recipientIds: input.recipientIds.filter((item) => item !== id),
                            })
                          }
                          aria-label={`Remove ${names[id] || id}`}
                        >
                          {names[id] || id}
                          <X size={12} />
                        </button>
                      ))}
                    </div>
                  )}
                  <p className="muted small-text">
                    {input.recipientIds.length}/50 selected · selection is kept across search and
                    pages
                  </p>
                  {accounts.error ? (
                    <ErrorState error={accounts.error} retry={accounts.reload} />
                  ) : accounts.loading ? (
                    <Loading label="Finding accounts…" />
                  ) : (
                    accounts.data && (
                      <>
                        <div className="campaign-account-list">
                          {accounts.data.items.map((account) => (
                            <label key={account.id}>
                              <input
                                type="checkbox"
                                checked={input.recipientIds.includes(account.id)}
                                disabled={
                                  Boolean(account.pendingOperation) ||
                                  (input.recipientIds.length >= 50 &&
                                    !input.recipientIds.includes(account.id))
                                }
                                onChange={(event) => {
                                  setNames((current) => ({
                                    ...current,
                                    [account.id]: account.name,
                                  }))
                                  update({
                                    recipientIds: event.target.checked
                                      ? [...input.recipientIds, account.id]
                                      : input.recipientIds.filter((id) => id !== account.id),
                                  })
                                }}
                              />
                              <Avatar name={account.name} small />
                              <span>
                                <strong>{account.name}</strong>
                                <small>{account.email || account.id}</small>
                              </span>
                            </label>
                          ))}
                        </div>
                        {!accounts.data.items.length && (
                          <p className="muted">No active accounts match this search.</p>
                        )}
                        <Pagination
                          page={accounts.data}
                          onPage={setPage}
                          onSize={(value) => {
                            setSize(value)
                            setPage(1)
                          }}
                          label="accounts"
                        />
                      </>
                    )
                  )}
                </div>
              )}
              {input.kind === 'coins' && (
                <Field label="Coins per account" hint="A whole number from 1 to 1,000,000.">
                  <input
                    type="number"
                    required
                    min={1}
                    max={1000000}
                    step={1}
                    value={input.coinAmount || ''}
                    onChange={(event) => update({ coinAmount: Number(event.target.value) })}
                  />
                </Field>
              )}
              <Field label="Title">
                <input
                  required
                  maxLength={120}
                  value={input.title}
                  onChange={(event) => update({ title: event.target.value })}
                  placeholder={
                    input.kind === 'coins'
                      ? 'A gift to keep you learning'
                      : 'A new update for your next battle'
                  }
                />
              </Field>
              <Field label="Message">
                <textarea
                  required
                  rows={4}
                  maxLength={2000}
                  value={input.body}
                  onChange={(event) => update({ body: event.target.value })}
                  placeholder="Write the message learners will see…"
                />
              </Field>
              {input.kind === 'notification' && (
                <Field label="Open when tapped">
                  <select
                    value={input.destination}
                    onChange={(event) =>
                      update({ destination: event.target.value as CampaignInput['destination'] })
                    }
                  >
                    {[
                      'Practice',
                      'Challenge',
                      'Battle',
                      'Leaderboard',
                      'Achievements',
                      'History',
                      'Wallet',
                    ].map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </Field>
              )}
              <Field
                label="Admin reason"
                hint="Saved in the admin audit log; learners do not see this reason."
              >
                <input
                  required
                  maxLength={500}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="For example: November learning reward"
                />
              </Field>
            </fieldset>
            <FormError error={error} />
            {pending && !busy && (
              <p className="campaign-note">
                This request has not been confirmed yet. Retry the same request to verify its result
                before creating another send.
              </p>
            )}
            <div className="campaign-actions">
              {pending ? (
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={busy}
                  onClick={() => void submit()}
                >
                  <RefreshCw size={15} />
                  {busy ? 'Verifying…' : 'Retry same request'}
                </button>
              ) : (
                <button className="btn btn-primary" type="submit" disabled={!valid || busy}>
                  <Send size={15} />
                  Review send
                </button>
              )}
            </div>
          </form>
        </section>
        <aside className="campaign-aside">
          <section className="panel campaign-preview">
            <span className="eyebrow">IN-APP PREVIEW</span>
            <div className="campaign-preview-card">
              <span className="campaign-preview-icon">
                {input.kind === 'coins' ? <Coins size={22} /> : <Bell size={22} />}
              </span>
              <h3>{input.title || 'Your message title'}</h3>
              <p>{input.body || 'Your message will appear here.'}</p>
              {input.kind === 'coins' && (
                <strong className="campaign-coin-value">+{number(input.coinAmount)} coins</strong>
              )}
            </div>
            <p className="campaign-note">
              Messages appear directly in the app’s Notifications inbox. Only accounts that enabled
              notifications receive a message. Missing preferences mean notifications are off.
            </p>
            <p className="campaign-note">
              Coin gifts still reach eligible wallets when notifications are off; the accompanying
              message follows the notification preference. Banned, deleted and unavailable accounts
              are skipped.
            </p>
          </section>
        </aside>
      </div>
      <section className="panel data-panel campaign-history">
        <div className="panel-heading">
          <div>
            <h2>Recent sends</h2>
            <p>Latest 20 requests · progress updates every 5 seconds</p>
          </div>
          <button className="btn" onClick={history.reload}>
            <RefreshCw size={14} />
            Refresh
          </button>
        </div>
        {history.error ? (
          <ErrorState error={history.error} retry={history.reload} />
        ) : !history.data && history.loading ? (
          <Loading />
        ) : !history.data?.length ? (
          <Empty
            title="No sends yet"
            description="Your messages and coin gifts will appear here after you send them."
          />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Send</th>
                  <th>Audience</th>
                  <th>Status</th>
                  <th>Delivered</th>
                  <th>Inboxes</th>
                  <th>Skipped</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {history.data.map((send) => (
                  <tr key={send.id}>
                    <td>
                      <strong>{send.title}</strong>
                      <small className="campaign-send-kind">
                        {send.kind === 'coins'
                          ? `${number(send.coinAmount)} coins / account`
                          : 'Notification'}
                      </small>
                    </td>
                    <td>
                      {send.audience === 'all'
                        ? 'All active accounts'
                        : `${send.recipientIds?.length || 0} selected`}
                    </td>
                    <td>
                      <Badge value={send.status} />
                      {send.errorCode && (
                        <small className="campaign-send-kind">{send.errorCode}</small>
                      )}
                    </td>
                    <td>
                      {number(send.delivered)} / {number(send.processed)} processed
                    </td>
                    <td>{number(send.notified)}</td>
                    <td>{number(send.skipped)}</td>
                    <td>{dateTime(send.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {review && (
        <Modal title="Review your send" onClose={() => setReview(false)} busy={busy}>
          <div className="modal-body">
            <dl className="campaign-review">
              <div>
                <dt>Title</dt>
                <dd>
                  <strong>{input.title}</strong>
                </dd>
              </div>
              <div>
                <dt>Message</dt>
                <dd>{input.body}</dd>
              </div>
              <div>
                <dt>Recipients</dt>
                <dd>
                  {input.audience === 'all'
                    ? 'All active accounts'
                    : `${input.recipientIds.length} selected account(s)`}
                </dd>
              </div>
              {input.kind === 'coins' && (
                <div>
                  <dt>Coin gift</dt>
                  <dd>
                    <strong>{number(input.coinAmount)} coins per account</strong>
                    {input.audience === 'selected' && (
                      <small>
                        Up to {number(input.coinAmount * input.recipientIds.length)} coins total
                      </small>
                    )}
                  </dd>
                </div>
              )}
              <div>
                <dt>Opens</dt>
                <dd>{input.destination}</dd>
              </div>
            </dl>
            <p className="campaign-note">
              Only opted-in accounts receive inbox messages. Accepted sends are processed by the
              server and cannot be edited.
            </p>
            <FormError error={error} />
          </div>
          <div className="modal-footer">
            <button className="btn" disabled={pending} onClick={() => setReview(false)}>
              Back to edit
            </button>
            <button className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
              <Send size={15} />
              {busy ? 'Sending…' : pending ? 'Retry same request' : 'Confirm send'}
            </button>
          </div>
        </Modal>
      )}
    </>
  )
}
