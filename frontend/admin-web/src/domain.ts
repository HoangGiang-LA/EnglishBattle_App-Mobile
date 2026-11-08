export type PageId = 'dashboard' | 'users' | 'content' | 'battles' | 'analytics'
export type SkillId = 'vocabulary' | 'grammar' | 'listening' | 'reading'
export type ContentStatus = 'draft' | 'published' | 'archived'
export type UserStatus = 'active' | 'banned' | 'deleted'
export type Difficulty = 'easy' | 'medium' | 'hard'
export type BattleStatus = 'ongoing' | 'completed' | 'abandoned'
export type BattleMode = 'quick' | 'daily' | 'private'

export interface AdminProfile {
  id: string
  name: string
  email: string
  role: 'administrator'
  revision?: number
}
export interface UserRecord {
  id: string
  code: string
  name: string
  email: string
  status: UserStatus
  createdAt: number
  updatedAt: number
  rating: number
  coins: number
  reason?: string
  revision?: number
  invitationStatus?: 'not_requested' | 'pending' | 'sending' | 'sent' | 'failed' | 'unknown'
  pendingOperation?: string
}
export interface Category {
  id: SkillId
  name: string
  description: string
  status: ContentStatus
  revision?: number
}
export interface Topic {
  id: string
  categoryId: SkillId
  title: string
  description: string
  status: ContentStatus
  revision?: number
}
export interface Lesson {
  id: string
  topicId: string
  title: string
  description: string
  difficulty: Difficulty
  status: ContentStatus
  revision?: number
}
export interface QuestionRecord {
  id: string
  code: string
  categoryId: SkillId
  topicId: string
  lessonId: string
  prompt: string
  options: { id: string; text: string }[]
  correctOptionId: string
  explanation: string
  passage: string
  audioUrl: string
  audioText: string
  difficulty: Difficulty
  status: ContentStatus
  version: number
  createdAt: number
  updatedAt: number
}
export interface BattleRecord {
  id: string
  code: string
  player1: string
  player2: string
  player1Name: string
  player2Name: string
  score1: number
  score2: number
  status: BattleStatus
  mode: BattleMode
  categoryId: SkillId | 'mixed'
  startedAt: number
  endedAt: number | null
  logs: { id: string; at: number; type: string; message: string; actorId?: string }[]
  createdAt?: number
  playStartedAt?: number | null
  phase?: 'ready' | 'playing' | 'reconnecting' | 'completed'
  endReason?: string
  questionCount?: number
  roundTimeLimitSeconds?: number
  settlementStatus?: 'not_due' | 'pending' | 'settled'
  outcome1?: 'win' | 'loss' | 'draw' | 'left' | null
  outcome2?: 'win' | 'loss' | 'draw' | 'left' | null
}
export interface Activity {
  id: string
  userId: string
  text: string
  type: 'battle' | 'lesson' | 'user'
  at: number
  categoryId: SkillId | 'mixed'
  answered: number
  correct: number
  completed: boolean
  userName?: string
  sourceId?: string
  outcome?: 'registered' | 'completed' | 'abandoned' | 'win' | 'loss' | 'draw' | 'left'
}
export interface AdminNotification {
  id: string
  title: string
  body: string
  at: number
  read: boolean
  page: PageId
}
export interface AuditEntry {
  id: string
  actor: string
  action: string
  target: string
  at: number
  reason: string
  operationId?: string
  result?: 'succeeded' | 'failed' | 'blocked'
  errorCode?: string
}
export interface DemoState {
  schemaVersion: 1
  profile: AdminProfile
  users: UserRecord[]
  categories: Category[]
  topics: Topic[]
  lessons: Lesson[]
  questions: QuestionRecord[]
  questionHistory: Record<string, QuestionRecord[]>
  battles: BattleRecord[]
  activities: Activity[]
  notifications: AdminNotification[]
  audit: AuditEntry[]
}
export interface DateRange {
  from: string
  to: string
}
export interface ListQuery {
  q?: string
  status?: string
  categoryId?: string
  difficulty?: string
  mode?: string
  type?: string
  range?: DateRange
  page?: number
  pageSize?: number
  actor?: string
  action?: string
  target?: string
  result?: string
  unreadOnly?: boolean
  granularity?: 'day' | 'week' | 'month'
  generation?: string
}
export interface Page<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
  asOf?: number
  lagMs?: number
  ready?: boolean
  snapshotId?: string
}
export interface Overview {
  totalUsers: number
  newUsers: number
  activeUsers: number
  completedBattles: number
  completedLessons: number
  growth: { users: number | null; active: number | null; battles: number | null }
  series: {
    date: string
    users: number
    previous: number
    lessons: number
    battles: number
    active: number
  }[]
  categories: {
    id: SkillId
    name: string
    lessons: number
    battles: number
    answered: number
    correct: number
    completed: number
    started: number
    completion?: number | null
  }[]
  accuracy: number | null
  completion: number | null
  recent: Activity[]
  asOf: number
  ready?: boolean
  lagMs?: number
  generation?: string
  granularity?: 'day' | 'week' | 'month'
  timeZone?: 'Asia/Ho_Chi_Minh'
  denominators?: {
    answered: number | null
    correct: number | null
    started: number
    completed: number
  }
  coverage?: {
    unknownStartSessions: number
    unclassifiedAnswers: number
    unknownAnswers: boolean
    skillBreakdownComplete: boolean
    partialPeriod: boolean
    accountScope: 'retained-auth'
    completionBasis: 'started-in-period'
  }
}
export interface BattleDetail {
  battle: BattleRecord
  player1: Pick<UserRecord, 'id' | 'code' | 'name' | 'status'>
  player2: Pick<UserRecord, 'id' | 'code' | 'name' | 'status'>
}
export interface Catalog {
  categories: Category[]
  topics: Topic[]
  lessons: Lesson[]
}
export interface CsvReport {
  filename: string
  columns: string[]
  rows: (string | number)[][]
  id?: string
  total?: number
  asOf?: number
  expiresAt?: number
}
export type QuestionInput = Omit<
  QuestionRecord,
  'id' | 'code' | 'version' | 'createdAt' | 'updatedAt'
