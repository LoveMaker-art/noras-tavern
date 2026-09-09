// Treat .asar as an ordinary file when removing an application bundle.
const fs = process.versions.electron ? require('original-fs') : require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const OWNER = 'nora-owner.json';
const RETAINED = 'nora-retained.json';
const PROGRAMS = ['hermes-agent', 'python', 'node', 'bin', '.local/bin', 'plugins/clawchat',
  'clawchat/liveware', 'nora-components.json', 'nora-clawchat-check.py', 'nora-installation.json',
  'nora-instance.json', 'gateway.pid', 'gateway.lock', 'gateway_state.json'];

function canonical(file) {
  const full = path.resolve(file);
  if (fs.existsSync(full)) return fs.realpathSync(full);
  const parent = path.dirname(full);
  return parent === full ? full : path.join(canonical(parent), path.basename(full));
}

function safeRoot(home) {
  if (fs.existsSync(home) && fs.lstatSync(home).isSymbolicLink()) throw new Error('隔离目录不能是符号链接。');
  const root = canonical(home), userHome = canonical(os.homedir());
  if (root === path.parse(root).root || root === userHome
    || userHome.startsWith(root + path.sep)) throw new Error('不能卸载用户目录或磁盘根目录。');
  return root;
}

function contained(root, relative) {
  const target = path.resolve(root, relative);
  if (target === root || !target.startsWith(root + path.sep)) throw new Error('卸载路径越过隔离目录。');
  let current = root;
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`卸载路径被链接重定向：${relative}`);
    }
  }
  return target;
}

function own(home) {
  const root = safeRoot(home);
  const file = contained(root, OWNER);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ schema: 1, id: crypto.randomUUID() }), { mode: 0o600, flag: 'wx' });
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value.schema !== 1 || typeof value.id !== 'string') throw new Error('安装目录归属记录无效。');
  return value.id;
}

function makePlan({ home, hermesHome, installRoot, mode, executable = process.execPath, appPath = null }) {
  if (!['keep', 'all'].includes(mode)) throw new Error('卸载方式无效。');
  const root = safeRoot(home);
  if (path.resolve(executable).startsWith(root + path.sep)) throw new Error('启动器位于数据目录内，请将启动器移到独立应用目录后重试。');
  const hermes = path.relative(root, canonical(hermesHome));
  const tavern = path.relative(root, canonical(installRoot));
  contained(root, hermes); contained(root, tavern);
  if (hermes === tavern || hermes.startsWith(tavern + path.sep) || tavern.startsWith(hermes + path.sep)) throw new Error('程序目录不能互相包含。');
  return { schema: 1, root, owner: own(root), hermes, tavern, mode, executable, appPath };
}

function validate(plan) {
  if (plan.schema !== 1 || !['keep', 'all'].includes(plan.mode)) throw new Error('卸载计划无效。');
  const root = safeRoot(plan.root);
  const owner = JSON.parse(fs.readFileSync(contained(root, OWNER), 'utf8'));
  if (owner.id !== plan.owner) throw new Error('安装目录已变化，已停止卸载。');
  contained(root, plan.hermes); contained(root, plan.tavern);
  return root;
}

