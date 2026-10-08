const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { presentError } = require('./error-presentation');
const {describeError}=require('./launcher-errors');
const {failureActions}=require('./operation-result');
const {OPERATION_BUDGET}=require('./evidence-store');

const SCHEMA = 'nora-operation/1';
const TERMINAL = new Set(['succeeded','failed','cancelled','rolled-back','blocked']);
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STAGES = new Set(['selecting','downloading','staged','prepared','applying','verifying','committing','recovering']);
const RETENTION=Object.freeze({detailDays:30,fullRecords:256,facts:OPERATION_BUDGET.historyCapacity,stopReserve:OPERATION_BUDGET.stopReserve});
const fail = (code, message) => Object.assign(new Error(message), { code });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function canonical(value){
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}
// Admission compares the selected program content. Lookup timestamps and GitHub
// counters remain in the immutable plan, but cannot grant another unsafe try.
function retryIdentity(target){
  const plan=target?.releasePlan;
  if(!plan)return digest(canonical(target));
  const {tag:requestedTag,...request}=target.request||{};
  return digest(canonical({request,release:{schema:plan.schema,mode:plan.mode,tag:plan.tag,
    channel:plan.channel,platform:plan.platform,arch:plan.arch,commit:plan.commit,
    manifest:plan.releaseManifest||plan.manifestSha256||plan.systemManifestSha256,
    launcher:plan.launcherManifest||null,system:plan.systemManifest||null}}));
}
const failedAttempt=record=>record&&record.state!=='succeeded'&&Boolean(record.primaryFailure);

