const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawn } = require('node:child_process');
const releases = () => require('./releases');

async function inspect({ release, manifest, launcherVersion, fetcher, signal, platform = process.platform, arch = process.arch }) {
  const r = releases();
  if (manifest.launcherVersion !== undefined && r.compare(manifest.launcherVersion, manifest.launcherVersion) !== 0) throw new Error('发布中的启动器版本无效。');
  if (r.compare(launcherVersion, manifest.launcherVersion) !== -1) return null;
  if (!['darwin-arm64', 'darwin-x64', 'win32-x64'].includes(`${platform}-${arch}`)) throw new Error('此系统暂不支持自动替换启动器。');
  const item = await r.requestJson(r.assetUrl(release, `nora-launcher-${platform}-${arch}.json`), fetcher, signal);
  if (item.schema !== 'nora-launcher/v1' || item.candidate || item.platform !== platform || item.arch !== arch
    || item.version !== manifest.launcherVersion || !/^[a-f0-9]{64}$/.test(item.sha256 || '')
    || !Number.isSafeInteger(item.size) || item.size < 1 || item.size > 2 * 1024 ** 3
    || !/^Nora-Tavern-Launcher-[\w.-]+-update\.zip$/.test(item.asset || '')) throw new Error('启动器更新清单无效，当前安装未修改。');
  r.assetUrl(release, item.asset);
  return item;
}

async function prepare(options) {
  const r = releases();
  const release = await r.latest(options.fetcher, options.signal, options.channel, options.tag);
  const manifest = await r.requestJson(r.assetUrl(release, 'release-manifest.json'), options.fetcher, options.signal);
  const item = await inspect({ ...options, release, manifest });
  r.validateUpdate(manifest, release, item?.version || options.launcherVersion);
  if (!item) return { tag: release.tag_name, manifest, launcher: null };
  const root = path.join(options.cacheRoot, 'launcher-' + item.sha256.slice(0, 16));
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const archive = path.join(root, item.asset);
  if (!fs.existsSync(archive) || await r.hash(archive) !== item.sha256) {
    options.onEvent?.({ event: 'task', task: '正在下载更新' });
    const partial = archive + '.partial';
    try {
      const signal = AbortSignal.any([options.signal || new AbortController().signal, AbortSignal.timeout(1800000)]);
      const response = await options.fetcher(r.assetUrl(release, item.asset), { signal });
      if (!response.ok || !response.body) throw new Error(`启动器下载失败（HTTP ${response.status}）`);
      let size = 0;
      const stream = Readable.fromWeb(response.body);
      stream.on('data', chunk => { size += chunk.length; if (size > item.size) stream.destroy(new Error('更新文件超出声明大小')); });
      await pipeline(stream, fs.createWriteStream(partial, { mode: 0o600 }), { signal });
      if (size !== item.size || await r.hash(partial) !== item.sha256) throw new Error('启动器更新校验失败，当前安装未修改。');
      fs.renameSync(partial, archive);
    } finally { fs.rmSync(partial, { force: true }); }
  }
  return { tag: release.tag_name, manifest, launcher: { ...item, archive } };
}

function applicationRoot(executable, platform = process.platform) {
  return platform === 'darwin' ? path.resolve(executable, '../../..') : path.dirname(executable);
}
async function handoff({ prepared, home, executable, python, helper, localRelease, skillId, onEvent = () => {} }) {
  if (process.env.PORTABLE_EXECUTABLE_FILE) {
    throw new Error('Windows 便携版不能原位替换临时运行目录。请使用安装版覆盖升级；现有数据不会被删除。');
  }
  const root = applicationRoot(executable);
  if (root === path.parse(root).root || home === root || home.startsWith(root + path.sep)) throw new Error('应用与用户数据必须位于不同目录。');
  fs.accessSync(path.dirname(root), fs.constants.W_OK);
  const jobs = path.join(home, 'installer', 'launcher-update');
  fs.mkdirSync(jobs, { recursive: true, mode: 0o700 });
  const job = fs.mkdtempSync(path.join(jobs, 'job-'));
  const plan = { schema: 1, token: crypto.randomUUID(), parentPid: process.pid, home,
    appRoot: root, executable: path.relative(root, executable), platform: process.platform,
    target: prepared.tag, version: prepared.launcher.version, arch: prepared.launcher.arch, sha256: prepared.launcher.sha256,
    archive: prepared.launcher.archive, localRelease: localRelease || null, skillId: skillId || null };
  fs.writeFileSync(path.join(job, 'plan.json'), JSON.stringify(plan), { mode: 0o600, flag: 'wx' });
  fs.copyFileSync(helper, path.join(job, 'replace.py'));
  const log = fs.openSync(path.join(job, 'replace.log'), 'a', 0o600);
  const child = spawn(python, ['-B', path.join(job, 'replace.py'), job], {
    cwd: job, detached: true, windowsHide: true, stdio: ['ignore', log, log],
  });
  fs.closeSync(log);
  const failed = new Promise((_, reject) => child.once('error', reject));
  child.unref();
  const ready = (async () => {
    for (let i = 0; i < 1200; i++) {
      const stateFile = path.join(job, 'status.json');
      if (fs.existsSync(stateFile)) {
        const state = JSON.parse(fs.readFileSync(stateFile));
        if (state.status === 'prepared') return job;
        if (state.status === 'error') throw new Error(state.error);
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    fs.writeFileSync(path.join(job, 'cancel'), 'cancel');
    throw new Error('准备更新超时，旧启动器未退出，请查看更新日志。');
  })();
  onEvent({ event: 'task', task: '正在校验更新，完成后将自动重启并继续' });
  return Promise.race([ready, failed]);
}

function resume(job, { home, executable, version }) {
  const jobs = path.join(home, 'installer', 'launcher-update');
  if (!job || path.dirname(path.resolve(job)) !== path.resolve(jobs) || !/^job-[\w-]+$/.test(path.basename(job))) return null;
  const plan = JSON.parse(fs.readFileSync(path.join(job, 'plan.json')));
  if (plan.schema !== 1 || plan.home !== home || plan.version !== version
    || path.resolve(plan.appRoot, plan.executable) !== executable) throw new Error('更新恢复信息不匹配。');
  fs.writeFileSync(path.join(job, 'ready.tmp'), JSON.stringify({ token: plan.token, version }), { mode: 0o600 });
  fs.renameSync(path.join(job, 'ready.tmp'), path.join(job, 'ready.json'));
  const marker = path.join(job, 'resume-started');
  try { fs.writeFileSync(marker, '', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') return null; throw error; }
  return plan;
}
module.exports = { inspect, prepare, handoff, resume, applicationRoot };
