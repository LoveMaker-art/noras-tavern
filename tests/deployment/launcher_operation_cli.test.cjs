const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {randomUUID}=require('node:crypto');
const cli=require('../installer/desktop/operation-cli');
const {createTestOperationLock}=require('./launcher_operation_test_lock.cjs');

function fixture(t){
  const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nora-operation-cli-')));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const bridge=path.join(home,'app/resources/launcher_bridge.py');
  const receipt={noraHome:home,hermesHome:path.join(home,'hermes'),installRoot:path.join(home,'tavern'),installerDirectory:path.join(home,'installer'),
    resourcesRoot:path.join(home,'app/resources'),platform:process.platform,arch:process.arch,port:8799,channel:'stable',launcherVersion:'2.0.2',
    resources:{'launcher_bridge.py':{path:bridge},'first_install.py':{path:path.join(home,'app/resources/first_install.py')}},managed:{}};
  const request=(action,extra=[])=>({schema:'nora-cli-request/1',kind:action,argv:[bridge,'--nora-home',home,action,...extra],stdin:''});
  const lock=createTestOperationLock();
  return {home,receipt,request,lock};
}

function updateResultFixture(t,{kind='repair',entry='bridge',resultChanges={},statusChanges={},beforeChanges={},failure,recover=false,
  prepareEffects,observed={effectState:'changed',recoveryOutcome:'not-required',canResume:true}}={}){
  const f=fixture(t),crypto=require('node:crypto'),vm=require('node:vm'),{createRequire}=require('node:module');
  f.receipt.launcherVersion='2.1.2';
  const commit='a'.repeat(40),version='2.4.5',sha=value=>crypto.createHash('sha256').update(value).digest('hex');
  const manifest={schema:'tavern-release/v2',commit,versions:{tavern:version},launcherVersion:'2.1.2',
    launcherCapabilities:{operationSchema:'nora-operation/1',executorProtocol:'nora-operation-executor/1',telemetrySchema:3,faultSchema:2},
    bootstrap:{managedComponents:1,minimumLauncherVersion:'2.1.2',sha256:sha('bootstrap')}};
  const local=path.join(f.home,'release');fs.mkdirSync(local);
  const bytes={'release-manifest.json':JSON.stringify(manifest),'tavern-updater-bootstrap.py':'bootstrap'};
  bytes.SHA256SUMS=Object.entries(bytes).map(([name,value])=>`${sha(value)}  ${name}`).join('\n');
  for(const [name,value] of Object.entries(bytes))fs.writeFileSync(path.join(local,name),value);
  f.receipt.resources['bootstrap.py']={path:path.join(f.receipt.resourcesRoot,'bootstrap.py')};
  f.receipt.managed['ops/updater/bootstrap.py']={path:path.join(f.home,'tavern/apps/tavern-ops/updater/bootstrap.py')};
  const request=entry==='bridge'?f.request(kind,['--release-dir',local]):{schema:'nora-cli-request/1',kind,
    argv:[f.receipt.managed['ops/updater/bootstrap.py'].path,'--nora-home',f.home,'--apply','--confirm',...(kind==='repair'?['--repair']:[]),'--release-dir',local],stdin:''};
  const final={version,commit,systemReady:true,running:false,gatewayRunning:false,clawchatConnected:false,port:f.receipt.port,noraHome:f.home,
    hermesHome:f.receipt.hermesHome,installRoot:f.receipt.installRoot};
  const actual={...final,updateVerified:true,...resultChanges},post={...final,...statusChanges};let applied=false;
  const run=async(_context,target,args)=>{
    if(target===f.receipt.resources['launcher_bridge.py'].path){
      const command=args[8];
      if(command==='status')return applied?post:{...final,version:'2.4.4',commit:'b'.repeat(40),...beforeChanges};
      if(command==='plan-update')return {version,archives:[]};
      if(command!=='update')throw new Error(`Unexpected bridge command: ${command}`);
    }
    applied=true;if(failure)throw Object.assign(new Error('Actual maintenance failed'),{code:failure});return actual;
  };
  const file=path.resolve(__dirname,'../installer/desktop/uninstall.js'),context=vm.createContext({
    require:createRequire(file),__filename:file,__dirname:path.dirname(file),module:{exports:{}},process,Buffer,console,setTimeout,clearTimeout,setInterval,clearInterval});
  vm.runInContext(fs.readFileSync(file,'utf8'),context);
  const completed=record=>context.completedSystemOperation(record);
  return {...f,actual,post,completed,request,local,get applied(){return applied;},execute:()=>cli.execute({receiptPath:'fixture',request},{validate:async()=>f.receipt,
    lock:f.lock,telemetry:false,run,policy:{observe:async()=>applied?observed:{effectState:'untouched',recoveryOutcome:'not-required'},
      ...(prepareEffects?{prepareEffects:context=>prepareEffects(context,{applied,receipt:f.receipt})}:{}),
      recover:async()=>recover?{verification:'confirmed',value:{updateRecovered:true,recoveryVerification:'confirmed'}}
        :Promise.reject(Object.assign(new Error('Recovery has no completion proof'),{code:'UPDATE_RECOVERY_REQUIRED'}))}})};
}

for(const entry of ['bridge','bootstrap'])for(const kind of ['update','repair'])test(`CLI ${entry} ${kind} preserves actual acceptance for the unchanged uninstall completion consumer`,async t=>{
  const f=updateResultFixture(t,{kind,entry}),operation=await f.execute();
  assert.equal(operation.state,'succeeded');assert.equal(operation.verification,'confirmed');
  assert.deepEqual(operation.result,f.actual,'CLI must retain the same actual executor result consumed by the GUI');
  assert.equal(operation.result.updateVerified,f.actual.updateVerified);
  assert.equal(operation.result.commit,f.actual.commit);assert.equal(operation.result.version,f.post.version);
  const persisted=JSON.parse(fs.readFileSync(path.join(f.receipt.installerDirectory,'operations',operation.operationId,'operation.json')));
  assert.equal(f.completed(persisted),true,'the real persisted result must satisfy the frozen uninstall consumer');
  assert.deepEqual(persisted.result,operation.result);
});

