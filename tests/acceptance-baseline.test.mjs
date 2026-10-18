import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readAcceptanceIdentity, readAcceptanceLauncherIdentity, materializeAcceptanceBaseline } from '../tooling/release/acceptance-baseline.mjs';
import * as acceptanceBaseline from '../tooling/release/acceptance-baseline.mjs';
import { assertLauncherReuse } from '../tooling/release/launcher-build-baseline.mjs';

const repository = 'LoveMaker-art/noras-tavern', tag = 'v2.5.0', origin = 'v2.4.9', commit = 'a'.repeat(40);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t, platform = 'darwin-arm64', shared = false) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-acceptance-baseline-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const [osName, arch] = platform.split('-'), bytes = { [tag]: {}, [origin]: {} }, calls = [];
    const commits = { [tag]: commit, [origin]: 'b'.repeat(40) };
    const releases = Object.fromEntries([tag, origin].map(value => [value, { tag_name: value, draft: false, prerelease: false, assets: [] }]));
    const put = (source, name, value) => {
        const data = Buffer.from(typeof value === 'object' && !Buffer.isBuffer(value) ? JSON.stringify(value) + '\n' : value);
        bytes[source][name] = data;
        const asset = { name, state: 'uploaded', size: data.length, digest: `sha256:${hash(data)}`,
            browser_download_url: `https://github.com/${repository}/releases/download/${source}/${name}` };
        const index = releases[source].assets.findIndex(item => item.name === name);
        if (index < 0) releases[source].assets.push(asset); else releases[source].assets[index] = asset;
        return asset;
    };
    const minimum = shared ? '2.1.2' : '2.1.1';
    const system = { schema: 'nora-system/v1', version: tag.slice(1), commit, candidate: false,
        channel: 'stable', platform: osName, arch, minimumLauncherVersion: minimum, files: {} };
    const references = [];
    const component = (logical, value, source = tag) => {
        const asset = `${platform}-${logical}`, entry = put(source, asset, value);
        system.files[logical] = { asset, size: entry.size, sha256: entry.digest.slice(7) };
        if (source !== tag) references.push({ name: asset, asset_release_tag: source, size: entry.size, sha256: entry.digest.slice(7) });
        return { name: logical, size: entry.size, sha256: entry.digest.slice(7) };
    };
    const archives = Object.fromEntries(['app', 'ops', 'nora-mcp'].map(part => [part, component(`${part}.tar.gz`, `historical ${part} compiled bytes`)]));
    const runtimeArchive = component('hermes.tar.gz', 'historical Node/Python environment bytes', shared ? origin : tag);
    const dependencyArchive = component('deps.tar.gz', 'historical native dependency bytes');
    const runtime = { schema: 1, platform: osName, arch, archive: runtimeArchive.name, size: runtimeArchive.size, sha256: runtimeArchive.sha256 };
    const dependencies = { schema: 1, platform: osName, arch, archive: dependencyArchive.name, size: dependencyArchive.size, sha256: dependencyArchive.sha256 };
    const identity = { schema: 'tavern-release/v2', candidate: false, dirty: false, commit, versions: { tavern: tag.slice(1) },
        bootstrap: { minimumLauncherVersion: minimum }, archives, hermesRuntime: runtime, dependencies,
        sourceFiles: { 'historical-different-app.js': 'd'.repeat(64) } };
    component('nora-hermes-runtime.json', runtime); component('nora-tavern-dependencies.json', dependencies);
    component('release-manifest.json', identity);
    put(tag, 'release-manifest.json', identity);
    put(origin, 'release-manifest.json', { ...identity, commit: 'b'.repeat(40), versions: { tavern: origin.slice(1) } });
    const systemName = `nora-system-${platform}.json`;
    const seal = () => put(tag, systemName, system);
    seal();
    if (shared) put(tag, 'release-assets.json', { schema: 'nora-release-assets/1', repository, tag, commit,
        minimumLauncherVersion: minimum, assets: references });
    const execute = args => {
        calls.push([...args]);
        if (args[0] === 'api') {
            for (const source of [tag, origin]) {
                if (args[1] === `repos/${repository}/releases/tags/${source}`) return JSON.stringify(releases[source]);
                if (args[1] === `repos/${repository}/git/ref/tags/${source}`) return JSON.stringify({ ref: `refs/tags/${source}`, object: { type: 'commit', sha: commits[source] } });
            }
            throw Error(`Unexpected API ${args[1]}`);
        }
        assert.deepEqual(args.slice(0, 2), ['release', 'download']);
        const source = args[2], asset = args[args.indexOf('--pattern') + 1], output = args[args.indexOf('--dir') + 1];
        assert.ok(bytes[source]?.[asset], `Missing physical ${source}/${asset}`);
        fs.writeFileSync(path.join(output, asset), bytes[source][asset], { flag: 'wx' });
        return '';
    };
    const options = { repository, tag, platform, expectedCommit: commit, execute };
    return { directory, bytes, releases, calls, put, component, seal, system, identity, runtime, options, systemName, commits };
}

