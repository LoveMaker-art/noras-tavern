const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RUNTIME_MANIFEST = 'nora-hermes-runtime.json';
const TOKENS = {
  '@@NORA_HERMES_HOME@@': (home) => home,
  '@@NORA_PYTHON_HOME@@': (home) => path.join(home, 'python'),
  '@@NORA_VENV_PYTHON@@': (home, manifest) => path.join(home, manifest.venvPython),
};

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function contained(root, relative) {
  const target = path.resolve(root, relative);
  const base = path.resolve(root);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) {
    throw new Error(`运行时清单包含非法路径：${relative}`);
  }
  return target;
}

function findBundledRuntime(payloadRoot, platform = process.platform, arch = process.arch) {
  const manifestPath = path.join(payloadRoot, RUNTIME_MANIFEST);
  if (!fs.existsSync(manifestPath)) return null;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schema !== 1 || manifest.platform !== platform || manifest.arch !== arch) {
    throw new Error('内置运行时与当前系统或架构不匹配，请下载对应的安装包。');
  }
  if (!manifest.components?.clawchat?.revision || !manifest.components?.liveware?.sha256 ||
      !manifest.components?.files || manifest.componentProbe !== 'nora-clawchat-check.py') {
    throw new Error('安装包缺少完整 ClawChat / Liveware 组件，请使用新版完整安装包。');
  }
  const archive = contained(payloadRoot, manifest.archive);
  if (!fs.existsSync(archive)) throw new Error('整合包缺少 Hermes 运行时文件。');
  return { manifest, manifestPath, archive };
}

