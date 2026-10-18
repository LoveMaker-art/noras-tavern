const fs = require('node:fs');
const { launcherError } = require('./launcher-errors');
const path = require('node:path');
const crypto = require('node:crypto');
const semver = require('semver');
const {metadataJson,createMetadataCache,createReleaseSourceContext,downloadAsset} = require('./release-network');
const operationNetworkPolicy = policy => ({...policy,
  sourceContext:policy?.sourceContext || createReleaseSourceContext()});

const REPO = 'LoveMaker-art/noras-tavern';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const ASSET_INDEX = 'release-assets.json';
const LAST_LEGACY_ASSET_CLIENT = '2.1.1';
const CURRENT_ASSET = /^(?:release-assets\.json|release-manifest\.json|[A-Za-z0-9][A-Za-z0-9._-]*-(?:release-manifest[A-Za-z0-9._-]*\.json|SHA256SUMS|first-install-manifest\.json|nora-tavern-first-install-bootstrap\.py|tavern-updater-bootstrap\.py)|SHA256SUMS|LAUNCHER-SHA256SUMS|bootstrap-manifest\.json|tavern-updater-bootstrap\.py|nora-(?:system|launcher)-[A-Za-z0-9._-]*\.json|Nora-Tavern-Launcher-[A-Za-z0-9._-]*|first-install-manifest\.json|nora-tavern-first-install-bootstrap\.py|install-nora-tavern\.(?:sh|ps1)|install-tavern-updater\.sh)$/;
const LAUNCHER_CAPABILITIES=Object.freeze({operationSchema:'nora-operation/1',executorProtocol:'nora-operation-executor/1',telemetrySchema:3,faultSchema:2});
const UPDATER_CAPABILITIES=Object.freeze({...LAUNCHER_CAPABILITIES});
function updaterClient(options={}){
  if(options.client!==undefined&&!['launcher','updater'].includes(options.client))throw new Error('更新客户端类型无效。');
  return options.client==='updater';
}
function candidateAcceptance(options={}){
  if(!updaterClient(options)||options.allowCandidate!==true||typeof options.explicitLocalRelease!=='string'
    ||!path.isAbsolute(options.explicitLocalRelease))return null;
  const directory=path.resolve(options.explicitLocalRelease),stat=fs.lstatSync(directory);
  if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('候选验收目录无效。');
  return {schema:'nora-local-candidate/1',releaseDirectory:directory};
}
function acceptsCandidate(manifest,options={},system=false){
  if(!manifest?.candidate)return true;
  const acceptance=candidateAcceptance(options);if(!acceptance)return false;
  const name=system?`nora-system-${manifest.platform}-${manifest.arch}.json`
    :options.systemManifest?.files?.['release-manifest.json']?.asset||'release-manifest.json';
  fileName(name);
  const file=path.join(acceptance.releaseDirectory,name),stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4*1024*1024
    ||canonical(readJson(file))!==canonical(manifest))throw new Error('候选发布与显式本地验收文件不一致。');
  return true;
}
function validateCapabilities(manifest,options={}){
  const updater=updaterClient(options),actual=updater?options.updaterCapabilities:LAUNCHER_CAPABILITIES;
  // Historical releases called the same executor contract launcherCapabilities.
  // An independent actor supplies its actual protocols, never an APP version.
  const declared=updater?(Object.hasOwn(manifest||{},'updaterCapabilities')?manifest.updaterCapabilities:manifest?.launcherCapabilities):manifest?.launcherCapabilities;
  if(!actual||!declared||Object.entries(updater?UPDATER_CAPABILITIES:LAUNCHER_CAPABILITIES)
    .some(([key,value])=>actual[key]!==value||declared[key]!==actual[key]))
    throw launcherError(`线上发布与当前${updater?'更新器':'启动器'}的维护协议不兼容，未修改原安装和数据。请等待兼容版本发布，勿反复重试。`,
      {code:'VERIFICATION_FAILED',userCode:'RELEASE_EXECUTOR_INCOMPATIBLE',source:'release_service',site:'release.verify'});
}
const version = value => typeof value === 'string' ? semver.valid(value) : null;
function publicationTag(manifest) {
  const core=manifest?.versions?.tavern ?? manifest?.version;
  if(!version(core))throw new Error('发布清单缺少有效核心版本。');
  if(!Object.hasOwn(manifest,'publication'))return `v${version(core)}`;
  const value=manifest.publication;
  if(!value||value.schema!=='nora-component-publication/1'
    ||Object.keys(value).some(key=>!['schema','tag'].includes(key))
    ||!/^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(value.tag||'')||version(value.tag)!==value.tag.slice(1))throw new Error('组件发布批次身份无效。');
  return value.tag;
}
// A publication may replace only the APP. Its product source is distinct from
// the unchanged core payload, which is bound by original bytes, not version alone.
function coreReference(manifest,platform,arch) {
  if(!Object.hasOwn(manifest||{},'coreRelease'))return null;
  const ref=manifest.coreRelease;
  if(!ref||ref.schema!=='nora-core-reference/1'||Object.keys(ref).some(key=>!['schema','tag','commit','manifests'].includes(key))
    ||!/^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(ref.tag||'')||!version(ref.tag)
    ||compare(ref.tag,publicationTag(manifest))!==-1||!/^[a-f0-9]{40}$/.test(ref.commit||'')
    ||!ref.manifests||Array.isArray(ref.manifests)||!Object.keys(ref.manifests).length)
    throw new Error('不变核心的来源证明无效。');
  for(const [key,item] of Object.entries(ref.manifests)){
    if(!['darwin-arm64','darwin-x64','win32-x64'].includes(key)||!item
      ||Object.keys(item).some(name=>!['asset','sha256','size'].includes(name))
      ||item.asset!==`${key}-release-manifest.json`||!/^[a-f0-9]{64}$/.test(item.sha256||'')
      ||!Number.isSafeInteger(item.size)||item.size<1||item.size>4*1024*1024)
      throw new Error('不变核心的平台清单证明无效。');
  }
  if(platform===undefined)return ref;
  const item=ref.manifests[`${platform}-${arch}`];
  if(!item)throw new Error('不变核心缺少当前平台的清单证明。');
  return {...item,tag:ref.tag,commit:ref.commit};
}
function coreIdentity(plan){
  const ref=coreReference(plan.releaseManifest,plan.platform,plan.arch);
  return {version:plan.releaseManifest.versions.tavern,commit:ref?.commit||plan.commit,
    manifestSha256:ref?.sha256||bytesHash(plan.releaseManifestText)};
}
function validateCoreManifestText(text,system){
  const ref=coreReference(system,system.platform,system.arch);
  if(!ref)return;
  const manifest=JSON.parse(text);
  if(bytesHash(text)!==ref.sha256||Buffer.byteLength(text)!==ref.size||manifest.commit!==ref.commit
    ||publicationTag(manifest)!==ref.tag||manifest.versions?.tavern!==system.version
    ||Object.hasOwn(manifest,'coreRelease'))throw new Error('不变核心的原始清单与发布证明不一致。');
}
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
  const index = release.assetIndexText === undefined ? null : validateAssetReferences(release);
  const reference = index?.assets.find(item => item.name === name);
  const expected = `https://github.com/${REPO}/releases/download/${encodeURIComponent(reference?.asset_release_tag || release.tag_name)}/${name}`;
  if (!asset || asset.browser_download_url !== expected) throw new Error(`最新发布缺少完整组件：${name}`);
  return expected;
}
function validateAssetIndex(index, tag) {
  if (!index || index.schema !== 'nora-release-assets/1' || index.repository !== REPO || index.tag !== tag
      || !/^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(tag || '') || !/^[a-f0-9]{40}$/.test(index.commit || '')
      || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(index.minimumLauncherVersion || '')
      || compare(index.minimumLauncherVersion,LAST_LEGACY_ASSET_CLIENT) !== 1
      || !Array.isArray(index.assets) || index.assets.length > 256) throw new Error('共享资产索引身份或兼容门槛无效。');
  const names = new Set();
  for (const item of index.assets) {
    fileName(item?.name);
    if (names.has(item.name) || CURRENT_ASSET.test(item.name)
        || !/^v\d+\.\d+\.\d+$/.test(item.asset_release_tag || '') || compare(item.asset_release_tag,tag) !== -1
        || !/^[a-f0-9]{64}$/.test(item.sha256 || '') || !Number.isSafeInteger(item.size) || item.size < 1 || item.size > 2*1024**3
        || Object.keys(item).some(key => !['name','asset_release_tag','size','sha256'].includes(key)))
      throw new Error('共享资产引用缺失、冲突或超出可信范围。');
    names.add(item.name);
  }
  return index;
}
function validateAssetReferences(release) {
  const descriptor = release.assets?.find(item => item.name === ASSET_INDEX);
  if (typeof release.assetIndexText !== 'string' || Buffer.byteLength(release.assetIndexText) > 64*1024
      || !descriptor || descriptor.state !== 'uploaded' || !Number.isSafeInteger(descriptor.size) || descriptor.size < 1
      || descriptor.size !== Buffer.byteLength(release.assetIndexText) || !/^sha256:[a-f0-9]{64}$/.test(descriptor.digest || '')
      || crypto.createHash('sha256').update(release.assetIndexText).digest('hex') !== descriptor.digest.slice(7)
      || descriptor.browser_download_url !== `https://github.com/${REPO}/releases/download/${encodeURIComponent(release.tag_name)}/${ASSET_INDEX}`)
    throw new Error('共享资产索引原文与当前发布校验信息不一致。');
  const index = validateAssetIndex(JSON.parse(release.assetIndexText),release.tag_name), names = new Set();
  for (const asset of release.assets) {
    fileName(asset.name);
    if (names.has(asset.name)) throw new Error('共享发布包含重复资产。');
    names.add(asset.name);
    const reference = index.assets.find(item => item.name === asset.name);
    const expected = `https://github.com/${REPO}/releases/download/${encodeURIComponent(reference?.asset_release_tag || release.tag_name)}/${asset.name}`;
    if (asset.browser_download_url !== expected || asset.asset_release_tag !== reference?.asset_release_tag
        || reference && (asset.size !== reference.size || asset.digest !== `sha256:${reference.sha256}` || asset.state !== 'uploaded'))
      throw new Error('共享资产与已校验的索引引用不一致。');
  }
  if (index.assets.some(item => !names.has(item.name))) throw new Error('共享资产引用未完整纳入发布计划。');
  return index;
}
async function withAssetReferences(release,fetcher,signal,options,evidence) {
  const descriptor = release.assets?.find(item => item.name === ASSET_INDEX);
  if (!descriptor) return release;
  if (release.assets.some(item => item.asset_release_tag !== undefined) || release.assetIndexText !== undefined)
    throw new Error('线上发布不得伪造已经校验的共享资产。');
  if (descriptor.state !== 'uploaded' || !Number.isSafeInteger(descriptor.size) || descriptor.size < 1 || descriptor.size > 64*1024
      || !/^sha256:[a-f0-9]{64}$/.test(descriptor.digest || '')) throw new Error('当前发布缺少共享索引校验信息。');
  const result = await requestJson(assetUrl(release,ASSET_INDEX),fetcher,signal,{...options,withEvidence:true,
    conditionIdentity:{sha256:descriptor.digest.slice(7),size:descriptor.size}});
  evidence.push(result);
  const index = validateAssetIndex(result.value,release.tag_name);
  if (index.assets.some(item => release.assets.some(asset => asset.name === item.name))) throw new Error('共享引用与当前发布资产同名。');
  const expanded = {...release,assetIndexText:result.body,assets:[...release.assets,...index.assets.map(item => ({
    name:item.name,state:'uploaded',size:item.size,digest:`sha256:${item.sha256}`,asset_release_tag:item.asset_release_tag,
    browser_download_url:`https://github.com/${REPO}/releases/download/${encodeURIComponent(item.asset_release_tag)}/${item.name}`}))]};
  validateAssetReferences(expanded);
  // Only references whose original text, digest, size and origin were accepted
  // above may inherit this operation's successful distribution source.
  options.networkPolicy?.sourceContext?.authorizeAssets?.(index.assets.map(item => ({
    url:assetUrl(expanded,item.name),sha256:item.sha256,size:item.size})));
  return expanded;
}
function validateAssetRelease(manifest,release,minimum) {
  if (release?.assetIndexText === undefined) return;
  const index = validateAssetReferences(release);
  if (manifest.commit !== index.commit || compare(minimum,index.minimumLauncherVersion) === null || compare(minimum,index.minimumLauncherVersion) < 0)
    throw new Error('共享资产与目标发布提交或客户端兼容门槛不一致。');
}
function validateAssetIntegrity(release,name,expected) {
  if (release?.assetIndexText === undefined) return;
  const asset = release.assets.find(item => item.name === name);
  assetUrl(release,name);
  if (asset.digest !== `sha256:${expected.sha256}` || expected.size !== undefined && asset.size !== expected.size
      || asset.asset_release_tag && (!Number.isSafeInteger(expected.size) || expected.size < 1))
    throw new Error('共享资产引用与组件校验信息不一致。');
}
// A 2.1.1 APP handoff seals the physical catalogue without understanding refs.
// Resolve routing at that same tag; never replace or re-seal the selected plan.
async function resolvePlanAssets(fixed,{fetcher,signal,metadataCache,networkPolicy,onEvent,client,updaterCapabilities,allowCandidate,explicitLocalRelease}) {
  if (fixed.release.assetIndexText !== undefined || !fixed.release.assets.some(item=>item.name===ASSET_INDEX)) return fixed.release;
  const resolved = await latest(fetcher,signal,fixed.channel,fixed.tag,{metadataCache,networkPolicy});
  const physical = resolved.assets.filter(item=>!item.asset_release_tag);
  if (physical.length !== fixed.release.assets.length || fixed.release.assets.some(item=>{
    const current=physical.find(asset=>asset.name===item.name);
    return !current || current.browser_download_url!==item.browser_download_url || current.size!==item.size
      || !Number.isSafeInteger(item.size) || item.size<1;
  })) throw new Error('原固定发布的物理资产集合已变化，未重新选择目标。');
  const index=validateAssetReferences(resolved);
  if (index.commit!==fixed.commit || index.minimumLauncherVersion!==fixed.releaseManifest.bootstrap.minimumLauncherVersion)
    throw new Error('共享索引与原固定发布的提交或兼容门槛不符。');
  validateUpdate(fixed.releaseManifest,resolved,updaterClient({client})?undefined:fixed.launcherManifest?.version || fixed.releaseManifest.bootstrap.minimumLauncherVersion,
    {client,updaterCapabilities,allowCandidate,explicitLocalRelease,...(fixed.mode==='install' ? {systemManifest:fixed.systemManifest,platform:fixed.platform,arch:fixed.arch,channel:fixed.channel} : {})});
  if (fixed.systemManifest) validateSystem(fixed.systemManifest,resolved,fixed.platform,fixed.arch,
    updaterClient({client})?undefined:fixed.launcherManifest?.version || fixed.systemManifest.minimumLauncherVersion,fixed.channel,{client,updaterCapabilities,allowCandidate,explicitLocalRelease});
  if (fixed.launcherManifest) require('./launcher-update').validateManifest(fixed.launcherManifest,
    {release:resolved,manifest:fixed.releaseManifest,platform:fixed.platform,arch:fixed.arch});
  onEvent?.({event:'log',line:`共享资产来源已按原固定计划核验：${fixed.tag} ${fixed.planId} index ${bytesHash(resolved.assetIndexText)}`});
  return resolved;
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
  options={...options,networkPolicy:operationNetworkPolicy(options.networkPolicy)};
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
      // A build-owned static channel is a complete catalogue, not a page of
      // GitHub's list endpoint. Never fall back to API pagination after it.
      if (rows.length < 100 || evidence.at(-1)?.catalogueComplete === true) break;
    }
    release = candidates.sort((a, b) => compare(b.tag_name, a.tag_name))[0];
  } else {
    release = await read(API);
  }
  if (!release || !accepts(release, channel)) throw new Error(channel === 'beta' ? '尚未发布可用的 Beta 测试版本。' : '没有找到有效的正式发布版本。');
  if (tag && release.tag_name !== tag) throw new Error('目标发布与所选版本不一致。');
  options.networkPolicy.sourceContext.bindTarget(release.tag_name);
  release = await withAssetReferences(release,fetcher,signal,{...options,channel},evidence);
  return options.withEvidence ? {release,checkedAt:evidence.map(item=>item.checkedAt).sort()[0],
    source:evidence.some(item=>item.source==='cache')?'cache':evidence.some(item=>item.source==='revalidated')?'revalidated':'network',
    latestConfirmed:evidence.every(item=>item.latestConfirmed)} : release;
}

