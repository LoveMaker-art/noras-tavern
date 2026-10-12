// Startup and post-exit uninstall diagnostics use the existing event/log
// protocol. Each producer owns a separate outbox and native writer lease.
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {randomUUID}=require('node:crypto');
const {createTelemetry}=require('./telemetry');
const {createDiagnostics}=require('./diagnostics');
const osLock=require('./os-lock');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KINDS=new Set(['startup','uninstall']);
const VERSION=/^(?:unknown|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const fail=message=>Object.assign(new Error(message),{code:'LIFECYCLE_DIAGNOSTICS_UNAVAILABLE'});
const inside=(root,file)=>{const relative=path.relative(root,file);return relative===''||!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};

function defaultDirectory(){
  const base=process.platform==='win32'?process.env.APPDATA||path.join(os.homedir(),'AppData','Roaming')
    :process.platform==='darwin'?path.join(os.homedir(),'Library','Application Support'):path.join(os.homedir(),'.local','share');
  return path.join(base,'NoraTavern','diagnostics','lifecycle');
}
function regular(file,limit){
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>limit)throw fail('诊断文件无法安全读取。');
  return JSON.parse(fs.readFileSync(file,'utf8'));
}
function checkedDirectory(directory,{create=false}={}){
  const full=path.resolve(directory);
  let current=path.parse(full).root;
  for(const part of full.slice(current.length).split(path.sep).filter(Boolean)){
    current=path.join(current,part);
    if(fs.existsSync(current)){
      const stat=fs.lstatSync(current);
      if(!stat.isDirectory()||stat.isSymbolicLink())throw fail('诊断目录被链接重定向或不可用。');
    }
  }
  if(create)fs.mkdirSync(full,{recursive:true,mode:0o700});
  return fs.existsSync(full)?fs.realpathSync(full):full;
}
function readChoice(home){
  try{
    if(!path.isAbsolute(home||''))throw fail('安装目录尚未确认。');
    const root=checkedDirectory(home),directory=checkedDirectory(path.join(root,'installer'));
    const value=regular(path.join(directory,'telemetry.json'),2*1024*1024);
    if(value.schema!==1||value.consentVersion!==3||typeof value.enabled!=='boolean')throw fail('诊断选择尚未确认。');
    if(value.enabled&& !UUID.test(value.diagnosticConsentId||''))throw fail('诊断选择身份无效。');
    return {enabled:value.enabled,consentId:value.enabled?value.diagnosticConsentId:'',reason:value.enabled?'':'diagnostic_disabled'};
  }catch{return {enabled:false,consentId:'',reason:'consent_unavailable'};}
}
function absentChoice(home){
  try{checkedDirectory(home);checkedDirectory(path.join(home,'installer'));
    return !fs.lstatSync(path.join(home,'installer','telemetry.json'),{throwIfNoEntry:false});
  }catch(error){return error.code==='ENOENT';}
}
function save(file,value){
  const stat=fs.lstatSync(file,{throwIfNoEntry:false});
  if(stat&&(stat.isSymbolicLink()||!stat.isFile()))throw fail('诊断记录被链接重定向。');
  const temporary=file+'.'+randomUUID()+'.tmp';
  try{const fd=fs.openSync(temporary,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,file);}
  finally{fs.rmSync(temporary,{force:true});}
}