for (const platform of ['darwin-arm64', 'darwin-x64', 'win32-x64']) for (const shared of [false, true]) {
    test(`${platform} ${shared ? 'shared' : 'legacy'}: full historical closure is bound to published tag and can differ from current compiler inputs`, t => {
        const f = fixture(t, platform, shared), output = path.join(f.directory, 'payload');
        const receipt = materializeAcceptanceBaseline({ ...f.options, output });
        assert.equal(receipt.schema, 'nora-acceptance-baseline/1'); assert.equal(receipt.mode, 'materialized');
        assert.equal(receipt.tag, tag); assert.equal(receipt.commit, commit); assert.equal(receipt.version, tag.slice(1));
        assert.equal(receipt.verifiedFiles, Object.keys(f.system.files).length);
        assert.equal(receipt.payloadManifestSha256, hash(fs.readFileSync(path.join(output, 'release-manifest.json'))));
        assert.equal(receipt.systemManifestSha256, hash(fs.readFileSync(path.join(output, 'nora-system.json'))));
        assert.equal(receipt.catalogueSha256, hash(fs.readFileSync(path.join(output, 'baseline-asset-catalogue.json'))));
        for (const [logical, entry] of Object.entries(f.system.files)) {
            assert.equal(hash(fs.readFileSync(path.join(output, logical))), entry.sha256);
            assert.equal(receipt.files[logical].asset, entry.asset);
        }
        const downloads = f.calls.filter(args => args[0] === 'release' && args[args.indexOf('--pattern') + 1] === `${platform}-hermes.tar.gz`);
        assert.equal(downloads.length, 1); assert.equal(downloads[0][2], shared ? origin : tag);
        assert.ok(!fs.readdirSync(output).some(name => name.startsWith('.asset-download-')));
        assert.throws(() => materializeAcceptanceBaseline({ ...f.options, output }), /new directory/);
    });
}

test('APP history identity reads official descriptor bytes and binds the archived APP digest',t=>{
    const f=fixture(t),asset='Nora-Tavern-Launcher-2.2.2-darwin-arm64-update.zip',archive=f.put(tag,asset,'official APP bytes');
    const descriptor={schema:'nora-launcher/v1',candidate:false,platform:'darwin',arch:'arm64',version:'2.2.2',commit,
        asset,sha256:archive.digest.slice(7),size:archive.size};
    const sealed=f.put(tag,'nora-launcher-darwin-arm64.json',descriptor);
    assert.deepEqual(readAcceptanceLauncherIdentity(f.options),{version:'2.2.2',commit,descriptorSha256:sealed.digest.slice(7),
        archiveSha256:descriptor.sha256,archiveSize:archive.size});
    assert.equal(f.calls.filter(call=>call[0]==='release'&&call[call.indexOf('--pattern')+1]===asset).length,0,
        'identity-only source verification does not pretend to have accepted an old native executable');
    f.put(tag,'nora-launcher-darwin-arm64.json',{...descriptor,sha256:'0'.repeat(64)});
    assert.throws(()=>readAcceptanceLauncherIdentity(f.options));
});

