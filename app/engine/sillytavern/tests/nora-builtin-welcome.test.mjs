import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ensureBuiltinWelcome } from '../src/nora-world-core/builtin-welcome.js';
import { clearNoraWorldCoreCache, resolveNoraWorldCore, worldCorePaths } from '../src/nora-world-core/runtime.js';
import { stageWelcomeWorld } from '../src/nora-world-core/st-import-staging.js';
import { selectBootstrapLastWorldId } from '../src/nora-bootstrap.js';
import { resolveNoraLocale } from '../public/scripts/nora-i18n/locale.js';

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nora-builtin-welcome-'));
    const directories = { root, characters: path.join(root, 'characters'), chats: path.join(root, 'chats'), worlds: path.join(root, 'worlds') };
    for (const directory of Object.values(directories)) await fs.mkdir(directory, { recursive: true });
    const settingsPath = path.join(root, 'settings.json');
    await fs.writeFile(settingsPath, JSON.stringify({ extension_settings: { untouched: true }, main_api: 'openai' }));
    t.after(async () => { clearNoraWorldCoreCache(); await fs.rm(root, { recursive: true, force: true }); });
    return { directories, settingsPath, markerPath: path.join(worldCorePaths(directories).root, 'builtin-welcome.json') };
}

async function openingFile(directories, worldId) {
    const world = await resolveNoraWorldCore(directories).getWorld(worldId);
    const session = world.sessions.items.find(item => item.session_id === world.sessions.default_session_id);
    return path.join(directories.chats, path.parse(session.binding.avatar).name, `${session.binding.chat_id}.jsonl`);
}

