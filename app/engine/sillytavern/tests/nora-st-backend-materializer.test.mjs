import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    convertEmbeddedBook,
    createStBackendMaterializer,
    inspectStCard,
} from '../src/nora-world-core/st-backend-materializer.js';
import { createNoraWorldCore } from '../src/nora-world-core/index.js';
import { adaptCardForMvuRuntime } from '../public/scripts/nora-compat/mvu-compatibility.js';

async function harness(t, options = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nora-st-materializer-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const directories = {
        characters: path.join(root, 'characters'),
        chats: path.join(root, 'chats'),
        worlds: path.join(root, 'worlds'),
    };
    const stagingRoot = path.join(root, 'staging');
    await Promise.all([...Object.values(directories), stagingRoot].map(directory => fs.mkdir(directory, { recursive: true })));
    const stagedPath = path.join(stagingRoot, 'fixture.card');
    const sourceBuffer = options.sourceBuffer || Buffer.from('sanitized staged character fixture');
    await fs.writeFile(stagedPath, sourceBuffer);
    const card = options.card || complexCard();
    const cardCodec = options.cardCodec || {
        async decode() {
            return { card, runtimeCardBuffer: Buffer.from(`runtime:${card.data.name}`) };
        },
    };
    const materializer = createStBackendMaterializer({
        directories,
        stagingRoot,
        cardCodec,
        now: () => '2026-08-28T12:00:00.000Z',
        checkpoint: options.checkpoint,
    });
    const command = {
        name: options.worldName || '复杂世界',
        persona: { name: '测试用户', description: '' },
        source: {
            type: 'character-card',
            sha256: crypto.createHash('sha256').update(sourceBuffer).digest('hex'),
            original_name: 'fixture.png',
            format: 'png',
        },
        payload: { staged_card: { path: stagedPath, format: 'png' } },
    };
    return { root, directories, stagingRoot, stagedPath, sourceBuffer, materializer, command };
}

function identities(suffix = 'one') {
    return {
        operationId: `operation:${suffix}`,
        worldId: `world:${suffix}`,
        sessionId: `session:${suffix}`,
        runtimeCardResourceId: `resource:${suffix}`,
    };
}

function complexCard({ name = '复杂角色', bookName = '同名设定集', content = '<status_current_variables>\n<UpdateVariable>' } = {}) {
    return {
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data: {
            name,
            description: 'Phase 2 sanitized fixture',
            first_mes: '第一句话',
            alternate_greetings: ['第二种开场'],
            extensions: {
                regex_scripts: [{ scriptName: 'clean output', regex: 'x', replaceString: 'y' }],
                tavern_helper: {
                    scripts: [{ type: 'script', content: 'MagicalAstrogy/MagVarUpdate/artifact/bundle.js' }],
                },
            },
            character_book: {
                name: bookName,
                extensions: {},
                entries: [{
                    id: 0,
                    keys: ['变量'],
                    secondary_keys: [],
                    comment: '[initvar]',
                    content,
                    enabled: true,
                    insertion_order: 100,
                    position: 'before_char',
                    extensions: {},
                }],
            },
        },
    };
}

test('preflights a complex card without creating resources', () => {
    const report = inspectStCard(complexCard());

    assert.equal(report.spec_version, 3);
    assert.equal(report.opening_state, 'message');
    assert.equal(report.worldbooks[0].entry_count, 1);
    assert.deepEqual(report.declared_capabilities, ['mvu', 'regex', 'tavern_helper']);
    assert.equal(report.capabilities.mvu.runtime_source, 'embedded');
});

test('normalizes legacy TavernHelper script wrappers before capability inspection', () => {
    const card = complexCard();
    const script = card.data.extensions.tavern_helper.scripts[0];
    delete card.data.extensions.tavern_helper;
    card.data.extensions.TavernHelper_scripts = [{ type: 'script', value: { ...script, id: 'legacy-mvu' } }];

    const report = inspectStCard(card);

    assert.equal(report.capabilities.tavern_helper.script_count, 1);
    assert.equal(report.capabilities.mvu.runtime_source, 'embedded');
    assert.equal(report.capabilities.mvu.update_protocol, 'legacy-adaptable');
});

test('classifies legacy inline MVU books without claiming split-model support', () => {
    const card = complexCard({ content: '<status_current_variables>\nReturn <UpdateVariable> commands.' });
    card.data.character_book.entries[0].comment = '[InitVar]';

    const report = inspectStCard(card);

    assert.equal(report.capabilities.mvu.declared, true);
    assert.equal(report.capabilities.mvu.update_protocol, 'legacy-adaptable');
    assert.deepEqual(report.capabilities.mvu.update_entry_ids, [0]);
});