test('native APP acceptance materializes the exact published archive and source receipt without reusing compiler outputs', t => {
    const f = fixture(t, 'win32-x64'), asset = 'Nora-Tavern-Launcher-2.2.2-win32-x64-update.zip';
    const archive = f.put(tag, asset, 'official native APP archive bytes');
    const descriptor = { schema: 'nora-launcher/v1', candidate: false, platform: 'win32', arch: 'x64', version: '2.2.2', commit,
        asset, sha256: archive.digest.slice(7), size: archive.size };
    const metadata = f.put(tag, 'nora-launcher-win32-x64.json', descriptor), output = path.join(f.directory, 'published-app');
    const proof = acceptanceBaseline.materializeAcceptanceLauncher({ ...f.options, output });
    assert.equal(proof.schema, 'nora-acceptance-launcher/1'); assert.equal(proof.mode, 'materialized');
    assert.equal(proof.repository, repository); assert.equal(proof.tag, tag); assert.equal(proof.platform, 'win32-x64');
    assert.equal(proof.commit, commit); assert.equal(proof.version, '2.2.2');
    assert.equal(proof.descriptorSha256, metadata.digest.slice(7)); assert.equal(proof.archiveSha256, descriptor.sha256);
    assert.equal(hash(fs.readFileSync(path.join(output, asset))), descriptor.sha256);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'baseline-launcher-source-receipt.json'))), proof);
    assert.throws(() => acceptanceBaseline.materializeAcceptanceLauncher({ ...f.options, output }), /new directory/);
});

test('native APP materialization refuses corrupt archive or a moved source tag and preserves no false receipt', t => {
    const f = fixture(t), asset = 'Nora-Tavern-Launcher-2.2.2-darwin-arm64-update.zip';
    const archive = f.put(tag, asset, 'official APP bytes');
    f.put(tag, 'nora-launcher-darwin-arm64.json', { schema: 'nora-launcher/v1', candidate: false, platform: 'darwin', arch: 'arm64',
        version: '2.2.2', commit, asset, sha256: archive.digest.slice(7), size: archive.size });
    const output = path.join(f.directory, 'rejected-app');
    assert.throws(() => acceptanceBaseline.materializeAcceptanceLauncher({ ...f.options, output, expectedCommit: 'f'.repeat(40) }), /selected commit/);
    assert.equal(fs.existsSync(output), false);
    f.bytes[tag][asset][0] ^= 1;
    assert.throws(() => acceptanceBaseline.materializeAcceptanceLauncher({ ...f.options, output }), /checksum/);
    assert.equal(fs.existsSync(output), false);
});

test('metadata-only receipt records limited verification and downloads no business/environment archives', t => {
    const f = fixture(t, 'win32-x64', true), output = path.join(f.directory, 'identity');
    const remote = readAcceptanceIdentity(f.options);
    assert.equal(remote.mode, 'identity-only'); assert.equal(remote.verifiedFiles, 3); assert.equal(remote.declaredFiles, 8);
    const local = materializeAcceptanceBaseline({ ...f.options, output, identityOnly: true });
    assert.equal(local.payloadManifestSha256, remote.payloadManifestSha256);
    assert.equal(local.catalogueSha256, remote.catalogueSha256);
    assert.ok(f.calls.filter(args => args[0] === 'release').every(args => !args[args.indexOf('--pattern') + 1].endsWith('.tar.gz')));
    assert.ok(!fs.existsSync(path.join(output, 'hermes.tar.gz')));
});

test('missing published component, wrong platform, foreign logical asset and metadata checksum fail before materialization', t => {
    for (const mutate of [f => delete f.system.files['hermes.tar.gz'], f => f.system.arch = 'wrong',
        f => f.system.files['hermes.tar.gz'].asset = 'win32-x64-hermes.tar.gz',
        f => f.system.files['hermes.tar.gz'].sha256 = 'f'.repeat(64),
        f => f.releases[tag].assets.splice(f.releases[tag].assets.findIndex(asset => asset.name.endsWith('-hermes.tar.gz')), 1),
        f => f.system.files['release-manifest.json'].asset = '../release-manifest.json']) {
        const f = fixture(t); mutate(f); f.seal(); const output = path.join(f.directory, 'payload');
        assert.throws(() => materializeAcceptanceBaseline({ ...f.options, output }));
        assert.ok(!fs.existsSync(output));
    }
});

