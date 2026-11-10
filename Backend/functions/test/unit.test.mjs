import {test} from 'node:test'
import assert from 'node:assert/strict'
process.env.GCLOUD_PROJECT='demo-englishbattle'
process.env.FIREBASE_DATABASE_EMULATOR_HOST='127.0.0.1:9000'
process.env.FIREBASE_AUTH_EMULATOR_HOST='127.0.0.1:9099'
const {fingerprint,key,integer}=await import('../lib/admin/core.js')
const {query,range,paginate}=await import('../lib/admin/validation.js')
const {questionInput}=await import('../lib/admin/content.js')
const {csvCell}=await import('../lib/admin/reports.js')
test('operation fingerprints ignore object key order and bind payload changes',()=>{
 assert.equal(fingerprint({b:2,a:{c:3}}),fingerprint({a:{c:3},b:2}))
 assert.notEqual(fingerprint({a:1}),fingerprint({a:2}))
})
test('rejects unsafe keys, oversized pages and invalid calendar days',()=>{
 for(const id of ['../x','a/b','x.y','a#b','']) assert.throws(()=>key(id))
 for(const v of [0,1.5,-1,51]) assert.throws(()=>integer(v,'size',1,50))
 assert.throws(()=>query({pageSize:51}))
 assert.throws(()=>query({role:'admin'}))
 assert.throws(()=>range({from:'2026-02-30',to:'2026-03-01'}))
 assert.throws(()=>range({from:'2026-01-01',to:'2026-12-31'}))
 const r=range({from:'2026-11-01',to:'2026-11-01'})
 assert.equal(r.end-r.start,86400000)
 assert.equal(new Date(r.start).toISOString(),'2026-10-31T17:00:00.000Z')
})
test('pagination retains exact total even on an empty later page',()=>{
 assert.deepEqual(paginate([1,2,3],{page:3,pageSize:2}),{items:[],total:3,page:3,pageSize:2})
})
test('CSV formula mitigation catches whitespace and formula prefixes',()=>{
 for(const s of ['=SUM(1,2)',' +1','@abc','-2','\t=CMD()']) assert.equal(csvCell(s),"'"+s)
 assert.equal(csvCell('normal'),'normal')
})
test('question validation rejects extra privilege fields and answer/options mismatch',()=>{
 const f={categoryId:'vocabulary',topicId:'vocabulary_daily_life',lessonId:'',prompt:'Question fixture?',options:[1,2,3,4].map(i=>({id:'opt_'+i,text:'Answer '+i})),correctOptionId:'opt_1',explanation:'',passage:'',audioUrl:'',audioText:'',difficulty:'easy',status:'draft'}
 assert.equal(questionInput(f).options.length,4)
 for(const change of [{role:'admin'},{correctOptionId:'outside'},{options:f.options.slice(0,3)},{audioUrl:'http://unsafe'},{status:'published'}]) assert.throws(()=>questionInput({...f,...change}))
})