test('projects legacy MVU metadata only into the Runtime Card and leaves the source card untouched', () => {
    const card = complexCard({ content: '<status_current_variables>\nReturn <UpdateVariable> commands.' });
    card.data.character_book.entries[0].comment = '变量规则';
    const source = structuredClone(card);

    const adapted = adaptCardForMvuRuntime(card);

    assert.equal(adapted.changed, true);
    assert.equal(adapted.plan.updateProtocol, 'legacy-adaptable');
    assert.deepEqual(card, source, 'the imported source card must remain byte-semantically unchanged');
    assert.match(adapted.card.data.character_book.entries[0].comment, /^\[mvu_update\]/i);
    assert.deepEqual(adapted.card.data.character_book.entries[0].extensions.nora_mvu_compatibility, {
        schema: 1,
        source: 'legacy-update-content',
    });
});

test('materializes one Runtime Card, collision-safe Worldbook and canonical initial Session without a browser', async (t) => {
    const current = await harness(t, { sourceBuffer: Buffer.from([0, 255, 128, 64, 1, 2, 3]) });
    const result = await current.materializer.materialize(current.command, identities());

    assert.equal(result.runtimeCard.engine, 'sillytavern');
    assert.equal(result.runtimeCard.ownership, 'owned');
    assert.equal(result.defaultSession.openingState, 'message');
    assert.deepEqual(result.declaredCapabilities, ['mvu', 'regex', 'tavern_helper']);
    assert.equal(result.knowledge.length, 1);
    assert.equal(result.knowledge[0].ownership, 'shared');

    const avatar = result.runtimeCard.binding.avatar;
    const chatId = result.defaultSession.binding.chat_id;
    const chatPath = path.join(current.directories.chats, path.parse(avatar).name, `${chatId}.jsonl`);
    const chat = (await fs.readFile(chatPath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(chat[0].chat_metadata.nora_world.id, 'world:one');
    assert.equal(chat[0].chat_metadata.nora_session.id, 'session:one');
    assert.equal(chat[0].chat_metadata.world_info, result.knowledge[0].binding.name);
    assert.equal(chat[1].mes, '第一句话');
    assert.deepEqual(chat[1].swipes, ['第一句话', '第二种开场']);

    assert.ok((await fs.stat(path.join(current.directories.characters, avatar))).isFile());
    assert.ok((await fs.stat(path.join(current.directories.worlds, `${result.knowledge[0].binding.name}.json`))).isFile());

    const repeated = await current.materializer.materialize(current.command, identities());
    assert.deepEqual(repeated, result);
    assert.equal((await fs.readdir(current.directories.characters)).length, 1);
    assert.equal((await fs.readdir(current.directories.worlds)).length, 1);
});

test('reuses one shared internal Runtime Card while blank Worlds keep independent sessions', async (t) => {
    const card = complexCard({ name: 'Nora 空白世界' });
    card.data.first_mes = '';
    card.data.alternate_greetings = [];
    card.data.character_book = null;
    card.data.extensions = { nora_internal: { kind: 'blank-world-runtime' } };
    const current = await harness(t, { card, worldName: '第一个空白世界' });
    current.command.source.type = 'blank-world';
    current.command.payload.runtime_card_kind = 'nora-internal-blank';
    current.command.payload.world_name_source = 'explicit';

    const first = await current.materializer.materialize(current.command, identities('blank-one'));
    const second = await current.materializer.materialize(
        { ...current.command, name: '第二个空白世界' },
        identities('blank-two'),
    );

    assert.equal(first.runtimeCard.ownership, 'shared');
    assert.equal(first.runtimeCard.binding.avatar, second.runtimeCard.binding.avatar);
    assert.equal(first.defaultSession.openingState, 'empty');
    assert.notEqual(first.defaultSession.binding.chat_id, second.defaultSession.binding.chat_id);
    assert.equal((await fs.readdir(current.directories.characters)).length, 1);
});

test('serializes concurrent reuse of one shared embedded Worldbook', async (t) => {
    const current = await harness(t);
    const [first, second] = await Promise.all([
        current.materializer.materialize(current.command, identities('parallel-one')),
        current.materializer.materialize(current.command, identities('parallel-two')),
    ]);

    assert.equal(first.knowledge[0].binding.name, second.knowledge[0].binding.name);
    assert.equal(first.knowledge[0].ownership, 'shared');
    assert.equal(second.knowledge[0].ownership, 'shared');
    assert.equal((await fs.readdir(current.directories.worlds)).length, 1);
});

test('plugs into NoraWorldCore and commits authoritative ST bindings', async (t) => {
    const current = await harness(t);
    const core = createNoraWorldCore({
        root: path.join(current.root, 'world-core'),
        materializer: current.materializer,
    });
    const created = await core.createWorld(current.command, { idempotencyKey: 'phase2:vertical-backend' });

    assert.equal(created.operation.status, 'COMPLETED');
    assert.equal(created.world.lifecycle.status, 'READY');
    assert.equal(created.world.capabilities.status, 'PENDING');
    assert.equal(created.world.runtime_card.binding.avatar.endsWith('.png'), true);
    assert.equal(created.world.sessions.items[0].binding.avatar, created.world.runtime_card.binding.avatar);
    assert.equal(created.world.knowledge[0].binding.name, '同名设定集');
    await assert.rejects(fs.stat(current.stagedPath), error => error?.code === 'ENOENT');
});

test('repairs from filesystem evidence and deletes only owned World resources', async (t) => {
    const current = await harness(t);
    const core = createNoraWorldCore({
        root: path.join(current.root, 'world-core'),
        materializer: current.materializer,
    });
    const created = await core.createWorld(current.command, { idempotencyKey: 'phase7:resource-lifecycle' });
    const avatar = created.world.runtime_card.binding.avatar;
    const session = created.world.sessions.items[0];
    const worldbook = created.world.knowledge[0].binding.name;
    const cardPath = path.join(current.directories.characters, avatar);
    const chatPath = path.join(current.directories.chats, path.parse(avatar).name, `${session.binding.chat_id}.jsonl`);
    const worldbookPath = path.join(current.directories.worlds, `${worldbook}.json`);

    const repaired = await core.repairWorld(created.world.world_id, { idempotencyKey: 'repair:resource-lifecycle' });
    assert.equal(repaired.world.lifecycle.status, 'READY');

    const deleted = await core.deleteWorld(created.world.world_id, { idempotencyKey: 'delete:resource-lifecycle' });
    assert.equal(deleted.world.lifecycle.status, 'DELETED');
    await assert.rejects(fs.stat(cardPath), error => error?.code === 'ENOENT');
    await assert.rejects(fs.stat(chatPath), error => error?.code === 'ENOENT');
    assert.ok((await fs.stat(worldbookPath)).isFile(), 'shared Worldbook must survive World deletion');
    assert.deepEqual(await core.listWorlds(), []);
});

test('rejects a migrated legacy Session without its v2 Session projection or with a conflicting projection', async (t) => {
    const current = await harness(t);
    const core = createNoraWorldCore({
        root: path.join(current.root, 'world-core'),
        materializer: current.materializer,
    });
    const created = await core.createWorld(current.command, { idempotencyKey: 'phase7:legacy-session-inspection' });
    const world = structuredClone(created.world);
    world.source.type = 'legacy-migration';
    const session = world.sessions.items[0];
    const chatPath = path.join(
        current.directories.chats,
        path.parse(world.runtime_card.binding.avatar).name,
        `${session.binding.chat_id}.jsonl`,
    );
    const lines = (await fs.readFile(chatPath, 'utf8')).trim().split('\n').map(JSON.parse);
    delete lines[0].chat_metadata.nora_session;
    await fs.writeFile(chatPath, `${lines.map(JSON.stringify).join('\n')}\n`, 'utf8');

    const missing = await current.materializer.inspect(world);
    assert.equal(missing.ready, false);
    assert.deepEqual(missing.issues.map(issue => issue.code), ['NORA_WORLD_SESSION_BINDING_MISMATCH']);

    lines[0].chat_metadata.nora_session = { id: 'session:conflict', version: 1 };
    await fs.writeFile(chatPath, `${lines.map(JSON.stringify).join('\n')}\n`, 'utf8');
    const conflicting = await current.materializer.inspect(world);
    assert.equal(conflicting.ready, false);
    assert.deepEqual(conflicting.issues.map(issue => issue.code), ['NORA_WORLD_SESSION_BINDING_MISMATCH']);
});

test('creates a header-only Session for a card with no opening message', async (t) => {
    const card = complexCard();
    card.data.first_mes = '';
    card.data.alternate_greetings = [];
    const current = await harness(t, { card });
    const result = await current.materializer.materialize(current.command, identities('empty'));
    const chatPath = path.join(
        current.directories.chats,
        path.parse(result.runtimeCard.binding.avatar).name,
        `${result.defaultSession.binding.chat_id}.jsonl`,
    );
    const lines = (await fs.readFile(chatPath, 'utf8')).trim().split('\n');

    assert.equal(result.defaultSession.openingState, 'empty');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).chat_metadata.nora_world.id, 'world:empty');
});

