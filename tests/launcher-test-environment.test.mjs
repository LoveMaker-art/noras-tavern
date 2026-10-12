import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { checkLauncherTestEnvironment, withTestNodePath } from '../tooling/checks/launcher-test-environment.mjs';

function fixture() {
    const node = { executable: process.execPath, node: '24.0.0', bun: null, platform: process.platform, arch: process.arch };
    const python = { executable: process.execPath, version: [3, 11, 0], prefix: os.tmpdir(), basePrefix: os.tmpdir(), psutil: '7.0.0', yaml: '6.0.2' };
    let dependencyChecks = 0, calls = [];
    const options = { environment: { PATH: 'fixture-path', NORA_PYTHON: 'source-python' },
        checkLinks: () => {},
        loadDependencies: () => { dependencyChecks++; return { directory: os.tmpdir() }; },
        run: (command, args, settings) => {
            calls.push({ command, args, settings });
            if(command==='openssl')return {status:0,stdout:'OpenSSL 3.0.0 fixture'};
            return { status: 0, stdout: JSON.stringify(args[0] === '-p' ? node : python) };
        } };
    return { node, python, options, calls, get dependencyChecks() { return dependencyChecks; } };
}

test('a compatibility shim, old Node or mismatched platform fails before running tests or Python', () => {
    for (const changes of [{ bun: '1.0.0' }, { node: '22.0.0' }, { platform: 'fixture-other-os' }, { arch: 'fixture-other-arch' }]) {
        const f = fixture(); Object.assign(f.node, changes);
        assert.throws(() => checkLauncherTestEnvironment(f.options), error => error.code === 'LAUNCHER_TEST_ENVIRONMENT_INVALID' && error.check === 'node');
        assert.equal(f.calls.length, 1); assert.equal(f.dependencyChecks, 0);
    }
});

test('an explicit unavailable interpreter cannot fall back or become a skipped success', () => {
    const f = fixture(); f.options.environment.NORA_TEST_PYTHON = path.join(os.tmpdir(), 'missing-python-fixture');
    f.options.run = (command, args) => command === 'openssl' ? {status:0,stdout:'OpenSSL 3.0.0 fixture'} : command === 'powershell.exe' ? { status: 0, stdout: '5.1' }
        : args[0] === '-p' ? { status: 0, stdout: JSON.stringify(f.node) }
        : { status: null, error: Object.assign(new Error('missing fixture'), { code: 'ENOENT' }) };
    assert.throws(() => checkLauncherTestEnvironment(f.options), error => error.category === 'test_environment' && error.check === 'python' && /ENOENT/.test(error.message));
});

test('missing Python packages and wrong native bindings are prerequisite failures', () => {
    const python = fixture();
    python.options.run = (command, args) => command === 'openssl' ? {status:0,stdout:'OpenSSL 3.0.0 fixture'} : command === 'powershell.exe' ? { status: 0, stdout: '5.1' }
        : args[0] === '-p' ? { status: 0, stdout: JSON.stringify(python.node) }
        : { status: 1, stderr: "ModuleNotFoundError: No module named 'psutil'" };
    assert.throws(() => checkLauncherTestEnvironment(python.options), error => error.check === 'python' && /missing dependency: psutil/.test(error.message));
    const native = fixture(); native.options.loadDependencies = () => { throw Object.assign(new Error('wrong ABI'), { code: 'ERR_DLOPEN_FAILED' }); };
    assert.throws(() => checkLauncherTestEnvironment(native.options), error => error.check === 'desktop_dependencies' && error.cause.code === 'ERR_DLOPEN_FAILED');
});
test('source TLS prerequisites reject a missing or denied OpenSSL before fixtures or Python start',()=>{
    for(const failure of [{status:null,error:Object.assign(new Error('missing openssl'),{code:'ENOENT'})},
        {status:null,error:Object.assign(new Error('denied openssl'),{code:'EACCES'})},{status:1,stderr:'openssl unavailable'}]){
        const f=fixture(),run=f.options.run;let pythonCalls=0;
        f.options.run=(command,args,settings)=>{if(command==='openssl')return failure;if(args[0]==='-B')pythonCalls++;return run(command,args,settings);};
        assert.throws(()=>checkLauncherTestEnvironment(f.options),error=>error.category==='test_environment'&&error.check==='tls_tools');
        assert.equal(pythonCalls,0);
    }
});
test('source TLS prerequisites accept the actual OpenSSL and macOS LibreSSL command families',()=>{
    for(const version of ['OpenSSL 3.5.7','LibreSSL 3.3.6']){
        const f=fixture(),run=f.options.run;
        f.options.run=(command,args,settings)=>command==='openssl'?{status:0,stdout:version}:run(command,args,settings);
        assert.equal(checkLauncherTestEnvironment(f.options).facts.openssl.version,version);
    }
});

test('validated interpreter paths and UTF-8 replace stale caller settings without changing its environment', () => {
    const f = fixture(); Object.assign(f.options.environment, { PYTHONHOME: 'stale', PYTHONPATH: 'stale', __PYVENV_LAUNCHER__: 'stale', NORA_OPERATION_JOB_ID: 'stale' });
    const before = { ...f.options.environment }, result = checkLauncherTestEnvironment(f.options);
    assert.equal(result.environment.NORA_TEST_NODE, process.execPath);
    assert.equal(result.environment.NORA_PYTHON, f.python.executable);
    assert.equal(result.environment.NORA_TEST_PYTHON, f.python.executable);
    assert.ok(result.environment.PATH.startsWith(path.dirname(process.execPath) + path.delimiter));
    for (const key of ['PYTHONHOME', 'PYTHONPATH', '__PYVENV_LAUNCHER__', 'NORA_OPERATION_JOB_ID']) assert.equal(result.environment[key], undefined);
    assert.equal(result.environment.PYTHONIOENCODING, 'utf-8'); assert.deepEqual(f.options.environment, before);
});

