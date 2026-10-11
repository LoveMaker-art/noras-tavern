import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import { prepareBootstrap, readBootstrapLock, verifyBootstrap } from '../tooling/runtime/prepare-hermes-bootstrap.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function temporary(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-hermes-bootstrap-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function downloadLock(platform, bytes) {
    const lock = readBootstrapLock();
    lock.installers[platform].sha256 = sha(bytes); return lock;
}

test('authored Hermes inputs fix the official original scripts, source commit, version and Python ABI', () => {
    const lock = readBootstrapLock();
    assert.equal(lock.revision, '2237be355906fbe6065ce1815711eee52b2d646e');
    assert.equal(lock.hermesVersion, '0.21.1'); assert.equal(lock.pythonMajorMinor, '3.11');
    assert.equal(lock.installers.darwin.sha256, '5854b15670b51a8daae8f59ddfa917062de9f74be261eb73b4b8d719710f8968');
    assert.equal(lock.installers.win32.sha256, '226c70a90ad47e8a4d34cb11aca4ecbeb649e2f9b67fbd009ea49791de2d56f5');
});

for (const platform of ['darwin', 'win32']) {
    test(`prepare ${platform} writes only verified original bytes from the immutable official URL`, async t => {
        const root = temporary(t), output = path.join(root, 'inputs');
        const bytes = Buffer.from('original locked installer\r\n'), lock = downloadLock(platform, bytes);
        const receipt = await prepareBootstrap({ platform, output, lock, fetchImpl: async (url, options) => {
            assert.equal(url, `https://raw.githubusercontent.com/NousResearch/hermes-agent/${lock.revision}/${lock.installers[platform].path}`);
            assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
            return new Response(bytes, { status: 200 });
        } });
        assert.deepEqual(fs.readFileSync(path.join(output, receipt.installer)), bytes);
        assert.equal(receipt.sha256, sha(bytes)); assert.equal(receipt.size, bytes.length);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'bootstrap-lock.json'))), receipt);
        assert.deepEqual(fs.readdirSync(output).sort(), ['bootstrap-lock.json', receipt.installer].sort());
    });
}

test('a changed installer fails before creating the input directory and has no latest fallback', async t => {
    const output = path.join(temporary(t), 'inputs'); let requests = 0;
    await assert.rejects(prepareBootstrap({ platform: 'darwin', output, fetchImpl: async () => {
        requests++; return new Response('changed untrusted script', { status: 200 });
    } }), /checksum mismatch/);
    assert.equal(requests, 1); assert.equal(fs.existsSync(output), false);
});

test('failed download, redirected response and oversized script cannot produce executable inputs', async t => {
    const root = temporary(t);
    for (const [name, response, expected] of [
        ['status', () => new Response('missing', { status: 404 }), /download failed/],
        ['redirect', () => ({ status: 200, redirected: true }), /source changed/],
        ['size', () => new Response(Buffer.alloc(1024 * 1024 + 1)), /exceeds/],
    ]) {
        const output = path.join(root, name);
        await assert.rejects(prepareBootstrap({ platform: 'win32', output, fetchImpl: async () => response() }), expected);
        assert.equal(fs.existsSync(output), false);
    }
});

test('prepare refuses an existing output before any request or write', async t => {
    const output = temporary(t); fs.writeFileSync(path.join(output, 'keep'), 'retained');
    await assert.rejects(prepareBootstrap({ platform: 'darwin', output, fetchImpl: async () => {
        assert.fail('Existing directories must not reach the network');
    } }), /new directory/);
    assert.equal(fs.readFileSync(path.join(output, 'keep'), 'utf8'), 'retained');
});

test('a branch, alternate source repository or absent original checksum cannot be authored as a bootstrap lock', t => {
    const root = temporary(t), file = path.join(root, 'lock.json');
    for (const [change, expected] of [
        [lock => { lock.revision = 'main'; }, /immutable full commit/],
        [lock => { lock.repository = 'https://github.com/example/hermes-agent.git'; }, /official repository/],
        [lock => { lock.installers.win32.sha256 = ''; }, /original installer checksum/],
    ]) {
        const lock = readBootstrapLock(); change(lock); fs.writeFileSync(file, JSON.stringify(lock));
        assert.throws(() => readBootstrapLock(file), expected);
    }
});