for(const [name,options] of [
  ['readiness cannot create a missing backend acceptance',{resultChanges:{updateVerified:undefined},statusChanges:{updateVerified:true}}],
  ['a failed runner cannot become completed',{failure:'EPIPE'}],
  ['a recovered runner remains rolled back',{failure:'EPIPE',recover:true}],
  ['backend version belongs to another target',{resultChanges:{version:'2.4.4'},entry:'bootstrap'}],
  ['backend commit belongs to another target',{resultChanges:{commit:'c'.repeat(40)}}],
  ['post-status commit changed',{statusChanges:{commit:'c'.repeat(40)}}],
  ['post-status installation changed',{statusChanges:{installRoot:'/another-owned-installation'}}],
  ['backend services disagree with verified status',{resultChanges:{running:true}}],
  ['backend readiness remains unconfirmed',{resultChanges:{systemReady:false},entry:'bootstrap'}],
  ['backend installation binding is absent',{resultChanges:{noraHome:undefined}}],
  ['post-status installation binding is absent',{statusChanges:{hermesHome:undefined}}],
  ['post-status port drifted',{statusChanges:{port:8800}}],
  ['backend port belongs to another instance',{resultChanges:{port:8800}}],
  ['ClawChat connection changed after acceptance',{resultChanges:{clawchatConnected:true}}],
  ['the original connected ClawChat was not restored',{beforeChanges:{clawchatConnected:true}}],
  ['canonical transaction effects remain unknown',{observed:{effectState:'unknown',recoveryOutcome:'recovery-required'}}],
  ['canonical transaction still needs recovery',{observed:{effectState:'changed',recoveryOutcome:'recovery-required',canResume:true}}],
  ['canonical transaction was restored',{observed:{effectState:'restored',recoveryOutcome:'restored-and-verified'}}],
  ['canonical transaction lacks committed continuation',{observed:{effectState:'changed',recoveryOutcome:'not-required',canResume:false}}],
])test(`CLI update completion refuses ${name}`,async t=>{
  const f=updateResultFixture(t,options),operation=await f.execute();
  assert.notEqual(operation.state,'succeeded');assert.equal(f.completed(operation),false);
  assert.equal(f.completed(JSON.parse(fs.readFileSync(path.join(f.receipt.installerDirectory,'operations',operation.operationId,'operation.json')))),false);
});

test('CLI retains a verified connected ClawChat and accepts older executor results without optional port or connection fields',async t=>{
  for(const options of [{beforeChanges:{clawchatConnected:true},resultChanges:{clawchatConnected:true},statusChanges:{clawchatConnected:true}},
    {resultChanges:{port:undefined,clawchatConnected:undefined},statusChanges:{port:undefined,clawchatConnected:undefined}}]){
    const f=updateResultFixture(t,options),result=await f.execute();assert.equal(result.state,'succeeded');
    assert.equal(f.completed(JSON.parse(fs.readFileSync(path.join(f.receipt.installerDirectory,'operations',result.operationId,'operation.json')))),true);
  }
});

test('CLI runs the existing closure producer with its sealed plan under the writer before applying; rejection is not swallowed',async t=>{
  for(const reject of [false,true]){
    let calls=0;
    const f=updateResultFixture(t,{prepareEffects:async(context,{applied,receipt})=>{
      calls++;assert.equal(applied,false);
      assert.equal(JSON.parse(fs.readFileSync(path.join(receipt.installerDirectory,'operations',context.operationId,'operation.json'))).planSelected,true);
      assert.equal(context.target.releasePlan.schema,'nora-release-plan/1');
      assert.equal((await f.lock.probe({directory:receipt.installerDirectory})).busy,true);
      if(reject)throw Object.assign(new Error('Unconfirmed predecessor closure'),{code:'UPDATE_RECOVERY_REQUIRED'});
      // This adapter test does not create physical predecessor evidence.
    }}),result=await f.execute();
    assert.equal(calls,1);assert.equal(f.applied,!reject);
    assert.equal(result.state,reject?'failed':'succeeded');
    if(reject)assert.equal(result.primaryFailure.code,'UPDATE_RECOVERY_REQUIRED');
  }
});

test('CLI committed continuation binds the real sealed release commit even when the returned version matches',async t=>{
  const {createOperationController}=require('../installer/desktop/operation-state'),releases=require('../installer/desktop/releases');
  for(const changed of [false,true]){
    const f=updateResultFixture(t,{kind:'update'}),controller=createOperationController({directory:f.receipt.installerDirectory,lock:f.lock});
    const failed=await controller.start('update',{target:{request:{action:'update',port:f.receipt.port}},execute:async context=>{
      const options={launcherVersion:f.receipt.launcherVersion,platform:f.receipt.platform,arch:f.receipt.arch,channel:'stable',mode:'update',
        operationDirectory:path.join(f.receipt.installerDirectory,'operations',context.operationId),fetcher:require('../installer/desktop/local-release').createLocalRelease(f.local)};
      await context.plan({request:{action:'update',port:f.receipt.port},releasePlan:releases.sealPlan(await releases.selectPlan(options),{...options,assertOwner:()=>context.check()}),currentVersion:'2.4.4'});
      await context.stage('prepared');await context.effect('changed');throw Object.assign(new Error('Interrupted committed operation'),{code:'EPIPE'});
    }},randomUUID());
    assert.equal(failed.target.releasePlan.manifestRef.schema,'nora-operation-manifest/1');
    const calls=[],continued={...f.actual,operationVerified:true,...(changed?{commit:'c'.repeat(40)}:{})};
    const result=await cli.execute({receiptPath:'fixture',request:{...f.request,operationId:failed.operationId,snapshotSequence:failed.snapshotSequence}},
      {validate:async()=>f.receipt,lock:f.lock,telemetry:false,policy:{observe:async()=>({effectState:'changed',recoveryOutcome:'not-required',canResume:true}),
        recover:async()=>{throw Object.assign(new Error('No synthetic recovery proof'),{code:'UPDATE_RECOVERY_REQUIRED'});}},run:async(_context,_target,args)=>{
        calls.push(args[8]);if(args[8]==='operation-effects')return {effects:{operationId:failed.operationId,status:'committed',canResume:true}};
        if(args[8]==='resume-committed-update')return continued;if(args[8]==='status')return continued;
        throw new Error('A committed continuation cannot select or apply again');
      },fetcher:async()=>{throw new Error('A committed continuation cannot query latest');}});
    assert.equal(result.operationId,failed.operationId);assert.equal(calls.includes('update'),false);
    if(changed){assert.notEqual(result.state,'succeeded');assert.equal(result.primaryFailure.code,'EPIPE');assert.equal(result.currentFailure.code,'VERIFICATION_FAILED');}
    else{assert.equal(result.state,'succeeded');assert.equal(result.result.commit,failed.target.releasePlan.commit);}
  }
});

test('independent CLI version failure leaves readable request and HTTP evidence in the operation log without applying changes',async t=>{
  const f=fixture(t);let writes=0;
  const operation=await cli.execute({receiptPath:'fixture',request:f.request('update')},{validate:async()=>f.receipt,lock:f.lock,telemetry:false,
    policy:{observe:async()=>({effectState:'untouched'})},
    run:async(_context,_target,_args,{readonly})=>{if(!readonly)writes++;return {version:'2.4.1',systemReady:true,running:false,gatewayRunning:false};},
    fetcher:async()=>new Response('forbidden',{status:403})});
  assert.equal(operation.state,'failed');assert.equal(writes,0);
  const log=require('../installer/desktop/diagnostics').createDiagnostics({primary:()=>path.join(f.receipt.installerDirectory,'install.log')}).readOperation(operation.operationId);
  const text=log.records.map(item=>item.text).join('\n');
  assert.match(text,/请求 https:\/\/api.github.com\/repos\/LoveMaker-art\/noras-tavern\/releases\/latest/);
  assert.match(text,/HTTP 403/);
});