// Discovery is optional and runs only after the ordinary core plan is valid.
// Reuse its verified bytes; neither lookup changes the persisted plan format.
function discoveryManifest(release, metadata) {
  const asset=release.assets?.find(item=>item.name==='release-manifest.json');
  if(!asset||asset.state!=='uploaded'||!/^sha256:[a-f0-9]{64}$/.test(asset.digest||'')
    ||!Number.isSafeInteger(asset.size)||asset.size<1||asset.size>4*1024*1024
    ||Buffer.byteLength(metadata.body)!==asset.size||bytesHash(metadata.body)!==asset.digest.slice(7))
    throw new Error('启动器发布清单与固定校验信息不符。');
  return metadata.value;
}
async function discoverLauncherRelease(corePlan,{fetcher,signal,metadataCache,networkPolicy,platform,arch}) {
  if(corePlan.channel!=='stable'||corePlan.releaseManifest.coreRelease)return null;
  const anchor=corePlan.release,evidence=[{checkedAt:corePlan.checkedAt,source:corePlan.metadataSource,latestConfirmed:corePlan.latestConfirmed}];
  const rows=[];let complete=false;
  for(let page=1;page<=5;page++){
    const item=await requestJson(`https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`,fetcher,signal,
      {metadataCache,networkPolicy,channel:'stable',withEvidence:true});
    evidence.push(item);
    if(!Array.isArray(item.value)||item.value.length>100)throw new Error('启动器发布列表无效。');
    rows.push(...item.value);
    if(item.value.length<100||item.catalogueComplete===true){complete=true;break;}
  }
  if(!complete)throw new Error('启动器发布列表超过本次有界查询范围。');
  const candidates=rows.filter(item=>accepts(item,'stable')&&compare(item.tag_name,anchor.tag_name)>0)
    .sort((a,b)=>compare(b.tag_name,a.tag_name));
  if(!candidates.length)return null;
  const core=discoveryManifest(anchor,{body:corePlan.releaseManifestText,value:corePlan.releaseManifest});
  if(core.schema!=='tavern-release/v2'||core.candidate||core.coreRelease
    ||publicationTag(core)!==anchor.tag_name||compare(core.versions?.tavern,anchor.tag_name)!==0
    ||!/^[a-f0-9]{40}$/.test(core.commit||''))throw new Error('核心稳定版锚点无法核验。');
  for(const item of candidates){
    const metadata=await requestJson(releaseManifestAsset(item,{mode:'update'}),fetcher,signal,
      {metadataCache,networkPolicy,channel:'stable',withEvidence:true});
    evidence.push(metadata);
    const product=discoveryManifest(item,metadata);
    if(!product.coreRelease)continue;
    const ref=coreReference(product,platform,arch);
    if(ref.tag!==anchor.tag_name||ref.commit!==core.commit||product.versions?.tavern!==core.versions.tavern)continue;
    const original=anchor.assets?.find(value=>value.name===ref.asset);
    if(!original||original.state!=='uploaded'||original.digest!==`sha256:${ref.sha256}`||original.size!==ref.size)
      throw new Error('启动器发布引用的原核心清单与稳定版不一致。');
    if(publicationTag(product)!==item.tag_name||product.candidate||!/^[a-f0-9]{40}$/.test(product.commit||''))
      throw new Error('启动器发布批次身份无法核验。');
    const release=await withAssetReferences(item,fetcher,signal,{metadataCache,networkPolicy,channel:'stable'},evidence);
    return {metadata,lookup:{release,checkedAt:evidence.map(value=>value.checkedAt).sort()[0],
      source:evidence.some(value=>value.source==='cache')?'cache':evidence.some(value=>value.source==='revalidated')?'revalidated':'network',
      latestConfirmed:evidence.every(value=>value.latestConfirmed)}};
  }
  return null;
}

