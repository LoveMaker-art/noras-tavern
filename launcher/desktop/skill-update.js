const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const DESKTOP_PROTOCOL='nora-desktop-update/1';
const ID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function publicResult(result){
  const fields=['version','launcherVersion','systemReady','running','gatewayRunning','updateComplete','unchanged','operationIds','sequenceId',
    'current','latest','releaseTag','checkedAt','state','available','releaseAvailable','launcherLatest','launcherUpdateAvailable','launcherError','compatibilityError',
    'coreUpdateComplete'];
  return Object.fromEntries(fields.filter(name=>Object.hasOwn(result||{},name)).map(name=>[name,result[name]]));
}
// Optional APP discovery may fail after the independent reader has verified a
// core plan. Admit that plan only with proof it can retain the current APP.
function assertDesktopCheck(checked,launcherVersion,{channel='stable',platform=process.platform,arch=process.arch,allowCandidate,explicitLocalRelease}={}){
  const reject=message=>{throw Object.assign(new Error(message),{code:'DESKTOP_UPDATE_CHECK_FAILED'});};
  if(checked.error||checked.compatibilityError||['unavailable','unknown','blocked'].includes(checked.state))
    reject(checked.error||checked.compatibilityError||checked.launcherError||'版本检查尚未确认，请重新检查。');
  if(!checked.launcherError)return null;
  if(checked.state!=='available'||checked.releaseAvailable!==true||checked.available!==true
    ||checked.installable!==true||checked.updateSupported!==true||!checked.releasePlan)
    reject(checked.launcherError);
  const releases=require('./releases');
  const plan=releases.validatePlan(checked.releasePlan,{client:'updater',updaterCapabilities:releases.UPDATER_CAPABILITIES,
    launcherVersion,channel,platform,arch,allowCandidate,explicitLocalRelease,tag:checked.releaseTag,mode:'update'});
  const target=plan.releaseManifest.versions.tavern;
  if(releases.compare(checked.current,target)!==-1||releases.compare(checked.latest,target)!==0
    ||!require('./update-sequence').compatible(plan.releaseManifest,target,launcherVersion,releases.LAUNCHER_CAPABILITIES))
    reject('启动器查询失败，且无法确认酒馆目标与当前启动器兼容。未开始更新，请重新检查。');
  return plan;
}
function coreOnlyCompletion(result){
  return result?.updateComplete===false&&result.coreUpdateComplete===true&&result.systemReady===true
    &&typeof result.launcherError==='string'&&Boolean(result.launcherError)
    &&Array.isArray(result.operationIds)&&result.operationIds.length>0;
}

function read(file,maximum=65536) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > maximum) throw new Error('Invalid skill update request');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function write(file, data) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}

// A local handoff, not another updater. Only the launcher's existing actions run.
function createSkillUpdateReceiver({ home, busy, execute, clean = String, now = Date.now }) {
  const session = randomUUID();
  let directory, running = false;
  function close() {
    if (directory) {
      try {
        const endpoint = path.join(directory, 'endpoint.json');
        if (read(endpoint).session === session) fs.rmSync(endpoint, { force: true });
      } catch {}
    }
  }
  async function tick() {
    const currentHome = path.resolve(home());
    const next = path.join(currentHome, 'installer', 'skill-update');
    if (directory !== next) { close(); directory = next; }
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Skill update directory must not be a link');
    write(path.join(directory, 'endpoint.json'), { schema: 1, session, noraHome: currentHome, desktopProtocol:DESKTOP_PROTOCOL, updatedAt: now() });
    if (running || busy()) return;
    const file = path.join(directory, 'request.json');
    let request;
    try { request = read(file); } catch { return; }
    if (['success', 'partial', 'error', 'interrupted'].includes(request.status)) return;
    if(request.scope==='desktop'&&request.status==='restarting'&&ID.test(request.sequenceId||''))return;
    const finish = (status, extra = {}) => {
      const current=read(file);if(current.id!==request.id)throw new Error('Update submission changed while running');
      write(file,{...current,status,updatedAt:now(),...extra});
    };
    if (request.status !== 'queued' || request.session !== session) {
      finish('interrupted', { error: '启动器会话已变化，任务不会自动重试。请检查版本后重新提交。' });
      return;
    }
    if (request.schema !== 1 || !ID.test(request.id || '') || request.scope!==undefined&&request.scope!=='desktop' ||
        !['check', 'update'].includes(request.action) || request.confirm !== true ||
        !Number.isFinite(request.createdAt) || now() - request.createdAt > 60000 || request.createdAt > now() + 5000) {
      finish('error', { error: '更新请求无效或已过期，请重新提交。' });
      return;
    }
    running = true;
    try {
      finish('running');
      const result = await execute(request.action, request.id, {scope:request.scope,retry:request.retry===true});
      const partial=request.scope==='desktop'&&request.action==='update'&&coreOnlyCompletion(result);
      if(request.scope==='desktop'&&request.action==='update'&&!result?.restarting&&result?.updateComplete!==true&&!partial)
        throw Object.assign(new Error('更新尚未确认全部完成，请查询原任务。'),{code:'DESKTOP_UPDATE_INCOMPLETE'});
      finish(result?.restarting ? 'restarting' : partial?'partial':'success', { result:request.scope==='desktop'?publicResult(result):result });
    } catch (error) {
      finish('error', { code:error.code||'DESKTOP_UPDATE_FAILED',error: clean(error.message || String(error)),
        ...(request.scope==='desktop'&&error.result?{result:publicResult(error.result)}:{}) });
    } finally { running = false; }
  }
  return { tick, close };
}
function finishHandoff(home, id, result, error) {
  if (!id) return;
  const file = path.join(home, 'installer', 'skill-update', 'request.json');
  const request = read(file);
  if (request.id !== id || !['running','restarting'].includes(request.status)) return;
  if(!error&&request.scope==='desktop'&&result?.updateComplete!==true)return;
  write(file, { ...request, status: error ? 'error' : 'success', updatedAt: Date.now(),
    ...(error ? { error: String(error) } : { result:request.scope==='desktop'?publicResult(result):result }) });
}
function bindDesktopSequence(home,id,sequenceId){
  if(!ID.test(id||'')||!ID.test(sequenceId||''))throw new Error('Invalid desktop update association');
  const file=path.join(home,'installer/skill-update/request.json'),request=read(file);
  if(request.id!==id||request.scope!=='desktop'||!['running','restarting'].includes(request.status))throw new Error('Desktop update request changed');
  write(file,{...request,sequenceId});
}
function desktopSequenceRequest(home,sequenceId){
  try{const request=read(path.join(home,'installer/skill-update/request.json'));
    return request.scope==='desktop'&&request.sequenceId===sequenceId&&ID.test(request.id||'')?request:null;
  }catch{return null;}
}