test('CLI terminal success requires the requested outcome and preserves the original failure after rollback',()=>{
  const primaryFailure={code:'EPIPE',guidance:{title:'原更新中断。'}};
  const cases=[
    [{kind:'install',state:'succeeded',verification:'confirmed',primaryFailure},true],
    [{kind:'recover',state:'rolled-back',verification:'failed',primaryFailure:null},false],
    [{kind:'update',state:'rolled-back',verification:'confirmed',primaryFailure},false],
    [{kind:'install',state:'rolled-back',verification:'confirmed',primaryFailure},false],
    [{kind:'recover',state:'rolled-back',verification:'confirmed',primaryFailure:null},true],
    [{kind:'recover',state:'rolled-back',verification:'confirmed',primaryFailure},false],
    [{kind:'update',requestedAction:'recover',state:'rolled-back',verification:'confirmed',primaryFailure},true],
    [{kind:'install',requestedAction:'recover',state:'rolled-back',verification:'confirmed',primaryFailure},true],
    [{kind:'update',requestedAction:'update',state:'rolled-back',verification:'confirmed',primaryFailure},false],
    [{kind:'install',requestedAction:'recover',state:'rolled-back',verification:'failed',primaryFailure},false],
  ];
  for(const [operation,ok] of cases){
    const result=cli.terminalResult(operation);
    assert.equal(result.event,'result');assert.equal(result.ok,ok);
    assert.equal(result.operation,operation);assert.equal(result.operation.primaryFailure,operation.primaryFailure);
  }
});

test('bounded outbox scans rotate past older empty history instead of starving later pending events',async t=>{
  const f=fixture(t),root=path.join(f.receipt.installerDirectory,'operations');
  for(let index=0;index<512;index++)fs.mkdirSync(path.join(root,`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`),{recursive:true});
  const id='ffffffff-ffff-4fff-8fff-ffffffffffff',file=path.join(root,id,'telemetry.json');
  const {createTelemetry}=require('../installer/desktop/telemetry');
  const telemetry=createTelemetry({file,launcherVersion:'2.0.2',automatic:false});telemetry.begin('start',{operationId:id});telemetry.finish('succeeded');telemetry.close();
  let calls=0;const options={noraHome:f.home,launcherVersion:'2.0.2',lock:f.lock,fetcher:async(_url,request)=>{
    calls++;return Response.json({accepted_event_ids:JSON.parse(request.body).events.map(event=>event.event_id),rejected_event_ids:[]});}};
  assert.deepEqual(await cli.drainOperationOutboxes(options),[]);assert.equal(calls,0);
  const next=await cli.drainOperationOutboxes(options);assert.equal(next.length,1);assert.equal(next[0].operationId,id);
  assert.ok(next[0].summary.accepted>0);assert.equal(next[0].summary.queued,0);
  assert.equal(fs.readdirSync(root).filter(name=>/^[a-f0-9-]{36}$/i.test(name)).length,513);
  const log=path.join(f.receipt.installerDirectory,'install.log');
  assert.doesNotMatch(fs.existsSync(log)?fs.readFileSync(log,'utf8'):'',/cli\.outbox-deferred|ENOENT/);
});

test('CLI routes only typed commands and refuses conflicting installation roots or unknown flags',t=>{
  const f=fixture(t);
  assert.deepEqual(cli.routeRequest(f.receipt,f.request('start',['--service','tavern'])).request,{action:'start',port:8799,service:'tavern'});
  assert.throws(()=>cli.routeRequest(f.receipt,f.request('start',['--install-root',path.join(f.home,'other')])),{code:'CONDITIONS_CHANGED'});
  assert.throws(()=>cli.routeRequest(f.receipt,f.request('start',['--eval','arbitrary'])),{code:'OPERATION_ENTRY_UNSUPPORTED'});
  assert.throws(()=>cli.routeRequest(f.receipt,{...f.request('start'),kind:'update'}),{code:'OPERATION_ENTRY_UNSUPPORTED'});
});

test('exit success without real workflow facts remains failed, and no raw argv/stdin is persisted',async t=>{
  const f=fixture(t),secret='private-pair-secret';
  const request=f.request('pair');request.stdin=Buffer.from(JSON.stringify({code:secret})).toString('base64');
  const operation=await cli.execute({receiptPath:'fixture',request},{validate:async()=>f.receipt,lock:f.lock,
    policy:{observe:async()=>({effectState:'untouched'}),recover:async()=>{throw new Error('not supported');}},
    run:async()=>({}),telemetry:false});
  assert.equal(operation.state,'failed');assert.equal(operation.failureCode,'VERIFICATION_FAILED');
  const bytes=fs.readFileSync(path.join(f.receipt.installerDirectory,'operations',operation.operationId,'operation.json'),'utf8');
  assert.equal(bytes.includes(secret),false);assert.equal(bytes.includes('argv'),false);assert.equal(bytes.includes('stdin'),false);
});

test('successful start requires observed running service state, not only a result message',async t=>{
  const f=fixture(t);
  const operation=await cli.execute({receiptPath:'fixture',request:f.request('start',['--service','tavern'])},{validate:async()=>f.receipt,
    lock:f.lock,policy:{observe:async()=>({effectState:'untouched'})},run:async(_context,_target,_args,{readonly})=>readonly?{running:true,gatewayRunning:false,systemReady:true}:{ok:true},telemetry:false});
  assert.equal(operation.state,'succeeded');assert.equal(operation.verification,'confirmed');
});

test('first-start setup blockers retain typed guidance and never offer blind retry after reopening',async t=>{
  const {failureResult}=require('../installer/desktop/operation-result');
  for(const [code,message,expected] of [['MODEL_SETUP_REQUIRED','请先配置并测试模型。',/配置.*验证.*模型/],
    ['CLAWCHAT_PAIR_REQUIRED','请先连接 ClawChat。',/连接 ClawChat/]]){
    const f=fixture(t);
    const operation=await cli.execute({receiptPath:'fixture',request:f.request('start',['--service','nora'])},
      {validate:async()=>f.receipt,lock:f.lock,telemetry:false,policy:{observe:async()=>({effectState:'untouched'})},
        run:async(_context,_target,_args,{readonly})=>{if(readonly)return {running:false,gatewayRunning:false};
          throw Object.assign(new Error(message),{code});}});
    const saved=JSON.parse(fs.readFileSync(path.join(f.receipt.installerDirectory,'operations',operation.operationId,'operation.json'),'utf8'));
    assert.equal(saved.primaryFailure.code,code);
    assert.equal(operation.failureCode,code);
    assert.deepEqual(operation.allowedActions,[code==='MODEL_SETUP_REQUIRED'?'configure-model':'pair-clawchat','recheck','logs']);
    const result=failureResult(Object.assign(new Error(message),{code}),{action:'start',operation});
    assert.match(result.error.guidance.next,expected);
    assert.doesNotMatch(result.error.guidance.detail,/尚未确认/);
    assert.equal(result.error.allowedActions.includes('retry'),false);
  }
});

