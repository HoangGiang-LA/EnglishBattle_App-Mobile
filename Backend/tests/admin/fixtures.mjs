export const range = {from: '2026-11-01', to: '2026-11-03'}
export const profile = {id: 'admin_1', name: 'Administrator', email: 'admin@example.test', role: 'administrator', revision: 1}
export const user = {id: 'user_1', code: 'EB-user_1', name: 'Learner', email: 'learner@example.test',
  status: 'active', createdAt: 1, updatedAt: 1, rating: 5, coins: 2, revision: 1}
export const questionInput = {categoryId: 'vocabulary', topicId: 'topic_1', lessonId: 'lesson_1',
  prompt: 'Choose the word.', options: ['a', 'b', 'c', 'd'].map(id => ({id, text: id.toUpperCase()})),
  correctOptionId: 'a', explanation: 'Because A is correct.', passage: '', audioUrl: '', audioText: '',
  difficulty: 'easy', status: 'published'}
export const question = {...questionInput, id: 'question_1', code: 'Q-1', version: 1, createdAt: 1, updatedAt: 1}
export const battle = {id: 'battle_1', code: 'B-1', player1: 'user_1', player2: 'user_2',
  player1Name: 'Learner', player2Name: 'Other learner', score1: 5, score2: 3, status: 'completed',
  mode: 'quick', categoryId: 'mixed', startedAt: 1, endedAt: 2, logs: []}
export const activity = {id: 'activity_1', userId: 'user_1', userName: 'Learner', text: 'Completed practice',
  type: 'lesson', at: 2, categoryId: 'vocabulary', answered: 10, correct: 8, completed: true}
export const notification = {id: 'notice_1', title: 'Notice', body: 'A real event', at: 2, read: false, page: 'users'}
export const audit = {id: 'operation_1', operationId: 'operation_1', actor: 'admin_1', action: 'adminSaveUser',
  target: 'user/user_1', at: 2, reason: 'Support request', result: 'succeeded'}
export const overview = {totalUsers: 2, newUsers: 1, activeUsers: 2, completedBattles: 1, completedLessons: 1,
  growth: {users: null, active: null, battles: null}, series: [], categories: [], accuracy: 80, completion: 100,
  recent: [activity], asOf: 2, ready: true, lagMs: 0, generation: 'generation_1', granularity: 'day', timeZone: 'Asia/Ho_Chi_Minh',
  denominators: {answered: 10, correct: 8, started: 1, completed: 1}, coverage: {unknownStartSessions: 0,
    unclassifiedAnswers: 0, unknownAnswers: false, skillBreakdownComplete: true, partialPeriod: false,
    accountScope: 'retained-auth', completionBasis: 'started-in-period'}}
const write = {requestId: 'request_1'}
export const requests = {
  adminGetProfile: {},
  adminUpdateProfile: {...write, name: 'Updated name', expectedRevision: 0},
  adminGetOverview: {range},
  adminListUsers: {query: {pageSize: 10}},
  adminGetUser: {id: 'user_1'},
  adminSaveUser: {...write, input: {name: 'Learner', email: 'learner@example.test'}},
  adminSetUserStatus: {...write, id: 'user_1', status: 'banned', reason: 'Support case', expectedRevision: 1},
  adminListQuestions: {query: {pageSize: 20, categoryId: 'vocabulary'}},
  adminGetQuestion: {id: 'question_1'},
  adminSaveQuestion: {...write, input: questionInput},
  adminArchiveQuestion: {...write, id: 'question_1', expectedVersion: 1},
  adminGetCatalog: {},
  adminSaveContent: {...write, input: {kind: 'lesson', title: 'Lesson', description: '',
    status: 'draft', topicId: 'topic_1', difficulty: 'easy'}},
  adminListBattles: {query: {mode: 'quick'}},
  adminGetBattle: {id: 'battle_1'},
  adminListActivities: {query: {}},
  adminSearch: {q: 'Learner'},
  adminListNotifications: {query: {unreadOnly: true}},
  adminMarkNotificationsRead: {...write, throughAt: 1},
  adminListAudit: {query: {range}},
  adminExportReport: {...write, kind: 'users', query: {status: 'active'}, range},
}
const envelope = data => ({serverNow: 2, ...data})
const written = data => envelope({operationId: 'operation_1', ...data})
export const paged = items => ({items, total: items.length, page: 1, pageSize: 10,
  snapshotId: 'snapshot_1', expiresAt: 9999999999999, nextCursor: null})
export const responses = {
  adminGetProfile: envelope({profile}), adminUpdateProfile: written({profile}),
  adminGetOverview: envelope({overview}), adminListUsers: envelope({page: paged([user])}),
  adminGetUser: envelope({user}), adminSaveUser: written({user}), adminSetUserStatus: written({}),
  adminListQuestions: envelope({page: paged([question])}), adminGetQuestion: envelope({question}),
  adminSaveQuestion: written({question}), adminArchiveQuestion: written({}),
  adminGetCatalog: envelope({catalog: {categories: [], topics: [], lessons: []}}), adminSaveContent: written({}),
  adminListBattles: envelope({page: paged([battle])}),
  adminGetBattle: envelope({detail: {battle,
    player1: {id: user.id, code: user.code, name: user.name, status: user.status},
    player2: {id: 'user_2', code: 'EB-user_2', name: 'Other learner', status: 'active'}}}),
  adminListActivities: envelope({page: paged([activity])}), adminSearch: envelope({items: []}),
  adminListNotifications: envelope({page: paged([notification])}), adminMarkNotificationsRead: written({}),
  adminListAudit: envelope({page: paged([audit])}),
  adminExportReport: written({report: {filename: 'users.csv', columns: ['id'], rows: [['user_1']], total: 1, expiresAt: 9999999999999}}),
}