// The operation record stores references and outcomes. File swap inventories
// and installed-version truth stay in their journal and receipt owners.
function createOperationController({directory,lock,executors={},recoverers={},recheckers={},captureConditions,identifyFailureCondition,evidence,
  observeEffects,now=()=>new Date().toISOString(),projectResult=value=>value,
  verifyResult=result=>result?.verification==='confirmed',verifyHandoff,verifyRecoveryHandoff,retention={}}={}) {
  if(!lock?.acquire||!lock?.probe)throw new TypeError('An OS lock adapter is required');
  const root=()=>path.join(typeof directory==='function'?directory():directory,'operations');
  const budget={...RETENTION,...retention};let cachedRecords,cachedGeneration;
  const generationFile=()=>path.join(root(),'.history-generation.json');
  function generation(){
    try{const file=generationFile(),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>256)return null;
      const value=JSON.parse(fs.readFileSync(file,'utf8'));return value.schema===1&&ID.test(value.id)&&value.writing===false?value.id:null;
    }catch{return null;}
  }
  const file=id=>{if(!ID.test(id))throw fail('OPERATION_INVALID_ID','Invalid operation ID');return path.join(root(),id,'operation.json');};
  function recordPath(id){
    const target=file(id),base=root();
    for(const part of [base,path.dirname(target)]){
      const stat=fs.lstatSync(part);
      if(!stat.isDirectory()||stat.isSymbolicLink())throw fail('OPERATION_RECORD_INVALID','Operation directory identity is not supported');
    }
    const stat=fs.lstatSync(target,{throwIfNoEntry:false});
    if(stat&&(!stat.isFile()||stat.isSymbolicLink()||stat.size>256*1024))throw fail('OPERATION_RECORD_INVALID','Operation record identity or size is not supported');
    return target;
  }
  const read=id=>{
    const fd=fs.openSync(recordPath(id),fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
    let value;try{
      const stat=fs.fstatSync(fd);
      if(!stat.isFile()||stat.size>256*1024)throw fail('OPERATION_RECORD_INVALID','Operation record is not supported');
      const contents=Buffer.alloc(256*1024+1),size=fs.readSync(fd,contents,0,contents.length,0);
      if(size>256*1024)throw fail('OPERATION_RECORD_INVALID','Operation record is too large');
      value=JSON.parse(contents.subarray(0,size).toString('utf8'));
    }finally{fs.closeSync(fd);}
    if(value.schema!==SCHEMA||value.operationId!==id||!Number.isSafeInteger(value.sequence)
      ||value.sequence<0||!Number.isSafeInteger(value.ownerEpoch)||typeof value.createdAt!=='string'
      ||!Number.isFinite(Date.parse(value.createdAt))||!value.target||typeof value.target!=='object')
      throw fail('OPERATION_RECORD_INVALID','Operation record is not supported');
    return value;
  };
  function readonlyArtifact(id){
    try{
      const directory=path.dirname(file(id));
      if(fs.lstatSync(directory).isSymbolicLink()||fs.readdirSync(directory).some(name=>name!=='evidence'))return false;
      const target=path.join(directory,'evidence');if(fs.lstatSync(target).isSymbolicLink())return false;
      const names=fs.readdirSync(target);if(names.some(name=>!['metadata.json','events.jsonl'].includes(name)))return false;
      const metadata=path.join(target,'metadata.json'),stat=fs.lstatSync(metadata);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>256*1024)return false;
      const saved=JSON.parse(fs.readFileSync(metadata,'utf8'));
      const events=fs.lstatSync(path.join(target,'events.jsonl'),{throwIfNoEntry:false});
      return saved.schema===1&&saved.operationId===id&&saved.action==='none'&&saved.primary===null
        &&Array.isArray(saved.events)&&saved.events.length===0&&Array.isArray(saved.secondary)&&saved.secondary.length===0
        &&(!events||events.isFile()&&!events.isSymbolicLink()&&events.size===0);
    }catch{return false;}
  }
  function records(){
    const current=generation();if(current&&cachedGeneration===current&&cachedRecords)return cachedRecords;
    let names;try{names=fs.readdirSync(root());}catch(error){if(error.code==='ENOENT')return [];throw error;}
    names=names.filter(name=>ID.test(name));
    if(names.length>budget.facts+budget.stopReserve)throw fail('OPERATION_HISTORY_CAPACITY','操作记录容量已满。未完成事务、备份和待确认诊断已保留，请查看日志并联系维护者。');
    const values=names.flatMap(id=>{
      try{return [read(id)];}catch(error){if(error.code==='ENOENT'&&readonlyArtifact(id))return [];throw error;}
    }).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.ownerEpoch-b.ownerEpoch||a.sequence-b.sequence);
    const after=generation();if(current&&current===after){cachedGeneration=current;cachedRecords=values;}else{cachedGeneration=null;cachedRecords=null;}
    return values;
  }
  const nextEpoch=id=>id?Math.max(Date.now(),read(id).ownerEpoch)+1:records().reduce((epoch,record)=>Math.max(epoch,record.ownerEpoch),Date.now())+1;
  async function write(record,lease,{expected={ownerEpoch:record.ownerEpoch,sequence:record.sequence},capture,archive=false}={}){
    if(typeof lease?.commitOperation!=='function')throw fail('OPERATION_COMMIT_REQUIRED','The native writer must commit operation records');
    const proposed={...record,updatedAt:now(),sequence:record.sequence+1};
    if(Buffer.byteLength(JSON.stringify(proposed))>256*1024)throw fail('OPERATION_RECORD_INVALID','Operation record is too large');
    const committed=await lease.commitOperation({record:JSON.parse(JSON.stringify(proposed)),expected,
      evidence:capture?.snapshot?.(),archive});
    Object.assign(record,committed.record);const id=committed.generation;
    if(cachedRecords){cachedRecords=cachedRecords.filter(value=>value.operationId!==record.operationId).concat(JSON.parse(JSON.stringify(record)))
      .sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.ownerEpoch-b.ownerEpoch||a.sequence-b.sequence);cachedGeneration=id;}
  }
  async function reclaim(kind,lease){
    const history=records(),latest=history.at(-1)?.operationId,cutoff=Date.parse(now())-budget.detailDays*86400000;
    let full=history.filter(record=>!record.archived).length;
    for(const record of history){
      if(record.archived||record.operationId===latest||Date.parse(record.updatedAt)>cutoff&&full<budget.fullRecords||!TERMINAL.has(record.state)
        ||!['untouched','restored'].includes(record.effectState)||record.handoffRef
        ||record.effectState==='restored'&&record.verification!=='confirmed'
        ||['recovery-required','files-restored-start-failed'].includes(record.recoveryOutcome)
        ||!evidence?.canArchive?.(record.operationId))continue;
      if(observeEffects){const facts=await observeEffects(record);if(!['untouched','restored'].includes(facts.effectState)
        ||['recovery-required','files-restored-start-failed'].includes(facts.recoveryOutcome))continue;}
      const summary={};
      for(const key of ['schema','operationId','requestId','requestDigest','retryTargetDigest','kind','planDigest','conditionFingerprint',
        'ownerEpoch','sequence','createdAt','updatedAt','state','stageId','attempt','totalAttempts','effectState','recoveryOutcome','verification'])
        if(record[key]!==undefined)summary[key]=record[key];
      summary.target={};summary.archived=true;summary.archivedAt=now();summary.secondaryFailures=[];summary.evidenceStatus='archived';
      summary.retryTargetDigest=record.retryTargetDigest||retryIdentity(record.target);
      summary.requestDigest=record.requestDigest||record.planDigest;
      if(record.primaryFailure)summary.primaryFailure={code:record.primaryFailure.code,site:record.primaryFailure.site};
      if(record.currentFailure)summary.currentFailure={code:record.currentFailure.code,site:record.currentFailure.site};
      if(record.result&&Buffer.byteLength(JSON.stringify(record.result))<=2048)summary.result=record.result;
      if(Buffer.byteLength(JSON.stringify(summary))>4096)continue;
      await write(summary,lease,{archive:true});full--;
    }
    const kept=records(),ordinary=!['stop','shutdown'].includes(kind);
    if(kept.length>=budget.facts+(ordinary?0:budget.stopReserve)||ordinary&&kept.filter(record=>!record.archived).length>=budget.fullRecords)
      throw fail('OPERATION_HISTORY_CAPACITY','操作记录容量已满。未完成事务、备份和待确认诊断已保留，请查看日志并联系维护者。');
  }
  function conditionProof(value){
    if(value==null)return null;
    if(value.schema!=='nora-operation-conditions/1'||!/^[a-f0-9]{64}$/.test(value.fingerprint||'')
      ||!value.facts||typeof value.facts!=='object'||Array.isArray(value.facts)||Buffer.byteLength(JSON.stringify(value))>8192)
      throw fail('OPERATION_CONDITIONS_INVALID','Operation conditions proof is not supported');
    return JSON.parse(JSON.stringify(value));
  }
  function failureCondition(record){
    const current=record.currentFailure||record.primaryFailure;
    if(current?.conditionTarget)return current.conditionTarget;
    if(current?.code!=='RETRY_CONDITIONS_UNCHANGED')return identifyFailureCondition?.(current,record);
    // Old admission blocks did not preserve the original typed setup failure.
    // Consult only the latest actual failure for this exact target; never infer
    // changed conditions from a different service or an arbitrary old error.
    const previous=records().filter(value=>value.operationId!==record.operationId&&value.kind===record.kind
      &&Date.parse(value.createdAt)<=Date.parse(record.createdAt)
      &&(value.retryTargetDigest||retryIdentity(value.target))===(record.retryTargetDigest||retryIdentity(record.target))
      &&failedAttempt(value)&&(value.currentFailure||value.primaryFailure)?.code!=='RETRY_CONDITIONS_UNCHANGED').at(-1);
    return previous?failureCondition(previous):null;
  }
  function failure(error,kind,record){
    const detail={code:/^[A-Z][A-Z0-9_]{0,99}$/.test(error?.userCode||error?.code||'')?error.userCode||error.code:'UNKNOWN_PROGRAM_ERROR',
      site:/^[a-z][a-z0-9_.-]{0,99}$/.test(error?.site||'')?error.site:'launcher.operation',
      technical:describeError(error),
      guidance:presentError(error,{action:kind})};
    if(record)try{
      const target=error?.code==='RETRY_CONDITIONS_UNCHANGED'?error.retryConditionTarget:identifyFailureCondition?.(error,record);
      if(target?.kind==='directory-write'&&['hermesHome','installRoot','noraHome'].includes(target.directory))
        detail.conditionTarget={kind:target.kind,directory:target.directory};
      else if(target?.kind==='setup-ready'&&['clawchatPaired','modelConfigured'].includes(target.requirement))
        detail.conditionTarget={kind:target.kind,requirement:target.requirement};
      else if(target?.kind==='release-read'){
        const resource=target.resource,url=new URL(resource?.url),label=value=>typeof value==='string'&&value.length>0&&value.length<=240&&!/[\x00-\x1f\x7f]/.test(value);
        if(url.origin==='https://github.com'&&!url.username&&!url.password&&!url.search&&!url.hash
          &&label(resource.tag)&&label(resource.asset)&&!/[\\/]/.test(resource.asset)
          &&url.pathname===`/LoveMaker-art/noras-tavern/releases/download/${encodeURIComponent(resource.tag)}/${encodeURIComponent(resource.asset)}`
          &&Number.isSafeInteger(resource.size)&&resource.size>=1&&/^[a-f0-9]{64}$/.test(resource.sha256||'')
          &&/^[a-f0-9]{64}$/.test(resource.routeHash||'')
          &&(target.retryAt===null||Number.isSafeInteger(target.retryAt)&&target.retryAt>=0))
          detail.conditionTarget={kind:target.kind,resource:{url:url.href,tag:resource.tag,asset:resource.asset,
            size:resource.size,sha256:resource.sha256,routeHash:resource.routeHash},retryAt:target.retryAt};
      }
      else if(target?.kind==='release-metadata'){
        const resource=target.resource,url=new URL(resource?.url),base='/repos/LoveMaker-art/noras-tavern/releases';
        let origin='https://api.github.com',expectedVersion;
        let allowed=url.pathname===base+'/latest'&&!url.search
          ||url.pathname===base&&/^\?per_page=100&page=[1-5]$/.test(url.search);
        if(url.pathname.startsWith(base+'/tags/')&&!url.search){
          const encoded=url.pathname.slice((base+'/tags/').length),tag=decodeURIComponent(encoded);
          allowed=encodeURIComponent(tag)===encoded&&require('./releases').compare(tag,tag)===0;
        }
        if(url.origin==='https://github.com'&&!url.search){
          const parts=url.pathname.split('/'),tag=decodeURIComponent(parts[5]||''),asset=parts[6];
          origin='https://github.com';
          allowed=parts.length===7&&parts.slice(0,5).join('/')==='/LoveMaker-art/noras-tavern/releases/download'
            &&encodeURIComponent(tag)===parts[5]&&require('./releases').compare(tag,tag)===0
            &&/^(?:release-manifest|nora-(?:system|launcher)-(?:darwin-(?:arm64|x64)|win32-x64))\.json$/.test(asset);
          if(allowed&&asset.startsWith('nora-')){
            allowed=typeof resource.expectedVersion==='string'&&resource.expectedVersion.length<=240
              &&require('./releases').compare(resource.expectedVersion,resource.expectedVersion)===0;
            if(allowed)expectedVersion=resource.expectedVersion;
          }
        }
        if(allowed&&url.origin===origin&&!url.username&&!url.password&&!url.hash
          &&url.href.length<=512&&/^[a-f0-9]{64}$/.test(resource.routeHash||'')
          &&(target.retryAt===null||Number.isSafeInteger(target.retryAt)&&target.retryAt>=0))
          detail.conditionTarget={kind:target.kind,resource:{url:url.href,routeHash:resource.routeHash,...(expectedVersion?{expectedVersion}:{})},retryAt:target.retryAt};
      }
    }catch{}
    return detail;
  }
  function dto(record,fields={}){
    let allowedActions;
    if(record.archived)allowedActions=['logs'];
    else if(fields.busy)allowedActions=['wait','logs'];
    else if(record.recoveryOutcome==='files-restored-start-failed')allowedActions=(record.restoredStartAttempts||0)>=2?['recheck','logs']:['start-restored','recheck','logs'];
    else if(record.recoveryOutcome==='recovery-required')allowedActions=record.canRecover===false?['recheck','logs']:['recover','recheck','logs'];
    else if(record.effectState==='unknown')allowedActions=['recheck','logs'];
    else if(record.canResume===true)allowedActions=['resume','recheck','logs'];
    else if(record.handoffRef&&['awaiting-handoff','interrupted'].includes(record.state))allowedActions=['recheck','logs'];
    else if(record.state==='blocked')allowedActions=['recheck','logs'];
    else if(record.state==='interrupted')allowedActions=record.effectState==='untouched'?['resume','recheck','logs']:['recheck','logs'];
    else if(record.effectState==='changed')allowedActions=['recheck','logs'];
    else if(record.state==='failed'||record.state==='cancelled'||record.state==='rolled-back')allowedActions=record.attempt>=2?['recheck','logs']:['retry','recheck','logs'];
    else allowedActions=['recheck','logs'];
    if(record.kind==='pair'||record.kind==='model'&&record.target?.request?.mode==='configure')
      allowedActions=allowedActions.filter(action=>!['retry','resume'].includes(action));
    allowedActions=failureActions((record.currentFailure||record.primaryFailure)?.code,{operation:{...record,busy:fields.busy,allowedActions}})||allowedActions;
    return {schema:SCHEMA,operationId:record.operationId,requestId:record.requestId,kind:record.kind,
      snapshotSequence:record.sequence,ownerEpoch:record.ownerEpoch,state:record.state,stageId:record.stageId,
      target:record.target,planDigest:record.planDigest,attempt:record.attempt,totalAttempts:record.totalAttempts||1,
      restoredStartAttempts:record.restoredStartAttempts||0,effectState:record.effectState,
      failureCode:record.state==='succeeded'?'':(record.currentFailure||record.primaryFailure)?.code||'',
      primaryFailure:record.primaryFailure||null,currentFailure:record.currentFailure||null,
      secondaryFailures:record.secondaryFailures||[],primaryFailureRef:record.evidenceRef||null,
      recoveryOutcome:record.recoveryOutcome||'not-required',verification:record.verification||'unconfirmed',
      evidenceStatus:record.evidenceStatus||'not-needed',evidenceMissingReasons:record.evidenceMissingReasons||[],journalRefs:record.journalRefs||[],
      handoffRef:record.handoffRef||null,result:record.result,archived:record.archived===true,allowedActions,...fields};
  }
  async function snapshot(id){
    if(!id){
      const history=records();
      // A later safe service stop must not hide a still unresolved file effect.
      // This selection stays read-only and uses the journals' actual facts.
      for(const pending of history.slice().reverse().filter(value=>!TERMINAL.has(value.state)
        ||['recovery-required','files-restored-start-failed'].includes(value.recoveryOutcome))){
        const observed=await snapshot(pending.operationId);
        if(observed.busy||['changed','unknown'].includes(observed.effectState)
          ||observed.recoveryOutcome==='files-restored-start-failed')return observed;
      }
      id=history.at(-1)?.operationId;
    }
    const record=id?read(id):null;
    if(!record)return null;
    const observed=await lock.probe({directory:typeof directory==='function'?directory():directory,operationId:record.operationId});
    const fields={busy:Boolean(observed.busy)};
    if((!TERMINAL.has(record.state)||record.recoveryOutcome==='recovery-required')&&!observed.busy){
      const effects=observeEffects?await observeEffects(record):{effectState:record.effectState==='untouched'?'untouched':'unknown'};
      return dto({...record,state:'interrupted',...effects},fields);
    }
    return dto(record,fields);
  }
  async function execute(record,options,lease,mode,initialConditions){
    const epoch=record.ownerEpoch;let closed=false,failureUnpersisted=false;
    const startingRestored=mode==='recover'&&record.recoveryOutcome==='files-restored-start-failed';
    const saved=evidence?.begin({action:record.kind,runId:record.requestId,operationId:record.operationId,memoryOnly:true});
    const persist=()=>write(record,lease,{capture:saved});
    function check(){
      if(closed||read(record.operationId).ownerEpoch!==epoch)throw fail('OPERATION_STALE_EVENT','Operation already ended or its writer changed');
      lease.assertActive?.();
    }
    async function update(fields){
      check();Object.assign(record,fields);await persist();
    }
    async function persistFailure({release=false}={}){
      let reason='WRITER_UNAVAILABLE',replacement,persisted=false;
      if(!release)try{await persist();return true;}
      catch(commitError){
        closed=true;
        record.secondaryFailures.push({...failure(commitError,record.kind),operation:'record-failure'});
        saved?.freeze({secondaryErrors:[{operation:'record-failure',error:commitError}]});
      }
      try{
        replacement=await lock.acquire({directory:typeof directory==='function'?directory():directory,
          operationId:record.operationId,ownerEpoch:epoch});
        const current=read(record.operationId);
        if(current.ownerEpoch!==epoch){reason='OWNER_CHANGED';return false;}
        // An ACK may have been lost after rename. Preserve the actual committed
        // target/sequence and first cause instead of replaying an obsolete copy.
        const local=record;
        record={...current,primaryFailure:current.primaryFailure||local.primaryFailure,currentFailure:local.currentFailure,
          secondaryFailures:[...(current.secondaryFailures||[]),...(local.secondaryFailures||[])],
          state:'failed',verification:'unconfirmed',effectState:'unknown',recoveryOutcome:'recovery-required'};
        await write(record,replacement,{capture:saved});persisted=true;return true;
      }catch(admissionError){
        record.secondaryFailures.push({...failure(admissionError,record.kind),operation:'record-failure-admission'});
        return false;
      }finally{
        if(replacement)try{await replacement.release();}
        catch(closeError){record.secondaryFailures.push({...failure(closeError,record.kind),operation:'release-failure-writer'});}
        if(!persisted){
          failureUnpersisted=true;
          record.evidenceMissingReasons=[...new Set([...(record.evidenceMissingReasons||[]),
            `${release?'release':'operation'}_failure_unpersisted:${reason}`])];
        }
      }
    }
    const context={operationId:record.operationId,ownerEpoch:epoch,lease,get target(){return JSON.parse(JSON.stringify(record.target));},
      get snapshot(){return dto(record);},
      plan:async target=>{
        const planDigest=digest(target);
        if(record.planSelected){if(record.planDigest!==planDigest)throw fail('OPERATION_PLAN_CHANGED','A running operation cannot select a different release');return;}
        const retryTargetDigest=retryIdentity(target);
        const prior=records().filter(value=>value.operationId!==record.operationId&&value.kind===record.kind
          &&(value.retryTargetDigest||retryIdentity(value.target))===retryTargetDigest).at(-1);
        if(failedAttempt(prior)&&(initialConditions||prior.conditionBaseline!==undefined)
          ||!initialConditions&&prior?.conditionBaseline!==undefined){
          record.conditionBaseline=prior.conditionBaseline;
          record.conditionFingerprint=prior.conditionFingerprint||'';
        }else if(initialConditions){
          const selectedConditions=prior?conditionProof(await captureConditions?.(record,{...options,lease,previous:prior,baseline:initialConditions}))||initialConditions:initialConditions;
          record.conditionBaseline=selectedConditions;
          record.conditionFingerprint=selectedConditions.fingerprint;
        }
        const previous=records().filter(value=>value.operationId!==record.operationId&&value.kind===record.kind
          &&(value.retryTargetDigest||retryIdentity(value.target))===retryTargetDigest
          &&value.conditionFingerprint===record.conditionFingerprint).at(-1);
        await update({target:JSON.parse(JSON.stringify(target)),planDigest,retryTargetDigest,planSelected:true,attempt:failedAttempt(previous)?previous.attempt+1:1});
        if(failedAttempt(previous)&&previous.attempt>=2){
          const error=fail('RETRY_CONDITIONS_UNCHANGED','Same target and conditions have already failed twice');
          error.retryConditionTarget=failureCondition(previous);throw error;
        }
      },
      stage:async(stageId,details={})=>{if(!STAGES.has(stageId))throw fail('OPERATION_INVALID_STAGE','Invalid operation stage');await update({state:stageId,stageId});saved?.observe({event:'stage',task:stageId,...details});},
      effect:async effectState=>{if(!['untouched','changed','restored','unknown'].includes(effectState))throw fail('OPERATION_INVALID_EFFECT','Invalid effect state');await update({effectState});},
      journal:async(reference)=>{if(typeof reference!=='string'||reference.length>4096)throw fail('OPERATION_INVALID_JOURNAL','Invalid journal reference');await update({journalRefs:[...new Set([...(record.journalRefs||[]),reference])]});},
      handoff:async(reference)=>{if(typeof reference!=='string'||reference.length>4096)throw fail('OPERATION_INVALID_HANDOFF','Invalid handoff reference');await update({state:'awaiting-handoff',handoffRef:reference});},
      observe:message=>saved?.observe(message),
      delivery:summary=>evidence?.updateDelivery(record.operationId,summary),
      check,
    };
    try{
      const executor=mode==='recover'?(options.prepareHandoff||recoverers[record.kind]):(options.execute||executors[record.kind]);
      if(typeof executor!=='function')throw fail('OPERATION_UNSUPPORTED','Operation has no supported executor');
      const result=await executor(context,options);
      if(result?.handoff===true){
        if(record.state!=='awaiting-handoff'||!record.handoffRef)throw fail('OPERATION_INVALID_HANDOFF','A durable handoff is required');
        record.result=projectResult(result,record.kind);record.verification='unconfirmed';
        saved?.finish({outcome:'handoff'});await persist();
      }else{
      const recoveryMode=mode==='recover'||record.kind==='recover';
      const filesOnly=recoveryMode&&result?.filesRestored===true&&result?.verification==='failed';
      if(!filesOnly&&!await verifyResult(result,record.kind,mode))throw fail('VERIFICATION_FAILED','The operation did not return verified workflow evidence');
      record.result=projectResult(result,record.kind);
      record.state=recoveryMode?'rolled-back':'succeeded';
      record.currentFailure=null;
      record.verification=filesOnly?'failed':'confirmed';
      if(recoveryMode){record.effectState=result?.effectState==='untouched'?'untouched':'restored';
        record.recoveryOutcome=record.effectState==='untouched'?'not-required':filesOnly?'files-restored-start-failed':'restored-and-verified';}
      if(Array.isArray(result?.secondaryErrors)){
        record.secondaryFailures.push(...result.secondaryErrors.map(item=>({...failure(item.error,record.kind),operation:item.operation||'recover'})));
        saved?.freeze({secondaryErrors:result.secondaryErrors});
      }
      saved?.finish({outcome:record.state});await persist();
      }
    }catch(error){
      // Save the first cause while its files still exist. Recovery errors are
      // secondary and can never turn a failed operation into a success.
      record.currentFailure=failure(error,record.kind,record);
      if(!record.primaryFailure){record.primaryFailure=record.currentFailure;record.failureSignature=digest(record.primaryFailure);}
      const frozen=saved?.freeze({error,outcome:'failed',context:{stage:record.stageId,planId:record.planDigest}});
      record.evidenceStatus=!frozen?'missing':frozen.missingReasons?.some(value=>value.startsWith('save_failed:'))?'save-failed':frozen.truncated?'saved-truncated':'saved';
      record.evidenceMissingReasons=frozen?.missingReasons||[];
      record.evidenceRef=saved?.directory||null;
      record.state=error?.code==='RETRY_CONDITIONS_UNCHANGED'?'blocked':error?.name==='AbortError'||error?.code==='ABORT_ERR'?'cancelled':'failed';
      await persistFailure();
      if(!closed){
      try{await options.onFailure?.(error,context);}
      catch(reportError){record.secondaryFailures.push({...failure(reportError,record.kind),operation:'report-failure'});await persistFailure();}
      if(!closed&&record.effectState!=='untouched'){
        const recover=recoverers[record.kind];
        record.recoveryOutcome=startingRestored&&record.effectState==='restored'?'files-restored-start-failed':'recovery-required';
        if(record.recoveryOutcome==='files-restored-start-failed')record.verification='failed';
        await persist();
        if(mode!=='recover'&&record.kind!=='recover'&&recover){
          await update({state:'recovering',stageId:'recovering'});
          try{
            const restored=await recover(context,{...options,error});
            if(!await verifyResult(restored,record.kind,'recover')
              &&!(restored?.filesRestored===true&&restored?.verification==='failed'))
              throw fail('VERIFICATION_FAILED','Recovery did not return verified file and service evidence');
            record.effectState=restored?.effectState==='untouched'?'untouched':'restored';
            record.state=record.effectState==='untouched'?'failed':'rolled-back';
            record.recoveryOutcome=record.effectState==='untouched'?'not-required':restored?.verification==='failed'?'files-restored-start-failed':'restored-and-verified';
            record.verification=record.effectState==='untouched'?'unconfirmed':restored?.verification==='failed'?'failed':'confirmed';
            record.result=projectResult(restored,record.kind);
            if(Array.isArray(restored?.secondaryErrors)){
              record.secondaryFailures.push(...restored.secondaryErrors.map(item=>({...failure(item.error,record.kind),operation:item.operation||'recover'})));
              saved?.freeze({secondaryErrors:restored.secondaryErrors});
            }
          }catch(recoveryError){
            record.secondaryFailures.push({...failure(recoveryError,record.kind),operation:'recover'});
            saved?.freeze({secondaryErrors:[{operation:'recover',error:recoveryError}]});
            record.state='failed';
          }
          await persistFailure();
        }
      }
      saved?.finish({outcome:record.state});if(!closed)await persistFailure();
      }
    }finally{
      closed=true;
      try{await lease.release();}
      catch(error){
        const detail={...failure(error,record.kind),operation:'release'};
        if(!record.primaryFailure)record.primaryFailure=detail;
        else record.secondaryFailures.push(detail);
        record.currentFailure=detail;record.state='failed';record.verification='unconfirmed';
        record.effectState='unknown';record.recoveryOutcome='recovery-required';
        saved?.freeze({error,outcome:'failed'});
        if(!await persistFailure({release:true}))failureUnpersisted=true;
      }
    }
    return dto(record,failureUnpersisted?{allowedActions:['recheck','logs']}:{});
  }
  async function start(kind,options={},requestId){
    if(!/^[a-z][a-z_-]{0,39}$/.test(kind)||!/^[-\w]{1,100}$/.test(requestId||''))throw fail('OPERATION_REQUEST_INVALID','Invalid operation request');
    const existing=records().find(record=>record.requestId===requestId);
    const target=options.target||{};
    const targetDigest=digest(target);
    if(existing){
      if(existing.kind!==kind||(existing.requestDigest||existing.planDigest)!==targetDigest)throw fail('OPERATION_REQUEST_CONFLICT','A request ID cannot choose another operation target');
      return snapshot(existing.operationId);
    }
    const operationId=randomUUID(),ownerEpoch=nextEpoch();
    const lease=await lock.acquire({directory:typeof directory==='function'?directory():directory,operationId,ownerEpoch});
    let record,initialConditions;
    try{
      // Recheck after acquiring the real writer lock. Another window may have
      // committed the request between the first read and lock acquisition.
      const committed=records().find(value=>value.requestId===requestId);
      if(committed){
        if(committed.kind!==kind||(committed.requestDigest||committed.planDigest)!==targetDigest)
          throw fail('OPERATION_REQUEST_CONFLICT','A request ID cannot choose another operation target');
        await lease.release();return snapshot(committed.operationId);
      }
      await reclaim(kind,lease);
      // A positively owned stop remains available while files need recovery.
      // It still acquires the same native lock and may not guess process identity.
      for(const unfinished of ['stop','shutdown'].includes(kind)?[]:records().filter(value=>!TERMINAL.has(value.state)
        ||['recovery-required','files-restored-start-failed'].includes(value.recoveryOutcome))){
        const effects=observeEffects?await observeEffects(unfinished):{effectState:unfinished.effectState==='untouched'?'untouched':'unknown'};
        if(!['untouched','restored'].includes(effects.effectState)
          ||['recovery-required','files-restored-start-failed'].includes(effects.recoveryOutcome)){
          const error=fail('UPDATE_RECOVERY_REQUIRED','Existing active effects require inspection before another operation');
          error.operation=dto({...unfinished,state:'interrupted',...effects});throw error;
        }
      }
      const retryTargetDigest=retryIdentity(target);
      const candidates=records().filter(value=>value.kind===kind&&(value.retryTargetDigest||retryIdentity(value.target))===retryTargetDigest);
      record={schema:SCHEMA,operationId,requestId,kind,target:JSON.parse(JSON.stringify(target)),planDigest:targetDigest,requestDigest:targetDigest,
        retryTargetDigest,
        ownerEpoch,sequence:0,createdAt:now(),updatedAt:now(),state:'selecting',stageId:'selecting',
        attempt:1,totalAttempts:1,conditionFingerprint:options.conditionFingerprint||'',effectState:'untouched',secondaryFailures:[]};
      const prior=candidates.at(-1);
      initialConditions=conditionProof(await captureConditions?.(record,{...options,lease,previous:prior}));
      // Service commands do not capture a maintenance baseline. Keep the last
      // verified setup proof after success rather than reviving older failures.
      if(failedAttempt(prior)&&(initialConditions||prior.conditionBaseline!==undefined)
        ||!initialConditions&&prior?.conditionBaseline!==undefined){
        record.conditionBaseline=prior.conditionBaseline;
        record.conditionFingerprint=prior.conditionFingerprint||'';
      }else if(initialConditions){
        record.conditionBaseline=initialConditions;
        record.conditionFingerprint=initialConditions.fingerprint;
      }
      const previous=candidates.filter(value=>value.conditionFingerprint===record.conditionFingerprint).at(-1);
      record.attempt=failedAttempt(previous)?previous.attempt+1:1;
      if(failedAttempt(previous)&&previous.attempt>=2){
        const error=fail('RETRY_CONDITIONS_UNCHANGED','Same target and conditions have already failed twice');
        record.state='blocked';record.primaryFailure={code:'RETRY_CONDITIONS_UNCHANGED',site:'launcher.operation',
          guidance:presentError(error,{action:kind})};
        error.retryConditionTarget=failureCondition(previous);
        const annotation=failure(error,kind,record).conditionTarget;if(annotation)record.primaryFailure.conditionTarget=annotation;
        await write(record,lease,{expected:null});await lease.release();return dto(record);
      }
      await write(record,lease,{expected:null});
    }catch(error){await lease.release();throw error;}
    return execute(record,options,lease,'start',initialConditions);
  }
  async function continueOperation(id,mode,options={}){
    const before=await snapshot(id);
    if(before.busy)throw fail('OPERATION_BUSY','The existing writer is still active');
    if(options.snapshotSequence!==undefined&&options.snapshotSequence!==before.snapshotSequence)throw fail('OPERATION_SNAPSHOT_CHANGED','The operation changed; inspect it again');
    const handoff=mode==='resume'&&options.handoff!==undefined
      &&before.handoffRef&&typeof verifyHandoff==='function'
      &&await verifyHandoff(before,options.handoff)===true;
    if(options.handoff!==undefined&&!handoff)
      throw fail('OPERATION_ACTION_UNAVAILABLE','The launcher handoff proof is not valid');
    const recoveryHandoff=mode==='recover'&&typeof options.prepareHandoff==='function'
      &&typeof verifyRecoveryHandoff==='function'&&await verifyRecoveryHandoff(before,options.recoveryHandoff)===true;
    if(options.prepareHandoff&&!recoveryHandoff)
      throw fail('OPERATION_ACTION_UNAVAILABLE','The launcher recovery proof is not valid');
    if(!handoff&&!recoveryHandoff&&!before.allowedActions.includes(mode)&&!(mode==='resume'&&before.allowedActions.includes('retry'))
      &&!(mode==='recover'&&before.allowedActions.includes('start-restored')))
      throw fail('OPERATION_ACTION_UNAVAILABLE','This operation cannot perform the requested action');
    const ownerEpoch=nextEpoch(id);
    const lease=await lock.acquire({directory:typeof directory==='function'?directory():directory,operationId:id,ownerEpoch});
    let record;
    try{
    record=read(id);
    if(record.sequence!==before.snapshotSequence)throw fail('OPERATION_SNAPSHOT_CHANGED','The operation changed; inspect it again');
    record.ownerEpoch=ownerEpoch;
    if(mode==='recover'&&before.recoveryOutcome==='files-restored-start-failed')
      record.restoredStartAttempts=(record.restoredStartAttempts||0)+1;
    if(mode==='resume'&&!handoff)record.attempt++;
    record.totalAttempts=(record.totalAttempts||1)+1;
    if(mode==='recover'){record.state='recovering';record.stageId='recovering';}
    else{record.state='selecting';record.stageId='selecting';}
    await write(record,lease,{expected:{ownerEpoch:before.ownerEpoch,sequence:before.snapshotSequence}});
    }catch(error){
      try{await lease.release();}catch(closeError){error.secondaryErrors=[...(error.secondaryErrors||[]),{operation:'release-admission',error:closeError}];}
      throw error;
    }
    return execute(record,options,lease,mode);
  }
  async function recheck(id,options={}){
    const before=await snapshot(id);
    if(before.busy)throw fail('OPERATION_BUSY','The existing writer is still active');
    if(options.snapshotSequence!==undefined&&options.snapshotSequence!==before.snapshotSequence)throw fail('OPERATION_SNAPSHOT_CHANGED','The operation changed; inspect it again');
    if(before.archived)throw fail('OPERATION_ACTION_UNAVAILABLE','Archived operations are read-only');
    const ownerEpoch=nextEpoch(id);
    const lease=await lock.acquire({directory:typeof directory==='function'?directory():directory,operationId:id,ownerEpoch});
    try{
      const record=read(id);
      if(record.sequence!==before.snapshotSequence)throw fail('OPERATION_SNAPSHOT_CHANGED','The operation changed; inspect it again');
      const verify=recheckers[record.kind];
      if(!verify)return dto(record);
      const proof=await verify(record,{lease,...options,conditionTarget:failureCondition(record)});
      if(proof?.changed===true&&typeof proof.fingerprint==='string'&&proof.fingerprint!==record.conditionFingerprint
        &&['untouched','restored'].includes(proof.effectState)){
        const baseline=conditionProof(proof.baseline);
        if(baseline&&baseline.fingerprint!==proof.fingerprint)throw fail('OPERATION_CONDITIONS_INVALID','Recheck proof identity does not match');
        if(baseline)record.conditionBaseline=baseline;
        record.conditionFingerprint=proof.fingerprint;record.attempt=0;record.ownerEpoch=ownerEpoch;
        record.effectState=proof.effectState;
        if(record.recoveryOutcome==='files-restored-start-failed')record.restoredStartAttempts=0;
        else record.recoveryOutcome='not-required';
        if(record.state==='blocked')record.state='failed';
        record.verifiedConditions={fingerprint:proof.fingerprint,verifiedAt:now()};
        await write(record,lease,{expected:{ownerEpoch:before.ownerEpoch,sequence:before.snapshotSequence}});
      }
      return dto(record);
    }finally{await lease.release();}
  }
  async function failHandoff(id,{job,error,onFailure}={}){
    const record=read(id);
    if(record.state!=='awaiting-handoff'||record.handoffRef!==job||!error)
      throw fail('OPERATION_ACTION_UNAVAILABLE','The handoff no longer belongs to this operation');
    const ownerEpoch=nextEpoch(id);
    const lease=await lock.acquire({directory:typeof directory==='function'?directory():directory,operationId:id,ownerEpoch});
    try{
      const current=read(id);
      if(current.sequence!==record.sequence)throw fail('OPERATION_SNAPSHOT_CHANGED','The handoff changed');
      const expected={ownerEpoch:record.ownerEpoch,sequence:record.sequence};
      record.ownerEpoch=ownerEpoch;await write(record,lease,{expected});
    }catch(failure){await lease.release();throw failure;}
    return execute(record,{execute:async()=>{throw error;},onFailure},lease,'resume');
  }
  return {start,snapshot,recheck,failHandoff,resume:(id,options)=>continueOperation(id,'resume',options),recover:(id,options)=>continueOperation(id,'recover',options)};
}
module.exports={createOperationController};