test('pair is not successful while its actual profile readiness is missing',async t=>{
  const f=fixture(t),request=f.request('pair');request.stdin=Buffer.from(JSON.stringify({code:'temporary-pair-code'})).toString('base64');
  const result=await cli.execute({receiptPath:'fixture',request},{validate:async()=>f.receipt,lock:f.lock,
    policy:{observe:async()=>({effectState:'untouched'})},run:async()=>({clawchatPaired:true}),telemetry:false});
  assert.equal(result.state,'failed');assert.equal(result.failureCode,'VERIFICATION_FAILED');
});

test('independent CLI shares durable retry limits across new request IDs',async t=>{
  const f=fixture(t);let writes=0;
  const deps={validate:async()=>f.receipt,lock:f.lock,policy:{observe:async()=>({effectState:'untouched'})},
    run:async(_ctx,_target,_args,{readonly})=>{if(readonly)return {running:false,gatewayRunning:false};writes++;throw Object.assign(new Error('unreachable'),{code:'ECONNREFUSED'});},telemetry:false};
  await cli.execute({receiptPath:'fixture',request:f.request('start')},deps);
  await cli.execute({receiptPath:'fixture',request:f.request('start')},deps);
  const final=await cli.execute({receiptPath:'fixture',request:f.request('start')},deps);
  assert.equal(writes,2);assert.equal(final.state,'blocked');
  assert.deepEqual(final.allowedActions,['recheck','logs']);
});

test('a held global executor blocks CLI before spawning any maintenance',async t=>{
  const f=fixture(t);let ran=false;
  await assert.rejects(cli.execute({receiptPath:'fixture',request:f.request('stop')},{validate:async()=>f.receipt,
    lock:{acquire:async()=>{throw Object.assign(new Error('held'),{code:'OPERATION_BUSY'});},probe:async()=>({busy:true})},
    policy:{observe:async()=>({effectState:'untouched'})},run:async()=>{ran=true;},telemetry:false}),{code:'OPERATION_BUSY'});
  assert.equal(ran,false);
});

test('CLI rejects a changed capability after acquiring the lease before consuming new writer identity',async t=>{
  const f=fixture(t);let checked=0,ran=false;
  const replacement={...f.receipt,resources:{...f.receipt.resources,
    'launcher_bridge.py':{...f.receipt.resources['launcher_bridge.py'],sha256:'b'.repeat(64)}}};
  await assert.rejects(cli.execute({receiptPath:'fixture',request:f.request('start')},{
    validate:async()=>{checked++;if(checked===1)return f.receipt;assert.equal((await f.lock.probe()).busy,true);return replacement;},
    lock:f.lock,policy:{observe:async()=>({effectState:'untouched'})},telemetry:false,
    run:async()=>{ran=true;return {running:true,gatewayRunning:true};}
  }),{code:'CONDITIONS_CHANGED'});
  assert.equal(checked,2);assert.equal(ran,false);assert.equal((await f.lock.probe()).busy,false);
  assert.equal(fs.existsSync(path.join(f.receipt.installerDirectory,'operations')),false);
});

test('refreshing only the capability registration time does not change the admitted identity',async t=>{
  const f=fixture(t);let checked=0;
  const result=await cli.execute({receiptPath:'fixture',request:f.request('start')},{
    validate:async()=>({...f.receipt,registeredAt:++checked===1?'2026-10-04T00:00:00.000Z':'2026-10-04T00:01:00.000Z'}),
    lock:f.lock,policy:{observe:async()=>({effectState:'untouched'})},telemetry:false,
    run:async()=>({running:true,gatewayRunning:true})
  });
  assert.equal(result.state,'succeeded');assert.equal(checked,2);
});

test('deferred CLI outbox never uploads details authorized before a revoked consent, even after opting in again',async t=>{
  const f=fixture(t),file=path.join(f.receipt.installerDirectory,'telemetry.json');
  fs.mkdirSync(f.receipt.installerDirectory,{recursive:true});
  const choice=consentId=>fs.writeFileSync(file,JSON.stringify({schema:1,consentVersion:3,enabled:true,diagnosticConsentId:consentId}));
  choice(randomUUID());
  const failed=await cli.execute({receiptPath:'fixture',request:f.request('start')},{validate:async()=>f.receipt,lock:f.lock,
    policy:{observe:async()=>({effectState:'untouched'})},run:async(_ctx,_target,_args,{readonly})=>{if(readonly)return {};throw Object.assign(new Error('program error'),{code:'ENOENT'});},
    fetcher:async()=>{throw new Error('offline');}});
  const outbox=path.join(f.receipt.installerDirectory,'operations',failed.operationId,'telemetry.json');
  const pending=JSON.parse(fs.readFileSync(outbox));assert.ok(pending.queue.some(event=>event.fault));
  choice(randomUUID()); // An off/on cycle replaces the explicit consent ID.
  let sent;
  const drained=await cli.drainOperationOutboxes({noraHome:f.home,launcherVersion:'2.0.2',lock:f.lock,fetcher:async(_url,options)=>{
    assert.equal((await f.lock.probe()).busy,true,'the outbox must retain exclusive ownership until ACK is saved');
    sent=JSON.parse(options.body).events;
    return Response.json({accepted_event_ids:sent.map(event=>event.event_id),rejected_event_ids:[]});
  }});
  assert.equal(drained.length,1);assert.ok(sent.length);assert.ok(sent.every(event=>event.fault===null));
  assert.ok(drained[0].summary.accepted>0);assert.equal(drained[0].summary.last_http,200);
});

test('pending outboxes stay queued without ACK and drain skips a live independent executor',async t=>{
  const f=fixture(t);
  const failed=await cli.execute({receiptPath:'fixture',request:f.request('start')},{validate:async()=>f.receipt,lock:f.lock,
    policy:{observe:async()=>({effectState:'untouched'})},run:async()=>{throw Object.assign(new Error('program error'),{code:'ENOENT'});},
    fetcher:async()=>{throw new Error('offline');}});
  let calls=0;
  const blocked=await cli.drainOperationOutboxes({noraHome:f.home,launcherVersion:'2.0.2',lock:f.lock,probe:async()=>({busy:true}),fetcher:async()=>{calls++;}});
  assert.deepEqual(blocked,[]);assert.equal(calls,0);
  const drained=await cli.drainOperationOutboxes({noraHome:f.home,launcherVersion:'2.0.2',lock:f.lock,fetcher:async()=>Response.json({accepted_event_ids:[],rejected_event_ids:[]})});
  assert.equal(drained[0].operationId,failed.operationId);assert.ok(drained[0].summary.queued>0);assert.equal(drained[0].summary.accepted,0);
  assert.equal(drained[0].summary.last_error,'unacknowledged');
});

