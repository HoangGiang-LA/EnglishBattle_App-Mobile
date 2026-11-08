import type {
  AdminService,
  ContentInput,
  CsvReport,
  DateRange,
  DemoState,
  ListQuery,
  Page,
  QuestionInput,
  QuestionRecord,
  UserInput,
  UserStatus,
} from '../domain'
import { skills } from '../domain'
import { rangeBounds, validateEmail } from '../lib'
import { createSeed } from './seed'
import { calculateOverview } from './metrics'

const key = 'english-battle.admin.demo.v1'
const copy = <T>(value: T): T =>
  value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
function paged<T>(rows: T[], query: ListQuery): Page<T> {
  const pageSize = [10, 20, 50].includes(query.pageSize || 10) ? query.pageSize || 10 : 10
  const page = Math.max(1, Math.min(query.page || 1, Math.ceil(rows.length / pageSize) || 1))
  return {
    items: rows.slice((page - 1) * pageSize, page * pageSize),
    page,
    pageSize,
    total: rows.length,
  }
}
function get<T extends { id: string }>(rows: T[], id: string): T {
  const record = rows.find((r) => r.id === id)
  if (!record) throw new Error('This record no longer exists. Refresh the list and try again.')
  return record
}
function match(text: string, q = '') {
  return normalize(text).includes(normalize(q))
}
const filteredUsers = (s: DemoState, q: ListQuery) =>
  s.users
    .filter(
      (u) =>
        (q.status ? u.status === q.status : u.status !== 'deleted') &&
        match(`${u.name} ${u.email} ${u.code}`, q.q),
    )
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
const filteredQuestions = (s: DemoState, q: ListQuery) =>
  s.questions
    .filter(
      (r) =>
        match(`${r.prompt} ${r.code}`, q.q) &&
        (!q.status || r.status === q.status) &&
        (!q.categoryId || r.categoryId === q.categoryId) &&
        (!q.difficulty || r.difficulty === q.difficulty),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
const filteredBattles = (s: DemoState, q: ListQuery) =>
  s.battles
    .filter(
      (b) =>
        match(b.code, q.q) &&
        (!q.status || b.status === q.status) &&
        (!q.mode || b.mode === q.mode),
    )
    .sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id))
    .map((b) => ({
      ...b,
      player1Name: get(s.users, b.player1).name,
      player2Name: get(s.users, b.player2).name,
    }))

