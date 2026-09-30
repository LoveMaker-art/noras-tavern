import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { discoverInstalledExtensions, installDisabledExtension, readExtensionLibraryState, setExtensionLibraryState } from '../src/nora-extension-library.js';
import { computeExtensionAssetManifest } from '../src/nora-static-assets.js';
import { pluginLibraryStatus, validatePluginRepository } from '../../../native-extensions/nora-ui/plugin-library-controller.js';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-plugin-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const user = path.join(root, 'user', 'extensions'), system = path.join(root, 'system'), global = path.join(root, 'global');
    for (const dir of [user, system, global]) fs.mkdirSync(dir, { recursive: true });
    const discover = () => discoverInstalledExtensions(user, system, global);
    const write = (directory, name, manifest = { display_name: name, version: '1' }) => {
        const target = path.join(directory, name); fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(manifest));
        fs.writeFileSync(path.join(target, 'index.js'), 'throw new Error("must not execute during install");');
    };
    const clone = async (_url, directory) => write(path.dirname(directory), path.basename(directory));
    return { root, user, system, global, discover, write, clone };
}

test('staged install never exposes an enabled plugin, preserves metadata and needs explicit enable', async t => {
    const f = fixture(t);
    await installDisabledExtension({ directory: f.user, name: 'Example', url: 'https://example.org/Example', clone: async (...args) => {
        assert.deepEqual(f.discover(), []);
        await f.clone(...args);
        assert.deepEqual(f.discover(), []);
    } });
    assert.deepEqual(f.discover(), [{ type: 'local', name: 'third-party/Example', libraryEnabled: false }]);
    assert.equal(readExtensionLibraryState(f.user).Example.source, 'https://example.org/Example');
    setExtensionLibraryState(f.user, 'Example', { enabled: true });
    assert.equal(f.discover()[0].libraryEnabled, true);
    assert.equal(readExtensionLibraryState(f.user).Example.source, 'https://example.org/Example');
    const secondUser = path.join(f.root, 'other', 'extensions'); fs.mkdirSync(secondUser, { recursive: true });
    assert.deepEqual(readExtensionLibraryState(secondUser), {});
});

test('malformed/failed installs clean staging; collisions and managed names never overwrite', async t => {
    const f = fixture(t);
    for (const clone of [async () => { throw new Error('network'); }, async (_url, dir) => f.write(path.dirname(dir), path.basename(dir), [])]) {
        await assert.rejects(installDisabledExtension({ directory: f.user, name: 'Bad', url: 'https://example.org/Bad', clone }));
        assert.deepEqual(f.discover(), []);
        assert.deepEqual(fs.readdirSync(path.dirname(f.user)), ['extensions']);
    }
    f.write(f.user, 'Existing');
    for (const name of ['Existing', 'nora-ui', 'NORA-MVU', 'js-slash-runner', '../outside']) {
        await assert.rejects(installDisabledExtension({ directory: f.user, name, url: 'https://example.org/x', clone: f.clone }));
    }
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.user, 'Existing/manifest.json'))).version, '1');
});

test('native discovery preserves legacy entries, local overrides shared, corrupted policy fails closed', t => {
    const f = fixture(t); f.write(f.system, 'regex'); f.write(f.global, 'Shared'); f.write(f.user, 'Shared');
    assert.deepEqual(f.discover(), [{ type: 'system', name: 'regex' }, { type: 'local', name: 'third-party/Shared' }]);
    fs.writeFileSync(path.join(path.dirname(f.user), 'nora-extension-library.json'), '{');
    assert.throws(f.discover);
});

test('discovery ignores removed-extension folders and dangling links without hiding valid disabled plugins', t => {
    const f = fixture(t);
    f.write(f.user, 'Disabled');
    setExtensionLibraryState(f.user, 'Disabled', { enabled: false });
    for (const directory of [f.user, f.system, f.global]) {
        fs.mkdirSync(path.join(directory, 'Leftover'));
        fs.symlinkSync(path.join(f.root, 'missing'), path.join(directory, 'Dangling'));
    }
    assert.deepEqual(f.discover(), [{ type: 'local', name: 'third-party/Disabled', libraryEnabled: false }]);
});

test('only managed extensions enter startup immutable assets; mutable plugins use revalidated routes', t => {
    const f = fixture(t); f.write(f.user, 'UserPlugin'); f.write(f.user, 'nora-mvu');
    const manifest = computeExtensionAssetManifest({ userDirectory: f.user, globalDirectory: f.global, managedOnly: true });
    assert.deepEqual(Object.keys(manifest.extensions), ['third-party/nora-mvu']);
    assert.ok(computeExtensionAssetManifest({ userDirectory: f.user, globalDirectory: f.global }).extensions['third-party/UserPlugin']);
});

test('the native loader applies library consent before manifest loading, preserving legacy settings', async () => {
    const source = fs.readFileSync(new URL('../public/scripts/extensions.js', import.meta.url), 'utf8');
    const begin = source.indexOf('export async function loadExtensionSettings(');
    const end = source.indexOf('\n/**', begin);
    const isDisabled = source.slice(source.indexOf('function isExtensionDisabled('), source.indexOf('\nexport function getExtensionLibraryRuntime'));
    const batches = [];
    const context = vm.createContext({ extension_settings: { disabledExtensions: ['legacy-off', 'third-party/approved'] },
        applyNoraProductExtensionPolicy() {}, eventSource: { emit: async () => {} }, event_types: {},
        discoverExtensions: async () => [{ name: 'third-party/new', libraryEnabled: false }, { name: 'third-party/approved', libraryEnabled: true }, { name: 'legacy-off' }, { name: 'legacy-on' }],
        getManifests: async names => { batches.push([...names]); return Object.fromEntries(names.map(name => [name, {}])); },
        activateExtensions: async () => {}, activeExtensions: new Set(), NORA_PRODUCT_DEFERRED_EXTENSIONS: [],
        document: { body: { classList: { contains: () => false } }, querySelector: () => null },
    });
    vm.runInContext(`let extensionNames, extensionTypes, libraryExtensionStates, manifests, prepareExtensionsForActivation; ${isDisabled}\n${source.slice(begin, end).replace('export ', '')}`, context);
    await vm.runInContext('loadExtensionSettings({})', context);
    assert.deepEqual(batches, [['third-party/approved', 'legacy-on']]);
});

