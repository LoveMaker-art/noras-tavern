#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import runtimeTools from '../installer/desktop/runtime.js';

const installer = fileURLToPath(new URL('../installer/', import.meta.url));
const lockPath = path.join(installer, 'clawchat-bundle.lock.json');
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));

const args = process.argv.slice(2);
function option(name, fallback = '') {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
}

const hermesHome = path.resolve(option('--hermes-home', process.env.HERMES_HOME || ''));
const output = path.resolve(option('--output', path.join(process.cwd(), 'release/hermes-runtime')));
const platform = option('--platform', process.platform);
const arch = option('--arch', process.arch);
const clawchatSource = option('--clawchat-source');
if (!clawchatSource) throw new Error('完整运行时必须提供 --clawchat-source，不能缺少 ClawChat。');
if (platform !== process.platform || arch !== process.arch) throw new Error('运行时必须在同系统同架构下构建。');
if (!hermesHome || hermesHome === path.parse(hermesHome).root) throw new Error('必须提供 --hermes-home');
if (!['darwin', 'win32'].includes(platform)) throw new Error(`暂不支持运行时平台：${platform}`);

const agent = path.join(hermesHome, 'hermes-agent');
const venv = path.join(agent, 'venv');
const marker = path.join(agent, '.hermes-bootstrap-complete');
if (!fs.existsSync(marker) || !fs.existsSync(venv)) throw new Error('Hermes 尚未完整安装，不能构建整合运行时。');

const venvPython = platform === 'win32'
    ? path.join(venv, 'Scripts', 'python.exe')
    : path.join(venv, 'bin', 'python');
const resolvedPython = fs.realpathSync(venvPython);
const pythonRoot = platform === 'win32'
    ? path.dirname(resolvedPython)
    : path.dirname(path.dirname(resolvedPython));
const managedNodeRoot = path.join(hermesHome, 'node');
const nodeRoot = fs.existsSync(managedNodeRoot)
    ? managedNodeRoot
    : platform === 'win32' ? path.dirname(process.execPath) : path.dirname(path.dirname(process.execPath));
const nodeExecutable = platform === 'win32' ? path.join(nodeRoot, 'node.exe') : path.join(nodeRoot, 'bin', 'node');
const nodeVersionResult = spawnSync(nodeExecutable, ['--version'], { encoding: 'utf8' });
if (nodeVersionResult.status !== 0) throw new Error('Hermes 托管 Node.js 无法运行。');
const nodeVersion = nodeVersionResult.stdout.trim();

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-hermes-runtime-'));
const runtime = path.join(temporary, 'hermes-runtime');
const excludedNames = new Set([
    '.DS_Store', '.env', '.git', '.github', '.npm', '.pytest_cache', '.ruff_cache',
    '__pycache__', 'docs', 'examples', 'node_modules', 'tests', 'config.yaml', 'SOUL.md', 'AGENTS.md',
]);
const excludedTopLevel = new Set([
    'Library', 'audio_cache', 'cron', 'hooks', 'image_cache', 'logs', 'memories',
    'pairing', 'sessions', 'skills', 'bin',
]);

function shouldCopy(sourceRoot, source, topLevel = false) {
    const relative = path.relative(sourceRoot, source);
    const parts = relative.split(path.sep).filter(Boolean);
    if (parts.some((part) => excludedNames.has(part))) return false;
    if (topLevel && parts.length && excludedTopLevel.has(parts[0])) return false;
    if (/\.(?:pyc|pyo|log|token)$/i.test(source)) return false;
    return true;
}

function copyTree(source, target, topLevel = false) {
    fs.cpSync(source, target, {
        recursive: true,
        preserveTimestamps: true,
        verbatimSymlinks: true,
        filter: (entry) => shouldCopy(source, entry, topLevel),
    });
}

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function replaceTextReferences(root, replacements) {
    const changed = [];
    const walk = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) walk(file);
            else if (entry.isFile()) {
                const stat = fs.statSync(file);
                if (stat.size > 8 * 1024 * 1024) continue;
                const bytes = fs.readFileSync(file);
                if (bytes.includes(0)) continue;
                let text = bytes.toString('utf8');
                const original = text;
                for (const [from, to] of replacements) text = text.split(from).join(to);
                if (text !== original) {
                    fs.writeFileSync(file, text);
                    changed.push(path.relative(root, file));
                }
            }
        }
    };
    walk(root);
    return changed.sort();
}

function archiveRuntime(archive) {
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    const command = platform === 'win32'
        ? ['tar', ['-a', '-cf', archive, '-C', temporary, 'hermes-runtime']]
        : ['tar', ['--no-xattrs', '-czf', archive, '-C', temporary, 'hermes-runtime']];
    const result = spawnSync(command[0], command[1], { stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } });
    if (result.status !== 0) throw new Error('无法创建 Hermes 运行时压缩包。');
}