test('native or receiver validation cannot succeed from source-only fixture inputs', () => {
    for (const profile of ['native', 'receiver']) {
        const f = fixture(); f.options.profile = profile;
        assert.throws(() => checkLauncherTestEnvironment(f.options), error => error.category === 'test_environment');
    }
});

test('a changed explicit Python identity is rejected before native work', t => {
    const f = fixture(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-env-identity-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const wrong = path.join(root, 'wrong-python'); fs.writeFileSync(wrong, 'fixture');
    f.options.environment.NORA_TEST_PYTHON = wrong;
    assert.throws(() => checkLauncherTestEnvironment(f.options), error => error.check === 'python' && /identity changed/.test(error.message));
});

test('source fixtures cannot start when the platform cannot create their file and directory links', () => {
    const f = fixture();
    f.options.checkLinks = () => { throw Object.assign(new Error('fixture links denied'), { code: 'EPERM' }); };
    assert.throws(() => checkLauncherTestEnvironment(f.options), error => error.check === 'native_links' && error.cause.code === 'EPERM');
});

test('receiver protocol comparison ignores object key order but retains field and array content', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-env-receiver-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const desktop = path.join(directory, 'ops/installer/desktop'), landing = path.join(directory, 'receiver');
    fs.mkdirSync(desktop, { recursive: true }); fs.mkdirSync(path.join(landing, 'server'), { recursive: true });
    fs.writeFileSync(path.join(desktop, 'telemetry-contract.json'), '{"schema":1,"choices":["a","b"]}');
    fs.writeFileSync(path.join(landing, 'server/launcher-contract.json'), '{"choices":["a","b"],"schema":1}');
    for (const name of ['server/worker.mjs', 'migrations/0005_launcher_events.sql', 'migrations/0006_launcher_error_details.sql',
        'migrations/0007_launcher_fault_packets.sql', 'migrations/0008_launcher_operation_logs.sql']) {
        const file = path.join(landing, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fixture');
    }
    const f = fixture(); Object.assign(f.options, { profile: 'receiver', root: directory }); f.options.environment.NORA_LANDING_ROOT = landing;
    assert.equal(checkLauncherTestEnvironment(f.options).facts.profile, 'receiver');
    fs.writeFileSync(path.join(landing, 'server/launcher-contract.json'), '{"choices":["b","a"],"schema":1}');
    assert.throws(() => checkLauncherTestEnvironment(f.options), error => error.check === 'receiver');
});

test('explicitly empty interpreter inputs are not treated as an absent optional override', () => {
    for (const name of ['NORA_TEST_NODE', 'NORA_TEST_PYTHON']) {
        const f = fixture(); f.options.environment[name] = '';
        assert.throws(() => checkLauncherTestEnvironment(f.options), error => /explicitly empty/.test(error.message));
    }
});

test('Windows Path is retained under one key when the test Node directory is prepended', () => {
    const original = { Path: 'C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0', OTHER: 'retained' };
    const normalized = withTestNodePath(original, 'C:\\fixture\\node.exe', 'win32');
    assert.deepEqual(Object.keys(normalized).filter(key => /^path$/i.test(key)), ['PATH']);
    assert.equal(normalized.PATH, 'C:\\fixture;' + original.Path);
    assert.equal(normalized.OTHER, 'retained');
    assert.equal(Object.hasOwn(original, 'PATH'), false);
    const duplicate = withTestNodePath({ Path: 'discarded', PATH: 'first-existing-value' }, 'C:\\fixture\\node.exe', 'win32');
    assert.deepEqual(Object.keys(duplicate).filter(key => /^path$/i.test(key)), ['PATH']);
    assert.equal(duplicate.PATH, 'C:\\fixture;first-existing-value');
});

test('POSIX PATH normalization preserves distinct case-sensitive variables', () => {
    const normalized = withTestNodePath({ PATH: '/usr/bin', Path: 'unrelated' }, '/fixture/node', 'darwin');
    assert.equal(normalized.PATH, '/fixture:/usr/bin');
    assert.equal(normalized.Path, 'unrelated');
});

test('a CLI reached through a filesystem alias still rejects invalid prerequisites', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-env-cli-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const target = fileURLToPath(new URL('../tooling/checks/launcher-test-environment.mjs', import.meta.url));
    const alias = path.join(directory, 'environment.mjs');
    fs.symlinkSync(target, alias, 'file');
    const result = spawnSync(process.execPath, [alias, 'source'], {
        env: { ...process.env, NORA_TEST_NODE: '' }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 2, 'The CLI must execute its check even when argv and the ESM URL use different paths');
    assert.equal(JSON.parse(result.stderr).category, 'test_environment');
    const gateAlias = path.join(directory, 'stability.mjs');
    fs.symlinkSync(fileURLToPath(new URL('../tooling/checks/verify-launcher-stability.mjs', import.meta.url)), gateAlias, 'file');
    const gate = spawnSync(process.execPath, [gateAlias], {
        env: { ...process.env, NORA_TEST_NODE: '' }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(gate.status, 2, 'The stability gate must also reject invalid prerequisites through an alias');
    assert.match(gate.stderr, /NORA_TEST_NODE is explicitly empty/);
});
