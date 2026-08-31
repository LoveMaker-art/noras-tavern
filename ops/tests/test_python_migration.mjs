import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { convertPythonState } from '../updater/python-state.mjs';
import { validateState } from '../updater/validate-state.mjs';
import { ImportPlan, DeferredData } from '../updater/python-import-plan.mjs';
import { createNoraWorldCore } from '../../app/engine/sillytavern/src/nora-world-core/index.js';
import { buildStoryProfileCard } from '../../app/engine/sillytavern/src/nora-story-profile.js';
import { WorldStore } from '../../app/engine/sillytavern/src/nora-world-core/store.js';
import { createActivationPlan } from '../../app/engine/sillytavern/src/nora-world-core/activation-plan.js';
import { renderStoryContext, storyEntityBindings, editStoryCharacter } from '../../app/engine/sillytavern/public/scripts/nora-worlds/story-context.js';
import { createStoryLedger } from '../../app/engine/sillytavern/src/nora-story-ledger/core.js';
import { ledgerStatePath } from '../../app/engine/sillytavern/src/nora-story-ledger/state-file.js';
import { renderLedger } from '../../app/engine/sillytavern/public/scripts/nora-story-ledger/history.js';
import { collectStoryProductions } from '../../app/engine/sillytavern/src/nora-story-ledger/profile-projection.js';
import { setConfigFilePath } from '../../app/engine/sillytavern/src/util.js';
import { read as readCard } from '../../app/engine/sillytavern/src/character-card-parser.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const app = path.join(repository, 'app');
const readJson = file => fs.readFile(file, 'utf8').then(JSON.parse);
async function setup(t, mutate = () => {}) {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), 'python-tavern-test-'));
    t.after(() => fs.rm(state, { recursive: true, force: true }));
    const fixture = await readJson(path.join(repository, 'ops/tests/fixtures/python-state.json'));
    mutate(fixture);
    for (const namespace of ['cards', 'worldbooks', 'productions']) {
        await fs.mkdir(path.join(state, namespace));
        for (const item of fixture[namespace]) await fs.writeFile(path.join(state, namespace, item.id + '.json'), JSON.stringify(item));
    }
    const root = path.join(state, 'native/default-user');
    return { state, root, fixture };
}