test('explicit resume consumes the original committed target without querying latest or applying again',async t=>{
  const f=fixture(t),calls=[];
  const {createOperationController}=require('../installer/desktop/operation-state');
  const controller=createOperationController({directory:f.receipt.installerDirectory,lock:f.lock});
  const failed=await controller.start('update',{target:{request:{action:'update',port:8799}},execute:async context=>{
    await context.plan({request:{action:'update',port:8799},releasePlan:{schema:'nora-release-plan/1',releaseManifest:{versions:{tavern:'2.4.0'}}},currentVersion:'2.3.0'});
    await context.effect('changed');throw Object.assign(new Error('lost final response'),{code:'EPIPE'});
  }},randomUUID());
  const request={...f.request('update'),operationId:failed.operationId,snapshotSequence:failed.snapshotSequence};
  const deps={validate:async()=>f.receipt,lock:f.lock,policy:{observe:async()=>({effectState:'changed',canResume:true,recoveryOutcome:'not-required'})},
    telemetry:false,fetcher:async()=>{throw new Error('must not lookup latest');},run:async(context,_target,args)=>{
      const command=args[8];calls.push(command);
      if(command==='operation-effects')return {effects:{operationId:context.operationId,status:'committed',canResume:true}};
      if(command==='resume-committed-update')return {operationVerified:true,updateVerified:true,systemReady:true,version:'2.4.0',running:true,gatewayRunning:true};
      throw new Error('unexpected workflow');
    }};
  await assert.rejects(cli.execute({receiptPath:'fixture',request:{...request,snapshotSequence:request.snapshotSequence-1}},deps),{code:'OPERATION_SNAPSHOT_CHANGED'});
  const result=await cli.execute({receiptPath:'fixture',request},deps);
  assert.equal(result.operationId,failed.operationId);assert.equal(result.state,'succeeded');
  assert.deepEqual(calls,['operation-effects','resume-committed-update']);
  assert.equal(result.target.releasePlan.releaseManifest.versions.tavern,'2.4.0');
});

test('committed first installation resumes only its original bundled target verification',async t=>{
  const f=fixture(t),calls=[];
  const {createOperationController}=require('../installer/desktop/operation-state');
  const controller=createOperationController({directory:f.receipt.installerDirectory,lock:f.lock});
  const failed=await controller.start('install',{target:{request:{action:'install',port:8799}},execute:async context=>{
    await context.plan({request:{action:'install',port:8799},releasePlan:{schema:'nora-bundled-plan/1',version:'2.4.0'}});
    await context.effect('changed');throw Object.assign(new Error('lost final installation response'),{code:'EPIPE'});
  }},randomUUID());
  const journal=path.join(f.receipt.installerDirectory,'operations',failed.operationId,'first-install/transaction.json');
  fs.mkdirSync(path.dirname(journal),{recursive:true});fs.writeFileSync(journal,'{}');
  const result=await cli.execute({receiptPath:'fixture',request:{...f.request('install'),operationId:failed.operationId,snapshotSequence:failed.snapshotSequence}},{
    validate:async()=>f.receipt,lock:f.lock,telemetry:false,fetcher:async()=>{throw new Error('must not look up a new target');},
    policy:{observe:async()=>({effectState:'changed',canResume:true,recoveryOutcome:'not-required'})},run:async(context,_target,args)=>{
      const command=args[8];calls.push(command);
      if(command==='operation-effects')return {effects:{operationId:context.operationId,status:'committed',version:'2.4.0',canResume:true}};
      if(command==='resume-committed-install')return {operationVerified:true,firstInstallVerified:true,systemReady:true,version:'2.4.0'};
      throw new Error('must not install or reapply files');
    }
  });
  assert.equal(result.operationId,failed.operationId);assert.equal(result.state,'succeeded');
  assert.deepEqual(calls,['operation-effects','resume-committed-install']);
  assert.equal(result.target.releasePlan.version,'2.4.0');
});

test('a committed runtime alone cannot claim that bundled first installation completed',async t=>{
  const f=fixture(t),calls=[];
  const {createOperationController}=require('../installer/desktop/operation-state');
  const controller=createOperationController({directory:f.receipt.installerDirectory,lock:f.lock});
  const failed=await controller.start('install',{target:{request:{action:'install',port:8799}},execute:async context=>{
    await context.plan({request:{action:'install',port:8799},releasePlan:{schema:'nora-bundled-plan/1',version:'2.4.0'}});
    await context.effect('changed');throw Object.assign(new Error('runtime ready but installation interrupted'),{code:'EPIPE'});
  }},randomUUID());
  const result=await cli.execute({receiptPath:'fixture',request:{...f.request('install'),operationId:failed.operationId,snapshotSequence:failed.snapshotSequence}},{
    validate:async()=>f.receipt,lock:f.lock,telemetry:false,fetcher:async()=>{throw new Error('must not look up another target');},
    policy:{observe:async()=>({effectState:'changed',canResume:true,recoveryOutcome:'not-required'})},
    run:async(_context,_target,args)=>{calls.push(args[8]);throw new Error('must not verify an uncommitted installation');}
  });
  assert.equal(result.state,'failed');assert.equal(result.currentFailure.code,'OPERATION_ENTRY_UNSUPPORTED');
  assert.deepEqual(calls,[]);assert.equal(result.target.releasePlan.version,'2.4.0');
});

test('an APP handoff routes independent resume and recovery to the GUI before any write',async t=>{
  for(const action of ['update','recover-update']){
    const f=fixture(t),calls=[];
    const {createOperationController}=require('../installer/desktop/operation-state');
    const controller=createOperationController({directory:f.receipt.installerDirectory,lock:f.lock});
    const failed=await controller.start('update',{target:{request:{action:'update',port:8799}},execute:async context=>{
      await context.plan({request:{action:'update',port:8799},releasePlan:{schema:'nora-release-plan/1',releaseManifest:{versions:{tavern:'2.4.0'}}}});
      await context.handoff(path.join(f.home,'launcher-handoff/job.json'));
      await context.effect('changed');throw Object.assign(new Error('APP replacement interrupted'),{code:'EPIPE'});
    }},randomUUID());
    const file=path.join(f.receipt.installerDirectory,'operations',failed.operationId,'operation.json'),before=fs.readFileSync(file);
    const request={...f.request(action),kind:action==='update'?'update':'recover',operationId:failed.operationId,snapshotSequence:failed.snapshotSequence};
    await assert.rejects(cli.execute({receiptPath:'fixture',request},{validate:async()=>f.receipt,lock:f.lock,telemetry:false,
      policy:{observe:async()=>({effectState:'changed',canResume:true,canRecover:true,recoveryOutcome:action==='update'?'not-required':'recovery-required'}),
        recover:async()=>{calls.push('recover');return {verification:'confirmed'};}},
      run:async()=>{calls.push('maintenance');return {};}
    }),{code:'LAUNCHER_RECOVERY_REQUIRED'});
    assert.deepEqual(calls,[]);assert.deepEqual(fs.readFileSync(file),before);
  }
});

