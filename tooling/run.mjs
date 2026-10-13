#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createReleaseSource } from './release/release-source.mjs';
import { readLayout, translatePath } from './layout.mjs';
import { buildCommand } from './release/build-commands.mjs';
import { withTestNodePath } from './checks/launcher-test-environment.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.versions.bun || Number(process.versions.node.split('.')[0]) !== 24) {
    throw Object.assign(new Error('The source test runner requires real Node.js 24; invoke this file with that executable.'),
        { code: 'LAUNCHER_TEST_ENVIRONMENT_INVALID' });
}
const sameNode = selected => {
    if (!selected || !path.isAbsolute(selected) || !fs.existsSync(selected)) return false;
    const expected = fs.realpathSync(process.execPath), actual = fs.realpathSync(selected);
    return process.platform === 'win32' ? expected.toLowerCase() === actual.toLowerCase() : expected === actual;
};
if (Object.hasOwn(process.env, 'NORA_TEST_NODE') && !sameNode(process.env.NORA_TEST_NODE)) {
    throw Object.assign(new Error('NORA_TEST_NODE must identify the real Node executable running this source runner.'),
        { code: 'LAUNCHER_TEST_ENVIRONMENT_INVALID' });
}
if (Object.hasOwn(process.env, 'NORA_TEST_PYTHON') && !process.env.NORA_TEST_PYTHON) {
    throw Object.assign(new Error('NORA_TEST_PYTHON is explicitly empty; select an actual interpreter or unset the override.'),
        { code: 'LAUNCHER_TEST_ENVIRONMENT_INVALID' });
}
const args = process.argv.slice(2);
const watch = args[0] === '--watch';
if (watch) args.shift();
const executable = args.shift();
if (!executable) throw new Error('Usage: node tooling/run.mjs [--watch] <node|python|executable> <arguments...>');
// Packaging must read Git from the authored tree, not from a projected export.
if (args.some(arg => /(?:^|\/)package-release\.(?:mjs|sh)$/.test(arg))) {
    throw new Error('Use node tooling/release/package-release.mjs directly');
}
if (args.some(arg => /(?:^|\/)index-project\.mjs$/.test(arg))) {
    throw new Error('Use node tooling/checks/index-project.mjs directly');
}
const rules = readLayout(root);
const nodeTests = executable === 'node' && args.includes('--test');
const nodeEval = executable === 'node' && args.some(arg => ['-e', '--eval', '-p', '--print'].includes(arg));
const { stage } = createReleaseSource(root, { candidate: true });
const watchers = [];
let child;
let interrupted = false;
const stop = signal => {
    interrupted = true;
    child?.kill(signal);
};
const signalHandlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => stop(signal)]));
try {
    for (const directory of ['launcher/desktop/node_modules', 'app/engine/sillytavern/node_modules', 'nora-mcp/node_modules']) {
        const source = directory === 'launcher/desktop/node_modules' && process.env.NORA_TEST_DESKTOP_NODE_MODULES
            ? path.resolve(process.env.NORA_TEST_DESKTOP_NODE_MODULES) : path.join(root, directory);
        if (directory === 'launcher/desktop/node_modules' && process.env.NORA_TEST_DESKTOP_NODE_MODULES
            && !fs.existsSync(path.join(source, 'fs-native-extensions/package.json'))) {
            throw new Error('The isolated launcher test dependencies must contain the native writer lock');
        }
        if (!fs.existsSync(source)) continue;
        const target = path.join(stage, translatePath(directory, rules));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.symlinkSync(fs.realpathSync(source), target, process.platform === 'win32' ? 'junction' : 'dir');
    }
    const mappedArgs = args.map(arg => {
        if (arg.startsWith('tests.deployment.')) return arg.replace('tests.deployment.', 'ops.tests.');
        if (arg.startsWith('-')) return arg;
        const relative = (path.isAbsolute(arg) ? path.relative(root, arg) : arg).replaceAll('\\', '/').replace(/^\.\//, '');
        // Absolute authored inputs must use the same export as relative ones.
        // Windows deletion admission can then see an absolute wrapper entry
        // and absolute forwarded script arguments without weakening its census.
        if (path.isAbsolute(arg) && (path.isAbsolute(relative) || relative === '..' || relative.startsWith('../'))) return arg;
        if (!fs.existsSync(path.join(root, relative))) return arg;
        const directory = fs.statSync(path.join(root, relative)).isDirectory();
        const mapped = translatePath(relative + (directory ? '/' : ''), rules).replace(/\/$/, '');
        // Windows cannot infer the cwd of another Node process from CIM. Keep
        // test runner entries explicit so deletion admission can distinguish
        // unrelated source tests without a testing-only safety exception.
        const explicitNodeEntry = executable === 'node' && !nodeEval && /\.(?:cjs|mjs|js)$/.test(relative);
        return fs.existsSync(path.join(stage, mapped)) ? (nodeTests || explicitNodeEntry ? path.join(stage, mapped) : mapped) : path.join(root, relative);
    });
    if (watch) {
        // Mirror authored files only. Electron's existing watcher reloads the UI.
        for (const directory of ['launcher/ui', 'launcher/desktop']) {
            watchers.push(fs.watch(path.join(root, directory), { recursive: true }, (_event, name) => {
                if (!name || name.split(/[\\/]/).some(part => ['node_modules', 'dist', '.cache'].includes(part))) return;
                const relative = `${directory}/${name.replaceAll('\\', '/')}`;
                const source = path.join(root, relative);
                const target = path.join(stage, translatePath(relative, rules));
                if (!fs.existsSync(source) || !fs.statSync(source).isFile()) return;
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.copyFileSync(source, target);
            }));
        }
    }
    const command = executable === 'node' ? process.execPath
        : executable === 'python' ? (process.env.NORA_TEST_PYTHON || process.env.NORA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')) : executable;
    const invocation = buildCommand(command, mappedArgs);
    const environment = withTestNodePath({ ...process.env, NORA_TEST_NODE: process.env.NORA_TEST_NODE || process.execPath,
        PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }, process.execPath);
    child = spawn(invocation.command, invocation.args, { cwd: stage, stdio: 'inherit', env: environment });
    for (const [signal, handler] of signalHandlers) process.on(signal, handler);
    process.exitCode = await new Promise((resolve, reject) => {
        let failure;
        child.once('error', error => { failure = error; });
        child.once('close', code => failure ? reject(failure) : resolve(code ?? (interrupted ? 130 : 1)));
    });
} finally {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    for (const watcher of watchers) watcher.close();
    fs.rmSync(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