test('materializes a card without an embedded Worldbook without inventing knowledge', async (t) => {
    const card = complexCard();
    delete card.data.character_book;
    const current = await harness(t, { card });
    const result = await current.materializer.materialize(current.command, identities('no-book'));

    assert.deepEqual(result.knowledge, []);
    assert.deepEqual(await fs.readdir(current.directories.worlds), []);
});

test('does not alias same-name Worldbooks with different content', async (t) => {
    const first = await harness(t, { card: complexCard({ content: 'first content' }) });
    const firstResult = await first.materializer.materialize(first.command, identities('first'));
    const secondCard = complexCard({ content: 'second content' });
    const secondCodec = {
        async decode() {
            return { card: secondCard, runtimeCardBuffer: Buffer.from('runtime:second') };
        },
    };
    const secondMaterializer = createStBackendMaterializer({
        directories: first.directories,
        stagingRoot: first.stagingRoot,
        cardCodec: secondCodec,
        now: () => '2026-08-28T12:00:00.000Z',
    });
    const secondResult = await secondMaterializer.materialize(first.command, identities('second'));

    assert.notEqual(firstResult.knowledge[0].binding.name, secondResult.knowledge[0].binding.name);
    assert.equal((await fs.readdir(first.directories.worlds)).length, 2);
});

