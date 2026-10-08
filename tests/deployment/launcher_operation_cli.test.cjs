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