function createLifecycleDiagnostics({directory=defaultDirectory(),launcherVersion,platform=process.platform,arch=process.arch,
  enabled=false,fetcher=globalThis.fetch,now=Date.now,clean,roots=()=>[os.homedir()],diagnostic=()=>{}}={}){
  const active=new Set();
  const emit=code=>{try{diagnostic(code);}catch{}};
  function validateMetadata(metadata,id){
    if(metadata.schema!=='nora-lifecycle-diagnostics/1'||metadata.id!==id||!KINDS.has(metadata.kind)
      ||!['capturing','queued','accepted'].includes(metadata.phase)||typeof metadata.choice?.enabled!=='boolean'
      ||metadata.choice.enabled&&!UUID.test(metadata.choice.consentId||'')||metadata.home!==null&&!path.isAbsolute(metadata.home||'')
      ||!Number.isSafeInteger(metadata.createdAt)||metadata.createdAt>now()+60000||!VERSION.test(metadata.launcherVersion||'')
      ||!['darwin','win32','linux'].includes(metadata.platform)||!['arm64','x64'].includes(metadata.arch)
      ||!Number.isInteger(metadata.expectedEvents)||metadata.expectedEvents<1||metadata.expectedEvents>20)throw fail('退出后诊断记录无效。');
    const state=regular(path.join(directory,id,'events.json'),2*1024*1024);
    if(!Array.isArray(state.queue)||state.active&&state.active.id!==id||state.queue.some(event=>event.operation_id!==id)
      ||Object.keys(state.delivery||{}).some(key=>key!==id))throw fail('诊断队列与故障身份不一致。');
    const logs=path.join(directory,id,'events.json.logs');
    if(fs.existsSync(logs)){const state=regular(logs,2*1024*1024);
      if(state.schema!==1||!Array.isArray(state.jobs)||state.jobs.some(job=>job.id!==id))throw fail('日志队列与故障身份不一致。');}
    return metadata;
  }
  function open(base,metadata,lease,budgetMs,{removedChoice=false}={}){
    let closed=false,pending=null,closing=null;
    const deadline=Date.now()+Math.max(1,Math.min(5000,budgetMs||1500));
    const boundedFetch=(url,options)=>fetcher(url,{...options,signal:AbortSignal.any([options.signal,
      AbortSignal.timeout(Math.max(1,deadline-Date.now()))].filter(Boolean))});
    for(const name of ['events.json','events.json.logs','install.log','install.log.1','install.log.2']){
      const stat=fs.lstatSync(path.join(base,name),{throwIfNoEntry:false});
      if(stat&&(stat.isSymbolicLink()||!stat.isFile()))throw fail('诊断队列被链接重定向。');
    }
    const diagnostics=createDiagnostics({primary:()=>path.join(base,'install.log')});
    const client=createTelemetry({file:path.join(base,'events.json'),launcherVersion:metadata.launcherVersion,
      platform:metadata.platform,arch:metadata.arch,enabled:true,diagnosticDefault:false,automatic:false,
      now,clean:clean||diagnostics.clean,roots:()=>[...roots(),...(metadata.home?[metadata.home]:[])],fetcher:boundedFetch,
      diagnostic:emit,operationLogs:(id,cursor)=>diagnostics.readOperation(id,cursor),
      logScope:(task,work)=>diagnostics.scope(task.id,{action:task.action},work)});
    // The task's capture choice can be revoked, but a later opt-in cannot add
    // details to a packet that was captured without that authorization.
    client.syncDiagnosticConsent(metadata.choice);
    const release=()=>{try{lease.release();}finally{active.delete(handle);}};
    const handle={operationId:metadata.id,diagnostics,client,
      flush(){
        if(closed)throw fail('诊断发送器已关闭。');
        if(pending)return pending;
        pending=(async()=>{
        let choice=readChoice(metadata.home);
        // Only the live ALL worker may use its pre-cleanup snapshot after it
        // removed this exact consent file. A later drain never gains this right.
        if(removedChoice&&choice.reason==='consent_unavailable'&&absentChoice(metadata.home))
          choice=metadata.choice;
        const detailsAllowed=choice.enabled&&choice.consentId===metadata.choice.consentId;
        client.syncDiagnosticConsent(detailsAllowed?choice:{enabled:false,consentId:''});
        await client.flush();
        const summary=client.deliverySummary(metadata.id),logs=client.rawLogSummary(metadata.id);
        const accepted=summary.accepted===metadata.expectedEvents&&summary.queued===0
          &&['rejected','expired','evicted','paused'].every(key=>summary[key]===0)
          &&summary.missing.every(reason=>reason==='diagnostic_disabled')
          &&(!detailsAllowed||Boolean(logs?.complete))&&(!logs||logs.complete&&!logs.blocked&&!logs.unavailable);
        metadata.delivery=summary;metadata.logs=logs;metadata.phase=accepted?'accepted':'queued';
        save(path.join(base,'job.json'),metadata);
        return {operationId:metadata.id,phase:metadata.phase,summary,logs};
        })().finally(()=>{pending=null;});
        return pending;
      },
      close(){if(closing)return closing;closed=true;client.close();
        // Abort does not synchronously finish telemetry's catch/save paths.
        // Retain the native lease until all writes have settled.
        if(pending)closing=pending.then(()=>{},()=>{}).then(release);
        else{release();closing=Promise.resolve();}return closing;},
    };
    active.add(handle);return handle;
  }
  function capture(kind,error,{home=null,budgetMs=1500}={},snapshot=null,removedChoice=false){
    if(!enabled)return null;
    if(!KINDS.has(kind))throw fail('诊断阶段无效。');
    const normalized=path.isAbsolute(home||'')?path.resolve(home):null;
    if(!path.isAbsolute(directory))throw fail('诊断目录必须为绝对路径。');
    const root=checkedDirectory(directory);
    if(normalized&&inside(normalized,root))throw fail('退出后诊断目录不能位于待卸载安装目录内。');
    checkedDirectory(root,{create:true});
    const catalog=osLock.acquire({directory:root});
    try{
    prune(root);
    if(fs.readdirSync(root).filter(name=>UUID.test(name)&&fs.existsSync(path.join(root,name,'job.json'))).length>=128)throw fail('退出后诊断队列超过保留预算。');
    const id=randomUUID(),base=path.join(root,id);fs.mkdirSync(base,{mode:0o700});
    const lease=osLock.acquire({directory:base});let handle;
    try{
      let choice=readChoice(normalized);
      if(snapshot&&removedChoice&&choice.reason==='consent_unavailable'&&absentChoice(normalized))
        choice=snapshot;
      const metadata={schema:'nora-lifecycle-diagnostics/1',id,kind,home:normalized,choice,
        launcherVersion:VERSION.test(launcherVersion||'')?launcherVersion:'unknown',platform,arch,createdAt:now(),phase:'capturing'};
      // Independent actors must not reset or concurrently write the GUI's
      // installation sequence. This is the same identity boundary as CLI actors.
      save(path.join(base,'events.json'),{schema:1,id:randomUUID(),cohort:'unknown',enabled:false,consentVersion:3,
        diagnosticConsentId:'',sequence:0,seen:true,ready:false,active:null,queue:[]});
      save(path.join(base,'job.json'),metadata);
      handle=open(base,metadata,lease,budgetMs,{removedChoice});
      handle.diagnostics.begin('lifecycle-'+kind,{operationId:id,action:'launcher'});
      handle.client.begin('launcher',{operationId:id});
      handle.diagnostics.error('lifecycle.'+kind+'-failed',error);
      handle.client.finish('failed',error);handle.diagnostics.finish('failed');
      metadata.expectedEvents=handle.client.deliverySummary(id).queued;
      metadata.phase='queued';save(path.join(base,'job.json'),metadata);
      return handle;
    }catch(error){handle?handle.close():lease.release();throw error;}
    }finally{catalog.release();}
  }
  function prune(root){
    for(const id of fs.readdirSync(root).filter(name=>UUID.test(name))){
      let lease;
      try{
        const base=checkedDirectory(path.join(root,id));lease=osLock.acquire({directory:base});
        const metadata=regular(path.join(base,'job.json'),16384);
        if(metadata.schema!=='nora-lifecycle-diagnostics/1'||metadata.id!==id||!Number.isSafeInteger(metadata.createdAt)
          ||now()-metadata.createdAt<(metadata.phase==='accepted'?86400000:7*86400000))continue;
        // Never recursively remove a modified job or its stable native lock.
        // Retired jobs remain small tombstones; capacity counts only job.json.
        const names=fs.readdirSync(base),allowed=new Set(['job.json','events.json','events.json.logs','install.log','install.log.1','install.log.2','install.log.3','operations']);
        if(names.some(name=>!allowed.has(name)))continue;
        if(names.filter(name=>name!=='operations').some(name=>!fs.lstatSync(path.join(base,name)).isFile()))continue;
        for(const name of names.filter(name=>name!=='operations'))fs.unlinkSync(path.join(base,name));
      }catch{}finally{lease?.release();}
    }
  }
  async function drain({maximum=4,budgetMs=5000}={}){
    if(!enabled||!fs.existsSync(directory))return [];
    const root=checkedDirectory(directory),deadline=Date.now()+Math.max(1,Math.min(10000,budgetMs)),results=[];
    for(const id of fs.readdirSync(root).filter(name=>UUID.test(name)).sort()){
      if(results.length>=Math.min(8,Math.max(1,maximum))||Date.now()>=deadline)break;
      let lease,handle;
      try{
        const base=checkedDirectory(path.join(root,id));
        if(!fs.existsSync(path.join(base,'job.json')))continue;
        lease=osLock.acquire({directory:base});
        const metadata=validateMetadata(regular(path.join(base,'job.json'),16384),id);
        if(metadata.phase==='accepted'||now()-metadata.createdAt>7*86400000)continue;
        if(metadata.home&&inside(metadata.home,root))throw fail('诊断目录与安装目录混用。');
        handle=open(base,metadata,lease,Math.max(1,deadline-Date.now()));
        results.push(await handle.flush());
      }catch(error){emit(error.code==='OPERATION_BUSY'?'outbox_busy':'outbox_unavailable');}
      finally{if(handle)await handle.close();else lease?.release();}
    }
    return results;
  }
  return {capture,drain,prepare({home,budgetMs=1500}={}){
    const snapshot=readChoice(home);
    return (kind,error,{consentRemoved=false}={})=>capture(kind,error,{home,budgetMs},snapshot,consentRemoved);
  },async close(){await Promise.all([...active].map(handle=>handle.close()));},directory:path.resolve(directory)};
}

module.exports={createLifecycleDiagnostics,defaultDirectory,readChoice};
