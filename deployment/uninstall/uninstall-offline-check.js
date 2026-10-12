// Read-only deletion admission. Historical recovery records never authorize it.
const fs=process.versions.electron?require('original-fs'):require('node:fs');
const path=require('node:path');
const net=require('node:net');
const {createHash}=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {TextDecoder}=require('node:util');
// The offline bridge's import closure; update/install-only resources are not
// required to discard a broken installation or its history.
const resources=['launcher_bridge.py','nora_system.py','nora_profile.py','launcher_services.py',
  'error_diagnostics.py','operation_control.py','operation_evidence.py','operation-budget.json','model_config.py'];
const SCHEMA='nora-uninstall-offline-check/1';
const failed=(message,cause)=>Object.assign(new Error(message,cause?{cause}:undefined),{code:'UNINSTALL_SERVICES_UNCONFIRMED'});
const same=(left,right)=>process.platform==='win32'?left.toLowerCase()===right.toLowerCase():left===right;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const cache=new Map();
function resourceFile(name,{resourcesRoot,entry}){
  const file=path.join(resourcesRoot,name);
  // Source projection keeps two extraResources inputs beside the desktop
  // entry. A packaged APP must always have the physical Resources copy.
  if(entry.endsWith('.asar')||fs.existsSync(file))return file;
  return name==='update_paths.py'?path.join(resourcesRoot,'../updater',name):path.join(path.dirname(entry),name);
}
function descriptor(file){
  const resolved=fs.realpathSync(file),before=fs.statSync(resolved,{bigint:true});
  if(!before.isFile()||before.size<1n||before.size>512n*1024n*1024n)throw failed('当前启动器检查资源无效，未删除文件。');
  const fingerprint=[before.dev,before.ino,before.size,before.mtimeNs,before.ctimeNs].map(String).join(':');
  const cached=cache.get(resolved);
  if(cached?.fingerprint===fingerprint)return {...cached.value};
  const value={path:resolved,size:Number(before.size),sha256:hash(fs.readFileSync(resolved))};
  const after=fs.statSync(resolved,{bigint:true});
  if([after.dev,after.ino,after.size,after.mtimeNs,after.ctimeNs].map(String).join(':')!==fingerprint)
    throw failed('当前启动器检查资源已变化，未删除文件。');
  cache.set(resolved,{fingerprint,value});return {...value};
}
function capture({root,hermesHome,installRoot,port,mode='port',executable,entry,resourcesRoot}){
  if(!['port','native-root'].includes(mode)||(mode==='native-root'?port!==null:!Number.isInteger(port)||port<1024||port>65535))
    throw failed('卸载端口绑定无效，未删除文件。');
  const moduleFile=entry.endsWith('.asar')?entry:__filename;
  return {schema:SCHEMA,root,hermesHome,installRoot,port,mode,executable:descriptor(executable),entry:descriptor(entry),
    module:descriptor(moduleFile),resources:Object.fromEntries(resources.map(name=>[name,descriptor(resourceFile(name,{resourcesRoot,entry}))]))};
}
function verify(check,expected){
  if(!check||check.schema!==SCHEMA||!['port','native-root'].includes(check.mode)||check.mode!==expected.mode
    ||(check.mode==='native-root'?check.port!==null:!Number.isInteger(check.port)||check.port<1024||check.port>65535)
    ||!['root','hermesHome','installRoot'].every(key=>same(check[key]||'',expected[key]))
    ||check.port!==expected.port||!check.resources||Object.keys(check.resources).sort().join(',')!==[...resources].sort().join(','))
    throw failed('卸载现场检查绑定不完整，未删除文件。');
  const items=[[check.executable,expected.executable],[check.entry,expected.entry],
    [check.module,expected.entry.endsWith('.asar')?expected.entry:__filename],
    ...resources.map(name=>[check.resources[name],resourceFile(name,expected)])];
  for(const [saved,file] of items){
    if(!saved||!same(saved.path||'',fs.realpathSync(file))||!Number.isSafeInteger(saved.size)||!/^[a-f0-9]{64}$/.test(saved.sha256||''))
      throw failed('卸载现场检查资源不属于当前启动器，未删除文件。');
    // Do not use the capture cache as an admission proof: read current bytes.
    const stat=fs.lstatSync(saved.path);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==saved.size||hash(fs.readFileSync(saved.path))!==saved.sha256)
      throw failed('当前启动器检查资源已变化，未删除文件。');
  }
}
function bounded(command,args,{environment={},timeout=15000}={}){
  const env={...process.env,...environment,PYTHONDONTWRITEBYTECODE:'1',LC_ALL:'C'};
  delete env.NODE_OPTIONS;delete env.PYTHONPATH;delete env.PYTHONHOME;
  for(const key of Object.keys(env))if(key.startsWith('NORA_OPERATION_'))delete env[key];
  const result=spawnSync(command,args,{env,encoding:'utf8',windowsHide:true,timeout,maxBuffer:4*1024*1024,killSignal:'SIGKILL'});
  if(result.error||result.signal||result.status!==0)throw failed('无法完整核验卸载现场进程，未删除文件。',result.error);
  return result.stdout;
}
async function portOffline(port){
  await new Promise((resolve,reject)=>{
    const socket=net.createConnection({host:'127.0.0.1',port});
    socket.setTimeout(1500);socket.once('connect',()=>{socket.destroy();reject(failed('酒馆端口仍有服务监听，未删除文件。'));});
    socket.once('timeout',()=>{socket.destroy();reject(failed('无法确认酒馆端口离线，未删除文件。'));});
    socket.once('error',error=>{socket.destroy();if(error.code==='ECONNREFUSED')resolve();else reject(failed('无法确认酒馆端口离线，未删除文件。',error));});
  });
}
const candidate=name=>/^(?:node|python(?:w|\d+(?:\.\d+)*)?|hermes|liveware)(?:\.exe)?$/i.test(name);
function referencesRoot(text,root,platform=process.platform){
  if(typeof text!=='string')return false;
  const normalize=value=>platform==='win32'?value.replaceAll('/','\\').toLowerCase():value;
  const value=normalize(text),prefix=normalize(root);
  return value===prefix||value.includes(prefix+(platform==='win32'?'\\':'/'));
}
function windowsProcesses(text,{root,pid}){
  let value;try{value=JSON.parse(text);}catch{throw failed('系统进程检查未返回有效记录，未删除文件。');}
  if(value?.schema!=='nora-uninstall-processes/1'||!Array.isArray(value.processes)||value.processes.length>10000)
    throw failed('系统进程检查记录不完整，未删除文件。');
  const seen=new Set();
  for(const item of value.processes){
    if(item.pid===0&&item.name==='System Idle Process'&&!item.executable&&!item.commandLine)continue;
    if(!Number.isSafeInteger(item.pid)||item.pid<1||seen.has(item.pid)||typeof item.name!=='string'||!item.name)
      throw failed('系统进程检查记录不完整，未删除文件。');
    seen.add(item.pid);if(item.pid===pid)continue;
    if(referencesRoot(item.executable,root,'win32')||referencesRoot(item.commandLine,root,'win32'))throw failed('当前安装仍有进程运行，未删除文件。');
    if(candidate(item.name)&&(!item.executable||!item.commandLine))throw failed('无法确认候选服务进程归属，未删除文件。');
    if(/^(?:node|python(?:w|\d+(?:\.\d+)*)?)(?:\.exe)?$/i.test(item.name)){
      // CIM has no working directory. A relative Tavern entry cannot be
      // assigned to another installation merely because the root is absent.
      const tokens=item.commandLine.match(/"[^"\r\n]*"|[^\s"]+/g)||[];
      for(const token of tokens.slice(1)){const value=token.replace(/^"|"$/g,'');
        if(/\.(?:js|mjs|cjs|py)$/i.test(value)&&!path.win32.isAbsolute(value))
          throw failed('无法确认相对路径服务进程归属，未删除文件。');
        if(['-e','--eval','-p','--print','-c','-'].includes(value)||/^(?:--eval|--print)=/.test(value))
          throw failed('无法确认内联服务进程归属，未删除文件。');
      }
      let entry=null;
      for(let index=1;index<tokens.length;index++){
        const value=tokens[index].replace(/^"|"$/g,'');
        if(['-r','--require','--import','--loader','--experimental-loader','--test-reporter','-W','-X'].includes(value)){index++;continue;}
        if(value.startsWith('-'))continue;
        entry=value;break;
      }
      if(!entry||!path.win32.isAbsolute(entry)||!(/\.(?:js|mjs|cjs|py)$/i.test(entry)))
        throw failed('无法确认无明确脚本入口的服务进程归属，未删除文件。');
    }
    if(/^(?:python(?:w|\d+(?:\.\d+)*)?|hermes)(?:\.exe)?$/i.test(item.name)
      &&/(?:hermes_cli[.\\/]main|gateway\s+(?:run|restart))/i.test(item.commandLine))
      throw failed('无法确认候选诺拉后台进程归属，未删除文件。');
  }
  if(!seen.has(pid))throw failed('系统进程快照缺少当前辅助程序，未删除文件。');
}
function lsofName(value){
  const blocks=[];
  for(let index=0;index<value.length;){
    if(value[index]!=='\\'){
      const code=value.codePointAt(index),character=String.fromCodePoint(code);blocks.push(Buffer.from(character));index+=character.length;continue;
    }
    const hexadecimal=/^\\x([a-f0-9]{2})/i.exec(value.slice(index));
    if(hexadecimal){blocks.push(Buffer.from([parseInt(hexadecimal[1],16)]));index+=4;continue;}
    const escapes={'\\':92,n:10,r:13,t:9,b:8,f:12,v:11};
    const next=value[index+1];if(!Object.hasOwn(escapes,next))throw failed('系统进程路径转义无法核验，未删除文件。');
    blocks.push(Buffer.from([escapes[next]]));index+=2;
  }
  try{return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(blocks));}
  catch{throw failed('系统进程路径编码无法核验，未删除文件。');}
}
function macFiles(output,{root,pid}){
  let actualPid=null,cwd=false,text=false,field=null;
  for(const line of output.trim().split('\n')){
    const tag=line[0],data=line.slice(1);
    if(tag==='p'){if(actualPid!==null||Number(data)!==pid)throw failed('候选进程身份已变化，未删除文件。');actualPid=pid;}
    else if(tag==='f'){if(!['cwd','txt'].includes(data))throw failed('候选进程检查记录无效，未删除文件。');field=data;}
    else if(tag==='n'){
      const file=lsofName(data);
      if(actualPid!==pid||!field||!path.posix.isAbsolute(file))throw failed('无法确认候选进程路径，未删除文件。');
      if(referencesRoot(file,root,'darwin'))throw failed('当前安装仍有进程运行，未删除文件。');
      if(field==='cwd')cwd=true;else if(field==='txt')text=true;field=null;
    }else if(tag!=='c')throw failed('候选进程检查记录无效，未删除文件。');
  }
  if(actualPid!==pid||!cwd||!text||field)throw failed('无法完整核验候选服务进程归属，未删除文件。');
}
function nativeOffline({root}){
  if(process.platform==='win32'){
    const systemRoot=process.env.SystemRoot;
    if(!path.win32.isAbsolute(systemRoot||''))throw failed('系统进程检查入口无效，未删除文件。');
    const command=path.win32.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
    const script="$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); $OutputEncoding=[Console]::OutputEncoding; $items=@(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId;name=[string]$_.Name;executable=$_.ExecutablePath;commandLine=$_.CommandLine} }); [pscustomobject]@{schema='nora-uninstall-processes/1';processes=$items} | ConvertTo-Json -Depth 4 -Compress";
    windowsProcesses(bounded(command,['-NoProfile','-NonInteractive','-Command',script]),{root,pid:process.pid});
    return;
  }
  if(process.platform!=='darwin')throw failed('当前系统无法核验卸载现场进程，未删除文件。');
  const deadline=Date.now()+30000;
  const remaining=()=>{const value=deadline-Date.now();if(value<=0)throw failed('系统进程检查超过安全时限，未删除文件。');return Math.min(value,15000);};
  const lines=bounded('/bin/ps',['-ww','-axo','pid=,uid=,comm='],{timeout:remaining()}).trim().split('\n'),targets=[];let self=false;
  for(const line of lines){
    const match=/^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if(!match)throw failed('系统进程检查记录不完整，未删除文件。');
    const pid=Number(match[1]),uid=Number(match[2]),command=match[3];
    if(!Number.isSafeInteger(pid)||pid<1||!Number.isSafeInteger(uid))throw failed('系统进程检查记录无效，未删除文件。');
    if(pid===process.pid){self=true;continue;}
    if(referencesRoot(command,root))throw failed('当前安装仍有进程运行，未删除文件。');
    if(candidate(path.basename(command)))targets.push(pid);
  }
  if(!self)throw failed('系统进程快照缺少当前辅助程序，未删除文件。');
  if(targets.length>256)throw failed('候选服务进程检查超过安全上限，未删除文件。');
  for(const pid of targets){
    // A process can exit between snapshots. Only a positive absent result is safe.
    const status=spawnSync('/bin/ps',['-ww','-p',String(pid),'-o','args='],{encoding:'utf8',env:{...process.env,LC_ALL:'C'},timeout:Math.min(3000,remaining()),maxBuffer:65536});
    if(!status.error&&status.status===1&&!status.stdout.trim())continue;
    if(status.error||status.status!==0||!status.stdout.trim())throw failed('无法确认候选服务进程归属，未删除文件。');
    if(referencesRoot(status.stdout,root))throw failed('当前安装仍有进程运行，未删除文件。');
    // Hermes can bind HERMES_HOME through its environment while executable
    // and cwd both belong elsewhere. Neither lsof nor rootless argv proves
    // that such a module/inline invocation is unrelated to this installation.
    if(/(?:hermes_cli[.\\/]main|gateway\s+(?:run|restart))/i.test(status.stdout)
      ||/(?:^|\s)(?:-e|-c|-p|-i|--eval|--print|--interactive|-)(?:\s|=|$)/.test(status.stdout)
      ||/(?:^|\/)(?:node|python(?:\d+(?:\.\d+)*)?)\s*$/i.test(status.stdout.trim()))
      throw failed('无法确认候选内联或诺拉后台进程归属，未删除文件。');
    const output=bounded('/usr/sbin/lsof',['-a','-p',String(pid),'-d','cwd,txt','-Fpcn'],{timeout:remaining()});
    macFiles(output,{root,pid});
  }
}
async function inspect({check,expected,hermesHome}){
  verify(check,expected);if(check.mode==='port')await portOffline(check.port);
  const venv=path.join(hermesHome,'hermes-agent','venv');
  const command=path.join(venv,process.platform==='win32'?'Scripts/python.exe':'bin/python');
  if(check.mode==='port'&&fs.existsSync(command)){
    const execution=require('./managed-python').resolveExecution(command,{managedPythonRoot:path.join(hermesHome,'python'),venvHome:venv});
    const output=bounded(execution.command,['-B',check.resources['launcher_bridge.py'].path,'--nora-home',check.root,
      '--hermes-home',check.hermesHome,'--install-root',check.installRoot,'--port',String(check.port),'repair-preflight','--offline-only'],
      {environment:execution.env});
    let results;try{results=output.trim().split('\n').map(line=>JSON.parse(line)).filter(value=>value.event==='result');}
    catch{throw failed('服务离线检查未返回有效结果，未删除文件。');}
    if(results.length!==1||results[0].offline!==true||results[0].running!==false||results[0].gatewayRunning!==false)
      throw failed('服务离线状态尚未确认，未删除文件。');
  }else nativeOffline({root:check.root});
  verify(check,expected);if(check.mode==='port')await portOffline(check.port);
  return {offline:true,mode:check.mode,method:check.mode==='port'&&fs.existsSync(command)?'managed-python':'native-os'};
}
module.exports={capture,inspect,windowsProcesses,macFiles,nativeOffline,portOffline,SCHEMA};
