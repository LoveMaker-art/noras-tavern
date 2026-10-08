// Treat .asar as an ordinary file when removing an application bundle.
const fs = process.versions.electron ? require('original-fs') : require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const osLock=require('./os-lock');

const OWNER = 'nora-owner.json';
const RETAINED = 'nora-retained.json';
const PROGRAMS = ['hermes-agent', 'python', 'node', 'bin', '.local/bin', 'plugins/clawchat',
  'clawchat/liveware', 'nora-components.json', 'nora-clawchat-check.py', 'nora-installation.json',
  'nora-instance.json', 'gateway.pid', 'gateway.lock', 'gateway_state.json'];

function canonical(file) {
  const full = path.resolve(file);
  if (fs.existsSync(full)) return fs.realpathSync(full);
  const parent = path.dirname(full);
  return parent === full ? full : path.join(canonical(parent), path.basename(full));
}

function safeRoot(home) {
  if (fs.existsSync(home) && fs.lstatSync(home).isSymbolicLink()) throw new Error('隔离目录不能是符号链接。');
  const root = canonical(home), userHome = canonical(os.homedir());
  if (root === path.parse(root).root || root === userHome
    || userHome.startsWith(root + path.sep)) throw new Error('不能卸载用户目录或磁盘根目录。');
  return root;
}

function contained(root, relative) {
  const target = path.resolve(root, relative);
  if (target === root || !target.startsWith(root + path.sep)) throw new Error('卸载路径越过隔离目录。');
  let current = root;
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`卸载路径被链接重定向：${relative}`);
    }
  }
  return target;
}

function own(home) {
  const root = safeRoot(home);
  const file = contained(root, OWNER);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ schema: 1, id: crypto.randomUUID() }), { mode: 0o600, flag: 'wx' });
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value.schema !== 1 || typeof value.id !== 'string') throw new Error('安装目录归属记录无效。');
  return value.id;
}

function makePlan({ home, hermesHome, installRoot, mode, executable = process.execPath, appPath = null }) {
  if (!['keep', 'all'].includes(mode)) throw new Error('卸载方式无效。');
  const root = safeRoot(home);
  if (path.resolve(executable).startsWith(root + path.sep)) throw new Error('启动器位于数据目录内，请将启动器移到独立应用目录后重试。');
  const hermes = path.relative(root, canonical(hermesHome));
  const tavern = path.relative(root, canonical(installRoot));
  contained(root, hermes); contained(root, tavern);
  if (hermes === tavern || hermes.startsWith(tavern + path.sep) || tavern.startsWith(hermes + path.sep)) throw new Error('程序目录不能互相包含。');
  return { schema: 1, root, owner: own(root), hermes, tavern, mode, executable, appPath, parentIdentity:processIdentity(process.pid) };
}

function validate(plan) {
  if (plan.schema !== 1 || !['keep', 'all'].includes(plan.mode)) throw new Error('卸载计划无效。');
  const root = safeRoot(plan.root);
  const owner = JSON.parse(fs.readFileSync(contained(root, OWNER), 'utf8'));
  if (owner.id !== plan.owner) throw new Error('安装目录已变化，已停止卸载。');
  contained(root, plan.hermes); contained(root, plan.tavern);
  return root;
}

function processIdentity(pid) {
  if(!Number.isSafeInteger(pid)||pid<1)throw Object.assign(new Error('启动器进程身份无效。'),{code:'UNINSTALL_PARENT_UNCONFIRMED'});
  let result,creationTime,precisionSeconds;
  if(process.platform==='darwin'){
    result=spawnSync('/bin/ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8',env:{...process.env,LC_ALL:'C'},timeout:10000});
    if(!result.error&&result.status===1&&!result.stdout.trim())return null;
    creationTime=Date.parse(result.stdout.trim())/1000;precisionSeconds=1;
  }else if(process.platform==='win32'){
    result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
      `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($null -eq $p){'absent'}else{([DateTimeOffset]$p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()}`],
      {encoding:'utf8',windowsHide:true,timeout:10000});
    if(!result.error&&result.status===0&&result.stdout.trim()==='absent')return null;
    creationTime=Number(result.stdout.trim())/1000;precisionSeconds=0.001;
  }
  if(result?.error||result?.status!==0||!Number.isFinite(creationTime)||creationTime<=0)
    throw Object.assign(new Error('无法核验启动器进程身份，未删除文件。'),{code:'UNINSTALL_PARENT_UNCONFIRMED'});
  return {pid,creationTime,precisionSeconds};
}