test('clean Tavern creates a real Chinese opening and selects it through the existing bootstrap contract', async t => {
    const { directories, settingsPath } = await fixture(t);
    const result = await ensureBuiltinWelcome(directories, { locale: 'zh-cn' });
    assert.equal(result.status, 'complete');
    const core = resolveNoraWorldCore(directories);
    const worlds = await core.listWorlds();
    assert.equal(worlds.length, 1);
    assert.equal(worlds[0].name, '新手引导');
    assert.equal(worlds[0].lifecycle.status, 'READY');
    const lines = (await fs.readFile(await openingFile(directories, result.worldId), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const expected = (await fs.readFile(new URL('../src/nora-world-core/builtin/welcome-zh.md', import.meta.url), 'utf8')).trim();
    assert.equal(lines.length, 2);
    assert.equal(lines[1].mes, expected);
    assert.equal(lines[1].is_user, false);
    assert.equal(lines[1].is_system, false);
    assert.equal(lines[1].swipes, undefined, 'a single Chinese opening has no alternate swipe');
    const settings = await fs.readFile(settingsPath, 'utf8');
    assert.equal(selectBootstrapLastWorldId({ settings }), result.worldId);
    assert.equal(JSON.parse(settings).extension_settings.untouched, true);
    assert.equal((await core.prepareOpen(result.worldId)).world_id, result.worldId);
});

test('the first opening follows the same URL/browser language decision as the UI', async t => {
    for (const [search, browserLanguage, expectedLocale] of [
        ['?lang=en', 'zh-CN', 'en'],
        ['?lang=zh-TW', 'en-US', 'zh-cn'],
        ['', 'zh-CN', 'zh-cn'],
        ['', 'en-US', 'en'],
        ['', '', 'en'],
        ['?lang=fr', 'zh-CN', 'en'],
    ]) {
        const { directories } = await fixture(t);
        const locale = resolveNoraLocale(search, browserLanguage);
        assert.equal(locale, expectedLocale);
        const first = await ensureBuiltinWelcome(directories, { locale });
        const world = await resolveNoraWorldCore(directories).getWorld(first.worldId);
        assert.equal(world.name, locale === 'zh-cn' ? '新手引导' : 'Getting started');
        const chatPath = await openingFile(directories, first.worldId);
        const chat = await fs.readFile(chatPath, 'utf8');
        const message = JSON.parse(chat.trim().split('\n')[1]);
        assert.match(message.mes, locale === 'zh-cn' ? /欢迎来到酒馆/ : /Welcome to Tavern/);
        await ensureBuiltinWelcome(directories, { locale: locale === 'en' ? 'zh-cn' : 'en' });
        assert.equal(await fs.readFile(chatPath, 'utf8'), chat, 'a later language change must not rewrite saved chat');
    }
});

test('concurrent initialization and later restarts neither duplicate nor reset the story or selection', async t => {
    const { directories, settingsPath } = await fixture(t);
    const [first, second] = await Promise.all([ensureBuiltinWelcome(directories), ensureBuiltinWelcome(directories)]);
    assert.deepEqual(second, first);
    const chatPath = await openingFile(directories, first.worldId);
    await fs.appendFile(chatPath, JSON.stringify({ is_user: true, mes: '我的新故事' }) + '\n');
    const savedChat = await fs.readFile(chatPath, 'utf8');
    const changed = { extension_settings: { nora_ui: { lastWorldId: 'world:user-chosen' } } };
    await fs.writeFile(settingsPath, JSON.stringify(changed));
    clearNoraWorldCoreCache();
    await ensureBuiltinWelcome(directories);
    assert.equal((await resolveNoraWorldCore(directories).listWorlds()).length, 1);
    assert.equal(await fs.readFile(chatPath, 'utf8'), savedChat);
    assert.deepEqual(JSON.parse(await fs.readFile(settingsPath, 'utf8')), changed);
});

test('deleting the welcome World is respected after restart', async t => {
    const { directories } = await fixture(t);
    const first = await ensureBuiltinWelcome(directories);
    await resolveNoraWorldCore(directories).deleteWorld(first.worldId, { idempotencyKey: 'test:delete-welcome' });
    clearNoraWorldCoreCache();
    await ensureBuiltinWelcome(directories);
    assert.equal((await resolveNoraWorldCore(directories).listWorlds()).length, 0);
});

test('existing cards, chats, worldbooks or a saved selection are not replaced by onboarding', async t => {
    for (const kind of ['characters', 'chats', 'worlds', 'selection']) {
        const { directories, settingsPath } = await fixture(t);
        if (kind === 'selection') await fs.writeFile(settingsPath, '{"extension_settings":{"nora_ui":{"lastWorldId":"existing"}}}');
        else await fs.writeFile(path.join(directories[kind], 'existing.json'), '{}');
        const before = await fs.readFile(settingsPath, 'utf8');
        assert.equal((await ensureBuiltinWelcome(directories)).status, 'skipped');
        assert.equal((await resolveNoraWorldCore(directories).listWorlds()).length, 0);
        assert.equal(await fs.readFile(settingsPath, 'utf8'), before);
    }
});

test('interruption after committing the World resumes initialization without another message or World', async t => {
    const { directories, settingsPath, markerPath } = await fixture(t);
    const command = await stageWelcomeWorld({ idempotencyKey: 'nora:builtin-welcome:v1', stagingRoot: worldCorePaths(directories).stagingRoot });
    await fs.writeFile(markerPath, JSON.stringify({ status: 'pending', command }));
    const created = await resolveNoraWorldCore(directories).createWorld(command, { idempotencyKey: 'nora:builtin-welcome:v1' });
    clearNoraWorldCoreCache();
    const result = await ensureBuiltinWelcome(directories);
    assert.equal(result.worldId, created.world.world_id);
    assert.equal((await resolveNoraWorldCore(directories).listWorlds()).length, 1);
    assert.equal(selectBootstrapLastWorldId({ settings: await fs.readFile(settingsPath, 'utf8') }), result.worldId);
    assert.equal((await fs.readFile(await openingFile(directories, result.worldId), 'utf8')).trim().split('\n').length, 2);
});

test('invalid existing settings fail without overwriting user data or creating a World', async t => {
    const { directories, settingsPath } = await fixture(t);
    await fs.writeFile(settingsPath, '{broken');
    await assert.rejects(ensureBuiltinWelcome(directories), SyntaxError);
    assert.equal(await fs.readFile(settingsPath, 'utf8'), '{broken');
    assert.equal((await resolveNoraWorldCore(directories).listWorlds()).length, 0);
});