export class MockAdminService implements AdminService {
  readonly mode = 'demo' as const
  storageWarning: string | null = null
  private state: DemoState
  private queue: Promise<unknown> = Promise.resolve()
  private failNext = false
  constructor(
    private storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
    private latency = 150,
  ) {
    this.state = createSeed()
    try {
      const saved = storage?.getItem(key)
      if (saved) {
        const parsed = JSON.parse(saved) as DemoState
        if (
          parsed.schemaVersion !== 1 ||
          !Array.isArray(parsed.users) ||
          !Array.isArray(parsed.questions) ||
          !Array.isArray(parsed.audit) ||
          !Array.isArray(parsed.battles) ||
          !Array.isArray(parsed.topics) ||
          !Array.isArray(parsed.lessons) ||
          !Array.isArray(parsed.categories) ||
          !Array.isArray(parsed.notifications) ||
          !Array.isArray(parsed.activities) ||
          !parsed.profile ||
          !parsed.questionHistory
        )
          throw new Error('Unsupported demo data')
        this.state = parsed
      }
    } catch {
      this.storageWarning =
        'Saved demo data could not be restored. A fresh preview is shown; use Reset demo data to replace the saved copy.'
    }
  }
  simulateNextFailure() {
    this.failNext = true
  }
  private async wait() {
    if (this.latency) await new Promise((resolve) => setTimeout(resolve, this.latency))
    if (this.failNext) {
      this.failNext = false
      throw new Error('Simulated connection error. Please retry to load this page.')
    }
  }
  private async read<T>(fn: (state: DemoState) => T): Promise<T> {
    await this.wait()
    await this.queue
    return copy(fn(this.state))
  }
  private mutate<T>(
    action: string,
    target: string,
    fn: (state: DemoState) => T,
    reason = '',
  ): Promise<T> {
    const work = this.queue.then(async () => {
      await this.wait()
      const next = copy(this.state),
        result = fn(next)
      next.audit.unshift({
        id: crypto.randomUUID(),
        actor: next.profile.name,
        action,
        target,
        reason,
        at: Date.now(),
      })
      next.audit = next.audit.slice(0, 200)
      try {
        this.storage?.setItem(key, JSON.stringify(next))
      } catch {
        throw new Error(
          'Browser storage is full or unavailable. Nothing was saved. Remove an audio attachment or reset demo data, then retry.',
        )
      }
      this.state = next
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('admin:data'))
      return copy(result)
    })
    this.queue = work.catch(() => undefined)
    return work
  }
  profile = () => this.read((s) => s.profile)
  saveProfile = (name: string) =>
    this.mutate('profile.update', 'demo-admin', (s) => {
      if (name.trim().length < 2 || name.length > 80)
        throw new Error('Enter a name between 2 and 80 characters.')
      s.profile.name = name.trim()
      return s.profile
    })
  overview = (range: DateRange, categoryId = '') =>
    this.read((s) => calculateOverview(s, range, categoryId))
  users = (query: ListQuery) => this.read((s) => paged(filteredUsers(s, query), query))
  user = (id: string) => this.read((s) => get(s.users, id))
  saveUser = (input: UserInput, id?: string) =>
    this.mutate(id ? 'user.update' : 'user.create', id || 'new', (s) => {
      const name = input.name.trim(),
        email = input.email.trim().toLowerCase()
      if (name.length < 2 || name.length > 80)
        throw new Error('Enter a name between 2 and 80 characters.')
      if (!validateEmail(email)) throw new Error('Enter a valid email address.')
      if (
        s.users.some(
          (u) => u.id !== id && u.status !== 'deleted' && u.email.toLowerCase() === email,
        )
      )
        throw new Error('This email is already used by another account.')
      if (id) {
        const u = get(s.users, id)
        if (u.status === 'deleted') throw new Error('Deleted accounts cannot be edited.')
        Object.assign(u, { name, email, updatedAt: Date.now() })
        return u
      }
      const u = {
        id: crypto.randomUUID(),
        code: `#${Math.max(...s.users.map((u) => Number(u.code.slice(1)))) + 1}`,
        name,
        email,
        status: 'active' as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        rating: 0,
        coins: 0,
      }
      s.users.unshift(u)
      s.activities.unshift({
        id: crypto.randomUUID(),
        userId: u.id,
        text: 'Joined English Battle',
        type: 'user',
        at: u.createdAt,
        categoryId: 'mixed',
        answered: 0,
        correct: 0,
        completed: true,
      })
      return u
    })
  setUserStatus = (id: string, status: UserStatus, reason: string) =>
    this.mutate(
      `user.${status}`,
      id,
      (s) => {
        const u = get(s.users, id)
        if (u.status === 'deleted') throw new Error('This account has already been deleted.')
        if (reason.trim().length < 5) throw new Error('Enter a reason of at least 5 characters.')
        u.status = status
        u.reason = reason.trim()
        u.updatedAt = Date.now()
        if (status === 'deleted') {
          u.name = 'Deleted user'
          u.email = ''
        }
      },
      reason,
    )
  questions = (query: ListQuery) => this.read((s) => paged(filteredQuestions(s, query), query))
  question = (id: string) => this.read((s) => get(s.questions, id))
  saveQuestion = (input: QuestionInput, id?: string, expectedVersion?: number) =>
    this.mutate(id ? 'question.update' : 'question.create', id || 'new', (s) => {
      if (!skills.includes(input.categoryId))
        throw new Error('Choose one of the four learning skills.')
      const topic = get(s.topics, input.topicId)
      if (topic.categoryId !== input.categoryId)
        throw new Error('The topic must belong to the selected skill.')
      if (input.lessonId && get(s.lessons, input.lessonId).topicId !== input.topicId)
        throw new Error('The lesson must belong to the selected topic.')
      if (input.prompt.trim().length < 5 || input.prompt.length > 3000)
        throw new Error('Question text must contain 5–3,000 characters.')
      if (
        input.options.length !== 4 ||
        input.options.some((o) => !o.text.trim() || o.text.length > 500)
      )
        throw new Error('Provide four non-empty answer options (up to 500 characters each).')
      if (
        new Set(input.options.map((o) => normalize(o.text))).size !== 4 ||
        new Set(input.options.map((o) => o.id)).size !== 4
      )
        throw new Error('Answer options must be distinct.')
      if (!input.options.some((o) => o.id === input.correctOptionId))
        throw new Error('Select the correct answer.')
      if (
        !['draft', 'published', 'archived'].includes(input.status) ||
        !['easy', 'medium', 'hard'].includes(input.difficulty)
      )
        throw new Error('Choose a valid status and difficulty.')
      if (input.status === 'published') {
        if (
          get(s.categories, input.categoryId).status !== 'published' ||
          topic.status !== 'published' ||
          (input.lessonId && get(s.lessons, input.lessonId).status !== 'published')
        )
          throw new Error('Publish the skill, topic and lesson before publishing this question.')
        if (!input.explanation.trim()) throw new Error('Add an explanation before publishing.')
        if (input.categoryId === 'reading' && !input.passage.trim())
          throw new Error('Add a passage for a published reading question.')
        if (input.categoryId === 'listening' && !input.audioUrl && !input.audioText.trim())
          throw new Error('Add an audio file, HTTPS audio URL or text for listening.')
      }
      if (
        input.audioUrl &&
        !/^https:\/\//i.test(input.audioUrl) &&
        !/^data:audio\/[a-z0-9.+-]+;base64,/i.test(input.audioUrl)
      )
        throw new Error('Audio must use an HTTPS URL or an uploaded audio file.')
      const now = Date.now(),
        clean = {
          ...copy(input),
          prompt: input.prompt.trim(),
          options: input.options.map((o) => ({ ...o, text: o.text.trim() })),
        }
      if (id) {
        const q = get(s.questions, id)
        if (q.version !== expectedVersion)
          throw new Error(
            'This question changed while you were editing. Close the form and reopen the latest version.',
          )
        s.questionHistory[id] = [...(s.questionHistory[id] || []), copy(q)].slice(-20)
        Object.assign(q, clean, { version: q.version + 1, updatedAt: now })
        return q
      }
      const q: QuestionRecord = {
        ...clean,
        id: crypto.randomUUID(),
        code: `#Q${String(s.questions.length + 1).padStart(5, '0')}`,
        version: 1,
        createdAt: now,
        updatedAt: now,
      }
      s.questions.unshift(q)
      return q
    })
  archiveQuestion = async (id: string, expectedVersion: number) => {
    await this.mutate('question.archive', id, (s) => {
      const q = get(s.questions, id)
      if (q.version !== expectedVersion)
        throw new Error('This question changed. Refresh and try again.')
      s.questionHistory[id] = [...(s.questionHistory[id] || []), copy(q)].slice(-20)
      q.status = 'archived'
      q.version++
      q.updatedAt = Date.now()
    })
  }
  catalog = () =>
    this.read((s) => ({ categories: s.categories, topics: s.topics, lessons: s.lessons }))
  saveContent = (input: ContentInput) =>
    this.mutate(`${input.kind}.save`, input.id || 'new', (s) => {
      const title = input.title.trim()
      if (title.length < 2 || title.length > 120)
        throw new Error('Enter a title between 2 and 120 characters.')
      if (!['draft', 'published', 'archived'].includes(input.status))
        throw new Error('Choose a valid content status.')
      if (input.kind === 'category') {
        if (!input.id) throw new Error('The four learning skills are fixed.')
        Object.assign(get(s.categories, input.id), {
          name: title,
          description: input.description.trim(),
          status: input.status,
        })
        return
      }
      if (input.kind === 'topic') {
        if (!input.categoryId || !skills.includes(input.categoryId))
          throw new Error('Choose a skill for this topic.')
        if (
          input.status === 'published' &&
          get(s.categories, input.categoryId).status !== 'published'
        )
          throw new Error('Publish the skill first.')
        if (
          s.topics.some(
            (t) =>
              t.id !== input.id &&
              t.categoryId === input.categoryId &&
              normalize(t.title) === normalize(title),
          )
        )
          throw new Error('This topic already exists in the selected skill.')
        if (
          input.id &&
          get(s.topics, input.id).categoryId !== input.categoryId &&
          (s.questions.some((q) => q.topicId === input.id) ||
            s.lessons.some((l) => l.topicId === input.id))
        )
          throw new Error('A topic with existing content cannot be moved to another skill.')
        const t = {
          id: input.id || crypto.randomUUID(),
          categoryId: input.categoryId,
          title,
          description: input.description.trim(),
          status: input.status,
        }
        if (input.id) Object.assign(get(s.topics, input.id), t)
        else s.topics.push(t)
      } else {
        const topic = get(s.topics, input.topicId || '')
        if (input.status === 'published' && topic.status !== 'published')
          throw new Error('Publish the topic first.')
        if (
          input.id &&
          get(s.lessons, input.id).topicId !== input.topicId &&
          s.questions.some((q) => q.lessonId === input.id)
        )
          throw new Error('A lesson with questions cannot be moved to another topic.')
        const l = {
          id: input.id || crypto.randomUUID(),
          topicId: topic.id,
          title,
          description: input.description.trim(),
          difficulty: input.difficulty || 'easy',
          status: input.status,
        }
        if (input.id) Object.assign(get(s.lessons, input.id), l)
        else s.lessons.push(l)
      }
    })
  battles = (query: ListQuery) => this.read((s) => paged(filteredBattles(s, query), query))
  battle = (id: string) =>
    this.read((s) => {
      const b = get(s.battles, id)
      return { battle: b, player1: get(s.users, b.player1), player2: get(s.users, b.player2) }
    })
  activities = (query: ListQuery) =>
    this.read((s) =>
      paged(
        s.activities
          .filter((a) => !query.status || a.type === query.status)
          .sort((a, b) => b.at - a.at)
          .map((a) => ({ ...a, userName: get(s.users, a.userId).name })),
        query,
      ),
    )
  search = (q: string) =>
    this.read((s) =>
      q.trim().length < 2
        ? []
        : [
            ...filteredUsers(s, { q })
              .slice(0, 4)
              .map((u) => ({
                id: u.id,
                label: u.name,
                detail: `${u.code} · User`,
                page: 'users' as const,
                query: u.code,
              })),
            ...filteredQuestions(s, { q })
              .slice(0, 4)
              .map((r) => ({
                id: r.id,
                label: r.prompt,
                detail: `${r.code} · Question`,
                page: 'content' as const,
                query: r.code,
              })),
            ...filteredBattles(s, { q })
              .slice(0, 3)
              .map((b) => ({
                id: b.id,
                label: b.code,
                detail: 'Battle',
                page: 'battles' as const,
                query: b.code,
              })),
          ],
    )
  notifications = (query: ListQuery = {}) =>
    this.read((s) => ({
      ...paged(
        s.notifications.filter((n) => !query.unreadOnly || !n.read),
        query,
      ),
      unreadTotal: s.notifications.filter((n) => !n.read).length,
      asOf: Date.now(),
    }))
  readNotifications = (id?: string) =>
    this.mutate('notification.read', id || 'all', (s) => {
      s.notifications.forEach((n) => {
        if (!id || id === n.id) n.read = true
      })
    })
  audit = (query: ListQuery = {}) =>
    this.read((s) => {
      const bounds = query.range ? rangeBounds(query.range) : null
      return paged(
        s.audit.filter(
          (a) =>
            (!query.q || match(`${a.actor} ${a.action} ${a.target} ${a.reason}`, query.q)) &&
            (!query.actor || a.actor === query.actor) &&
            (!query.action || a.action === query.action) &&
            (!query.result || a.result === query.result) &&
            (!query.target || a.target.includes(query.target)) &&
            (!bounds || (a.at >= bounds.start && a.at < bounds.end)),
        ),
        query,
      )
    })
  exportReport = (
    kind: 'users' | 'questions' | 'battles' | 'analytics',
    query: ListQuery,
    range: DateRange,
  ): Promise<CsvReport> =>
    this.read((s) => {
      rangeBounds(range)
      const filename = `english-battle-demo-${kind}-${range.from}-${range.to}.csv`
      if (kind === 'users')
        return {
          filename,
          columns: ['ID', 'Name', 'Email', 'Status', 'Joined (UTC)'],
          rows: filteredUsers(s, query).map((u) => [
            u.code,
            u.name,
            u.email,
            u.status,
            new Date(u.createdAt).toISOString(),
          ]),
        }
      if (kind === 'questions')
        return {
          filename,
          columns: ['ID', 'Question', 'Skill', 'Difficulty', 'Status', 'Version'],
          rows: filteredQuestions(s, query).map((q) => [
            q.code,
            q.prompt,
            q.categoryId,
            q.difficulty,
            q.status,
            q.version,
          ]),
        }
      if (kind === 'battles')
        return {
          filename,
          columns: ['Match', 'Mode', 'Player 1', 'Player 2', 'Score 1', 'Score 2', 'Status'],
          rows: filteredBattles(s, query).map((b) => [
            b.code,
            b.mode,
            get(s.users, b.player1).name,
            get(s.users, b.player2).name,
            b.score1,
            b.score2,
            b.status,
          ]),
        }
      const o = calculateOverview(s, range, query.categoryId)
      return {
        filename,
        columns: [
          'Date (Asia/Ho_Chi_Minh)',
          'Users at end of day',
          'Lessons completed',
          'Battles completed',
        ],
        rows: o.series.map((d) => [d.date, d.users, d.lessons, d.battles]),
      }
    })
  reset = async () => {
    await this.mutate('demo.reset', 'workspace', (s) => {
      Object.assign(s, createSeed())
      this.storageWarning = null
    })
  }
}

let browserStorage: Storage | undefined
try {
  browserStorage = window.localStorage
} catch {
  /* The workspace still works in memory. */
}
export const service = new MockAdminService(browserStorage)
