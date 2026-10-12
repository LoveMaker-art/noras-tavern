const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {randomUUID}=require('node:crypto');
const vm=require('node:vm'),{createRequire}=require('node:module');
const {createLifecycleDiagnostics}=require('../installer/desktop/lifecycle-diagnostics');
function fixture(t,{consent=true,enabled=true,fetcher,now=Date.now}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nora-lifecycle-diagnostic-')));
  const home=path.join(root,'installation'),directory=path.join(root,'diagnostics');
  fs.mkdirSync(path.join(home,'installer'),{recursive:true});
  const consentFile=path.join(home,'installer','telemetry.json');
  const choice={schema:1,consentVersion:3,enabled:consent,diagnosticConsentId:consent?randomUUID():''};
  fs.writeFileSync(consentFile,JSON.stringify(choice));
  const requests=[],codes=[],actors=[];
  const transport=fetcher||(async(url,options)=>{
    const body=JSON.parse(options.body);requests.push({url,body});
    return new Response(JSON.stringify(body.events?{accepted_event_ids:body.events.map(event=>event.event_id),rejected_event_ids:[]}
      :{accepted:true,index:body.index,chunk_id:body.chunk_id}),{status:202});
  });
  const create=()=>{const actor=createLifecycleDiagnostics({directory,launcherVersion:'2.1.3',enabled,fetcher:transport,now,
    roots:()=>[root],diagnostic:code=>codes.push(code)});actors.push(actor);return actor;};
  t.after(async()=>{await Promise.all(actors.map(actor=>actor.close()));fs.rmSync(root,{recursive:true,force:true});});
  return {root,home,directory,choice,consentFile,requests,codes,create,register:actor=>{actors.push(actor);return actor;}};
}
test('startup failure is persisted before send, preserves the GUI consent file and uses a separate producer identity',async t=>{
  const f=fixture(t),actor=f.create(),prior=fs.readFileSync(f.consentFile,'utf8');
  const handle=actor.capture('startup',Object.assign(new Error('cannot open https://private.example/?token=PRIVATE_CANARY'),{code:'EACCES',syscall:'mkdir'}),{home:f.home});
  const base=path.join(f.directory,handle.operationId);
  const state=JSON.parse(fs.readFileSync(path.join(base,'events.json')));
  assert.equal(state.active,null);assert.equal(state.queue.at(-1).status,'failed');assert.equal(state.queue.at(-1).system_code,'EACCES');
  assert.notEqual(state.id,f.choice.diagnosticConsentId);assert.equal(state.queue.every(event=>event.operation_id===handle.operationId),true);
  const receipt=await handle.flush();assert.equal(receipt.phase,'accepted');assert.equal(receipt.logs.complete,true);
  assert.equal(fs.readFileSync(f.consentFile,'utf8'),prior);
  const sent=JSON.stringify(f.requests);assert.doesNotMatch(sent,/private\.example|PRIVATE_CANARY/);assert.match(sent,/lifecycle\.startup-failed/);
});
test('offline failure survives actor restart and only exact event/log ACKs complete delivery',async t=>{
  let offline=true,lostAck=true,time=Date.now();const requests=[];
  const f=fixture(t,{now:()=>time,fetcher:async(url,options)=>{
    const body=JSON.parse(options.body);requests.push(body);if(offline)throw Error('offline');
    if(body.events&&lostAck){lostAck=false;throw Error('ACK lost after receiver acceptance');}
    return new Response(JSON.stringify(body.events?{accepted_event_ids:body.events.map(event=>event.event_id),rejected_event_ids:[]}
      :{accepted:true,index:body.index,chunk_id:body.chunk_id}),{status:202});
  }});
  const actor=f.create(),handle=actor.capture('uninstall',Object.assign(new Error('locked file'),{code:'EPERM'}),{home:f.home});
  assert.equal((await handle.flush()).phase,'queued');const id=handle.operationId;
  const ids=JSON.parse(fs.readFileSync(path.join(f.directory,id,'events.json'))).queue.map(event=>event.event_id);await actor.close();offline=false;time+=400000;
  assert.equal((await f.create().drain())[0].phase,'queued');
  time+=400000;
  assert.equal((await f.create().drain())[0].phase,'accepted');
  assert.deepEqual(requests.filter(body=>body.events).at(-1).events.map(event=>event.event_id),ids);
});
test('HTTP success without exact ACK leaves the failure queued',async t=>{
  const f=fixture(t,{fetcher:async()=>new Response('{}',{status:200})});
  const handle=f.create().capture('startup',new Error('failure'),{home:f.home});
  const receipt=await handle.flush();assert.equal(receipt.phase,'queued');assert.ok(receipt.summary.queued>0);assert.equal(receipt.logs.complete,false);
});
for(const consent of [false,null])test(`diagnostic choice ${consent} sends only basic events and no fault or raw log`,async t=>{
  const f=fixture(t,{consent:false});if(consent===null)fs.rmSync(f.consentFile);
  const handle=f.create().capture('startup',new Error('PRIVATE_FAILURE_DETAIL'),{home:f.home});
  assert.equal((await handle.flush()).phase,'accepted');
  assert.equal(f.requests.length,1);assert.ok(f.requests[0].body.events.every(event=>event.fault===null));
  assert.doesNotMatch(JSON.stringify(f.requests),/PRIVATE_FAILURE_DETAIL/);
});
test('revoking consent strips a deferred fault and raw logs before replay',async t=>{
  const f=fixture(t),actor=f.create(),handle=actor.capture('uninstall',new Error('PRIVATE_FAILURE_DETAIL'),{home:f.home});actor.close();
  fs.writeFileSync(f.consentFile,JSON.stringify({...f.choice,enabled:false,diagnosticConsentId:''}));
  assert.equal((await f.create().drain())[0].phase,'accepted');
  assert.equal(f.requests.length,1);assert.ok(f.requests[0].body.events.every(event=>event.fault===null));
});
test('a later opt-in cannot add fault details to an earlier unconsented failure',async t=>{
  const f=fixture(t,{consent:false}),actor=f.create();actor.capture('startup',new Error('PRIVATE_FAILURE_DETAIL'),{home:f.home});actor.close();
  fs.writeFileSync(f.consentFile,JSON.stringify({...f.choice,enabled:true,diagnosticConsentId:randomUUID()}));
  assert.equal((await f.create().drain())[0].phase,'accepted');assert.equal(f.requests.length,1);
  assert.ok(f.requests[0].body.events.every(event=>event.fault===null));
});
test('the live ALL worker may retain pre-cleanup consent; later replay cannot assume it',async t=>{
  const f=fixture(t),actor=f.create(),record=actor.prepare({home:f.home});
  fs.rmSync(path.join(f.home,'installer'),{recursive:true});
  const handle=record('uninstall',Object.assign(new Error('application removal failed'),{code:'EACCES'}),{consentRemoved:true});
  assert.equal((await handle.flush()).phase,'accepted');assert.ok(f.requests.some(request=>!request.body.events));
  const f2=fixture(t),actor2=f2.create(),record2=actor2.prepare({home:f2.home});fs.rmSync(path.join(f2.home,'installer'),{recursive:true});
  record2('uninstall',new Error('offline failure'),{consentRemoved:true});actor2.close();
  assert.equal((await f2.create().drain())[0].phase,'accepted');assert.equal(f2.requests.length,1);
  assert.ok(f2.requests[0].body.events.every(event=>event.fault===null));
});
test('a current explicit opt-out overrides the live ALL worker snapshot',async t=>{
  const f=fixture(t),actor=f.create(),record=actor.prepare({home:f.home});
  fs.writeFileSync(f.consentFile,JSON.stringify({...f.choice,enabled:false,diagnosticConsentId:''}));
  const handle=record('uninstall',new Error('failure'),{consentRemoved:true});await handle.flush();
  assert.equal(f.requests.length,1);assert.ok(f.requests[0].body.events.every(event=>event.fault===null));
});
test('an unreadable consent file is never treated as confirmed ALL removal',async t=>{
  const f=fixture(t),file=path.resolve(__dirname,'../installer/desktop/lifecycle-diagnostics.js'),localRequire=createRequire(file);let denied=false;
  const adapter={...fs,lstatSync:(name,...args)=>{if(denied&&name===f.consentFile)throw Object.assign(new Error('permission denied'),{code:'EACCES'});return fs.lstatSync(name,...args);},
    existsSync:name=>denied&&name===f.consentFile?false:fs.existsSync(name)};
  const context=vm.createContext({require:name=>name==='node:fs'?adapter:localRequire(name),module:{exports:{}},process,AbortSignal});
  vm.runInContext(fs.readFileSync(file,'utf8'),context);
  const actor=f.register(context.module.exports.createLifecycleDiagnostics({directory:f.directory,launcherVersion:'2.1.3',enabled:true,
    fetcher:async(_url,options)=>{const body=JSON.parse(options.body);f.requests.push(body);
      return new Response(JSON.stringify({accepted_event_ids:body.events.map(event=>event.event_id),rejected_event_ids:[]}),{status:202});}}));
  const record=actor.prepare({home:f.home});denied=true;
  assert.equal((await record('uninstall',new Error('PRIVATE_FAILURE_DETAIL'),{consentRemoved:true}).flush()).phase,'accepted');
  assert.equal(f.requests.length,1);assert.ok(f.requests[0].events.every(event=>event.fault===null));
});
test('an active native writer prevents another actor from replaying the same failure',async t=>{
  const f=fixture(t),actor=f.create(),handle=actor.capture('startup',new Error('failure'),{home:f.home});
  assert.deepEqual(await f.create().drain(),[]);assert.ok(f.codes.includes('outbox_busy'));handle.close();
  assert.equal((await f.create().drain())[0].phase,'accepted');
});
test('modified queue operation identity is rejected without sending or rewriting its evidence',async t=>{
  const f=fixture(t),actor=f.create(),handle=actor.capture('startup',new Error('failure'),{home:f.home});actor.close();
  const file=path.join(f.directory,handle.operationId,'events.json'),value=JSON.parse(fs.readFileSync(file));value.queue[0].operation_id=randomUUID();
  fs.writeFileSync(file,JSON.stringify(value));const prior=fs.readFileSync(file,'utf8');
  assert.deepEqual(await f.create().drain(),[]);assert.equal(f.requests.length,0);assert.equal(fs.readFileSync(file,'utf8'),prior);
});
test('a linked store or a store inside the uninstall root is rejected before writing',t=>{
  const f=fixture(t),outside=path.join(f.root,'outside');fs.mkdirSync(outside);fs.symlinkSync(outside,f.directory,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>f.create().capture('uninstall',new Error('failure'),{home:f.home}),/链接/);assert.deepEqual(fs.readdirSync(outside),[]);
  const actor=createLifecycleDiagnostics({directory:path.join(f.home,'bad-diagnostics'),enabled:true,launcherVersion:'2.1.3'});
  assert.throws(()=>actor.capture('uninstall',new Error('failure'),{home:f.home}),/待卸载/);assert.equal(fs.existsSync(actor.directory),false);actor.close();
});
test('disabled test or development reporting leaves no outbox or requests',async t=>{
  const f=fixture(t,{enabled:false}),actor=f.create();assert.equal(actor.capture('startup',new Error('failure'),{home:f.home}),null);
  assert.deepEqual(await actor.drain(),[]);assert.equal(fs.existsSync(f.directory),false);assert.equal(f.requests.length,0);
});
test('bounded delivery aborts both event and raw log requests and keeps original failure queued',async t=>{
  const keepAlive=setInterval(()=>{},1000);t.after(()=>clearInterval(keepAlive));
  const f=fixture(t,{fetcher:async(_url,{signal})=>new Promise((_resolve,reject)=>{
    const abort=()=>reject(signal.reason);if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
  })});
  const start=Date.now(),handle=f.create().capture('uninstall',Object.assign(new Error('delete failed'),{code:'EACCES'}),{home:f.home,budgetMs:80});
  const result=await handle.flush();assert.equal(result.phase,'queued');assert.ok(Date.now()-start<1000);assert.ok(result.summary.queued>0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory,handle.operationId,'events.json'))).queue.at(-1).system_code,'EACCES');
});
test('retention retires only known old diagnostic files while keeping native lock identity',t=>{
  let time=Date.now();const f=fixture(t,{now:()=>time}),actor=f.create(),old=actor.capture('startup',new Error('old'),{home:f.home});old.close();
  const base=path.join(f.directory,old.operationId),lock=path.join(base,'operations','.writer.lock'),identity=fs.statSync(lock).ino;
  time+=8*86400000;actor.capture('startup',new Error('new'),{home:f.home});
  assert.equal(fs.existsSync(path.join(base,'job.json')),false);assert.equal(fs.statSync(lock).ino,identity);
});
test('partial acceptance plus expired events cannot be reported as fully received',async t=>{
  const f=fixture(t,{consent:false}),actor=f.create(),handle=actor.capture('startup',new Error('failure'),{home:f.home});await actor.close();
  const file=path.join(f.directory,handle.operationId,'events.json'),state=JSON.parse(fs.readFileSync(file));
  state.delivery[handle.operationId].accepted=1;state.delivery[handle.operationId].expired=state.queue.length-1;
  state.delivery[handle.operationId].missing=['expired'];state.queue=[];fs.writeFileSync(file,JSON.stringify(state));
  assert.equal((await f.create().drain())[0].phase,'queued');assert.equal(f.requests.length,0);
});
test('closing a sender holds its native lease until aborted writes settle',async t=>{
  let blocked=true;const pending=[];const f=fixture(t,{fetcher:async()=>{if(!blocked)throw Error('offline');return new Promise((_resolve,reject)=>pending.push(reject));}});
  const actor=f.create(),handle=actor.capture('startup',new Error('failure'),{home:f.home});
  const work=handle.flush(),closing=handle.close();
  try{assert.deepEqual(await f.create().drain(),[]);assert.ok(f.codes.includes('outbox_busy'));}
  finally{for(const reject of pending)reject(new Error('fixture aborted'));await work;await closing;}
  blocked=false;assert.equal((await f.create().drain())[0].phase,'queued','transport failure still owns its pending evidence');
});