test('known legacy recovery uses a real guarded worker and reports files restored without claiming service success', {timeout:20000},async t=>{
  const f=fixture(t),calls=[],write=(name,value)=>{
    const file=path.join(f.home,name);fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));
  };
  write('nora-owner.json',{schema:1,id:randomUUID()});
  write('hermes/.env','old local configuration');write('tavern/story.json','old user data');
  write('hermes/nora-instance.json',{schema:1,noraHome:f.home,hermesHome:f.receipt.hermesHome,installRoot:f.receipt.installRoot,port:8799});
  write('hermes/hermes-agent/.hermes-bootstrap-complete',{schema:1,source:'nora-integrated-runtime',sha256:'a'.repeat(64),platform:process.platform,arch:process.arch});
  const manifest={schema:'tavern-release/v2',commit:'b'.repeat(40),versions:{tavern:'2.4.0'},hermesRuntime:{sha256:'a'.repeat(64),platform:process.platform,arch:process.arch}};
  write('tavern/tavern-updates/installed-manifest.json',manifest);
  write('tavern/tavern-updates/installed.json',{schema:1,version:'2.4.0',commit:manifest.commit,hermesRuntime:manifest.hermesRuntime});
  const directory=path.join(f.home,'installer/system-update');fs.mkdirSync(directory,{recursive:true});
  for(const name of ['hermes','tavern'])fs.cpSync(path.join(f.home,name),path.join(directory,name),{recursive:true});
  write('installer/system-update/journal.json',{schema:1,phase:'applying',target:'v2.4.1'});
  write('hermes/.env','current local configuration');write('tavern/story.json','current user data');
  const lock=require('../installer/desktop/operation-lock');
  const {createOperationController}=require('../installer/desktop/operation-state');
  const controller=createOperationController({directory:f.receipt.installerDirectory,lock});
  const failed=await controller.start('update',{target:{request:{action:'update',port:8799}},execute:async context=>{
    await context.effect('changed');throw Object.assign(new Error('legacy update interrupted'),{code:'EPIPE'});
  }},randomUUID());
  let workerIdentity;
  const recoveryRequest={...f.request('recover-update',['--operation-id',failed.operationId]),kind:'recover'};
  const deps={
    validate:async()=>f.receipt,lock,telemetry:false,run:async(context,target,args,options)=>{
      if(options.node){
        assert.equal(path.basename(target),'legacy-recovery-worker.js');
        const child=context.lease.spawn(process.execPath,[target,...args],{kind:'legacy-recovery',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
        let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
        child.stdin.end(options.stdin);
        const [code]=await require('node:events').once(child,'close');assert.equal(code,0,stdout+stderr);
        workerIdentity=(await context.lease.snapshot()).jobs.at(-1);
        return stdout.trim().split('\n').map(JSON.parse).find(event=>event.event==='result');
      }
      calls.push(args[8]);
      if(args[8]==='recovery-stop')return {offline:true,running:false,gatewayRunning:false};
      if(args[8]==='verify-current-update'){
        assert.equal(args[args.indexOf('--version')+1],'2.4.0','service continuation must verify the restored fixed version');
        return {version:'2.4.0',updateVerified:true,systemReady:true};
      }
      if(args[8]==='start')return {running:true,systemReady:true,version:'2.4.0'};
      throw new Error('unexpected bridge operation');
    }
  };
  const result=await cli.execute({receiptPath:'fixture',request:recoveryRequest},deps);
  assert.equal(result.operationId,failed.operationId);assert.equal(result.state,'rolled-back');
  assert.equal(result.recoveryOutcome,'files-restored-start-failed');assert.equal(result.verification,'failed');
  assert.equal(result.result.legacyFilesRestored,true);assert.equal(result.result.systemReady,undefined);
  assert.equal(result.result.originalServiceState,'unrecorded');assert.deepEqual(calls,['recovery-stop']);
  assert.equal(cli.terminalResult(result).ok,false);
  assert.equal(workerIdentity.delegation.identityStatus,'reported');assert.ok(workerIdentity.closedAt);
  assert.equal(fs.readFileSync(path.join(f.home,'tavern/story.json'),'utf8'),'old user data');
  const journal=JSON.parse(fs.readFileSync(path.join(directory,'journal.json')));
  assert.equal(fs.readFileSync(path.join(directory,journal.restoreSteps[1].failedName,'story.json'),'utf8'),'current user data');
  const restoredJournal=fs.readFileSync(path.join(directory,'journal.json'));
  const confirmed=await cli.execute({receiptPath:'fixture',request:recoveryRequest},deps);
  assert.equal(confirmed.state,'rolled-back');assert.equal(confirmed.verification,'confirmed');
  assert.equal(confirmed.result.legacyServicesVerified,true);
  assert.equal(cli.terminalResult(confirmed).ok,true);
  assert.equal(confirmed.kind,'update');assert.equal(confirmed.primaryFailure.code,'EPIPE');
  assert.deepEqual(calls,['recovery-stop','verify-current-update','start']);
  assert.deepEqual(fs.readFileSync(path.join(directory,'journal.json')),restoredJournal,'service continuation cannot restore files a second time');
});

test('explicit recovery reports under the original operation and persists real delivery ACK',async t=>{
  const f=fixture(t),sent=[];
  const {createOperationController}=require('../installer/desktop/operation-state');
  const controller=createOperationController({directory:f.receipt.installerDirectory,lock:f.lock});
  const failed=await controller.start('update',{execute:async context=>{
    await context.effect('changed');throw Object.assign(new Error('activation interrupted'),{code:'EPIPE'});
  }},randomUUID());
  await assert.rejects(cli.execute({receiptPath:'fixture',request:{...f.request('recover-install',['--operation-id',failed.operationId]),kind:'recover'}},{
    validate:async()=>f.receipt,lock:f.lock,policy:{observe:async()=>({effectState:'changed',canRecover:true})},telemetry:false
  }),{code:'OPERATION_REQUEST_CONFLICT'});
  const operation=await cli.execute({receiptPath:'fixture',request:{...f.request('recover-update',['--operation-id',failed.operationId]),kind:'recover'}},{
    validate:async()=>f.receipt,lock:f.lock,policy:{observe:async()=>({effectState:'changed',canRecover:true}),
      recover:async()=>({verification:'confirmed',value:{updateRecovered:true}})},
    fetcher:async(_url,options)=>{sent.push(...JSON.parse(options.body).events);return Response.json({accepted_event_ids:JSON.parse(options.body).events.map(event=>event.event_id),rejected_event_ids:[]});}
  });
  assert.equal(operation.state,'rolled-back');assert.equal(operation.operationId,failed.operationId);
  assert.equal(operation.kind,'update');assert.equal(operation.primaryFailure.code,'EPIPE');
  assert.equal(operation.requestedAction,'recover');
  assert.equal(cli.terminalResult(operation).ok,true,'the explicitly requested verified recovery succeeds while preserving the failed original update');
  assert.ok(sent.some(event=>event.action==='repair'&&event.event==='operation_started'));
  assert.ok(sent.every(event=>event.operation_id===''||event.operation_id===failed.operationId));
  const queue=JSON.parse(fs.readFileSync(path.join(f.receipt.installerDirectory,'operations',failed.operationId,'telemetry.json')));
  assert.equal(queue.queue.length,0);
});