test('status and repository validation never equate installation/loading with compatibility', () => {
    assert.equal(pluginLibraryStatus({ libraryEnabled: false }), '已停用');
    assert.equal(pluginLibraryStatus({ libraryEnabled: false }, { loaded: true }), '已停用，待刷新');
    assert.equal(pluginLibraryStatus({}, { enabled: true, loaded: true }), '本页已加载');
    assert.equal(pluginLibraryStatus({}, { enabled: true, error: 'missing dependency' }), '加载失败');
    assert.equal(pluginLibraryStatus({}, {}, true), '已更改，待刷新');
    assert.equal(validatePluginRepository(' https://github.com/a/b.git '), 'https://github.com/a/b.git');
    for (const url of ['javascript:alert(1)', 'file:///tmp/a', 'https://key@github.com/a/b', 'https://github.com/', 'https://github.com/a/b?token=x']) assert.throws(() => validatePluginRepository(url));
});

test('real HTTP routes protect bundles and shared installs; state persists and uninstall keeps unrelated data', async t => {
    const f = fixture(t); f.write(f.user, 'Example');
    const bundled = ['nora-ui', 'nora-ledger', 'nora-mvu', 'JS-Slash-Runner', 'ST-Prompt-Template'];
    for (const name of bundled) f.write(f.user, name);
    const { setConfigFilePath } = await import('../src/util.js');
    const config = path.join(f.root, 'config.yaml'); fs.writeFileSync(config, '{}'); setConfigFilePath(config);
    const { router } = await import('../src/endpoints/extensions.js');
    const { default: express } = await import('express');
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.user = { directories: { extensions: f.user }, profile: { admin: false, handle: 'test' } }; next(); });
    app.use('/api/extensions', router);
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const post = (route, body) => fetch(`http://127.0.0.1:${server.address().port}/api/extensions/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    for (const route of ['update', 'delete', 'switch', 'move', 'library/state']) {
        assert.equal((await post(route, { extensionName: 'nora-ui', enabled: true })).status, 403);
        assert.equal((await post(route, { extensionName: '../Example', enabled: true })).status, 400);
    }
    assert.equal((await post('install', { url: 'https://example.org/NORA-UI', disabled: true })).status, 403);
    assert.equal((await post('delete', { extensionName: 'Example', global: true })).status, 403);
    assert.equal((await post('library/state', { extensionName: 'Example', enabled: false })).status, 200);
    assert.equal(readExtensionLibraryState(f.user).Example.enabled, false);
    assert.equal((await post('library/state', { extensionName: 'Example', enabled: 'false' })).status, 400);
    const library = await (await fetch(`http://127.0.0.1:${server.address().port}/api/extensions/library`)).json();
    assert.equal(library.items.some(item => item.name === 'third-party/nora-ui'), false);
    assert.equal(library.items.some(item => item.name === 'memory'), false);
    assert.equal(library.items.filter(item => item.builtin).length, 5);
    for (const item of library.items.filter(item => item.builtin)) {
        assert.equal(item.managed, true);
        assert.equal(item.editable, false);
        assert.equal(item.repository, false);
    }
    assert.equal(library.items.find(item => item.name === 'third-party/Example').libraryEnabled, false);
    const discovery = await (await fetch(`http://127.0.0.1:${server.address().port}/api/extensions/discover`)).json();
    for (const name of bundled) {
        assert.ok(discovery.some(item => item.name === `third-party/${name}`), 'Runtime discovery must retain bundled modules');
        assert.ok(fs.existsSync(path.join(f.user, name, 'manifest.json')));
    }
    // Exercise the actual native update route against local Git repositories only.
    const upstream = path.join(f.root, 'upstream'); fs.mkdirSync(upstream);
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
    git(upstream, 'init', '-b', 'main');
    git(upstream, 'config', 'user.email', 'fixture@example.invalid'); git(upstream, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(upstream, 'manifest.json'), '{"display_name":"GitFixture","version":"1"}');
    git(upstream, 'add', '.'); git(upstream, 'commit', '-m', 'initial');
    git(f.user, 'clone', upstream, 'GitFixture');
    setExtensionLibraryState(f.user, 'GitFixture', { enabled: false });
    fs.writeFileSync(path.join(upstream, 'manifest.json'), '{"display_name":"GitFixture","version":"2"}');
    git(upstream, 'add', '.'); git(upstream, 'commit', '-m', 'update');
    assert.equal((await post('update', { extensionName: 'GitFixture' })).status, 200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.user, 'GitFixture/manifest.json'))).version, '2');
    assert.equal(readExtensionLibraryState(f.user).GitFixture.enabled, false);
    assert.equal((await (await post('update', { extensionName: 'GitFixture' })).json()).isUpToDate, true);
    assert.equal((await post('delete', { extensionName: 'Example' })).status, 200);
    assert.ok(fs.existsSync(path.join(f.user, 'nora-ui/manifest.json')));
    assert.equal(fs.existsSync(path.join(f.user, 'Example')), false);
});
