// One policy for GUI and independent CLI callers. Journals own file facts;
// this module combines their outcomes and orders whole-operation recovery.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const runtime=require('./runtime-transaction');
const {describeError}=require('./launcher-errors');
const {sourceCandidates,validateSourceResponse}=require('./release-sources');
const {fetchRead}=require('./release-network');
const failure=(code,message)=>Object.assign(new Error(message),{code});
const safe=new Set(['untouched','restored']);
const value=input=>typeof input==='function'?input():input;
const CONDITION_SCHEMA='nora-operation-conditions/1';
const maintenanceKinds=new Set(['install','update','repair','recover']);
const conditionFingerprint=facts=>crypto.createHash('sha256').update(JSON.stringify(facts)).digest('hex');

// A bounded write probe verifies effective directory access. It does not create
// missing installation trees or treat lookup times as changed conditions.
function inspectConditions({home,hermesHome,installRoot},context={}){
  const directories=[];
  for(const [name,input] of Object.entries({noraHome:home,hermesHome,installRoot})){
    const directory=path.resolve(value(input));context.lease?.assertActive?.();
    let stat;try{stat=fs.lstatSync(directory);}catch(error){if(error.code==='ENOENT'){directories.push({name,identity:null,writable:null});continue;}throw error;}
    if(!stat.isDirectory()||stat.isSymbolicLink()){directories.push({name,identity:null,writable:null});continue;}
    const identity=[String(stat.dev),String(stat.ino)];let writable=false;
    const probe=path.join(directory,`.nora-condition-${crypto.randomUUID()}`);
    try{const fd=fs.openSync(probe,'wx',0o600);try{fs.writeSync(fd,'probe');}finally{fs.closeSync(fd);}writable=true;}
    catch(error){if(!['EACCES','EPERM','EROFS','ENOSPC'].includes(error.code))throw error;}
    finally{try{fs.unlinkSync(probe);}catch(error){if(error.code!=='ENOENT')throw error;}}
    const after=fs.lstatSync(directory);
    if(after.isSymbolicLink()||String(after.dev)!==identity[0]||String(after.ino)!==identity[1])throw failure('CONDITIONS_CHANGED','条件检查期间安装目录身份已变化。');
    directories.push({name,identity,writable});
  }
  const facts={directories,networkReads:[]};return {schema:CONDITION_SCHEMA,fingerprint:conditionFingerprint(facts),facts};
}

function validConditions(proof){
  return proof?.schema===CONDITION_SCHEMA&&/^[a-f0-9]{64}$/.test(proof.fingerprint||'')
    &&Array.isArray(proof.facts?.directories)&&proof.facts.directories.length===3
    &&proof.facts.directories.every((item,index)=>item?.name===['noraHome','hermesHome','installRoot'][index]
      &&(item.identity===null||Array.isArray(item.identity)&&item.identity.length===2&&item.identity.every(part=>/^\d+$/.test(part)))
      &&[true,false,null].includes(item.writable))&&Array.isArray(proof.facts.networkReads)&&proof.facts.networkReads.length<=8
    &&proof.facts.networkReads.every(item=>item?.readable===true&&/^[a-f0-9]{64}$/.test(item.identity||'')&&/^[a-f0-9]{64}$/.test(item.routeHash||''))
    &&conditionFingerprint(proof.facts)===proof.fingerprint;
}

