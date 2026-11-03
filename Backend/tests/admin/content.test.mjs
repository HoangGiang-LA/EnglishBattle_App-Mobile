import assert from 'node:assert/strict'
import {test, beforeEach, after} from 'node:test'
import {createRequire} from 'node:module'
import {randomUUID, createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
assert.equal(process.env.GCLOUD_PROJECT, 'demo-englishbattle-admin')
assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, '127.0.0.1:19299')
assert.equal(process.env.FIREBASE_DATABASE_EMULATOR_HOST, '127.0.0.1:19200')
assert.equal(process.env.GOOGLE_APPLICATION_CREDENTIALS, undefined)
const require = createRequire(new URL('../../functions/package.json', import.meta.url))
const {adminAuth: auth, adminDb: db} = require('./lib/config/firebaseAdmin.js')
const {deleteApp} = require('firebase-admin/app')
const api = require('./lib/admin/callables.js')
const {adminRuntime} = require('./lib/admin/service.js')
const {adminOperationId} = require('./lib/admin/operations.js')
const {runQuestionIndexMaintenance, syncAdminQuestionIndex} = require('./lib/admin/questionIndex.js')
const {playableQuestion} = require('./lib/be1/practice/contentValidation.js')
const {selectQuestions, startAttempt} = require('./lib/be1/practice/startAttempt.js')
const {resumeAttempt} = require('./lib/be1/practice/resumeAttempt.js')
const {submitAttemptAnswer} = require('./lib/be1/practice/submitAttemptAnswer.js')
const {findBattle} = require('./lib/be1/battle/battleCallables.js')
const {provisionUserProfile} = require('./lib/be1/auth/userProvisioning.js')
assert.match(db.ref().toString(), /^http:\/\/127\.0\.0\.1:19200\//)
const seed = JSON.parse(readFileSync(new URL('../../database/english-battle.seed.json', import.meta.url), 'utf8'))
const read = async path => (await db.ref(path).get()).val()
const topicId = 'vocabulary_daily_life', lessonId = `lesson_${topicId}`, qid = `q_${topicId}_001`
const request = (u, data = {}) => ({data, auth: {uid: u.uid, token: u.decoded}, rawRequest: {headers: {authorization: `Bearer ${u.token}`}}})
const call = (name, u, data = {}) => api[name].run(request(u, data))
async function account(admin = true) {
  const email = `${randomUUID()}@example.test`, password = 'EmulatorOnly123!'
  const u = await auth.createUser({email, password, displayName: 'Content QA'})
  await auth.setCustomUserClaims(u.uid, {admin})
  await provisionUserProfile(u.uid)
  const response = await fetch('http://127.0.0.1:19299/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=emulator-only', {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({email, password, returnSecureToken: true}),
  })
  assert.equal(response.status, 200)
  const {idToken: token} = await response.json()
  return {...u, token, decoded: await auth.verifyIdToken(token)}
}
const get = async (actor, id = qid) => (await call('adminGetQuestion', actor, {id})).question
const fields = q => Object.fromEntries(['categoryId', 'topicId', 'lessonId', 'prompt', 'options', 'correctOptionId',
  'explanation', 'passage', 'audioUrl', 'audioText', 'difficulty', 'status'].map(key => [key, q[key]]))
const edit = (q, extra = {}) => ({id: q.id, expectedVersion: q.version, requestId: randomUUID(), input: {...fields(q), ...extra}})
const saveContent = (actor, input, expectedRevision) => call('adminSaveContent', actor, {
  input, requestId: randomUUID(), ...(input.id ? {expectedRevision} : {}),
})
const catalog = async actor => (await call('adminGetCatalog', actor)).catalog
async function readyIndex() {
  for (let i = 0; i < 100; i++) {
    await db.ref('adminQuestionIndexControl/nextRunAt').set(0)
    await runQuestionIndexMaintenance()
    if (await read('adminQuestionIndexMeta/ready')) return
  }
  assert.fail('Question backfill did not complete')
}
beforeEach(async () => {
  assert.equal((await fetch('http://127.0.0.1:19299/emulator/v1/projects/demo-englishbattle-admin/accounts', {method: 'DELETE'})).status, 200)
  await db.ref().set(seed)
})
after(async () => deleteApp(db.app))

test('catalog maps four skills and real source revisions while preserving runtime metadata on edit', async () => {
  const actor = await account(), before = await read('categories/vocabulary')
  const value = await catalog(actor)
  assert.equal(value.categories.length, 4)
  assert.equal(value.topics.find(t => t.id === 'vocabulary_idioms').categoryId, 'vocabulary')
  await saveContent(actor, {kind: 'category', id: 'vocabulary', title: 'Vocabulary edited', description: 'Admin description', status: 'published'}, 0)
  const current = await read('categories/vocabulary')
  assert.equal(current.name, 'Vocabulary edited')
  assert.equal(current.revision, 1)
  assert.equal(current.icon, before.icon)
  assert.equal(current.englishName, before.englishName)
  assert.equal((await catalog(actor)).categories.find(c => c.id === 'vocabulary').revision, 1)
})

test('topic and lesson creates keep stable IDs through retry; lesson category is derived from its topic', async () => {
  const actor = await account()
  const data = {requestId: randomUUID(), input: {kind: 'topic', title: 'New topic', description: '', categoryId: 'reading', status: 'published'}}
  const first = await call('adminSaveContent', actor, data)
  assert.deepEqual(await call('adminSaveContent', actor, data), first)
  const topics = (await catalog(actor)).topics.filter(t => t.title === 'New topic')
  assert.equal(topics.length, 1)
  assert.equal(topics[0].id, `admin_${first.operationId.slice(0, 40)}`)
  await saveContent(actor, {kind: 'lesson', title: 'New reading lesson', description: '', topicId: topics[0].id, difficulty: 'medium', status: 'published'})
  const lesson = (await catalog(actor)).lessons.find(l => l.title === 'New reading lesson')
  assert.equal(await read(`lessons/${lesson.id}/categoryId`), 'reading')
  assert.equal(lesson.revision, 1)
  await assert.rejects(saveContent(actor, {...data.input, title: 'New topic'}), {code: 'already-exists'})
})

test('catalog rejects invalid relations, moving populated parents, fifth skill and Idioms outside Vocabulary', async () => {
  const actor = await account()
  for (const input of [
    {kind: 'category', id: 'idioms', title: 'Bad skill', description: '', status: 'published'},
    {kind: 'topic', title: 'Idioms & Phrases', categoryId: 'grammar', description: '', status: 'published'},
    {kind: 'topic', id: topicId, title: 'Move topic', categoryId: 'grammar', description: '', status: 'published'},
    {kind: 'lesson', id: lessonId, title: 'Move lesson', topicId: 'grammar_tenses', description: '', difficulty: 'easy', status: 'draft'},
    {kind: 'lesson', title: 'Bad chain', topicId, categoryId: 'reading', description: '', difficulty: 'easy', status: 'draft'},
  ]) await assert.rejects(saveContent(actor, input, 0), {code: input.kind === 'category' ? 'invalid-argument' : 'failed-precondition'})
  assert.deepEqual(await read('questionVersions'), seed.questionVersions)
  await assert.rejects(saveContent(actor, {kind: 'topic', id: 'constructor', title: 'Missing record',
    categoryId: 'vocabulary', description: '', status: 'draft'}, 0), {code: 'not-found'})
})

test('two catalog edits of one revision accept one change and reject the other without a partial mutation', async () => {
  const a = await account(), b = await account()
  const input = {kind: 'category', id: 'grammar', title: 'First', description: '', status: 'published'}
  const data = {input, expectedRevision: 0, requestId: randomUUID()}
  const other = {...data, requestId: randomUUID(), input: {...input, title: 'Second'}}
  await call('adminSaveContent', a, data)
  await assert.rejects(call('adminSaveContent', b, other), e => e.details.reason === 'version-conflict' && e.details.operationPhase === 'failed')
  assert.equal(await read('categories/grammar/revision'), 1)
})

test('catalog capacity errors fail before effects and release locks so existing content remains editable', async () => {
  const actor = await account(), topics = {...seed.topics}
  for (let i = 0; Object.keys(topics).length < 500; i++) {
    topics[`capacity_${i}`] = {categoryId: 'vocabulary', title: `Capacity topic ${i}`, status: 'draft'}
  }
  await db.ref('topics').set(topics)
  await assert.rejects(saveContent(actor, {kind: 'topic', title: 'Over the limit', categoryId: 'vocabulary',
    description: '', status: 'draft'}), e => e.code === 'resource-exhausted' && e.details.operationPhase === 'failed')
  assert.equal(await read('adminResourceLocks'), null)
  assert.equal(Object.keys(await read('topics')).length, 500)
  await saveContent(actor, {kind: 'category', id: 'grammar', title: 'Still editable', description: '', status: 'published'}, 0)
  assert.equal(await read('categories/grammar/name'), 'Still editable')
})

test('draft/archive ancestors gate new sessions without cascading statuses or changing a running practice snapshot', async () => {
  const actor = await account(), learner = await account(false)
  const started = await startAttempt.run(request(learner, {mode: 'PRACTICE', topicId, requestId: randomUUID()}))
  const frozen = await read(`attemptQuestions/${learner.uid}/${started.attempt.id}`)
  await saveContent(actor, {kind: 'topic', id: topicId, categoryId: 'vocabulary', title: 'Parent archived', description: '', status: 'archived'}, 0)
  assert.equal(await read(`lessons/${lessonId}/status`), 'published')
  assert.equal(await read(`questions/${qid}/status`), 'published')
  await assert.rejects(selectQuestions('PRACTICE', topicId), {code: 'failed-precondition'})
  const resumed = await resumeAttempt.run(request(learner, {attemptId: started.attempt.id}))
  assert.equal(resumed.attempt.questions[0].prompt, started.attempt.questions[0].prompt)
  assert.deepEqual(await read(`attemptQuestions/${learner.uid}/${started.attempt.id}`), frozen)
  await assert.rejects(call('adminSaveQuestion', actor, edit(await get(actor), {prompt: 'Cannot publish under archived parent'})),
    e => e.details.reason === 'parent-not-published')
})

test('question reads resolve legacy TTS assets and retain ordered stable option IDs without source secrets', async () => {
  const actor = await account()
  const id = Object.keys(seed.questions).find(id => seed.questions[id].categoryId === 'listening')
  const q = await get(actor, id)
  assert.ok(q.audioText.trim())
  assert.equal(q.audioUrl, '')
  assert.deepEqual(q.options.map(o => o.id), ['opt_1', 'opt_2', 'opt_3', 'opt_4'])
  assert.equal(q.version, 1)
  assert.equal(q.source, undefined)
  assert.equal(q.lastAdminOperation, undefined)
})

test('question create writes playable server envelopes once with stable UID, answer/order mapping and one audit', async () => {
  const actor = await account(), q = await get(actor)
  const data = {requestId: randomUUID(), input: {...fields(q), prompt: 'A brand new question from admin'}}
  const results = await Promise.allSettled([call('adminSaveQuestion', actor, data), call('adminSaveQuestion', actor, data)])
  assert.ok(results.some(r => r.status === 'fulfilled'))
  const saved = await call('adminSaveQuestion', actor, data)
  assert.deepEqual(await call('adminSaveQuestion', actor, data), saved)
  assert.equal(saved.question.id, `q_admin_${saved.operationId.slice(0, 40)}`)
  assert.equal(saved.question.version, 1)
  const id = saved.question.id, meta = await read(`questions/${id}`)
  const version = await read(`questionVersions/${id}/v1`), answer = await read(`questionAnswers/${id}/v1`)
  assert.ok(playableQuestion(id, meta, version, answer, {...seed, assets: seed.contentAssets}))
  assert.equal(version.options.opt_4.order, 4)
  assert.equal(answer.correctOptionId, q.correctOptionId)
  assert.equal(Object.keys(await read(`questionVersions/${id}`)).length, 1)
  assert.equal(Object.keys(await read('adminAudit')).length, 1)
  assert.equal((await read(`adminAudit/${saved.operationId}`)).actor, actor.uid)
  assert.equal(await read(`adminQuestionIndex/${id}/version`), 1)
})

test('edits and archive create successive immutable versions; stale saves cannot resurrect an archived question', async () => {
  const actor = await account(), q = await get(actor), oldVersion = await read(`questionVersions/${qid}/v1`)
  const oldAnswer = await read(`questionAnswers/${qid}/v1`)
  const saved = await call('adminSaveQuestion', actor, edit(q, {prompt: 'Edited prompt', correctOptionId: 'opt_2', explanation: 'Changed answer'}))
  assert.equal(saved.question.version, 2)
  const data = {id: qid, expectedVersion: 2, requestId: randomUUID()}
  const archived = await call('adminArchiveQuestion', actor, data)
  assert.deepEqual(await call('adminArchiveQuestion', actor, data), archived)
  assert.equal((await get(actor)).version, 3)
  assert.equal((await get(actor)).status, 'archived')
  await assert.rejects(call('adminSaveQuestion', actor, edit(saved.question)), e => e.details.reason === 'version-conflict')
  assert.deepEqual(await read(`questionVersions/${qid}/v1`), oldVersion)
  assert.deepEqual(await read(`questionAnswers/${qid}/v1`), oldAnswer)
  assert.equal(Object.keys(await read(`questionVersions/${qid}`)).length, 3)
  assert.equal(await read(`lessonQuestions/${lessonId}/${qid}/status`), 'archived')
})

test('a newly published topic, lesson and ten admin questions are usable through the real practice callable', async () => {
  const actor = await account(), learner = await account(false), original = await get(actor)
  await saveContent(actor, {kind: 'topic', title: 'New playable topic', categoryId: 'vocabulary', description: '', status: 'published'})
  const topic = (await catalog(actor)).topics.find(t => t.title === 'New playable topic')
  await saveContent(actor, {kind: 'lesson', title: 'New playable lesson', topicId: topic.id, description: '', difficulty: 'easy', status: 'published'})
  const lesson = (await catalog(actor)).lessons.find(l => l.topicId === topic.id)
  const ids = []
  for (let i = 0; i < 10; i++) {
    const saved = await call('adminSaveQuestion', actor, {requestId: randomUUID(), input: {...fields(original),
      topicId: topic.id, lessonId: lesson.id, prompt: `New playable bank question ${i}`}})
    ids.push(saved.question.id)
  }
  const started = await startAttempt.run(request(learner, {mode: 'PRACTICE', topicId: topic.id, requestId: randomUUID()}))
  assert.equal(started.attempt.questions.length, 10)
  assert.deepEqual(started.attempt.questions.map(q => q.id).sort(), ids.sort())
  assert.ok(started.attempt.questions.every(q => q.version === 'v1' && q.prompt.startsWith('New playable bank')))
  assert.ok(started.attempt.questions.every(q => !('correctOptionId' in q) && !('explanation' in q)))
})

test('concurrent question edits allow only one result at the expected version', async () => {
  const a = await account(), b = await account(), q = await get(a)
  const inputs = [edit(q, {prompt: 'Concurrent A'}), edit(q, {prompt: 'Concurrent B'})]
  const results = await Promise.allSettled([call('adminSaveQuestion', a, inputs[0]), call('adminSaveQuestion', b, inputs[1])])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  const loser = results.findIndex(r => r.status === 'rejected')
  await assert.rejects(call('adminSaveQuestion', [a,b][loser], inputs[loser]), e => e.details.reason === 'version-conflict')
  assert.equal(await read(`questions/${qid}/currentVersion`), 'v2')
  assert.equal(Object.keys(await read(`questionVersions/${qid}`)).length, 2)
})

test('invalid question fields and mismatched hierarchy never alter source versions', async () => {
  const actor = await account(), q = await get(actor)
  for (const extra of [
    {options: q.options.map(o => ({...o, text: ' SAME '}))}, {correctOptionId: 'missing'},
    {explanation: ''}, {categoryId: 'reading'}, {audioUrl: 'https://example.test/file.mp3'},
    {options: q.options.map((o, i) => ({...o, id: String(i)}))},
    {lessonId: 'missing'}, {options: [...q.options.slice(0, 3), q.options[0]]},
  ]) await assert.rejects(call('adminSaveQuestion', actor, edit(q, extra)))
  assert.deepEqual(await read(`questionVersions/${qid}`), seed.questionVersions[qid])
  assert.equal(await read(`questions/${qid}/currentVersion`), 'v1')
})

test('Reading passage and Listening TTS are required for publication and new versions pass the user validator', async () => {
  const actor = await account()
  for (const skill of ['reading', 'listening']) {
    const id = Object.keys(seed.questions).find(id => seed.questions[id].categoryId === skill)
    const q = await get(actor, id), field = skill === 'reading' ? 'passage' : 'audioText'
    await assert.rejects(call('adminSaveQuestion', actor, edit(q, {[field]: ''})), {code: 'invalid-argument'})
    const updated = await call('adminSaveQuestion', actor, edit(q, {[field]: 'Admin supplied learning content'}))
    assert.equal(updated.question.version, 2)
    assert.equal(await read(`questionVersions/${id}/v2/audioAssetId`), null)
    assert.ok(playableQuestion(id, await read(`questions/${id}`), await read(`questionVersions/${id}/v2`),
      await read(`questionAnswers/${id}/v2`), {...seed, assets: seed.contentAssets}))
  }
})

test('an interrupted answer write keeps the old currentVersion playable and recovers without duplicate versions', async () => {
  const actor = await account(), q = await get(actor), data = edit(q, {prompt: 'Recovered after version write'})
  const original = db.ref
  db.ref = function(path) { const ref = original.call(this, path)
    if (path === `questionAnswers/${qid}/v2`) ref.transaction = async () => {throw new Error('Injected RTDB failure')}
    return ref
  }
  try { await assert.rejects(call('adminSaveQuestion', actor, data), {code: 'aborted'}) }
  finally {db.ref = original}
  assert.equal(await read(`questions/${qid}/currentVersion`), 'v1')
  assert.ok(await read(`questionVersions/${qid}/v2`))
  assert.equal((await call('adminSaveQuestion', actor, data)).question.version, 2)
  assert.equal(Object.keys(await read(`questionVersions/${qid}`)).length, 2)
})

test('lost source commit acknowledgement and index failures recover using the same request without incrementing again', async () => {
  const actor = await account(), q = await get(actor), data = edit(q, {prompt: 'Lost commit acknowledgement'})
  const original = db.ref; let injected = false
  db.ref = function(path) {const ref = original.call(this, path), transact = ref.transaction
    if (path === `questions/${qid}`) ref.transaction = async function(...args) {
      const result = await transact.apply(this, args)
      if (!injected) {injected = true; throw new Error('Lost ACK')}
      return result
    }
    return ref
  }
  try { await assert.rejects(call('adminSaveQuestion', actor, data), {code: 'aborted'}) }
  finally {db.ref = original}
  assert.ok(injected)
  assert.equal(await read(`questions/${qid}/currentVersion`), 'v2')
  const completed = await call('adminSaveQuestion', actor, data)
  assert.equal(completed.question.version, 2)
  assert.equal(Object.keys(await read('adminAudit')).length, 1)
  const next = edit(completed.question, {prompt: 'Index recovery'})
  db.ref = function(path) {const ref = original.call(this, path)
    if (path === `adminQuestionIndex/${qid}`) ref.transaction = async () => {throw new Error('Index interrupted')}
    return ref
  }
  try {await assert.rejects(call('adminSaveQuestion', actor, next), {code: 'aborted'})}
  finally {db.ref = original}
  const id = adminOperationId(actor.uid, 'adminSaveQuestion', next.requestId)
  await adminRuntime.operations.process(id)
  assert.equal(await read(`questions/${qid}/currentVersion`), 'v3')
  assert.equal(await read(`adminQuestionIndex/${qid}/version`), 3)
  assert.equal(Object.keys(await read('adminAudit')).length, 2)
})

test('a running study keeps its prompt, answer and explanation after edit/archive', async () => {
  const actor = await account(), learner = await account(false)
  const started = await startAttempt.run(request(learner, {mode: 'PRACTICE', topicId, requestId: randomUUID()}))
  const current = started.attempt.questions[0], old = await get(actor, current.id)
  const changed = await call('adminSaveQuestion', actor, edit(old, {prompt: 'Future sessions only',
    correctOptionId: old.options.find(o => o.id !== old.correctOptionId).id, explanation: 'Future explanation'}))
  await call('adminArchiveQuestion', actor, {id: old.id, expectedVersion: changed.question.version, requestId: randomUUID()})
  const resumed = await resumeAttempt.run(request(learner, {attemptId: started.attempt.id}))
  assert.equal(resumed.attempt.questions[0].prompt, current.prompt)
  assert.equal(resumed.attempt.questions[0].version, current.version)
  const answered = await submitAttemptAnswer.run(request(learner, {attemptId: started.attempt.id, questionId: current.id,
    optionId: old.correctOptionId, requestId: randomUUID()}))
  assert.equal(answered.attempt.receipts[0].correct, true)
  assert.equal((await read(`questionAnswers/${current.id}/${current.version}`)).explanation, old.explanation)
})

test('a running battle keeps its questions and trusted answer keys after edits and archive', async () => {
  const actor = await account(), a = await account(false), b = await account(false)
  await findBattle.run(request(a, {kind: 'quick', clientSessionId: 'content_qa_a', requestId: randomUUID()}))
  const matched = await findBattle.run(request(b, {kind: 'quick', clientSessionId: 'content_qa_b', requestId: randomUUID()}))
  const matchId = matched.ticket.attemptId
  const frozen = await read(`battleRooms/${matchId}`)
  assert.ok(frozen?.questions?.length)
  const q = await get(actor, frozen.questions[0].id)
  const saved = await call('adminSaveQuestion', actor, edit(q, {prompt: 'Changed after battle started'}))
  await call('adminArchiveQuestion', actor, {id: q.id, expectedVersion: saved.question.version, requestId: randomUUID()})
  assert.deepEqual((await read(`battleRooms/${matchId}`)).questions, frozen.questions)
  assert.deepEqual((await read(`battleRooms/${matchId}`)).keys, frozen.keys)
})

test('question backfill covers more than 50 rows and returns exact stable filtered snapshots across pages', async () => {
  const actor = await account(), other = await account()
  await assert.rejects(call('adminListQuestions', actor, {query: {}}), e => e.details.reason === 'question-index-not-ready')
  await readyIndex()
  const query = {pageSize: 20, status: 'published', categoryId: 'vocabulary', difficulty: 'easy'}
  const first = (await call('adminListQuestions', actor, {query})).page
  const expected = Object.entries(seed.questions).filter(([,q]) => q.status === 'published' && q.categoryId === 'vocabulary' && q.difficulty === 'easy')
  assert.ok(Object.keys(seed.questions).length > 50)
  assert.equal(first.total, expected.length)
  const second = (await call('adminListQuestions', actor, {query: {...query, page: 2, snapshotId: first.snapshotId, cursor: first.nextCursor}})).page
  assert.equal(new Set([...first.items, ...second.items].map(q => q.id)).size, first.items.length + second.items.length)
  await call('adminArchiveQuestion', actor, {id: first.items[0].id, expectedVersion: first.items[0].version, requestId: randomUUID()})
  const stable = (await call('adminListQuestions', actor, {query: {...query, snapshotId: first.snapshotId}})).page
  assert.deepEqual(stable.items, first.items)
  const fresh = (await call('adminListQuestions', actor, {query})).page
  assert.equal(fresh.total, first.total - 1)
  await assert.rejects(call('adminListQuestions', other, {query: {...query, snapshotId: first.snapshotId}}))
  await assert.rejects(call('adminListQuestions', actor, {query: {...query, categoryId: 'reading', snapshotId: first.snapshotId}}))
  await db.ref(`adminSnapshots/${first.snapshotId}/expiresAt`).set(1)
  await assert.rejects(call('adminListQuestions', actor, {query: {...query, snapshotId: first.snapshotId}}))
})

test('question search matches text and IDs, stale index writers rebuild and snapshots reject scans that change mid-read', async () => {
  const actor = await account()
  await readyIndex()
  const found = (await call('adminListQuestions', actor, {query: {q: qid}})).page
  assert.equal(found.total, 1)
  await db.ref('adminQuestionIndexMeta/writers/dead').set({id: qid, startedAt: 1})
  await db.ref('adminQuestionIndexControl/nextRunAt').set(0)
  await runQuestionIndexMaintenance()
  assert.equal(await read('adminQuestionIndexMeta/ready'), false)
  await readyIndex()
  assert.equal(await read('adminQuestionIndexMeta/writers/dead'), null)
  assert.equal((await call('adminListQuestions', actor, {query: {q: qid}})).page.total, 1)
  const original = db.ref; let injected = false
  db.ref = function(path) {const ref = original.call(this, path)
    if (path === 'adminQuestionIndex') {
      const byKey = ref.orderByKey
      ref.orderByKey = function() {const query = byKey.call(this), limit = query.limitToFirst
        query.limitToFirst = function(n) {const bounded = limit.call(this, n), get = bounded.get
          bounded.get = async function() {const snap = await get.call(this)
            if (!injected) {injected = true; await original.call(db, 'adminQuestionIndexMeta/version').set(Date.now())}
            return snap
          }; return bounded
        }; return query
      }
    }; return ref
  }
  try {await assert.rejects(call('adminListQuestions', actor, {query: {}}), {code: 'aborted'})}
  finally {db.ref = original}
  assert.ok(injected)
})

test('source version corruption is reported instead of overwritten and no browser client can read question answers', async () => {
  const actor = await account(), q = await get(actor)
  await db.ref(`questionVersions/${qid}/v2`).set({prompt: 'Existing orphan must not be overwritten'})
  const data = edit(q, {prompt: 'Attempt immutable overwrite'})
  await assert.rejects(call('adminSaveQuestion', actor, data), e => e.details.operationPhase === 'blocked')
  assert.equal(await read(`questionVersions/${qid}/v2/prompt`), 'Existing orphan must not be overwritten')
  assert.equal(await read(`questions/${qid}/currentVersion`), 'v1')
  const hash = createHash('sha256').update(`question/${qid}`).digest('hex')
  assert.ok(await read(`adminResourceLocks/${hash}`))
  const response = await fetch(`http://127.0.0.1:19200/questionAnswers/${qid}.json?ns=demo-englishbattle-admin-default-rtdb&auth=${actor.token}`)
  assert.equal(response.status, 401)
  assert.equal(await read(`questionAnswers/${qid}/v1/correctOptionId`), seed.questionAnswers[qid].v1.correctOptionId)
})
