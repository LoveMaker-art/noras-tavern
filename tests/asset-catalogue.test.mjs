import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expandAssetCatalogue, readAssetCatalogue, downloadCatalogueAsset, assertBaselineCatalogue, REPOSITORY } from '../tooling/release/asset-catalogue.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const current = 'v2.5.1', origin = 'v2.5.0', commit = 'b'.repeat(40), originCommit = 'a'.repeat(40);
const archive = 'nora-hermes-runtime-darwin-arm64.tar.gz';
function fixture(t, shared = true) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-catalogue-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const files = {}, releases = {}, calls = [];
    for (const tag of [current, origin]) {
        files[tag] = {};
        releases[tag] = { tag_name: tag, draft: false, prerelease: false, assets: [] };
    }
    const put = (tag, name, bytes) => {
        bytes = Buffer.from(typeof bytes === 'object' && !Buffer.isBuffer(bytes) ? JSON.stringify(bytes) + '\n' : bytes);
        files[tag][name] = bytes;
        const entry = { name, size: bytes.length, state: 'uploaded', digest: `sha256:${hash(bytes)}`,
            browser_download_url: `https://github.com/${REPOSITORY}/releases/download/${tag}/${name}` };
        const assets = releases[tag].assets, index = assets.findIndex(item => item.name === name);
        if (index >= 0) assets[index] = entry; else assets.push(entry);
        return entry;
    };
    put(current, 'release-manifest.json', { schema: 'tavern-release/v2', commit, candidate: false, dirty: false,
        versions: { tavern: current.slice(1) }, bootstrap: { minimumLauncherVersion: '2.1.2' } });
    const entry = put(shared ? origin : current, archive, 'accepted unchanged environment bytes');
    put(origin, 'release-manifest.json', { schema: 'tavern-release/v2', commit: originCommit, candidate: false, dirty: false,
        versions: { tavern: origin.slice(1) }, bootstrap: { minimumLauncherVersion: '2.1.1' } });
    let index = { schema: 'nora-release-assets/1', repository: REPOSITORY, tag: current, commit,
        minimumLauncherVersion: '2.1.2', assets: [{ name: archive, asset_release_tag: origin, size: entry.size, sha256: entry.digest.slice(7) }] };
    const sealIndex = () => { if (shared) put(current, 'release-assets.json', index); };
    sealIndex();
    const execute = args => {
        calls.push([...args]);
        if (args[0] === 'api') {
            const resource = args[1];
            for (const tag of [current, origin]) {
                if (resource === `repos/${REPOSITORY}/releases/tags/${tag}`) return JSON.stringify(releases[tag]);
                if (resource === `repos/${REPOSITORY}/git/ref/tags/${tag}`) return JSON.stringify({ ref: `refs/tags/${tag}`, object: {
                    type: tag === current ? 'tag' : 'commit', sha: tag === current ? 'c'.repeat(40) : originCommit } });
            }
            if (resource === `repos/${REPOSITORY}/git/tags/${'c'.repeat(40)}`) return JSON.stringify({ sha: 'c'.repeat(40), object: { type: 'commit', sha: commit } });
            throw Error(`Unexpected API ${resource}`);
        }
        assert.deepEqual(args.slice(0, 2), ['release', 'download']);
        const tag = args[2], name = args[args.indexOf('--pattern') + 1], output = args[args.indexOf('--dir') + 1];
        assert.equal(args[args.indexOf('--repo') + 1], REPOSITORY);
        assert.ok(files[tag]?.[name], `Missing physical asset ${tag}/${name}`);
        fs.writeFileSync(path.join(output, name), files[tag][name], { flag: 'wx' });
        return '';
    };
    const expand = () => expandAssetCatalogue({ repository: REPOSITORY, tag: current, commit,
        release: releases[current], indexText: shared ? files[current]['release-assets.json'].toString() : null,
        origins: { [origin]: releases[origin] }, originCommits: { [origin]: originCommit },
        manifestTexts: Object.fromEntries([current, origin].map(tag => [tag, files[tag]['release-manifest.json'].toString()])) });
    return { directory, files, releases, calls, put, index, sealIndex, execute, expand, entry };
}

test('regression: a shared baseline lacks a physical current-tag archive; verified original tag download succeeds', t => {
    const f = fixture(t);
    // The old consumer's exact current-tag command fails before any packaging.
    assert.throws(() => f.execute(['release', 'download', current, '--repo', REPOSITORY, '--pattern', archive, '--dir', f.directory]), /Missing physical asset/);
    const catalogue = readAssetCatalogue({ tag: current, execute: f.execute });
    assert.equal(catalogue.commit, commit); assert.equal(catalogue.originCommits[origin], originCommit);
    const asset = catalogue.release.assets.find(item => item.name === archive);
    assert.equal(asset.asset_release_tag, origin);
    const file = downloadCatalogueAsset(catalogue, archive, f.directory, { execute: f.execute,
        expected: { size: f.entry.size, sha256: f.entry.digest.slice(7) } });
    assert.equal(hash(fs.readFileSync(file)), f.entry.digest.slice(7));
    assert.equal(f.calls.at(-1)[2], origin);
    assert.ok(!fs.readdirSync(f.directory).some(name => name.startsWith('.asset-download-')));
});

