import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import {
  Activity,
  Bell,
  BookOpen,
  ChartNoAxesCombined,
  Check,
  ChevronDown,
  ChevronsUpDown,
  CircleHelp,
  CircleUserRound,
  Command,
  FlaskConical,
  LayoutDashboard,
  LogOut,
  Menu,
  Search,
  Settings,
  ShieldCheck,
  Swords,
  Users,
  X,
} from 'lucide-react'
import type { AdminService, PageId } from './domain'
import { loadWorkspaceService } from './data/firebase-service'
import { AdminContext } from './context'
import { useDebounced, useResource, useRoute } from './hooks'
import {
  Avatar,
  Empty,
  ErrorState,
  Field,
  FormError,
  Loading,
  Modal,
  Pagination,
  RangePicker,
  SearchInput,
} from './components'
import { dateTime, defaultRange, message } from './lib'
import { SignInForm } from './firebase/SignIn'
import type { AuthGateway, FirebaseSession } from './firebase/auth'
import { useAdminAuth, type AdminAuthController } from './firebase/useAdminAuth'
const Dashboard = lazy(() => import('./pages/Overview').then((m) => ({ default: m.Dashboard })))
const Analytics = lazy(() => import('./pages/Overview').then((m) => ({ default: m.Analytics })))
const UsersPage = lazy(() => import('./pages/Users').then((m) => ({ default: m.UsersPage })))
const ContentPage = lazy(() => import('./pages/Content').then((m) => ({ default: m.ContentPage })))
const BattlesPage = lazy(() => import('./pages/Battles').then((m) => ({ default: m.BattlesPage })))
const NotificationsPage = lazy(() =>
  import('./pages/Notifications').then((m) => ({ default: m.NotificationsPage })),
)

const navigation = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'users', label: 'Users', icon: Users },
  { id: 'content', label: 'Content', icon: BookOpen },
  { id: 'battles', label: 'Battles', icon: Swords },
  { id: 'analytics', label: 'Analytics', icon: ChartNoAxesCombined },
  { id: 'notifications', label: 'Notifications', icon: Bell },
]
function Login({ auth }: { auth: AdminAuthController }) {
  return (
    <main className="login-page">
      <section className="login-story">
        <a className="brand" href="#/dashboard">
          <span className="brand-icon">
            <Swords size={23} />
          </span>
          English Battle
        </a>
        <div className="login-copy">
          <span className="eyebrow">THE ADMIN WORKSPACE</span>
          <h1>
            A little more clarity.
            <br />A better place to learn.
          </h1>
          <p>
            Bring your community, learning content and battle activity together in one workspace.
          </p>
          <div className="login-illustration" aria-hidden="true">
            <div className="illustration-orbit" />
            <div className="illustration-card">
              <ChartNoAxesCombined size={32} />
              <span>Learning, at a glance</span>
              <i />
              <i />
              <i />
              <i />
              <i />
            </div>
            <span className="illustration-badge">
              <ShieldCheck /> Built for your community
            </span>
          </div>
        </div>
        <span className="login-bottom">English Battle · Administration</span>
      </section>
      <section className="login-form-wrap">
        <div className="login-form">
          <SignInForm auth={auth} />
        </div>
      </section>
    </main>
  )
}

