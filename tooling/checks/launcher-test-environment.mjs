import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const rootDirectory = fileURLToPath(new URL('../../', import.meta.url));
const desktopDirectory = root => fs.existsSync(path.join(root, 'launcher/desktop/package.json'))
    ? path.join(root, 'launcher/desktop') : path.join(root, 'ops/installer/desktop');
const invalid = (check, message, cause) => Object.assign(new Error(`Launcher test environment (${check}): ${message}`, cause ? { cause } : undefined),
    { code: 'LAUNCHER_TEST_ENVIRONMENT_INVALID', category: 'test_environment', check });
const same = (left, right) => {
    const first = fs.realpathSync(left), second = fs.realpathSync(right);
    return process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
};

export function withTestNodePath(environment, executable, platform = process.platform) {
    const clean = { ...environment };
    const keys = Object.keys(clean).filter(key => platform === 'win32' ? /^path$/i.test(key) : key === 'PATH').sort();
    // Node passes only the first lexicographic spelling of a Windows env key.
    const previous = keys.length ? clean[keys[0]] : '';
    for (const key of keys) delete clean[key];
    const filesystemPath = platform === 'win32' ? path.win32 : path.posix;
    clean.PATH = filesystemPath.dirname(executable) + filesystemPath.delimiter + (previous || '');
    return clean;
}