try {
    const source = path.resolve(clawchatSource);
    const git = (...args) => {
        const result = spawnSync('git', ['-C', source, ...args], { encoding: 'utf8' });
        if (result.status !== 0) throw new Error('无法验证 ClawChat Git 来源。');
        return result.stdout.trim();
    };
    if (git('remote', 'get-url', 'origin').replace(/\.git$/, '') !== lock.repository.replace(/\.git$/, '') ||
        git('rev-parse', 'HEAD') !== lock.revision || git('status', '--porcelain')) {
        throw new Error('ClawChat 必须使用已审核的官方固定版本且工作树干净。');
    }
    const audit = spawnSync(venvPython, ['-B', path.join(installer, 'clawchat-bundle-audit.py'), source, lockPath], {
        env: { ...process.env, PYTHONPATH: agent, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8', timeout: 30000,
    });
    if (audit.status !== 0) throw new Error(`ClawChat 安全审核未通过：${audit.stderr || audit.stdout}`);
    fs.mkdirSync(runtime, { recursive: true });
    copyTree(agent, path.join(runtime, 'hermes-agent'));
    copyTree(pythonRoot, path.join(runtime, 'python'));
    fs.cpSync(nodeRoot, path.join(runtime, 'node'), {
        recursive: true, preserveTimestamps: true, verbatimSymlinks: true,
        filter: (entry) => !path.relative(nodeRoot, entry).split(path.sep).some((part) => ['.env', '.git', '.cache'].includes(part)),
    });
    if (clawchatSource) {
        if (!fs.existsSync(path.join(source, 'clawchat_cli.py')) || !fs.existsSync(path.join(source, 'plugin.yaml'))) {
            throw new Error('ClawChat 插件源码不完整。');
        }
        const revision = spawnSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
        if (revision.status !== 0) throw new Error('ClawChat 插件必须来自可追溯的干净 Git checkout。');
        const dirty = spawnSync('git', ['-C', source, 'status', '--porcelain'], { encoding: 'utf8' });
        if (dirty.status !== 0 || dirty.stdout.trim()) throw new Error('ClawChat 插件源码含未提交文件，拒绝打包用户数据。');
        const tracked = spawnSync('git', ['-C', source, 'ls-files', '-z'], { encoding: 'utf8' });
        if (tracked.status !== 0) throw new Error('无法读取 ClawChat 已跟踪文件。');
        for (const relative of tracked.stdout.split('\0').filter(Boolean)) {
            const file = path.join(source, relative);
            if (!shouldCopy(source, file)) continue;
            if (!fs.lstatSync(file).isFile()) throw new Error('ClawChat 源码只能包含普通文件。');
            const target = path.join(runtime, 'plugins/clawchat', relative);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(file, target);
        }
        fs.writeFileSync(path.join(runtime, 'plugins', 'clawchat', 'nora-source.json'), JSON.stringify({ repository: 'clawling/clawchat-plugin-hermes-agent', revision: revision.stdout.trim() }));
        const prepare = spawnSync(venvPython, ['-B', '-c',
            'import sys;sys.path.insert(0,sys.argv[1]);from clawchat_gateway.liveware_cli import ensure_liveware_cli,resolve_liveware_path;ensure_liveware_cli();assert resolve_liveware_path(),"Liveware is unavailable for this platform"', source], {
            env: { ...process.env, HERMES_HOME: runtime, HOME: runtime, USERPROFILE: runtime, PATH: '', PYTHONPATH: agent },
            encoding: 'utf8', timeout: 180000,
        });
        if (prepare.status !== 0) throw new Error(`无法准备内置 Liveware：${prepare.stderr || prepare.stdout}`);
    }
    const files = {};
    const inventory = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) throw new Error('ClawChat bundle cannot contain symlinks');
            if (entry.isDirectory()) inventory(file);
            else if (entry.isFile()) files[path.relative(runtime, file).split(path.sep).join('/')] = sha256(file);
        }
    };
    inventory(path.join(runtime, 'plugins/clawchat'));
    const livewarePath = `clawchat/liveware/liveware${platform === 'win32' ? '.exe' : ''}`;
    files[livewarePath] = sha256(path.join(runtime, livewarePath));
    const components = {
        schema: 1, clawchat: { revision: lock.revision, version: lock.version, review: lock.review },
        liveware: { path: livewarePath, sha256: files[livewarePath] }, files,
    };
    fs.writeFileSync(path.join(runtime, 'nora-components.json'), JSON.stringify(components, null, 2));
    fs.copyFileSync(path.join(installer, 'clawchat-bundle-check.py'), path.join(runtime, 'nora-clawchat-check.py'));
    fs.rmSync(path.join(runtime, 'hermes-agent', '.hermes-bootstrap-complete'), { force: true });

    if (platform === 'darwin') {
        const libpython = path.join(runtime, 'python', 'lib', 'libpython3.11.dylib');
        const normalized = spawnSync('install_name_tool', ['-id', '@rpath/libpython3.11.dylib', libpython], { encoding: 'utf8' });
        if (normalized.status !== 0) throw new Error(`无法规范化 Python 动态库：${normalized.stderr || normalized.stdout}`);
    }

    const bundledVenvPython = platform === 'win32'
        ? path.join(runtime, 'hermes-agent', 'venv', 'Scripts', 'python.exe')
        : path.join(runtime, 'hermes-agent', 'venv', 'bin', 'python');
    if (platform !== 'win32') {
        fs.rmSync(bundledVenvPython, { force: true });
        fs.symlinkSync(path.relative(path.dirname(bundledVenvPython), path.join(runtime, 'python', path.relative(pythonRoot, resolvedPython))), bundledVenvPython);
    }
    runtimeTools.validateRuntimeLinks(runtime);

    const replacements = [
        [path.join(agent, 'venv', platform === 'win32' ? 'Scripts' : 'bin', platform === 'win32' ? 'python.exe' : 'python'), '@@NORA_VENV_PYTHON@@'],
        [agent, path.join('@@NORA_HERMES_HOME@@', 'hermes-agent')],
        [hermesHome, '@@NORA_HERMES_HOME@@'],
        [pythonRoot, '@@NORA_PYTHON_HOME@@'],
    ].sort((a, b) => b[0].length - a[0].length);
    const relocatableFiles = replaceTextReferences(runtime, replacements);
    const pyvenv = path.join(runtime, 'hermes-agent', 'venv', 'pyvenv.cfg');
    const pyvenvHome = platform === 'win32' ? '@@NORA_PYTHON_HOME@@' : '@@NORA_PYTHON_HOME@@/bin';
    const pyvenvText = fs.readFileSync(pyvenv, 'utf8').replace(/^home\s*=.*$/m, `home = ${pyvenvHome}`);
    fs.writeFileSync(pyvenv, pyvenvText);
    const pyvenvRelative = path.relative(runtime, pyvenv);
    if (!relocatableFiles.includes(pyvenvRelative)) relocatableFiles.push(pyvenvRelative);
    relocatableFiles.sort();

    const format = platform === 'win32' ? 'zip' : 'tar.gz';
    const archiveName = `nora-hermes-runtime-${platform}-${arch}.${format}`;
    const archive = path.join(output, archiveName);

    const pyproject = fs.readFileSync(path.join(agent, 'pyproject.toml'), 'utf8');
    const version = pyproject.match(/^version\s*=\s*"([^"]+)"/m)?.[1] || 'unknown';
    const manifest = {
        schema: 1,
        platform,
        arch,
        format,
        archive: archiveName,
        components,
        componentProbe: 'nora-clawchat-check.py',
        hermesVersion: version,
        nodeVersion,
        venvPython: platform === 'win32' ? 'hermes-agent/venv/Scripts/python.exe' : 'hermes-agent/venv/bin/python',
        nodeBin: platform === 'win32' ? 'node' : 'node/bin',
        nodeLinks: platform === 'win32' ? {} : {
            node: 'node/bin/node', npm: 'node/bin/npm', npx: 'node/bin/npx',
        },
        probe: {
            command: platform === 'win32' ? 'hermes-agent/venv/Scripts/hermes.exe' : 'hermes-agent/venv/bin/hermes',
            args: ['--version'],
        },
        relocatableFiles,
        optionalComponents: ['chromium', 'browser-use', 'cua-driver', 'ffmpeg'],
        excludesUserData: true,
        createdAt: new Date().toISOString(),
    };
    // Validate the relocated tree, then restore tokens and strip probe-generated state.
    const originals = new Map(relocatableFiles.map((relative) => [relative, fs.readFileSync(path.join(runtime, relative))]));
    runtimeTools.relocateFiles(runtime, manifest);
    runtimeTools.initializeHome(runtime, manifest);
    runtimeTools.validateRuntime(runtime, manifest);
    for (const [relative, bytes] of originals) fs.writeFileSync(path.join(runtime, relative), bytes);
    const allowed = new Set(['hermes-agent', 'python', 'node', 'plugins', 'clawchat', 'nora-components.json', 'nora-clawchat-check.py']);
    for (const entry of fs.readdirSync(runtime)) {
        if (!allowed.has(entry)) fs.rmSync(path.join(runtime, entry), { recursive: true, force: true });
    }
    archiveRuntime(archive);
    manifest.sha256 = sha256(archive);
    manifest.size = fs.statSync(archive).size;
    fs.writeFileSync(path.join(output, 'nora-hermes-runtime.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(JSON.stringify({ manifest: path.join(output, 'nora-hermes-runtime.json'), archive, ...manifest }, null, 2));
} finally {
    fs.rmSync(temporary, { recursive: true, force: true });
}