test('original Python serializer fixture becomes separate Worlds, library cards and current cast; replay is idempotent', async t => {
    const { state, root, fixture } = await setup(t);
    const report = await convertPythonState(state, app);
    assert.equal(report.pythonMigration, true);
    assert.equal(report.modelsCalled, 0);
    const store = new WorldStore({ root: path.join(root, 'nora-world-core') });
    const world = await store.get('prod_fixture');
    assert.equal((await store.list()).length, 2);
    assert.deepEqual(world.story_context.characters.map(c => c.id), fixture.cards.map(c => c.id));
    assert.equal(world.story_context.characters[0].profile.identity.occupation, '已晋升的大副');
    const card = JSON.parse(readCard(await fs.readFile(path.join(root, 'characters', world.story_context.characters[0].source_avatar))));
    assert.doesNotMatch(card.data.description, /已晋升的大副/);
    const plan = createActivationPlan(world);
    assert.equal(plan.story_context.characters[0].persistent_status.physical_condition, '左臂受伤');
    const prompt = renderStoryContext(plan.story_context);
    for (const expected of ['阿岚', '清夏', '左臂受伤', '互相信任', '保持因果一致']) assert.ok(prompt.includes(expected));
    const session = world.sessions.items[0];
    const lines = (await fs.readFile(path.join(root, 'chats', world.runtime_card.binding.avatar.slice(0, -4), session.binding.chat_id + '.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(lines.length, 33);
    assert.deepEqual(lines.slice(1).map(message => message.mes), fixture.productions[0].story.map(message => message.text));
    assert.deepEqual(lines[1].swipes, fixture.productions[0].story[0].alts);
    assert.equal((await store.get('prod_empty')).sessions.items[0].opening_state, 'empty');
    assert.equal((await convertPythonState(state, app)).repeated, true);
    assert.equal((await validateState(state, app)).migration, false);
    const profile = buildStoryProfileCard({ worlds: await store.list(), statsByWorld: { prod_fixture: { turns: 16, words: 40 }, prod_empty: { turns: 0, words: 0 } } });
    assert.equal(profile.career.roles, 2);
    assert.deepEqual(profile.roles_played.map(role => role.name).sort(), ['清夏', '阿岚'].sort());
});

test('imported ledger retains named entities, preserves projection and only locks after real dispatch acceptance', async t => {
    const { state, root, fixture } = await setup(t);
    await convertPythonState(state, app);
    const store = new WorldStore({ root: path.join(root, 'nora-world-core') });
    const world = await store.get('prod_fixture');
    const scope = { worldId: world.world_id, sessionId: world.sessions.default_session_id };
    let ledger = await readJson(ledgerStatePath(root, scope));
    const messages = (await fs.readFile(path.join(root, 'chats', world.runtime_card.binding.avatar.slice(0, -4), 'python-story.jsonl'), 'utf8')).trim().split('\n').slice(1).map(JSON.parse);
    const entityBindings = storyEntityBindings(world.story_context, world.persona.name);
    let calls = 0;
    const plugin = createStoryLedger({ readChat: () => ({ messages, entities: Object.keys(entityBindings), entityBindings }),
        readState: () => ledger, writeState: (_scope, value) => { ledger = value; }, merge: () => { calls++; throw new Error('No compression due'); } });
    assert.equal((await plugin.status(scope)).active, null);
    assert.equal(ledger.pending.ledger.objects[0].holder, fixture.cards[0].id);
    const projection = await collectStoryProductions({ root, chats: path.join(root, 'chats') }, () => store.list());
    assert.equal(projection[0].id, 'prod_fixture');
    assert.deepEqual(projection[0].story_state.timeline, ['抵达港口']);
    const reservation = await plugin.reserve(scope, ledger.pending.id, [{ role: 'system', content: renderLedger(ledger.pending) }]);
    await reservation.accept(); reservation.release();
    assert.equal((await plugin.inspect(scope, { limit: 2 })).messages[0].editable, false);
    assert.equal(calls, 0);
});

test('character edits preserve independent identities, other profiles and library templates', async t => {
    const { state, root } = await setup(t);
    await convertPythonState(state, app);
    const world = await new WorldStore({ root: path.join(root, 'nora-world-core') }).get('prod_fixture');
    const changed = editStoryCharacter(world.story_context, { id: world.story_context.characters[0].id, patch: { name: '改名', description: '新描述' } });
    assert.equal(changed.characters[0].profile.identity.name, '改名');
    assert.equal(changed.characters[0].persistent_status.physical_condition, '左臂受伤');
    assert.deepEqual(changed.characters[1], world.story_context.characters[1]);
    assert.equal(world.story_context.characters[0].profile.identity.name, '阿岚');
    const core = createNoraWorldCore({ root: path.join(root, 'nora-world-core'), materializer: { async materialize() { throw new Error('Not used by edit'); } } });
    const saved = await core.updateWorld(world.world_id, { character: { id: world.story_context.characters[0].id, patch: { name: '改名' } } }, { expectedRevision: world.revision });
    assert.equal(saved.story_context.characters[0].profile.identity.name, '改名');
    assert.deepEqual(saved.story_context.relationships, world.story_context.relationships);
    await assert.rejects(core.updateWorld(world.world_id, { name: 'stale' }, { expectedRevision: world.revision }), /World changed/);
    await assert.rejects(core.updateWorld(world.world_id, { character: null }, { expectedRevision: saved.revision }), /Invalid World story context/);
});

test('all attached lore is selected using native extra-book bindings, not only the first book', async t => {
    const { state, root } = await setup(t, fixture => {
        fixture.worldbooks.push({ id: 'wb_second', owner_production_id: 'prod_fixture', entries: [{ uid: 4, key: ['航线'], content: '南行', probability: 0.5, case_sensitive: true }] });
        fixture.productions[0].worldbook_ids.push('wb_second');
    });
    await convertPythonState(state, app);
    const world = await new WorldStore({ root: path.join(root, 'nora-world-core') }).get('prod_fixture');
    const settings = await readJson(path.join(root, 'settings.json'));
    assert.deepEqual(settings.world_info_settings.world_info.charLore, [{ name: world.runtime_card.binding.avatar.slice(0, -4), extraBooks: [world.knowledge[1].binding.name] }]);
    const entry = (await readJson(path.join(root, 'worlds', world.knowledge[1].binding.name + '.json'))).entries[4];
    assert.deepEqual(entry.key, ['航线']);
    assert.equal(entry.probability, 50);
    assert.equal(entry.caseSensitive, true);
    assert.equal(world.knowledge[1].ownership, 'owned');
});

test('the next fifteen-turn compression receives independent entity bindings and retains ledger ownership', async t => {
    setConfigFilePath(path.join(app, 'engine/sillytavern/default/config.yaml'));
    const { ledgerPrompt } = await import('../../app/engine/sillytavern/src/nora-story-ledger/model.js');
    const { state, root } = await setup(t, fixture => {
        for (let turn = 17; turn <= 31; turn++) for (const role of ['user', 'char']) fixture.productions[0].story.push({ id: `msg_${turn}_${role}`, role, text: `续写${turn}`, ts: 1785542400 + turn });
    });
    await convertPythonState(state, app);
    const world = await new WorldStore({ root: path.join(root, 'nora-world-core') }).get('prod_fixture');
    const scope = { worldId: world.world_id, sessionId: world.sessions.default_session_id };
    let stateValue = await readJson(ledgerStatePath(root, scope));
    const messages = (await fs.readFile(path.join(root, 'chats', world.runtime_card.binding.avatar.slice(0, -4), 'python-story.jsonl'), 'utf8')).trim().split('\n').slice(1).map(JSON.parse);
    const entityBindings = storyEntityBindings(world.story_context, world.persona.name);
    let calls = 0;
    const plugin = createStoryLedger({ readState: () => stateValue, writeState: (_, value) => { stateValue = value; },
        readChat: () => ({ messages, entityBindings, entities: Object.keys(entityBindings), language: 'en' }),
        merge: input => { calls++; assert.deepEqual(input.entityBindings, entityBindings); assert.match(JSON.stringify(ledgerPrompt(input)), /阿岚/); return input.previous; } });
    await plugin.schedule(scope);
    assert.equal(calls, 1); // deterministic local stub; no model or network call
    assert.equal(stateValue.pending.coveredTurns, 30);
    assert.equal(stateValue.pending.ledger.objects[0].holder, world.story_context.characters[0].id);
    assert.equal(stateValue.active, null);
    const inspected = await plugin.inspect(scope);
    await plugin.edit(scope, { messageId: 2, text: '修改早期剧情', expectedSignature: inspected.expectedSignature }, next => messages.splice(0, messages.length, ...next));
    assert.equal(stateValue.pending, null);
    assert.equal(stateValue.imported, null, 'edited Python history must not remain a shared-memory projection');
    assert.equal(messages.length, 3);
});

test('an explicit Python builtin selection does not silently switch to a different Hermes model', async t => {
    const { state, root } = await setup(t);
    await fs.writeFile(path.join(state, 'model_configs.json'), JSON.stringify({ configs: [], active: 'clawling:old-flash' }));
    await convertPythonState(state, app, {
        legacyModel: { provider: 'clawling', base_url: 'https://old.invalid/v1', api_key: 'old-test-key', model: 'old-default' },
        hermesModel: { provider: 'other', base_url: 'https://new.invalid/v1', api_key: 'new-test-key', model: 'different-model', context: 200000, max_tokens: 10000 },
    });
    const settings = await readJson(path.join(root, 'settings.json'));
    assert.equal(settings.oai_settings.custom_model, 'old-flash');
    assert.equal(settings.extension_settings.nora_ui.hermesModel.model, 'different-model');
    const secrets = await readJson(path.join(root, 'secrets.json'));
    assert.equal(secrets.api_key_custom.find(secret => secret.active).value, 'old-test-key');
});

test('default selection uses only target Hermes configuration, never a generated Python builtin', async t => {
    const { state, root } = await setup(t);
    await convertPythonState(state, app, {
        legacyModel: { provider: 'Python builtin', base_url: 'https://old.invalid/v1', api_key: 'old-key', model: 'old-model' },
        hermesModel: { provider: 'target', base_url: 'https://target.invalid/v1', api_key: 'target-key', model: 'target-model', context: 200000, max_tokens: 10000 },
    });
    const settings = await readJson(path.join(root, 'settings.json'));
    assert.deepEqual(settings.extension_settings.nora_ui.modelProfiles, []);
    assert.equal(settings.extension_settings.nora_ui.activeModel, '');
    assert.equal(settings.oai_settings.custom_model, 'target-model');
    const secrets = await readJson(path.join(root, 'secrets.json'));
    assert.deepEqual(secrets.api_key_custom.map(item => item.value), ['target-key']);
});

test('explicit old provider identical to target Hermes does not create a duplicate choice or secret', async t => {
    const { state, root } = await setup(t);
    await fs.writeFile(path.join(state, 'model_configs.json'), JSON.stringify({ configs: [], active: 'clawling:target-model' }));
    const model = { provider: 'clawling', base_url: 'https://target.invalid/v1', api_key: 'target-key', model: 'target-model', context: 200000, max_tokens: 10000 };
    await convertPythonState(state, app, { hermesModel: model, legacyModel: { ...model, base_url: model.base_url + '/' } });
    const settings = await readJson(path.join(root, 'settings.json'));
    assert.deepEqual(settings.extension_settings.nora_ui.modelProfiles, []);
    assert.equal(settings.oai_settings.custom_model, 'target-model');
    assert.equal((await readJson(path.join(root, 'secrets.json'))).api_key_custom.length, 1);
});

test('unconfigured target stays unconfigured without a built-in fallback', async t => {
    const { state, root } = await setup(t);
    const report = await convertPythonState(state, app);
    const settings = await readJson(path.join(root, 'settings.json'));
    assert.deepEqual(settings.extension_settings.nora_ui.modelProfiles, []);
    assert.equal(settings.extension_settings.nora_ui.hermesModel, undefined);
    assert.deepEqual(settings.oai_settings, {});
    assert.deepEqual((await readJson(path.join(root, 'secrets.json'))).api_key_custom, []);
    assert.ok(report.warnings.some(item => item.code === 'MODEL_CONFIGURATION_REQUIRED'));
});

test('unknown selected model is reported without blocking Worlds or inventing credentials', async t => {
    const { state, root } = await setup(t);
    await fs.writeFile(path.join(state, 'model_configs.json'), JSON.stringify({ configs: [], active: 'missing' }));
    const report = await convertPythonState(state, app);
    assert.equal(report.worlds.length, 2);
    assert.ok(report.deferred.some(item => item.kind === 'model-selection'));
    assert.deepEqual((await readJson(path.join(root, 'secrets.json'))).api_key_custom, []);
});

test('replay refuses changed native history or missing output instead of silently creating another World', async t => {
    const { state, root } = await setup(t);
    await convertPythonState(state, app);
    const world = await new WorldStore({ root: path.join(root, 'nora-world-core') }).get('prod_fixture');
    const chat = path.join(root, 'chats', world.runtime_card.binding.avatar.slice(0, -4), 'python-story.jsonl');
    await fs.appendFile(chat, '\n');
    await assert.rejects(convertPythonState(state, app), /Imported data has changed/);
    await fs.unlink(chat);
    await assert.rejects(convertPythonState(state, app), { code: 'ENOENT' });
});

test('broken references defer the entire World, never leave partial bindings, and preserve originals', async t => {
    const { state, root, fixture } = await setup(t, data => data.productions[0].worldbook_ids.push('wb_missing'));
    const report = await convertPythonState(state, app);
    assert.deepEqual(report.worlds.map(world => world.id), ['prod_empty']);
    assert.deepEqual(report.users[0].active, ['prod_empty']);
    assert.ok(report.deferred.some(item => item.id === 'prod_fixture'));
    assert.equal((await fs.readdir(path.join(root, 'characters'))).length, fixture.cards.length + 1);
    assert.equal((await fs.readdir(path.join(root, 'chats'))).length, 1);
    assert.deepEqual(await readJson(path.join(state, 'python-source/productions/prod_fixture.json')), fixture.productions[0]);
    await validateState(state, app);
});

test('backup files, malformed JSON and unsupported unattached lore do not block compatible records', async t => {
    const { state } = await setup(t, data => data.worldbooks.push({ id: 'wb_st', entries: { 0: { content: '旧书' } } }));
    await fs.writeFile(path.join(state, 'cards/card_old.json.bak_agefix'), 'untouched backup');
    await fs.writeFile(path.join(state, 'productions/prod_broken.json'), '{bad');
    const report = await convertPythonState(state, app);
    assert.equal(report.worlds.length, 2);
    assert.equal(report.status, 'partial');
    assert.equal(report.deferred.length, 2);
    assert.equal(report.archived.length, 1);
    assert.equal(await fs.readFile(path.join(state, 'python-source/cards/card_old.json.bak_agefix'), 'utf8'), 'untouched backup');
    assert.equal(await fs.readFile(path.join(state, 'python-source/productions/prod_broken.json'), 'utf8'), '{bad');
    assert.equal((await convertPythonState(state, app)).repeated, true);
    await validateState(state, app);
});

test('backup-only directories are successful imports, not data failures requiring user conversion', async t => {
    const { state } = await setup(t);
    await fs.writeFile(path.join(state, 'cards/old.json.bak'), 'old backup');
    const report = await convertPythonState(state, app);
    assert.equal(report.status, 'complete');
    assert.equal(report.deferred.length, 0);
    assert.equal(report.archived.length, 1);
    assert.equal(await fs.readFile(path.join(state, report.archived[0].archiveFile), 'utf8'), 'old backup');
});

test('malformed profile is archived byte-for-byte', async t => {
    const { state } = await setup(t);
    await fs.writeFile(path.join(state, 'story_profile.json'), '{broken profile');
    const report = await convertPythonState(state, app);
    assert.equal(report.profile, null);
    assert.ok(report.deferred.some(item => item.kind === 'profile'));
    assert.equal(await fs.readFile(path.join(state, 'python-source-profile/story_profile.json'), 'utf8'), '{broken profile');
    await assert.rejects(fs.stat(path.join(state, 'story_profile.json')), { code: 'ENOENT' });
    await validateState(state, app);
});

test('compatible profile history, eras and custom configuration remain byte-identical', async t => {
    const { state } = await setup(t);
    const originals = {
        'story_profile.json': JSON.stringify({ schema_version: 1, preferences: [{ text: '历史口味' }], recent_timeline: [], shared_story_memory: [], custom: '保留' }),
        'profile_eras.json': '[{"title":"旧时代"}]\n',
        'profile_events.jsonl': '{"event":"历史"}\n',
        'model_configs.json': '{"configs":[],"active":"builtin"}\n',
    };
    for (const [file, content] of Object.entries(originals)) await fs.writeFile(path.join(state, file), content);
    const report = await convertPythonState(state, app);
    assert.equal(report.profile.preserved, true);
    for (const [file, content] of Object.entries(originals)) assert.equal(await fs.readFile(path.join(state, file), 'utf8'), content);
});

test('all incompatible Worlds result in an empty usable World list with an explicit report', async t => {
    const { state } = await setup(t, data => data.productions.forEach(world => { world.story = 'not messages'; }));
    const report = await convertPythonState(state, app);
    assert.deepEqual(report.users[0].active, []);
    assert.equal(report.deferred.filter(item => item.kind === 'world').length, 2);
    const validated = await validateState(state, app);
    assert.equal(validated.users[0].after, 0);
    for (const item of report.deferred) assert.ok((await fs.stat(path.join(state, item.archiveFile))).isFile());
});

test('malformed messages, card fields and optional ledger are isolated at their own record boundaries', async t => {
    for (const [kind, mutate] of [
        ['world', data => { data.productions[0].story[0] = null; }],
        ['card', data => { data.cards[0].entry = { first_message: {} }; }],
        ['ledger', data => { data.productions[0].story_state.facts = 'wrong'; }],
    ]) {
        const { state } = await setup(t, mutate);
        const report = await convertPythonState(state, app);
        assert.ok(report.deferred.some(item => item.kind === kind), kind);
        assert.ok(report.worlds.some(world => world.id === 'prod_empty'));
        if (kind === 'ledger') assert.equal(report.worlds.find(world => world.id === 'prod_fixture').messages, 32);
        await validateState(state, app);
    }
});

test('record boundaries defer known data errors only, never programming or disk errors', async () => {
    const plan = new ImportPlan();
    await plan.record('world', 'broken', 'productions/broken.json', () => {
        plan.put('native/orphan.json', {});
        throw new DeferredData('incompatible');
    });
    assert.equal(plan.outputs.size, 0);
    for (const error of [new TypeError('bug'), new ReferenceError('bug'), Object.assign(new Error('full'), { code: 'ENOSPC' })]) {
        await assert.rejects(plan.record('world', 'bad', 'productions/bad.json', () => { throw error; }), value => value === error);
    }
});

test('Python combined lore conditions retain primary, secondary and exclusions with native regex keys', async t => {
    const { state, root } = await setup(t, data => {
        data.worldbooks[0].entries = [{ id: 1, keys: ['港口'], secondary_keys: ['船长'], selective: true,
            exclusion_keys: ['封锁'], content: '允许靠岸', enabled: true },
        { id: 2, constant: true, exclusion_keys: ['封锁'], content: '常驻但可排除' },
        { id: 3, keys: ['/abc/', 'a.b'], content: '关键词是字面量，不是正则' }];
    });
    await convertPythonState(state, app);
    const file = (await fs.readdir(path.join(root, 'worlds')))[0];
    const entries = (await readJson(path.join(root, 'worlds', file))).entries;
    const match = (entry, text) => entry.constant || entry.key.some(key => {
        const end = key.lastIndexOf('/');
        return new RegExp(key.slice(1, end), key.slice(end + 1)).test(text);
    });
    assert.equal(match(entries[1], '港口 船长'), true);
    assert.equal(match(entries[1], '港口'), false);
    assert.equal(match(entries[1], '船长'), false);
    assert.equal(match(entries[1], '港口\n船长\n封锁'), false);
    assert.equal(match(entries[2], ''), true);
    assert.equal(match(entries[2], '封锁'), false);
    assert.equal(match(entries[3], 'axb'), false);
    assert.equal(match(entries[3], 'a.b'), true);
    assert.equal(match(entries[3], '/abc/'), true);
});

for (const legacyWeb of ['web', 'frontend', 'backend/web']) test(`old ${legacyWeb} assets survive replacement and replay`, async t => {
    const { state, root } = await setup(t, data => {
        data.productions[0].ui = { version: 1, assets: { background: '/assets/scenes/harbor.png?v=1' } };
    });
    const legacyApp = path.join(state, 'old-app');
    await fs.mkdir(path.join(legacyApp, legacyWeb, 'assets/scenes'), { recursive: true });
    const bytes = Buffer.from('test-image-bytes');
    await fs.writeFile(path.join(legacyApp, legacyWeb, 'assets/scenes/harbor.png'), bytes);
    await convertPythonState(state, app, { legacyApp, legacyWeb });
    const world = await new WorldStore({ root: path.join(root, 'nora-world-core') }).get('prod_fixture');
    assert.match(world.ui.assets.background, /^\/backgrounds\/python-.*\.png$/);
    assert.deepEqual(await fs.readFile(path.join(root, world.ui.assets.background.slice(1))), bytes);
    await fs.rm(legacyApp, { recursive: true });
    assert.equal((await convertPythonState(state, app, { legacyApp, legacyWeb })).repeated, true);
});

test('old asset traversal refuses before any native output is written', async t => {
    const { state } = await setup(t, data => {
        data.productions[0].ui = { version: 1, assets: { background: '/assets/%2e%2e/secret.png' } };
    });
    await assert.rejects(convertPythonState(state, app, { legacyApp: path.join(state, 'old-app') }), /Unsafe Python asset/);
    await assert.rejects(fs.stat(path.join(state, 'native')), { code: 'ENOENT' });
});

test('a symlink inside the legacy frontend cannot import files outside its asset root', async t => {
    const { state } = await setup(t, data => {
        data.productions[0].ui = { version: 1, assets: { background: '/assets/link/private.png' } };
    });
    const legacyApp = path.join(state, 'old-app');
    await fs.mkdir(path.join(legacyApp, 'frontend/assets'), { recursive: true });
    await fs.mkdir(path.join(state, 'private'));
    await fs.writeFile(path.join(state, 'private/private.png'), 'must-not-be-imported');
    await fs.symlink(path.join(state, 'private'), path.join(legacyApp, 'frontend/assets/link'));
    await assert.rejects(convertPythonState(state, app, { legacyApp }), /Unsafe Python asset symlink/);
    await assert.rejects(fs.stat(path.join(state, 'native')), { code: 'ENOENT' });
});

test('missing legacy image defers its World without blocking other Worlds', async t => {
    const { state } = await setup(t, data => {
        data.productions[0].ui = { version: 1, assets: { background: '/assets/missing.png' } };
    });
    const source = await fs.readFile(path.join(state, 'productions/prod_fixture.json'));
    const report = await convertPythonState(state, app, { legacyApp: path.join(state, 'old-app') });
    assert.deepEqual(report.worlds.map(world => world.id), ['prod_empty']);
    assert.ok(report.deferred.some(item => item.id === 'prod_fixture'));
    assert.deepEqual(await fs.readFile(path.join(state, 'python-source/productions/prod_fixture.json')), source);
    await validateState(state, app);
});

test('stale old ledger keeps full raw history without inventing activation', async t => {
    const { state, root } = await setup(t, data => { data.productions[0].story_state.covered_signature = 'wrong'; });
    const report = await convertPythonState(state, app);
    assert.equal(report.worlds.find(world => world.id === 'prod_fixture').ledger, 'stale-not-activated');
    assert.equal(report.worlds.find(world => world.id === 'prod_fixture').messages, 32);
    await assert.rejects(fs.stat(path.join(root, 'nora-story-ledger')), { code: 'ENOENT' });
});

test('custom model credentials go to secrets, not UI settings or report', async t => {
    const { state, root } = await setup(t);
    await fs.writeFile(path.join(state, 'model_configs.json'), JSON.stringify({ active: 'm_test', configs: [
        { id: 'm_test', base: 'https://example.invalid/v1', name: 'test', model: 'test-model', key: 'fixture-secret' },
    ] }));
    const report = await convertPythonState(state, app);
    const settings = await readJson(path.join(root, 'settings.json'));
    const secrets = await readJson(path.join(root, 'secrets.json'));
    assert.equal(settings.extension_settings.nora_ui.activeModel, 'm_test');
    assert.equal(settings.oai_settings.custom_model, 'test-model');
    assert.equal(secrets.api_key_custom[0].value, 'fixture-secret');
    assert.equal(secrets.api_key_custom[0].active, true);
    assert.doesNotMatch(JSON.stringify([report, settings]), /fixture-secret/);
    assert.equal((await fs.stat(path.join(root, 'secrets.json'))).mode & 0o777, 0o600);
});