>
export type UserInput = Pick<UserRecord, 'name' | 'email'>
export type ContentInput = {
  kind: 'category' | 'topic' | 'lesson'
  id?: string
  title: string
  description: string
  status: ContentStatus
  categoryId?: SkillId
  topicId?: string
  difficulty?: Difficulty
  revision?: number
}

/** Server adapters must implement these methods with bounded, authorized APIs. */
export interface AdminService {
  readonly mode: 'demo' | 'firebase'
  readonly storageWarning?: string | null
  profile(): Promise<AdminProfile>
  saveProfile(name: string, expectedRevision?: number): Promise<AdminProfile>
  overview(
    range: DateRange,
    categoryId?: string,
    granularity?: 'day' | 'week' | 'month',
  ): Promise<Overview>
  users(query: ListQuery): Promise<Page<UserRecord>>
  user(id: string): Promise<UserRecord>
  saveUser(
    input: UserInput,
    id?: string,
    expectedRevision?: number,
    resendInvitation?: boolean,
  ): Promise<UserRecord>
  setUserStatus(
    id: string,
    status: UserStatus,
    reason: string,
    expectedRevision?: number,
  ): Promise<void>
  questions(query: ListQuery): Promise<Page<QuestionRecord>>
  question(id: string): Promise<QuestionRecord>
  saveQuestion(input: QuestionInput, id?: string, expectedVersion?: number): Promise<QuestionRecord>
  archiveQuestion(id: string, expectedVersion: number): Promise<void>
  catalog(): Promise<Catalog>
  saveContent(input: ContentInput, expectedRevision?: number): Promise<void>
  battles(query: ListQuery): Promise<Page<BattleRecord>>
  battle(id: string): Promise<BattleDetail>
  activities(query: ListQuery): Promise<Page<Activity & { userName: string }>>
  search(
    q: string,
  ): Promise<{ id: string; label: string; detail: string; page: PageId; query: string }[]>
  notifications(query?: ListQuery): Promise<Page<AdminNotification> & { unreadTotal: number }>
  readNotifications(id?: string): Promise<void>
  audit(query?: ListQuery): Promise<Page<AuditEntry>>
  exportReport(
    kind: 'users' | 'questions' | 'battles' | 'analytics',
    query: ListQuery,
    range: DateRange,
  ): Promise<CsvReport>
  reset(): Promise<void>
}

export const skillNames: Record<SkillId, string> = {
  vocabulary: 'Vocabulary',
  grammar: 'Grammar',
  listening: 'Listening',
  reading: 'Reading',
}
export const skills = Object.keys(skillNames) as SkillId[]
export const statusLabels: Record<string, string> = {
  active: 'Active',
  banned: 'Banned',
  deleted: 'Deleted',
  draft: 'Draft',
  published: 'Published',
  archived: 'Archived',
  easy: 'Easy',
  medium: 'Medium',
  hard: 'Hard',
  ongoing: 'Ongoing',
  completed: 'Completed',
  abandoned: 'Abandoned',
  quick: 'Quick battle',
  daily: 'Daily battle',
  private: 'Private room',
}
