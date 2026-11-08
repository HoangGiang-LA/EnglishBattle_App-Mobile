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
  AdminNotification,
  AuditEntry,
  CsvReport,
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
    'search-not-ready': 'Các chỉ mục tìm kiếm đang được chuẩn bị. Thử lại sau ít giây.',
    'notifications-not-ready': 'Thông báo đang được tổng hợp. Thử lại sau khi worker hoàn tất.',
    'report-too-large': 'Báo cáo vượt giới hạn 5.000 dòng hoặc 1 MiB. Thu hẹp bộ lọc rồi xuất lại.',
    'report-timeout': 'Báo cáo xử lý quá lâu. Thu hẹp bộ lọc rồi xuất lại.',
    'report-expired': 'Báo cáo đã hết hạn hoặc không còn khả dụng. Xuất lại báo cáo.',
    'report-privacy-changed':
      'Trạng thái hiển thị tài khoản đã đổi. Tải lại dữ liệu và xuất báo cáo mới.',
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

/** All business methods use authorized callable APIs. Pending reads are shared only within this account and revision. */
export class FirebaseAdminService implements AdminService {
  readonly mode = 'firebase' as const
  private readonly pending = new Map<string, Pending>()
  private readonly snapshots = new Map<string, string>()
  private readonly inFlightReads = new Map<string, Promise<Payload>>()
  private readonly inFlightMutations = new Map<string, { key: string; promise: Promise<Payload> }>()
  private active = true
  private generation = 0
  private notificationAsOf = 0
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
            'adminMarkNotificationsRead',
            'adminExportReport',
          ].includes(record.action)
        )
          this.pending.set(record.lane, record)
    } catch {
      this.storageFailed = true
    }
  }
  dispose() {
    this.active = false
    this.generation++
    this.snapshots.clear()
    this.inFlightReads.clear()
  }
  private assertActive() {
    if (!this.active) throw new Error('Phiên làm việc đã thay đổi. Mở lại workspace để tiếp tục.')
  }
  private accessDenied(error: unknown) {
    const phase = (error as { details?: { operationPhase?: string } })?.details?.operationPhase
    // A stored terminal rejection belongs to the original actor session, not the current login.
    if (this.active && !phase && ['unauthenticated', 'permission-denied'].includes(codeOf(error))) {
      window.dispatchEvent(
        new CustomEvent('admin:access-denied', {
          detail: { uid: this.uid, message: describe(error).message },
        }),
      )
    }
  }
  private persist() {
    if (this.storage)
      this.storage.setItem(this.storageKey, JSON.stringify([...this.pending.values()]))
  }
  /** Recheck the exact stored intents before presenting new forms after reload. */
  async restorePending(): Promise<void> {
    this.assertActive()
    for (const record of [...this.pending.values()].slice(0, 5)) {
      try {
        await this.transport(record.action, record.payload)
        this.assertActive()
        if (record.action === 'adminExportReport') continue
        this.pending.delete(record.lane)
        this.snapshots.clear()
        this.generation++
      } catch (error) {
        if (!this.active) throw error
        const phase = (error as { details?: { operationPhase?: string } })?.details?.operationPhase
        const review = phase === 'blocked' || reasonOf(error) === 'operation-result-expired'
        if (
          !review &&
          (phase === 'failed' ||
            ['invalid-argument', 'already-exists'].includes(codeOf(error)) ||
            ['report-expired', 'report-privacy-changed'].includes(reasonOf(error) || ''))
        ) {
          this.pending.delete(record.lane)
        }
        if (!phase && ['unauthenticated', 'permission-denied'].includes(codeOf(error))) {
          this.accessDenied(error)
          throw describe(error)
        }
      }
      try {
        this.persist()
      } catch {
        /* Stored old IDs remain replay-safe if cleanup fails. */
      }
    }
  }
  private read(action: string, data: Payload): Promise<Payload> {
    this.assertActive()
    const key = stable([this.generation, action, data])
    const current = this.inFlightReads.get(key)
    if (current) return current
    const pending = this.performRead(action, data).finally(() => this.inFlightReads.delete(key))
    this.inFlightReads.set(key, pending)
    return pending
  }
  private async performRead(action: string, data: Payload): Promise<Payload> {
    try {
      const response = await this.transport(action, data)
      this.assertActive()
      return response
    } catch (error) {
      if (!this.active) throw error
      this.accessDenied(error)
      throw describe(error)
    }
  }
  private mutate(
    action: string,
    data: Payload,
    target: string,
    complete?: (response: Payload) => Promise<Payload>,
  ): Promise<Payload> {
    this.assertActive()
    const lane = `${action}:${target}`,
      key = stable([action, data])
    const current = this.inFlightMutations.get(lane)
    if (current) {
      if (current.key !== key)
        return Promise.reject(
          new Error('Yêu cầu trước đang xử lý. Chờ xác minh kết quả trước khi gửi nội dung khác.'),
        )
      return current.promise
    }
    const promise = this.performMutation(action, data, target, complete).finally(() =>
      this.inFlightMutations.delete(lane),
    )
    this.inFlightMutations.set(lane, { key, promise })
    return promise
  }
  private async performMutation(
    action: string,
    data: Payload,
    target: string,
    complete?: (response: Payload) => Promise<Payload>,
  ): Promise<Payload> {
    this.assertActive()
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
    const created = !record
    if (!record) {
      record = {
        lane,
        key,
        action,
        payload: JSON.parse(JSON.stringify({ ...data, requestId: crypto.randomUUID() })),
      }
      this.pending.set(lane, record)
    }
    try {
      this.persist()
    } catch {
      if (created) this.pending.delete(lane)
      throw new Error(
        'Không lưu được mã yêu cầu trong phiên. Chưa gửi thay đổi; kiểm tra session storage rồi thử lại.',
      )
    }
    try {
      let response = await this.transport(action, record.payload)
      this.assertActive()
      if (complete) response = await complete(response)
      this.assertActive()
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
      if (!this.active) throw error
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
          [
            'invalid-argument',
            'already-exists',
            'not-found',
            'failed-precondition',
            'unimplemented',
          ].includes(code))
      ) {
        this.pending.delete(lane)
        try {
          this.persist()
        } catch {
          /* The confirmed rejection remains safe to replay. */
        }
      }
      this.accessDenied(error)
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
    if (page === 1 || !snapshotId) {
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
    if (page === 1 || !snapshotId) {
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
  search: AdminService['search'] = async (q) => {
    const value = q.trim()
    if (value.length < 2) return []
    if (value.length > 100) throw new Error('Nhập tối đa 100 ký tự tìm kiếm.')
    return (await this.read('adminSearch', { q: value })).items as Awaited<
      ReturnType<AdminService['search']>
    >
  }
  private async privatePage<T>(
    kind: 'notifications' | 'audit',
    query: ListQuery,
  ): Promise<Page<T> & Payload> {
    const generation = this.generation
    const filters =
      kind === 'notifications'
        ? { ...(query.unreadOnly ? { unreadOnly: true } : {}) }
        : {
            ...(query.q?.trim() ? { q: query.q.trim() } : {}),
            ...(query.actor ? { actor: query.actor } : {}),
            ...(query.action ? { action: query.action } : {}),
            ...(query.target ? { target: query.target } : {}),
            ...(query.result ? { result: query.result } : {}),
            ...(query.range ? { range: query.range } : {}),
          }
    const page = query.page || 1,
      pageSize = query.pageSize || 10
    const key = stable([kind, filters, pageSize])
    const action = kind === 'audit' ? 'adminListAudit' : 'adminListNotifications'
    let snapshotId = this.snapshots.get(key)
    try {
      let first: (Page<T> & Payload) | undefined
      if (page === 1 || !snapshotId) {
        first = (await this.read(action, { query: { ...filters, pageSize, page: 1 } }))
          .page as Page<T> & Payload
        if (generation !== this.generation) throw new Error('Danh sách đang được làm mới.')
        snapshotId = first.snapshotId
        this.snapshots.set(key, snapshotId!)
      }
      const result =
        page === 1
          ? first!
          : ((
              await this.read(action, {
                query: {
                  ...filters,
                  pageSize,
                  page,
                  snapshotId,
                },
              })
            ).page as Page<T> & Payload)
      if (generation !== this.generation) throw new Error('Danh sách đang được làm mới.')
      return result
    } catch (error) {
      this.snapshots.delete(key)
      throw error
    }
  }
  notifications = async (query: ListQuery = {}) => {
    const result = await this.privatePage<AdminNotification>('notifications', query)
    this.notificationAsOf = Number(result.asOf)
    return { ...result, unreadTotal: Number(result.unreadTotal) }
  }
  readNotifications = async (id?: string) => {
    if (!id && !this.notificationAsOf) await this.notifications()
    const prior = this.pending.get('adminMarkNotificationsRead:all')
    await this.mutate(
      'adminMarkNotificationsRead',
      id
        ? { id }
        : {
            throughAt: prior?.payload.throughAt ?? this.notificationAsOf,
          },
      id || 'all',
    )
  }
  audit = (query: ListQuery = {}) => this.privatePage<AuditEntry>('audit', query)
  exportReport: AdminService['exportReport'] = async (kind, query, range) => {
    const filters: Payload = {
      ...(kind === 'analytics'
        ? {
            ...(query.categoryId ? { categoryId: query.categoryId } : {}),
            ...(query.granularity ? { granularity: query.granularity } : {}),
            ...(query.generation ? { generation: query.generation } : {}),
          }
        : {
            ...(query.q?.trim() ? { q: query.q.trim() } : {}),
            ...(query.status ? { status: query.status } : {}),
            ...(kind !== 'users' && query.categoryId ? { categoryId: query.categoryId } : {}),
            ...(kind === 'questions' && query.difficulty ? { difficulty: query.difficulty } : {}),
            ...(kind === 'battles' && query.mode ? { mode: query.mode } : {}),
            ...(kind === 'battles' && query.range ? { range: query.range } : {}),
          }),
    }
    const result = await this.mutate(
      'adminExportReport',
      { kind, query: filters, range },
      kind,
      (response) =>
        this.transport('adminExportReport', { reportId: (response.report as Payload).id }),
    )
    return result.report as unknown as CsvReport
  }
  reset: AdminService['reset'] = async () => {
    throw new Error('Không có chức năng reset dữ liệu thật.')
  }
}

export async function loadWorkspaceService(
  uid: string,
  signal?: AbortSignal,
): Promise<AdminService> {
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
  const abort = () => service.dispose()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  try {
    await service.restorePending()
    return service
  } catch (error) {
    service.dispose()
    signal?.removeEventListener('abort', abort)
    throw error
  }
}