const OPERATION_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const recoveryRequired=cause=>Object.assign(new Error('上次文件事务尚未确认结束，请先恢复并保留日志与备份，再卸载程序。',cause?{cause}:undefined),{code:'UNINSTALL_RECOVERY_REQUIRED'});
function localDiagnostic(error,depth=0){return {name:String(error.name||'Error').slice(0,100),code:String(error.code||'').slice(0,100),
  message:String(error.message||'').slice(0,2000),stack:String(error.stack||'').slice(0,8192),
  ...(error.cause&&depth<3?{cause:localDiagnostic(error.cause,depth+1)}:{})};}
function present(file){try{fs.lstatSync(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
function readJournal(file,limit=4*1024*1024){
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>limit)throw recoveryRequired();
  const value=JSON.parse(fs.readFileSync(file,'utf8'));
  if(!value||typeof value!=='object'||Array.isArray(value))throw recoveryRequired();
  return value;
}
function transactionCatalog(root,plan){
  const directory=contained(root,'installer/operations'),operations=[];
  for(const name of fs.readdirSync(directory)){
    if(!OPERATION_ID.test(name)){
      const other=contained(root,path.join('installer/operations',name));
      if(fs.lstatSync(other).isDirectory()&&(present(path.join(other,'runtime-bootstrap.json'))
        ||present(path.join(other,'first-install/transaction.json'))))throw recoveryRequired();
      continue;
    }
    const base=contained(root,path.join('installer/operations',name));
    if(!fs.lstatSync(base).isDirectory())throw recoveryRequired();
    const file=contained(root,path.join('installer/operations',name,'operation.json'));
    const record=present(file)?readJournal(file,256*1024):null;
    if(record&&(record.schema!=='nora-operation/1'||record.operationId!==name))throw recoveryRequired();
    const runtimeFile=contained(root,path.join('installer/operations',name,'runtime-bootstrap.json'));
    const firstFile=contained(root,path.join('installer/operations',name,'first-install/transaction.json'));
    const runtime=present(runtimeFile)?readJournal(runtimeFile):null;
    const first=present(firstFile)?readJournal(firstFile,2*1024*1024):null;
    if(first&&(first.schema!==1||first.owner!=='nora-first-install'||first.operationId!==name
      ||canonical(first.noraHome||'')!==root||canonical(first.roots?.hermes||'')!==contained(root,plan.hermes)
      ||canonical(first.roots?.tavern||'')!==contained(root,plan.tavern)))throw recoveryRequired();
    operations.push({id:name,record,runtime,runtimeFile,first,firstFile});
  }
  const systemFile=contained(root,path.join(plan.tavern,'tavern-updates/transaction.json'));
  const system=present(systemFile)?readJournal(systemFile,64*1024*1024):null;
  // A corrupt authoritative journal is never hidden by a missing Operation.
  if(system&&(system.schema!==1||!system.recoveryPlan||typeof system.recoveryPlan!=='object'))throw recoveryRequired();
  const legacyFile=contained(root,'installer/system-update/journal.json');
  let legacy=null;
  if(present(legacyFile)){
    const state=readJournal(legacyFile);legacy=state;
    const facts=require('./system-update').inspect(root);
    if(facts||!['committed','rolled-back'].includes(state.phase))throw recoveryRequired();
    // The old adapter intentionally has no current-file assessment for a
    // committed journal. A later authenticated system transaction must prove
    // it was superseded; the saved word "committed" cannot grant deletion.
    if(state.phase==='committed'&&(!system||typeof state.target!=='string'||!/^v?\d+\.\d+\.\d+(?:[-.][\w.-]+)?$/.test(state.target)))throw recoveryRequired();
  }
  const appDirectory=contained(root,'installer/launcher-update');
  const appJobs=present(appDirectory)?fs.readdirSync(appDirectory).filter(name=>/^job-[\w-]+$/.test(name))
    .map(name=>contained(root,path.join('installer/launcher-update',name))):[];
  return {operations,system,systemFile,appJobs,legacy};
}
function runtimeEffects(root,plan,catalog){
  const inspect=require('./runtime-transaction').inspect;
  const facts=new Map(catalog.operations.filter(item=>item.runtime).map(item=>[item.id,
    inspect({noraHome:root,hermesHome:contained(root,plan.hermes),operationId:item.id})]));
  // A later committed swap must actually seal the current tree and link its
  // previous identity to the older tree. Success labels alone are insufficient.
  const superseded=new Set();
  for(const item of catalog.operations){
    if(facts.get(item.id)?.reason!=='committed')continue;
    let predecessor=item.runtime.identities.previous;
    const seen=new Set([item.id]);
    while(predecessor){
      const old=catalog.operations.find(value=>!seen.has(value.id)&&value.record?.state==='succeeded'
        &&value.runtime?.status==='committed'&&value.runtime.schema==='nora-runtime-bootstrap/1'
        &&value.runtime.operationId===value.id&&value.runtime.paths?.noraHome===root
        &&value.runtime.paths?.hermesHome===contained(root,plan.hermes)
        &&facts.get(value.id)?.reason!=='RUNTIME_JOURNAL_INVALID'
        &&value.runtime.identities?.next?.device===predecessor.device&&value.runtime.identities.next.inode===predecessor.inode);
      if(!old)break;
      superseded.add(old.id);seen.add(old.id);predecessor=old.runtime.identities.previous;
    }
  }
  for(const item of catalog.operations){
    if(item.runtime&&!superseded.has(item.id)){
      const observed=facts.get(item.id);
      if(observed.effectState==='unknown'||observed.recoveryOutcome==='recovery-required'
        ||observed.effectState==='changed'&&observed.reason!=='committed')throw recoveryRequired(
          Object.assign(new Error(`Nora runtime journal: ${observed.reason}`),{code:'UNINSTALL_RUNTIME_UNCONFIRMED'}));
    }
    if(!item.runtime&&!item.first&&item.record&&(!['untouched','restored'].includes(item.record.effectState)
      ||item.record.recoveryOutcome==='recovery-required')&&catalog.system?.operationId!==item.id)throw recoveryRequired();
  }
}
function assertNoPendingTransaction(root,plan){
  try{
    const catalog=transactionCatalog(root,plan);
    runtimeEffects(root,plan,catalog);
    if(!catalog.system&&!catalog.appJobs.length&&!catalog.operations.some(item=>item.first))return;
    // Keep the public cleanup synchronous. This bounded child only reads
    // sealed current-APP resources; the parent keeps the native writer fd
    // throughout inspection and deletion. It never acquires a second owner.
    readOnlyNodeCheck('inspectSealedTransactions',plan);
  }catch(error){if(error.code==='UNINSTALL_RECOVERY_REQUIRED')throw error;throw recoveryRequired(error);}
}
function readOnlyNodeCheck(method,plan){
  const script=`(async()=>{await require(${JSON.stringify(__filename)})[${JSON.stringify(method)}](JSON.parse(process.argv[1]));process.stdout.write('nora-uninstall-facts-ok');})().catch(error=>{process.stdout.write(JSON.stringify(${localDiagnostic.toString()}(error)));process.exitCode=1;});`;
  const env={...process.env,ELECTRON_RUN_AS_NODE:'1',PYTHONDONTWRITEBYTECODE:'1'};
  delete env.NODE_OPTIONS;for(const key of Object.keys(env))if(key.startsWith('NORA_OPERATION_'))delete env[key];
  const result=spawnSync(process.execPath,['-e',script,JSON.stringify(plan)],{env,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:64*1024});
  if(result.error)throw recoveryRequired(result.error);
  if(result.status!==0||result.stdout!=='nora-uninstall-facts-ok'){
    let detail;try{detail=JSON.parse(result.stdout);}catch{}
    const cause=Object.assign(new Error(detail?.message||String(result.stderr||'只读事务检查未返回有效结果。').slice(0,2000)),
      {name:detail?.name||'Error',code:detail?.code||'UNINSTALL_INSPECTION_FAILED',stack:detail?.stack,
        ...(detail?.cause?{cause:Object.assign(new Error(detail.cause.message),detail.cause)}:{})});
    throw recoveryRequired(cause);
  }
}
async function inspectExecutorHistory(plan){
  const root=validate(plan),history=await require('./operation-lock').probe({directory:contained(root,'installer')});
  const facts=require('./operation-inspection').inspectExecutors({sessions:history.sessions});
  if(history.errors?.length||!facts.safe)throw Object.assign(new Error('尚未确认上次维护进程已结束，未删除文件。'),{code:'OPERATION_EXECUTOR_UNCONFIRMED'});
}
async function inspectSealedTransactions(plan){
  const root=validate(plan),catalog=transactionCatalog(root,plan);
  runtimeEffects(root,plan,catalog);
  const capability=await require('./launcher-capability').validate({receiptPath:path.join(root,'installer/launcher-control.json'),
    noraHome:root,currentExecutable:process.execPath});
  if(canonical(capability.hermesHome)!==contained(root,plan.hermes)||canonical(capability.installRoot)!==contained(root,plan.tavern))throw recoveryRequired();
  const venv=path.join(capability.hermesHome,'hermes-agent','venv');
  const command=path.join(venv,process.platform==='win32'?'Scripts/python.exe':'bin/python');
  const environment={...process.env,PYTHONDONTWRITEBYTECODE:'1'};
  delete environment.NODE_OPTIONS;for(const key of Object.keys(environment))if(key.startsWith('NORA_OPERATION_'))delete environment[key];
  const execution=require('./managed-python').resolveExecution(command,{managedPythonRoot:path.join(capability.hermesHome,'python'),venvHome:venv,env:environment});
  const input={root,hermesHome:capability.hermesHome,installRoot:capability.installRoot,
    first:catalog.operations.filter(item=>item.first).map(item=>({id:item.id,file:item.firstFile,
      record:item.record?{operationId:item.record.operationId,state:item.record.state}:null})),
    system:catalog.system!==null&&catalog.system!==undefined,legacy:catalog.legacy,
    appJobs:catalog.appJobs,executable:process.execPath,
    resources:capability.resources};
  const result=spawnSync(execution.command,['-B','-c',PYTHON_TRANSACTION_FACTS],{env:execution.env,input:JSON.stringify(input),encoding:'utf8',windowsHide:true,timeout:45000,maxBuffer:128*1024});
  if(result.error)throw recoveryRequired(result.error);
  if(result.status!==0)throw recoveryRequired(Object.assign(new Error(String(result.stderr||'Python 只读事务检查失败。').slice(0,8192)),{code:'UNINSTALL_PYTHON_INSPECTION_FAILED'}));
  const facts=JSON.parse(result.stdout);
  if(facts?.schema!=='nora-uninstall-facts/1'||facts.safe!==true)throw recoveryRequired();
}
// Pure read-only public inspectors are reused here. No recovery CLI or write
// capability is invoked; Python bytecode creation is disabled by both -B/env.
const PYTHON_TRANSACTION_FACTS=String.raw`
import importlib.util,json,sys,re
from pathlib import Path
args=json.load(sys.stdin)
def module(name,file):
    spec=importlib.util.spec_from_file_location(name,file);value=importlib.util.module_from_spec(spec)
    sys.modules[name]=value;spec.loader.exec_module(value);return value
recovery=module('nora_uninstall_recovery',args['resources']['update_recovery.py']['path'])
first=module('nora_uninstall_first',args['resources']['first_install.py']['path'])
system=None
if args['system']:
    system=recovery.effects(args['hermesHome'],args['installRoot'])
    if system['effectState']=='unknown' or (system['effectState']=='changed' and system.get('status')!='committed'):
        raise RuntimeError('unconfirmed system effects: '+str(system.get('reason','')))
successor=None
if system and system.get('status')=='committed':
    operation=Path(args['root'])/'installer/operations'/str(system.get('operationId'))/'operation.json'
    record=recovery.read_object(operation,max_bytes=256*1024)
    journal=recovery.load(args['hermesHome'],args['installRoot'],full=False)
    installed=recovery.read_object(Path(args['installRoot'])/'tavern-updates/installed.json')
    if record.get('operationId')==system.get('operationId') and record.get('state')=='succeeded' and installed.get('version')==journal.record.get('version'):
        successor=system['operationId']
if args['legacy'] and args['legacy'].get('phase')=='committed' and not successor:
    raise RuntimeError('unconfirmed legacy successor')
for item in args['first']:
    facts=first.inspect_first_install(item['file'])
    value=recovery.read_object(item['file'])
    # An authenticated, actually committed successor owns the live files.
    # Historical successful journals retain their original sealed intent,
    # while their old root identities legitimately no longer match live trees.
    historical=(item['record'] or {}).get('state')=='succeeded' and successor and successor!=item['id']
    if historical and value.get('checkpoints',{}).get('commit',{}).get('state')=='result':
        def identity_shape(value):
            return isinstance(value,list) and len(value)==2 and all(type(number) is int and number>=0 for number in value) and value[1]>0
        if (not re.fullmatch('[a-f0-9]{64}',str(value.get('targetDigest','')))
                or not isinstance(value.get('targets'),list) or len(value['targets'])>128
                or set(value.get('rootIdentities',{}))!={'hermes','tavern'}
                or not all(identity_shape(identity) for identity in value['rootIdentities'].values())
                or value.get('checkpoints',{}).get('restore',{}).get('state') in ('intent','result')):
            raise RuntimeError('invalid historical first install')
        seen=set()
        for target in value['targets']:
            namespace,relative=target.get('namespace'),target.get('path')
            allowed=first.FirstInstallJournal.TAVERN if namespace=='tavern' else first.FirstInstallJournal.HERMES if namespace=='hermes' else set()
            if (relative not in allowed or (namespace,relative) in seen or type(target.get('existed')) is not bool
                    or target['existed'] and (not identity_shape(target.get('oldIdentity'))
                        or not re.fullmatch('[a-f0-9]{64}',str(target.get('digest',''))))):
                raise RuntimeError('invalid historical target')
            seen.add((namespace,relative))
        if not {('tavern','tavern-updates/installed.json'),('tavern','tavern-updates/installed-manifest.json')}.issubset(seen):
            raise RuntimeError('historical install receipts missing')
        continue
    if facts['effectState']=='unknown' or (facts['effectState']=='changed' and facts.get('canResume') is not True):
        raise RuntimeError('unconfirmed first install effects: '+str(facts.get('reason','')))
if args['appJobs']:
    replacement=module('nora_uninstall_launcher',args['resources']['replace-launcher.py']['path'])
    executable=Path(args['executable']).resolve()
    jobs=sorted(map(Path,args['appJobs']),key=lambda file:file.stat().st_ctime_ns,reverse=True)
    for job in jobs:
        context=replacement.context(job)
        if (context['app']/context['executable']).resolve()!=executable:continue
        pending=replacement.assess(job)
        if pending is not None:raise RuntimeError('unconfirmed launcher effects')
        break  # A validated latest completion supersedes older APP jobs.
print(json.dumps({'schema':'nora-uninstall-facts/1','safe':True}))
`;

function remove(file) {
  fs.rmSync(file, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
  if (fs.existsSync(file)) throw new Error(`未能删除：${file}`);
}

function cleanup(plan,onProgress=()=>{}) {
  const root=validate(plan),writer=osLock.acquire({directory:contained(root,'installer')});
  try{cleanupLocked(plan,onProgress);}finally{writer.release();}
}

function cleanupLocked(plan, onProgress = () => {}) {
  const root = validate(plan);
  if(present(contained(root,'installer/operations/.guards'))){
    try{readOnlyNodeCheck('inspectExecutorHistory',plan);}
    catch(error){throw Object.assign(new Error('尚未确认上次维护进程已结束，未删除文件。',{cause:error}),{code:'OPERATION_EXECUTOR_UNCONFIRMED'});}
  }
  assertNoPendingTransaction(root,plan);
  // Resolve every top-level deletion before changing anything. Node rm does not
  // follow links inside a removed tree; redirected deletion roots are rejected.
  const relatives = plan.mode === 'all'
    ? fs.readdirSync(root).filter(name => name !== OWNER && name !== 'installer')
    : [...PROGRAMS.map(name => path.join(plan.hermes, name)),
      path.join(plan.tavern, 'apps'), path.join(plan.tavern, 'tavern-state/native-runtime'),
      'cache', 'launcher'];
  if(plan.mode==='all'){
    const installer=contained(root,'installer');
    for(const name of fs.readdirSync(installer).filter(name=>name!=='operations'))relatives.push(path.join('installer',name));
    const operations=contained(root,'installer/operations');
    for(const name of fs.readdirSync(operations).filter(name=>name!=='.writer.lock'))relatives.push(path.join('installer/operations',name));
  }
  const targets = relatives.map(relative => contained(root, relative));
  if (plan.mode === 'keep') {
    const config = contained(root, path.join(plan.tavern, 'tavern-state/native-runtime/config.yaml'));
    const retainedConfig = contained(root, path.join(plan.tavern, 'tavern-state/nora-retained-config.yaml'));
    if (fs.existsSync(config)) fs.copyFileSync(config, retainedConfig);
    // This receipt enables a subsequent runtime extraction to merge retained data.
    fs.writeFileSync(contained(root, RETAINED), JSON.stringify({ schema: 1, hermes: plan.hermes }), { mode: 0o600 });
  }
  for (let index = 0; index < targets.length; index++) {
    onProgress({ stage: 'cleanup', current: index + 1, total: targets.length, path: targets[index] });
    remove(targets[index]);
  }
  // Even all retains only the ownership record and native lock inode.
  // Unlinking the held lock would let a new installer create another owner.
}

function restoreRetained(noraHome, previous, current) {
  const receipt = path.join(noraHome, RETAINED);
  if (!fs.existsSync(receipt)) return false;
  const value = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  if (value.schema !== 1 || path.resolve(noraHome, value.hermes) !== path.resolve(current)) throw new Error('保留数据目录不匹配。');
  // Program folders were removed during uninstall. Only retained files are
  // overlaid; never replace fresh runtime binaries with an old backup.
  const excluded = PROGRAMS.map(name => name.split('/').join(path.sep));
  const copy = relative => {
    if (excluded.some(name => relative === name || relative.startsWith(name + path.sep))) return;
    const source = contained(path.resolve(previous), relative);
    const target = contained(path.resolve(current), relative);
    if (fs.statSync(source).isDirectory()) {
      fs.mkdirSync(target, { recursive: true });
      for (const entry of fs.readdirSync(source)) copy(path.join(relative, entry));
    } else fs.copyFileSync(source, target);
  };
  for (const entry of fs.readdirSync(previous)) copy(entry);
  return true;
}

async function worker(planFile, showMessage = notify) {
  const directory = path.dirname(planFile);
  const resultFile = path.join(directory, 'result.json');
  let plan,writer;
  const report = value => fs.writeFileSync(resultFile, JSON.stringify(value), { mode: 0o600 });
  try {
    plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
    if (path.resolve(plan.executable) !== path.resolve(process.execPath)) throw new Error('卸载程序与应用不匹配。');
    if (plan.executable.startsWith(path.resolve(plan.root) + path.sep)) throw new Error('启动器不能位于数据目录内。');
    if (process.platform === 'darwin' && plan.appPath) {
      const expected = path.resolve(process.execPath, '../../..');
      if (plan.appPath !== expected || !expected.endsWith('.app') || fs.lstatSync(expected).isSymbolicLink()) throw new Error('应用目录校验失败。');
    }
    if (plan.parentPid) {
      const expected=plan.parentIdentity;
      if(expected?.pid!==plan.parentPid||!Number.isFinite(expected.creationTime)||expected.creationTime<=0
        ||!Number.isFinite(expected.precisionSeconds)||expected.precisionSeconds<0||expected.precisionSeconds>1)
        throw Object.assign(new Error('旧启动器身份记录不完整，未删除文件。'),{code:'UNINSTALL_PARENT_UNCONFIRMED'});
      const deadline = Date.now() + 60000;
      while (true) {
        const actual=processIdentity(plan.parentPid);
        if(!actual||Math.abs(actual.creationTime-expected.creationTime)>Math.max(actual.precisionSeconds,expected.precisionSeconds))break;
        if (Date.now() > deadline) throw new Error('启动器尚未退出，未删除文件。');
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    const root=validate(plan);
    writer=osLock.acquire({directory:contained(root,'installer')});
    await inspectExecutorHistory(plan);
    report({ state: 'running', stage: 'cleanup' });
    cleanupLocked(plan, progress => { report({ state: 'running', ...progress }); process.stdout.write(`清理文件 ${progress.current}/${progress.total}\n`); });
    if (process.platform === 'darwin' && plan.appPath) {
      report({ state: 'running', stage: 'application' });
      remove(plan.appPath);
    }
    report({ state: 'complete', mode: plan.mode, retained: plan.mode === 'keep' ? plan.root : null });
    if (process.platform === 'darwin') showMessage(plan.mode === 'keep' ? '卸载完成。用户数据已保留，可在重装后继续使用。' : '卸载完成。本地程序和数据已清理。');
  } catch (error) {
    report({ state: 'error', code:error.code||'UNINSTALL_FAILED', error: error.message, diagnosticError:localDiagnostic(error) });
    if (process.platform === 'darwin') showMessage(`卸载未完成。请保留剩余文件并重试。详情：${resultFile}`);
    process.stderr.write(`卸载未完成：${error.message}\n`);
    process.exitCode = 1;
  }finally{writer?.release();}
}

function notify(message) {
  spawnSync('/usr/bin/osascript', ['-e', 'on run argv', '-e', 'display dialog (item 1 of argv) with title "诺拉·酒馆" buttons {"好"} default button "好"', '-e', 'end run', message], { timeout: 120000 });
}

module.exports = { own, makePlan, cleanup, restoreRetained, worker, RETAINED, PROGRAMS, safeRoot, contained,inspectSealedTransactions,inspectExecutorHistory };
if (require.main === module) worker(process.argv[2]);
