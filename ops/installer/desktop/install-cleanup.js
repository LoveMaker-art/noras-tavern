const fs = require('node:fs');
const path = require('node:path');

function cleanupInstallTemps(noraHome) {
  const root = fs.realpathSync(noraHome);
  const inside = file => {
    const relative = path.relative(root, fs.realpathSync(file));
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  const removed = [];
  // Called under the launcher's single-instance/run lock, before spawning installers.
  for (const [relative, pattern] of [
    ['cache/tmp', /^(?:nora-first-install-|nora-tavern-bootstrap\.)[a-z0-9_]{8}$/],
    ['.tmp', /^i-[a-z0-9_]{8}$/],
    ['.', /^\.runtime-[a-zA-Z0-9]{6}$/],
  ]) {
    const directory = path.join(root, relative);
    if (!fs.existsSync(directory)) continue;
    if (fs.lstatSync(directory).isSymbolicLink() || !inside(directory)) {
      throw new Error('安装临时目录越过隔离目录，已停止清理。');
    }
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!pattern.test(item.name) || item.isSymbolicLink() || !item.isDirectory()) continue;
      const file = path.join(directory, item.name);
      if (!inside(file)) throw new Error('安装临时文件越过隔离目录，已停止清理。');
      fs.rmSync(file, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      removed.push(path.relative(root, file));
    }
  }
  return removed;
}

module.exports = { cleanupInstallTemps };