test('corrupt archive download removes incomplete private payload and never emits an acceptance receipt', t => {
    const f = fixture(t, 'darwin-x64', true), output = path.join(f.directory, 'payload');
    f.bytes[origin]['darwin-x64-hermes.tar.gz'][0] ^= 1;
    assert.throws(() => materializeAcceptanceBaseline({ ...f.options, output }), /checksum/);
    assert.ok(!fs.existsSync(output));
});

test('descriptor and expected tag commit remain mandatory despite matching archive hashes', t => {
    const f = fixture(t), output = path.join(f.directory, 'payload');
    assert.throws(() => materializeAcceptanceBaseline({ ...f.options, output, expectedCommit: 'e'.repeat(40) }), /selected commit/);
    f.component('nora-hermes-runtime.json', { ...f.runtime, arch: 'wrong' }); f.seal();
    assert.throws(() => materializeAcceptanceBaseline({ ...f.options, output }));
    assert.ok(!fs.existsSync(output));
});

test('acceptance-only helper edits do not authorize or force compiler/environment reuse', () => {
    const sourceFiles = Object.fromEntries(['app/engine/sillytavern/package-lock.json', 'nora-mcp/npm-shrinkwrap.json',
        'tooling/source-layout.json', 'tooling/release/package-hermes-runtime.mjs'].map(name => [name, 'a'.repeat(64)]));
    const before = { schema: 'tavern-release/v2', candidate: false, dirty: false, commit, sourceFiles };
    const after = { ...before, sourceFiles: { ...sourceFiles, 'tooling/release/acceptance-baseline.mjs': 'b'.repeat(64) } };
    assert.deepEqual(assertLauncherReuse(after, before), ['tooling/release/acceptance-baseline.mjs']);
    const file = fileURLToPath(new URL('../tooling/release/acceptance-baseline.mjs', import.meta.url));
    const help = spawnSync(process.execPath, [file, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0); assert.match(help.stdout, /--identity-only/); assert.match(help.stdout, /never build, publish, or authorize runtime reuse/);
});

test('APP-only published baseline authenticates product separately and materializes the unchanged actual core manifest', t => {
 const f=fixture(t,'win32-x64');
 const core={...f.identity,versions:{tavern:'2.4.9'}},coreFile=f.component('release-manifest.json',core);
 const reference={schema:'nora-core-reference/1',tag:'v2.4.9',commit,manifests:{'win32-x64':{asset:'win32-x64-release-manifest.json',sha256:coreFile.sha256,size:coreFile.size}}};
 const product={...core,commit:'e'.repeat(40),publication:{schema:'nora-component-publication/1',tag},coreRelease:reference};
 f.commits[tag]=product.commit;f.put(tag,'release-manifest.json',product);
 Object.assign(f.system,{commit:product.commit,version:'2.4.9',publication:product.publication,coreRelease:reference});f.seal();
 const output=path.join(f.directory,'retained-core');
 const receipt=materializeAcceptanceBaseline({...f.options,expectedCommit:product.commit,output});
 assert.equal(receipt.commit,commit);assert.equal(receipt.productCommit,product.commit);assert.equal(receipt.coreTag,'v2.4.9');
 assert.equal(receipt.payloadManifestSha256,coreFile.sha256);assert.equal(receipt.version,'2.4.9');
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output,'release-manifest.json'))),core);
 f.system.coreRelease={...reference,commit:'f'.repeat(40)};f.seal();
 assert.throws(()=>materializeAcceptanceBaseline({...f.options,expectedCommit:product.commit,output:path.join(f.directory,'forged-core')}));
});