test('legacy release without index retains its current-tag route and verifies full bytes', t => {
    const f = fixture(t, false), catalogue = readAssetCatalogue({ tag: current, execute: f.execute });
    assert.equal(catalogue.release.assetIndexText, undefined);
    assert.deepEqual(catalogue.originCommits, { [current]: commit });
    downloadCatalogueAsset(catalogue, archive, f.directory, { execute: f.execute });
    assert.equal(f.calls.at(-1)[2], current);
});

test('logical target names are independent from a colliding physical basename', t => {
    const f = fixture(t), catalogue = f.expand();
    fs.writeFileSync(path.join(f.directory, 'release-manifest.json'), 'platform-specific manifest already validated');
    const target = downloadCatalogueAsset(catalogue, 'release-manifest.json', f.directory, { execute: f.execute, targetName: 'shared-release-manifest.json' });
    assert.equal(JSON.parse(fs.readFileSync(target)).commit, commit);
    assert.equal(fs.readFileSync(path.join(f.directory, 'release-manifest.json'), 'utf8'), 'platform-specific manifest already validated');
    assert.throws(() => downloadCatalogueAsset(catalogue, 'release-manifest.json', f.directory, { execute: f.execute, targetName: 'shared-release-manifest.json' }), /already exists/);
});

test('index raw bytes are bound to API size/digest; corrupt downloaded archives never reach target', t => {
    const f = fixture(t);
    f.files[current]['release-assets.json'][0] ^= 1;
    assert.throws(() => readAssetCatalogue({ tag: current, execute: f.execute }), /checksum/);
    f.sealIndex();
    const catalogue = f.expand();
    f.files[origin][archive][0] ^= 1;
    assert.throws(() => downloadCatalogueAsset(catalogue, archive, f.directory, { execute: f.execute }), /checksum/);
    assert.ok(!fs.existsSync(path.join(f.directory, archive)));
    assert.deepEqual(fs.readdirSync(f.directory), []);
    assert.throws(() => downloadCatalogueAsset(catalogue, archive, f.directory, { execute: f.execute, expected: { size: f.entry.size, sha256: 'f'.repeat(64) } }), /descriptor checksum/);
});

test('foreign repository, current-tag controls, future/nonstable origins and unknown index properties fail closed', t => {
    const f = fixture(t), original = structuredClone(f.index);
    const mutations = [index => index.repository = 'attacker/repo', index => index.commit = 'f'.repeat(40),
        index => index.tag = origin, index => index.minimumLauncherVersion = '2.1.1',
        index => index.assets[0].asset_release_tag = current, index => index.assets[0].asset_release_tag = 'v2.6.0',
        index => index.assets[0].asset_release_tag = 'v2.5.0-beta.1', index => index.assets[0].asset_release_tag = 'v02.5.0',
        index => index.assets[0].url = 'https://attacker/archive', index => index.extra = true,
        index => index.assets[0].size = 0, index => index.assets[0].sha256 = 'short',
        index => index.assets.push(structuredClone(index.assets[0])),
        ...['release-manifest.json', 'darwin-arm64-release-manifest.json', 'nora-system-win32-x64.json',
            'nora-launcher-darwin-arm64.json', 'SHA256SUMS', 'LAUNCHER-SHA256SUMS', 'Nora-Tavern-Launcher-update.zip',
            'bootstrap-manifest.json', 'first-install-manifest.json', 'tavern-updater-bootstrap.py'].map(name => index => index.assets[0].name = name)];
    for (const mutate of mutations) {
        Object.assign(f.index, structuredClone(original)); mutate(f.index); f.sealIndex();
        assert.throws(f.expand, undefined, String(mutate));
        // Reset removed/unknown keys; Object.assign deliberately does not do that.
        for (const key of Object.keys(f.index)) if (!(key in original)) delete f.index[key];
    }
});

test('origin must physically own matching full bytes under a formal same-repository URL', t => {
    const f = fixture(t), initial = structuredClone(f.releases[origin]);
    for (const mutate of [release => release.draft = true, release => release.prerelease = true,
        release => release.assets = [], release => release.assets[0].size++,
        release => release.assets[0].digest = `sha256:${'f'.repeat(64)}`,
        release => release.assets[0].browser_download_url = 'https://github.com/attacker/repo/releases/download/v2.5.0/' + archive,
        release => release.assets[0].asset_release_tag = 'v2.4.0']) {
        f.releases[origin] = structuredClone(initial); mutate(f.releases[origin]); assert.throws(f.expand);
    }
});

