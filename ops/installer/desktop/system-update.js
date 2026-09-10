const fs = require('node:fs');
const path = require('node:path');
const fsp = fs.promises;

const NAMES = ['hermes', 'tavern'];
function locations(home) {
  const root = path.resolve(home);
  const directory = path.join(root, 'installer', 'system-update');
  for (const relative of ['installer', 'installer/system-update', ...NAMES]) {
    const target = path.join(root, relative);
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('更新目录不能是符号链接。');
  }
  return { root, directory, journal: path.join(directory, 'journal.json') };
}
function read(home) {
  const { journal } = locations(home);
  if (!fs.existsSync(journal)) return null;
  const value = JSON.parse(fs.readFileSync(journal, 'utf8'));
  if (value.schema !== 1 || !['snapshot', 'applying', 'committed', 'rolled-back'].includes(value.phase)) {
    throw new Error('更新恢复记录无效，已保留文件，请勿删除备份。');
  }
  return value;
}
async function save(home, value) {
  const { directory, journal } = locations(home);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${journal}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify({ schema: 1, ...value }), { mode: 0o600 });
  await fsp.rename(temporary, journal);
}
function pending(home) {
  const state = read(home);
  return state && !['committed', 'rolled-back'].includes(state.phase);
}
async function recover(home, stop) {
  if (!pending(home)) return false;
  await stop();
  const { root, directory } = locations(home);
  for (const name of NAMES) {
    const backup = path.join(directory, name);
    if (!fs.existsSync(backup)) continue;
    if (fs.lstatSync(backup).isSymbolicLink()) throw new Error('回滚备份不是有效目录。');
    await fsp.rm(path.join(root, name), { recursive: true, force: true });
    await fsp.rename(backup, path.join(root, name));
  }
  await save(home, { phase: 'rolled-back' });
  return true;
}
async function perform({ home, target, stop, apply, verify, onEvent = () => {} }) {
  if (pending(home)) throw new Error('上次更新尚待恢复。');
  const { root, directory } = locations(home);
  for (const name of NAMES) if (!fs.statSync(path.join(root, name)).isDirectory()) throw new Error('当前安装不完整。');
  await stop();
  // Only the last completed update backup is replaced, never an unfinished one.
  await fsp.rm(directory, { recursive: true, force: true });
  await save(home, { phase: 'snapshot', target });
  try {
    onEvent({ event: 'task', task: '保存更新前的系统与数据' });
    for (const name of NAMES) {
      const current = path.join(root, name), backup = path.join(directory, name);
      await fsp.rename(current, backup);
      await fsp.cp(backup, current, { recursive: true, verbatimSymlinks: true });
    }
    await save(home, { phase: 'applying', target });
    await apply(directory);
    const result = await verify();
    await save(home, { phase: 'committed', target });
    return result;
  } catch (error) {
    onEvent({ event: 'task', task: '更新未完成，正在恢复原系统' });
    try { await recover(home, stop); }
    catch { throw new Error('更新未完成，自动恢复也未完成。旧系统备份已保留，请重新打开启动器恢复。'); }
    throw new Error(`更新未完成，已恢复原系统和数据：${error.message}`);
  }
}

async function restoreUserHome(previous, current) {
  const programs = new Set(['hermes-agent', 'python', 'node', 'nora-components.json', 'nora-clawchat-check.py',
    'gateway.pid', 'gateway.lock', 'gateway_state.json', 'nora-instance.json']);
  for (const entry of await fsp.readdir(previous, { withFileTypes: true })) {
    if (programs.has(entry.name)) continue;
    const source = path.join(previous, entry.name), target = path.join(current, entry.name);
    if (['plugins', 'clawchat'].includes(entry.name) && entry.isDirectory()) {
      for (const child of await fsp.readdir(source)) {
        if (entry.name === 'plugins' && child === 'clawchat' || entry.name === 'clawchat' && child === 'liveware') continue;
        await fsp.cp(path.join(source, child), path.join(target, child), { recursive: true, verbatimSymlinks: true });
      }
    } else await fsp.cp(source, target, { recursive: true, verbatimSymlinks: true });
  }
}
module.exports = { pending, perform, recover, restoreUserHome };