export default function App({
  api,
  authLoader,
}: {
  api?: AdminService
  authLoader?: () => Promise<AuthGateway>
}) {
  const auth = useAdminAuth(authLoader)
  const [loaded, setLoaded] = useState<{ uid: string; api: AdminService } | null>(null)
  const [serviceError, setServiceError] = useState('')
  const [accessError, setAccessError] = useState('')
  const [serviceRevision, setServiceRevision] = useState(0)
  useEffect(() => {
    let closed = false
    const controller = new AbortController()
    setLoaded(null)
    setServiceError('')
    if (!api && auth.session?.isAdmin) {
      const uid = auth.session.uid
      void loadWorkspaceService(uid, controller.signal)
        .then((value) => {
          if (!closed) {
            if (value.mode === 'firebase' && !window.location.hash) window.location.hash = '/users'
            setLoaded({ uid, api: value })
          }
        })
        .catch((error) => {
          if (!closed) setServiceError(message(error))
        })
    }
    return () => {
      closed = true
      controller.abort()
      if (auth.session?.isAdmin) api?.dispose?.()
    }
  }, [api, auth.session?.uid, auth.session?.isAdmin, serviceRevision])
  const activeApi = api || (loaded?.uid === auth.session?.uid ? loaded?.api : undefined)
  useEffect(() => {
    if (!auth.session?.isAdmin) return
    setAccessError('')
    const uid = auth.session.uid
    const denied = (event: Event) => {
      const detail = (event as CustomEvent<{ uid: string; message: string }>).detail
      if (detail?.uid !== uid) return
      setAccessError(detail.message)
      activeApi?.dispose?.()
      auth.invalidate(detail.message)
      void auth.signOut()
    }
    window.addEventListener('admin:access-denied', denied)
    const timer =
      activeApi?.mode === 'firebase'
        ? setInterval(() => {
            void activeApi.profile().catch(() => {})
          }, 30000)
        : undefined
    return () => {
      window.removeEventListener('admin:access-denied', denied)
      clearInterval(timer)
    }
  }, [auth.session?.uid, auth.session?.isAdmin, activeApi])
  if (!auth.session?.isAdmin)
    return (
      <Login
        auth={{
          ...auth,
          error: auth.error || accessError,
          signIn: (email, password) => {
            window.location.hash =
              api?.mode === 'demo' || import.meta.env.VITE_ADMIN_DATA_MODE === 'demo'
                ? '/dashboard'
                : '/users'
            return auth.signIn(email, password)
          },
          refresh: () => {
            window.location.hash =
              api?.mode === 'demo' || import.meta.env.VITE_ADMIN_DATA_MODE === 'demo'
                ? '/dashboard'
                : '/users'
            return auth.refresh()
          },
        }}
      />
    )
  if (serviceError)
    return <ErrorState error={serviceError} retry={() => setServiceRevision((v) => v + 1)} />
  if (!activeApi) return <Loading label="Connecting admin services…" />
  return (
    <AdminWorkspace
      key={auth.session.uid}
      api={activeApi}
      session={auth.session}
      onSignOut={auth.signOut}
      authBusy={auth.busy}
      authError={auth.error}
    />
  )
}

