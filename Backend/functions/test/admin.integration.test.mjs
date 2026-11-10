import {test, before, after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID, createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {deleteApp} from '../../server/node_modules/firebase-admin/lib/app/index.js'
import {assertEmulators, connectLocalFirebase, signIn, callable, functionsBase} from '../../server/tools/local-config.mjs'
import contract from '../../../frontend/contracts/admin.v1.json' with {type:'json'}
import {valid} from '../../../frontend/admin-web/src/data/admin-response.ts'

await assertEmulators()
const {app,auth,database} = connectLocalFirebase()
const prefix=`admtest_${randomUUID().replaceAll('-','')}`
const ids=[`${prefix}_a`,`${prefix}_b`,`${prefix}_learner`,`${prefix}_revoked`]
const tokens={}, createdQuestions=[], createdContent=[], operations=[], battleIds=[]
const date=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Ho_Chi_Minh'})
const range={from:date,to:date}
const hash=value=>createHash('sha256').update(value).digest('hex')
const opId=(actor,action,id)=>hash(JSON.stringify(`adminOperations/${actor}/${action.replaceAll('.','_')}/${id}`))
const questionForm={categoryId:'vocabulary',topicId:'vocabulary_daily_life',lessonId:'',prompt:`${prefix} What is the right answer?`,options:[1,2,3,4].map(i=>({id:`opt_${i}`,text:`Answer ${i}`})),correctOptionId:'opt_1',explanation:'Fixture explanation',passage:'',audioUrl:'',audioText:'',difficulty:'easy',status:'draft'}
const requestId=()=>randomUUID()
async function api(name,data={},actor=ids[0]) {
  const result=await callable(name,tokens[actor],data)
  const spec=Object.values(contract.methods).find(v=>v.callable===name)
  if(result.status===200) {
    assert.equal(typeof result.body.result.serverNow,'number')
    if(spec.payloadKey) assert.equal(valid(Object.keys(contract.methods).find(k=>contract.methods[k]===spec),result.body.result[spec.payloadKey]),true,`${name} domain schema`)
  }
  return result
}
async function write(name,data,action,actor=ids[0]) {
  operations.push({actor,action,requestId:data.requestId})
  return api(name,data,actor)
}
function ok(r) {assert.equal(r.status,200,JSON.stringify(r.body));return r.body.result}
function denied(r,code) {assert.equal(r.body.error?.status,code,JSON.stringify(r.body))}
async function newQuestion(extra={}) {
 const data={input:{...questionForm,...extra},requestId:requestId()}
 const q=ok(await write('adminSaveQuestion',data,'question.save')).question
 createdQuestions.push(q.id);return q
}
before(async()=>{
  for(const [i,uid] of ids.entries()) {
    await auth.createUser({uid,email:`${uid}@example.test`,password:'LocalDemo123!',displayName:`Fixture ${i}`})
    const token=await signIn(`${uid}@example.test`)
    assert.equal((await callable('ensureUserProfile',token)).status,200)
    if(i!==2) await auth.setCustomUserClaims(uid,{admin:true})
    tokens[uid]=await signIn(`${uid}@example.test`)
  }
})
after(async()=>{
 try {
  const update={}
  for(const id of createdQuestions) for(const root of ['questions','questionVersions','questionAnswers','adminViews/questions']) update[`${root}/${id}`]=null
  for(const [root,id] of createdContent) { update[`${root}/${id}`]=null; if(root==='lessons')update[`lessonQuestions/${id}`]=null }
  for(const id of battleIds) { update[`battleRooms/${id}`]=null;update[`battleResults/${id}`]=null }
  for(const op of operations) {
    const id=opId(op.actor,op.action,op.requestId)
    update[`adminAuditRecent/${id}`]=null;update[`adminAuditLogs/${date}/${id}`]=null
  }
  for(const uid of ids) {
    for(const root of ['users','userPrivate','userSettings','userStats','accountAccess','wallets','adminProfiles','adminOperations','adminNotifications']) update[`${root}/${uid}`]=null
    update[`adminLocks/user_${uid}`]=null;update[`adminLocks/notifications_${uid}`]=null
  }
  // Never clear the shared content lock unless it belongs to one of our operation paths.
  const lock=(await database.ref('adminLocks/content').get()).val()
  if(typeof lock==='string'&&ids.some(uid=>lock.startsWith(`adminOperations/${uid}/`))) update['adminLocks/content']=null
  await database.ref().update(update)
  for(const uid of ids) await auth.deleteUser(uid).catch(()=>{})
 } finally { await deleteApp(app) }
})
test('all 21 admin callables require authentication and reject learner',async()=>{
  for(const spec of Object.values(contract.methods).filter(v=>v.callable)) {
    const response=await fetch(`${functionsBase}/${spec.callable}`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"data":{}}'})
    assert.equal(response.status,401,spec.callable)
    denied(await api(spec.callable,{},ids[2]),'PERMISSION_DENIED')
  }
})
test('current claims, disabled, banned, deleted and revoked sessions are checked on every request',async()=>{
  const uid=ids[1]
  await auth.setCustomUserClaims(uid,{})
  denied(await api('adminGetProfile',{},uid),'PERMISSION_DENIED')
  await auth.setCustomUserClaims(uid,{admin:true})
  await auth.updateUser(uid,{disabled:true})
  denied(await api('adminGetProfile',{},uid),'PERMISSION_DENIED')
  await auth.updateUser(uid,{disabled:false})
  for(const status of ['banned','deleted']) {
    await database.ref(`accountAccess/${uid}/status`).set(status)
    denied(await api('adminGetProfile',{},uid),'PERMISSION_DENIED')
  }
  await database.ref(`accountAccess/${uid}/status`).set('active')
  ok(await api('adminGetProfile',{},uid))
  await new Promise(r=>setTimeout(r,1200))
  await auth.revokeRefreshTokens(ids[3])
  denied(await api('adminGetProfile',{},ids[3]),'UNAUTHENTICATED')
})
test('profile update is idempotent; payload mismatch rejected; no role/rating/coins input accepted',async()=>{
  const before=ok(await api('adminGetProfile')).profile
  assert.equal(before.role,'administrator')
  const payload={name:`${prefix} Admin`,requestId:requestId()}
  const first=ok(await write('adminUpdateProfile',payload,'profile.update'))
  assert.deepEqual(ok(await api('adminUpdateProfile',payload)),first)
  denied(await api('adminUpdateProfile',{...payload,name:'Other'}),'ALREADY_EXISTS')
  denied(await api('adminUpdateProfile',{...payload,requestId:requestId(),role:'admin'}),'INVALID_ARGUMENT')
  for(const field of ['role','rating','coins']) denied(await api('adminSaveUser',{id:ids[2],requestId:requestId(),input:{name:'Learner',email:`${ids[2]}@example.test`,[field]:99}}),'INVALID_ARGUMENT')
  const create=await api('adminSaveUser',{input:{name:'New learner',email:'new-fixture@example.test'},requestId:requestId()})
  denied(create,'INVALID_ARGUMENT')
  denied(await write('adminSetUserStatus',{id:ids[0],status:'banned',reason:'self restriction',requestId:requestId()},'user.status'),'FAILED_PRECONDITION')
})
test('admin creates a learner with a unique initial password without granting admin or storing the password',async()=>{
 const password='FixtureOnly123!', payload={input:{name:prefix+' created learner',email:prefix+'created@example.test',password},requestId:requestId()}
 const result=ok(await write('adminSaveUser',payload,'user.create')), uid=result.user.id
 ids.push(uid)
 assert.equal(result.user.rating,0);assert.equal(result.user.coins,0)
 const created=await auth.getUser(uid);assert.notEqual(created.customClaims?.admin,true);assert.equal(created.disabled,false)
 const token=await signIn(payload.input.email,password)
 assert.equal((await callable('ensureUserProfile',token)).status,200)
 assert.equal((await database.ref('wallets/'+uid+'/coinBalance').get()).val(),0)
 assert.deepEqual(ok(await api('adminSaveUser',payload)),result)
 denied(await api('adminSaveUser',{...payload,input:{...payload.input,password:'ChangedPassword123!'}}),'ALREADY_EXISTS')
 const op=(await database.ref('adminOperations/'+ids[0]+'/user_create/'+payload.requestId).get()).val()
 assert.equal(JSON.stringify(op).includes(password),false)
 assert.equal(JSON.stringify(result).includes(password),false)
})
test('question writes preserve immutable old versions, stable IDs and exact filter/total',async()=>{
  const q=await newQuestion()
  const old=(await database.ref(`questionVersions/${q.id}/v1`).get()).val()
  const answers=(await database.ref(`questionAnswers/${q.id}/v1`).get()).val()
  const input={...questionForm,prompt:`${prefix} changed question`}, payload={id:q.id,expectedVersion:1,input,requestId:requestId()}
  const q2=ok(await write('adminSaveQuestion',payload,'question.save')).question
  assert.equal(q2.version,2)
  assert.deepEqual(ok(await api('adminSaveQuestion',payload)).question,q2)
  assert.deepEqual((await database.ref(`questionVersions/${q.id}/v1`).get()).val(),old)
  assert.deepEqual((await database.ref(`questionAnswers/${q.id}/v1`).get()).val(),answers)
  denied(await write('adminSaveQuestion',{...payload,requestId:requestId()},'question.save'),'ABORTED')
  const filtered=ok(await api('adminListQuestions',{query:{q:prefix,page:1,pageSize:1,status:'draft'}})).page
  assert.equal(filtered.total,1);assert.equal(filtered.items[0].id,q.id)
  const second=ok(await api('adminListQuestions',{query:{q:prefix,page:2,pageSize:1}})).page
  assert.equal(second.total,1);assert.equal(second.items.length,0)
  assert.equal(ok(await api('adminGetQuestion',{id:q.id})).question.version,2)
  await database.ref('adminViews/questions/'+q.id).update({currentVersion:'v1',prompt:'stale projection must not be used'})
  const canonicalList=ok(await api('adminListQuestions',{query:{q:prefix}})).page
  assert.equal(canonicalList.items.find(row=>row.id===q.id).prompt,input.prompt)
  const archive={id:q.id,expectedVersion:2,requestId:requestId()}
  ok(await write('adminArchiveQuestion',archive,'question.archive'))
  assert.equal(ok(await api('adminGetQuestion',{id:q.id})).question.status,'archived')
  assert.deepEqual((await database.ref(`questionVersions/${q.id}/v1`).get()).val(),old)
})
test('concurrent requests cannot create duplicate version or audit and stale version cannot win',async()=>{
  const payload={input:{...questionForm,prompt:`${prefix} concurrent fixture`},requestId:requestId()}
  const responses=await Promise.all([write('adminSaveQuestion',payload,'question.save'),api('adminSaveQuestion',payload)])
  assert.ok(responses.some(r=>r.status===200))
  for(const r of responses) if(r.status!==200) denied(r,'ABORTED')
  const q=ok(await api('adminSaveQuestion',payload)).question;createdQuestions.push(q.id)
  assert.equal(q.version,1)
  assert.equal((await database.ref(`questionVersions/${q.id}`).get()).numChildren(),1)
  const responseId=opId(ids[0],'question.save',payload.requestId)
  assert.equal((await database.ref(`adminAuditRecent/${responseId}`).get()).exists(),true)
  const updates=[1,2].map(i=>({input:{...questionForm,prompt:`${prefix} update ${i}`},id:q.id,expectedVersion:1,requestId:requestId()}))
  const raced=await Promise.all(updates.map(p=>write('adminSaveQuestion',p,'question.save')))
  assert.equal(raced.filter(r=>r.status===200).length,1)
  assert.equal(ok(await api('adminGetQuestion',{id:q.id})).question.version,2)
})
test('validates published content, parent relationships, option IDs and non-production audio',async()=>{
 for(const input of [
   {...questionForm,options:questionForm.options.slice(0,3)},
   {...questionForm,options:questionForm.options.map(()=>({id:'same',text:'same'}))},
   {...questionForm,correctOptionId:'not_an_option'},
   {...questionForm,audioUrl:'data:audio/mp3;base64,abc'},
   {...questionForm,status:'published',explanation:''},
   {...questionForm,categoryId:'reading',status:'published',passage:''},
 ]) denied(await api('adminSaveQuestion',{input,requestId:requestId()}),'INVALID_ARGUMENT')
 denied(await write('adminSaveQuestion',{input:{...questionForm,categoryId:'grammar'},requestId:requestId()},'question.save'),'INVALID_ARGUMENT')
 const cat=ok(await api('adminGetCatalog')).catalog;assert.equal(cat.categories.length,4)
 const payload={input:{kind:'topic',title:`${prefix} Topic`,description:'Fixture topic',status:'published',categoryId:'vocabulary'},requestId:requestId()}
 const id=`topic_${hash(JSON.stringify([ids[0],payload.requestId])).slice(0,24)}`
 ok(await write('adminSaveContent',payload,'content.save'));createdContent.push(['topics',id])
 assert.ok(ok(await api('adminGetCatalog')).catalog.topics.some(t=>t.id===id))
 const lessonPayload={input:{kind:'lesson',title:'Fixture lesson',description:'Fixture',status:'published',topicId:id,difficulty:'easy'},requestId:requestId()}
 const lessonId=`lesson_${hash(JSON.stringify([ids[0],lessonPayload.requestId])).slice(0,24)}`
 ok(await write('adminSaveContent',lessonPayload,'content.save'));createdContent.push(['lessons',lessonId])
 const linked=await newQuestion({topicId:id,lessonId,status:'published'})
 assert.equal((await database.ref('lessonQuestions/'+lessonId+'/'+linked.id+'/version').get()).val(),'v1')
 const edit={id:linked.id,expectedVersion:1,requestId:requestId(),input:{...questionForm,topicId:id,lessonId,status:'published'}}
 ok(await write('adminSaveQuestion',edit,'question.save'))
 assert.equal((await database.ref('lessonQuestions/'+lessonId+'/'+linked.id+'/version').get()).val(),'v2')
 ok(await write('adminArchiveQuestion',{id:linked.id,expectedVersion:2,requestId:requestId()},'question.archive'))
 assert.equal((await database.ref('lessonQuestions/'+lessonId+'/'+linked.id+'/version').get()).val(),'v3')
 assert.equal((await database.ref('lessonQuestions/'+lessonId+'/'+linked.id+'/enabled').get()).val(),false)

})
test('notifications are isolated by UID; marking read and audit are replay safe; export escapes formula strings',async()=>{
 const nid=`${prefix}_notification`
 for(const uid of ids.slice(0,2)) await database.ref(`adminNotifications/${uid}/${nid}`).set({title:`Notification ${uid}`,body:'Fixture operation',page:'content',createdAt:Date.now()})
 const list=ok(await api('adminListNotifications')).items
 assert.equal(list.filter(n=>n.id===nid).length,1);assert.equal(list.find(n=>n.id===nid).title,`Notification ${ids[0]}`)
 const payload={id:nid,requestId:requestId()}
 ok(await write('adminMarkNotificationsRead',payload,'notifications.read'))
 assert.equal(ok(await api('adminListNotifications')).items.find(n=>n.id===nid).read,true)
 assert.equal((await database.ref(`adminNotifications/${ids[1]}/${nid}/readAt`).get()).exists(),false)
 ok(await api('adminMarkNotificationsRead',payload))
 const all={requestId:requestId()};ok(await write('adminMarkNotificationsRead',all,'notifications.read'))
 const audit=ok(await api('adminListAudit')).items
 assert.ok(audit.some(a=>a.actor===ids[0]&&a.action==='notifications.read'))
 const search=ok(await api('adminSearch',{q:prefix})).items;assert.ok(search.length>0&&search.length<=20)
 const q=await newQuestion({prompt:'=SUM(1,2) fixture'})
 const report=ok(await api('adminExportReport',{kind:'questions',query:{q:q.code},range})).report
 assert.equal(report.rows.length,1);assert.equal(report.rows[0][2],"'=SUM(1,2) fixture")
})
test('battle monitoring and analytics use authoritative fixture sources without leaking answer logs',async()=>{
 const id=`${prefix}_battle`;battleIds.push(id)
 const at=Date.now(), participants={[ids[0]]:{displayName:'Admin'},[ids[2]]:{displayName:'Learner'}}
 await database.ref(`battleRooms/${id}`).set({displayCode:id,mode:'quick',categoryId:'vocabulary',status:'completed',participants,questionCount:10,correctCounts:{[ids[0]]:8,[ids[2]]:6},startedAt:at-60000})
 await database.ref(`battleResults/${id}`).set({status:'settled',correctCounts:{[ids[0]]:8,[ids[2]]:6},finishedAt:at})
 const b=ok(await api('adminListBattles',{query:{q:id}})).page
 assert.equal(b.total,1);assert.equal(b.items[0].status,'completed')
 const detail=ok(await api('adminGetBattle',{id})).detail
 assert.equal(detail.player1.id,ids[0]);assert.equal(detail.battle.logs.some(l=>l.type==='answer_accepted'),false)
 const events=ok(await api('adminListActivities',{query:{q:id}})).page
 assert.equal(events.total,1)
 const stats=ok(await api('adminGetOverview',{range})).overview
 assert.ok(stats.activeUsers>=2);assert.ok(stats.completedBattles>=1)
 for(const kind of ['users','battles','analytics']) ok(await api('adminExportReport',{kind,query:{},range}))
})
test('interrupted Auth/RTDB operation recovers only after explicit stopped-worker confirmation',async()=>{
 const id=ids[2], request=requestId(), input={id,input:{name:prefix+' recovered',email:id+'@example.test'},requestId:request}
 const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v)
 const path='adminOperations/'+ids[0]+'/user_update/'+request, now=Date.now(), logId=opId(ids[0],'user.update',request)
 operations.push({actor:ids[0],action:'user.update',requestId:request})
 const previous=ok(await api('adminGetUser',{id})).user
 const entry={actorUid:ids[0],action:'user.update',targetId:id,serverAt:now,reason:'',result:'success'}
 const plan={auth:{uid:id,name:input.input.name},updates:{['users/'+id+'/displayName']:input.input.name,['users/'+id+'/updatedAt']:now,['adminAuditLogs/'+date+'/'+logId]:entry,['adminAuditRecent/'+logId]:entry},result:{serverNow:now,user:{...previous,name:input.input.name,updatedAt:now}}}
 await auth.updateUser(id,{displayName:input.input.name})
 await database.ref(path).set({hash:hash(canonical(input)),createdAt:now,owner:'terminated-fixture-worker',planJson:JSON.stringify(plan)})
 await database.ref('adminLocks/user_'+id).set(path)
 denied(await api('adminSaveUser',input),'ABORTED')
 const script=fileURLToPath(new URL('../tools/recover-admin-operation.mjs',import.meta.url))
 const args=[script,'--uid',ids[0],'--action','user_update','--request-id',request]
 const dry=execFileSync(process.execPath,args,{env:process.env,encoding:'utf8',timeout:30000})
 assert.equal(JSON.parse(dry.trim()).hasPlan,true)
 execFileSync(process.execPath,[...args,'--apply','--worker-stopped','--expected-owner','terminated-fixture-worker'],{env:process.env,stdio:'pipe',timeout:30000})
 assert.equal((await database.ref('adminLocks/user_'+id).get()).val(),path)
 assert.deepEqual(ok(await api('adminSaveUser',input)),plan.result)
 assert.equal((await database.ref('adminLocks/user_'+id).get()).exists(),false)
 assert.deepEqual(ok(await api('adminSaveUser',input)),plan.result)
})
test('bounded snapshots fail explicitly instead of returning a truncated total',async()=>{
 const updates={},paths=[]
 for(let i=0;i<501;i++){const path='users/'+prefix+'_limit_'+i;paths.push(path);updates[path]={createdAt:Date.now(),displayName:'Limit fixture'}}
 try {
   await database.ref().update(updates)
   denied(await api('adminListUsers',{query:{}}),'RESOURCE_EXHAUSTED')
 } finally {await database.ref().update(Object.fromEntries(paths.map(path=>[path,null])))}
})
test('audit backfill dry-run, apply and rollback only touch the selected legacy fixture',async()=>{
 const id=prefix+'_legacy',path='adminAuditLogs/'+date+'/'+id,entry={actorUid:ids[0],action:'fixture.legacy',targetId:ids[2],serverAt:Date.now(),reason:'Fixture only',result:'success'}
 const script=fileURLToPath(new URL('../tools/backfill-admin-audit.mjs',import.meta.url))
 const args=[script,'--from',date,'--to',date,'--entry-id',id]
 const legacyId='legacy_'+hash(JSON.stringify([date,id]))
 try {
   await database.ref(path).set(entry)
   const dry=JSON.parse(execFileSync(process.execPath,args,{env:process.env,encoding:'utf8',timeout:30000}).trim())
   assert.equal(dry.candidates,1);assert.equal(dry.inserted,0)
   const applied=JSON.parse(execFileSync(process.execPath,[...args,'--apply'],{env:process.env,encoding:'utf8',timeout:30000}).trim())
   assert.equal(applied.inserted,1)
   assert.deepEqual((await database.ref(path).get()).val(),entry)
   assert.equal((await database.ref('adminAuditRecent/'+legacyId).get()).exists(),true)
   execFileSync(process.execPath,[script,'--rollback',applied.journal,'--apply'],{env:process.env,stdio:'pipe',timeout:30000})
   assert.equal((await database.ref('adminAuditRecent/'+legacyId).get()).exists(),false)
 } finally {await database.ref().update({[path]:null,['adminAuditRecent/'+legacyId]:null})}
})
test('user editing preserves balances; soft deletion blocks restoration and keeps history',async()=>{
 const id=ids[2], before=ok(await api('adminGetUser',{id})).user
 const payload={id,input:{name:`${prefix} learner`,email:`${id}@example.test`},requestId:requestId()}
 const after=ok(await write('adminSaveUser',payload,'user.update')).user
 assert.equal(after.rating,before.rating);assert.equal(after.coins,before.coins)
 const list=ok(await api('adminListUsers',{query:{q:prefix,pageSize:50}})).page
 assert.ok(list.total>=4)
 for(const status of ['banned','active','deleted']) {
   const p={id,status,reason:'Integration fixture moderation',requestId:requestId()}
   ok(await write('adminSetUserStatus',p,'user.status'))
 }
 const deleted=ok(await api('adminGetUser',{id})).user
 assert.equal(deleted.status,'deleted');assert.equal(deleted.name,'Deleted user');assert.equal(deleted.email,'')
 denied(await write('adminSetUserStatus',{id,status:'active',reason:'Cannot restore deleted',requestId:requestId()},'user.status'),'FAILED_PRECONDITION')
 assert.equal((await database.ref(`wallets/${id}`).get()).val().coinBalance,before.coins)
 assert.equal((await database.ref(`battleRooms/${battleIds[0]}/participants/${id}`).get()).exists(),true)
})