function validateSystemDescriptor(manifest, release, platform, arch, channel = 'stable',options={}) {
  if (manifest.schema !== 'nora-system/v1' || !acceptsCandidate(manifest,options,true) || manifest.platform !== platform || manifest.arch !== arch ||
      (manifest.channel || 'stable') !== channel ||
      compare(manifest.version,manifest.version)!==0 ||
      (release && publicationTag(manifest) !== release.tag_name) ||
      compare(manifest.minimumLauncherVersion,manifest.minimumLauncherVersion)!==0 || !/^[a-f0-9]{40}$/.test(manifest.commit || '')) throw new Error('完整系统发布清单与目标版本或平台不符。');
  validateCapabilities(manifest,options);
  publicationTag(manifest);
  const core=coreReference(manifest,platform,arch);
  if(core){
    const item=manifest.files?.['release-manifest.json'];
    if(!item||item.asset!==core.asset||item.sha256!==core.sha256||item.size!==core.size)
      throw new Error('完整系统未绑定原始核心清单。');
  }
  validateAssetRelease(manifest,release,manifest.minimumLauncherVersion);
  const required = ['release-manifest.json', 'SHA256SUMS', 'nora-tavern-app.tar.gz', 'nora-tavern-ops.tar.gz',
    'nora-tavern-nora-mcp.tar.gz', 'nora-tavern-first-install-bootstrap.py', 'first-install-manifest.json',
    'nora-hermes-runtime.json', 'nora-tavern-dependencies.json'];
  if (!manifest.files || required.some(name => !manifest.files[name])) throw new Error('最新发布不是完整 Nora 系统包。');
  for (const [name, item] of Object.entries(manifest.files)) {
    fileName(name); fileName(item.asset);
    if (!/^[a-f0-9]{64}$/.test(item.sha256 || '') || !Number.isSafeInteger(item.size) || item.size < 1) throw new Error('组件校验信息缺失。');
    if (release) { assetUrl(release,item.asset); validateAssetIntegrity(release,item.asset,item); }
  }
  if(release) releaseManifestAsset(release,{mode:'install',systemManifest:manifest,platform,arch});
  return manifest;
}
function validateSystem(manifest, release, platform, arch, launcherVersion, channel = 'stable',options={}) {
  validateSystemDescriptor(manifest,release,platform,arch,channel,options);
  if (!updaterClient(options)&&(compare(launcherVersion, manifest.minimumLauncherVersion) === null || compare(launcherVersion, manifest.minimumLauncherVersion) < 0)) {
    throw new Error(`请先升级启动器到 ${manifest.minimumLauncherVersion} 或更新版本。`);
  }
  return manifest;
}
function releaseManifestAsset(release,{mode,systemManifest,platform,arch}) {
  const name=mode==='install' ? systemManifest?.files?.['release-manifest.json']?.asset : 'release-manifest.json';
  if (name!=='release-manifest.json' && name!==`${platform}-${arch}-release-manifest.json`)
    throw new Error('完整系统指定的发布清单不属于当前平台。');
  const assets=release.assets?.filter(item=>item.name===name);
  const core=mode==='install'?coreReference(systemManifest,platform,arch):null;
  if (assets?.length!==1 || assets[0].asset_release_tag!==undefined)
    throw new Error(`固定发布清单必须是当前发布的唯一实体：${name}`);
  const url=assetUrl(release,name);
  if (url!==`https://github.com/${REPO}/releases/download/${encodeURIComponent(release.tag_name)}/${name}`)
    throw new Error('固定发布清单来源不属于当前发布。');
  if(core&&(name!==core.asset||assets[0].size!==core.size||assets[0].digest!==`sha256:${core.sha256}`))
    throw new Error('引用的原始核心清单校验信息不一致。');
  return url;
}
function validateInstallManifestText(text,systemManifest) {
  const descriptor=systemManifest.files['release-manifest.json'];
  if(descriptor.sha256!==bytesHash(text) || descriptor.size!==Buffer.byteLength(text))
    throw new Error('完整系统与固定发布清单校验信息不符。');
  validateCoreManifestText(text,systemManifest);
}
async function systemFor(release, { platform = process.platform, arch = process.arch, launcherVersion, fetcher = fetch, signal, channel = 'stable',metadataCache,networkPolicy,client,updaterCapabilities,allowCandidate,explicitLocalRelease }) {
  const name = `nora-system-${platform}-${arch}.json`;
  const manifest = await requestJson(assetUrl(release, name), fetcher, signal,{metadataCache,networkPolicy,channel,conditionIdentity:{expectedVersion:launcherVersion}});
  return validateSystem(manifest, release, platform, arch, launcherVersion, channel,{client,updaterCapabilities,allowCandidate,explicitLocalRelease});
}
function validateUpdate(manifest, release, launcherVersion, {systemManifest,platform,arch,channel='stable',client,updaterCapabilities,allowCandidate,explicitLocalRelease} = {}) {
  const core=systemManifest?coreReference(systemManifest,platform,arch):null;
  if (manifest.schema !== 'tavern-release/v2' || !acceptsCandidate(manifest,{client,allowCandidate,explicitLocalRelease,systemManifest}) ||
      compare(manifest.versions?.tavern,manifest.versions?.tavern)!==0 || publicationTag(manifest) !== (core?.tag||release.tag_name) || !/^[a-f0-9]{40}$/.test(manifest.commit || '') ||
      manifest.bootstrap?.managedComponents !== 1 || !/^[a-f0-9]{64}$/.test(manifest.bootstrap.sha256 || '')) {
    throw launcherError('目标发布尚不支持启动器组件更新，未修改当前安装。',
      {userCode:'RELEASE_COMPATIBILITY',source:'release_service',site:'release.verify'});
  }
  validateCapabilities(manifest,{client,updaterCapabilities});
  const minimum = manifest.bootstrap.minimumLauncherVersion || '1.0.0';
  if(!core)validateAssetRelease(manifest,release,minimum);
  coreReference(manifest,platform,arch);
  if (!updaterClient({client})&&(compare(launcherVersion, minimum) === null || compare(launcherVersion, minimum) < 0))
    throw launcherError(`请先升级启动器到 ${minimum} 或更新版本。`,
      {userCode:'RELEASE_COMPATIBILITY',source:'release_service',site:'release.verify'});
  if(systemManifest) {
    validateSystem(systemManifest,release,platform,arch,launcherVersion,channel,{client,updaterCapabilities,allowCandidate,explicitLocalRelease});
    if((core?.commit||systemManifest.commit)!==manifest.commit || compare(systemManifest.version,manifest.versions.tavern)!==0)
      throw new Error('完整系统与组件清单不是同一次发布。');
  }
  for (const item of [...Object.values(manifest.archives || {}),...Object.values(manifest.modules || {})]) {
    if(!item.name) continue;
    if(!systemManifest) {validateAssetIntegrity(release,item.name,item);continue;}
    // A complete installation consumes system.files, whose logical filenames
    // map to platform-specific physical assets. Other component-update modules
    // are not consumed by this flow and remain governed by the root update plan.
    const installed=systemManifest.files[item.name];
    if(!installed) continue;
    if(installed.sha256!==item.sha256 || item.size!==undefined && installed.size!==item.size)
      throw new Error('完整安装档案与系统实体校验信息不一致。');
    validateAssetIntegrity(release,installed.asset,installed);
  }
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
    ...(release.assetIndexText !== undefined ? {assetIndexText:release.assetIndexText} : {}),
    assets:release.assets.map(item=>({name:item.name,browser_download_url:item.browser_download_url,
      ...(item.state!==undefined?{state:item.state}:{}),...(item.digest!==undefined?{digest:item.digest}:{}),
      ...(item.asset_release_tag ? {asset_release_tag:item.asset_release_tag} : {}),
      ...(Number.isSafeInteger(item.size)?{size:item.size}:{})}))};
}
function fixedPlanSourceEvidence(fixed){
  return {url:releaseManifestAsset(fixed.release,{mode:fixed.mode,systemManifest:fixed.systemManifest,platform:fixed.platform,arch:fixed.arch}),
    sha256:bytesHash(fixed.releaseManifestText),size:Buffer.byteLength(fixed.releaseManifestText)};
}
function planDigest(plan) {
  if(plan.schema!=='nora-release-plan/1'){const {planId,...content}=plan;return bytesHash(canonical(content));}
  const bytes=typeof plan.releaseManifestText==='string'?Buffer.from(plan.releaseManifestText):null;
  const content={schema:plan.schema,mode:plan.mode,tag:plan.tag,channel:plan.channel,platform:plan.platform,arch:plan.arch,
    ...(plan.client!==undefined?{client:plan.client}:{}),
    ...(plan.candidateAcceptance!==undefined?{candidateAcceptance:plan.candidateAcceptance}:{}),
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
  if(!updaterClient(options)&&typeof options.launcherVersion!=='string')throw new TypeError('The current launcherVersion is required to seal a plan');
  assertOwner();
  const checked=validatePlan(plan,{platform:plan.platform,arch:plan.arch,channel:plan.channel,...options,operationDirectory,
    launcherVersion:options.launcherVersion});
  const bytes=Buffer.from(checked.releaseManifestText);
  if(bytes.length>MAX_MANIFEST_BYTES)throw new Error('固定发布清单超过受支持的读取预算。');
  const contract={schema:checked.schema,mode:checked.mode,tag:checked.tag,channel:checked.channel,platform:checked.platform,arch:checked.arch,
    ...(checked.client!==undefined?{client:checked.client}:{}),
    ...(checked.candidateAcceptance!==undefined?{candidateAcceptance:checked.candidateAcceptance}:{}),
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
function validatePlan(plan, {launcherVersion,platform = process.platform,arch = process.arch,channel = 'stable',tag,mode,operationDirectory,client,updaterCapabilities,allowCandidate,explicitLocalRelease} = {}) {
  const updater=updaterClient({client});
  if(plan?.manifestRef){
    try{
      const text=readManifestArtifact(plan,{operationDirectory}),manifest=JSON.parse(text);
      if(plan.version!==manifest.versions?.tavern||plan.commit!==manifest.commit)throw new Error('固定发布清单摘要与封存原文不符。');
      plan={...plan,releaseManifestText:text,releaseManifest:manifest};
    }catch(error){throw launcherError('固定发布计划或清单无法核验。原操作目标、安装和备份已保留，请查看日志并通过新版启动器重新检查。',
      {userCode:'RELEASE_COMPATIBILITY',source:'release_service',site:'release.verify'},error);}
  }
  if (!plan || plan.schema !== 'nora-release-plan/1' || plan.planId !== planDigest(plan)
    || (plan.client==='updater')!==updater || plan.client!==undefined&&plan.client!=='updater' || updater&&plan.launcherManifest
    || plan.platform !== platform || plan.arch !== arch || plan.channel !== channel || (tag && plan.tag !== tag)
    || !['update','install'].includes(plan.mode) || (mode && plan.mode !== mode) || plan.tag !== plan.release?.tag_name || !accepts(plan.release,channel)
    || !Number.isFinite(Date.parse(plan.checkedAt))) throw new Error('固定发布计划无效或与当前目标不符，未修改当前安装。');
  const parsed = JSON.parse(plan.releaseManifestText);
  if (canonical(parsed) !== canonical(plan.releaseManifest) || plan.commit!==plan.releaseManifest.commit
    ||plan.version!==undefined&&plan.version!==parsed.versions?.tavern) throw new Error('固定发布清单与保存的原文不符。');
  const candidate=plan.releaseManifest.candidate===true||plan.systemManifest?.candidate===true;
  if(candidate!==Boolean(plan.candidateAcceptance)||candidate
    &&canonical(plan.candidateAcceptance)!==canonical(candidateAcceptance({client,allowCandidate,explicitLocalRelease})))
    throw new Error('固定候选计划与本地验收授权不一致。');
  releaseManifestAsset(plan.release,{mode:plan.mode,systemManifest:plan.systemManifest,platform,arch});
  if(plan.launcherManifest) require('./launcher-update').validateManifest(plan.launcherManifest,
    {release:plan.release,manifest:plan.releaseManifest,platform,arch});
  if(!updater&&compare(launcherVersion,plan.releaseManifest.launcherVersion)===-1 && !plan.launcherManifest) throw new Error('固定计划缺少所需启动器的校验信息。');
  validateUpdate(plan.releaseManifest,plan.release,plan.launcherManifest?.version || launcherVersion,
    {client,updaterCapabilities,allowCandidate,explicitLocalRelease,...(plan.mode==='install' ? {systemManifest:plan.systemManifest,platform,arch,channel} : {})});
  if(plan.mode==='install' && !plan.systemManifest) throw new Error('完整安装计划缺少系统清单。');
  if (plan.systemManifest) {
    if((coreReference(plan.systemManifest,platform,arch)?.commit||plan.systemManifest.commit)!==plan.commit) throw new Error('完整系统与组件清单不是同一次发布。');
    validateSystem(plan.systemManifest,plan.release,platform,arch,plan.launcherManifest?.version || launcherVersion,channel,{client,updaterCapabilities,allowCandidate,explicitLocalRelease});
    validateInstallManifestText(plan.releaseManifestText,plan.systemManifest);
  }
  return freezePlan(JSON.parse(JSON.stringify(plan)));
}
async function selectPlan(options) { return selectPlanWithMetadata(options); }
async function selectPlanWithMetadata({fetcher = fetch,signal,launcherVersion,platform = process.platform,arch = process.arch,channel = 'stable',tag,mode = 'update',selectedRelease,releaseEvidence,metadataCache,networkPolicy,client,updaterCapabilities,allowCandidate,explicitLocalRelease}, knownMetadata) {
  const updater=updaterClient({client});
  networkPolicy={...operationNetworkPolicy(networkPolicy),deadlineAt:networkPolicy?.deadlineAt ?? (networkPolicy?.now || Date.now)()+(networkPolicy?.totalBudgetMs ?? 100000)};
  const lookup=releaseEvidence || (selectedRelease ? {release:selectedRelease,checkedAt:new Date().toISOString(),source:'selected',latestConfirmed:false}
    : await latest(fetcher,signal,channel,tag,{metadataCache,networkPolicy,withEvidence:true}));
  const release = lookup.release;
  if (!accepts(release,channel) || (tag && release.tag_name !== tag)) throw new Error('所选发布与目标渠道不符。');
  if (!['update','install'].includes(mode)) throw new Error('固定发布计划的操作类型无效。');
  networkPolicy.sourceContext.bindTarget(release.tag_name);
  const systemManifest=mode==='install' ? await requestJson(assetUrl(release,`nora-system-${platform}-${arch}.json`),fetcher,signal,
    {metadataCache,networkPolicy,channel,conditionIdentity:{expectedSystemVersion:release.tag_name}}) : null;
  // Validate identity and routing before reading the payload. The launcher gate
  // is checked after inspecting the same target's possible launcher handoff.
  if(systemManifest) validateSystemDescriptor(systemManifest,release,platform,arch,channel,{client,updaterCapabilities,allowCandidate,explicitLocalRelease});
  const descriptor=systemManifest?.files['release-manifest.json'];
  const metadata = knownMetadata || await requestJson(releaseManifestAsset(release,{mode,systemManifest,platform,arch}),fetcher,signal,
    {withEvidence:true,metadataCache,networkPolicy,channel,...(descriptor ? {conditionIdentity:{sha256:descriptor.sha256,size:descriptor.size}} : {})});
  if(systemManifest) validateInstallManifestText(metadata.body,systemManifest);
  validateCapabilities(metadata.value,{client,updaterCapabilities});
  const launcherManifest = updater?null:await require('./launcher-update').inspect({release,manifest:metadata.value,launcherVersion,fetcher,signal,platform,arch,metadataCache,networkPolicy,channel});
  validateUpdate(metadata.value,release,launcherManifest?.version || launcherVersion,
    {client,updaterCapabilities,allowCandidate,explicitLocalRelease,...(systemManifest ? {systemManifest,platform,arch,channel} : {})});
  if(systemManifest) validateSystem(systemManifest,release,platform,arch,launcherManifest?.version || launcherVersion,channel,{client,updaterCapabilities,allowCandidate,explicitLocalRelease});
  const plan = {schema:'nora-release-plan/1',mode,tag:release.tag_name,channel,platform,arch,release:releaseSnapshot(release),
    ...(updater?{client:'updater'}:{}),
    ...(metadata.value.candidate===true||systemManifest?.candidate===true
      ?{candidateAcceptance:candidateAcceptance({client,allowCandidate,explicitLocalRelease})}:{}),
    commit:metadata.value.commit,releaseManifest:metadata.value,releaseManifestText:metadata.body,launcherManifest,systemManifest,
    checkedAt:lookup.checkedAt,metadataSource:lookup.source,latestConfirmed:lookup.latestConfirmed};
  plan.planId=planDigest(plan);
  return validatePlan(plan,{launcherVersion,platform,arch,channel,tag,mode,client,updaterCapabilities,allowCandidate,explicitLocalRelease});
}
async function check({ installRoot, launcherVersion, fetcher = fetch, platform, arch, channel = 'stable',metadataCache,networkPolicy,signal,client,updaterCapabilities,allowCandidate,explicitLocalRelease,launcherDiscovery=false }) {
  networkPolicy=operationNetworkPolicy(networkPolicy);
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
    let lookup = await latest(fetcher,signal,channel,undefined,{metadataCache,networkPolicy,withEvidence:true}),release=lookup.release;
    let system = null, compatibilityError = '', requestError = '', requestFailed = false, launcher = null, diagnosticError, releasePlan,launcherCheckError;
    try {
      releasePlan = await selectPlan({releaseEvidence:lookup,launcherVersion,fetcher,platform,arch,channel,metadataCache,networkPolicy,signal,client,updaterCapabilities,allowCandidate,explicitLocalRelease});
      launcher = releasePlan.launcherManifest;
      system = releasePlan.releaseManifest;
    }
    catch (error) {
      if (error.site === 'release.request') { requestFailed = true; requestError = error.message || '尚未取得有效的发布响应，请稍后重新检查。'; }
      else compatibilityError = error.message;
      diagnosticError = launcherError(error.message || '发布清单检查未通过。', {source:'release_service',site:error.site || 'release.verify'}, error);
    }
    // The GUI discovers its own APP independently. Missing APP metadata cannot
    // invalidate a content plan that the independent updater can execute.
    if(system&&updaterClient({client})&&launcherDiscovery){
      const now=networkPolicy.now || Date.now;
      const optionalPolicy={...networkPolicy,sourceContext:createReleaseSourceContext(),
        deadlineAt:Math.min(networkPolicy.deadlineAt,now()+Math.min(networkPolicy.attemptTimeoutMs ?? 30000,30000))};
      try{launcher=await require('./launcher-update').inspect({release,manifest:system,launcherVersion,
        fetcher,signal,platform,arch,metadataCache,networkPolicy:optionalPolicy,channel});}
      catch(error){if(signal?.aborted)throw error;launcherCheckError=error.message||'启动器更新检查未完成。';}
      try{
        const discovered=await discoverLauncherRelease(releasePlan,{fetcher,signal,metadataCache,networkPolicy:optionalPolicy,
          platform:releasePlan.platform,arch:releasePlan.arch});
        if(discovered){
          const selected=await selectPlanWithMetadata({releaseEvidence:discovered.lookup,launcherVersion,fetcher,
            platform,arch,channel,metadataCache,networkPolicy:optionalPolicy,signal,client,updaterCapabilities,allowCandidate,explicitLocalRelease},discovered.metadata);
          const found=await require('./launcher-update').inspect({release:selected.release,manifest:selected.releaseManifest,launcherVersion,
            fetcher,signal,platform,arch,metadataCache,networkPolicy:optionalPolicy,channel});
          releasePlan=selected;system=selected.releaseManifest;release=selected.release;launcher=found;
          lookup=discovered.lookup;launcherCheckError=undefined;
        }
      }catch(error){
        if(signal?.aborted)throw error;
        launcherCheckError='启动器更新检查未完成：'+(error.message||'请稍后重试。');
      }
    }
    const coreLatest=system?.versions?.tavern, comparison=compare(current,coreLatest);
    return { current, versionSource: installed.source, latest:coreLatest?`v${version(coreLatest)}`:null, releaseTag:release.tag_name, checkedAt: lookup.checkedAt, launcherVersion,
      metadataSource:lookup.source,latestConfirmed:lookup.latestConfirmed,retryAt:retryAt(diagnosticError),...(releasePlan ? {releasePlan} : {}),
      releaseUrl: `https://github.com/${REPO}/releases/tag/${release.tag_name}`,
      updateSupported: Boolean(system), channel,
      launcherLatest: system?.launcherVersion || null, launcherUpdateAvailable:Boolean(launcher),...(launcherCheckError?{launcherError:launcherCheckError}:{}),
      state: requestFailed ? 'unavailable' : !system ? 'blocked' : comparison === null ? 'unknown' : comparison < 0 || launcher ? 'available' : launcherCheckError ? 'unavailable' : comparison > 0 ? 'ahead' : 'current',
      releaseAvailable: comparison !== null && comparison < 0,
      available: comparison !== null && (comparison < 0 || Boolean(launcher)) && Boolean(system), installable: Boolean(system), compatibilityError, ...(requestFailed ? {error:requestError} : {}), ...(diagnosticError ? {diagnosticError} : {}) };
  } catch (error) {
    return { current, latest: null, checkedAt:null,metadataSource:'unavailable',latestConfirmed:false,retryAt:retryAt(error),launcherVersion, state: 'unavailable', available: false, installable: false, error: error.message,
      diagnosticError:launcherError(error.message || '检查更新未完成。', {source:'release_service',site:error.site || 'release.check'}, error) };
  }
}
async function prepareUpdate({ cacheRoot, launcherVersion, fetcher = fetch, signal, onEvent = () => {},
  channel = 'stable', tag, plan, selectedPlan, operationDirectory,platform = process.platform, arch = process.arch,metadataCache,networkPolicy,client,updaterCapabilities,allowCandidate,explicitLocalRelease }) {
  networkPolicy=operationNetworkPolicy(networkPolicy);
  onEvent({ event: 'task', stage_id: 'release_check', task: '检查更新清单' });
  const fixed = selectedPlan ? validatePlan(selectedPlan,{launcherVersion,platform,arch,channel,tag,operationDirectory,client,updaterCapabilities,allowCandidate,explicitLocalRelease})
    : await selectPlan({fetcher,signal,launcherVersion,platform,arch,channel,tag,metadataCache,networkPolicy,client,updaterCapabilities,allowCandidate,explicitLocalRelease});
  networkPolicy.sourceContext.bindTarget(fixed.tag);
  const release = await resolvePlanAssets(fixed,{fetcher,signal,metadataCache,networkPolicy,onEvent,client,updaterCapabilities,allowCandidate,explicitLocalRelease});
  const manifest = validateUpdate(fixed.releaseManifest,release,launcherVersion,{client,updaterCapabilities,allowCandidate,explicitLocalRelease});
  if(coreReference(manifest,platform,arch)){
    // Reuse the complete-system resolver. It authenticates the platform's
    // original core bytes instead of installing the publication's APP runner.
    return prepare({cacheRoot,launcherVersion,fetcher,signal,onEvent,channel,tag:fixed.tag,
      platform,arch,selectedRelease:release,metadataCache,networkPolicy,client,updaterCapabilities,allowCandidate,explicitLocalRelease});
  }
  const root = path.join(cacheRoot, `components-${release.tag_name}-${manifest.commit.slice(0, 12)}`);
  fs.mkdirSync(root, { recursive: true });
  const download = async (name, expected) => {
    fileName(name);
    signal?.throwIfAborted();
    const target = path.join(root, name);
    onEvent({ event: 'task', stage_id: 'verify', task: `校验缓存：${name}` });
    const size=release.assets.find(item=>item.name===name)?.size;
    await downloadAsset({url:assetUrl(release,name),target,identity:{tag:release.tag_name,asset:name,sha256:expected,...(size ? {size}: {})},
      fetcher,signal,onEvent,policy:networkPolicy,fixedPlanSourceEvidence:fixedPlanSourceEvidence(fixed),task:`准备 ${release.tag_name}：${name}`,maxSize:expected ? 2*1024**3 : 4*1024*1024});
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
  const verified = validateUpdate(readJson(path.join(root, 'release-manifest.json')), release, launcherVersion,{client,updaterCapabilities,allowCandidate,explicitLocalRelease});
  if (verified.commit !== manifest.commit || verified.bootstrap.sha256 !== manifest.bootstrap.sha256) throw new Error('下载过程中发布清单发生变化，请重新检查版本。');
  await download('tavern-updater-bootstrap.py', verified.bootstrap.sha256);
  const result = await plan(root);
  if (result.error) throw new Error(result.error);
  if (!Array.isArray(result.archives) || compare(result.version,manifest.versions.tavern) !== 0) throw new Error('更新器返回的下载计划无效。');
  onEvent({ event: 'task', task: `更新器已确认 ${result.archives.length} 个待下载模块` });
  for (const item of result.archives) {
    fileName(item.name);
    if (!/^[a-f0-9]{64}$/.test(item.sha256 || '') || sums.get(item.name) !== item.sha256) throw new Error('更新模块与发布校验清单不一致。');
    const descriptor=[...Object.values(manifest.archives || {}),...Object.values(manifest.modules || {})].find(value=>value.name===item.name);
    if(release.assets.find(value=>value.name===item.name)?.asset_release_tag) {
      if(!descriptor || descriptor.sha256!==item.sha256) throw new Error('共享下载不属于原固定发布清单。');
      validateAssetIntegrity(release,item.name,descriptor);
    }
    await download(item.name, item.sha256);
  }
  return root;
}
async function prepare({ cacheRoot, bundledRoot, launcherVersion, platform = process.platform, arch = process.arch,
  fetcher = fetch, signal, onEvent = () => {}, channel = 'stable', tag, selectedRelease,selectedPlan,operationDirectory,metadataCache,networkPolicy,client,updaterCapabilities,allowCandidate,explicitLocalRelease }) {
  networkPolicy=operationNetworkPolicy(networkPolicy);
  onEvent({ event: 'task', stage_id: 'release_check', task: `确认 GitHub ${channel === 'beta' ? 'Beta 测试' : '正式'}完整版本` });
  signal?.throwIfAborted();
  const fixed=selectedPlan ? validatePlan(selectedPlan,{launcherVersion,platform,arch,channel,tag,mode:'install',operationDirectory,client,updaterCapabilities,allowCandidate,explicitLocalRelease}) : null;
  const release = fixed ? await resolvePlanAssets(fixed,{fetcher,signal,metadataCache,networkPolicy,onEvent,client,updaterCapabilities,allowCandidate,explicitLocalRelease})
    : selectedRelease || await latest(fetcher, signal, channel, tag,{metadataCache,networkPolicy});
  if (!accepts(release, channel) || tag && release.tag_name!==tag) throw new Error('所选发布与安装渠道或固定目标不符。');
  networkPolicy.sourceContext.bindTarget(release.tag_name);
  const system = fixed?.systemManifest || await systemFor(release, { platform, arch, launcherVersion, fetcher, signal, channel,metadataCache,networkPolicy,client,updaterCapabilities,allowCandidate,explicitLocalRelease });
  if(!system) throw new Error('完整安装计划缺少系统清单。');
  validateSystem(system,release,platform,arch,launcherVersion,channel,{client,updaterCapabilities,allowCandidate,explicitLocalRelease});
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
      fetcher,signal,policy:networkPolicy,...(fixed?{fixedPlanSourceEvidence:fixedPlanSourceEvidence(fixed)}:{}),task:`下载：${name}`,onEvent:event=>onEvent({...event,...(event.event==='progress'?{ratio:event.total ? event.current/event.total:0}:{})})});
  }
  validatePayload(root, system, platform, arch,{client,updaterCapabilities,allowCandidate,explicitLocalRelease});
  fs.writeFileSync(path.join(root, 'nora-system.json'), JSON.stringify(system, null, 2), { mode: 0o600 });
  return root;
}

