const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function read(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 65536) throw new Error('Invalid skill update request');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function write(file, data) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}

// A local handoff, not another updater. Only the launcher's existing actions run.
function createSkillUpdateReceiver({ home, busy, execute, clean = String, now = Date.now }) {
  const session = randomUUID();
  let directory, running = false;
  function close() {
    if (directory) {
      try {
        const endpoint = path.join(directory, 'endpoint.json');
        if (read(endpoint).session === session) fs.rmSync(endpoint, { force: true });
      } catch {}
    }
  }
  async function tick() {
    const currentHome = path.resolve(home());
    const next = path.join(currentHome, 'installer', 'skill-update');
    if (directory !== next) { close(); directory = next; }
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Skill update directory must not be a link');
    write(path.join(directory, 'endpoint.json'), { schema: 1, session, noraHome: currentHome, updatedAt: now() });
    if (running || busy()) return;
    const file = path.join(directory, 'request.json');
    let request;
    try { request = read(file); } catch { return; }
    if (['success', 'error', 'interrupted'].includes(request.status)) return;
    const finish = (status, extra = {}) => write(file, {
      schema: 1, id: request.id, action: request.action, status, updatedAt: now(), ...extra,
    });
    if (request.status !== 'queued' || request.session !== session) {
      finish('interrupted', { error: '启动器会话已变化，任务不会自动重试。请检查版本后重新提交。' });
      return;
    }
    if (request.schema !== 1 || !/^[a-f0-9-]{36}$/.test(request.id || '') ||
        !['check', 'update'].includes(request.action) || request.confirm !== true ||
        !Number.isFinite(request.createdAt) || now() - request.createdAt > 60000 || request.createdAt > now() + 5000) {
      finish('error', { error: '更新请求无效或已过期，请重新提交。' });
      return;
    }
    running = true;
    try {
      finish('running');
      const result = await execute(request.action, request.id);
      finish(result?.restarting ? 'restarting' : 'success', { result });
    } catch (error) {
      finish('error', { error: clean(error.message || String(error)) });
    } finally { running = false; }
  }
  return { tick, close };
}
function finishHandoff(home, id, result, error) {
  if (!id) return;
  const file = path.join(home, 'installer', 'skill-update', 'request.json');
  const request = read(file);
  if (request.id !== id || request.status !== 'restarting') return;
  write(file, { ...request, status: error ? 'error' : 'success', updatedAt: Date.now(),
    ...(error ? { error: String(error) } : { result }) });
}
module.exports = { createSkillUpdateReceiver, finishHandoff };