function probe(run, command, args, environment, check) {
    const result = run(command, args, { env: environment, encoding: 'utf8', timeout: 10000, maxBuffer: 256 * 1024 });
    if (result.error || result.signal || result.status !== 0) {
        const missing = /No module named ['"]([A-Za-z0-9_.-]+)['"]/.exec(result.stderr || '')?.[1];
        throw invalid(check, `the prerequisite command failed (${result.error?.code || result.signal || result.status})`
            + (missing ? `; missing dependency: ${missing}` : ''), result.error);
    }
    try { return JSON.parse(result.stdout.trim()); }
    catch (error) { throw invalid(check, 'the prerequisite returned an invalid identity', error); }
}

function dependencies(root, environment) {
    const directory = environment.NORA_TEST_DESKTOP_NODE_MODULES
        ? path.resolve(environment.NORA_TEST_DESKTOP_NODE_MODULES) : path.join(desktopDirectory(root), 'node_modules');
    const expected = JSON.parse(fs.readFileSync(path.join(desktopDirectory(root), 'package.json'), 'utf8'));
    const require = createRequire(path.join(directory, '.launcher-test-environment.cjs'));
    for (const name of ['semver', 'acorn', 'fs-native-extensions']) {
        const actual = JSON.parse(fs.readFileSync(path.join(directory, name, 'package.json'), 'utf8'));
        if (actual.version !== (expected.dependencies?.[name] || expected.devDependencies?.[name]))
            throw invalid('desktop_dependencies', `${name} does not match the committed dependency`);
    }
    const native = require('fs-native-extensions');
    // Loading a package.json alone does not establish its platform/ABI binding.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-test-lock-probe-'));
    const file = path.join(scratch, 'writer.lock'); let descriptor, locked = false;
    try {
        descriptor = fs.openSync(file, 'wx+'); fs.writeSync(descriptor, Buffer.from([0]));
        locked = native.tryLock(descriptor, 0, process.platform === 'win32' ? 1 : 0);
        if (!locked) throw invalid('desktop_dependencies', 'the native writer lock is unavailable');
    } finally {
        try { if (locked) native.unlock(descriptor, 0, process.platform === 'win32' ? 1 : 0); }
        finally { if (descriptor !== undefined) fs.closeSync(descriptor); fs.rmSync(scratch, { recursive: true, force: true }); }
    }
    return { directory };
}

function links() {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-test-links-probe-'));
    try {
        const file = path.join(scratch, 'file'), directory = path.join(scratch, 'directory');
        fs.writeFileSync(file, 'fixture'); fs.mkdirSync(directory);
        fs.symlinkSync(file, path.join(scratch, 'file-link'), 'file');
        fs.symlinkSync(directory, path.join(scratch, 'directory-link'), 'dir');
        if (!same(file, path.join(scratch, 'file-link')) || !same(directory, path.join(scratch, 'directory-link')))
            throw invalid('native_links', 'file and directory link identities disagree');
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

function checkEnvironment({ root = rootDirectory, profile = 'source', environment = process.env,
    run = spawnSync, loadDependencies = dependencies, checkLinks = links } = {}) {
    if (!['source', 'native', 'chromium', 'receiver'].includes(profile)) throw invalid('profile', 'unknown test profile');
    let clean = { ...environment, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
    delete clean.PYTHONPATH; delete clean.PYTHONHOME; delete clean.__PYVENV_LAUNCHER__;
    for (const name of Object.keys(clean)) if (name.startsWith('NORA_OPERATION_')) delete clean[name];
    if (Object.hasOwn(clean, 'NORA_TEST_NODE') && !clean.NORA_TEST_NODE) throw invalid('node', 'NORA_TEST_NODE is explicitly empty');
    const selectedNode = clean.NORA_TEST_NODE || process.execPath;
    if (!path.isAbsolute(selectedNode)) throw invalid('node', 'NORA_TEST_NODE must be an absolute executable path');
    const node = probe(run, selectedNode, ['-p', 'JSON.stringify({executable:process.execPath,node:process.versions.node,bun:process.versions.bun||null,platform:process.platform,arch:process.arch})'], clean, 'node');
    if (process.versions.bun || !node.node || node.bun || Number(node.node.split('.')[0]) !== 24
        || node.platform !== process.platform || node.arch !== process.arch || !same(node.executable, selectedNode)
        || !same(node.executable, process.execPath))
        throw invalid('node', 'real, platform-matching Node.js 24 is required; a compatibility shim is not accepted');
    clean.NORA_TEST_NODE = node.executable;
    clean = withTestNodePath(clean, node.executable);
    if (process.platform === 'win32' && ['source', 'native'].includes(profile)) {
        const powershell = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'],
            { env: clean, encoding: 'utf8', timeout: 10000 });
        if (powershell.error || powershell.signal || powershell.status !== 0)
            throw invalid('windows_tools', 'PowerShell is required for the native process fixtures', powershell.error);
    }
    let desktop;
    try { desktop = loadDependencies(root, clean); }
    catch (error) { if (error.category === 'test_environment') throw error; throw invalid('desktop_dependencies', 'install the locked desktop dependencies for this platform', error); }
    const facts = { profile, node, desktop };
    if(['source','chromium'].includes(profile)){
        const openssl=run('openssl',['version'],{env:clean,encoding:'utf8',timeout:10000});
        if(openssl.error||openssl.signal||openssl.status!==0||!/^(?:OpenSSL|LibreSSL)\s+\S+/.test(openssl.stdout||''))
            throw invalid('tls_tools','OpenSSL is required for the local TLS fixtures',openssl.error);
        facts.openssl={version:openssl.stdout.trim()};
    }
    if (profile === 'chromium') {
        const lock = JSON.parse(fs.readFileSync(path.join(desktopDirectory(root), 'package-lock.json'), 'utf8'));
        const installed = JSON.parse(fs.readFileSync(path.join(desktop.directory, 'electron/package.json'), 'utf8'));
        if (installed.version !== lock.packages['node_modules/electron'].version) throw invalid('chromium', 'Electron does not match the committed lockfile');
        const require = createRequire(path.join(desktop.directory, '.launcher-test-environment.cjs'));
        const binary = require('electron');
        if (!fs.existsSync(binary)) throw invalid('chromium', 'install the actual Electron binary before its transport checks');
        if (clean.NORA_ELECTRON && !same(clean.NORA_ELECTRON, binary)) throw invalid('chromium', 'NORA_ELECTRON differs from the pinned Electron fixture');
        return { environment: clean, facts };
    }
    if (Object.hasOwn(clean, 'NORA_TEST_PYTHON') && !clean.NORA_TEST_PYTHON) throw invalid('python', 'NORA_TEST_PYTHON is explicitly empty');
    const selectedPython = clean.NORA_TEST_PYTHON || clean.NORA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    const python = probe(run, selectedPython, ['-B', '-c',
        "import sys,json,psutil,yaml; print(json.dumps({'executable':sys.executable,'prefix':sys.prefix,'basePrefix':sys.base_prefix,'version':list(sys.version_info[:3]),'psutil':psutil.__version__,'yaml':yaml.__version__}))"], clean, 'python');
    if (!path.isAbsolute(python.executable) || python.version?.[0] !== 3 || python.version?.[1] < 11)
        throw invalid('python', 'Python 3.11 or later with psutil and PyYAML is required');
    if (clean.NORA_TEST_PYTHON && (!path.isAbsolute(clean.NORA_TEST_PYTHON) || !same(python.executable, clean.NORA_TEST_PYTHON)))
        throw invalid('python', 'the explicit test interpreter identity changed');
    clean.NORA_TEST_PYTHON = clean.NORA_PYTHON = clean.NORA_WORKFLOW_YAML_PYTHON = python.executable;
    facts.python = python;
    if (profile === 'native') {
        const hermes = clean.NORA_TEST_HERMES, managed = clean.NORA_TEST_MANAGED_PYTHON_ROOT;
        if (!path.isAbsolute(hermes || '') || !path.isAbsolute(managed || '')
            || !same(python.prefix, path.join(hermes, 'venv')) || !same(python.basePrefix, managed)
            || !same(managed, path.join(path.dirname(hermes), 'python')))
            throw invalid('native_runtime', 'declare the actual Hermes checkout, its venv and managed Python root');
        if (!fs.existsSync(path.join(hermes, 'agent/prompt_builder.py'))) throw invalid('native_runtime', 'the real Hermes prompt loader is missing');
        const require = createRequire(path.join(desktopDirectory(root), 'package.json'));
        require('./managed-python').resolveExecution(python.executable, { managedPythonRoot: managed, venvHome: python.prefix, env: clean });
        const imported = probe(run, python.executable, ['-B', '-c', "import json,ssl,requests,hermes_cli; print(json.dumps({'requests':requests.__version__,'hermes':hermes_cli.__version__,'hermesFile':hermes_cli.__file__,'ssl':ssl.OPENSSL_VERSION}))"], clean, 'native_runtime');
        if (!same(imported.hermesFile, path.join(hermes, 'hermes_cli/__init__.py'))) throw invalid('native_runtime', 'Python imported a different Hermes checkout');
        facts.native = imported;
    }
    if (profile === 'source' || profile === 'native') {
        try { checkLinks(); } catch (error) { throw invalid('native_links', 'the source fixtures require file and directory symlink capability', error); }
    }
    if (profile === 'receiver') {
        const landing = clean.NORA_LANDING_ROOT;
        if (!path.isAbsolute(landing || '')) throw invalid('receiver', 'NORA_LANDING_ROOT must identify the actual receiver source');
        const local = JSON.parse(fs.readFileSync(path.join(desktopDirectory(root), 'telemetry-contract.json'), 'utf8'));
        const remote = JSON.parse(fs.readFileSync(path.join(landing, 'server/launcher-contract.json'), 'utf8'));
        if (!isDeepStrictEqual(local, remote)) throw invalid('receiver', 'the receiver contract differs from this launcher source');
        for (const name of ['server/worker.mjs', 'migrations/0005_launcher_events.sql', 'migrations/0006_launcher_error_details.sql',
            'migrations/0007_launcher_fault_packets.sql', 'migrations/0008_launcher_operation_logs.sql'])
            if (!fs.statSync(path.join(landing, name)).isFile()) throw invalid('receiver', 'the receiver fixture is incomplete');
    }
    return { environment: clean, facts };
}

export function checkLauncherTestEnvironment(options = {}) {
    try { return checkEnvironment(options); }
    catch (error) {
        if (error.category === 'test_environment') throw error;
        throw invalid('inputs', 'the selected fixture files or interpreter identities are unavailable', error);
    }
}

if (process.argv[1] && same(process.argv[1], fileURLToPath(import.meta.url))) {
    try {
        const profile = process.argv[2] || 'source';
        console.log(JSON.stringify(checkLauncherTestEnvironment({ profile }).facts));
    } catch (error) {
        console.error(JSON.stringify({ category: 'test_environment', code: error.code || 'LAUNCHER_TEST_ENVIRONMENT_INVALID',
            check: error.check || 'inputs', message: error.message })); process.exitCode = 2;
    }
}
