const fs = require('node:fs');
const { launcherError } = require('./launcher-errors');
const path = require('node:path');
const crypto = require('node:crypto');
const semver = require('semver');
const {metadataJson,createMetadataCache,downloadAsset} = require('./release-network');

const REPO = 'LoveMaker-art/noras-tavern';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const LAUNCHER_CAPABILITIES=Object.freeze({operationSchema:'nora-operation/1',executorProtocol:'nora-operation-executor/1',telemetrySchema:3,faultSchema:2});
function validateCapabilities(manifest){
  if(!manifest?.launcherCapabilities||Object.entries(LAUNCHER_CAPABILITIES).some(([key,value])=>manifest.launcherCapabilities[key]!==value))
    throw launcherError('线上发布与当前启动器的维护协议不兼容，未修改原安装和数据。请等待兼容版本发布，勿反复重试。',
      {code:'VERIFICATION_FAILED',userCode:'RELEASE_EXECUTOR_INCOMPATIBLE',source:'release_service',site:'release.verify'});
}
const version = value => typeof value === 'string' ? semver.valid(value) : null;
function compare(a, b) {
  const left = version(a), right = version(b);
  if (!left || !right) return null;
  return semver.compare(left, right);
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } }
function installedVersion(root) {
  const record = readJson(path.join(root, 'tavern-updates', 'installed.json'));
  if (version(record.version)) return { version: record.version, source: 'receipt' };
  // Legacy first installs wrote only the runtime's release file. Never infer from a folder name.
  try {
    const current = fs.readFileSync(path.join(root, 'apps/tavern-runtime/.tavern-release-version'), 'utf8').trim();
    if (version(current)) return { version: current, source: 'legacy-runtime' };
  } catch {}
  return { version: null, source: 'unknown' };
}
async function hash(file) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
async function matches(file, expected) {
  const stat=fs.lstatSync(file,{throwIfNoEntry:false});
  return Boolean(stat?.isFile() && await hash(file) === expected);
}
function fileName(name) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new Error('发布清单包含非法文件名。');
  return name;
}
function assetUrl(release, name) {
  fileName(name);
  const asset = release.assets?.find(item => item.name === name);
  const expected = `https://github.com/${REPO}/releases/download/${encodeURIComponent(release.tag_name)}/${name}`;
  if (!asset || asset.browser_download_url !== expected) throw new Error(`最新发布缺少完整组件：${name}`);
  return expected;
}
async function requestJson(url, fetcher, signal, options = {}) {
  const result=await metadataJson(url,{fetcher,signal,metadataCache:options.metadataCache,channel:options.channel,policy:options.networkPolicy,conditionIdentity:options.conditionIdentity});
  return options.withEvidence ? result : result.value;
}
function accepts(release, channel) {
  if (!['stable', 'beta'].includes(channel) || release.draft || !version(release.tag_name)) return false;
  const pre = semver.prerelease(release.tag_name);
  return channel === 'beta' ? release.prerelease === true && pre?.[0] === 'beta'
    : !release.prerelease && !pre;
}
async function latest(fetcher = fetch, signal, channel = 'stable', tag, options = {}) {
  let release;
  const evidence=[];
  const read=async url=>{const item=await requestJson(url,fetcher,signal,{...options,channel,withEvidence:true});evidence.push(item);return item.value;};
  if (tag) {
    if (!version(tag)) throw new Error('目标版本号无效。');
    release = await read(`https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`);
  } else if (channel === 'beta') {
    const candidates = [];
    for (let page = 1; page <= 5; page++) {
      const rows = await read(`https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`);
      if (!Array.isArray(rows)) throw new Error('测试发布列表无效。');
      candidates.push(...rows.filter(item => accepts(item, channel)));
      if (rows.length < 100) break;
    }
    release = candidates.sort((a, b) => compare(b.tag_name, a.tag_name))[0];
  } else release = await read(API);
  if (!release || !accepts(release, channel)) throw new Error(channel === 'beta' ? '尚未发布可用的 Beta 测试版本。' : '没有找到有效的正式发布版本。');
  if (tag && release.tag_name !== tag) throw new Error('目标发布与所选版本不一致。');
  return options.withEvidence ? {release,checkedAt:evidence.map(item=>item.checkedAt).sort()[0],
    source:evidence.some(item=>item.source==='cache')?'cache':evidence.some(item=>item.source==='revalidated')?'revalidated':'network',
    latestConfirmed:evidence.every(item=>item.latestConfirmed)} : release;
}
function validateSystem(manifest, release, platform, arch, launcherVersion, channel = 'stable') {
  if (manifest.schema !== 'nora-system/v1' || manifest.candidate || manifest.platform !== platform || manifest.arch !== arch ||
      (manifest.channel || 'stable') !== channel ||
      compare(manifest.version, release ? release.tag_name : manifest.version) !== 0 || !/^[a-f0-9]{40}$/.test(manifest.commit || '')) throw new Error('完整系统发布清单与目标版本或平台不符。');
  validateCapabilities(manifest);
  if (compare(launcherVersion, manifest.minimumLauncherVersion) === null || compare(launcherVersion, manifest.minimumLauncherVersion) < 0) {
    throw new Error(`请先升级启动器到 ${manifest.minimumLauncherVersion} 或更新版本。`);
  }
  const required = ['release-manifest.json', 'SHA256SUMS', 'nora-tavern-app.tar.gz', 'nora-tavern-ops.tar.gz',
    'nora-tavern-nora-mcp.tar.gz', 'nora-tavern-first-install-bootstrap.py', 'first-install-manifest.json',
    'nora-hermes-runtime.json', 'nora-tavern-dependencies.json'];
  if (!manifest.files || required.some(name => !manifest.files[name])) throw new Error('最新发布不是完整 Nora 系统包。');
  for (const [name, item] of Object.entries(manifest.files)) {
    fileName(name); fileName(item.asset);
    if (!/^[a-f0-9]{64}$/.test(item.sha256 || '') || !Number.isSafeInteger(item.size) || item.size < 1) throw new Error('组件校验信息缺失。');
    if (release) assetUrl(release, item.asset);
  }
  return manifest;
}
async function systemFor(release, { platform = process.platform, arch = process.arch, launcherVersion, fetcher = fetch, signal, channel = 'stable',metadataCache,networkPolicy }) {
  const name = `nora-system-${platform}-${arch}.json`;
  const manifest = await requestJson(assetUrl(release, name), fetcher, signal,{metadataCache,networkPolicy,channel,conditionIdentity:{expectedVersion:launcherVersion}});
  return validateSystem(manifest, release, platform, arch, launcherVersion, channel);
}
function validateUpdate(manifest, release, launcherVersion) {
  if (manifest.schema !== 'tavern-release/v2' || manifest.candidate ||
      compare(manifest.versions?.tavern, release.tag_name) !== 0 || !/^[a-f0-9]{40}$/.test(manifest.commit || '') ||
      manifest.bootstrap?.managedComponents !== 1 || !/^[a-f0-9]{64}$/.test(manifest.bootstrap.sha256 || '')) {
    throw launcherError('目标发布尚不支持启动器组件更新，未修改当前安装。',
      {userCode:'RELEASE_COMPATIBILITY',source:'release_service',site:'release.verify'});
  }
  validateCapabilities(manifest);
  const minimum = manifest.bootstrap.minimumLauncherVersion || '1.0.0';
  if (compare(launcherVersion, minimum) === null || compare(launcherVersion, minimum) < 0)
    throw launcherError(`请先升级启动器到 ${minimum} 或更新版本。`,
      {userCode:'RELEASE_COMPATIBILITY',source:'release_service',site:'release.verify'});
  return manifest;
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const MAX_MANIFEST_BYTES=4*1024*1024;
const MAX_PLAN_ARTIFACTS=4;
const OPERATION_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const bytesHash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function releaseSnapshot(release){
  return {tag_name:release.tag_name,draft:release.draft===true,prerelease:release.prerelease===true,
    assets:release.assets.map(item=>({name:item.name,browser_download_url:item.browser_download_url,
      ...(Number.isSafeInteger(item.size)?{size:item.size}:{})}))};
}
function planDigest(plan) {
  if(plan.schema!=='nora-release-plan/1'){const {planId,...content}=plan;return bytesHash(canonical(content));}
  const bytes=typeof plan.releaseManifestText==='string'?Buffer.from(plan.releaseManifestText):null;
  const content={schema:plan.schema,mode:plan.mode,tag:plan.tag,channel:plan.channel,platform:plan.platform,arch:plan.arch,
    release:releaseSnapshot(plan.release),commit:plan.commit,
    version:plan.version||plan.releaseManifest?.versions?.tavern,
    manifestSha256:bytes?bytesHash(bytes):plan.manifestSha256,manifestSize:bytes?bytes.length:plan.manifestRef?.size,
    launcherManifest:plan.launcherManifest,systemManifest:plan.systemManifest,
    checkedAt:plan.checkedAt,metadataSource:plan.metadataSource,latestConfirmed:plan.latestConfirmed};
  return bytesHash(canonical(content));
}
function operationArtifact(plan,{operationDirectory}={}){
  if(typeof operationDirectory!=='string'||!path.isAbsolute(operationDirectory)
    ||!OPERATION_ID.test(path.basename(operationDirectory))||path.basename(path.dirname(operationDirectory))!=='operations'
    ||plan.manifestRef?.operationId!==path.basename(operationDirectory)
    ||plan.manifestRef?.file!==`release-plan/${plan.manifestSha256}.json`)
    throw new Error('固定发布计划缺少可信操作目录，未修改当前安装。');
  for(const folder of [operationDirectory,path.join(operationDirectory,'release-plan')]){
    const stat=fs.lstatSync(folder);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('固定发布清单目录身份无效。');
  }
  return path.join(operationDirectory,plan.manifestRef.file);
}
function readManifestArtifact(plan,options){
  const ref=plan.manifestRef;
  if(ref?.schema!=='nora-operation-manifest/1'||!/^[a-f0-9]{64}$/.test(ref.sha256||'')||ref.sha256!==plan.manifestSha256
    ||!Number.isSafeInteger(ref.size)||ref.size<1||ref.size>MAX_MANIFEST_BYTES)throw new Error('固定发布清单引用无效。');
  const file=operationArtifact(plan,options),stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==ref.size)throw new Error('固定发布清单身份或长度已改变。');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
  try{
    const actual=fs.fstatSync(fd);
    if(!actual.isFile()||actual.dev!==stat.dev||actual.ino!==stat.ino||actual.size!==ref.size)throw new Error('固定发布清单身份已改变。');
    const bytes=Buffer.alloc(ref.size+1);let size=0;
    while(size<bytes.length){const count=fs.readSync(fd,bytes,size,bytes.length-size,size);if(!count)break;size+=count;}
    if(size!==ref.size||bytesHash(bytes.subarray(0,size))!==ref.sha256)throw new Error('固定发布清单校验失败，原目标未重新选择。');
    return bytes.subarray(0,size).toString('utf8');
  }finally{fs.closeSync(fd);}
}
// The owner seals one authoritative raw manifest. Operation and APP handoff
// records carry only its relative reference and bounded download contract.
function sealPlan(plan,{operationDirectory,assertOwner,...options}={}){
  if(typeof assertOwner!=='function')throw new TypeError('A current operation owner check is required');
  if(typeof options.launcherVersion!=='string')throw new TypeError('The current launcherVersion is required to seal a plan');
  assertOwner();
  const checked=validatePlan(plan,{platform:plan.platform,arch:plan.arch,channel:plan.channel,...options,operationDirectory,
    launcherVersion:options.launcherVersion});
  const bytes=Buffer.from(checked.releaseManifestText);
  if(bytes.length>MAX_MANIFEST_BYTES)throw new Error('固定发布清单超过受支持的读取预算。');
  const contract={schema:checked.schema,mode:checked.mode,tag:checked.tag,channel:checked.channel,platform:checked.platform,arch:checked.arch,
    release:releaseSnapshot(checked.release),commit:checked.commit,version:checked.releaseManifest.versions.tavern,
    manifestSha256:bytesHash(bytes),manifestRef:{schema:'nora-operation-manifest/1',operationId:path.basename(operationDirectory),
      file:`release-plan/${bytesHash(bytes)}.json`,size:bytes.length,sha256:bytesHash(bytes)},
    launcherManifest:checked.launcherManifest,systemManifest:checked.systemManifest,
    checkedAt:checked.checkedAt,metadataSource:checked.metadataSource,latestConfirmed:checked.latestConfirmed,planId:checked.planId};
  if(Buffer.byteLength(JSON.stringify(contract))>64*1024)throw new Error('固定发布下载合同超过受支持的记录预算。');
  const folder=path.join(operationDirectory,'release-plan');
  const parent=fs.lstatSync(operationDirectory);
  if(!parent.isDirectory()||parent.isSymbolicLink())throw new Error('固定发布清单缺少可信操作目录。');
  if(!fs.lstatSync(folder,{throwIfNoEntry:false}))fs.mkdirSync(folder,{mode:0o700});
  const file=operationArtifact(contract,{operationDirectory});
  if(fs.existsSync(file)){readManifestArtifact(contract,{operationDirectory});return freezePlan(contract);}
  if(fs.readdirSync(folder).length>=MAX_PLAN_ARTIFACTS)throw launcherError('此操作的发布清单封存次数已达到安全上限。原目标和文件已保留，请查看日志，不要反复重试。',
    {userCode:'RELEASE_COMPATIBILITY',source:'release_service',site:'release.verify'});
  const temporary=path.join(folder,`${crypto.randomUUID()}.tmp`);let fd;
  try{
    fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    assertOwner();fs.linkSync(temporary,file);
    if(process.platform!=='win32'){const directory=fs.openSync(folder,'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}}
  }finally{if(fd!==undefined)fs.closeSync(fd);fs.rmSync(temporary,{force:true});}
  return freezePlan(contract);
}
function freezePlan(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freezePlan(item); Object.freeze(value); }
  return value;
}
function validatePlan(plan, {launcherVersion,platform = process.platform,arch = process.arch,channel = 'stable',tag,mode,operationDirectory} = {}) {
  if(plan?.manifestRef){
    try{
      const text=readManifestArtifact(plan,{operationDirectory}),manifest=JSON.parse(text);
      if(plan.version!==manifest.versions?.tavern||plan.commit!==manifest.commit)throw new Error('固定发布清单摘要与封存原文不符。');
      plan={...plan,releaseManifestText:text,releaseManifest:manifest};
    }catch(error){throw launcherError('固定发布计划或清单无法核验。原操作目标、安装和备份已保留，请查看日志并通过新版启动器重新检查。',
      {userCode:'RELEASE_COMPATIBILITY',source:'release_service',site:'release.verify'},error);}
  }
  if (!plan || plan.schema !== 'nora-release-plan/1' || plan.planId !== planDigest(plan)
    || plan.platform !== platform || plan.arch !== arch || plan.channel !== channel || (tag && plan.tag !== tag)
    || !['update','install'].includes(plan.mode) || (mode && plan.mode !== mode) || plan.tag !== plan.release?.tag_name || !accepts(plan.release,channel)
    || !Number.isFinite(Date.parse(plan.checkedAt))) throw new Error('固定发布计划无效或与当前目标不符，未修改当前安装。');
  const parsed = JSON.parse(plan.releaseManifestText);
  if (canonical(parsed) !== canonical(plan.releaseManifest) || plan.commit!==plan.releaseManifest.commit
    ||plan.version!==undefined&&plan.version!==parsed.versions?.tavern) throw new Error('固定发布清单与保存的原文不符。');
  assetUrl(plan.release,'release-manifest.json');
  if(plan.launcherManifest) require('./launcher-update').validateManifest(plan.launcherManifest,
    {release:plan.release,manifest:plan.releaseManifest,platform,arch});
  if(compare(launcherVersion,plan.releaseManifest.launcherVersion)===-1 && !plan.launcherManifest) throw new Error('固定计划缺少所需启动器的校验信息。');
  validateUpdate(plan.releaseManifest,plan.release,plan.launcherManifest?.version || launcherVersion);
  if(plan.mode==='install' && !plan.systemManifest) throw new Error('完整安装计划缺少系统清单。');
  if (plan.systemManifest) {
    if(plan.systemManifest.commit!==plan.commit) throw new Error('完整系统与组件清单不是同一次发布。');
    validateSystem(plan.systemManifest,plan.release,platform,arch,plan.launcherManifest?.version || launcherVersion,channel);
    if(plan.systemManifest.files['release-manifest.json'].sha256!==bytesHash(plan.releaseManifestText))throw new Error('完整系统与固定发布清单校验信息不符。');
  }
  return freezePlan(JSON.parse(JSON.stringify(plan)));
}
async function selectPlan({fetcher = fetch,signal,launcherVersion,platform = process.platform,arch = process.arch,channel = 'stable',tag,mode = 'update',selectedRelease,releaseEvidence,metadataCache,networkPolicy}) {
  networkPolicy={...networkPolicy,deadlineAt:networkPolicy?.deadlineAt ?? (networkPolicy?.now || Date.now)()+(networkPolicy?.totalBudgetMs ?? 100000)};
  const lookup=releaseEvidence || (selectedRelease ? {release:selectedRelease,checkedAt:new Date().toISOString(),source:'selected',latestConfirmed:false}
    : await latest(fetcher,signal,channel,tag,{metadataCache,networkPolicy,withEvidence:true}));
  const release = lookup.release;
  if (!accepts(release,channel) || (tag && release.tag_name !== tag)) throw new Error('所选发布与目标渠道不符。');
  const metadata = await requestJson(assetUrl(release,'release-manifest.json'),fetcher,signal,{withEvidence:true,metadataCache,networkPolicy,channel});
  validateCapabilities(metadata.value);
  const launcherManifest = await require('./launcher-update').inspect({release,manifest:metadata.value,launcherVersion,fetcher,signal,platform,arch,metadataCache,networkPolicy,channel});
  validateUpdate(metadata.value,release,launcherManifest?.version || launcherVersion);
  const systemManifest = mode === 'install' ? await systemFor(release,{platform,arch,launcherVersion:launcherManifest?.version || launcherVersion,fetcher,signal,channel,metadataCache,networkPolicy}) : null;
  const plan = {schema:'nora-release-plan/1',mode,tag:release.tag_name,channel,platform,arch,release:releaseSnapshot(release),
    commit:metadata.value.commit,releaseManifest:metadata.value,releaseManifestText:metadata.body,launcherManifest,systemManifest,
    checkedAt:lookup.checkedAt,metadataSource:lookup.source,latestConfirmed:lookup.latestConfirmed};
  plan.planId=planDigest(plan);
  return validatePlan(plan,{launcherVersion,platform,arch,channel,tag,mode});
}
async function check({ installRoot, launcherVersion, fetcher = fetch, platform, arch, channel = 'stable',metadataCache,networkPolicy,signal }) {
  const installed = installedVersion(installRoot);
  const current = installed.version;
  const retryAt=error=>{
    if(!error?.rateLimited)return null;
    const now=(networkPolicy?.now || Date.now)();
    const reset=Number.isSafeInteger(error.rateLimitReset*1000)?error.rateLimitReset*1000:0;
    const after=Number.isFinite(error.retryAfterMs)&&error.retryAfterMs>=0?now+error.retryAfterMs:0;
    return Math.max(reset,after)||now+60000;
  };
  try {
    networkPolicy={...networkPolicy,deadlineAt:networkPolicy?.deadlineAt ?? (networkPolicy?.now || Date.now)()+(networkPolicy?.totalBudgetMs ?? 100000)};
    const lookup = await latest(fetcher,signal,channel,undefined,{metadataCache,networkPolicy,withEvidence:true}),release=lookup.release;
    const comparison = compare(current, release.tag_name);
    let system = null, compatibilityError = '', requestError = '', requestFailed = false, launcher = null, diagnosticError, releasePlan;
    try {
      releasePlan = await selectPlan({releaseEvidence:lookup,launcherVersion,fetcher,platform,arch,channel,metadataCache,networkPolicy,signal});
      launcher = releasePlan.launcherManifest;
      system = releasePlan.releaseManifest;
    }
    catch (error) {
      if (error.site === 'release.request') { requestFailed = true; requestError = error.message || '尚未取得有效的发布响应，请稍后重新检查。'; }
      else compatibilityError = error.message;
      diagnosticError = launcherError(error.message || '发布清单检查未通过。', {source:'release_service',site:error.site || 'release.verify'}, error);
    }
    return { current, versionSource: installed.source, latest: release.tag_name, checkedAt: lookup.checkedAt, launcherVersion,
      metadataSource:lookup.source,latestConfirmed:lookup.latestConfirmed,retryAt:retryAt(diagnosticError),...(releasePlan ? {releasePlan} : {}),
      releaseUrl: `https://github.com/${REPO}/releases/tag/${release.tag_name}`,
      updateSupported: Boolean(system), channel,
      launcherLatest: system?.launcherVersion || null, launcherUpdateAvailable: system ? compare(launcherVersion, system.launcherVersion) === -1 : false,
      state: requestFailed ? 'unavailable' : !system ? 'blocked' : comparison === null ? 'unknown' : comparison < 0 || launcher ? 'available' : comparison > 0 ? 'ahead' : 'current',
      releaseAvailable: comparison !== null && comparison < 0,
      available: comparison !== null && (comparison < 0 || Boolean(launcher)) && Boolean(system), installable: Boolean(system), compatibilityError, ...(requestFailed ? {error:requestError} : {}), ...(diagnosticError ? {diagnosticError} : {}) };
  } catch (error) {
    return { current, latest: null, checkedAt:null,metadataSource:'unavailable',latestConfirmed:false,retryAt:retryAt(error),launcherVersion, state: 'unavailable', available: false, installable: false, error: error.message,
      diagnosticError:launcherError(error.message || '检查更新未完成。', {source:'release_service',site:error.site || 'release.check'}, error) };
  }
}
async function prepareUpdate({ cacheRoot, launcherVersion, fetcher = fetch, signal, onEvent = () => {},
  channel = 'stable', tag, plan, selectedPlan, operationDirectory,platform = process.platform, arch = process.arch,metadataCache,networkPolicy }) {
  onEvent({ event: 'task', stage_id: 'release_check', task: '检查更新清单' });
  const fixed = selectedPlan ? validatePlan(selectedPlan,{launcherVersion,platform,arch,channel,tag,operationDirectory})
    : await selectPlan({fetcher,signal,launcherVersion,platform,arch,channel,tag,metadataCache,networkPolicy});
  const release = fixed.release;
  const manifest = validateUpdate(fixed.releaseManifest,release,launcherVersion);
  const root = path.join(cacheRoot, `components-${release.tag_name}-${manifest.commit.slice(0, 12)}`);
  fs.mkdirSync(root, { recursive: true });
  const download = async (name, expected) => {
    fileName(name);
    signal?.throwIfAborted();
    const target = path.join(root, name);
    onEvent({ event: 'task', stage_id: 'verify', task: `校验缓存：${name}` });
    const size=release.assets.find(item=>item.name===name)?.size;
    await downloadAsset({url:assetUrl(release,name),target,identity:{tag:release.tag_name,asset:name,sha256:expected,...(size ? {size}: {})},
      fetcher,signal,onEvent,policy:networkPolicy,task:`准备 ${release.tag_name}：${name}`,maxSize:expected ? 2*1024**3 : 4*1024*1024});
  };
  await download('SHA256SUMS');
  const sums = new Map();
  for (const line of fs.readFileSync(path.join(root, 'SHA256SUMS'), 'utf8').split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?([a-zA-Z0-9][a-zA-Z0-9._-]*)$/.exec(line);
    if (match) {
      if (sums.has(match[2])) throw new Error('发布校验清单包含重复文件。');
      sums.set(match[2], match[1]);
    }
  }
  if (!sums.has('release-manifest.json')) throw new Error('发布清单缺少校验信息。');
  if (crypto.createHash('sha256').update(fixed.releaseManifestText).digest('hex') !== sums.get('release-manifest.json'))
    throw new Error('所选发布清单与发布校验信息不符，请重新检查版本。');
  fs.writeFileSync(path.join(root,'release-manifest.json'),fixed.releaseManifestText,{mode:0o600});
  const verified = validateUpdate(readJson(path.join(root, 'release-manifest.json')), release, launcherVersion);
  if (verified.commit !== manifest.commit || verified.bootstrap.sha256 !== manifest.bootstrap.sha256) throw new Error('下载过程中发布清单发生变化，请重新检查版本。');
  await download('tavern-updater-bootstrap.py', verified.bootstrap.sha256);
  const result = await plan(root);
  if (result.error) throw new Error(result.error);
  if (!Array.isArray(result.archives) || compare(result.version, release.tag_name) !== 0) throw new Error('更新器返回的下载计划无效。');
  onEvent({ event: 'task', task: `更新器已确认 ${result.archives.length} 个待下载模块` });
  for (const item of result.archives) {
    fileName(item.name);
    if (!/^[a-f0-9]{64}$/.test(item.sha256 || '') || sums.get(item.name) !== item.sha256) throw new Error('更新模块与发布校验清单不一致。');
    await download(item.name, item.sha256);
  }
  return root;
}
async function prepare({ cacheRoot, bundledRoot, launcherVersion, platform = process.platform, arch = process.arch,
  fetcher = fetch, signal, onEvent = () => {}, channel = 'stable', tag, selectedRelease,selectedPlan,operationDirectory,metadataCache,networkPolicy }) {
  onEvent({ event: 'task', stage_id: 'release_check', task: `确认 GitHub ${channel === 'beta' ? 'Beta 测试' : '正式'}完整版本` });
  signal?.throwIfAborted();
  const fixed=selectedPlan ? validatePlan(selectedPlan,{launcherVersion,platform,arch,channel,tag,mode:'install',operationDirectory}) : null;
  const release = fixed?.release || selectedRelease || await latest(fetcher, signal, channel, tag,{metadataCache,networkPolicy});
  if (!accepts(release, channel) || tag && release.tag_name!==tag) throw new Error('所选发布与安装渠道或固定目标不符。');
  const system = fixed?.systemManifest || await systemFor(release, { platform, arch, launcherVersion, fetcher, signal, channel,metadataCache,networkPolicy });
  if(!system) throw new Error('完整安装计划缺少系统清单。');
  validateSystem(system,release,platform,arch,launcherVersion,channel);
  const root = path.join(cacheRoot, `${release.tag_name}-${platform}-${arch}-${system.commit.slice(0, 12)}`);
  fs.mkdirSync(root, { recursive: true });
  for (const [name, item] of Object.entries(system.files)) {
    signal?.throwIfAborted();
    const target = path.join(root, name);
    onEvent({ event: 'task', stage_id: 'verify', task: `准备 ${release.tag_name}：${name}` });
    if (await matches(target, item.sha256) && fs.statSync(target).size===item.size) continue;
    const local = bundledRoot ? path.join(bundledRoot, name) : null;
    if(local && await matches(local,item.sha256) && fs.statSync(local).size===item.size) fs.copyFileSync(local,target);
    else if(name==='release-manifest.json' && fixed && crypto.createHash('sha256').update(fixed.releaseManifestText).digest('hex')===item.sha256)
      fs.writeFileSync(target,fixed.releaseManifestText,{mode:0o600});
    else await downloadAsset({url:assetUrl(release,item.asset),target,identity:{tag:release.tag_name,asset:item.asset,sha256:item.sha256,size:item.size},
      fetcher,signal,policy:networkPolicy,task:`下载：${name}`,onEvent:event=>onEvent({...event,...(event.event==='progress'?{ratio:event.total ? event.current/event.total:0}:{})})});
  }
  validatePayload(root, system, platform, arch);
  fs.writeFileSync(path.join(root, 'nora-system.json'), JSON.stringify(system, null, 2), { mode: 0o600 });
  return root;
}

async function prepareInstall(options) {
  const { fetcher = fetch, signal, channel = 'stable', onEvent = () => {}, onPlan = () => {}, confirmBundled } = options;
  signal?.throwIfAborted();
  if(options.selectedPlan) {
    const plan=validatePlan(options.selectedPlan,{...options,mode:'install'});
    await onPlan(plan);signal?.throwIfAborted();
    return prepare({...options,selectedPlan:plan});
  }
  onEvent({event:'task',stage_id:'release_check',task:`查询最新${channel === 'beta' ? 'Beta 测试' : '稳定'}版本`});
  const networkPolicy={...options.networkPolicy,deadlineAt:options.networkPolicy?.deadlineAt
    ?? (options.networkPolicy?.now || Date.now)()+(options.networkPolicy?.totalBudgetMs ?? 100000)};
  let lookup;
  try { lookup = await latest(fetcher, signal, channel, options.tag,{metadataCache:options.metadataCache,networkPolicy,withEvidence:true}); }
  catch (error) {
    signal?.throwIfAborted();
    // Only a failed release lookup can offer the offline package. A discovered
    // incompatible release, bad manifest or corrupt download must fail closed.
    if (typeof confirmBundled !== 'function' || error.source !== 'release_service'
      || ['INVALID_RESPONSE','RESPONSE_TOO_LARGE','CANCELLED'].includes(error.code)) throw error;
    const root = await prepareBundled(options);
    const system = readJson(path.join(root,'nora-system.json'));
    if (!await confirmBundled({version:system.version,error})) throw error;
    signal?.throwIfAborted();
    const localPlan={schema:'nora-bundled-plan/1',mode:'install',tag:`v${system.version.replace(/^v/,'')}`,
      version:system.version,commit:system.commit,platform:system.platform,arch:system.arch,channel,
      manifestSha256:await hash(path.join(root,'release-manifest.json')),metadataSource:'bundled',latestConfirmed:false};
    localPlan.planId=planDigest(localPlan);
    await onPlan(freezePlan(localPlan));signal?.throwIfAborted();
    onEvent({event:'task',stage_id:'verify',task:`按用户选择安装包内版本 ${system.version}，未确认其为最新版`});
    return root;
  }
  // Keep one release snapshot throughout selection, downloads and verification.
  const plan=await selectPlan({...options,mode:'install',releaseEvidence:lookup,networkPolicy});
  await onPlan(plan);signal?.throwIfAborted();
  return prepare({...options,selectedPlan:plan});
}
function validatePayload(root, system, platform, arch) {
  const payload = readJson(path.join(root, 'release-manifest.json'));
  validateCapabilities(payload);
  const runtime = readJson(path.join(root, 'nora-hermes-runtime.json'));
  const dependencies = readJson(path.join(root, 'nora-tavern-dependencies.json'));
  if (payload.candidate || payload.commit !== system.commit || compare(payload.versions?.tavern, system.version) !== 0 ||
      !system.files[runtime.archive] || !system.files[dependencies.archive] ||
      runtime.sha256 !== system.files[runtime.archive].sha256 || dependencies.sha256 !== system.files[dependencies.archive].sha256 ||
      runtime.platform !== platform || runtime.arch !== arch || dependencies.platform !== platform || dependencies.arch !== arch) {
    throw new Error('完整系统包内部版本或运行环境不一致。');
  }
}

function bundledUpgradeTarget({ bundledRoot, currentVersion, launcherVersion, platform = process.platform,
  arch = process.arch, channel = 'stable' }) {
  const system = readJson(path.join(bundledRoot, 'nora-system.json'));
  try { validateSystem(system, null, platform, arch, launcherVersion, channel); }
  catch { return null; }
  // This is only a target hint; the updater still verifies the selected release before any mutation.
  return compare(currentVersion, system.version) === -1 ? `v${system.version.replace(/^v/, '')}` : null;
}
async function prepareBundled({ bundledRoot, launcherVersion, platform = process.platform, arch = process.arch,
  signal, onEvent = () => {}, channel = 'stable' }) {
  const system = readJson(path.join(bundledRoot, 'nora-system.json'));
  validateSystem(system, null, platform, arch, launcherVersion, channel);
  for (const [name, item] of Object.entries(system.files)) {
    signal?.throwIfAborted();
    onEvent({ event: 'task', stage_id: 'verify', task: `校验包内 ${system.version}：${name}` });
    const file = path.join(bundledRoot, name);
    const stat = await fs.promises.lstat(file).catch(error => {
      if (error.code === 'ENOENT') throw new Error(`安装包缺少组件：${name}，请重新下载完整安装包。`);
      throw error;
    });
    if (!stat.isFile() || stat.size !== item.size || !await matches(file, item.sha256)) {
      throw new Error(`安装包组件校验失败：${name}，请重新下载完整安装包。`);
    }
  }
  signal?.throwIfAborted();
  validatePayload(bundledRoot, system, platform, arch);
  return bundledRoot;
}
module.exports = { compare, check, prepare, prepareInstall, prepareUpdate, prepareBundled, bundledUpgradeTarget, validateSystem, validateUpdate,validateCapabilities, hash, latest, accepts, requestJson, assetUrl,selectPlan,validatePlan,sealPlan,createMetadataCache };
