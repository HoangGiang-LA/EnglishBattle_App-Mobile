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
import { MockAdminService } from './data/mock-service'
import { service } from './data/service'
import { AdminContext } from './context'
import { useDebounced, useResource, useRoute } from './hooks'
import { Avatar, Empty, ErrorState, Field, FormError, Loading, Modal } from './components'
import { dateTime, defaultRange, message } from './lib'
import { SignInForm } from './firebase/SignIn'
import type { AuthGateway, FirebaseSession } from './firebase/auth'
import { useAdminAuth, type AdminAuthController } from './firebase/useAdminAuth'
const Dashboard = lazy(() => import('./pages/Overview').then((m) => ({ default: m.Dashboard })))
const Analytics = lazy(() => import('./pages/Overview').then((m) => ({ default: m.Analytics })))
const UsersPage = lazy(() => import('./pages/Users').then((m) => ({ default: m.UsersPage })))
const ContentPage = lazy(() => import('./pages/Content').then((m) => ({ default: m.ContentPage })))
const BattlesPage = lazy(() => import('./pages/Battles').then((m) => ({ default: m.BattlesPage })))

const navigation = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'users', label: 'Users', icon: Users },
  { id: 'content', label: 'Content', icon: BookOpen },
  { id: 'battles', label: 'Battles', icon: Swords },
  { id: 'analytics', label: 'Analytics', icon: ChartNoAxesCombined },
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
  api = service,
  authLoader,
}: {
  api?: AdminService
  authLoader?: () => Promise<AuthGateway>
}) {
  const auth = useAdminAuth(authLoader)
  if (!auth.session?.isAdmin)
    return (
      <Login
        auth={{
          ...auth,
          signIn: (email, password) => {
            window.location.hash = '/dashboard'
            return auth.signIn(email, password)
          },
          refresh: () => {
            window.location.hash = '/dashboard'
            return auth.refresh()
          },
        }}
      />
    )
  return (
    <AdminWorkspace
      key={auth.session.uid}
      api={api}
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
  const profile = useResource(() => api.profile()),
    notifications = useResource(() => api.notifications())
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
  const unread = notifications.data?.filter((n) => !n.read).length || 0,
    name = session.name || session.email || 'Administrator'
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
              {api.mode === 'demo' ? 'Demo services ready' : 'Firebase API'}
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
                  : 'Firebase Callable API'
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
                onClick={() => setPopover(popover === 'notifications' ? null : 'notifications')}
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
                    onClick={() =>
                      api
                        .readNotifications()
                        .then(notifications.reload)
                        .catch((e) => toast(message(e), true))
                    }
                  >
                    Mark all read
                  </button>
                </div>
                {notifications.loading ? (
                  <Loading />
                ) : notifications.error ? (
                  <ErrorState error={notifications.error} retry={notifications.reload} />
                ) : !notifications.data?.length ? (
                  <p>You’re all caught up.</p>
                ) : (
                  notifications.data.map((n) => (
                    <button
                      className={`notification ${n.read ? '' : 'unread'}`}
                      key={n.id}
                      onClick={async () => {
                        try {
                          await api.readNotifications(n.id)
                          notifications.reload()
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
                  ))
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
                  { label: 'About this preview', icon: CircleHelp, action: () => setPanel('help') },
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
                : 'You’re offline. Reconnect before requesting Firebase data.'}
            </div>
          )}
          {api instanceof MockAdminService && api.storageWarning && (
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
      {panel === 'profile' && profile.loading && (
        <Modal title="Profile & workspace" onClose={() => setPanel(null)}>
          <Loading />
        </Modal>
      )}
      {panel === 'profile' && profile.error && (
        <Modal title="Profile & workspace" onClose={() => setPanel(null)}>
          <ErrorState error={profile.error} retry={profile.reload} />
        </Modal>
      )}
      {panel === 'profile' && !profile.loading && !profile.error && (
        <ProfileDialog
          api={api}
          name={profile.data?.name || name}
          email={profile.data?.email || ''}
          onClose={() => setPanel(null)}
          onReset={() => setPanel('reset')}
        />
      )}
      {panel === 'audit' && <AuditDialog api={api} onClose={() => setPanel(null)} />}
      {panel === 'help' && api.mode === 'firebase' && (
        <Modal title="Firebase API" onClose={() => setPanel(null)}>
          <p>
            Business data uses Firebase Callable APIs. Missing backend functions are shown as
            errors; sample data is never substituted.
          </p>
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

function ProfileDialog({
  api,
  name,
  email,
  onClose,
  onReset,
}: {
  api: AdminService
  name: string
  email: string
  onClose: () => void
  onReset: () => void
}) {
  const [value, setValue] = useState(name),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  return (
    <Modal
      title="Profile & workspace"
      subtitle={api.mode === 'demo' ? 'Demo administrator profile' : 'Administrator profile'}
      onClose={onClose}
      busy={busy}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError('')
          try {
            await api.saveProfile(value)
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
          <Field label="Email address" hint="Email is read-only in this form.">
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
  const audit = useResource(() => api.audit())
  return (
    <Modal
      title="Admin activity log"
      subtitle={
        api.mode === 'demo'
          ? 'The most recent 200 changes in this demo workspace'
          : 'Recent administration changes'
      }
      onClose={onClose}
      wide
    >
      <div className="modal-body">
        {audit.loading ? (
          <Loading />
        ) : audit.error ? (
          <ErrorState error={audit.error} retry={audit.reload} />
        ) : !audit.data?.length ? (
          <Empty
            title="No admin changes yet"
            description="Save a user or question to see the action recorded here."
          />
        ) : (
          <ol className="timeline">
            {audit.data.map((a) => (
              <li key={a.id}>
                <span className="timeline-dot" />
                <div>
                  <strong>{a.action}</strong>
                  <p>
                    {a.actor} · {a.target}
                    {a.reason ? ` · ${a.reason}` : ''}
                  </p>
                  <small>{dateTime(a.at)}</small>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Modal>
  )
}