test('oversized index is rejected before download and duplicate/foreign physical metadata before expansion', t => {
    const f = fixture(t), descriptor = f.releases[current].assets.find(asset => asset.name === 'release-assets.json');
    descriptor.size = 64 * 1024 + 1;
    assert.throws(() => readAssetCatalogue({ tag: current, execute: f.execute }), /64 KiB/);
    assert.equal(f.calls.filter(args => args[0] === 'release').length, 0);
    f.sealIndex();
    f.releases[current].assets.push({ ...f.releases[current].assets[0], name: 'RELEASE-MANIFEST.JSON' });
    assert.throws(f.expand, /Duplicate/);
});

test('current release descriptors retain the remote tag commit, version and protocol floor', t => {
    const f = fixture(t), catalogue = f.expand();
    const identity = JSON.parse(f.files[current]['release-manifest.json']);
    assert.doesNotThrow(() => assertBaselineCatalogue(catalogue, identity));
    for (const patch of [{ commit: originCommit }, { versions: { tavern: '2.5.0' } }, { dirty: true },
        { candidate: true }, { bootstrap: { minimumLauncherVersion: '2.1.1' } }]) {
        assert.throws(() => assertBaselineCatalogue(catalogue, { ...identity, ...patch }));
    }
    const system = { schema: 'nora-system/v1', commit, version: current.slice(1), candidate: false, channel: 'stable', minimumLauncherVersion: '2.1.2' };
    assert.doesNotThrow(() => assertBaselineCatalogue(catalogue, system));
    assert.throws(() => assertBaselineCatalogue(catalogue, { ...system, minimumLauncherVersion: '2.1.1' }));
});

test('remote ref commit cannot be replaced with a moving target_commitish or a different tag', t => {
    const f = fixture(t);
    const execute = args => {
        const result = f.execute(args);
        if (args[0] === 'api' && args[1].endsWith(`git/ref/tags/${current}`)) return JSON.stringify({ ref: `refs/tags/${origin}`, object: { type: 'commit', sha: commit } });
        return result;
    };
    assert.throws(() => readAssetCatalogue({ tag: current, execute }), /another ref/);
    f.releases[current].target_commitish = 'main';
    assert.equal(readAssetCatalogue({ tag: current, execute: f.execute }).commit, commit);
});

test('source manifest hashes alone cannot claim a different commit/version than the original remote tag', t => {
    const f = fixture(t);
    for (const [tag, patch] of [[current, { commit: originCommit }], [origin, { commit }], [origin, { versions: { tavern: current.slice(1) } }]]) {
        const bytes = Buffer.from(f.files[tag]['release-manifest.json']), metadata = JSON.parse(bytes);
        f.put(tag, 'release-manifest.json', { ...metadata, ...patch });
        assert.throws(f.expand, /remote tag/);
        assert.throws(() => readAssetCatalogue({ tag: current, execute: f.execute }), /remote tag/);
        f.put(tag, 'release-manifest.json', bytes);
    }
});

test('CLI help makes read-only catalogue proof distinct from building and publishing', () => {
    const file = fileURLToPath(new URL('../tooling/release/asset-catalogue.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [file, '--help'], { encoding: 'utf8' });
    assert.equal(result.status, 0); assert.match(result.stdout, /--baseline/); assert.match(result.stdout, /never builds or publishes/);
});

test('API, bounded index/manifest and small download deadlines stay two minutes; large archives get twenty', t => {
    const f = fixture(t), calls = [];
    const execute = (args, options) => { calls.push({ args, options }); return f.execute(args); };
    const catalogue = readAssetCatalogue({ tag: current, execute });
    assert.ok(calls.every(call => call.options?.timeout === 120000));
    downloadCatalogueAsset(catalogue, archive, f.directory, { execute });
    assert.equal(calls.at(-1).options.timeout, 120000);
    const large = structuredClone(catalogue), asset = large.release.assets.find(item => item.name === archive);
    asset.size = 8 * 1024 * 1024 + 1;
    const separate = path.join(f.directory, 'large'); fs.mkdirSync(separate);
    const recordThenFail = (args, options) => { calls.push({ args, options }); throw Error('Simulated large transfer'); };
    assert.throws(() => downloadCatalogueAsset(large, archive, separate, { execute: recordThenFail }), /Simulated/);
    assert.equal(calls.at(-1).options.timeout, 20 * 60 * 1000);
    const actual = [];
    t.mock.method(childProcess, 'execFileSync', (command, args, options) => {
        assert.equal(command, 'gh'); actual.push(options); return f.execute(args);
    });
    syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    readAssetCatalogue({ tag: current });
    assert.ok(actual.every(options => options.timeout === 120000 && options.killSignal === 'SIGKILL'));
    assert.throws(() => downloadCatalogueAsset(large, archive, separate), /size mismatch/);
    assert.equal(actual.at(-1).timeout, 20 * 60 * 1000);
});
