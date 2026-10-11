#!/usr/bin/env node
// Fix build inputs only. This helper never executes an installer or changes a runtime.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const lockFile = fileURLToPath(new URL('./hermes-bootstrap.lock.json', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const filenames = { darwin: 'install.sh', win32: 'install.ps1' };
const MAX_SCRIPT_BYTES = 1024 * 1024;

export function readBootstrapLock(file = lockFile) {
    const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(lock.schema, 'nora-hermes-bootstrap/1', 'Unsupported Hermes bootstrap lock');
    assert.equal(lock.repository, 'https://github.com/NousResearch/hermes-agent.git', 'Hermes must use its official repository');
    assert.match(lock.revision || '', /^[a-f0-9]{40}$/, 'Hermes must use an immutable full commit');
    assert.match(lock.hermesVersion || '', /^\d+\.\d+\.\d+$/, 'Missing fixed Hermes version');
    assert.match(lock.pythonMajorMinor || '', /^3\.\d+$/, 'Missing fixed Python ABI');
    assert.deepEqual(Object.keys(lock.installers || {}).sort(), ['darwin', 'win32']);
    for (const [platform, filename] of Object.entries(filenames)) {
        assert.equal(lock.installers[platform]?.path, `scripts/${filename}`, 'Unexpected Hermes installer path');
        assert.match(lock.installers[platform]?.sha256 || '', /^[a-f0-9]{64}$/, 'Missing original installer checksum');
    }
    return lock;
}

export async function prepareBootstrap({ platform, output, fetchImpl = globalThis.fetch, lock = readBootstrapLock() } = {}) {
    assert.ok(filenames[platform], 'Select darwin or win32');
    assert.ok(typeof output === 'string' && output, 'Specify a new build input directory');
    output = path.resolve(output);
    assert.notEqual(output, path.parse(output).root, 'Do not use a filesystem root');
    assert.ok(!fs.lstatSync(output, { throwIfNoEntry: false }), 'Hermes bootstrap output must be a new directory');
    const input = lock.installers[platform];
    const url = `https://raw.githubusercontent.com/NousResearch/hermes-agent/${lock.revision}/${input.path}`;
    const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(45000) });
    assert.equal(response.status, 200, 'Fixed Hermes installer download failed');
    assert.ok(!response.redirected && (!response.url || response.url === url), 'Hermes installer source changed');
    assert.ok(response.body, 'Empty Hermes installer response');
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            assert.ok(size <= MAX_SCRIPT_BYTES, 'Hermes installer exceeds the build input limit');
            chunks.push(Buffer.from(value));
        }
    } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
    } finally { reader.releaseLock(); }
    const bytes = Buffer.concat(chunks);
    assert.ok(size > 0, 'Empty Hermes installer');
    assert.equal(hash(bytes), input.sha256, 'Fixed Hermes installer checksum mismatch');
    // No path is written until all downloaded bytes match the authored lock.
    fs.mkdirSync(output, { recursive: true, mode: 0o700 });
    const receipt = { schema: 'nora-hermes-bootstrap-input/1', repository: lock.repository,
        revision: lock.revision, hermesVersion: lock.hermesVersion, pythonMajorMinor: lock.pythonMajorMinor,
        platform, url, installer: filenames[platform], sha256: input.sha256, size };
    fs.writeFileSync(path.join(output, filenames[platform]), bytes, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(output, 'bootstrap-lock.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return receipt;
}

function checked(command, args, execute) {
    const result = execute(command, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, windowsHide: true });
    assert.ok(!result.error && result.status === 0, `Cannot verify fixed Hermes input: ${command}`);
    return result.stdout.trim();
}