test('explicit first-install recovery succeeds without rewriting the original failed installation',async t=>{
  const f=fixture(t);
  const {createOperationController}=require('../installer/desktop/operation-state');
  const controller=createOperationController({directory:f.receipt.installerDirectory,lock:f.lock});
  const failed=await controller.start('install',{execute:async context=>{
    await context.effect('changed');throw Object.assign(new Error('installation interrupted'),{code:'EPIPE'});
  }},randomUUID());
  const operation=await cli.execute({receiptPath:'fixture',request:{...f.request('recover-install',['--operation-id',failed.operationId]),kind:'install'}},{
    validate:async()=>f.receipt,lock:f.lock,telemetry:false,
    policy:{observe:async()=>({effectState:'changed',canRecover:true}),recover:async()=>({verification:'confirmed',value:{firstInstallRecovered:true}})}
  });
  assert.equal(operation.kind,'install');assert.equal(operation.requestedAction,'recover');
  assert.equal(operation.primaryFailure.code,'EPIPE');assert.equal(operation.state,'rolled-back');
  assert.equal(cli.terminalResult(operation).ok,true);
  const saved=JSON.parse(fs.readFileSync(path.join(f.receipt.installerDirectory,'operations',failed.operationId,'operation.json')));
  assert.equal(saved.kind,'install');assert.equal(saved.primaryFailure.code,'EPIPE');
  assert.equal(saved.requestedAction,undefined,'the response action does not change the durable original operation');
});

test('a failed explicit update continuation remains failed after a confirmed automatic rollback',async t=>{
  const f=fixture(t),calls=[];
  fs.mkdirSync(f.receipt.installerDirectory,{recursive:true});
  fs.writeFileSync(path.join(f.receipt.installerDirectory,'telemetry.json'),JSON.stringify({schema:1,consentVersion:3,enabled:true,diagnosticConsentId:randomUUID()}));
  const raw=[];
  const {createOperationController}=require('../installer/desktop/operation-state');
  const controller=createOperationController({directory:f.receipt.installerDirectory,lock:f.lock});
  const failed=await controller.start('update',{target:{request:{action:'update',port:8799}},execute:async context=>{
    await context.plan({request:{action:'update',port:8799},releasePlan:{schema:'nora-release-plan/1',releaseManifest:{versions:{tavern:'2.4.0'}}}});
    await context.effect('changed');throw Object.assign(new Error('lost update response'),{code:'EPIPE'});
  }},randomUUID());
  const operation=await cli.execute({receiptPath:'fixture',request:{...f.request('update'),operationId:failed.operationId,snapshotSequence:failed.snapshotSequence}},{
    validate:async()=>f.receipt,lock:f.lock,fetcher:async(url,init)=>{
      const body=JSON.parse(init.body);
      if(url.endsWith('/logs')){
        assert.ok(calls.includes('recover'),'raw capture must close after automatic rollback');raw.push(body);
        return Response.json({accepted:true,index:body.index,chunk_id:body.chunk_id});
      }
      assert.ok(url.endsWith('/events'),'must not select a new target');
      return Response.json({accepted_event_ids:body.events.map(event=>event.event_id),rejected_event_ids:[]});
    },
    policy:{observe:async()=>({effectState:'changed',canResume:true,canRecover:true,recoveryOutcome:'not-required'}),
      recover:async()=>{calls.push('recover');return {verification:'confirmed',value:{updateRecovered:true}};}},
    run:async(context,_target,args)=>{
      calls.push(args[8]);
      if(args[8]==='operation-effects')return {effects:{operationId:context.operationId,status:'committed',canResume:true}};
      throw Object.assign(new Error('verification interrupted'),{code:'ECONNRESET'});
    }
  });
  assert.deepEqual(calls,['operation-effects','resume-committed-update','recover']);
  assert.equal(operation.state,'rolled-back');assert.equal(operation.verification,'confirmed');
  assert.equal(operation.kind,'update');assert.equal(operation.requestedAction,'update');
  assert.equal(operation.primaryFailure.code,'EPIPE');assert.equal(operation.currentFailure.code,'ECONNRESET');
  assert.equal(cli.terminalResult(operation).ok,false,'automatic rollback is recovery evidence, not a successful update');
  assert.ok(raw.at(-1)?.final,'the retained operation log must reach a final ACK');
  assert.match(raw.map(chunk=>chunk.text).join(''),/verification interrupted/);
  assert.match(raw.map(chunk=>chunk.text).join(''),/restored-and-verified/);
});

test('CLI drains closed failure logs after the basic event queue has already been acknowledged',async t=>{
  const f=fixture(t);
  fs.mkdirSync(f.receipt.installerDirectory,{recursive:true});
  fs.writeFileSync(path.join(f.receipt.installerDirectory,'telemetry.json'),JSON.stringify({schema:1,consentVersion:3,enabled:true,diagnosticConsentId:randomUUID()}));
  const operation=await cli.execute({receiptPath:'fixture',request:f.request('start')},{validate:async()=>f.receipt,lock:f.lock,
    policy:{observe:async()=>({effectState:'untouched'})},run:async(_context,_target,_args,{readonly})=>{
      if(readonly)return {};throw Object.assign(new Error('native start failed'),{code:'ENOENT'});
    },fetcher:async(url,init)=>{
      if(url.endsWith('/logs'))throw Error('offline');
      return Response.json({accepted_event_ids:JSON.parse(init.body).events.map(event=>event.event_id),rejected_event_ids:[]});
    }});
  const file=path.join(f.receipt.installerDirectory,'operations',operation.operationId,'telemetry.json');
  assert.equal(JSON.parse(fs.readFileSync(file)).queue.length,0);
  const rawState=JSON.parse(fs.readFileSync(file+'.logs'));rawState.jobs[0].due=0;
  fs.writeFileSync(file+'.logs',JSON.stringify(rawState));
  const chunks=[];
  const drained=await cli.drainOperationOutboxes({noraHome:f.home,launcherVersion:'2.0.2',lock:f.lock,fetcher:async(url,init)=>{
    assert.ok(url.endsWith('/logs'));const chunk=JSON.parse(init.body);chunks.push(chunk);
    return Response.json({accepted:true,index:chunk.index,chunk_id:chunk.chunk_id});
  }});
  assert.equal(drained.length,1);assert.equal(chunks.length,1);assert.ok(chunks[0].final);
  assert.match(chunks[0].text,/native start failed/);
});