function create({home,hermesHome,installRoot,bridge,runRuntime,inspectRuntime=runtime.inspect,
  inspectLauncher=async()=>null,inspectLegacy=()=>require('./system-update').inspect(value(home)),runLegacy,checkConditions,
  networkFetch=globalThis.fetch,launcherVersion='2.0.2',channel='stable',platform=process.platform,arch=process.arch,now=Date.now}={}){
  if(typeof bridge!=='function'||typeof runRuntime!=='function')throw new TypeError('Owned bridge and runtime executors are required');
  const locations=id=>({noraHome:value(home),hermesHome:value(hermesHome),operationId:id});
  const firstJournal=id=>path.join(value(home),'installer','operations',id,'first-install','transaction.json');
  const systemJournal=()=>path.join(value(installRoot),'tavern-updates','transaction.json');
  const collect=checkConditions||((record,context)=>inspectConditions({home,hermesHome,installRoot},context));
  async function initialConditions(record,context={}){
    if(!maintenanceKinds.has(record.kind))return null;
    try{
      const proof=validConditions(context.baseline)?context.baseline:await collect(record,context);
      if(!validConditions(proof))return null;
      const previous=context.previous?.conditionBaseline;
      if(!validConditions(previous))return proof;
      const reads=new Map(previous.facts.networkReads.map(item=>[item.identity,item]));
      for(const item of proof.facts.networkReads)reads.set(item.identity,item);
      if(reads.size>8)return null;
      const facts={...proof.facts,networkReads:[...reads.values()]};
      return {schema:CONDITION_SCHEMA,facts,fingerprint:conditionFingerprint(facts)};
    }catch{return null;}
  }
  function trustedResource(record,resource){
    try{
      if(!resource||!/^[a-f0-9]{64}$/.test(resource.sha256||'')||!/^[a-f0-9]{64}$/.test(resource.routeHash||'')
        ||!Number.isSafeInteger(resource.size)||resource.size<1||resource.size>2*1024**3)return null;
      const source=record.target?.releasePlan;if(source?.schema!=='nora-release-plan/1')return null;
      const releases=require('./releases');
      const plan=releases.validatePlan(source,{launcherVersion:value(launcherVersion),platform:source.platform,arch:source.arch,channel:source.channel,
        operationDirectory:path.join(value(home),'installer','operations',record.operationId)});
      if(resource.tag!==plan.tag||resource.url!==releases.assetUrl(plan.release,resource.asset)
        ||plan.release.assets.find(item=>item.name===resource.asset)?.size!==resource.size)return null;
      const owned=[...Object.values(plan.systemManifest?.files||{}),...Object.values(plan.releaseManifest.modules||{}),
        ...Object.values(plan.releaseManifest.archives||{}),...(plan.launcherManifest?[plan.launcherManifest]:[]),
        {name:'tavern-updater-bootstrap.py',sha256:plan.releaseManifest.bootstrap?.sha256}];
      if(!owned.some(item=>(item.asset||item.name)===resource.asset&&item.sha256===resource.sha256))return null;
      return {url:resource.url,tag:resource.tag,asset:resource.asset,size:resource.size,sha256:resource.sha256,routeHash:resource.routeHash};
    }catch{return null;}
  }
  function trustedMetadata(record,resource){
    try{
      if(record.target?.releasePlan||!/^[a-f0-9]{64}$/.test(resource?.routeHash||''))return null;
      const url=new URL(resource.url),base='/repos/LoveMaker-art/noras-tavern/releases',requested=record.target?.request?.tag;
      if(url.username||url.password||url.hash)return null;
      let tag=null,list=false;
      if(url.origin==='https://github.com'&&!url.search){
        const prefix='/LoveMaker-art/noras-tavern/releases/download/',parts=url.pathname.slice(prefix.length).split('/');
        if(!url.pathname.startsWith(prefix)||parts.length!==2)return null;
        tag=decodeURIComponent(parts[0]);const asset=parts[1];
        if(!require('./releases').accepts({tag_name:tag,draft:false,prerelease:value(channel)==='beta'},value(channel))
          ||parts[0]!==encodeURIComponent(tag)||requested&&requested!==tag)return null;
        const type=asset==='release-manifest.json'?'release-manifest':asset===`nora-launcher-${value(platform)}-${value(arch)}.json`?'launcher-manifest'
          :asset===`nora-system-${value(platform)}-${value(arch)}.json`?'system-manifest':null;
        if(!type||type!=='release-manifest'&&require('./releases').compare(resource.expectedVersion,resource.expectedVersion)!==0)return null;
        return {url:url.href,routeHash:resource.routeHash,tag,type,...(type!=='release-manifest'?{expectedVersion:resource.expectedVersion}:{})};
      }
      if(url.origin!=='https://api.github.com')return null;
      if(url.pathname===`${base}/latest`&&!url.search){if(requested||value(channel)!=='stable')return null;}
      else if(url.pathname.startsWith(`${base}/tags/`)&&!url.search){
        tag=decodeURIComponent(url.pathname.slice(`${base}/tags/`.length));
        if(require('./releases').compare(tag,tag)!==0||url.pathname!==`${base}/tags/${encodeURIComponent(tag)}`||requested!==tag)return null;
      }else if(url.pathname===base&&/^\?per_page=100&page=[1-5]$/.test(url.search)&&value(channel)==='beta'&&!requested)list=true;
      else return null;
      return {url:url.href,routeHash:resource.routeHash,tag,list};
    }catch{return null;}
  }
  function identifyFailureCondition(error,record){
    if(['start','restart'].includes(record.kind)&&record.target?.request?.service!=='tavern'){
      const requirement={CLAWCHAT_PAIR_REQUIRED:'clawchatPaired',MODEL_SETUP_REQUIRED:'modelConfigured'}[error?.userCode||error?.code];
      if(requirement)return {kind:'setup-ready',requirement};
    }
    const roots=Object.entries({noraHome:home,hermesHome,installRoot}).map(([name,input])=>[name,path.resolve(value(input))])
      .sort((left,right)=>right[1].length-left[1].length);
    const seen=new Set();
    for(let current=error;current&&typeof current==='object'&&!seen.has(current)&&seen.size<4;current=current.cause){
      seen.add(current);
      if(!['EACCES','EPERM'].includes(current.code)||typeof current.path!=='string'||!path.isAbsolute(current.path)
        ||!['open','mkdir','write','rename','copyfile','unlink','rmdir'].includes(current.syscall))continue;
      const target=path.resolve(current.path);
      const match=roots.find(([,root])=>target===root||path.dirname(target)===root);
      if(match)return {kind:'directory-write',directory:match[0]};
    }
    const technical=describeError(error);
    if(technical.error_source==='release_service'&&['release.download','release.request'].includes(technical.error_site)
      &&['dns_failed','connection_refused','network','timeout','http_forbidden','rate_limited','http_error'].includes(technical.error_code)){
      for(let current=error,depth=0;current&&typeof current==='object'&&depth<4;current=current.cause,depth++){
        if(technical.error_site==='release.download'){
          const resource=trustedResource(record,current.conditionResource);
          if(resource)return {kind:'release-read',resource,retryAt:current.conditionRetryAt??null};
        }else{
          const resource=trustedMetadata(record,current.conditionResource);
          if(resource)return {kind:'release-metadata',resource:{url:resource.url,routeHash:resource.routeHash,
            ...(resource.expectedVersion?{expectedVersion:resource.expectedVersion}:{})},retryAt:current.conditionRetryAt??null};
        }
      }
    }
    return null;
  }
  async function verifyNetworkRead(record,condition,baseline){
    const metadata=condition.kind==='release-metadata';
    const resource=metadata?trustedMetadata(record,condition.resource):trustedResource(record,condition.resource);
    if(!resource||condition.retryAt!==null&&(!Number.isSafeInteger(condition.retryAt)||now()<condition.retryAt))return null;
    const signal=AbortSignal.timeout(10000);
    let response,reader;
    try{
      const abort=new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
      const route=await Promise.race([networkFetch.conditionRoute?networkFetch.conditionRoute(resource.url):Promise.resolve('direct-node'),abort]);
      const routeHash=crypto.createHash('sha256').update(String(route)).digest('hex');
      const identity=conditionFingerprint(metadata?{url:resource.url,kind:'release-metadata'}:{url:resource.url,tag:resource.tag,asset:resource.asset,size:resource.size,sha256:resource.sha256});
      if(baseline.facts.networkReads.some(item=>item.identity===identity&&item.routeHash===routeHash&&item.readable))return null;
      if(baseline.facts.networkReads.length>=8&&!baseline.facts.networkReads.some(item=>item.identity===identity))return null;
      const end=metadata?null:Math.min(resource.size,1024)-1,maxBytes=metadata?4*1024*1024:end+1;
      const sources=sourceCandidates(resource.url,{channel:value(channel)}),deadline=Date.now()+10000;
      let selected;
      for(let index=0;index<sources.length;index++){
        const source=sources[index],remaining=deadline-Date.now();if(remaining<=0)return null;
        const attemptSignal=AbortSignal.any([signal,AbortSignal.timeout(Math.max(1,Math.ceil(remaining/(sources.length-index))))]);
        try{
          response=await fetchRead(networkFetch,source.url,{method:'GET',
            headers:metadata?{Accept:'application/vnd.github+json','Accept-Encoding':'identity'}:{Range:`bytes=0-${end}`,'Accept-Encoding':'identity'},
            signal:attemptSignal,credentials:'omit'},{source,maxAttempts:1,totalBudgetMs:remaining});
          validateSourceResponse(source,response);
          if(response.status===200||!metadata&&response.status===206){selected=source;break;}
          await response.body?.cancel();
          if(![403,404,408,410,429,500,502,503,504].includes(response.status))return null;
        }catch(error){
          if(!attemptSignal.aborted&&!['ENOTFOUND','ECONNREFUSED','ECONNRESET','ETIMEDOUT','TIMEOUT','EAI_AGAIN'].includes(error.code||error.cause?.code))return null;
        }
      }
      if(!selected)return null;
      const final=new URL(response.url||resource.url);
      if(final.protocol!=='https:'||final.username||final.password
        ||!selected.mirror&&!(metadata&&!resource.type?final.href===resource.url:['github.com','objects.githubusercontent.com','release-assets.githubusercontent.com'].includes(final.hostname))
        ||!metadata&&response.headers.get('content-encoding')&&!['identity'].includes(response.headers.get('content-encoding')))return null;
      if(metadata){if(response.status!==200)return null;}
      else if(response.status===206){if(response.headers.get('content-range')!==`bytes 0-${end}/${resource.size}`)return null;}
      else if(response.status!==200||resource.size>1024)return null;
      if(!response.body)return null;
      reader=response.body.getReader();let bytes=0;const parts=[];
      while(true){const chunk=await Promise.race([reader.read(),abort]);if(chunk.done)break;
        bytes+=chunk.value.byteLength;if(bytes>maxBytes)return null;parts.push(Buffer.from(chunk.value));}
      if(metadata){
        const result=JSON.parse(Buffer.concat(parts).toString('utf8')),releases=require('./releases');
        if(resource.type==='release-manifest'){
          if(result.launcherVersion!==undefined&&releases.compare(result.launcherVersion,result.launcherVersion)!==0)return null;
          releases.validateUpdate(result,{tag_name:resource.tag},result.launcherVersion||value(launcherVersion));
        }else if(resource.type==='system-manifest'){
          if(releases.compare(result.version,resource.tag)!==0)return null;
          releases.validateSystem(result,null,value(platform),value(arch),resource.expectedVersion,value(channel));
        }else if(resource.type==='launcher-manifest'){
          // This verifies the original metadata and its expected version. The
          // resumed selectPlan still verifies membership in the full release.
          const asset=result.asset;
          require('./launcher-update').validateManifest(result,{release:{tag_name:resource.tag,assets:[{name:asset,
            browser_download_url:`https://github.com/LoveMaker-art/noras-tavern/releases/download/${encodeURIComponent(resource.tag)}/${asset}`}]},
            manifest:{launcherVersion:resource.expectedVersion},platform:value(platform),arch:value(arch)});
        }else if(resource.list){if(!Array.isArray(result)||result.length>100||result.some(item=>!item||typeof item.tag_name!=='string'
          ||typeof item.draft!=='boolean'||typeof item.prerelease!=='boolean'||!Array.isArray(item.assets)))return null;}
        else if(!releases.accepts(result,value(channel))||resource.tag&&result.tag_name!==resource.tag||!Array.isArray(result.assets))return null;
      }else if(bytes!==end+1||resource.size<=1024&&crypto.createHash('sha256').update(Buffer.concat(parts)).digest('hex')!==resource.sha256)return null;
      const facts={...baseline.facts,networkReads:[...baseline.facts.networkReads.filter(item=>item.identity!==identity),{identity,routeHash,readable:true}].slice(-8)};
      return {schema:CONDITION_SCHEMA,facts,fingerprint:conditionFingerprint(facts)};
    }catch{return null;}
    finally{try{
      const cancelled=reader?reader.cancel():response?.body?.cancel();
      if(cancelled)await Promise.race([cancelled,signal.aborted?Promise.resolve():new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}))]);
    }catch{}}
  }
  const present=file=>{try{fs.lstatSync(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
  const regular=file=>{try{const stat=fs.lstatSync(file);return stat.isFile()&&!stat.isSymbolicLink();}
    catch(error){if(error.code==='ENOENT')return false;throw error;}};
  async function finalRuntimeStatus(context,port){
    context.check();
    if(present(value(hermesHome)))return bridge('status',{port},context);
    // A first-install rollback can remove Python itself. Its positive stop
    // proof and confirmed directory rollback are already held by this writer;
    // do not keep an intermediate bridge result which still saw that Python.
    const root=value(installRoot),noraHome=value(home);
    return {installed:regular(path.join(root,'apps/tavern-runtime/native-runtime.json'))
      &&regular(path.join(root,'apps/tavern-runtime/native_lifecycle.py')),
      hermesInstalled:false,noraInstalled:false,systemReady:false,setupCompleted:false,
      running:false,gatewayRunning:false,clawchatConnected:false,clawchatPaired:false,
      clawchatProfileReady:false,modelConfigured:false,modelSyncPending:false,
      port,home:noraHome,noraHome,hermesHome:value(hermesHome),installRoot:root};
  }
  const statusFlags=['installed','hermesInstalled','noraInstalled','systemReady','setupCompleted',
    'running','gatewayRunning','clawchatConnected'];
  const sameVersion=(left,right)=>String(left||'').replace(/^v/,'')===String(right||'').replace(/^v/,'');
  function servicePlan(record,result){
    const saved=record.result?.recoveryServiceState;
    const plan=saved||(result&&typeof result.running==='boolean'&&typeof result.gatewayRunning==='boolean'?{
      schema:'nora-recovery-services/1',operationId:record.operationId,version:String(result.version||''),
      running:result.running,gatewayRunning:result.gatewayRunning,clawchatConnected:result.clawchatConnected===true}:null);
    if(plan&&(plan.schema!=='nora-recovery-services/1'||plan.operationId!==record.operationId
      ||typeof plan.version!=='string'||plan.version.length>100
      ||['running','gatewayRunning','clawchatConnected'].some(key=>typeof plan[key]!=='boolean')
      ||(plan.running||plan.gatewayRunning)&&!plan.version))
      throw failure('VERIFICATION_FAILED','原有服务恢复计划无法核验，未改变服务。');
    return plan;
  }
  async function finishRuntimeRecovery(context,record,result,port){
    const plan=servicePlan(record,result),fileFacts={};
    for(const key of ['firstInstallRecovered','updateRecovered'])if(result?.[key]===true||record.result?.[key]===true)fileFacts[key]=true;
    if(plan)fileFacts.recoveryServiceState=plan;
    let current;
    const verifyStatus=state=>{
      if(!state||statusFlags.some(key=>typeof state[key]!=='boolean')||state.warningCode)
        throw failure('VERIFICATION_FAILED','文件已恢复，但当前服务状态尚未通过实际核验。');
      return state;
    };
    const matches=state=>!plan||(state.running===plan.running&&state.gatewayRunning===plan.gatewayRunning
      &&(!plan.clawchatConnected||state.clawchatConnected===true)
      &&(!plan.version||sameVersion(state.version,plan.version)));
    try{
      current=verifyStatus(await finalRuntimeStatus(context,port));
      if(!matches(current)&&(plan.running||plan.gatewayRunning)&&present(value(hermesHome))){
        const verified=await bridge('verify-current-update',{port,version:plan.version},context);
        if(verified?.updateVerified!==true||verified.systemReady!==true||!sameVersion(verified.version,plan.version))
          throw failure('VERIFICATION_FAILED','旧版本文件尚未通过固定版本核验，未启动服务。');
        await bridge('start',{port,service:plan.running&&plan.gatewayRunning?'all':plan.running?'tavern':'nora'},context);
        current=verifyStatus(await finalRuntimeStatus(context,port));
      }
      if(!matches(current))throw failure('VERIFICATION_FAILED','文件已恢复，但更新前的服务状态尚未恢复。');
      return {effectState:'restored',verification:'confirmed',value:{...fileFacts,...current,recoveryVerification:'confirmed'}};
    }catch(error){
      return {effectState:'restored',filesRestored:true,verification:'failed',
        secondaryErrors:[{operation:'verify-restored-services',error}],
        value:{...fileFacts,...(current||{}),recoveryVerification:'files-only',recoveryError:error.code||'VERIFICATION_FAILED'}};
    }
  }
  async function system(record){
    if(!present(firstJournal(record.operationId))&&!present(systemJournal()))
      return {effectState:'untouched',recoveryOutcome:'not-required',canRecover:false,reason:'no_journal'};
    const result=await bridge('operation-effects',{operationId:record.operationId,kind:record.kind==='install'?'install':'update'},null);
    return result.effects||{effectState:'unknown',recoveryOutcome:'recovery-required',canRecover:false};
  }
  function combine(parts){
    if(parts.some(part=>part.effectState==='unknown'))return {effectState:'unknown',recoveryOutcome:'recovery-required',canRecover:false};
    const changed=parts.filter(part=>part.effectState==='changed');
    const pending=parts.filter(part=>part.recoveryOutcome==='recovery-required');
    const filesOnly=parts.some(part=>part.recoveryOutcome==='files-restored-start-failed');
    if(changed.length&&!pending.length&&!filesOnly&&changed.every(part=>part.canResume===true))
      return {effectState:'changed',recoveryOutcome:'not-required',canResume:true,canRecover:false};
    if(changed.length)return {effectState:'changed',recoveryOutcome:'recovery-required',
      canRecover:changed.every(part=>part.canRecover===true||part.reason==='committed')&&pending.every(part=>part.canRecover===true)};
    const restored=parts.some(part=>part.effectState==='restored');
    if(pending.length)return {effectState:restored?'restored':'untouched',recoveryOutcome:'recovery-required',
      canRecover:pending.every(part=>part.canRecover===true)};
    return {effectState:restored?'restored':'untouched',
      recoveryOutcome:filesOnly?'files-restored-start-failed':restored?'restored-and-verified':'not-required',canRecover:false};
  }
  async function observe(record){
    if(!['install','update','repair','recover'].includes(record.kind))return {effectState:'untouched',recoveryOutcome:'not-required'};
    try{
      const parts=[inspectRuntime(locations(record.operationId)),await system(record)];
      const legacy=inspectLegacy();
      if(legacy)parts.push({effectState:legacy.canRecover?'changed':'unknown',canRecover:legacy.canRecover});
      if(record.handoffRef){
        const app=await inspectLauncher(record.handoffRef,record);
        parts.push(app?{effectState:app.effectState||'unknown',canRecover:app.canRecover,
          canResume:app.status==='awaiting-system'&&app.busy===false&&app.workerOffline===true,reason:app.reason}
          :{effectState:'unknown',canRecover:false});
      }
      return combine(parts);
    }catch{return {effectState:'unknown',recoveryOutcome:'recovery-required',canRecover:false};}
  }
  async function recover(context,options={}){
    context.check();
    await context.stage('recovering');
    const record=context.snapshot,port=record.target?.request?.port;
    if(record.handoffRef){
      const app=await inspectLauncher(record.handoffRef,record);
      if(!app||!safe.has(app.effectState))throw failure('LAUNCHER_RECOVERY_REQUIRED',
        '启动器程序替换仍需处理，请保留旧程序备份，通过启动器恢复入口继续。');
    }
    const legacy=inspectLegacy();
    if(legacy||record.result?.legacyFilesRestored===true){
      if(options.error)throw failure('UPDATE_RECOVERY_REQUIRED','旧更新仍需用户选择恢复，现有文件和备份已保留。');
      if(record.result?.legacyFilesRestored===true&&!legacy){
        const restored=record.result;
        const verified=await bridge('verify-current-update',{port:restored.port,version:restored.restoreVersion},context);
        const sameVersion=result=>String(result?.version||'').replace(/^v/,'')===String(restored.restoreVersion||'').replace(/^v/,'');
        if(verified?.updateVerified!==true||verified.systemReady!==true||!sameVersion(verified))
          throw failure('VERIFICATION_FAILED','旧版本文件尚未通过固定版本检查，未启动服务。');
        const started=await bridge('start',{service:'tavern',port:restored.port},context);
        if(started.running!==true||started.systemReady!==true||!sameVersion(started))
          throw failure('VERIFICATION_FAILED','旧版本文件已恢复，服务尚未通过启动检查。');
        return {effectState:'restored',verification:'confirmed',value:{...restored,...started,legacyServicesVerified:true,
          originalServiceState:'unrecorded',recoveryVerification:'confirmed'}};
      }
      if(legacy?.canRecover!==true||!runLegacy)throw failure('LEGACY_RECOVERY_UNSUPPORTED','旧更新记录无法核验，未覆盖当前文件。请保留安装、日志和备份。');
      const fixed=record.target?.legacyRecovery;
      if(fixed&&fixed.journalDigest!==legacy.journalDigest)throw failure('CONDITIONS_CHANGED','旧更新记录已变化，请重新检查恢复条件。');
      if(!fixed&&!record.target?.releasePlan)await context.plan({...context.target,legacyRecovery:{journalDigest:legacy.journalDigest,
        journalReference:legacy.journalReference,restoreVersion:legacy.restoreVersion,dataPolicy:legacy.dataPolicy}});
      await context.journal(legacy.journalReference);
      const stopped=await bridge('recovery-stop',{port},context);
      if(stopped.offline!==true||stopped.running!==false||stopped.gatewayRunning!==false)
        throw failure('VERIFICATION_FAILED','尚未确认服务已停止，未恢复旧文件。');
      const restored=await runLegacy(context,{journalDigest:legacy.journalDigest,offlineProof:{operationId:context.operationId,
        ownerEpoch:context.ownerEpoch,offline:true,running:false,gatewayRunning:false}});
      if(restored?.legacyFilesRestored!==true||restored.effectState!=='restored'||restored.recoveryVerification!=='files-only')
        throw failure('VERIFICATION_FAILED','旧文件恢复未返回受管确认，已保留现场。');
      return {effectState:'restored',filesRestored:true,verification:'failed',value:{...restored,originalServiceState:'unrecorded'}};
    }
    let systemResult;
    if(present(firstJournal(record.operationId))||present(systemJournal())){
      const facts=await system(record);
      if(facts.effectState==='unknown'||facts.effectState==='changed'&&facts.canRecover!==true)
        throw failure('UPDATE_RECOVERY_REQUIRED','恢复记录无法核验，未覆盖现有文件。请保留安装、数据和日志。');
      if(!safe.has(facts.effectState)||facts.recoveryOutcome==='files-restored-start-failed'){
        const command=present(firstJournal(record.operationId))?'recover-install':'recover-update';
        try{
          systemResult=await bridge(command,{operationId:record.operationId,port},context);
          if(systemResult.recoveryVerification!=='confirmed'||systemResult[command==='recover-install'?'firstInstallRecovered':'updateRecovered']!==true)
            throw failure('VERIFICATION_FAILED','恢复程序未返回有效的文件和服务验收结果。');
        }catch(error){
          const after=await system(record);
          if(after.effectState==='restored'&&after.recoveryOutcome==='files-restored-start-failed'){
            const runtimeAfter=inspectRuntime(locations(record.operationId));
            if(safe.has(runtimeAfter.effectState))return {filesRestored:true,verification:'failed',
              secondaryErrors:[{operation:'restore-service',error}],value:{recoveryError:error.code||'VERIFICATION_FAILED'}};
          }
          throw error;
        }
      }
    }
    const runtimeFacts=inspectRuntime(locations(record.operationId));
    if(runtimeFacts.effectState==='unknown')throw failure('RUNTIME_IDENTITY_UNKNOWN','诺拉核心恢复记录无法核验，未覆盖现有文件。');
    const runtimePending=runtimeFacts.effectState==='changed'||runtimeFacts.recoveryOutcome==='recovery-required';
    if(runtimePending){
      // Stop proof comes from the owned backend, not from a saved PID or a
      // best-effort false status. Its actual child closes before tree recovery.
      const stopped=await bridge('recovery-stop',{port},context);
      if(stopped.offline!==true||stopped.running!==false||stopped.gatewayRunning!==false)
        throw failure('VERIFICATION_FAILED','尚未确认服务已停止，未恢复诺拉核心。');
      await runRuntime(context,{recover:true,allowCommitted:true});
      const after=inspectRuntime(locations(record.operationId));
      if(!safe.has(after.effectState)||after.recoveryOutcome==='recovery-required')
        throw failure('UPDATE_RECOVERY_REQUIRED','诺拉核心恢复后仍有未确认的目录或运行检查。');
    }
    if(runtimePending||record.recoveryOutcome==='files-restored-start-failed')
      return finishRuntimeRecovery(context,record,systemResult,port);
    return {effectState:runtimeFacts.effectState==='untouched'&&!systemResult?'untouched':'restored',
      verification:'confirmed',value:{...(systemResult||{}),recoveryVerification:'confirmed'}};
  }
  async function recheck(record,context={}){
    const effects=await observe(record);
    if(!safe.has(effects.effectState)||effects.recoveryOutcome==='recovery-required')return {changed:false,...effects};
    const baseline=record.conditionBaseline,condition=context.conditionTarget
      ||(record.currentFailure||record.primaryFailure)?.conditionTarget
      ||identifyFailureCondition(record.currentFailure||record.primaryFailure,record);
    if(condition?.kind==='setup-ready'&&['start','restart'].includes(record.kind)
      &&record.target?.request?.service!=='tavern'&&['clawchatPaired','modelConfigured'].includes(condition.requirement)){
      // A typed missing-setup failure is the negative baseline. Only a real
      // status read can prove it is resolved. The same positive proof cannot
      // replenish the budget repeatedly if the subsequent start still fails.
      const status=await bridge('status',{port:record.target?.request?.port});
      if(status?.systemReady!==true||status[condition.requirement]!==true)return {changed:false,...effects};
      const facts={setup:{requirement:condition.requirement,satisfied:true}};
      const proof={schema:CONDITION_SCHEMA,facts,fingerprint:conditionFingerprint(facts)};
      const changed=proof.fingerprint!==record.conditionFingerprint;
      return {changed,fingerprint:proof.fingerprint,...(changed?{baseline:proof}:{}),...effects};
    }
    if(!validConditions(baseline))return {changed:false,...effects};
    if(['release-read','release-metadata'].includes(condition?.kind)){
      const proof=await verifyNetworkRead(record,condition,baseline);
      return proof?{changed:true,fingerprint:proof.fingerprint,baseline:proof,...effects}:{changed:false,...effects};
    }
    if(condition?.kind!=='directory-write')return {changed:false,...effects};
    const current=await initialConditions(record,context);
    if(!current)return {changed:false,...effects};
    const before=baseline.facts.directories.find(item=>item.name===condition.directory);
    const after=current.facts.directories.find(item=>item.name===condition.directory);
    const improved=before?.writable===false&&after?.writable===true&&before.identity!==null
      &&JSON.stringify(before.identity)===JSON.stringify(after.identity);
    const facts={...current.facts,networkReads:baseline.facts.networkReads};
    const proof={schema:CONDITION_SCHEMA,facts,fingerprint:conditionFingerprint(facts)};
    return {changed:improved,fingerprint:proof.fingerprint,...(improved?{baseline:proof}:{}),...effects};
  }
  return {observe,recover,recheck,initialConditions,identifyFailureCondition};
}
module.exports={create,inspectConditions};
