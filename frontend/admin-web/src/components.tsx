import { cloneElement, isValidElement, useEffect, useId, useRef } from 'react'
import type { ReactNode } from 'react'
import {
  ArrowDownToLine,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  LoaderCircle,
  Search,
  SearchX,
  X,
} from 'lucide-react'
import type { DateRange, Page } from './domain'
import { statusLabels } from './domain'
import { initials, number } from './lib'

export function Avatar({ name, small = false }: { name: string; small?: boolean }) {
  return (
    <span className={`avatar ${small ? 'small' : ''}`} aria-hidden="true">
      {initials(name)}
    </span>
  )
}
export function Badge({ value, children }: { value: string; children?: ReactNode }) {
  return (
    <span className={`badge badge-${value}`}>
      <span />
      {children || statusLabels[value] || value}
    </span>
  )
}
export function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (s: string) => void
  placeholder: string
}) {
  return (
    <label className="search-field">
      <Search size={15} />
      <span className="sr-only">{placeholder}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        type="search"
      />
    </label>
  )
}
export function Loading({ label = 'Loading workspace data…' }: { label?: string }) {
  return (
    <div className="loading-state" role="status">
      <LoaderCircle className="spin" size={23} />
      <span>{label}</span>
      <div className="skeleton-lines">
        <i />
        <i />
        <i />
      </div>
    </div>
  )
}
export function ErrorState({ error, retry }: { error: string; retry: () => void }) {
  return (
    <div className="empty-state" role="alert">
      <CircleAlert size={30} />
      <h3>We couldn’t load this data</h3>
      <p>{error}</p>
      <button className="btn" onClick={retry}>
        Try again
      </button>
    </div>
  )
}
export function Empty({
  title = 'No results found',
  description = 'Try another search or change your filters.',
  action,
}: {
  title?: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="empty-state">
      <SearchX size={30} />
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  )
}
export function FormError({ error }: { error: string }) {
  return error ? (
    <p role="alert" className="form-error">
      <CircleAlert size={15} />
      {error}
    </p>
  ) : null
}
export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
  busy = false,
}: {
  title: string
  subtitle?: string
  children: ReactNode
  onClose: () => void
  wide?: boolean
  busy?: boolean
}) {
  const root = useRef<HTMLDivElement>(null),
    titleId = useId(),
    close = useRef(onClose),
    locked = useRef(busy)
  close.current = onClose
  locked.current = busy
  useEffect(() => {
    const previous = document.activeElement as HTMLElement,
      oldOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusables = () =>
      Array.from(
        root.current?.querySelectorAll<HTMLElement>(
          'button:enabled, input:enabled, select:enabled, textarea:enabled, [tabindex="0"]',
        ) || [],
      ).filter((element) => !element.closest('fieldset[disabled]'))
    focusables()[0]?.focus()
    const keydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !locked.current) {
        e.preventDefault()
        close.current()
      }
      if (e.key === 'Tab') {
        const elements = focusables()
        if (!elements.length) {
          e.preventDefault()
          return
        }
        const first = elements[0],
          last = elements[elements.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last?.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first?.focus()
        }
      }
    }
    document.addEventListener('keydown', keydown)
    return () => {
      document.body.style.overflow = oldOverflow
      document.removeEventListener('keydown', keydown)
      previous?.focus()
    }
  }, [])
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <div
        ref={root}
        className={`modal ${wide ? 'modal-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-busy={busy}
        aria-labelledby={titleId}
      >
        <div className="modal-heading">
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-btn" aria-label="Close dialog" disabled={busy} onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <fieldset className="modal-content" disabled={busy}>
          {children}
        </fieldset>
      </div>
    </div>
  )
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string
  children: ReactNode
  hint?: string
}) {
  const id = useId(),
    hintId = `${id}-hint`
  const child = isValidElement<{ id?: string; 'aria-describedby'?: string }>(children)
    ? children
    : null
  const controlId = child?.props.id || id
  return (
    <div className="field">
      <label htmlFor={controlId}>{label}</label>
      {child
        ? cloneElement(child, {
            id: controlId,
            'aria-describedby': hint ? hintId : child.props['aria-describedby'],
          })
        : children}
      {hint && <small id={hintId}>{hint}</small>}
    </div>
  )
}
export function Pagination<T>({
  page,
  onPage,
  onSize,
  label,
}: {
  page: Page<T>
  onPage: (p: number) => void
  onSize: (s: number) => void
  label: string
}) {
  const count = Math.ceil(page.total / page.pageSize),
    pages = Array.from(new Set([1, page.page - 1, page.page, page.page + 1, count]))
      .filter((n) => n >= 1 && n <= count)
      .sort((a, b) => a - b)
  return (
    <footer className="table-footer">
      <span>
        Showing {page.total ? (page.page - 1) * page.pageSize + 1 : 0}–
        {Math.min(page.page * page.pageSize, page.total)} of {number(page.total)} {label}
      </span>
      <div className="pagination">
        <label>
          Rows per page{' '}
          <select
            aria-label="Rows per page"
            value={page.pageSize}
            onChange={(e) => onSize(Number(e.target.value))}
          >
            {[10, 20, 50].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <button
          className="icon-btn"
          aria-label="Previous page"
          disabled={page.page <= 1}
          onClick={() => onPage(page.page - 1)}
        >
          <ChevronLeft size={16} />
        </button>
        {pages.map((n, i) => (
          <span key={n}>
            {i > 0 && n - pages[i - 1] > 1 && <span className="page-gap">…</span>}
            <button
              aria-label={`Page ${n}`}
              aria-current={n === page.page ? 'page' : undefined}
              className={`page-btn ${n === page.page ? 'selected' : ''}`}
              onClick={() => onPage(n)}
            >
              {n}
            </button>
          </span>
        ))}
        <button
          className="icon-btn"
          aria-label="Next page"
          disabled={page.page >= count}
          onClick={() => onPage(page.page + 1)}
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </footer>
  )
}
export function RangePicker({
  range,
  onChange,
}: {
  range: DateRange
  onChange: (r: DateRange) => void
}) {
  return (
    <div className="date-range">
      <label>
        <span className="sr-only">Start date</span>
        <input
          aria-label="Start date"
          type="date"
          value={range.from}
          max={range.to}
          onChange={(e) => onChange({ ...range, from: e.target.value })}
        />
      </label>
      <span>–</span>
      <label>
        <span className="sr-only">End date</span>
        <input
          aria-label="End date"
          type="date"
          value={range.to}
          min={range.from}
          onChange={(e) => onChange({ ...range, to: e.target.value })}
        />
      </label>
    </div>
  )
}
export function ExportButton({
  onClick,
  busy = false,
  primary = false,
}: {
  onClick: () => void
  busy?: boolean
  primary?: boolean
}) {
  return (
    <button className={`btn ${primary ? 'btn-primary' : ''}`} disabled={busy} onClick={onClick}>
      {busy ? <LoaderCircle className="spin" size={15} /> : <ArrowDownToLine size={15} />}Export
      report
    </button>
  )
}