async function desktopStatus(home){
  const file=path.join(home,'installer/skill-update/request.json');
  if(!fs.existsSync(file))return {status:'none',settled:true,busy:false};
  const request=read(file);
  if(request.scope!=='desktop'||!ID.test(request.id||''))return {status:'none',settled:true,busy:false};
  const probe=require('./os-lock').acquire({directory:path.join(home,'installer'),probe:true});
  let busy;try{busy=probe.busy;}finally{probe.release();}
  const base={requestId:request.id,scope:'desktop',busy,settled:!busy,...(request.sequenceId?{sequenceId:request.sequenceId}:{})};
  if(busy)return {...base,status:'in-progress'};
  if(['success','partial'].includes(request.status)&&request.action==='update'){
    const receipt=await require('./launcher-capability').validateApp({receiptPath:require('./launcher-capability').receiptPath(home),noraHome:home});
    const installed=read(path.join(receipt.installRoot,'tavern-updates/installed.json')),result=request.result||{};
    const ids=result.operationIds||[];
    const partial=request.status==='partial';
    if((partial?!coreOnlyCompletion(result):result.updateComplete!==true)||result.version!==installed.version||result.launcherVersion!==receipt.launcherVersion
      ||!Array.isArray(ids)||!ids.length&&result.unchanged!==true)throw new Error('Desktop update completion cannot be verified');
    let requestIds=[request.id,'skill-'+request.id];
    if(request.sequenceId){
      if(!ID.test(request.sequenceId))throw new Error('Invalid sequence association');
      const sequence=read(path.join(home,'installer/update-sequences',request.sequenceId,'request.json'),8*1024*1024);
      const {digest,...content}=sequence;
      if(sequence.id!==request.sequenceId||digest!==require('node:crypto').createHash('sha256').update(JSON.stringify(content)).digest('hex'))
        throw new Error('Desktop sequence identity changed');
      requestIds=Object.values(sequence.requests);
    }
    for(const id of ids){if(!ID.test(id))throw new Error('Invalid operation association');
      const operation=read(path.join(home,'installer/operations',id,'operation.json'),8*1024*1024);
      if(operation.state!=='succeeded'||operation.verification!=='confirmed'||!requestIds.includes(operation.requestId)
        ||partial&&(operation.kind!=='update'||operation.result?.version!==result.version||operation.result?.systemReady!==true))
        throw new Error('Desktop update operation is not confirmed');}
    return {...base,status:partial?'partial':'succeeded',result};
  }
  if(request.status==='success')return {...base,status:'succeeded',result:request.result};
  if(['error','interrupted'].includes(request.status))return {...base,status:request.status,code:request.code,error:request.error,
    ...(request.result?{result:publicResult(request.result)}:{})};
  return {...base,status:request.status,settled:false,submitted:true};
}

