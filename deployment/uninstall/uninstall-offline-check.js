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
  if(!['port','native-root','retained'].includes(mode)||(mode==='native-root'?port!==null:!Number.isInteger(port)||port<1024||port>65535))
    throw failed('卸载端口绑定无效，未删除文件。');
  const moduleFile=entry.endsWith('.asar')?entry:__filename;
  return {schema:SCHEMA,root,hermesHome,installRoot,port,mode,executable:descriptor(executable),entry:descriptor(entry),
    module:descriptor(moduleFile),resources:Object.fromEntries(resources.map(name=>[name,descriptor(resourceFile(name,{resourcesRoot,entry}))]))};
}
function verify(check,expected){
  if(!check||check.schema!==SCHEMA||!['port','native-root','retained'].includes(check.mode)||check.mode!==expected.mode
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
// Kernel argv/environment boundaries and microsecond birth identity avoid
// guessing ownership from ps's unquoted environment text. Only the declared
// argv and installation paths leave this helper; never log its private output.
const MAC_PROCESS_EVIDENCE=String.raw`function run(input) {
  ObjC.import('Foundation');
  ObjC.bindFunction('sysctl', ['int', ['void *','unsigned int','void *','void *','void *','unsigned long']]);
  ObjC.bindFunction('proc_pidinfo', ['int', ['int','int','unsigned long long','void *','int']]);
  var cap=1048576, pid=Number(input[0]);
  if (!Number.isSafeInteger(pid)||pid<1||pid>2147483647) throw Error('Invalid process identity');
  function raw(data) {
    var s=ObjC.unwrap(data.base64EncodedStringWithOptions(0)), out=[], bits=0, value=0;
    var chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    for(var i=0;i<s.length&&s[i]!=='=';i++) { value=value*64+chars.indexOf(s[i]); bits+=6;
      if(bits>=8) { bits-=8; out.push((value>>bits)&255); value&=(1<<bits)-1; } }
    return out;
  }
  function encoded(bytes) {
    var chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', out='';
    for(var i=0;i<bytes.length;i+=3) { var a=bytes[i], b=bytes[i+1], c=bytes[i+2], v=(a<<16)|((b||0)<<8)|(c||0);
      out+=chars[(v>>>18)&63]+chars[(v>>>12)&63]+(b===undefined?'=':chars[(v>>>6)&63])+(c===undefined?'=':chars[v&63]); }
    return out;
  }
  function data(bytes) { return $.NSData.alloc.initWithBase64EncodedStringOptions(encoded(bytes),0); }
  function u32(a,i) { return a[i]+a[i+1]*256+a[i+2]*65536+a[i+3]*16777216; }
  function u64(a,i) { var n=u32(a,i)+u32(a,i+4)*4294967296; if(!Number.isSafeInteger(n))throw Error('Invalid native integer');return n; }
  function birth() {
    // Darwin's 64-bit proc_bsdinfo contains PID/UID and microsecond birth time.
    var d=$.NSMutableData.dataWithLength(136);
    if($.proc_pidinfo(pid,3,0,d.mutableBytes,136)!==136)throw Error('Process identity unavailable');
    var a=raw(d), value={pid:u32(a,12),uid:u32(a,20),created:[u64(a,120),u64(a,128)]};
    if(value.pid!==pid||value.created[0]<1||value.created[1]>999999||u32(a,4)===5)throw Error('Invalid process identity');
    return value;
  }
  var before=birth(), mib=data([1,0,0,0,49,0,0,0,pid&255,(pid>>>8)&255,(pid>>>16)&255,(pid>>>24)&255]);
  var output=$.NSMutableData.dataWithLength(cap), length=$.NSMutableData.alloc.initWithBase64EncodedStringOptions('AAAQAAAAAAA=',0);
  if($.sysctl(mib.bytes,3,output.mutableBytes,length.mutableBytes,null,0)!==0)throw Error('Process arguments unavailable');
  var size=u64(raw(length),0);
  if(size<8||size>=cap)throw Error('Invalid process argument size');
  output.setLength(size);
  var bytes=raw(output), argc=u32(bytes,0), pos=4;
  if(argc<1||argc>65536)throw Error('Invalid argument count');
  function read() {
    var start=pos;while(pos<size&&bytes[pos]!==0)pos++;
    if(pos>=size)throw Error('Truncated process argument record');
    var value=ObjC.unwrap($.NSString.alloc.initWithDataEncoding(output.subdataWithRange($.NSMakeRange(start,pos-start)),4));
    pos++;if(typeof value!=='string')throw Error('Invalid process record encoding');return value;
  }
  var executable=read(); if(!executable||executable[0]!=='/')throw Error('Invalid executable record');
  while(pos<size&&bytes[pos]===0)pos++;
  var argv=[];for(var i=0;i<argc;i++)argv.push(read());
  if(!argv[0])throw Error('Invalid first argument');
  var allowed={HERMES_HOME:1,NORA_HERMES_HOME:1,NORA_TAVERN_HOME:1,TAVERN_DATA_ROOT:1,HERMES_INSTALL_DIR:1,
    PYTHONPATH:1,PYTHONHOME:1,PYTHONEXECUTABLE:1,__PYVENV_LAUNCHER__:1,TAVERN_NODE_EXECUTABLE:1,VIRTUAL_ENV:1};
  var environment={}, seen=Object.create(null);
  while(pos<size&&bytes[pos]!==0) {
    var entry=read(), split=entry.indexOf('=');if(split<=0)throw Error('Invalid environment record');
    var key=entry.slice(0,split);if(seen[key])throw Error('Duplicate environment key');seen[key]=true;
    if(Object.prototype.hasOwnProperty.call(allowed,key))environment[key]=entry.slice(split+1);
  }
  if(pos>=size)throw Error('Incomplete environment record');
  // Darwin appends Apple data after the environment. A relevant key there is ambiguous.
  while(pos<size) { if(bytes[pos]===0){pos++;continue;} var tail=read(), split=tail.indexOf('=');
    if(split>0&&Object.prototype.hasOwnProperty.call(allowed,tail.slice(0,split)))throw Error('Ambiguous environment boundary'); }
  var after=birth();
  if(JSON.stringify(before)!==JSON.stringify(after))throw Error('Process identity changed');
  return JSON.stringify({schema:'nora-uninstall-mac-process/1',pid:pid,uid:before.uid,created:before.created,argv:argv,environment:environment});
}
`;
const HERMES_BINDINGS=['HERMES_HOME','NORA_HERMES_HOME','NORA_TAVERN_HOME','TAVERN_DATA_ROOT',
  'HERMES_INSTALL_DIR','PYTHONPATH','PYTHONHOME','PYTHONEXECUTABLE','__PYVENV_LAUNCHER__','TAVERN_NODE_EXECUTABLE','VIRTUAL_ENV'];
function macHermesProcess(pid,root,timeout){
  let value;
  try{value=JSON.parse(bounded('/usr/bin/osascript',['-l','JavaScript','-e',MAC_PROCESS_EVIDENCE,'--',String(pid)],{timeout}));}
  catch(error){throw failed('无法读取候选诺拉后台的实例归属，未删除文件。',error);}
  if(value?.schema!=='nora-uninstall-mac-process/1'||value.pid!==pid||value.uid!==process.getuid()
    ||!Array.isArray(value.created)||value.created.length!==2||!value.created.every(Number.isSafeInteger)
    ||value.created[0]<1||value.created[1]<0||value.created[1]>999999
    ||!Array.isArray(value.argv)||value.argv.length<2||value.argv.length>128||!value.argv.every(item=>typeof item==='string')
    ||!value.environment||Array.isArray(value.environment)||typeof value.environment!=='object'
    ||Object.keys(value.environment).some(key=>!HERMES_BINDINGS.includes(key)||typeof value.environment[key]!=='string'))
    throw failed('候选诺拉后台的进程证据不完整，未删除文件。');
  const canonicalRoot=fs.realpathSync(root),paths={};
  const outside=(file,{directory=true}={})=>{
    if(!path.posix.isAbsolute(file||''))throw failed('候选诺拉后台缺少明确实例路径，未删除文件。');
    let resolved,stat;
    try{resolved=fs.realpathSync(file);stat=fs.statSync(resolved);}catch{throw failed('候选诺拉后台的实例路径无法核验，未删除文件。');}
    if(directory?!stat.isDirectory():!stat.isFile())throw failed('候选诺拉后台的实例路径类型无法核验，未删除文件。');
    if(resolved==='/'||resolved===canonicalRoot||resolved.startsWith(canonicalRoot+'/')||canonicalRoot.startsWith(resolved+'/'))
      throw failed('当前安装仍有诺拉后台进程运行，未删除文件。');
    return resolved;
  };
  const executable=file=>({file:outside(file,{directory:false}),directory:outside(path.posix.dirname(file))});
  // A venv binary may resolve to a base interpreter outside the installation;
  // its invocation directory still selects that venv's pyvenv.cfg and modules.
  paths.interpreter=executable(value.argv[0]);
  paths.HERMES_HOME=outside(value.environment.HERMES_HOME);
  for(const [key,file] of Object.entries(value.environment)){
    if(['PYTHONPATH','PYTHONHOME'].includes(key))paths[key]=file.split(':').map(item=>outside(item));
    else if(['TAVERN_NODE_EXECUTABLE','PYTHONEXECUTABLE','__PYVENV_LAUNCHER__'].includes(key))paths[key]=executable(file);
    else paths[key]=outside(file);
  }
  const args=value.argv.slice(1);
  while(['-B','-u','-s','-E','-I'].includes(args[0]))args.shift();
  if(args[0]==='-m'&&args[1]==='hermes_cli.main')args.splice(0,2);
  else if(path.posix.isAbsolute(args[0]||'')&&(/(?:^|\/)hermes$|\/hermes_cli\/main\.py$/.test(args[0]))){
    paths.entry=outside(args.shift(),{directory:false});
  }else throw failed('候选诺拉后台入口无法核验，未删除文件。');
  if(JSON.stringify(args)!==JSON.stringify(['gateway','run'])
    &&JSON.stringify(args)!==JSON.stringify(['gateway','run','--replace'])
    &&JSON.stringify(args)!==JSON.stringify(['gateway','restart']))
    throw failed('候选诺拉后台命令无法核验，未删除文件。');
  return {...value,paths};
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
    const hermes=/(?:hermes_cli[.\\/]main|gateway\s+(?:run|restart))/i.test(status.stdout);
    if(/(?:^|\s)(?:-e|-c|-p|-i|--eval|--print|--interactive|-)(?:\s|=|$)/.test(status.stdout)
      ||/(?:^|\/)(?:node|python(?:\d+(?:\.\d+)*)?)\s*$/i.test(status.stdout.trim()))
      throw failed('无法确认候选内联或诺拉后台进程归属，未删除文件。');
    const before=hermes?macHermesProcess(pid,root,remaining()):null;
    const output=bounded('/usr/sbin/lsof',['-a','-p',String(pid),'-d','cwd,txt','-Fpcn'],{timeout:remaining()});
    macFiles(output,{root,pid});
    if(hermes&&JSON.stringify(before)!==JSON.stringify(macHermesProcess(pid,root,remaining())))
      throw failed('候选诺拉后台的进程或实例归属已变化，未删除文件。');
  }
}
async function inspect({check,expected,hermesHome}){
  verify(check,expected);if(check.mode!=='native-root')await portOffline(check.port);
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
  verify(check,expected);if(check.mode!=='native-root')await portOffline(check.port);
  return {offline:true,mode:check.mode,method:check.mode==='port'&&fs.existsSync(command)?'managed-python':'native-os'};
}
module.exports={capture,inspect,windowsProcesses,macFiles,nativeOffline,portOffline,SCHEMA};