export function verifyBootstrap({ platform, hermesHome, execute = spawnSync, lock = readBootstrapLock() } = {}) {
    assert.ok(filenames[platform], 'Select darwin or win32');
    assert.ok(typeof hermesHome === 'string' && hermesHome, 'Specify the CI Hermes directory');
    const agent = path.join(path.resolve(hermesHome), 'hermes-agent');
    assert.ok(fs.lstatSync(agent, { throwIfNoEntry: false })?.isDirectory(), 'Missing ordinary Hermes source directory');
    const git = (...args) => checked('git', ['-C', agent, ...args], execute);
    assert.equal(git('rev-parse', 'HEAD'), lock.revision, 'Hermes checkout differs from its locked commit');
    const origin = git('remote', 'get-url', 'origin');
    assert.ok([lock.repository, lock.repository.replace(/\.git$/, ''),
        'git@github.com:NousResearch/hermes-agent.git'].includes(origin), 'Hermes checkout uses a different repository');
    assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'Hermes tracked build inputs changed after checkout');
    const markerFile = path.join(agent, '.hermes-bootstrap-complete');
    assert.ok(fs.lstatSync(markerFile, { throwIfNoEntry: false })?.isFile(), 'Missing original Hermes bootstrap marker');
    assert.ok(fs.statSync(markerFile).size <= 16384, 'Hermes bootstrap marker exceeds limit');
    const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
    assert.equal(marker.schemaVersion, 1, 'Hermes bootstrap marker uses a different install contract');
    assert.equal(marker.pinnedCommit, lock.revision, 'Hermes bootstrap marker differs from its locked commit');
    const venv = path.join(agent, 'venv');
    assert.ok(fs.lstatSync(venv, { throwIfNoEntry: false })?.isDirectory(), 'Missing original Hermes venv layout');
    const python = path.join(venv, platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    assert.ok(fs.statSync(python, { throwIfNoEntry: false })?.isFile(), 'Missing Hermes venv interpreter');
    const probe = JSON.parse(checked(python, ['-I', '-B', '-c',
        'import json,sys,hermes_cli;print(json.dumps({"python":"%s.%s"%sys.version_info[:2],"hermes":hermes_cli.__version__,"prefix":sys.prefix,"hermesFile":hermes_cli.__file__}))'], execute));
    assert.equal(probe.python, lock.pythonMajorMinor, 'Hermes Python ABI differs from the locked build input');
    assert.equal(probe.hermes, lock.hermesVersion, 'Hermes version differs from the locked build input');
    const canonical = file => {
        assert.ok(typeof file === 'string' && path.isAbsolute(file), 'Missing absolute Hermes probe origin');
        const resolved = fs.realpathSync(file); return platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    assert.equal(canonical(probe.prefix), canonical(venv), 'Hermes probe did not execute in the fixed source venv');
    assert.equal(canonical(probe.hermesFile), canonical(path.join(agent, 'hermes_cli/__init__.py')),
        'Hermes probe imported a package outside the fixed checkout');
    return { schema: 'nora-hermes-bootstrap-verification/1', platform, repository: lock.repository,
        revision: lock.revision, hermesVersion: probe.hermes, pythonMajorMinor: probe.python,
        source: 'verified-fixed-checkout', marker: 'verified', venv: 'verified' };
}

async function main() {
    const flags = new Set(), values = {};
    for (let i = 2; i < process.argv.length; i++) {
        const option = process.argv[i];
        if (['--prepare', '--verify', '--revision'].includes(option)) {
            assert.ok(!flags.has(option), 'Duplicate action'); flags.add(option); continue;
        }
        assert.ok(['--platform', '--output', '--hermes-home'].includes(option) && !values[option], 'Unknown or duplicate option');
        const value = process.argv[++i]; assert.ok(value && !value.startsWith('--'), 'Missing option value'); values[option] = value;
    }
    assert.equal(flags.size, 1, 'Select exactly one of --prepare, --verify or --revision');
    if (flags.has('--revision')) { assert.equal(Object.keys(values).length, 0); console.log(readBootstrapLock().revision); return; }
    if (flags.has('--prepare')) {
        assert.ok(!values['--hermes-home'], '--prepare does not change or inspect runtimes');
        console.log(JSON.stringify(await prepareBootstrap({ platform: values['--platform'], output: values['--output'] }), null, 2));
    } else {
        assert.ok(!values['--output'], '--verify is read-only');
        console.log(JSON.stringify(verifyBootstrap({ platform: values['--platform'], hermesHome: values['--hermes-home'] }), null, 2));
    }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
