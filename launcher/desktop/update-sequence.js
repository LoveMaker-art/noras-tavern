// A fixed desktop request links the existing core and APP operations. Their
// journals remain authoritative; this file never stores a second outcome.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const semver = require('semver');
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const schema = 'nora-update-sequence/1';
const fail = (code, message, cause) => Object.assign(new Error(message, cause ? {cause} : undefined), {code});
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const exactVersion = value => typeof value === 'string' && semver.valid(value) === value;
function compatible(manifest, core, launcher, capabilities) {
  const value = manifest.updateCompatibility;
  if (!value || value.schema !== 'nora-core-launcher-compatibility/1'
    || value.coreVersion !== manifest.versions?.tavern || !exactVersion(value.coreVersion)
    || Object.keys(value).some(key => !['schema','coreVersion','launcherVersions','previousCoreVersions','capabilities'].includes(key))) return false;
  for (const list of [value.launcherVersions, value.previousCoreVersions || []]) {
    if (!Array.isArray(list) || list.length > 32 || new Set(list).size !== list.length || !list.every(exactVersion)) return false;
  }
  if (!value.launcherVersions.includes(manifest.launcherVersion) || !capabilities || !value.capabilities
    || Object.keys(capabilities).length !== Object.keys(value.capabilities).length
    || Object.entries(capabilities).some(([key, expected]) => value.capabilities[key] !== expected)) return false;
  return core === value.coreVersion && value.launcherVersions.includes(launcher)
    || launcher === manifest.launcherVersion && (value.previousCoreVersions || []).includes(core);
}
function pointer(home) { return path.join(path.resolve(home), 'installer', 'current-update-sequence.json'); }
function directory(home,id) {
  if (!ID.test(id || '')) throw fail('UPDATE_SEQUENCE_INVALID','更新衔接编号无法核验，请保留日志。');
  return path.join(path.resolve(home), 'installer', 'update-sequences', id);
}
function ownedFolders(home,id,create=false){
  let folder=path.resolve(home);
  for(const name of [null,'installer','update-sequences',...(id?[id]:[])]){
    if(name)folder=path.join(folder,name);
    if(!fs.existsSync(folder)&&create)fs.mkdirSync(folder,{mode:0o700});
    if(!fs.existsSync(folder))return;
    const stat=fs.lstatSync(folder);
    if(!stat.isDirectory()||stat.isSymbolicLink())throw fail('UPDATE_SEQUENCE_INVALID','更新衔接目录归属无法核验，未写入文件。');
  }
}
function readJson(file, max = 8 * 1024 * 1024) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > max)
    throw fail('UPDATE_SEQUENCE_INVALID','更新衔接记录无法核验，请保留日志。');
  return JSON.parse(fs.readFileSync(file,'utf8'));
}
function atomic(file, value) {
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  const fd = fs.openSync(temporary,'wx',0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary,file); } finally { fs.rmSync(temporary,{force:true}); }
  if (process.platform !== 'win32') {
    const parent = fs.openSync(path.dirname(file),'r');
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  }
}
function validate(value, {validatePlan, capabilities}) {
  const {digest,...content} = value || {};
  if (value?.schema !== schema || !ID.test(value.id || '') || digest !== hash(content)
    || !ID.test(value.requests?.core || '') || !ID.test(value.requests?.launcher || '')
    || value.requests.core === value.requests.launcher || !exactVersion(value.before?.core) || !exactVersion(value.before?.launcher)
    || !/^[a-f0-9]{40}$/.test(value.before?.coreCommit||'') || !/^[a-f0-9]{64}$/.test(value.before?.coreManifestSha256||'')
    || !['core,launcher','launcher,core'].includes(value.order?.join(',')))
    throw fail('UPDATE_SEQUENCE_INVALID','更新衔接计划已变化，未重复替换程序，请保留日志。');
  const plan = validatePlan(value.plan);
  if (!plan.launcherManifest || plan.mode !== 'update'
    || !compatible(plan.releaseManifest,plan.releaseManifest.versions.tavern,plan.launcherManifest.version,capabilities))
    throw fail('RELEASE_COMPATIBILITY','缺少两项更新的目标兼容依据，未开始替换。');
  const safe = value.order[0] === 'core'
    ? compatible(plan.releaseManifest,plan.releaseManifest.versions.tavern,value.before.launcher,capabilities)
    : compatible(plan.releaseManifest,value.before.core,plan.launcherManifest.version,capabilities);
  if (!safe) throw fail('RELEASE_COMPATIBILITY','无法确认更新中间组合的兼容性，未开始替换。');
  return {...value,plan};
}
function load(home, options) {
  ownedFolders(home);
  const file = pointer(home);
  if (!fs.existsSync(file)) return null;
  const reference = readJson(file,1024);
  if (reference.schema !== schema || !ID.test(reference.id || '')) throw fail('UPDATE_SEQUENCE_INVALID','更新衔接引用无法核验。');
  ownedFolders(home,reference.id);
  return validate(readJson(path.join(directory(home,reference.id),'request.json')), options);
}
function create(home, {plan,before,validatePlan,capabilities}) {
  const previous = load(home,{validatePlan,capabilities});
  if (previous) {
    if (previous.plan.planId !== plan.planId) throw fail('UPDATE_SEQUENCE_PENDING','请先完成或恢复原来的两项更新，原目标已保留。');
    return previous;
  }
  const coreFirst = compatible(plan.releaseManifest,plan.releaseManifest.versions.tavern,before.launcher,capabilities);
  const content = {schema,id:crypto.randomUUID(),plan,before,
    order:coreFirst ? ['core','launcher'] : ['launcher','core'],
    requests:{core:crypto.randomUUID(),launcher:crypto.randomUUID()}};
  const value = validate({...content,digest:hash(content)},{validatePlan,capabilities});
  const folder = directory(home,value.id);
  ownedFolders(home,value.id,true);
  // The complete immutable request is published before its discoverable pointer.
  // FlushFileBuffers on Windows requires the original writable handle.
  const file = path.join(folder,'request.json'),fd=fs.openSync(file,'wx',0o600);
  try { fs.writeFileSync(fd,JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  atomic(pointer(home),{schema,id:value.id});
  return value;
}
function clear(home, value) {
  const reference = readJson(pointer(home),1024);
  if (reference.schema !== schema || reference.id !== value.id) throw fail('UPDATE_SEQUENCE_INVALID','更新衔接引用已变化，原记录已保留。');
  fs.unlinkSync(pointer(home));
}
function operation(home, requestId) {
  if (!ID.test(requestId || '')) throw fail('UPDATE_SEQUENCE_INVALID','更新请求编号无效。');
  const root = path.join(path.resolve(home),'installer','operations');
  if (!fs.existsSync(root)) return null;
  let found;
  for (const id of fs.readdirSync(root).filter(name => ID.test(name))) {
    const file = path.join(root,id,'operation.json');
    if (!fs.existsSync(file)) continue;
    const value = readJson(file);
    if (value.requestId !== requestId) continue;
    if (found || value.operationId !== id || value.kind !== 'update') throw fail('UPDATE_SEQUENCE_INVALID','更新请求的操作归属冲突，请保留记录。');
    found = value;
  }
  return found || null;
}
function bootstrap(home,value){
  ownedFolders(home,value.id);
  const file=path.join(directory(home,value.id),'core-bootstrap.py'),stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>2*1024*1024
    ||crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==value.plan.releaseManifest.bootstrap.sha256)
    throw fail('UPDATE_SEQUENCE_INVALID','原核心更新入口无法核验，未执行程序，请保留记录。');
  return file;
}
async function prepareBootstrap(home,value,{fetcher,networkPolicy,onEvent}={}){
  const file=path.join(directory(home,value.id),'core-bootstrap.py');
  if(fs.existsSync(file))return bootstrap(home,value);
  ownedFolders(home,value.id);
  const releases=require('./releases'),asset='tavern-updater-bootstrap.py';
  await require('./release-network').downloadAsset({url:releases.assetUrl(value.plan.release,asset),target:file,
    identity:{tag:value.plan.tag,asset,sha256:value.plan.releaseManifest.bootstrap.sha256},fetcher,policy:networkPolicy,
    fixedPlanSourceEvidence:releases.fixedPlanSourceEvidence(value.plan),maxSize:2*1024*1024,onEvent,
    task:'准备启动器重开后使用的核心更新入口'});
  return bootstrap(home,value);
}
async function run(value, adapters, {retry=false}={}) {
  const completed = [];
  for (const step of value.order) {
    let current = await adapters.observe(step,value);
    if (current?.succeeded === true) {
      await adapters.verifyStep(step,value,current); completed.push(step); continue;
    }
    try {
      if (current?.failed && !retry) throw current.error || fail('UPDATE_SEQUENCE_FAILED','上次更新尚未完成。');
      const result = await adapters.execute(step,value,current,{retry});
      if (result?.restarting) return result;
      current = await adapters.observe(step,value);
      if (current?.succeeded !== true) throw current?.error || fail('UPDATE_SEQUENCE_UNCONFIRMED','更新步骤的完成结果尚未确认，请保留日志。');
      await adapters.verifyStep(step,value,current); completed.push(step);
    } catch (error) {
      const actual = await adapters.verifyCombination(value);
      const restored = await adapters.observe(step,value);
      const settled = restored?.settled === true && restored?.safe === true;
      if (completed.length && actual?.compatible === true && settled) {
        return {status:'partial',completed,failed:step,current:actual.current,error,
          operation:restored.operation,message:step==='launcher'
            ?'酒馆已更新；启动器更新未完成，当前程序组合已核验可用。可重试启动器，聊天和配置保留。'
            :'启动器已更新；酒馆更新未完成，当前程序组合已核验可用。可重试酒馆，聊天和配置保留。'};
      }
      if (completed.length || !settled) throw fail('UPDATE_RECOVERY_REQUIRED','更新结果或恢复尚未确认，请查询原任务，保留数据与日志。',error);
      throw error;
    }
  }
  const actual = await adapters.verifyCombination(value);
  if (actual?.compatible !== true) throw fail('UPDATE_RECOVERY_REQUIRED','两项更新的实际组合尚未通过核验，请保留数据和日志。');
  return {status:'succeeded',completed,current:actual.current};
}
module.exports = {compatible,create,load,clear,operation,run,validate,bootstrap,prepareBootstrap};
