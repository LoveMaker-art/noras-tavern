import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import express from 'express';

import { renderLocaleBootstrap } from '../src/nora-locale-bootstrap.js';
import { clearNoraWorldCoreCache, resolveNoraWorldCore, worldCorePaths } from '../src/nora-world-core/runtime.js';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(path.resolve('default/config.yaml'));
const { router } = await import('../src/endpoints/nora-boot.js');
const index = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const bootRequests = index.slice(
    index.indexOf('const bootLocaleQuery ='),
    index.indexOf('globalThis.__NORA_RUNTIME_BOOTSTRAP_NETWORK_PROMISE__ ='),
);

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nora-welcome-boot-'));
    const directories = { root };
    for (const name of ['characters', 'chats', 'worlds', 'openAI_Settings', 'instruct', 'context', 'sysprompt', 'reasoning']) {
        directories[name] = path.join(root, name);
        await fs.mkdir(directories[name]);
    }
    await fs.writeFile(path.join(root, 'settings.json'), JSON.stringify({ main_api: 'openai' }));
    const previousAgentId = process.env.TAVERN_AGENT_USER_ID;
    process.env.TAVERN_AGENT_USER_ID = 'usr_welcome_test';
    const app = express();
    app.set('noraAssetRelease', '123456abcdef');
    app.use((req, _res, next) => { req.user = { directories }; next(); });
    app.use('/api/nora-boot', router);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
        await new Promise(resolve => server.close(resolve));
        clearNoraWorldCoreCache();
        await fs.rm(root, { recursive: true, force: true });
        if (previousAgentId === undefined) delete process.env.TAVERN_AGENT_USER_ID;
        else process.env.TAVERN_AGENT_USER_ID = previousAgentId;
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    return { directories, base };
}

async function openPage(base, search, browserLanguage) {
    const requested = [];
    const context = vm.createContext({
        URLSearchParams,
        location: { search },
        navigator: { language: browserLanguage },
        document: { documentElement: {} },
        recordAssetCacheMilestone() {},
        __NORA_BOOT_METRICS__: { sessionId: 'test-welcome' },
        __NORA_TRACK_BOOT_RESOURCE__: () => ({ complete() {}, fail() {} }),
        __NORA_REPORT_EARLY_BOOT_METRICS__() {},
        fetch(url, options) {
            requested.push(url);
            return fetch(base + url, options);
        },
    });
    vm.runInContext(renderLocaleBootstrap(index), context);
    const [shell, bootstrap] = await vm.runInContext(
        bootRequests + '\nPromise.all([shellNetworkPromise, runtimeBootstrapNetworkPromise]);', context,
    );
    return { shell, bootstrap, requested };
}

test('the actual page passes its locale to both boot reads before the first chat is created', async t => {
    for (const [search, browserLanguage, locale] of [
        ['?lang=en', 'zh-CN', 'en'],
        ['?lang=zh', 'en-US', 'zh-cn'],
        ['', 'zh-CN', 'zh-cn'],
        ['', 'en-US', 'en'],
        ['', undefined, 'en'],
    ]) {
        const { directories, base } = await fixture(t);
        const { shell, bootstrap, requested } = await openPage(base, search, browserLanguage);
        assert.deepEqual(requested, ['/api/nora-boot/shell', '/api/nora-boot/bootstrap'].map(url => `${url}?lang=${locale}`));
        assert.equal(shell.worlds.length, 1);
        assert.equal(shell.worlds[0].name, locale === 'zh-cn' ? '新手引导' : 'Getting started');
        assert.equal(bootstrap.lastWorldId, shell.worlds[0].id);
        const world = await resolveNoraWorldCore(directories).getWorld(bootstrap.lastWorldId);
        const binding = world.sessions.items[0].binding;
        const file = path.join(directories.chats, path.parse(binding.avatar).name, `${binding.chat_id}.jsonl`);
        const original = await fs.readFile(file, 'utf8');
        const messages = original.trim().split('\n').map(line => JSON.parse(line));
        const expected = await fs.readFile(new URL(`../src/nora-world-core/builtin/welcome-${locale === 'zh-cn' ? 'zh' : 'en'}.md`, import.meta.url), 'utf8');
        assert.equal(messages.length, 2);
        assert.equal(messages[1].mes, expected.trim());
        const reopened = await openPage(base, locale === 'en' ? '?lang=zh' : '?lang=en', browserLanguage);
        assert.equal(reopened.bootstrap.lastWorldId, bootstrap.lastWorldId);
        assert.equal(reopened.shell.worlds.length, 1);
        assert.equal(await fs.readFile(file, 'utf8'), original);
    }
});

test('language-free health probes leave initialization for the first browser', async t => {
    const { directories, base } = await fixture(t);
    for (const endpoint of ['shell', 'bootstrap']) {
        const response = await fetch(`${base}/api/nora-boot/${endpoint}`);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        await response.json();
    }
    assert.equal((await resolveNoraWorldCore(directories).listWorlds()).length, 0);
    await assert.rejects(fs.access(path.join(worldCorePaths(directories).root, 'builtin-welcome.json')), { code: 'ENOENT' });
    const { shell } = await openPage(base, '', 'zh-CN');
    assert.equal(shell.worlds[0].name, '新手引导');
});

test('server startup must not create a welcome before a browser supplies its locale', async () => {
    const server = await fs.readFile(new URL('../src/server-main.js', import.meta.url), 'utf8');
    assert.doesNotMatch(server, /ensureBuiltinWelcome/);
});