test('already-current admission checks real program bytes and rejects damaged or redirected trees',async t=>{
  const f=fixture(t),sha=bytes=>require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  const manifest={artifacts:{}};
  for(const [name,relative] of [['app/entry.js','tavern-runtime/entry.js'],['ops/task.py','tavern-ops/task.py'],['nora-mcp/dist/server.js','nora-mcp/dist/server.js']]){
    const target=path.join(f.receipt.installRoot,'apps',relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,name);
    manifest.artifacts[name]=sha(name);
  }
  assert.equal(await cli.currentFilesMatch(f.receipt,manifest),true);
  const app=path.join(f.receipt.installRoot,'apps/tavern-runtime'),file=path.join(app,'entry.js');
  fs.writeFileSync(file,'different program, same version');assert.equal(await cli.currentFilesMatch(f.receipt,manifest),false);
  fs.writeFileSync(file,'app/entry.js');
  const moved=app+'-moved';fs.renameSync(app,moved);fs.symlinkSync(moved,app,process.platform==='win32'?'junction':'dir');
  assert.equal(await cli.currentFilesMatch(f.receipt,manifest),false);
});

for(const managedInstallation of [true,false])for(const appOnly of [false,true])for(const receiptForm of appOnly?['raw','first-install','altered-source']:['raw'])test(`independent updater verifies an already-current ${managedInstallation?'managed':'standalone'} ${appOnly?'APP-only publication':'target'} (${receiptForm}) without a replacement transaction`,async t=>{
  const f=fixture(t),sha=value=>require('node:crypto').createHash('sha256').update(value).digest('hex');
  f.receipt.schema='nora-updater-control/1';f.receipt.managedInstallation=managedInstallation;
  const release=path.join(f.home,'local-release'),app=path.join(f.receipt.installRoot,'apps/tavern-runtime/entry.js');
  fs.mkdirSync(path.dirname(app),{recursive:true});fs.writeFileSync(app,'current verified program');fs.mkdirSync(release);
  const commit='e'.repeat(40),version='2.5.2',manifest={schema:'tavern-release/v2',commit,versions:{tavern:version},
    updaterCapabilities:require('../installer/desktop/releases').UPDATER_CAPABILITIES,
    bootstrap:{managedComponents:1,minimumLauncherVersion:'99.0.0',sha256:sha('bootstrap')},artifacts:{'app/entry.js':sha('current verified program')}};
  const original=JSON.stringify(manifest),receipt=path.join(f.receipt.installRoot,'tavern-updates/installed-manifest.json');
  const installed=receiptForm==='raw'?original:JSON.stringify({...manifest,integratedDependencies:{schema:1,
    platform:process.platform,arch:process.arch,archive:'dependencies.tar.gz',sha256:sha('dependencies'),size:12,
    nodeMajor:24,roots:['app/engine/sillytavern/node_modules','nora-mcp/node_modules']}},null,2);
  fs.mkdirSync(path.dirname(receipt),{recursive:true});fs.writeFileSync(receipt,installed);
  if(managedInstallation){
    // File presence selects the existing healthy-managed route. Service health
    // is the explicit adapter result below, not claimed from these placeholders.
    for(const name of ['native-runtime.json','native_lifecycle.py'])fs.writeFileSync(path.join(path.dirname(app),name),'fixture');
    const python=path.join(f.receipt.hermesHome,'hermes-agent/venv',process.platform==='win32'?'Scripts/python.exe':'bin/python3');
    fs.mkdirSync(path.dirname(python),{recursive:true});fs.writeFileSync(python,'fixture');
  }
  const files={'release-manifest.json':appOnly?JSON.stringify({...manifest,commit:'f'.repeat(40),
    publication:{schema:'nora-component-publication/1',tag:'v2.5.3'},launcherVersion:'2.2.3',
    artifacts:{'ops/new-runner.js':sha('APP source is different')},
    coreRelease:{schema:'nora-core-reference/1',tag:'v2.5.2',commit,manifests:{[`${process.platform}-${process.arch}`]:{
      asset:`${process.platform}-${process.arch}-release-manifest.json`,sha256:sha(original),size:Buffer.byteLength(original)}}}}):original,
    'tavern-updater-bootstrap.py':'bootstrap',...(appOnly?{[`${process.platform}-${process.arch}-release-manifest.json`]:
      receiptForm==='altered-source'?original.replace(sha('current verified program'),'0'.repeat(64)):original}:{})};
  files.SHA256SUMS=Object.entries(files).map(([name,value])=>sha(value)+'  '+name).join('\n');
  for(const [name,value] of Object.entries(files))fs.writeFileSync(path.join(release,name),value);
  const actual={version,commit,systemReady:true,running:false,gatewayRunning:false,noraHome:f.home,
    hermesHome:f.receipt.hermesHome,installRoot:f.receipt.installRoot,port:f.receipt.port,
    ...(!managedInstallation?{standalone:true,gatewayManaged:false,gatewayRunning:null}:{})},calls=[];
  const operation=await cli.execute({receiptPath:'fixture',request:f.request('update',['--release-dir',release])},
    {client:'updater',validate:async()=>f.receipt,lock:f.lock,telemetry:false,
      policy:{observe:async()=>({effectState:'untouched',recoveryOutcome:'not-required'})},run:async(_context,_target,args)=>{
        const command=args[8];calls.push(command);
        if(command==='status'||command==='repair-preflight')return actual;
        if(command==='verify-current-update')return {...actual,updateVerified:true};
        assert.fail('An already-current target must not prepare or apply: '+command);
      }});
  if(receiptForm==='altered-source'){
    assert.equal(operation.state,'failed');assert.equal(operation.effectState,'untouched');
    assert.equal(operation.result?.noUpdate,undefined);
    assert.deepEqual(calls,[managedInstallation?'status':'repair-preflight']);
  }else{
  assert.equal(operation.state,'succeeded',fs.readFileSync(path.join(f.receipt.installerDirectory,'install.log'),'utf8'));assert.equal(operation.verification,'confirmed');
  assert.equal(operation.effectState,'untouched');assert.equal(operation.result.noUpdate,true);
  assert.deepEqual(calls,[managedInstallation?'status':'repair-preflight','verify-current-update','status']);
  }
  assert.equal(fs.readFileSync(receipt,'utf8'),installed);
  assert.equal(fs.readFileSync(app,'utf8'),'current verified program');
});
