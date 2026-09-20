const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const semver = require('semver');

const REPO = 'LoveMaker-art/noras-tavern';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
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
  return fs.existsSync(file) && await hash(file) === expected;
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
async function requestJson(url, fetcher, signal) {
  const response = await fetcher(url, { headers: { 'User-Agent': 'Nora-Tavern-Launcher', Accept: 'application/vnd.github+json' }, signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(20000)]) });
  if (!response.ok) throw new Error(`无法检查 GitHub 版本（HTTP ${response.status}）。`);
  const body = await response.text();
  if (body.length > 4 * 1024 * 1024) throw new Error('发布清单过大。');
  return JSON.parse(body);
}
function accepts(release, channel) {
  if (!['stable', 'beta'].includes(channel) || release.draft || !version(release.tag_name)) return false;
  const pre = semver.prerelease(release.tag_name);
  return channel === 'beta' ? release.prerelease === true && pre?.[0] === 'beta'
    : !release.prerelease && !pre;
}
async function latest(fetcher = fetch, signal, channel = 'stable', tag) {
  let release;
  if (tag) {
    if (!version(tag)) throw new Error('目标版本号无效。');
    release = await requestJson(`https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`, fetcher, signal);
  } else if (channel === 'beta') {
    const candidates = [];
    for (let page = 1; page <= 5; page++) {
      const rows = await requestJson(`https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`, fetcher, signal);
      if (!Array.isArray(rows)) throw new Error('测试发布列表无效。');
      candidates.push(...rows.filter(item => accepts(item, channel)));
      if (rows.length < 100) break;
    }
    release = candidates.sort((a, b) => compare(b.tag_name, a.tag_name))[0];
  } else release = await requestJson(API, fetcher, signal);
  if (!release || !accepts(release, channel)) throw new Error(channel === 'beta' ? '尚未发布可用的 Beta 测试版本。' : '没有找到有效的正式发布版本。');
  if (tag && release.tag_name !== tag) throw new Error('目标发布与所选版本不一致。');
  return release;
}
function validateSystem(manifest, release, platform, arch, launcherVersion, channel = 'stable') {
  if (manifest.schema !== 'nora-system/v1' || manifest.candidate || manifest.platform !== platform || manifest.arch !== arch ||
      (manifest.channel || 'stable') !== channel ||
      compare(manifest.version, release ? release.tag_name : manifest.version) !== 0 || !/^[a-f0-9]{40}$/.test(manifest.commit || '')) throw new Error('完整系统发布清单与目标版本或平台不符。');
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
async function systemFor(release, { platform = process.platform, arch = process.arch, launcherVersion, fetcher = fetch, signal, channel = 'stable' }) {
  const name = `nora-system-${platform}-${arch}.json`;
  const manifest = await requestJson(assetUrl(release, name), fetcher, signal);
  return validateSystem(manifest, release, platform, arch, launcherVersion, channel);
}
function validateUpdate(manifest, release, launcherVersion) {
  if (manifest.schema !== 'tavern-release/v2' || manifest.candidate ||
      compare(manifest.versions?.tavern, release.tag_name) !== 0 || !/^[a-f0-9]{40}$/.test(manifest.commit || '') ||
      manifest.bootstrap?.managedComponents !== 1 || !/^[a-f0-9]{64}$/.test(manifest.bootstrap.sha256 || '')) {
    throw new Error('目标发布尚不支持启动器组件更新，未修改当前安装。');
  }
  const minimum = manifest.bootstrap.minimumLauncherVersion || '1.0.0';
  if (compare(launcherVersion, minimum) === null || compare(launcherVersion, minimum) < 0) throw new Error(`请先升级启动器到 ${minimum} 或更新版本。`);
  return manifest;
}
async function check({ installRoot, launcherVersion, fetcher = fetch, platform, arch, channel = 'stable' }) {
  const installed = installedVersion(installRoot);
  const current = installed.version;
  try {
    const release = await latest(fetcher, undefined, channel);
    const comparison = compare(current, release.tag_name);
    let system = null, compatibilityError = '', launcher = null;
    try {
      const manifest = await requestJson(assetUrl(release, 'release-manifest.json'), fetcher);
      launcher = await require('./launcher-update').inspect({ release, manifest, launcherVersion, fetcher, platform, arch });
      system = validateUpdate(manifest, release, launcher?.version || launcherVersion);
    }
    catch (error) { compatibilityError = error.message; }
    return { current, versionSource: installed.source, latest: release.tag_name, checkedAt: new Date().toISOString(), launcherVersion,
      releaseUrl: `https://github.com/${REPO}/releases/tag/${release.tag_name}`,
      updateSupported: Boolean(system), channel,
      launcherLatest: system?.launcherVersion || null, launcherUpdateAvailable: system ? compare(launcherVersion, system.launcherVersion) === -1 : false,
      state: !system ? 'blocked' : comparison === null ? 'unknown' : comparison < 0 || launcher ? 'available' : comparison > 0 ? 'ahead' : 'current',
      releaseAvailable: comparison !== null && comparison < 0,
      available: comparison !== null && (comparison < 0 || Boolean(launcher)) && Boolean(system), installable: Boolean(system), compatibilityError };
  } catch (error) {
    return { current, latest: null, launcherVersion, state: 'unavailable', available: false, installable: false, error: error.message };
  }
}
async function prepareUpdate({ cacheRoot, launcherVersion, fetcher = fetch, signal, onEvent = () => {},
  channel = 'stable', tag, plan }) {
  const release = await latest(fetcher, signal, channel, tag);
  const manifest = validateUpdate(await requestJson(assetUrl(release, 'release-manifest.json'), fetcher, signal), release, launcherVersion);
  const root = path.join(cacheRoot, `components-${release.tag_name}-${manifest.commit.slice(0, 12)}`);
  fs.mkdirSync(root, { recursive: true });
  const download = async (name, expected) => {
    fileName(name);
    signal?.throwIfAborted();
    const target = path.join(root, name);
    if (expected && await matches(target, expected)) return;
    const partial = `${target}.partial`;
    onEvent({ event: 'task', task: `准备 ${release.tag_name}：${name}` });
    try {
      const downloadSignal = AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(30 * 60 * 1000)]);
      const response = await fetcher(assetUrl(release, name), { signal: downloadSignal });
      if (!response.ok || !response.body) throw new Error(`下载失败：${name}（HTTP ${response.status}）`);
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partial, { mode: 0o600 }), { signal: downloadSignal });
      if (expected && !await matches(partial, expected)) throw new Error(`组件校验失败：${name}`);
      fs.renameSync(partial, target);
    } finally { fs.rmSync(partial, { force: true }); }
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
  await download('release-manifest.json', sums.get('release-manifest.json'));
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
  fetcher = fetch, signal, onEvent = () => {}, channel = 'stable', tag }) {
  onEvent({ event: 'task', task: `确认 GitHub ${channel === 'beta' ? 'Beta 测试' : '正式'}完整版本` });
  const release = await latest(fetcher, signal, channel, tag);
  const system = await systemFor(release, { platform, arch, launcherVersion, fetcher, signal, channel });
  const root = path.join(cacheRoot, `${release.tag_name}-${platform}-${arch}-${system.commit.slice(0, 12)}`);
  fs.mkdirSync(root, { recursive: true });
  for (const [name, item] of Object.entries(system.files)) {
    signal?.throwIfAborted();
    const target = path.join(root, name);
    onEvent({ event: 'task', task: `准备 ${release.tag_name}：${name}` });
    if (await matches(target, item.sha256)) continue;
    const partial = `${target}.partial`;
    try {
      const local = path.join(bundledRoot, name);
      if (await matches(local, item.sha256)) fs.copyFileSync(local, partial);
      else {
        const downloadSignal = AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(30 * 60 * 1000)]);
        const response = await fetcher(assetUrl(release, item.asset), { signal: downloadSignal });
        if (!response.ok || !response.body) throw new Error(`组件下载失败：${name}（HTTP ${response.status}）。`);
        let current = 0;
        const input = Readable.fromWeb(response.body);
        input.on('data', chunk => {
          current += chunk.length;
          if (current > item.size) input.destroy(new Error(`组件大小与发布清单不符：${name}`));
          onEvent({ event: 'progress', current, total: item.size, ratio: current / item.size });
        });
        await pipeline(input, fs.createWriteStream(partial, { mode: 0o600 }), { signal: downloadSignal });
      }
      if (fs.statSync(partial).size !== item.size || !await matches(partial, item.sha256)) throw new Error(`组件校验失败：${name}`);
      fs.renameSync(partial, target);
    } finally { fs.rmSync(partial, { force: true }); }
  }
  validatePayload(root, system, platform, arch);
  fs.writeFileSync(path.join(root, 'nora-system.json'), JSON.stringify(system, null, 2), { mode: 0o600 });
  return root;
}
function validatePayload(root, system, platform, arch) {
  const payload = readJson(path.join(root, 'release-manifest.json'));
  const runtime = readJson(path.join(root, 'nora-hermes-runtime.json'));
  const dependencies = readJson(path.join(root, 'nora-tavern-dependencies.json'));
  if (payload.candidate || payload.commit !== system.commit || compare(payload.versions?.tavern, system.version) !== 0 ||
      !system.files[runtime.archive] || !system.files[dependencies.archive] ||
      runtime.sha256 !== system.files[runtime.archive].sha256 || dependencies.sha256 !== system.files[dependencies.archive].sha256 ||
      runtime.platform !== platform || runtime.arch !== arch || dependencies.platform !== platform || dependencies.arch !== arch) {
    throw new Error('完整系统包内部版本或运行环境不一致。');
  }
}

async function prepareBundled({ bundledRoot, launcherVersion, platform = process.platform, arch = process.arch,
  signal, onEvent = () => {}, channel = 'stable' }) {
  const system = readJson(path.join(bundledRoot, 'nora-system.json'));
  validateSystem(system, null, platform, arch, launcherVersion, channel);
  for (const [name, item] of Object.entries(system.files)) {
    signal?.throwIfAborted();
    onEvent({ event: 'task', task: `校验包内 ${system.version}：${name}` });
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
module.exports = { compare, check, prepare, prepareUpdate, prepareBundled, validateSystem, validateUpdate, hash, latest, accepts, requestJson, assetUrl };
