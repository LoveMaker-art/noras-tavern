const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const io=process.versions.electron?require('original-fs'):fs;
const SCHEMA='nora-app-helper-runtime/1';
const DESCRIPTOR='app-helper-runtime.json';
const verified=new WeakSet();
const LIMITS=Object.freeze({files:25000,bytes:512*1024*1024,descriptor:8*1024*1024});
const failure=(message,code='APP_HELPER_RUNTIME_INVALID',cause)=>Object.assign(new Error(message,cause?{cause}:undefined),{code});
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const within=(root,file)=>file===root||file.startsWith(root+path.sep);
const safeRelative=value=>typeof value==='string'&&value.length>0&&value.length<1024&&!value.includes('\0')
  &&!value.includes('\\')&&!path.posix.isAbsolute(value)&&!value.split('/').some(p=>!p||p==='.'||p==='..'||p.includes(':'));
function directory(file){
  const absolute=path.resolve(file);let current=path.parse(absolute).root;
  for(const part of path.relative(current,absolute).split(path.sep).filter(Boolean)){
    current=path.join(current,part);const stat=io.lstatSync(current);
    if(stat.isSymbolicLink()||!stat.isDirectory())throw failure('APP助手目录被重定向或不是目录。');
  }
  return absolute;
}
function imageDigest(value){
  return sha(JSON.stringify({platform:value.platform,arch:value.arch,executable:value.executable,
    pythonRoot:value.pythonRoot,pythonVersion:value.pythonVersion,psutilVersion:value.psutilVersion,files:value.files}));
}
function validateDescriptor(value,{platform=process.platform,arch=process.arch}={}){
  if(!value||value.schema!==SCHEMA||value.platform!==platform||value.arch!==arch
    ||!['darwin-arm64','darwin-x64','win32-x64'].includes(`${platform}-${arch}`)
    ||value.root!=='app-helper-runtime'||value.pythonRoot!=='python'||!safeRelative(value.executable)
    ||!value.executable.startsWith('python/')||!/^3\.\d+\.\d+$/.test(value.pythonVersion||'')
    ||!/^\d+\.\d+\.\d+$/.test(value.psutilVersion||'')||!Array.isArray(value.files)
    ||value.files.length<2||value.files.length>LIMITS.files||!/^[a-f0-9]{64}$/.test(value.imageSha256||''))
    throw failure('APP助手运行资源清单不适用于当前系统。');
  let previous='',total=0;const seen=new Set();
  for(const entry of value.files){
    const name=entry?.path,key=platform==='win32'?name?.toLowerCase():name;
    if(!safeRelative(name)||name<=previous||seen.has(key)||!['file','symlink'].includes(entry.type)
      ||name.split('/').some(part=>/^(?:sitecustomize|usercustomize)\.pyc?$/.test(part)||part.endsWith('.pth')))
      throw failure('APP助手运行资源清单包含重复、重定向或不安全路径。');
    seen.add(key);previous=name;
    if(entry.type==='file'){
      if(Object.keys(entry).some(k=>!['path','type','size','sha256'].includes(k))
        ||!Number.isSafeInteger(entry.size)||entry.size<0||!/^[a-f0-9]{64}$/.test(entry.sha256||''))
        throw failure('APP助手文件校验信息不完整。');
      total+=entry.size;
    }else if(Object.keys(entry).some(k=>!['path','type','target'].includes(k))
      ||typeof entry.target!=='string'||!entry.target||entry.target.includes('\0')||entry.target.includes('\\')
      ||path.posix.isAbsolute(entry.target)||!safeRelative(path.posix.normalize(path.posix.join(path.posix.dirname(name),entry.target))))
      throw failure('APP助手链接必须留在自己的运行目录。');
  }
  if(total>LIMITS.bytes||!seen.has(platform==='win32'?value.executable.toLowerCase():value.executable)
    ||imageDigest(value)!==value.imageSha256)throw failure('APP助手运行资源摘要无效。');
  return value;
}
async function hashFile(file){
  const before=io.lstatSync(file);if(!before.isFile()||before.isSymbolicLink())throw failure('APP助手文件类型无法核验。');
  const hash=crypto.createHash('sha256');for await(const bytes of io.createReadStream(file))hash.update(bytes);
  const after=io.lstatSync(file);
  if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)
    throw failure('APP助手文件在校验期间变化。');
  return {size:after.size,sha256:hash.digest('hex')};
}
async function inventory(root){
  root=directory(root);const files=[];let count=0;
  async function walk(base,relative,depth){
    if(depth>64)throw failure('APP助手目录层级过深。');
    for(const entry of io.readdirSync(base,{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
      if(++count>LIMITS.files*2)throw failure('APP助手运行资源数量超限。');
      const name=relative?relative+'/'+entry.name:entry.name,file=path.join(base,entry.name),stat=io.lstatSync(file);
      if(!safeRelative(name))throw failure('APP助手路径无效。');
      if(stat.isSymbolicLink()){
        const target=io.readlinkSync(file),resolved=io.realpathSync(file);
        if(!within(root,resolved))throw failure('APP助手链接指向运行目录之外。');
        files.push({path:name,type:'symlink',target});
      }else if(stat.isDirectory())await walk(file,name,depth+1);
      else if(stat.isFile())files.push({path:name,type:'file',...await hashFile(file)});
      else throw failure('APP助手含未知文件类型。');
    }
  }
  await walk(root,'',0);return files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
async function verifyTree(root,descriptor){
  const before=io.statSync(directory(root)),actual=await inventory(root);
  if(JSON.stringify(actual)!==JSON.stringify(descriptor.files))throw failure('APP助手运行资源已变化，未执行或覆盖原副本。');
  const after=io.statSync(root);
  if(before.dev!==after.dev||before.ino!==after.ino)throw failure('APP助手目录在校验期间变化。');
  const executable=path.join(root,...descriptor.executable.split('/'));
  if(!within(root,io.realpathSync(executable)))throw failure('APP助手解释器指向目录之外。');
  if(process.platform!=='win32')io.accessSync(executable,fs.constants.X_OK);
  return executable;
}
function readDescriptor(resourcesRoot,expected,{platform,arch}){
  if(!/^[a-f0-9]{64}$/.test(expected||''))throw failure('APP助手清单缺少APP本体提供的可信摘要。','APP_HELPER_RUNTIME_UNTRUSTED');
  const file=path.join(directory(resourcesRoot),DESCRIPTOR),stat=io.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>LIMITS.descriptor)throw failure('APP助手清单不是有效文件。');
  const bytes=io.readFileSync(file);if(sha(bytes)!==expected)throw failure('APP助手清单与APP本体记录不一致。');
  try{return validateDescriptor(JSON.parse(bytes),{platform,arch});}
  catch(error){if(error.code)throw error;throw failure('APP助手清单无法读取。',undefined,error);}
}
function environment(home,root,profile,source){
  const env={};for(const key of ['SystemRoot','WINDIR','COMSPEC','LANG','LC_ALL'])if(source[key])env[key]=source[key];
  Object.assign(env,{HOME:profile,USERPROFILE:profile,APPDATA:path.join(profile,'appdata'),LOCALAPPDATA:path.join(profile,'localappdata'),
    TMPDIR:profile,TMP:profile,TEMP:profile,NORA_TAVERN_HOME:home,PYTHONNOUSERSITE:'1',PYTHONSAFEPATH:'1',PYTHONDONTWRITEBYTECODE:'1',PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'});
  env.PATH=[path.join(root,'python',process.platform==='win32'?'':'bin'),...(process.platform==='win32'
    ?[path.join(source.SystemRoot||'C:\\Windows','System32')]:['/usr/bin','/bin'])].join(path.delimiter);
  return env;
}
const PROBE=['import json,os,sys,psutil','from pathlib import Path',
  'process=psutil.Process()',
  'assert process.pid == os.getpid() and process.create_time() > 0 and process.is_running()',
  'assert isinstance(process.status(),str) and isinstance(process.username(),str) and isinstance(process.cmdline(),list)',
  'assert all(issubclass(getattr(psutil,name),Exception) for name in ("Error","NoSuchProcess","ZombieProcess","AccessDenied"))',
  'assert isinstance(psutil.STATUS_ZOMBIE,str)',
  'observed=next(item for item in psutil.process_iter(["pid","create_time","exe","cmdline"],ad_value=None) if item.pid==process.pid)',
  'assert observed.info["pid"] == process.pid and observed.info["create_time"] == process.create_time()',
  "print(json.dumps({'pythonVersion':'.'.join(map(str,sys.version_info[:3])),'basePrefix':str(Path(sys.base_prefix).resolve()),'prefix':str(Path(sys.prefix).resolve()),'psutilVersion':psutil.__version__,'psutilFile':str(Path(psutil.__file__).resolve()),'processExecutable':str(Path(process.exe()).resolve()),'requiredApis':True}))"].join('\n');
function probe(command,env,cwd,{spawnProbe=spawn}={}){
  return new Promise((resolve,reject)=>{
    const child=spawnProbe(command,['-I','-B','-c',PROBE],{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let out='',cause,force,unconfirmed,settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;
      clearTimeout(timeout);clearTimeout(force);clearTimeout(unconfirmed);error?reject(error):resolve(value);};
    const stop=()=>{
      if(force||settled)return;
      child.kill();force=setTimeout(()=>{
        child.kill('SIGKILL');
        unconfirmed=setTimeout(()=>{
          // This process only runs the fixed read-only probe. Refuse APP
          // mutation, retain the image, and report absent closure explicitly.
          const error=failure('APP助手检查进程尚未确认退出，未开始程序替换。','APP_HELPER_RUNTIME_EXECUTOR_UNCONFIRMED',cause);
          error.probeTerminationConfirmed=false;if(Number.isSafeInteger(child.pid))error.probePid=child.pid;
          child.stdout.destroy?.();child.stderr.destroy?.();child.unref?.();finish(error);
        },1000);unconfirmed.unref?.();
      },2000);force.unref?.();
    };
    const timeout=setTimeout(()=>{cause=failure('APP助手运行检查超时。','APP_HELPER_RUNTIME_UNAVAILABLE');stop();},10000);timeout.unref?.();
    child.stdout.on('data',b=>{if(settled)return;out+=b;if(out.length>8192){cause=failure('APP助手检查返回内容过大。');stop();}});
    child.stderr.on('data',()=>{});
    child.once('error',error=>{cause=failure('APP助手无法执行。','APP_HELPER_RUNTIME_UNAVAILABLE',error);});
    child.once('close',code=>{clearTimeout(timeout);clearTimeout(force);
      if(cause)return finish(cause);
      if(code!==0)return finish(failure('APP助手独立运行检查失败。','APP_HELPER_RUNTIME_UNAVAILABLE'));
      try{finish(null,JSON.parse(out));}catch(error){finish(failure('APP助手检查没有返回有效结果。',undefined,error));}
    });
  });
}
async function inspectedExecution({home,root,descriptor,descriptorFile,descriptorSha256,command,profile,platform,env,spawnProbe,materialized}){
  // Windows propagates the executable's extended path to native Python modules.
  // Keep the ordinary path for the cache and the sealed helper reference.
  const launchCommand=path.toNamespacedPath(command);
  const executionEnv=environment(home,root,profile,env),observed=await probe(launchCommand,executionEnv,profile,{spawnProbe});
  const pythonRoot=io.realpathSync(path.join(root,descriptor.pythonRoot));
  const canonical=value=>platform==='win32'?path.toNamespacedPath(path.resolve(value||'')).toLowerCase():path.resolve(value||'');
  if(observed.requiredApis!==true||canonical(observed.processExecutable)!==canonical(io.realpathSync(command))
    ||observed.pythonVersion!==descriptor.pythonVersion||observed.psutilVersion!==descriptor.psutilVersion
    ||canonical(observed.basePrefix)!==canonical(pythonRoot)||canonical(observed.prefix)!==canonical(pythonRoot)
    ||!within(canonical(pythonRoot),canonical(observed.psutilFile)))throw failure('APP助手加载了闭包之外的Python或模块。');
  const result=Object.freeze({command:io.realpathSync(command),launchCommand,env:Object.freeze(executionEnv),root,managedPythonRoot:pythonRoot,
    imageSha256:descriptor.imageSha256,descriptorSha256,descriptorFile,pythonVersion:descriptor.pythonVersion,psutilVersion:descriptor.psutilVersion,
    materialized});
  verified.add(result);return result;
}
async function resolve({home,executable,resourcesRoot,descriptorSha256,platform=process.platform,arch=process.arch,env=process.env,
  spawnProbe,materialize=true}={}){
  const app=platform==='darwin'?path.resolve(executable,'../../..'):path.dirname(executable);
  home=directory(home);resourcesRoot=directory(resourcesRoot);
  const descriptor=readDescriptor(resourcesRoot,descriptorSha256,{platform,arch});
  const source=directory(path.join(resourcesRoot,descriptor.root));
  if(!materialize){
    const command=await verifyTree(source,descriptor);
    // Admission and status can inspect the shipped interpreter without publishing
    // cache/profile files while uninstall or another operation owns the writer.
    return inspectedExecution({home,root:source,descriptor,descriptorSha256,command,profile:resourcesRoot,
      descriptorFile:path.join(resourcesRoot,DESCRIPTOR),platform,env,spawnProbe,materialized:false});
  }
  const installer=path.join(home,'installer');io.mkdirSync(installer,{recursive:true,mode:0o700});directory(installer);
  const base=path.join(installer,'app-helper-runtime');io.mkdirSync(base,{recursive:true,mode:0o700});directory(base);
  if(within(app,base)||within(base,app)||within(source,base)||within(base,source))throw failure('APP助手必须位于交换程序树之外。');
  const target=path.join(base,descriptor.imageSha256);let command;
  if(io.existsSync(target))command=await verifyTree(target,descriptor);
  else{
    await verifyTree(source,descriptor);
    const stage=path.join(base,'.prepare-'+crypto.randomUUID());io.mkdirSync(stage,{mode:0o700});let complete=false;
    try{
      for(const name of io.readdirSync(source))await io.promises.cp(path.join(source,name),path.join(stage,name),
        {recursive:true,dereference:false,verbatimSymlinks:true,errorOnExist:true,force:false,
          ...(platform==='win32'?{filter:()=>true}:{})});
      await verifyTree(stage,descriptor);
      try{io.renameSync(stage,target);}catch(error){
        if(!['EEXIST','ENOTEMPTY','EPERM'].includes(error.code)||!io.existsSync(target))throw error;
        await verifyTree(target,descriptor);
      }
      command=await verifyTree(target,descriptor);
      complete=true;
    }catch(error){error.retainedStage=stage;throw error;}
    finally{if(complete&&io.existsSync(stage))io.rmSync(stage,{recursive:true,force:true});}
  }
  const profile=path.join(base,'profile');io.mkdirSync(profile,{recursive:true,mode:0o700});directory(profile);
  const descriptorFile=path.join(base,descriptor.imageSha256+'.json');
  const descriptorBytes=io.readFileSync(path.join(resourcesRoot,DESCRIPTOR));
  if(sha(descriptorBytes)!==descriptorSha256)throw failure('APP助手清单在复制期间变化。');
  if(io.existsSync(descriptorFile)){
    const stat=io.lstatSync(descriptorFile);
    if(!stat.isFile()||stat.isSymbolicLink()||sha(io.readFileSync(descriptorFile))!==descriptorSha256)
      throw failure('APP助手的保留清单已变化，未覆盖原现场。');
  }else try{io.writeFileSync(descriptorFile,descriptorBytes,{flag:'wx',mode:0o600});}
  catch(error){if(error.code!=='EEXIST'||sha(io.readFileSync(descriptorFile))!==descriptorSha256)throw error;}
  return inspectedExecution({home,root:target,descriptor,descriptorFile,descriptorSha256,command,profile,platform,env,spawnProbe,materialized:true});
}
module.exports={resolve,isVerified:value=>verified.has(value),imageDigest,inventory,validateDescriptor,SCHEMA,DESCRIPTOR};
