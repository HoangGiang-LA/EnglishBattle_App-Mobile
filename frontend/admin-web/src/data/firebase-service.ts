import type {
  AdminProfile,
  AdminService,
  Activity,
  BattleRecord,
  BattleDetail,
  Catalog,
  ContentInput,
  ListQuery,
  Page,
  Overview,
  DateRange,
  QuestionInput,
  QuestionRecord,
  UserInput,
  UserRecord,
  UserStatus,
} from '../domain'

type Payload = Record<string, unknown>
export type AdminTransport = (action: string, data: Payload) => Promise<Payload>
type Pending = { key: string; lane: string; action: string; payload: Payload }
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    const data = value as Payload
    return `{${Object.keys(data)
      .filter((k) => data[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(data[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
const unavailable = async (): Promise<never> => {
  throw new Error('Chức năng này chưa được triển khai trong giai đoạn hiện tại.')
}
const reasonOf = (error: unknown) => (error as { details?: { reason?: string } })?.details?.reason
const codeOf = (error: unknown) =>
  String((error as { code?: string })?.code || '').replace('functions/', '')
function describe(error: unknown): Error {
  const details = (error as { details?: { operationPhase?: string; operationId?: string } })
    ?.details
  if (details?.operationPhase === 'blocked') {
    return new Error(
      'Thao tác đang chờ kiểm tra trên server.' +
        (/^[a-f0-9]{64}$/.test(details.operationId || '')
          ? ` Mã thao tác: ${details.operationId}`
          : ''),
    )
  }
  const reason = reasonOf(error)
  const reasons: Record<string, string> = {
    'version-conflict': 'Dữ liệu đã được người khác thay đổi. Mở lại bản ghi trước khi sửa tiếp.',
    'last-active-admin': 'Không thể khóa, xóa hoặc thu hồi quản trị viên hoạt động cuối cùng.',
    'admin-self-protection':
      'Không thể tự khóa/xóa tài khoản hoặc đổi email đăng nhập qua form này.',
    'email-already-exists': 'Email này đã thuộc về tài khoản khác.',
    'account-deleted': 'Tài khoản đã xóa không thể mở lại hoặc chỉnh sửa.',
    'user-index-not-ready': 'Danh sách người dùng đang được chuẩn bị. Thử lại sau ít giây.',
    'question-index-not-ready': 'Danh sách câu hỏi đang được chuẩn bị. Thử lại sau ít giây.',
    'monitoring-index-not-ready': 'Dữ liệu giám sát đang được tổng hợp. Thử lại sau ít giây.',
    'overview-not-ready': 'Thống kê đang được tổng hợp đầy đủ. Thử lại sau khi worker hoàn tất.',
    'overview-stale': 'Thống kê đã quá hạn cập nhật. Kiểm tra worker và thử lại.',
    'overview-history-incomplete':
      'Lịch sử trận thiếu dữ liệu nguồn. Cần kiểm tra nguồn trước khi tính thống kê.',
    'overview-skill-history-incomplete':
      'Lịch sử chưa đủ thông tin kỹ năng. Chọn All skills hoặc kiểm tra nguồn.',
    'invalid-stored-battle': 'Dữ liệu trận hiện có cần được kiểm tra trên server.',
    'invalid-stored-activity': 'Dữ liệu hoạt động hiện có cần được kiểm tra trên server.',
    'invalid-content-relation': 'Kỹ năng, chủ đề và bài học phải thuộc cùng một nhánh nội dung.',
    'parent-not-published':
      'Xuất bản kỹ năng, chủ đề và bài học cha trước khi xuất bản nội dung này.',
    'content-has-children': 'Không thể chuyển nội dung đã có bài học hoặc câu hỏi sang nhánh khác.',
    'idioms-belongs-to-vocabulary': 'Idioms & Phrases phải thuộc Vocabulary.',
    'duplicate-content-title': 'Tên nội dung đã tồn tại trong cùng cấp cha.',
    'invalid-published-question': 'Câu hỏi chưa đáp ứng điều kiện để sử dụng trong ứng dụng.',
    'invalid-stored-content': 'Dữ liệu câu hỏi hiện có cần được kiểm tra trên server.',
    'unsupported-audio-content':
      'Nội dung nghe hiện tại chưa hỗ trợ chỉnh sửa; giai đoạn này chỉ dùng TTS.',
    'snapshot-expired':
      'Danh sách đã hết hạn hoặc thay đổi sau khi xóa tài khoản. Làm mới danh sách.',
    'external-outcome-unknown':
      'Một bước đã có kết quả chưa xác định. Cần kiểm tra operation trên server trước khi thử thao tác mới.',
    'partial-operation-needs-review': 'Thao tác đã lưu một phần và cần kiểm tra trên server.',
    'invitation-busy': 'Email mời đang được xử lý hoặc vừa được gửi. Hãy chờ trước khi gửi lại.',
    'operation-result-expired': 'Kết quả thao tác đã hết hạn lưu. Đọc lại tài khoản để xác minh.',
  }
  const codes: Record<string, string> = {
    unauthenticated: 'Phiên đăng nhập đã hết hạn hoặc bị thu hồi. Đăng nhập lại.',
    'permission-denied': 'Quyền quản trị đã bị thu hồi hoặc tài khoản bị khóa.',
    'invalid-argument': 'Dữ liệu nhập không hợp lệ. Kiểm tra lại form.',
    'already-exists': 'Email hoặc mã yêu cầu đã được sử dụng.',
    'not-found': 'Không còn tìm thấy bản ghi này.',
    'resource-exhausted': 'Đã vượt giới hạn gọi API hoặc kích thước truy vấn. Thử lại sau.',
    aborted:
      'Thao tác đang xử lý hoặc dữ liệu đang cập nhật. Thử lại với cùng nội dung để xác minh kết quả.',
    'deadline-exceeded':
      'Chưa xác định được kết quả sau thời gian chờ. Giữ nguyên form và thử lại.',
    unavailable: 'Chưa kết nối được backend. Giữ nguyên form và thử lại.',
    unimplemented: 'Chức năng này chưa được triển khai trong giai đoạn hiện tại.',
  }
  return new Error(
    reasons[reason || ''] ||
      codes[codeOf(error)] ||
      'Không thể hoàn tất yêu cầu. Giữ nguyên form và thử lại.',
  )
}

/** Supported groups use callable APIs; later groups explicitly report unavailable. */
export class FirebaseAdminService implements AdminService {
  readonly mode = 'firebase' as const
  private readonly pending = new Map<string, Pending>()
  private readonly snapshots = new Map<string, string>()
  private generation = 0
  private storageFailed = false
  private readonly storageKey: string
  constructor(
    private readonly uid: string,
    private readonly transport: AdminTransport,
    private readonly storage?: Storage,
  ) {
    this.storageKey = `english-battle.admin.pending.${uid}`
    try {
      const records = JSON.parse(storage?.getItem(this.storageKey) || '[]') as Pending[]
      for (const record of records)
        if (
          record?.lane &&
          record.key &&
          record.payload?.requestId &&
          [
            'adminUpdateProfile',
            'adminSaveUser',
            'adminSetUserStatus',
            'adminSaveContent',
            'adminSaveQuestion',
            'adminArchiveQuestion',
          ].includes(record.action)
        )
          this.pending.set(record.lane, record)
    } catch {
      this.storageFailed = true
    }
  }
  private persist() {
    if (this.storage)
      this.storage.setItem(this.storageKey, JSON.stringify([...this.pending.values()]))
  }
  /** Recheck the exact stored intents before presenting new forms after reload. */
  async restorePending(): Promise<void> {
    for (const record of [...this.pending.values()].slice(0, 5)) {
      try {
        await this.transport(record.action, record.payload)
        this.pending.delete(record.lane)
        this.snapshots.clear()
        this.generation++
      } catch (error) {
        const phase = (error as { details?: { operationPhase?: string } })?.details?.operationPhase
        const review = phase === 'blocked' || reasonOf(error) === 'operation-result-expired'
        if (
          !review &&
          (phase === 'failed' || ['invalid-argument', 'already-exists'].includes(codeOf(error)))
        ) {
          this.pending.delete(record.lane)
        }
        if (!phase && ['unauthenticated', 'permission-denied'].includes(codeOf(error))) {
          window.dispatchEvent(
            new CustomEvent('admin:access-denied', {
              detail: { uid: this.uid, message: describe(error).message },
            }),
          )
        }
      }
      try {
        this.persist()
      } catch {
        /* Stored old IDs remain replay-safe if cleanup fails. */
      }
    }
  }
  private async read(action: string, data: Payload): Promise<Payload> {
    try {
      return await this.transport(action, data)
    } catch (error) {
      if (['unauthenticated', 'permission-denied'].includes(codeOf(error))) {
        window.dispatchEvent(
          new CustomEvent('admin:access-denied', {
            detail: { uid: this.uid, message: describe(error).message },
          }),
        )
      }
      throw describe(error)
    }
  }
  private async mutate(action: string, data: Payload, target: string): Promise<Payload> {
    if (this.storageFailed)
      throw new Error(
        'Không đọc được mã yêu cầu đã lưu trong phiên. Cần khôi phục session storage trước khi gửi thay đổi.',
      )
    const lane = `${action}:${target}`
    const key = stable([action, data])
    let record = this.pending.get(lane)
    if (record && record.key !== key) {
      throw new Error(
        'Yêu cầu trước chưa xác định được kết quả. Giữ lại nội dung cũ và thử lại trước khi gửi thay đổi mới.',
      )
    }
    if (!record) {
      record = { lane, key, action, payload: { ...data, requestId: crypto.randomUUID() } }
      this.pending.set(lane, record)
    }
    try {
      this.persist()
    } catch {
      throw new Error(
        'Không lưu được mã yêu cầu trong phiên. Chưa gửi thay đổi; kiểm tra session storage rồi thử lại.',
      )
    }
    try {
      const response = await this.transport(action, record.payload)
      this.pending.delete(lane)
      try {
        this.persist()
      } catch {
        /* The server already confirmed this operation; do not turn success into a timeout. */
      }
      this.snapshots.clear()
      this.generation++
      window.dispatchEvent(new Event('admin:data'))
      return response
    } catch (error) {
      const code = codeOf(error)
      const reason = reasonOf(error)
      const phase = (error as { details?: { operationPhase?: string } })?.details?.operationPhase
      const review =
        [
          'external-outcome-unknown',
          'partial-operation-needs-review',
          'operation-result-expired',
        ].includes(reason || '') ||
        (error as { details?: { operationPhase?: string } })?.details?.operationPhase === 'blocked'
      if (
        !review &&
        (phase === 'failed' ||
          ['invalid-argument', 'already-exists', 'not-found', 'failed-precondition'].includes(code))
      ) {
        this.pending.delete(lane)
        this.persist()
      }
      if (!phase && ['unauthenticated', 'permission-denied'].includes(code)) {
        window.dispatchEvent(
          new CustomEvent('admin:access-denied', {
            detail: { uid: this.uid, message: describe(error).message },
          }),
        )
      }
      throw describe(error)
    }
  }
  private revision(value: number | undefined): number {
    if (!Number.isSafeInteger(value) || Number(value) < 0)
      throw new Error('Mở lại bản ghi để lấy revision hiện tại trước khi lưu.')
    return value!
  }
  profile = async () => (await this.read('adminGetProfile', {})).profile as AdminProfile
  saveProfile = async (name: string, revision?: number) =>
    (
      await this.mutate(
        'adminUpdateProfile',
        { name, expectedRevision: this.revision(revision) },
        'self',
      )
    ).profile as AdminProfile
  user = async (id: string) => (await this.read('adminGetUser', { id })).user as UserRecord
  saveUser = async (input: UserInput, id?: string, revision?: number, resendInvitation = false) =>
    (
      await this.mutate(
        'adminSaveUser',
        {
          input: { name: input.name, email: input.email },
          ...(id ? { id, expectedRevision: this.revision(revision) } : {}),
          ...(resendInvitation ? { resendInvitation: true } : {}),
        },
        id || 'new',
      )
    ).user as UserRecord
  setUserStatus = async (id: string, status: UserStatus, reason: string, revision?: number) => {
    await this.mutate(
      'adminSetUserStatus',
      { id, status, reason, expectedRevision: this.revision(revision) },
      id,
    )
  }
  users = async (query: ListQuery): Promise<Page<UserRecord>> => {
    const generation = this.generation
    const page = query.page || 1
    const filters = {
      ...(query.q?.trim() ? { q: query.q.trim() } : {}),
      ...(query.status ? { status: query.status } : {}),
      pageSize: query.pageSize || 10,
    }
    const key = stable(filters)
    let snapshotId = this.snapshots.get(key)
    let first: (Page<UserRecord> & { snapshotId: string }) | undefined
    if (!snapshotId) {
      first = (await this.read('adminListUsers', { query: { ...filters, page: 1 } }))
        .page as typeof first
      if (generation !== this.generation) throw new Error('Danh sách đang được làm mới.')
      snapshotId = first!.snapshotId
      this.snapshots.set(key, snapshotId)
    }
    try {
      const value =
        page === 1 && first
          ? first
          : ((await this.read('adminListUsers', { query: { ...filters, page, snapshotId } }))
              .page as Page<UserRecord>)
      if (generation !== this.generation) throw new Error('Danh sách đang được làm mới.')
      return value
    } catch (error) {
      this.snapshots.delete(key)
      throw error
    }
  }
  overview = async (
    range: DateRange,
    categoryId?: string,
    granularity: 'day' | 'week' | 'month' = 'day',
  ) =>
    (
      await this.read('adminGetOverview', {
        range,
        granularity,
        ...(categoryId ? { categoryId } : {}),
      })
    ).overview as Overview
  catalog = async () => (await this.read('adminGetCatalog', {})).catalog as Catalog
  saveContent = async (input: ContentInput, revision = input.revision) => {
    await this.mutate(
      'adminSaveContent',
      {
        input: {
          kind: input.kind,
          title: input.title,
          description: input.description,
          status: input.status,
          ...(input.id ? { id: input.id } : {}),
          ...(input.categoryId ? { categoryId: input.categoryId } : {}),
          ...(input.topicId ? { topicId: input.topicId } : {}),
          ...(input.difficulty ? { difficulty: input.difficulty } : {}),
        },
        ...(input.id ? { expectedRevision: this.revision(revision) } : {}),
      },
      `${input.kind}:${input.id || 'new'}`,
    )
  }
  question = async (id: string) =>
    (await this.read('adminGetQuestion', { id })).question as QuestionRecord
  saveQuestion = async (input: QuestionInput, id?: string, expectedVersion?: number) => {
    if (input.audioUrl)
      throw new Error(
        'Nội dung nghe giai đoạn này chỉ hỗ trợ TTS. Bỏ URL/file audio trước khi lưu.',
      )
    if (id && (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 1))
      throw new Error('Mở lại câu hỏi để lấy phiên bản hiện tại trước khi lưu.')
    return (
      await this.mutate(
        'adminSaveQuestion',
        {
          input: {
            categoryId: input.categoryId,
            topicId: input.topicId,
            lessonId: input.lessonId,
            prompt: input.prompt,
            options: input.options.map(({ id: optionId, text }) => ({ id: optionId, text })),
            correctOptionId: input.correctOptionId,
            explanation: input.explanation,
            passage: input.passage,
            audioUrl: '',
            audioText: input.audioText,
            difficulty: input.difficulty,
            status: input.status,
          },
          ...(id ? { id, expectedVersion } : {}),
        },
        id || 'new',
      )
    ).question as QuestionRecord
  }
  archiveQuestion = async (id: string, expectedVersion: number) => {
    await this.mutate('adminArchiveQuestion', { id, expectedVersion }, id)
  }
  questions = async (query: ListQuery): Promise<Page<QuestionRecord>> => {
    const generation = this.generation,
      page = query.page || 1
    const filters = {
      pageSize: query.pageSize || 10,
      ...(query.q?.trim() ? { q: query.q.trim() } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.difficulty ? { difficulty: query.difficulty } : {}),
    }
    const key = stable(['questions', filters])
    let snapshotId = this.snapshots.get(key)
    let first: (Page<QuestionRecord> & { snapshotId: string }) | undefined
    if (!snapshotId) {
      first = (await this.read('adminListQuestions', { query: { ...filters, page: 1 } }))
        .page as typeof first
      if (generation !== this.generation) throw new Error('Danh sách đang được làm mới.')
      snapshotId = first!.snapshotId
      this.snapshots.set(key, snapshotId)
    }
    try {
      const value =
        page === 1 && first
          ? first
          : ((await this.read('adminListQuestions', { query: { ...filters, page, snapshotId } }))
              .page as Page<QuestionRecord>)
      if (generation !== this.generation) throw new Error('Danh sách đang được làm mới.')
      return value
    } catch (error) {
      this.snapshots.delete(key)
      throw error
    }
  }
  private async monitoringPage<T>(
    kind: 'battles' | 'activities',
    query: ListQuery,
  ): Promise<Page<T>> {
    const generation = this.generation,
      page = query.page || 1
    const filters = {
      pageSize: query.pageSize || 10,
      ...(query.q?.trim() ? { q: query.q.trim() } : {}),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.range ? { range: query.range } : {}),
      ...(kind === 'battles' && query.status ? { status: query.status } : {}),
      ...(kind === 'battles' && query.mode ? { mode: query.mode } : {}),
      ...(kind === 'activities' && (query.type || query.status)
        ? { type: query.type || query.status }
        : {}),
    }
    const key = stable([kind, filters]),
      action = kind === 'battles' ? 'adminListBattles' : 'adminListActivities'
    let snapshotId = this.snapshots.get(key)
    try {
      let first: (Page<T> & { snapshotId: string }) | undefined
      // Page one and Refresh create a fresh snapshot. Later pages reuse its stable order.
      if (page === 1 || !snapshotId) {
        first = (await this.read(action, { query: { ...filters, page: 1 } })).page as typeof first
        if (generation !== this.generation) throw new Error('Danh sách đang được làm mới.')
        snapshotId = first!.snapshotId
        this.snapshots.set(key, snapshotId)
      }
      const result =
        page === 1
          ? first!
          : ((await this.read(action, { query: { ...filters, page, snapshotId } })).page as Page<T>)
      if (generation !== this.generation) throw new Error('Danh sách đang được làm mới.')
      return result
    } catch (error) {
      this.snapshots.delete(key)
      throw error
    }
  }
  battles = (query: ListQuery) => this.monitoringPage<BattleRecord>('battles', query)
  battle = async (id: string) => (await this.read('adminGetBattle', { id })).detail as BattleDetail
  activities = (query: ListQuery) =>
    this.monitoringPage<Activity & { userName: string }>('activities', query)
  search: AdminService['search'] = unavailable
  notifications: AdminService['notifications'] = unavailable
  readNotifications: AdminService['readNotifications'] = unavailable
  audit: AdminService['audit'] = unavailable
  exportReport: AdminService['exportReport'] = unavailable
  reset: AdminService['reset'] = async () => {
    throw new Error('Không có chức năng reset dữ liệu thật.')
  }
}

export async function loadWorkspaceService(uid: string): Promise<AdminService> {
  if (import.meta.env.VITE_ADMIN_DATA_MODE === 'demo')
    return (await import('./mock-service')).service
  const transport: AdminTransport = async (action, data) => {
    const [{ firebaseAuth, firebaseFunctions }, { httpsCallable }] = await Promise.all([
      import('../firebase/client'),
      import('firebase/functions'),
    ])
    if (firebaseAuth.currentUser?.uid !== uid) throw { code: 'functions/unauthenticated' }
    const response = await httpsCallable(firebaseFunctions, action, { timeout: 30000 })(data)
    if (firebaseAuth.currentUser?.uid !== uid) throw { code: 'functions/unauthenticated' }
    return response.data as Payload
  }
  const service = new FirebaseAdminService(uid, transport, sessionStorage)
  await service.restorePending()
  return service
}
