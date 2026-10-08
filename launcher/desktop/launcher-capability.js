const fs=require('node:fs');
const physicalFs=process.versions.electron?require('original-fs'):fs;
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');

const SCHEMA='nora-launcher-control/1';
const RESOURCE_NAMES=Object.freeze(['launcher_bridge.py','first_install.py','nora_system.py','nora_profile.py',
  'launcher_services.py','model_config.py','bootstrap.py','update_recovery.py','update_paths.py',
  'error_diagnostics.py','operation_control.py','operation_cli.py','operation_evidence.py','operation_node.mjs','mcp_probe.mjs','operation-delegate.js','operation-budget.json','replace-launcher.py']);
const SOURCES=Object.freeze({'ops/updater/bootstrap.py':'bootstrap','ops/updater/update.py':'update','ops/installer/nora_system.py':'system'});
const failure=(code='OPERATION_CAPABILITY_INVALID')=>Object.assign(new Error(
  '无法核验已安装的新版启动器，未修改安装和数据。请保留诺拉数据，只重新安装最新版启动器。'),{code});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const receiptPath=noraHome=>path.join(path.resolve(noraHome),'installer','launcher-control.json');
const samePath=(left,right,platform=process.platform)=>platform==='win32'?left.toLowerCase()===right.toLowerCase():left===right;

