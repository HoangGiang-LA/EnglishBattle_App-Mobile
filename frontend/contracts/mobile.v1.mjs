// Transport contract only. This module contains no server implementation.
const str = {type: 'string', minLength: 1, maxLength: 512};
const text = {type: 'string'};
const int = {type: 'integer', minimum: 0};
const nullableId = {anyOf: [str, {type: 'null'}]};
const object = (properties, required = Object.keys(properties)) => ({type: 'object', properties, required, additionalProperties: false});
const list = (items, maxItems) => ({type: 'array', items, ...(maxItems ? {maxItems} : {})});
const modes = {enum: ['PRACTICE', 'TEST', 'DAILY', 'BATTLE']};
const option = object({id: str, text});
export const question = object({id: str, version: str, categoryId: {enum: ['vocabulary', 'grammar', 'listening', 'reading']}, topicId: text, prompt: str,
  options: {...list(option), minItems: 2}, passage: text, audioText: text}, ['id', 'version', 'categoryId', 'prompt', 'options']);
const review = object({question, pickedId: nullableId, correctId: str, explanation: text});
export const result = object({attemptId: str, mode: modes, correct: int, total: {...int, minimum: 1}, coins: int,
  ratingDelta: {type: 'integer'}, outcome: {enum: ['completed', 'abandoned', 'win', 'loss', 'draw', 'left']},
  opponentName: text, opponentCorrect: int, completedAt: int, durationMs: {anyOf: [int, {type: 'null'}]}, reviews: list(review)}, ['attemptId', 'mode', 'correct', 'total', 'coins', 'outcome', 'reviews']);
const receipt = object({questionId: str, optionId: nullableId, correct: {type: ['boolean', 'null']}}, ['questionId', 'optionId']);
export const attempt = {...object({id: str, mode: modes, topicId: text, questions: list(question), index: int, deadlineAt: int,
  receipts: list(receipt), status: {enum: ['active', 'waiting', 'completed', 'abandoned']}, opponentName: text,
  result: {anyOf: [result, {type: 'null'}]}, selectedOptionId: nullableId, reconnectDeadlineAt: {anyOf: [int, {type: 'null'}]}}, ['id', 'mode', 'questions', 'index', 'deadlineAt', 'receipts', 'status']),
  allOf: [{if: {properties: {status: {const: 'active'}}}, then: {properties: {questions: {minItems: 1}}}},
    {if: {properties: {status: {enum: ['completed', 'abandoned']}}}, then: {required: ['result'], properties: {result}}}]};
const entry = object({uid: str, name: str, rank: {...int, minimum: 1}, rating: int});
const leaderboard = object({title: str, entries: list(entry, 100), self: {anyOf: [entry, {type: 'null'}]}, nextCursor: nullableId});
const ticket = object({id: str, status: {enum: ['searching', 'waiting', 'matched', 'cancelled', 'expired', 'failed']}, opponentName: text, attemptId: nullableId, roomCode: nullableId}, ['id', 'status']);
const notification = object({id: str, title: str, body: text, destination: {enum: ['Achievements', 'Challenge', 'Practice', 'Battle', 'Leaderboard', 'History', 'Wallet']}, read: {type: 'boolean'}, createdAt: int});
const dashboard = object({rating: int, coins: int, wins: int, losses: int, draws: int, streak: int,
  progress: {type: 'object', additionalProperties: int},
  daily: object({status: {enum: ['available', 'active', 'waiting', 'completed', 'abandoned']}, attemptId: nullableId}, ['status']),
  history: list(result, 50), achievements: list(object({id: str, title: str, description: text, unlocked: {type: 'boolean'},
    progress: int, threshold: {...int, minimum: 1}}, ['id', 'title', 'description', 'unlocked'])),
  notifications: list(notification, 50), unreadNotificationCount: int, studyStreak: int, studyDates: list(text, 7),
  ledger: list(object({id: str, label: str, delta: {type: 'integer'}, createdAt: int}), 50),
  skills: list(object({id: str, name: str, answered: int, correct: int}))},
  ['rating', 'coins', 'wins', 'losses', 'draws', 'streak', 'progress', 'daily', 'history', 'achievements', 'notifications', 'ledger', 'skills']);
const response = props => object({serverNow: int, ...props});
const counts = object({answered: int, correct: int});
const metric = object({sessions: int, answered: int, correct: int, durationMs: int, unknownDurationSessions: int,
  skills: {type: 'object', additionalProperties: counts}});
