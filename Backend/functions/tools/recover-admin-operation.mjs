import {assertEmulators,connectLocalFirebase} from '../../server/tools/local-config.mjs'
import {deleteApp} from '../../server/node_modules/firebase-admin/lib/app/index.js'
const args=process.argv.slice(2), value=flag=>args[args.indexOf(flag)+1]
const uid=value('--uid'),action=value('--action'),requestId=value('--request-id')
if(![uid,action,requestId].every(v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v))) throw new Error('Supply --uid --action (dots encoded as _) --request-id with safe keys')
await assertEmulators()
const {app,database}=connectLocalFirebase()
try {
 const path=`adminOperations/${uid}/${action}/${requestId}`,ref=database.ref(path),op=(await ref.get()).val()
 if(!op||op.resultJson) throw new Error('Only a pending operation can be recovered')
 const locks=await database.ref('adminLocks').orderByKey().limitToFirst(1001).get()
 if(locks.numChildren()>1000) throw new Error('Lock inspection limit exceeded')
 const owned=[];locks.forEach(s=>{if(s.val()===path)owned.push(s.key)})
 console.log(JSON.stringify({mode:args.includes('--apply')?'apply':'dry-run',path,owner:op.owner||null,hasPlan:typeof op.planJson==='string',locks:owned}))
 if(args.includes('--apply')) {
   if(!args.includes('--worker-stopped')||!args.includes('--expected-owner')||value('--expected-owner')!==(op.owner||'none')) throw new Error('Confirm worker termination with --worker-stopped and supply --expected-owner from dry-run; never unlock a live worker')
   // Transact only the scalar owner. A cold null value must reach the server,
   // otherwise the SDK can abort before loading the actual owner.
   const tx=await ref.child('owner').transaction(current=>current===null||current===op.owner?null:undefined)
   if(!tx.committed)throw new Error('Operation changed; no recovery applied')
   console.log('Execution owner cleared; target locks retained. Retry original requestId and original payload.')
 }
} finally {await deleteApp(app)}
