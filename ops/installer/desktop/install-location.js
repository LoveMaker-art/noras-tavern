const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { safeRoot, contained, own } = require('./uninstall');

const OWNER = 'nora-owner.json';
const SCOPE = 'nora-location-scope.json';

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
function receipt(defaultHome) { return contained(safeRoot(defaultHome), 'installer/location.json'); }

function ownerAt(root) {
  const owner = readJson(contained(root, OWNER));
  if (owner.schema !== 1 || typeof owner.id !== 'string' || !owner.id) throw new Error('安装目录归属记录无效。');
  return owner.id;
}

function readLocation(defaultHome, scope) {
  const file = receipt(defaultHome);
  if (!fs.existsSync(file)) return safeRoot(defaultHome);
  const value = readJson(file);
  if (value.schema !== 1 || value.scope !== scope || typeof value.root !== 'string'
    || !path.isAbsolute(value.root) || typeof value.owner !== 'string') throw new Error('安装位置记录无效，请保留文件并检查。');
  const root = safeRoot(value.root);
  // Never silently install elsewhere when an external disk has disappeared.
  if (!fs.existsSync(path.dirname(root))) throw new Error(`安装位置不可用，请连接磁盘后重试：${root}`);
  if (fs.existsSync(root)) {
    if (ownerAt(root) !== value.owner) throw new Error('安装目录归属已变化，未加载或修改其中的文件。');
    for (const name of ['hermes', 'tavern', 'installer', 'cache', 'launcher']) contained(root, name);
  } else {
    // A complete uninstall removes this root. Keep only the location preference.
    own(root);
    writeJson(contained(root, SCOPE), { schema: 1, scope });
    writeJson(file, { ...value, owner: ownerAt(root) });
  }
  return root;
}

function canChangeLocation(home) {
  const root = safeRoot(home);
  if (['hermes', 'tavern', 'nora-retained.json'].some(name => fs.existsSync(contained(root, name)))) return false;
  const state = contained(root, 'installer/state.json');
  if (!fs.existsSync(state)) return true;
  try {
    const value = readJson(state);
    return !value.startedAt && !value.setupCompleted;
  } catch { return false; }
}

function selectLocation(parent, { defaultHome, currentHome, scope, appPath }) {
  if (!canChangeLocation(currentHome)) throw new Error('已经开始安装，不能更改位置。');
  if (typeof parent !== 'string' || !path.isAbsolute(parent) || !fs.statSync(parent).isDirectory()) throw new Error('请选择本机文件夹。');
  const selected = path.resolve(parent);
  const root = safeRoot(path.basename(selected) === path.basename(defaultHome) || fs.existsSync(path.join(selected, OWNER))
    ? selected : path.join(selected, path.basename(defaultHome)));
  const original = safeRoot(defaultHome);
  if (root !== original && (root.startsWith(original + path.sep) || original.startsWith(root + path.sep))) {
    throw new Error('安装目录不能与默认隔离目录互相包含。');
  }
  if (appPath) {
    const application = fs.realpathSync(appPath);
    if (application === root || application.startsWith(root + path.sep) || root.startsWith(application + path.sep)) {
      throw new Error('程序和数据目录必须分开，请选择启动器应用之外的位置。');
    }
  }
  if (fs.existsSync(root)) {
    if (!fs.statSync(root).isDirectory()) throw new Error('安装位置不是文件夹。');
    const entries = fs.readdirSync(root);
    if (entries.length) {
      if (!entries.includes(OWNER)) throw new Error('这个目录已有其他文件，请选择空目录。');
      ownerAt(root);
      const scopeFile = contained(root, SCOPE);
      const recorded = fs.existsSync(scopeFile) ? readJson(scopeFile) : null;
      if ((recorded && (recorded.schema !== 1 || recorded.scope !== scope))
        || (!recorded && root !== safeRoot(currentHome) && scope !== 'stable')) {
        throw new Error('不能混用正式版和其他测试安装的目录。');
      }
      for (const name of ['hermes', 'tavern', 'installer', 'cache', 'launcher']) contained(root, name);
    }
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const probe = contained(root, `.nora-write-${crypto.randomUUID()}`);
  try { fs.writeFileSync(probe, '', { flag: 'wx', mode: 0o600 }); }
  catch { throw new Error('这个位置无法写入，请换一个文件夹。'); }
  finally { fs.rmSync(probe, { force: true }); }
  const owner = own(root);
  writeJson(contained(root, SCOPE), { schema: 1, scope });
  writeJson(receipt(defaultHome), { schema: 1, scope, root, owner });
  return root;
}

module.exports = { readLocation, selectLocation, canChangeLocation };