function extractionCommand(archive, destination, platform = process.platform, systemRoot = process.env.SystemRoot) {
  // Native bsdtar handles both ZIP and gzip; bypass PowerShell's per-file overhead.
  return {
    file: platform === 'win32' ? path.win32.join(systemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar',
    args: ['-xf', archive, '-C', destination],
  };
}

function extractArchive(bundle, destination) {
  const command = extractionCommand(bundle.archive, destination);
  const result = spawnSync(command.file, command.args, { encoding: 'utf8', windowsHide: true, timeout: 600000 });
  if (result.status !== 0) {
    throw new Error(`无法释放 Hermes 运行时：${(result.error?.message || result.stderr || result.stdout || '').trim()}`);
  }
}

function relocateText(text, home, manifest) {
  for (const [token, resolve] of Object.entries(TOKENS)) {
    const native = resolve(home, manifest);
    // Forward slashes also work in Windows Python literals, unlike unescaped C:\\Users.
    text = text.split(token).join(manifest.platform === 'win32' ? native.replaceAll('\\', '/') : native);
  }
  return text;
}

function relocateFiles(home, manifest) {
  for (const relative of manifest.relocatableFiles || []) {
    const target = contained(home, relative);
    if (!fs.existsSync(target)) throw new Error(`运行时缺少可迁移文件：${relative}`);
    const text = relocateText(fs.readFileSync(target, 'utf8'), home, manifest);
    fs.writeFileSync(target, text);
  }
  if (manifest.platform === 'win32') {
    // uv's Windows trampoline embeds the build interpreter path. Recreate only
    // venv launchers/config from bundled CPython, retaining all site-packages.
    const basePython = contained(home, 'python/python.exe');
    const venv = path.dirname(path.dirname(contained(home, manifest.venvPython)));
    const rebuilt = spawnSync(basePython, ['-I', '-m', 'venv', '--without-pip', '--copies', venv], {
      encoding: 'utf8', timeout: 60000, windowsHide: true,
    });
    if (rebuilt.error || rebuilt.status !== 0) {
      throw new Error(`无法重建 Windows Python 环境：${rebuilt.error?.message || rebuilt.stderr}`);
    }
    const python = contained(home, manifest.venvPython);
    const result = spawnSync(python, ['-I', '-c', [
      'import sys',
      'from pathlib import Path',
      'from importlib.metadata import distributions',
      'from pip._vendor.distlib.scripts import ScriptMaker',
      'maker = ScriptMaker(None, str(Path(sys.executable).parent))',
      'maker.executable = sys.executable',
      'maker.clobber = True',
      'maker.variants = {""}',
      'for distribution in distributions():',
      '    for entry in distribution.entry_points:',
      '        if entry.group == "console_scripts":',
      '            maker.make(entry.name + " = " + entry.value)',
    ].join('\n')], { encoding: 'utf8', timeout: 60000, windowsHide: true });
    if (result.status !== 0) throw new Error(`无法重建 Windows 本地命令入口：${result.stderr || result.error?.message}`);
  }
}

function initializeHome(home, manifest) {
  for (const relative of ['audio_cache', 'cron', 'hooks', 'image_cache', 'logs', 'memories', 'pairing', 'sessions', 'skills']) {
    fs.mkdirSync(path.join(home, relative), { recursive: true });
  }
  const envFile = path.join(home, '.env');
  const configFile = path.join(home, 'config.yaml');
  if (!fs.existsSync(envFile)) fs.writeFileSync(envFile, '', { mode: 0o600 });
  if (!fs.existsSync(configFile)) fs.writeFileSync(configFile, '{}\n', { mode: 0o600 });

  const sourceSkills = path.join(home, 'hermes-agent', 'skills');
  if (fs.existsSync(sourceSkills)) {
    for (const entry of fs.readdirSync(sourceSkills, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const target = path.join(home, 'skills', entry.name);
      if (!fs.existsSync(target)) fs.cpSync(path.join(sourceSkills, entry.name), target, { recursive: true });
    }
  }

  if (process.platform !== 'win32') {
    const bin = path.join(home, '.local', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const links = manifest.nodeLinks || {};
    for (const [name, relative] of Object.entries(links)) {
      const target = path.join(bin, name);
      fs.rmSync(target, { force: true });
      fs.symlinkSync(path.relative(bin, path.join(home, relative)), target);
    }
  }
}

function validateRuntime(home, manifest) {
  validateRuntimeLinks(home);
  const node = contained(home, path.join(manifest.nodeBin, process.platform === 'win32' ? 'node.exe' : 'node'));
  const npm = contained(home, process.platform === 'win32' ? 'node/node_modules/npm/bin/npm-cli.js' : 'node/lib/node_modules/npm/bin/npm-cli.js');
  const npmCheck = spawnSync(node, [npm, '--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  if (npmCheck.error || npmCheck.status !== 0) throw new Error('内置 Node.js / npm 不完整或无法执行。');
  const command = contained(home, manifest.probe.command);
  const result = spawnSync(command, manifest.probe.args || ['--version'], {
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
    env: {
      ...process.env,
      HOME: home,
      HERMES_HOME: home,
      PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
      PATH: [
        path.dirname(command),
        path.join(home, manifest.nodeBin),
        process.env.PATH || '',
      ].join(path.delimiter),
    },
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Hermes 运行时校验失败：${result.error?.message || result.stderr || result.stdout || '未知错误'}`);
  }
  const check = spawnSync(contained(home, manifest.venvPython), ['-B', contained(home, manifest.componentProbe)], {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: {
      // Do not inherit developer credentials, Python paths, or external Liveware binaries.
      SystemRoot: process.env.SystemRoot || '', WINDIR: process.env.WINDIR || '',
      HOME: home, USERPROFILE: home, HERMES_HOME: home,
      APPDATA: path.join(home, 'appdata'), LOCALAPPDATA: path.join(home, 'localappdata'),
      TMPDIR: home, TMP: home, TEMP: home, XDG_CACHE_HOME: path.join(home, '.cache'),
      PYTHONPATH: path.join(home, 'hermes-agent'), PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1',
      PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
      PATH: [path.dirname(command), path.join(home, manifest.nodeBin)].join(path.delimiter),
    },
  });
  if (check.error || check.status !== 0) {
    throw new Error(`ClawChat / Liveware 离线加载检查失败：${check.error?.message || check.stderr || check.stdout}`);
  }
  return (result.stdout || result.stderr || '').trim();
}

function validateRuntimeLinks(home) {
  const base = fs.realpathSync(home);
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = fs.realpathSync(file);
        if (target !== base && !target.startsWith(`${base}${path.sep}`)) {
          throw new Error(`运行时链接指向安装目录之外：${path.relative(home, file)}`);
        }
      } else if (entry.isDirectory()) walk(file);
    }
  };
  walk(home);
}

function installBundledHermes({ payloadRoot, noraHome, hermesHome, onEvent = () => {} }) {
  const bundle = findBundledRuntime(payloadRoot);
  if (!bundle) return null;
  if (sha256File(bundle.archive) !== bundle.manifest.sha256) {
    throw new Error('Hermes 运行时校验失败，安装包可能不完整。');
  }

  fs.mkdirSync(noraHome, { recursive: true });
  const work = fs.mkdtempSync(path.join(noraHome, '.runtime-'));
  const extracted = path.join(work, 'hermes-runtime');
  const backup = path.join(noraHome, 'installer', 'backups', `hermes-partial-${Date.now()}`);
  let previous = false;
  let replaced = false;
  try {
    onEvent({ event: 'task', milestone: 0, task: '释放 Nora 核心', current: 1, total: 3 });
    extractArchive(bundle, work);
    if (!fs.existsSync(extracted)) throw new Error('Hermes 运行时目录结构不正确。');

    if (fs.existsSync(hermesHome)) {
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.renameSync(hermesHome, backup);
      previous = true;
    }
    fs.renameSync(extracted, hermesHome);
    replaced = true;

    onEvent({ event: 'task', milestone: 0, task: '初始化 Nora', current: 2, total: 3 });
    relocateFiles(hermesHome, bundle.manifest);
    initializeHome(hermesHome, bundle.manifest);

    onEvent({ event: 'task', milestone: 0, task: '检查 Nora', current: 3, total: 3 });
    const version = validateRuntime(hermesHome, bundle.manifest);
    fs.writeFileSync(path.join(hermesHome, 'hermes-agent', '.hermes-bootstrap-complete'), `${JSON.stringify({
      schema: 1,
      source: 'nora-integrated-runtime',
      platform: bundle.manifest.platform,
      arch: bundle.manifest.arch,
      version,
      sha256: bundle.manifest.sha256,
      installedAt: new Date().toISOString(),
    }, null, 2)}\n`, { mode: 0o600 });
    return { ...bundle.manifest, version };
  } catch (error) {
    if (replaced) fs.rmSync(hermesHome, { recursive: true, force: true });
    if (previous && fs.existsSync(backup)) fs.renameSync(backup, hermesHome);
    throw error;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = {
  extractionCommand,
  RUNTIME_MANIFEST,
  findBundledRuntime,
  installBundledHermes,
  initializeHome,
  relocateFiles,
  relocateText,
  sha256File,
  validateRuntime,
  validateRuntimeLinks,
};