test('treats an unmarked matching Worldbook as external and never compensates it', async (t) => {
    const card = complexCard({ bookName: 'External Lore' });
    const current = await harness(t, {
        card,
        checkpoint(stage) {
            if (stage === 'SESSION_CREATED') throw new Error('injected failure');
        },
    });
    await fs.writeFile(
        path.join(current.directories.worlds, 'External Lore.json'),
        `${JSON.stringify(convertEmbeddedBook(card.data.character_book), null, 2)}\n`,
        'utf8',
    );

    await assert.rejects(
        current.materializer.materialize(current.command, identities('failure')),
        /injected failure/,
    );

    assert.ok((await fs.stat(path.join(current.directories.worlds, 'External Lore.json'))).isFile());
    assert.deepEqual(await fs.readdir(current.directories.characters), []);
    assert.deepEqual(await fs.readdir(current.directories.chats), []);
});

test('never removes a shared Worldbook during compensation', async (t) => {
    const current = await harness(t, {
        checkpoint(stage) {
            if (stage === 'SESSION_CREATED') throw new Error('injected failure');
        },
    });

    await assert.rejects(
        current.materializer.materialize(current.command, identities('shared-failure')),
        /injected failure/,
    );

    assert.equal((await fs.readdir(current.directories.worlds)).length, 1);
    assert.deepEqual(await fs.readdir(current.directories.characters), []);
    assert.deepEqual(await fs.readdir(current.directories.chats), []);
});

test('rejects staged files outside the configured staging root before decoding', async (t) => {
    let decoded = false;
    const current = await harness(t, {
        cardCodec: {
            async decode() {
                decoded = true;
                return { card: complexCard(), runtimeCardBuffer: Buffer.from('runtime') };
            },
        },
    });
    current.command.payload.staged_card.path = path.join(current.root, 'outside.png');

    await assert.rejects(
        current.materializer.materialize(current.command, identities('outside')),
        error => error?.code === 'NORA_CARD_STAGING_INVALID',
    );
    assert.equal(decoded, false);
});

test('rejects a symlink that escapes the staging root', async (t) => {
    let decoded = false;
    const current = await harness(t, {
        cardCodec: {
            async decode() {
                decoded = true;
                return { card: complexCard(), runtimeCardBuffer: Buffer.from('runtime') };
            },
        },
    });
    const outside = path.join(current.root, 'outside.png');
    await fs.writeFile(outside, 'outside');
    const symlink = path.join(current.stagingRoot, 'escape.png');
    await fs.symlink(outside, symlink);
    current.command.payload.staged_card.path = symlink;

    await assert.rejects(
        current.materializer.materialize(current.command, identities('symlink')),
        error => error?.code === 'NORA_CARD_STAGING_INVALID',
    );
    assert.equal(decoded, false);
});

test('rejects staged format and source digest mismatches before creating resources', async (t) => {
    const current = await harness(t);
    current.command.payload.staged_card.format = 'json';
    await assert.rejects(
        current.materializer.materialize(current.command, identities('format-mismatch')),
        error => error?.code === 'NORA_CARD_FORMAT_MISMATCH',
    );

    current.command.payload.staged_card.format = 'png';
    current.command.source.sha256 = 'f'.repeat(64);
    await assert.rejects(
        current.materializer.materialize(current.command, identities('digest-mismatch')),
        error => error?.code === 'NORA_CARD_SOURCE_MISMATCH',
    );
    assert.deepEqual(await fs.readdir(current.directories.characters), []);
});
