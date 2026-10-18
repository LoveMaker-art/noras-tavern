// An updater execution identity, independent of Electron and the desktop APP.
// The immutable runner survives replacement of the installed ops directory.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
const SCHEMA='nora-updater-control/1';
const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUIRED=['ops/installer/desktop/updater-task.js','ops/installer/desktop/updater-capability.js',
  'ops/installer/desktop/updater-policy.js','ops/installer/desktop/operation-cli.js',
  'ops/installer/operation_control.py','ops/updater/task.py','ops/updater/task_backend.py',
  ...['receipt.json','package.json','package-lock.json'].map(name=>'ops/updater/actor-dependencies/'+name)];
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const fail=()=>Object.assign(new Error('更新器或安装记录无法核验，未修改程序和用户数据。请保留日志。'),{code:'UPDATER_IDENTITY_INVALID'});
const absolute=value=>{if(typeof value!=='string'||!path.isAbsolute(value))throw fail();return path.resolve(value);};
const same=(left,right)=>process.platform==='win32'?absolute(left).toLowerCase()===absolute(right).toLowerCase():absolute(left)===absolute(right);
function privatePath(file,{directory=false}={}){
  const stat=fs.lstatSync(file);
  if(stat.isSymbolicLink()||(directory?!stat.isDirectory():!stat.isFile())
    ||process.platform!=='win32'&&((stat.uid!==process.getuid()&&stat.uid!==0)||(stat.mode&0o022)))throw fail();
  return stat;
}
function regular(file){
  let current=absolute(file);
  const root=path.parse(current).root;
  while(true){
    // Node on Windows rejects lstat('\\\\?\\C:\\') as drive-relative C:.
    // Check that same drive root through C:\; keep descendant paths intact.
    const checked=process.platform==='win32'&&current===root&&/^\\\\\?\\[a-z]:\\$/i.test(root)?root.slice(4):current;
    const s=fs.lstatSync(checked);if(s.isSymbolicLink())throw fail();if(current===root)break;
    const parent=path.dirname(current);if(parent===current)break;current=parent;}
  return privatePath(file);
}
function bytes(file,max=16*1024*1024){if(regular(file).size>max)throw fail();return fs.readFileSync(file);}
function descriptor(file,{executable=false}={}){
  // A venv interpreter may be a symlink; preserve its invocation path, bind the
  // physical binary separately. Runner files and install receipts never may.
  const physical=executable?fs.realpathSync(file):file;
  const before=regular(physical),data=fs.readFileSync(physical),after=regular(physical);
  if(before.ino!==after.ino||before.dev!==after.dev||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw fail();
  return {path:path.resolve(file),physical:path.resolve(physical),size:data.length,sha256:hash(data)};
}
function atomic(file,value){const temp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(value),{flag:'wx',mode:0o600});try{fs.renameSync(temp,file);}finally{fs.rmSync(temp,{force:true});}}
function identity(root){
  privatePath(root,{directory:true});
  const manifestFile=path.join(root,'tavern-updates/installed-manifest.json'),receiptFile=path.join(root,'tavern-updates/installed.json');
  const manifest=JSON.parse(bytes(manifestFile)),receipt=JSON.parse(bytes(receiptFile));
  if(manifest.schema!=='tavern-release/v2'||!/^[a-f0-9]{40}$/.test(manifest.commit||'')||manifest.commit!==receipt.commit
    ||typeof receipt.version!=='string'||manifest.versions?.tavern!==receipt.version)throw fail();
  return {manifest,files:[descriptor(manifestFile),descriptor(receiptFile)]};
}
function binding(value){
  for(const directory of [value.noraHome,value.hermesHome,value.installRoot])privatePath(absolute(directory),{directory:true});
  const file=path.join(value.hermesHome,'nora-instance.json'),managed=fs.existsSync(file);
  if(managed){
    const record=JSON.parse(bytes(file));
    if(record.schema!==1||record.port!==value.port||!same(record.noraHome,value.noraHome)
      ||!same(record.hermesHome,value.hermesHome)||!same(record.installRoot,value.installRoot)
      ||!same(value.hermesHome,path.join(value.noraHome,'hermes'))||!same(value.installRoot,path.join(value.noraHome,'tavern')))throw fail();
  }else if(!same(value.noraHome,value.hermesHome))throw fail();
  return managed;
}
function members(manifest){
  const selected=manifest?.modules?.updater?.artifacts;
  if(manifest?.schema!=='tavern-release/v2'||!/^[a-f0-9]{40}$/.test(manifest.commit||'')||!manifest.artifacts
    ||!Array.isArray(selected)||!selected.length||new Set(selected).size!==selected.length)throw fail();
  for(const name of selected){
    if(typeof name!=='string'||!name.startsWith('ops/')||/[\\:\0\r\n]/.test(name)
      ||name.split('/').some(part=>!part||part==='..'||part==='.')||!/^[a-f0-9]{64}$/.test(manifest.artifacts[name]||''))throw fail();
  }
  if(REQUIRED.some(name=>!selected.includes(name)))throw fail();
  return selected;
}
function resourcesFor(files,managed){
  const resources={};
  for(const [name,item] of Object.entries(files))if(name.startsWith('ops/installer/')&&!name.slice(14).includes('/'))resources[path.basename(name)]=item;
  resources['launcher_bridge.py']=files[managed?'ops/installer/launcher_bridge.py':'ops/updater/task_backend.py'];
  if(!resources['launcher_bridge.py'])throw fail();
  return resources;
}
function dependencyClosure(files,manifest){
  const prefix='ops/updater/actor-dependencies/',receipt=JSON.parse(bytes(files[prefix+'receipt.json'].path));
  if(receipt.schema!=='nora-updater-dependencies/1'
    ||receipt.canonicalLockSha256!==manifest.artifacts['ops/installer/desktop/package-lock.json']
    ||!isDeepStrictEqual(receipt.dependencies,{'fs-native-extensions':'1.5.1',semver:'7.8.5'})||!receipt.files)throw fail();
  const expected=Object.keys(receipt.files).map(name=>prefix+name).concat(prefix+'receipt.json').sort();
  const actual=Object.keys(files).filter(name=>name.startsWith(prefix)).sort();
  if(!isDeepStrictEqual(expected,actual))throw fail();
  for(const [name,digest] of Object.entries(receipt.files))if(!/^[a-f0-9]{64}$/.test(digest)||manifest.artifacts[prefix+name]!==digest)throw fail();
}
function snapshotInventory(root,files){
  const visit=directory=>{
    privatePath(directory,{directory:true});
    for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
      const file=path.join(directory,entry.name);
      if(entry.isDirectory())visit(file);
      else if(!entry.isFile()||!files['ops/'+path.relative(root,file).split(path.sep).join('/')])throw fail();
    }
  };
  visit(root);
}
function stage(options){
  try{
  const {jobDirectory,python,node=process.execPath,port,channel='stable'}=options;
  const noraHome=absolute(options.noraHome),hermesHome=absolute(options.hermesHome),installRoot=absolute(options.installRoot);
  if(!Number.isInteger(port)||port<1024||port>65535||!['stable','beta'].includes(channel))throw fail();
  if(!ID.test(path.basename(jobDirectory))||absolute(jobDirectory)!==path.join(noraHome,'installer/update-jobs',path.basename(jobDirectory)))throw fail();
  privatePath(jobDirectory,{directory:true});
  for(const directory of [path.join(noraHome,'installer'),path.join(noraHome,'installer/update-jobs')])privatePath(directory,{directory:true});
  const managed=binding({noraHome,hermesHome,installRoot,port});
  const installed=identity(installRoot),sourceRoot=path.resolve(options.opsRoot||path.join(installRoot,'apps/tavern-ops'));
  privatePath(sourceRoot,{directory:true});
  const sourceBytes=bytes(options.manifestPath||path.join(installRoot,'tavern-updates/installed-manifest.json'));
  const sourceManifest=JSON.parse(sourceBytes),selected=members(sourceManifest);
  const opsRoot=path.join(jobDirectory,'runner/ops');fs.mkdirSync(opsRoot,{recursive:true,mode:0o700});
  const manifestSnapshot=path.join(jobDirectory,'runner/release-manifest.json');fs.writeFileSync(manifestSnapshot,sourceBytes,{flag:'wx',mode:0o600});
  const files={};
  for(const name of selected){
    const digest=sourceManifest.artifacts[name];
    const relative=name.slice(4);
    if(relative.split('/').some(part=>!part||part==='..'||part==='.')||relative.includes('\\')||!/^[a-f0-9]{64}$/.test(digest))throw fail();
    const from=path.join(sourceRoot,...relative.split('/'));
    // Only the declared updater module is an execution closure. A full installed
    // ops tree may also contain UI/APP resources; they never join this snapshot.
    const data=bytes(from,128*1024*1024);if(hash(data)!==digest)throw fail();
    const to=path.join(opsRoot,...relative.split('/'));fs.mkdirSync(path.dirname(to),{recursive:true,mode:0o700});fs.writeFileSync(to,data,{flag:'wx',mode:0o600});
    files[name]={path:to,physical:to,size:data.length,sha256:digest};
  }
  const resourcesRoot=path.join(opsRoot,'installer'),resources=resourcesFor(files,managed);
  const value={schema:SCHEMA,noraHome,hermesHome,installRoot,port,channel,platform:process.platform,arch:process.arch,
    managedInstallation:managed,installerDirectory:path.join(noraHome,'installer'),resourcesRoot,opsRoot,
    python:descriptor(python,{executable:true}),executable:descriptor(node,{executable:true}),
    hermesInstallDir:options.hermesInstallDir||path.join(hermesHome,'hermes-agent'),
    managedPythonRoot:options.managedPythonRoot||path.join(hermesHome,'python'),venvHome:options.venvHome||path.join(hermesHome,'hermes-agent/venv'),
    files,resources,managed:{},installed:installed.files,sourceCommit:sourceManifest.commit,sourceManifest:descriptor(manifestSnapshot)};
  dependencyClosure(files,sourceManifest);
  const receiptPath=path.join(jobDirectory,'updater-control.json');atomic(receiptPath,value);
  return {receiptPath,receipt:value};
  }catch(error){if(error.code==='UPDATER_IDENTITY_INVALID')throw error;throw Object.assign(fail(),{cause:error});}
}
async function validate({receiptPath,currentExecutable,readOnly=false}={}){
  try{
  const value=JSON.parse(bytes(receiptPath,8*1024*1024));
  if(value.schema!==SCHEMA||!['win32','darwin','linux'].includes(value.platform)||value.platform!==process.platform||value.arch!==process.arch
    ||value.installerDirectory!==path.join(value.noraHome,'installer')||!value.resources?.['launcher_bridge.py']||!value.files
    ||!Number.isInteger(value.port)||value.port<1024||value.port>65535||!['stable','beta'].includes(value.channel))throw fail();
  const job=path.dirname(receiptPath),expected=path.join(value.installerDirectory,'update-jobs',path.basename(job));
  if(!ID.test(path.basename(job))||absolute(job)!==expected||value.opsRoot!==path.join(job,'runner/ops')
    ||value.resourcesRoot!==path.join(value.opsRoot,'installer')||value.sourceManifest?.path!==path.join(job,'runner/release-manifest.json'))throw fail();
  for(const directory of [value.noraHome,value.installerDirectory,path.dirname(job),job,path.join(job,'runner'),value.opsRoot])privatePath(directory,{directory:true});
  if(binding(value)!==value.managedInstallation)throw fail();
  const sourceManifest=JSON.parse(bytes(value.sourceManifest.path)),selected=members(sourceManifest);
  if(value.sourceCommit!==sourceManifest.commit||!isDeepStrictEqual(Object.keys(value.files).sort(),selected.slice().sort())
    ||!isDeepStrictEqual(value.resources,resourcesFor(value.files,value.managedInstallation))||!isDeepStrictEqual(value.managed,{}))throw fail();
  dependencyClosure(value.files,sourceManifest);
  snapshotInventory(value.opsRoot,value.files);
  for(const [name,item] of Object.entries(value.files)){
    if(item.path!==path.join(value.opsRoot,...name.slice(4).split('/'))||item.sha256!==sourceManifest.artifacts[name])throw fail();
    for(let directory=path.dirname(item.path);directory!==value.opsRoot;directory=path.dirname(directory))privatePath(directory,{directory:true});
  }
  for(const item of [...Object.values(value.files),value.sourceManifest,
    ...(readOnly?[]:[...value.installed,value.python,value.executable])]){
    const actual=descriptor(item.path,{executable:item===value.python||item===value.executable});
    if(actual.physical!==item.physical||actual.size!==item.size||actual.sha256!==item.sha256)throw fail();
  }
  if(currentExecutable&&fs.realpathSync(currentExecutable)!==value.executable.physical)throw fail();
  if(!readOnly&&!isDeepStrictEqual(identity(value.installRoot).files,value.installed))throw fail();
  return value;
  }catch(error){if(error.code==='UPDATER_IDENTITY_INVALID')throw error;throw Object.assign(fail(),{cause:error});}
}
// Validate the code which will actually answer a query. The old writer's
// executable and Python are not query dependencies; their descriptors remain
// mandatory when a writer starts. Loaded reader code is stable for this process.
const readers=new Map();
function verifyReader({opsRoot,manifestPath}){
  opsRoot=absolute(opsRoot);manifestPath=absolute(manifestPath);
  const key=opsRoot+'\0'+manifestPath;if(readers.has(key))return readers.get(key);
  try{
    const manifest=JSON.parse(bytes(manifestPath)),selected=members(manifest),files={};
    privatePath(opsRoot,{directory:true});
    for(const name of selected){
      const file=path.join(opsRoot,...name.slice(4).split('/')),item=descriptor(file);
      if(item.sha256!==manifest.artifacts[name])throw fail();files[name]=item;
    }
    // Installed ops may contain declared UI files outside the updater module.
    // Unknown files are still rejected so they cannot shadow a require target.
    snapshotInventory(opsRoot,Object.fromEntries(Object.keys(manifest.artifacts)
      .filter(name=>name.startsWith('ops/')).map(name=>[name,true])));
    dependencyClosure(files,manifest);
    const result={opsRoot};readers.set(key,result);return result;
  }catch(error){if(error.code==='UPDATER_IDENTITY_INVALID')throw error;throw Object.assign(fail(),{cause:error});}
}
function authorizeTarget(receipt,script){
  if(path.resolve(script)!==receipt.resources['launcher_bridge.py'].path)throw fail();
  return {type:'bridge',path:receipt.resources['launcher_bridge.py'].path};
}
module.exports={SCHEMA,stage,validate,verifyReader,authorizeTarget,atomic};
