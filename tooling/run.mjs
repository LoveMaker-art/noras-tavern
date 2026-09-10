#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createReleaseSource } from './release/release-source.mjs';
import { readLayout, translatePath } from './layout.mjs';
import { buildCommand } from './release/build-commands.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
        const source = path.join(root, directory);
        if (!fs.existsSync(source)) continue;
        const target = path.join(stage, translatePath(directory, rules));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.symlinkSync(fs.realpathSync(source), target, process.platform === 'win32' ? 'junction' : 'dir');
    }
    const mappedArgs = args.map(arg => {
        if (arg.startsWith('tests.deployment.')) return arg.replace('tests.deployment.', 'ops.tests.');
        if (arg.startsWith('-') || path.isAbsolute(arg)) return arg;
        const relative = arg.replaceAll('\\', '/').replace(/^\.\//, '');
        if (!fs.existsSync(path.join(root, relative))) return arg;
        const directory = fs.statSync(path.join(root, relative)).isDirectory();
        const mapped = translatePath(relative + (directory ? '/' : ''), rules).replace(/\/$/, '');
        return fs.existsSync(path.join(stage, mapped)) ? mapped : path.join(root, relative);
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
        : executable === 'python' ? (process.env.NORA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')) : executable;
    const invocation = buildCommand(command, mappedArgs);
    child = spawn(invocation.command, invocation.args, { cwd: stage, stdio: 'inherit', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    for (const [signal, handler] of signalHandlers) process.on(signal, handler);
    process.exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => resolve(code ?? (interrupted ? 130 : 1)));
    });
} finally {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    for (const watcher of watchers) watcher.close();
    fs.rmSync(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
