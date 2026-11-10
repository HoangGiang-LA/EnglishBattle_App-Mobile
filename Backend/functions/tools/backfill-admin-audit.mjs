import {assertEmulators,connectLocalFirebase} from '../../server/tools/local-config.mjs'
import {deleteApp} from '../../server/node_modules/firebase-admin/lib/app/index.js'
import {createHash,randomUUID} from 'node:crypto'
import {mkdir,writeFile,readFile} from 'node:fs/promises'
import {resolve,relative,isAbsolute} from 'node:path'
import {fileURLToPath} from 'node:url'
const args=process.argv.slice(2),value=flag=>args[args.indexOf(flag)+1]
const repository=resolve(fileURLToPath(new URL('../../..',import.meta.url)))
const journalRoot=resolve(repository,'.local/admin-audit-backfill')
const stable=v=>Array.isArray(v)?'['+v.map(stable).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}':JSON.stringify(v)
const hash=v=>createHash('sha256').update(stable(v)).digest('hex')
await assertEmulators()
const {app,database}=connectLocalFirebase()
try {
 if(args.includes('--rollback')) {
   const journalPath=resolve(value('--rollback')),rel=relative(journalRoot,journalPath)
   if(!rel||rel.startsWith('..')||isAbsolute(rel)) throw new Error('Journal must be inside .local/admin-audit-backfill')
   const journal=JSON.parse(await readFile(journalPath,'utf8'))
   if(!Array.isArray(journal.inserted)||journal.inserted.length>31000)throw new Error('Invalid journal')
   for(const row of journal.inserted) {
     if(!/^legacy_[a-f0-9]{64}$/.test(row.id))throw new Error('Unsafe journal id')
     if(args.includes('--apply')) {
       const ref=database.ref('adminAuditRecent/'+row.id);await ref.get()
       await ref.transaction(v=>v===null?null:hash(v)===row.hash?null:undefined)
     }
   }
   console.log(JSON.stringify({mode:args.includes('--apply')?'rollback':'rollback-dry-run',count:journal.inserted.length}))
 } else {
   const from=value('--from'),to=value('--to')
   if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to))throw new Error('Supply --from and --to YYYY-MM-DD')
   const start=Date.parse(from),end=Date.parse(to)
   if(!Number.isFinite(start)||!Number.isFinite(end)||end<start||end-start>30*86400000||new Date(start).toISOString().slice(0,10)!==from||new Date(end).toISOString().slice(0,10)!==to)throw new Error('Backfill scope must be 1-31 valid days')
   const entry=args.includes('--entry-id')?value('--entry-id'):null
   if(entry&&!/^[A-Za-z0-9_-]{1,128}$/.test(entry))throw new Error('Unsafe entry id')
   let inspected=0,candidates=0
   const inserted=[]
   // Journal each committed row immediately; never overwrite an existing projection.
   await mkdir(journalRoot,{recursive:true})
   const batchId=randomUUID(), journalPath=resolve(journalRoot,batchId+'.json')
   for(let at=start;at<=end;at+=86400000) {
     const day=new Date(at).toISOString().slice(0,10),base=database.ref('adminAuditLogs/'+day)
     const snap=entry?await base.child(entry).get():await base.orderByKey().limitToFirst(1001).get()
     if(!entry&&snap.numChildren()>1000)throw new Error('Day exceeds 1000 logs; narrow scope with --entry-id')
     const rows=entry?(snap.exists()?[[entry,snap.val()]]:[]):Object.entries(snap.val()||{})
     for(const [id,row] of rows) {
       inspected++
       if(typeof row.actorUid!=='string'||typeof row.action!=='string'||typeof row.targetId!=='string'||!Number.isFinite(row.serverAt)||!['success','failure'].includes(row.result))throw new Error('Unsupported legacy audit schema')
       const projected={backfillOwner:batchId,actorUid:row.actorUid,action:row.action,targetId:row.targetId,serverAt:row.serverAt,reason:typeof row.reason==='string'?row.reason:'',result:row.result}
       const targetId='legacy_'+hash([day,id]),ref=database.ref('adminAuditRecent/'+targetId)
       if((await ref.get()).exists())continue
       candidates++
       if(args.includes('--apply')) {
         inserted.push({id:targetId,hash:hash(projected)})
         await writeFile(journalPath,JSON.stringify({inserted},null,2))
         const tx=await ref.transaction(v=>v===null?projected:undefined)
         if(!tx.committed){inserted.pop();await writeFile(journalPath,JSON.stringify({inserted},null,2))}
       }
     }
   }
   console.log(JSON.stringify({mode:args.includes('--apply')?'apply':'dry-run',inspected,candidates,inserted:inserted.length,journal:inserted.length?journalPath:null}))
 }
} finally {await deleteApp(app)}