function installedFixture(t, platform = 'darwin') {
    const home = temporary(t), agent = path.join(home, 'hermes-agent'); fs.mkdirSync(agent);
    const git = (...args) => execFileSync('git', ['-C', agent, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(agent, 'source.py'), 'fixed source\n'); git('add', 'source.py'); git('commit', '-m', 'fixture');
    git('remote', 'add', 'origin', 'https://github.com/NousResearch/hermes-agent.git');
    const lock = readBootstrapLock(); lock.revision = git('rev-parse', 'HEAD');
    const marker = path.join(agent, '.hermes-bootstrap-complete');
    fs.writeFileSync(marker, JSON.stringify({ schemaVersion: 1, pinnedCommit: lock.revision }));
    const python = path.join(agent, 'venv', platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    fs.mkdirSync(path.dirname(python), { recursive: true }); fs.writeFileSync(python, 'fixture interpreter');
    const hermesFile = path.join(agent, 'hermes_cli/__init__.py');
    fs.mkdirSync(path.dirname(hermesFile)); fs.writeFileSync(hermesFile, 'fixed package');
    const probe = { python: '3.11', hermes: '0.21.1', prefix: path.join(agent, 'venv'), hermesFile }, calls = [];
    const execute = (command, args, options) => {
        calls.push({ command, args });
        if (command !== python) return spawnSync(command, args, options);
        assert.deepEqual(args.slice(0, 3), ['-I', '-B', '-c']); assert.ok(options.timeout <= 30000);
        return { status: 0, stdout: JSON.stringify(probe), stderr: '' };
    };
    return { home, agent, git, lock, marker, python, probe, calls, execute, platform };
}

for (const platform of ['darwin', 'win32']) {
    test(`verify ${platform} binds the actual Git checkout, bootstrap marker and isolated venv probe`, t => {
        const fixture = installedFixture(t, platform);
        const receipt = verifyBootstrap({ hermesHome: fixture.home, ...fixture });
        assert.equal(receipt.revision, fixture.lock.revision); assert.equal(receipt.pythonMajorMinor, '3.11');
        assert.equal(receipt.marker, 'verified'); assert.equal(receipt.venv, 'verified');
        assert.equal(fixture.calls.at(-1).command, fixture.python);
        assert.equal(fixture.git('status', '--porcelain', '--untracked-files=no'), '');
    });
}

test('a newer checkout or different remote is refused before the interpreter executes', t => {
    const fixture = installedFixture(t);
    const lock = { ...fixture.lock, revision: 'f'.repeat(40) };
    assert.throws(() => verifyBootstrap({ hermesHome: fixture.home, ...fixture, lock }), /checkout differs/);
    assert.equal(fixture.calls.some(item => item.command === fixture.python), false);
    fixture.git('remote', 'set-url', 'origin', 'https://github.com/example/hermes-agent.git');
    assert.throws(() => verifyBootstrap({ hermesHome: fixture.home, ...fixture }), /different repository/);
});

test('changed tracked source cannot be sealed merely because Git HEAD is correct', t => {
    const fixture = installedFixture(t); fs.writeFileSync(path.join(fixture.agent, 'source.py'), 'changed source\n');
    assert.throws(() => verifyBootstrap({ hermesHome: fixture.home, ...fixture }), /tracked build inputs changed/);
    assert.equal(fixture.calls.some(item => item.command === fixture.python), false);
});

test('missing or incompatible bootstrap receipts preserve the runtime and reject packaging', t => {
    const fixture = installedFixture(t);
    for (const marker of [{ schemaVersion: 1, pinnedCommit: 'e'.repeat(40) },
        { schema: 1, source: 'nora-integrated-runtime', sha256: 'a'.repeat(64) }]) {
        fs.writeFileSync(fixture.marker, JSON.stringify(marker));
        assert.throws(() => verifyBootstrap({ hermesHome: fixture.home, ...fixture }), /marker differs|different install contract/);
        assert.equal(fs.readFileSync(path.join(fixture.agent, 'source.py'), 'utf8'), 'fixed source\n');
    }
    fs.rmSync(fixture.marker);
    assert.throws(() => verifyBootstrap({ hermesHome: fixture.home, ...fixture }), /Missing original Hermes bootstrap marker/);
});

test('a fallback Python ABI or unexpected Hermes version rejects the runtime before packaging', t => {
    const fixture = installedFixture(t);
    for (const python of ['3.10', '3.12', '3.14']) {
        fixture.probe.python = python;
        assert.throws(() => verifyBootstrap({ hermesHome: fixture.home, ...fixture }), /Python ABI differs/);
    }
    fixture.probe.python = '3.11'; fixture.probe.hermes = '1.0.0';
    assert.throws(() => verifyBootstrap({ hermesHome: fixture.home, ...fixture }), /Hermes version differs/);
    assert.equal(fs.existsSync(fixture.python), true);
});

test('matching versions from another venv or another checkout cannot satisfy fixed source verification', t => {
    const fixture = installedFixture(t), elsewhere = path.join(fixture.home, 'other'); fs.mkdirSync(elsewhere);
    const prefix = fixture.probe.prefix; fixture.probe.prefix = elsewhere;
    assert.throws(() => verifyBootstrap({ hermesHome: fixture.home, ...fixture }), /fixed source venv/);
    fixture.probe.prefix = prefix; fixture.probe.hermesFile = path.join(elsewhere, '__init__.py');
    fs.writeFileSync(fixture.probe.hermesFile, 'other identical version package');
    assert.throws(() => verifyBootstrap({ hermesHome: fixture.home, ...fixture }), /outside the fixed checkout/);
});
