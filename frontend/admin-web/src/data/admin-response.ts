export const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const fields = (v: unknown, shape: Record<string, string>) =>
  object(v) &&
  Object.entries(shape).every(([k, t]) =>
    t === 'array'
      ? Array.isArray(v[k])
      : t === 'object'
        ? object(v[k])
        : typeof v[k] === t && (t !== 'number' || Number.isFinite(v[k])),
  )
const shapes = {
  profile: { id: 'string', name: 'string', email: 'string', role: 'string' },
  user: {
    id: 'string',
    code: 'string',
    name: 'string',
    email: 'string',
    status: 'string',
    createdAt: 'number',
    updatedAt: 'number',
    rating: 'number',
    coins: 'number',
  },
  question: {
    id: 'string',
    code: 'string',
    categoryId: 'string',
    topicId: 'string',
    lessonId: 'string',
    prompt: 'string',
    options: 'array',
    correctOptionId: 'string',
    explanation: 'string',
    passage: 'string',
    audioUrl: 'string',
    audioText: 'string',
    difficulty: 'string',
    status: 'string',
    version: 'number',
    createdAt: 'number',
    updatedAt: 'number',
  },
  battle: {
    id: 'string',
    code: 'string',
    player1: 'string',
    player2: 'string',
    player1Name: 'string',
    player2Name: 'string',
    score1: 'number',
    score2: 'number',
    status: 'string',
    mode: 'string',
    categoryId: 'string',
    startedAt: 'number',
    logs: 'array',
  },
  activity: {
    id: 'string',
    userId: 'string',
    text: 'string',
    type: 'string',
    at: 'number',
    categoryId: 'string',
    answered: 'number',
    correct: 'number',
    completed: 'boolean',
  },
  search: { id: 'string', label: 'string', detail: 'string', page: 'string', query: 'string' },
  notification: {
    id: 'string',
    title: 'string',
    body: 'string',
    at: 'number',
    read: 'boolean',
    page: 'string',
  },
  audit: {
    id: 'string',
    actor: 'string',
    action: 'string',
    target: 'string',
    at: 'number',
    reason: 'string',
  },
  category: { id: 'string', name: 'string', description: 'string', status: 'string' },
  topic: {
    id: 'string',
    categoryId: 'string',
    title: 'string',
    description: 'string',
    status: 'string',
  },
  lesson: {
    id: 'string',
    topicId: 'string',
    title: 'string',
    description: 'string',
    difficulty: 'string',
    status: 'string',
  },
} satisfies Record<string, Record<string, string>>
function record(v: unknown, kind: keyof typeof shapes): boolean {
  if (!fields(v, shapes[kind]) || !object(v)) return false
  if (kind === 'profile') return v.role === 'administrator'
  if (kind === 'question')
    return (
      Number.isInteger(v.version) &&
      Number(v.version) >= 1 &&
      (v.options as unknown[]).every((o) => fields(o, { id: 'string', text: 'string' }))
    )
  if (kind === 'battle')
    return (
      (v.endedAt === null || typeof v.endedAt === 'number') &&
      (v.logs as unknown[]).every((l) =>
        fields(l, { id: 'string', at: 'number', type: 'string', message: 'string' }),
      )
    )
  return true
}
const array = (v: unknown, kind: keyof typeof shapes) =>
  Array.isArray(v) && v.every((x) => record(x, kind))
export function valid(method: string, v: unknown): boolean {
  const pages = {
    users: 'user',
    questions: 'question',
    battles: 'battle',
    activities: 'activity',
  } as const
  if (method in pages) {
    if (
      !fields(v, { items: 'array', total: 'number', page: 'number', pageSize: 'number' }) ||
      !object(v)
    )
      return false
    return (
      array(v.items, pages[method as keyof typeof pages]) &&
      ['total', 'page', 'pageSize'].every(
        (k) => Number.isInteger(v[k]) && Number(v[k]) >= (k === 'total' ? 0 : 1),
      ) &&
      (method !== 'activities' ||
        (v.items as unknown[]).every((a) => fields(a, { userName: 'string' })))
    )
  }
  if (method === 'search') return array(v, 'search')
  if (method === 'notifications') return array(v, 'notification')
  if (method === 'audit') return array(v, 'audit')
  if (['profile', 'saveProfile'].includes(method)) return record(v, 'profile')
  if (['user', 'saveUser'].includes(method)) return record(v, 'user')
  if (['question', 'saveQuestion'].includes(method)) return record(v, 'question')
  if (method === 'catalog')
    return (
      object(v) &&
      array(v.categories, 'category') &&
      array(v.topics, 'topic') &&
      array(v.lessons, 'lesson')
    )
  if (method === 'overview')
    return (
      fields(v, {
        totalUsers: 'number',
        newUsers: 'number',
        activeUsers: 'number',
        completedBattles: 'number',
        completedLessons: 'number',
        growth: 'object',
        series: 'array',
        categories: 'array',
        recent: 'array',
        asOf: 'number',
      }) &&
      object(v) &&
      array(v.recent, 'activity') &&
      fields(v.growth, {}) &&
      object(v.growth) &&
      ['users', 'active', 'battles'].every(
        (k) =>
          v.growth && object(v.growth) && (v.growth[k] === null || typeof v.growth[k] === 'number'),
      ) &&
      (v.accuracy === null || typeof v.accuracy === 'number') &&
      (v.completion === null || typeof v.completion === 'number') &&
      (v.series as unknown[]).every((x) =>
        fields(x, {
          date: 'string',
          users: 'number',
          previous: 'number',
          lessons: 'number',
          battles: 'number',
          active: 'number',
        }),
      ) &&
      (v.categories as unknown[]).every((x) =>
        fields(x, {
          id: 'string',
          name: 'string',
          lessons: 'number',
          battles: 'number',
          answered: 'number',
          correct: 'number',
          completed: 'number',
          started: 'number',
        }),
      )
    )
  if (method === 'battle')
    return (
      object(v) &&
      record(v.battle, 'battle') &&
      record(v.player1, 'user') &&
      record(v.player2, 'user')
    )
  if (method === 'exportReport')
    return (
      fields(v, { filename: 'string', columns: 'array', rows: 'array' }) &&
      object(v) &&
      (v.columns as unknown[]).every((c) => typeof c === 'string') &&
      (v.rows as unknown[]).every(
        (r) =>
          Array.isArray(r) &&
          r.length === (v.columns as unknown[]).length &&
          r.every((c) => typeof c === 'string' || typeof c === 'number'),
      )
    )
  return false
}