const dateKey = {type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$'};
const statistics = object({period: {enum: ['week', 'month']}, timeZone: {const: 'Asia/Ho_Chi_Minh'},
  today: dateKey, from: dateKey, to: dateKey, previousFrom: dateKey, previousTo: dateKey,
  current: metric, previous: metric, days: list(object({date: dateKey, ...metric.properties}), 31),
  accuracyDelta: {type: ['number', 'null']}, streak: int});
const empty = object({});
export const mobileContract = {
  version: 1, region: 'asia-southeast1', transport: 'firebase-callable',
  methods: {
    ensureUserProfile: {request: empty, response: response({}), writes: true},
    getUserDashboard: {request: empty, response: response({dashboard})},
    getStudyStatistics: {request: object({period: {enum: ['week', 'month']}}), response: response({statistics})},
    getHistory: {request: object({kind: {enum: ['learning', 'battle']}, cursor: nullableId}, ['kind']), response: response({page: object({entries: list(result, 25), nextCursor: nullableId})})},
    getCoinLedger: {request: object({cursor: nullableId}, []), response: response({page: object({entries: list(object({id: str, label: str, delta: {type: 'integer'}, createdAt: int}), 25), nextCursor: nullableId})})},
    startAttempt: {request: {...object({mode: modes, topicId: nullableId, requestId: str}, ['mode', 'requestId']),
      allOf: [{if: {properties: {mode: {const: 'PRACTICE'}}}, then: {required: ['topicId'], properties: {topicId: str}}}]}, response: response({attempt}), writes: true},
    resumeAttempt: {request: object({attemptId: str}), response: response({attempt})},
    submitAttemptAnswer: {request: object({attemptId: str, questionId: str, optionId: nullableId, requestId: str}), response: response({attempt}), writes: true},
    saveAttemptSelection: {request: object({attemptId: str, questionId: str, optionId: str, requestId: str}), response: response({accepted: {type: 'boolean'}}), writes: true},
    advanceAttempt: {request: object({attemptId: str, requestId: str, expectedIndex: {...int, maximum: 19}}, ['attemptId', 'requestId']), response: response({attempt}), writes: true},
    leaveAttempt: {request: object({attemptId: str, requestId: str}), response: response({attempt}), writes: true},
    findBattle: {request: {...object({kind: {enum: ['quick', 'daily', 'create', 'join']}, roomCode: nullableId, requestId: str}, ['kind', 'requestId']),
      allOf: [{if: {properties: {kind: {const: 'join'}}}, then: {required: ['roomCode'], properties: {roomCode: {type: 'string', pattern: '^[A-Z0-9]{6}$'}}}}]}, response: response({ticket}), writes: true, phaseOneKinds: ['quick']},
    getBattleTicket: {request: object({ticketId: str}), response: response({ticket})},
    cancelBattleSearch: {request: object({ticketId: str}), response: object({serverNow: int, attempt}, ['serverNow']), writes: true},
    getLeaderboard: {request: object({period: {enum: ['week', 'month']}, cursor: nullableId}, ['period']), response: response({page: leaderboard})},
    getNotifications: {request: object({cursor: nullableId}, []), response: response({page: object({entries: list(notification, 25), unreadCount: int, totalCount: int, nextCursor: nullableId})})},
    markNotificationsRead: {request: {...object({ids: list(str, 50), all: {const: true}}, []),
      oneOf: [{required: ['ids'], not: {required: ['all']}}, {required: ['all'], not: {required: ['ids']}}]}, response: response({}), writes: true},
    getAttemptResult: {request: object({attemptId: str}), response: response({result})},
  },
};

// Optional for older clients; current Android supplies a stable installation ID
// so another device cannot keep an active battle session alive accidentally.
for (const name of ['findBattle', 'getBattleTicket', 'cancelBattleSearch', 'resumeAttempt',
  'submitAttemptAnswer', 'saveAttemptSelection', 'advanceAttempt', 'leaveAttempt', 'getAttemptResult']) {
  mobileContract.methods[name].request.properties.clientSessionId = str;
}

const learningActions = ['startAttempt', 'resumeAttempt', 'submitAttemptAnswer', 'saveAttemptSelection',
  'advanceAttempt', 'leaveAttempt', 'getAttemptResult'];
mobileContract.methods.learningAttempt = {
  request: {oneOf: learningActions.map(action => object({action: {const: action}, payload: mobileContract.methods[action].request}))},
  response: {anyOf: [response({attempt}), response({accepted: {type: 'boolean'}}), response({result})]},
  writes: true,
};

export function assertAttemptSemantics(value) {
  const ids = new Set();
  for (const q of value.questions) {
    if (ids.has(q.id)) throw new Error('Duplicate question id'); ids.add(q.id);
    if (new Set(q.options.map(o => o.id)).size !== q.options.length) throw new Error('Duplicate option id');
  }
  if (value.status === 'active' && value.index >= value.questions.length) throw new Error('Invalid current question index');
  for (const receipt of value.receipts) {
    const q = value.questions.find(q => q.id === receipt.questionId);
    if (!q || (receipt.optionId !== null && !q.options.some(o => o.id === receipt.optionId))) throw new Error('Receipt does not reference a valid option');
  }
  if (new Set(value.receipts.map(r => r.questionId)).size !== value.receipts.length) throw new Error('Duplicate receipt');
  if (value.result && value.result.correct > value.result.total) throw new Error('Correct count exceeds total');
}