async function desktopRequest({noraHome:home,action,confirm=false},{now=Date.now,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  checkRelease=options=>require('./releases').check(options),
  launch=receipt=>{const env={...process.env,NORA_TAVERN_HOME:home};
    for(const name of Object.keys(env))if(name==='ELECTRON_RUN_AS_NODE'||name==='NODE_OPTIONS'||name==='NODE_PATH'||name.startsWith('NORA_OPERATION_'))delete env[name];
    const child=require('node:child_process').spawn(receipt.executable.path,[],{detached:true,stdio:'ignore',
      cwd:path.dirname(receipt.executable.path),env});child.unref();return child;} }={}){
  if(!['check','update','status'].includes(action)||typeof home!=='string'||!path.isAbsolute(home))throw new Error('Invalid desktop request');
  home=path.resolve(home);
  const cap=require('./launcher-capability'),file=cap.receiptPath(home);
  if(action==='status')return desktopStatus(home);
  if(!fs.existsSync(file))return {applicable:false,status:'no-desktop'};
  const receipt=await cap.validateApp({receiptPath:file,noraHome:home});
  if(action==='check'){
    // Reuse the standalone metadata reader; a version query owns no GUI task
    // and must not wake the APP or replace an existing update submission.
    const checked=await checkRelease({client:'updater',updaterCapabilities:require('./releases').UPDATER_CAPABILITIES,
      installRoot:receipt.installRoot,launcherVersion:receipt.launcherVersion,launcherDiscovery:true,
      platform:receipt.platform,arch:receipt.arch,channel:receipt.channel});
    assertDesktopCheck(checked,receipt.launcherVersion,{channel:receipt.channel,platform:receipt.platform,arch:receipt.arch});
    return {scope:'desktop',action:'check',status:'succeeded',settled:true,
      result:publicResult({...checked,launcherVersion:receipt.launcherVersion})};
  }
  if(action==='update'&&confirm!==true)throw new Error('Desktop update requires explicit authorization');
  const directory=path.join(home,'installer/skill-update'),endpointFile=path.join(directory,'endpoint.json');
  let endpoint,launched=false;
  const deadline=now()+30000;
  const currentEndpoint=value=>value&&value.noraHome===home&&ID.test(value.session||'')&&Number.isFinite(value.updatedAt)
    &&now()-value.updatedAt<10000&&value.updatedAt<=now()+5000;
  while(now()<deadline){
    try{endpoint=read(endpointFile);}catch{endpoint=null;}
    if(currentEndpoint(endpoint))break;
    if(!launched){const child=launch(receipt);child?.once?.('error',()=>{});launched=true;}
    await wait(250);
  }
  if(!currentEndpoint(endpoint))throw Object.assign(new Error('启动器尚未接管请求，请打开启动器后重试。'),{code:'DESKTOP_UPDATE_UNAVAILABLE'});
  if(endpoint.desktopProtocol!==DESKTOP_PROTOCOL)throw Object.assign(new Error('当前旧启动器尚不支持诺拉整套更新。原更新入口可用时先升级启动器；入口失效时使用已验证的保留数据安装或修复方式，勿删除原数据。'),{code:'DESKTOP_UPDATE_UNSUPPORTED'});
  const fileRequest=path.join(directory,'request.json');
  const lock=require('./os-lock').acquire({directory,probe:false});
  try{
    const previous=fs.existsSync(fileRequest)?read(fileRequest):null;
    if(previous&&['queued','running','restarting'].includes(previous.status)){
      if(previous.scope!=='desktop'||previous.action!==action||!ID.test(previous.id||''))throw Object.assign(new Error('已有其他维护请求，请先查询原任务。'),{code:'OPERATION_BUSY'});
      return {status:previous.status,requestId:previous.id,submitted:true,joined:true,settled:false};
    }
    const pointer=path.join(home,'installer/current-update-sequence.json');
    const retry=action==='update'&&fs.existsSync(pointer)?read(pointer):null;
    if(retry&&!ID.test(retry.id||''))throw new Error('Pending update sequence cannot be verified');
    const request={schema:1,id:retry&&previous?.scope==='desktop'&&previous.sequenceId===retry.id?previous.id:randomUUID(),scope:'desktop',action,confirm:true,createdAt:now(),
      session:endpoint.session,status:'queued',...(retry?{retry:true,sequenceId:retry.id}:{})};
    write(fileRequest,request);
    return {status:'queued',requestId:request.id,submitted:true,settled:false};
  }finally{lock.release();}
}

if(require.main===module)(async()=>{
  let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>65536)throw new Error('Desktop request too large');}
  const result=await desktopRequest(JSON.parse(input));process.stdout.write(JSON.stringify(result)+'\n');
})().catch(error=>{process.stdout.write(JSON.stringify({status:'error',settled:false,code:error.code||'DESKTOP_UPDATE_UNCONFIRMED',error:error.message})+'\n');process.exitCode=1;});
module.exports = { createSkillUpdateReceiver, finishHandoff,bindDesktopSequence,desktopSequenceRequest,desktopRequest,desktopStatus,assertDesktopCheck };