async function prepareInstall(options) {
  options={...options,networkPolicy:operationNetworkPolicy(options.networkPolicy)};
  const { fetcher = fetch, signal, channel = 'stable', onEvent = () => {}, onPlan = () => {}, confirmBundled } = options;
  signal?.throwIfAborted();
  if(options.selectedPlan) {
    const plan=validatePlan(options.selectedPlan,{...options,mode:'install'});
    options.networkPolicy.sourceContext.bindTarget(plan.tag);
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
    const localPlan={schema:'nora-bundled-plan/1',mode:'install',tag:publicationTag(system),
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
function validatePayload(root, system, platform, arch,options={}) {
  const payload = readJson(path.join(root, 'release-manifest.json'));
  validateCapabilities(payload,options);
  const runtime = readJson(path.join(root, 'nora-hermes-runtime.json'));
  const dependencies = readJson(path.join(root, 'nora-tavern-dependencies.json'));
  const core=coreReference(system,platform,arch);
  validateCoreManifestText(fs.readFileSync(path.join(root,'release-manifest.json'),'utf8'),system);
  if (!acceptsCandidate(payload,{...options,systemManifest:system}) || payload.commit !== (core?.commit||system.commit) || compare(payload.versions?.tavern, system.version) !== 0 || publicationTag(payload)!==(core?.tag||publicationTag(system)) ||
      !system.files[runtime.archive] || !system.files[dependencies.archive] ||
      runtime.sha256 !== system.files[runtime.archive].sha256 || dependencies.sha256 !== system.files[dependencies.archive].sha256 ||
      runtime.platform !== platform || runtime.arch !== arch || dependencies.platform !== platform || dependencies.arch !== arch) {
    throw new Error('完整系统包内部版本或运行环境不一致。');
  }
}

function bundledUpgradeTarget({ bundledRoot, currentVersion, launcherVersion, platform = process.platform,
  arch = process.arch, channel = 'stable',client,updaterCapabilities,allowCandidate,explicitLocalRelease }) {
  const system = readJson(path.join(bundledRoot, 'nora-system.json'));
  try { validateSystem(system, null, platform, arch, launcherVersion, channel,{client,updaterCapabilities,allowCandidate,explicitLocalRelease}); }
  catch { return null; }
  // This is only a target hint; the updater still verifies the selected release before any mutation.
  return compare(currentVersion, system.version) === -1 ? publicationTag(system) : null;
}
async function prepareBundled({ bundledRoot, launcherVersion, platform = process.platform, arch = process.arch,
  signal, onEvent = () => {}, channel = 'stable',client,updaterCapabilities,allowCandidate,explicitLocalRelease }) {
  const system = readJson(path.join(bundledRoot, 'nora-system.json'));
  validateSystem(system, null, platform, arch, launcherVersion, channel,{client,updaterCapabilities,allowCandidate,explicitLocalRelease});
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
  validatePayload(bundledRoot, system, platform, arch,{client,updaterCapabilities,allowCandidate,explicitLocalRelease});
  return bundledRoot;
}
module.exports = { compare, publicationTag, coreReference, coreIdentity, check, prepare, prepareInstall, prepareUpdate, prepareBundled, bundledUpgradeTarget, validateSystem,validateSystemDescriptor, validateUpdate,validateCapabilities, LAUNCHER_CAPABILITIES, UPDATER_CAPABILITIES, hash, latest, accepts, requestJson, assetUrl,validateAssetIndex,validateAssetReferences,validateAssetIntegrity,selectPlan,validatePlan,sealPlan,fixedPlanSourceEvidence,createMetadataCache };