function AdminWorkspace({
  api,
  session,
  onSignOut,
  authBusy,
  authError,
}: {
  api: AdminService
  session: FirebaseSession
  onSignOut: () => Promise<void>
  authBusy: boolean
  authError: string
}) {
  const { path, params, navigate } = useRoute(),
    page = path.slice(1) as PageId
  const [range, setRange] = useState(defaultRange),
    [mobileNav, setMobileNav] = useState(false)
  const [notice, setNotice] = useState<{ text: string; error: boolean; id: number } | null>(null),
    [panel, setPanel] = useState<'profile' | 'audit' | 'help' | 'reset' | 'denied' | null>(null)
  const [popover, setPopover] = useState<'notifications' | 'account' | 'search' | null>(null),
    [search, setSearch] = useState(''),
    [online, setOnline] = useState(navigator.onLine)
  const [previewingError, setPreviewingError] = useState(false)
  const [noticePage, setNoticePage] = useState(1),
    [noticeSize, setNoticeSize] = useState(10),
    [unreadOnly, setUnreadOnly] = useState(false)
  const profile = useResource(() => api.profile()),
    notifications = useResource(
      () => api.notifications({ page: noticePage, pageSize: noticeSize, unreadOnly }),
      [noticePage, noticeSize, unreadOnly],
    )
  const debouncedSearch = useDebounced(search),
    results = useResource(() => api.search(debouncedSearch), [debouncedSearch])
  const searchRef = useRef<HTMLInputElement>(null),
    headerRef = useRef<HTMLDivElement>(null),
    toastId = useRef(0)
  const toast = (text: string, error = false) => setNotice({ text, error, id: ++toastId.current })
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 5000)
    return () => clearTimeout(timer)
  }, [notice])
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        searchRef.current?.focus()
        setPopover('search')
      }
      if (e.key === 'Escape') {
        setPopover(null)
        setMobileNav(false)
      }
    }
    const outside = (e: MouseEvent) => {
      if (!headerRef.current?.contains(e.target as Node)) setPopover(null)
    }
    const connected = () => setOnline(navigator.onLine)
    document.addEventListener('keydown', key)
    document.addEventListener('mousedown', outside)
    window.addEventListener('online', connected)
    window.addEventListener('offline', connected)
    return () => {
      document.removeEventListener('keydown', key)
      document.removeEventListener('mousedown', outside)
      window.removeEventListener('online', connected)
      window.removeEventListener('offline', connected)
    }
  }, [])
  useEffect(() => {
    setMobileNav(false)
    setPopover(null)
    document.title = `${navigation.find((n) => n.id === page)?.label || 'Workspace'} · English Battle Admin`
    window.scrollTo?.(0, 0)
  }, [path, page])
  const signOut = () => {
    setPanel(null)
    setPopover(null)
    void onSignOut()
  }
  const go = (target: string) => {
    navigate(target)
    setMobileNav(false)
    setPopover(null)
  }
  const unread = notifications.data?.unreadTotal || 0,
    name =
      (api.mode === 'firebase' && profile.data?.name) ||
      session.name ||
      session.email ||
      'Administrator'
  return (
    <AdminContext.Provider value={{ api, toast, navigate: go, range, setRange }}>
      <div className="app-layout">
        {mobileNav && (
          <button
            className="sidebar-scrim"
            aria-label="Close navigation"
            onClick={() => setMobileNav(false)}
          />
        )}
        <aside className={`sidebar ${mobileNav ? 'sidebar-open' : ''}`}>
          <a href="#/dashboard" className="brand" onClick={() => setMobileNav(false)}>
            <span className="brand-icon">
              <Swords size={21} />
            </span>
            English Battle
          </a>
          <span className="workspace-label">WORKSPACE</span>
          <nav aria-label="Main navigation">
            {navigation.map(({ id, label, icon: Icon }) => (
              <a
                key={id}
                href={`#/${id}`}
                className={page === id ? 'active' : ''}
                aria-current={page === id ? 'page' : undefined}
                onClick={() => setMobileNav(false)}
              >
                <Icon size={17} />
                <span>{label}</span>
                {page === id && <i />}
              </a>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <span className="system-status">
              <i />
              {api.mode === 'demo' ? 'Demo services ready' : 'Firebase · Admin services'}
            </span>
            <button className="sidebar-account" onClick={() => setPanel('profile')}>
              <Avatar name={name} />
              <span>
                <strong>{name}</strong>
                <small>Administrator</small>
              </span>
              <ChevronsUpDown size={14} />
            </button>
          </div>
        </aside>
        <div className="workspace-main">
          <header className="topbar" ref={headerRef}>
            <div className="breadcrumb">
              <button
                className="icon-btn mobile-toggle"
                aria-label="Open navigation"
                onClick={() => setMobileNav((v) => !v)}
              >
                <Menu size={20} />
              </button>
              <span>Workspace</span>
              <span className="breadcrumb-arrow">›</span>
              <strong>{navigation.find((n) => n.id === page)?.label || 'Page not found'}</strong>
            </div>
            <button
              className="demo-indicator"
              aria-label="Preview details"
              title={
                api.mode === 'demo'
                  ? 'Demo workspace · Local sample data · No live admin data'
                  : 'Firebase data · Users, content, monitoring and analytics'
              }
              onClick={() => setPanel('help')}
            >
              <FlaskConical size={13} />
              <span>{api.mode === 'demo' ? 'Demo workspace' : 'Firebase workspace'}</span>
            </button>
            <div className="header-actions">
              <div className="global-search">
                <Search size={15} />
                <input
                  ref={searchRef}
                  placeholder="Search anything…"
                  aria-label="Search anything"
                  maxLength={100}
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value)
                    setPopover('search')
                  }}
                  onFocus={() => setPopover('search')}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && results.data?.[0]) {
                      const r = results.data[0]
                      go(`/${r.page}?q=${encodeURIComponent(r.query)}`)
                    }
                  }}
                />
                <kbd>
                  <Command size={10} /> K
                </kbd>
              </div>
              <button
                className="icon-btn bell"
                aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
                aria-expanded={popover === 'notifications'}
                onClick={() => {
                  setNoticePage(1)
                  if (popover !== 'notifications') notifications.reload()
                  setPopover(popover === 'notifications' ? null : 'notifications')
                }}
              >
                <Bell size={19} />
                {unread > 0 && <i />}
              </button>
              <span className="header-divider" />
              <button
                className="workspace-menu"
                aria-label="English Battle"
                aria-expanded={popover === 'account'}
                onClick={() => setPopover(popover === 'account' ? null : 'account')}
              >
                <CircleUserRound size={18} className="mobile-account-icon" />
                <span>English Battle</span>
                <ChevronDown size={13} />
              </button>
            </div>
            {popover === 'search' && (
              <div className="header-popover search-results">
                <h3>Search workspace</h3>
                {search.trim().length < 2 ? (
                  <p>Search users, question text or a match ID. Enter at least 2 characters.</p>
                ) : results.loading ? (
                  <p>Searching…</p>
                ) : results.error ? (
                  <p role="alert">{results.error}</p>
                ) : !results.data?.length ? (
                  <p>No matching records.</p>
                ) : (
                  results.data.map((r) => (
                    <button
                      key={r.id}
                      onClick={() => go(`/${r.page}?q=${encodeURIComponent(r.query)}`)}
                    >
                      <Search size={15} />
                      <span>
                        <strong>{r.label}</strong>
                        <small>{r.detail}</small>
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
            {popover === 'notifications' && (
              <div className="header-popover notifications-panel">
                <div className="popover-heading">
                  <h3>
                    Notifications <span className="count-chip">{unread}</span>
                  </h3>
                  <button
                    className="text-btn"
                    disabled={notifications.loading || !unread}
                    onClick={async () => {
                      try {
                        await api.readNotifications()
                        setNoticePage(1)
                      } catch (e) {
                        toast(message(e), true)
                      }
                    }}
                  >
                    Mark all read
                  </button>
                </div>
                <div className="popover-heading">
                  <label>
                    <input
                      type="checkbox"
                      checked={unreadOnly}
                      onChange={(e) => {
                        setUnreadOnly(e.target.checked)
                        setNoticePage(1)
                      }}
                    />{' '}
                    Unread only
                  </label>
                  <button
                    className="text-btn"
                    onClick={() => {
                      setNoticePage(1)
                      notifications.reload()
                    }}
                  >
                    Refresh
                  </button>
                </div>
                {notifications.loading ? (
                  <p>Loading notifications…</p>
                ) : notifications.error ? (
                  <div role="alert">
                    <p>{notifications.error}</p>
                    <button
                      className="text-btn"
                      onClick={() => {
                        setNoticePage(1)
                        notifications.reload()
                      }}
                    >
                      Try again
                    </button>
                  </div>
                ) : !notifications.data?.items.length ? (
                  <p>You’re all caught up.</p>
                ) : (
                  <div className="notification-items">
                    {notifications.data.items.map((n) => (
                      <button
                        className={`notification ${n.read ? '' : 'unread'}`}
                        key={n.id}
                        onClick={async () => {
                          try {
                            await api.readNotifications(n.id)
                            setNoticePage(1)
                            go(`/${n.page}`)
                          } catch (e) {
                            toast(message(e), true)
                          }
                        }}
                      >
                        <span className="notification-icon">
                          <Activity size={17} />
                        </span>
                        <span>
                          <strong>{n.title}</strong>
                          <p>{n.body}</p>
                          <small>{dateTime(n.at)}</small>
                        </span>
                        {!n.read && <i />}
                      </button>
                    ))}
                  </div>
                )}
                {notifications.data && !notifications.error && (
                  <div className="notification-pager">
                    <select
                      aria-label="Notification page size"
                      value={noticeSize}
                      onChange={(e) => {
                        setNoticeSize(Number(e.target.value))
                        setNoticePage(1)
                      }}
                    >
                      {[10, 20, 50].map((n) => (
                        <option key={n} value={n}>
                          {n} rows
                        </option>
                      ))}
                    </select>
                    <button
                      className="text-btn"
                      aria-label="Previous notification page"
                      disabled={notifications.loading || noticePage <= 1}
                      onClick={() => setNoticePage((n) => n - 1)}
                    >
                      Previous
                    </button>
                    <span>
                      {noticePage}/{Math.max(1, Math.ceil(notifications.data.total / noticeSize))}
                    </span>
                    <button
                      className="text-btn"
                      aria-label="Next notification page"
                      disabled={
                        notifications.loading || noticePage * noticeSize >= notifications.data.total
                      }
                      onClick={() => setNoticePage((n) => n + 1)}
                    >
                      Next
                    </button>
                  </div>
                )}
              </div>
            )}
            {popover === 'account' && (
              <div className="header-popover account-popover">
                <div className="account-info">
                  <strong>{name}</strong>
                  <small>{session.email}</small>
                </div>
                {[
                  {
                    label: 'Profile & workspace',
                    icon: Settings,
                    action: () => setPanel('profile'),
                  },
                  { label: 'Admin activity log', icon: Activity, action: () => setPanel('audit') },
                  {
                    label: api.mode === 'demo' ? 'About this preview' : 'About this workspace',
                    icon: CircleHelp,
                    action: () => setPanel('help'),
                  },
                  { label: 'Sign out', icon: LogOut, action: signOut },
                ].map((item) => (
                  <button
                    key={item.label}
                    disabled={authBusy && item.label === 'Sign out'}
                    onClick={() => {
                      setPopover(null)
                      item.action()
                    }}
                  >
                    <item.icon size={15} />
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          </header>
          {authError && (
            <p role="alert" className="storage-warning">
              {authError}
            </p>
          )}
          {!online && (
            <div className="offline-banner" role="status">
              {api.mode === 'demo'
                ? 'You’re offline. This demo continues to use data saved in your browser.'
                : 'You’re offline. Keep your form open and retry when connected.'}
            </div>
          )}
          {api.mode === 'demo' && api.storageWarning && (
            <p role="alert" className="storage-warning">
              {api.storageWarning}
            </p>
          )}
          <main className="page-content" id="main-content">
            <Suspense fallback={<Loading label="Loading page…" />}>
              {previewingError ? (
                <ErrorState
                  error="Simulated connection error. This is a preview of the retry state."
                  retry={() => setPreviewingError(false)}
                />
              ) : page === 'dashboard' ? (
                <Dashboard />
              ) : page === 'users' ? (
                <UsersPage key={params.get('q') || 'users'} initialSearch={params.get('q') || ''} />
              ) : page === 'content' ? (
                <ContentPage
                  key={params.get('q') || 'content'}
                  initialSearch={params.get('q') || ''}
                />
              ) : page === 'battles' ? (
                <BattlesPage
                  key={params.get('q') || 'battles'}
                  initialSearch={params.get('q') || ''}
                />
              ) : page === 'analytics' ? (
                <Analytics />
              ) : page === 'notifications' ? (
                <NotificationsPage />
              ) : (
                <Empty
                  title="Page not found"
                  description="Choose a page from the workspace navigation."
                  action={
                    <button className="btn" onClick={() => go('/dashboard')}>
                      Back to dashboard
                    </button>
                  }
                />
              )}
            </Suspense>
          </main>
        </div>
      </div>
      {notice && (
        <div
          key={notice.id}
          className={`toast ${notice.error ? 'toast-error' : ''}`}
          role={notice.error ? 'alert' : 'status'}
        >
          <Check size={17} />
          <span>{notice.text}</span>
          <button className="icon-btn" aria-label="Dismiss message" onClick={() => setNotice(null)}>
            <X size={16} />
          </button>
        </div>
      )}
      {panel === 'profile' && (
        <ProfilePanel api={api} onClose={() => setPanel(null)} onReset={() => setPanel('reset')} />
      )}
      {panel === 'audit' && <AuditDialog api={api} onClose={() => setPanel(null)} />}
      {panel === 'help' && api.mode === 'firebase' && (
        <Modal
          title="Firebase workspace"
          subtitle="Users, content, monitoring and analytics"
          onClose={() => setPanel(null)}
        >
          <div className="modal-body prose">
            <p>
              Profile and Users read and update Firebase accounts. Rating and coins are read only.
            </p>
            <p>
              Content manages skills, topics, lessons and versioned questions in Firebase. Listening
              uses text-to-speech. Existing session snapshots are preserved.
            </p>
            <p>
              Battles monitors quick matches and recorded activity. Daily/private battles remain
              unavailable.
            </p>
            <p>
              Dashboard and Analytics use published server aggregates, with update time and
              historical data coverage shown on each page.
            </p>
            <p>
              Search, notifications, audit browsing and filtered CSV reports use authorized backend
              APIs. Errors are shown directly, and saved changes remain available after reload.
            </p>
            <p>
              New accounts receive a Firebase password setup email. Check the invitation status
              before sending again.
            </p>
          </div>
        </Modal>
      )}
      {panel === 'help' && api.mode === 'demo' && (
        <Modal
          title="About this preview"
          subtitle="Verified admin access · Sample business data"
          onClose={() => setPanel(null)}
        >
          <div className="modal-body prose">
            <p>
              All five pages use a shared mock service. Your edits stay in this browser; signing out
              preserves demo data.
            </p>
            <p>
              Your administrator access is verified through Firebase and the server. User accounts,
              moderation and publishing on these sample pages do not change Firebase. Listening
              uploads are stored locally for preview, with a 2 MB limit.
            </p>
            <p>
              Use the account menu to view an audit log or reset the sample data. A service contract
              is included for connecting a backend later.
            </p>
            <div className="preview-actions">
              <button
                className="btn"
                onClick={() => {
                  setPreviewingError(true)
                  setPanel(null)
                }}
              >
                Preview loading error
              </button>
              <button className="btn" onClick={() => setPanel('denied')}>
                Preview access denied
              </button>
            </div>
          </div>
        </Modal>
      )}
      {panel === 'denied' && (
        <Modal
          title="Access restricted"
          subtitle="Preview of the admin permission error"
          onClose={() => setPanel(null)}
        >
          <div className="empty-state">
            <ShieldCheck size={36} />
            <h3>Administrator access required</h3>
            <p>
              A connected backend must verify the signed-in account’s permissions before opening
              this workspace.
            </p>
            <button className="btn" onClick={() => setPanel(null)}>
              Return to demo
            </button>
          </div>
        </Modal>
      )}
      {panel === 'reset' && api.mode === 'demo' && (
        <ResetDialog api={api} onClose={() => setPanel(null)} />
      )}
    </AdminContext.Provider>
  )
}

function ProfilePanel({
  api,
  onClose,
  onReset,
}: {
  api: AdminService
  onClose: () => void
  onReset: () => void
}) {
  const profile = useResource(() => api.profile())
  if (profile.loading || profile.error || !profile.data)
    return (
      <Modal
        title="Profile & workspace"
        subtitle={
          api.mode === 'demo' ? 'Demo administrator profile' : 'Firebase administrator profile'
        }
        onClose={onClose}
      >
        <div className="modal-body">
          {profile.error ? (
            <ErrorState error={profile.error} retry={profile.reload} />
          ) : (
            <Loading label="Loading profile…" />
          )}
        </div>
      </Modal>
    )
  return (
    <ProfileDialog
      api={api}
      name={profile.data.name}
      email={profile.data.email}
      revision={profile.data.revision}
      onClose={onClose}
      onReset={onReset}
    />
  )
}
function ProfileDialog({
  api,
  name,
  email,
  revision,
  onClose,
  onReset,
}: {
  api: AdminService
  name: string
  email: string
  revision?: number
  onClose: () => void
  onReset: () => void
}) {
  const [value, setValue] = useState(name),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const [expectedRevision] = useState(revision)
  return (
    <Modal
      title="Profile & workspace"
      subtitle={
        api.mode === 'demo' ? 'Demo administrator profile' : 'Firebase administrator profile'
      }
      onClose={onClose}
      busy={busy}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError('')
          try {
            await api.saveProfile(value, expectedRevision)
            onClose()
          } catch (e) {
            setError(message(e))
          } finally {
            setBusy(false)
          }
        }}
      >
        <div className="modal-body">
          <div className="profile-preview">
            <Avatar name={value} />
            <span>
              <strong>{value}</strong>
              <small>
                Administrator · {api.mode === 'demo' ? 'Demo access' : 'Firebase access'}
              </small>
            </span>
          </div>
          <Field label="Display name">
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              required
              minLength={2}
              maxLength={80}
            />
          </Field>
          <Field
            label="Email address"
            hint={
              api.mode === 'demo'
                ? 'Authentication and email changes will be connected to Firebase later.'
                : 'Use the account email change flow to change your own sign-in address.'
            }
          >
            <input value={email} disabled />
          </Field>
          <FormError error={error} />
          {api.mode === 'demo' && (
            <div className="reset-area">
              <strong>Demo data</strong>
              <p>Restore sample users, content and activity in this browser.</p>
              <button type="button" className="btn btn-danger-outline" onClick={onReset}>
                Reset demo data
              </button>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save profile'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
function ResetDialog({ api, onClose }: { api: AdminService; onClose: () => void }) {
  const [value, setValue] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  return (
    <Modal
      title="Reset demo data?"
      subtitle="This replaces local demo edits with the original samples."
      onClose={onClose}
      busy={busy}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          if (value !== 'RESET') return
          setBusy(true)
          try {
            await api.reset()
            onClose()
          } catch (e) {
            setError(message(e))
          } finally {
            setBusy(false)
          }
        }}
      >
        <div className="modal-body">
          <Field label="Type RESET to confirm">
            <input value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" />
          </Field>
          <FormError error={error} />
        </div>
        <div className="modal-footer">
          <button className="btn" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-danger" disabled={value !== 'RESET' || busy}>
            Reset demo data
          </button>
        </div>
      </form>
    </Modal>
  )
}
function AuditDialog({ api, onClose }: { api: AdminService; onClose: () => void }) {
  const [page, setPage] = useState(1),
    [size, setSize] = useState(10),
    [q, setQ] = useState(''),
    [result, setResult] = useState(''),
    [range, setRange] = useState(defaultRange)
  const search = useDebounced(q)
  const audit = useResource(
    () => api.audit({ page, pageSize: size, q: search, result, range }),
    [page, size, search, result, range.from, range.to],
  )
  return (
    <Modal
      title="Admin activity log"
      subtitle={
        api.mode === 'demo'
          ? 'The most recent 200 changes in this demo workspace'
          : 'Administrative audit history'
      }
      onClose={onClose}
      wide
    >
      <div className="modal-body">
        <div className="audit-filters">
          <SearchInput
            value={q}
            onChange={(v) => {
              setQ(v)
              setPage(1)
            }}
            placeholder="Search actor, action, target or reason…"
          />
          <select
            aria-label="Audit result"
            value={result}
            onChange={(e) => {
              setResult(e.target.value)
              setPage(1)
            }}
          >
            <option value="">All results</option>
            {['succeeded', 'failed', 'blocked'].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
          <RangePicker
            range={range}
            onChange={(v) => {
              setRange(v)
              setPage(1)
            }}
          />
        </div>
        {audit.loading ? (
          <Loading />
        ) : audit.error ? (
          <ErrorState
            error={audit.error}
            retry={() => {
              setPage(1)
              audit.reload()
            }}
          />
        ) : !audit.data?.items.length ? (
          <Empty
            title="No admin changes yet"
            description="Save a user or question to see the action recorded here."
          />
        ) : (
          <ol className="timeline">
            {audit.data.items.map((a) => (
              <li key={a.id}>
                <span className="timeline-dot" />
                <div>
                  <strong>{a.action}</strong>
                  <p>
                    {a.actor} · {a.target}
                    {a.reason ? ` · ${a.reason}` : ''}
                  </p>
                  <small>{dateTime(a.at)}</small>
                  {a.result && (
                    <p>
                      {a.result}
                      {a.errorCode ? ` · ${a.errorCode}` : ''}
                    </p>
                  )}
                  {a.operationId && <code>{a.operationId}</code>}
                </div>
              </li>
            ))}
          </ol>
        )}
        {audit.data && !audit.error && (
          <Pagination
            page={audit.data}
            onPage={setPage}
            onSize={(n) => {
              setSize(n)
              setPage(1)
            }}
            label="audit entries"
          />
        )}
      </div>
    </Modal>
  )
}