function remove(file) {
  fs.rmSync(file, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
  if (fs.existsSync(file)) throw new Error(`未能删除：${file}`);
}

function cleanup(plan, onProgress = () => {}) {
  const root = validate(plan);
  // Resolve every top-level deletion before changing anything. Node rm does not
  // follow links inside a removed tree; redirected deletion roots are rejected.
  const relatives = plan.mode === 'all'
    ? fs.readdirSync(root).filter(name => name !== OWNER)
    : [...PROGRAMS.map(name => path.join(plan.hermes, name)),
      path.join(plan.tavern, 'apps'), path.join(plan.tavern, 'tavern-state/native-runtime'),
      path.join(plan.tavern, 'tavern-updates'), 'cache', 'launcher'];
  const targets = relatives.map(relative => contained(root, relative));
  if (plan.mode === 'keep') {
    const config = contained(root, path.join(plan.tavern, 'tavern-state/native-runtime/config.yaml'));
    const retainedConfig = contained(root, path.join(plan.tavern, 'tavern-state/nora-retained-config.yaml'));
    if (fs.existsSync(config)) fs.copyFileSync(config, retainedConfig);
    // This receipt enables a subsequent runtime extraction to merge retained data.
    fs.writeFileSync(contained(root, RETAINED), JSON.stringify({ schema: 1, hermes: plan.hermes }), { mode: 0o600 });
  }
  for (let index = 0; index < targets.length; index++) {
    onProgress({ stage: 'cleanup', current: index + 1, total: targets.length, path: targets[index] });
    remove(targets[index]);
  }
  if (plan.mode === 'all') {
    const ownerFile = path.join(root, OWNER), content = fs.readFileSync(ownerFile);
    remove(ownerFile);
    try { fs.rmdirSync(root); }
    catch (error) { fs.writeFileSync(ownerFile, content, { mode: 0o600 }); throw error; }
  }
}

function restoreRetained(noraHome, previous, current) {
  const receipt = path.join(noraHome, RETAINED);
  if (!fs.existsSync(receipt)) return false;
  const value = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  if (value.schema !== 1 || path.resolve(noraHome, value.hermes) !== path.resolve(current)) throw new Error('保留数据目录不匹配。');
  // Program folders were removed during uninstall. Only retained files are
  // overlaid; never replace fresh runtime binaries with an old backup.
  const excluded = PROGRAMS.map(name => name.split('/').join(path.sep));
  const copy = relative => {
    if (excluded.some(name => relative === name || relative.startsWith(name + path.sep))) return;
    const source = contained(path.resolve(previous), relative);
    const target = contained(path.resolve(current), relative);
    if (fs.statSync(source).isDirectory()) {
      fs.mkdirSync(target, { recursive: true });
      for (const entry of fs.readdirSync(source)) copy(path.join(relative, entry));
    } else fs.copyFileSync(source, target);
  };
  for (const entry of fs.readdirSync(previous)) copy(entry);
  return true;
}

async function worker(planFile, showMessage = notify) {
  const directory = path.dirname(planFile);
  const resultFile = path.join(directory, 'result.json');
  let plan;
  const report = value => fs.writeFileSync(resultFile, JSON.stringify(value), { mode: 0o600 });
  try {
    plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
    if (path.resolve(plan.executable) !== path.resolve(process.execPath)) throw new Error('卸载程序与应用不匹配。');
    if (plan.executable.startsWith(path.resolve(plan.root) + path.sep)) throw new Error('启动器不能位于数据目录内。');
    if (process.platform === 'darwin' && plan.appPath) {
      const expected = path.resolve(process.execPath, '../../..');
      if (plan.appPath !== expected || !expected.endsWith('.app') || fs.lstatSync(expected).isSymbolicLink()) throw new Error('应用目录校验失败。');
    }
    if (plan.parentPid) {
      const deadline = Date.now() + 60000;
      while (true) {
        try { process.kill(plan.parentPid, 0); }
        catch (error) { if (error.code === 'ESRCH') break; throw error; }
        if (Date.now() > deadline) throw new Error('启动器尚未退出，未删除文件。');
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    report({ state: 'running', stage: 'cleanup' });
    cleanup(plan, progress => { report({ state: 'running', ...progress }); process.stdout.write(`清理文件 ${progress.current}/${progress.total}\n`); });
    if (process.platform === 'darwin' && plan.appPath) {
      report({ state: 'running', stage: 'application' });
      remove(plan.appPath);
    }
    report({ state: 'complete', mode: plan.mode, retained: plan.mode === 'keep' ? plan.root : null });
    if (process.platform === 'darwin') showMessage(plan.mode === 'keep' ? '卸载完成。用户数据已保留，可在重装后继续使用。' : '卸载完成。本地程序和数据已清理。');
  } catch (error) {
    report({ state: 'error', error: error.message });
    if (process.platform === 'darwin') showMessage(`卸载未完成。请保留剩余文件并重试。详情：${resultFile}`);
    process.stderr.write(`卸载未完成：${error.message}\n`);
    process.exitCode = 1;
  }
}

function notify(message) {
  spawnSync('/usr/bin/osascript', ['-e', 'on run argv', '-e', 'display dialog (item 1 of argv) with title "诺拉·酒馆" buttons {"好"} default button "好"', '-e', 'end run', message], { timeout: 120000 });
}

module.exports = { own, makePlan, cleanup, restoreRetained, worker, RETAINED, PROGRAMS };
if (require.main === module) worker(process.argv[2]);