function safePath(file,{directory=false,allowMissing=false,owner=false,allowRoot=false,io=physicalFs}={}){
  if(typeof file!=='string'||!path.isAbsolute(file))throw failure();
  const absolute=path.resolve(file);
  let current=path.parse(absolute).root;
  for(const part of path.relative(current,absolute).split(path.sep)){
    current=path.join(current,part);
    let stat;try{stat=io.lstatSync(current);}catch(error){if(allowMissing&&error.code==='ENOENT')return absolute;throw failure();}
    if(stat.isSymbolicLink())throw failure();
    if(current!==absolute&&!stat.isDirectory())throw failure();
  }
  const stat=io.statSync(absolute);
  if(directory?!stat.isDirectory():!stat.isFile())throw failure();
  if(owner&&process.platform!=='win32'&&((stat.uid!==process.getuid()&&!(allowRoot&&stat.uid===0))||(stat.mode&0o022)))throw failure();
  return absolute;
}
async function descriptor(file){
  safePath(file,{owner:true,allowRoot:true});
  const before=physicalFs.statSync(file);
  const hash=createHash('sha256');
  for await(const bytes of physicalFs.createReadStream(file))hash.update(bytes);
  const after=physicalFs.statSync(file);
  if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw failure();
  return {path:file,size:after.size,sha256:hash.digest('hex')};
}
function rootFor(executable,platform){
  return platform==='darwin'?path.resolve(executable,'../../Resources'):path.join(path.dirname(executable),'resources');
}
function checkShape(value,{noraHome,platform,arch,currentExecutable}={}){
  if(!value||value.schema!==SCHEMA||value.capabilityVersion!==1||value.executorProtocol!=='nora-operation-executor/1'
    ||value.operationSchema!=='nora-operation/1'||value.telemetrySchema!==3||value.faultSchema!==2
    ||!['darwin-arm64','darwin-x64','win32-x64'].includes(`${value.platform}-${value.arch}`)
    ||value.platform!==platform||value.arch!==arch||!['stable','beta'].includes(value.channel)
    ||!Number.isInteger(value.port)||value.port<1024||value.port>65535||!/^\d+\.\d+\.\d+(?:[-.][\w.-]+)?$/.test(value.launcherVersion||'')
    ||!samePath(value.noraHome,path.resolve(noraHome),platform)||!samePath(value.installerDirectory,path.join(value.noraHome,'installer'),platform)
    ||!samePath(value.resourcesRoot,rootFor(value.executable?.path||'',platform),platform)
    ||!samePath(value.asar?.path||'',path.join(value.resourcesRoot,'app.asar'),platform)
    ||!samePath(value.entry||'',path.join(value.asar.path,'operation-cli.js'),platform)
    ||!samePath(value.native?.path||'',path.join(value.resourcesRoot,'app.asar.unpacked','node_modules/fs-native-extensions/prebuilds',`${platform}-${arch}`,'fs-native-extensions.node'),platform)
    ||currentExecutable&&!samePath(value.executable.path,path.resolve(currentExecutable),platform))throw failure();
  for(const directory of [value.hermesHome,value.installRoot]){
    const relative=typeof directory==='string'?path.relative(value.noraHome,directory):'..';
    if(!relative||relative.startsWith(`..${path.sep}`)||relative==='..'||path.isAbsolute(relative))throw failure();
    safePath(directory,{directory:true,allowMissing:true,owner:true});
  }
  for(const name of RESOURCE_NAMES)if(!samePath(value.resources?.[name]?.path||'',path.join(value.resourcesRoot,name),platform))throw failure();
  if(Object.keys(value.resources||{}).length!==RESOURCE_NAMES.length)throw failure();
  for(const item of [value.executable,value.asar,value.native,...Object.values(value.resources),...Object.values(value.managed||{})]){
    if(!item||!path.isAbsolute(item.path||'')||!Number.isSafeInteger(item.size)||item.size<1||!/^[a-f0-9]{64}$/.test(item.sha256||''))throw failure();
  }
  const sourceHash=sha(JSON.stringify([value.asar.sha256,value.native.sha256,RESOURCE_NAMES.map(name=>[name,value.resources[name].sha256])]));
  if(value.sourceHash!==sourceHash)throw failure();
}
async function register({noraHome,hermesHome,installRoot,executable,resourcesRoot,isPackaged,launcherVersion,platform=process.platform,arch=process.arch,port,channel='stable'}={}){
  if(isPackaged!==true)throw failure('OPERATION_CAPABILITY_REQUIRED');
  noraHome=path.resolve(noraHome);executable=path.resolve(executable);resourcesRoot=path.resolve(resourcesRoot);
  hermesHome=path.resolve(hermesHome||path.join(noraHome,'hermes'));installRoot=path.resolve(installRoot||path.join(noraHome,'tavern'));
  safePath(noraHome,{directory:true,owner:true});safePath(resourcesRoot,{directory:true});
  const installerDirectory=path.join(noraHome,'installer');safePath(installerDirectory,{directory:true,allowMissing:true,owner:true});
  physicalFs.mkdirSync(installerDirectory,{recursive:true,mode:0o700});
  safePath(installerDirectory,{directory:true,owner:true});
  const resources={};for(const name of RESOURCE_NAMES)resources[name]=await descriptor(path.join(resourcesRoot,name));
  const asar=await descriptor(path.join(resourcesRoot,'app.asar'));
  const native=await descriptor(path.join(resourcesRoot,'app.asar.unpacked','node_modules/fs-native-extensions/prebuilds',`${platform}-${arch}`,'fs-native-extensions.node'));
  const receipt={schema:SCHEMA,capabilityVersion:1,executorProtocol:'nora-operation-executor/1',operationSchema:'nora-operation/1',telemetrySchema:3,faultSchema:2,
    noraHome,hermesHome,installRoot,installerDirectory,launcherVersion,platform,arch,port,channel,resourcesRoot,
    executable:await descriptor(executable),asar,native,entry:path.join(asar.path,'operation-cli.js'),resources,
    sourceHash:sha(JSON.stringify([asar.sha256,native.sha256,RESOURCE_NAMES.map(name=>[name,resources[name].sha256])])),
    managed:{},registeredAt:new Date().toISOString()};
  const manifestFile=path.join(installRoot,'tavern-updates/installed-manifest.json');
  if(physicalFs.existsSync(manifestFile)){
    const manifest=JSON.parse(physicalFs.readFileSync(safePath(manifestFile,{owner:true}),'utf8'));
    const installedFile=path.join(installRoot,'tavern-updates/installed.json');
    const installed=JSON.parse(physicalFs.readFileSync(safePath(installedFile,{owner:true}),'utf8'));
    if(manifest.schema!=='tavern-release/v2'||!manifest.commit||manifest.commit!==installed.commit||manifest.versions?.tavern!==installed.version)throw failure();
    receipt.installedManifest=await descriptor(manifestFile);receipt.installedReceipt=await descriptor(installedFile);
    for(const name of Object.keys(SOURCES)){
      const target=path.join(installRoot,'apps/tavern-ops',...name.split('/').slice(1));
      if(!physicalFs.existsSync(target))continue;
      const item=await descriptor(target);
      if(manifest.artifacts?.[name]!==item.sha256)continue; // A damaged updater never becomes a capability.
      receipt.managed[name]=item;
    }
  }
  checkShape(receipt,{noraHome,platform,arch});
  const file=receiptPath(noraHome),temporary=`${file}.${randomUUID()}.tmp`;
  safePath(file,{allowMissing:true,owner:true});
  const fd=physicalFs.openSync(temporary,'wx',0o600);
  try{physicalFs.writeFileSync(fd,JSON.stringify(receipt));physicalFs.fsyncSync(fd);}finally{physicalFs.closeSync(fd);}
  try{physicalFs.renameSync(temporary,file);}finally{physicalFs.rmSync(temporary,{force:true});}
  return receipt;
}
async function validate({receiptPath:file,noraHome,platform=process.platform,arch=process.arch,currentExecutable}={}){
  try{
    if(!samePath(path.resolve(file),receiptPath(noraHome),platform))throw failure();
    safePath(noraHome,{directory:true,owner:true});safePath(path.dirname(file),{directory:true,owner:true});
    safePath(file,{owner:true});if(physicalFs.statSync(file).size>128*1024)throw failure();
    const receipt=JSON.parse(physicalFs.readFileSync(file,'utf8'));checkShape(receipt,{noraHome,platform,arch,currentExecutable});
    for(const item of [receipt.executable,receipt.asar,receipt.native,...Object.values(receipt.resources),...Object.values(receipt.managed||{}),
      ...(receipt.installedManifest?[receipt.installedManifest,receipt.installedReceipt]:[])]){
      const actual=await descriptor(item.path);if(actual.size!==item.size||actual.sha256!==item.sha256)throw failure();
    }
    if(receipt.installedManifest){
      if(!samePath(receipt.installedManifest.path,path.join(receipt.installRoot,'tavern-updates/installed-manifest.json'),platform)
        ||!samePath(receipt.installedReceipt.path,path.join(receipt.installRoot,'tavern-updates/installed.json'),platform))throw failure();
      const manifest=JSON.parse(physicalFs.readFileSync(receipt.installedManifest.path,'utf8'));
      const installed=JSON.parse(physicalFs.readFileSync(receipt.installedReceipt.path,'utf8'));
      if(manifest.schema!=='tavern-release/v2'||!manifest.commit||manifest.commit!==installed.commit||manifest.versions?.tavern!==installed.version)throw failure();
      for(const [name,item] of Object.entries(receipt.managed)){
        const target=path.join(receipt.installRoot,'apps/tavern-ops',...name.split('/').slice(1));
        if(!SOURCES[name]||!samePath(target,item.path,platform)||manifest.artifacts?.[name]!==item.sha256)throw failure();
      }
    }else if(Object.keys(receipt.managed).length)throw failure();
    return receipt;
  }catch(error){if(error.code==='OPERATION_CAPABILITY_INVALID')throw error;throw failure();}
}
function authorizeTarget(receipt,script){
  if(typeof script!=='string'||!path.isAbsolute(script))throw failure('OPERATION_ENTRY_UNSUPPORTED');
  const resolved=path.resolve(script),platform=receipt.platform;
  for(const [name,type] of [['launcher_bridge.py','bridge'],['first_install.py','install'],['bootstrap.py','install-bootstrap']]){
    if(samePath(receipt.resources[name].path,resolved,platform))return {type,path:receipt.resources[name].path};
  }
  for(const [name,item] of Object.entries(receipt.managed||{}))if(samePath(item.path,resolved,platform))return {type:SOURCES[name],path:item.path};
  throw failure('OPERATION_ENTRY_UNSUPPORTED');
}
module.exports={register,validate,authorizeTarget,receiptPath,RESOURCE_NAMES,SCHEMA};
