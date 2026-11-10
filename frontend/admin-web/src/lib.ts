import type { DateRange } from './domain'

export const number = (n: number) => new Intl.NumberFormat('en-US').format(n)
export const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
export const dateTime = (at: number) =>
  new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Asia/Ho_Chi_Minh',
  }).format(at)
export const dayKey = (at: number) =>
  new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'Asia/Ho_Chi_Minh',
  }).format(at)
export function rangeBounds(range: DateRange) {
  const start = Date.parse(`${range.from}T00:00:00+07:00`)
  const end = Date.parse(`${range.to}T00:00:00+07:00`) + 86_400_000
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start ||
    end - start > 366 * 86_400_000
  )
    throw new Error('Choose a valid date range of up to 366 days.')
  return { start, end }
}
export function defaultRange(): DateRange {
  const now = Date.now()
  return { from: dayKey(now - 29 * 86_400_000), to: dayKey(now) }
}
export function csvText(columns: string[], rows: (string | number)[][]) {
  const cell = (value: string | number) => {
    let s = String(value)
    if (typeof value === 'string' && /^[\s\u0000-\u001f]*[=+@\-]/.test(s)) s = `'${s}`
    return `"${s.replaceAll('"', '""')}"`
  }
  return '\uFEFF' + [columns, ...rows].map((row) => row.map(cell).join(',')).join('\r\n')
}
export function downloadCsv(filename: string, columns: string[], rows: (string | number)[][]) {
  const url = URL.createObjectURL(
    new Blob([csvText(columns, rows)], { type: 'text/csv;charset=utf-8' }),
  )
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export function validateEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254
}
export const message = (e: unknown) => {
  const code = typeof e === 'object' && e !== null && 'code' in e ? String(e.code) : ''
  const messages: Record<string, string> = {
    'functions/not-found':
      'The admin API or requested record is unavailable. Check backend exports and refresh.',
    'functions/unimplemented': 'This admin API has not been implemented by the backend.',
    'functions/unavailable':
      'Could not reach the Functions service. Check your connection and try again.',
    'functions/aborted': 'This record changed. Refresh it before saving again.',
    'functions/permission-denied':
      'Administrator access was denied. Sign in again or contact your administrator.',
    'functions/unauthenticated': 'Your session has expired. Sign in again.',
  }
  return (
    messages[code] || (e instanceof Error ? e.message : 'Something went wrong. Please try again.')
  )
}
