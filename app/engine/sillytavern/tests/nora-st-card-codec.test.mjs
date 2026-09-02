import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';

import { createStCardCodec } from '../src/nora-world-core/st-card-codec.js';
import { inspectStCard } from '../src/nora-world-core/st-backend-materializer.js';
import { adaptCardForMvuRuntime } from '../public/scripts/nora-compat/mvu-compatibility.js';

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const engineRoot = path.resolve(testRoot, '..');
const fixtureRoot = path.join(testRoot, 'fixtures', 'nora-world-compat');
const codec = createStCardCodec({ serverRoot: engineRoot });

for (const fixture of [
    { filename: 'sanitized-v2.png', format: 'png', spec: 'chara_card_v2', name: 'Nora V2 兼容测试角色' },
    { filename: 'sanitized-v2.json', format: 'json', spec: 'chara_card_v2', name: 'Nora V2 兼容测试角色' },
    { filename: 'sanitized-managed-mvu-v3.png', format: 'png', spec: 'chara_card_v3', name: 'Nora Managed MVU 测试角色' },
    { filename: 'sanitized-v3.charx', format: 'charx', spec: 'chara_card_v3', name: 'Nora CHARX 兼容测试角色' },
]) {
    test(`decodes canonical ${fixture.filename} into an ST runtime PNG`, async () => {
        const buffer = await fs.readFile(path.join(fixtureRoot, fixture.filename));
        const decoded = await codec.decode({ buffer, format: fixture.format });

        assert.equal(decoded.card.spec, fixture.spec);
        assert.equal(decoded.card.data.name, fixture.name);
        assert.ok(Buffer.isBuffer(decoded.runtimeCardBuffer));
        assert.ok(decoded.runtimeCardBuffer.length > 0);
    });
}

test('rejects flattened V1-shaped JSON even when it carries a V2 spec label', async () => {
    const hybrid = Buffer.from(JSON.stringify({
        spec: 'chara_card_v2',
        spec_version: '2.0',
        name: 'Flattened legacy fixture',
        description: '',
        personality: '',
        scenario: '',
        first_mes: '',
        mes_example: '',
    }));

    await assert.rejects(
        codec.decode({ buffer: hybrid, format: 'json' }),
        error => error?.code === 'NORA_CARD_FORMAT_UNSUPPORTED'
            && /spec label must store its fields under data/.test(error.message),
    );
});

test('converts an ST V1 JSON card while preserving foreign extension data', async () => {
    const decoded = await codec.decode({
        format: 'json',
        buffer: Buffer.from(JSON.stringify({
            name: 'Legacy V1',
            description: 'description',
            personality: 'personality',
            scenario: 'scenario',
            first_mes: 'hello',
            mes_example: '<START>',
            creatorcomment: 'notes',
            tags: 'legacy, test',
            data: { extensions: { custom_plugin: { enabled: true } } },
        })),
    });

    assert.equal(decoded.card.spec, 'chara_card_v2');
    assert.equal(decoded.card.data.name, 'Legacy V1');
    assert.deepEqual(decoded.card.data.tags, ['legacy', 'test']);
    assert.deepEqual(decoded.card.data.extensions.custom_plugin, { enabled: true });
});

test('converts a Pygmalion notebook JSON card', async () => {
    const decoded = await codec.decode({
        format: 'json',
        buffer: Buffer.from(JSON.stringify({
            char_name: 'Pygmalion Card',
            char_persona: 'persona',
            char_greeting: 'hello',
            example_dialogue: '<START>',
            world_scenario: 'scenario',
        })),
    });

    assert.equal(decoded.card.spec, 'chara_card_v2');
    assert.equal(decoded.card.data.name, 'Pygmalion Card');
    assert.equal(decoded.card.data.description, 'persona');
    assert.equal(decoded.card.data.scenario, 'scenario');
});

test('converts the YAML character format accepted by ST', async () => {
    const decoded = await codec.decode({
        format: 'yaml',
        buffer: Buffer.from('name: YAML Card\ncontext: YAML persona\ngreeting: YAML hello\n'),
    });

    assert.equal(decoded.card.spec, 'chara_card_v2');
    assert.equal(decoded.card.data.name, 'YAML Card');
    assert.equal(decoded.card.data.description, 'YAML persona');
    assert.equal(decoded.card.data.first_mes, 'YAML hello');
});

test('preserves CCv3 standard fields and unknown plugin extensions through the runtime PNG', async () => {
    const data = {
        name: 'Complete CCv3',
        description: 'description',
        personality: 'personality',
        scenario: 'scenario',
        first_mes: 'hello',
        mes_example: '<START>',
        creator_notes: 'notes',
        system_prompt: 'system',
        post_history_instructions: 'post history',
        alternate_greetings: ['alternate'],
        group_only_greetings: ['group greeting'],
        tags: ['test'],
        creator: 'creator',
        character_version: '3',
        nickname: 'nickname',
        creator_notes_multilingual: { zh: '中文说明', en: 'English notes' },
        source: ['https://example.invalid/card'],
        assets: [{ type: 'icon', uri: 'https://example.invalid/icon.png', name: 'main', ext: 'png' }],
        character_book: {
            name: 'book',
            description: 'book description',
            scan_depth: 7,
            token_budget: 2048,
            recursive_scanning: true,
            extensions: { book_plugin: { value: 1 } },
            entries: [{
                id: 9,
                name: 'entry',
                keys: ['key'],
                secondary_keys: ['secondary'],
                content: 'content',
                enabled: true,
                insertion_order: 12,
                case_sensitive: true,
                use_regex: true,
                constant: false,
                selective: true,
                position: 'before_char',
                priority: 4,
                comment: 'comment',
                extensions: { entry_plugin: { value: 2 } },
            }],
        },
        extensions: { unknown_plugin: { nested: ['preserved'] } },
    };
    const decoded = await codec.decode({
        format: 'json',
        buffer: Buffer.from(JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data })),
    });
    const roundTrip = await codec.decode({ buffer: decoded.runtimeCardBuffer, format: 'png' });

    assert.deepEqual(roundTrip.card.data, data);
});

test('converts the BYAF character, lore and scenario data accepted by ST', async () => {
    const archive = zipSync({
        'manifest.json': strToU8(JSON.stringify({
            schemaVersion: 1,
            createdAt: '2026-09-02T00:00:00.000Z',
            characters: ['characters/card.json'],
            scenarios: ['scenarios/start.json'],
            author: { name: 'BYAF author', backyardURL: 'https://example.invalid/author' },
        })),
        'characters/card.json': strToU8(JSON.stringify({
            schemaVersion: 1,
            id: 'byaf-card',
            name: 'BYAF Card',
            displayName: 'BYAF Display Name',
            isNSFW: false,
            persona: 'BYAF persona',
            loreItems: [{ key: 'city, home', value: 'BYAF lore' }],
            images: [],
        })),
        'scenarios/start.json': strToU8(JSON.stringify({
            schemaVersion: 1,
            title: 'Start',
            formattingInstructions: 'BYAF system prompt',
            firstMessages: [{ characterID: 'byaf-card', text: 'BYAF hello' }],
            exampleMessages: [],
            narrative: 'BYAF scenario',
            messages: [],
        })),
    });

    const decoded = await codec.decode({ format: 'byaf', buffer: Buffer.from(archive) });

    assert.equal(decoded.card.spec, 'chara_card_v2');
    assert.equal(decoded.card.data.name, 'BYAF Card');
    assert.equal(decoded.card.data.first_mes, 'BYAF hello');
    assert.equal(decoded.card.data.character_book.entries[0].content, 'BYAF lore');
    assert.ok(decoded.runtimeCardBuffer.length > 0);
});

test('decodes CHARX embedded expressions for authoritative ST materialization', async () => {
    const archive = zipSync({
        'card.json': strToU8(JSON.stringify({
            spec: 'chara_card_v3',
            spec_version: '3.0',
            data: {
                name: 'CHARX Assets',
                assets: [{ type: 'expression', name: 'happy', ext: 'png', uri: 'embedded://assets/happy.png' }],
                extensions: {},
            },
        })),
        'assets/happy.png': new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    });

    const decoded = await codec.decode({ format: 'charx', buffer: Buffer.from(archive) });

    assert.equal(decoded.auxiliaryAssets.length, 1);
    assert.equal(decoded.auxiliaryAssets[0].storageCategory, 'sprite');
    assert.equal(decoded.auxiliaryAssets[0].baseName, 'happy');
    assert.deepEqual(
        decoded.extractedAssetBuffers.get('assets/happy.png'),
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
});

test('encodes the normalized MVU compatibility projection into the Runtime Card PNG', async () => {
    const source = await fs.readFile(path.join(fixtureRoot, 'sanitized-v2.png'));
    const decoded = await codec.decode({ buffer: source, format: 'png' });
    decoded.card.data.extensions.TavernHelper_scripts = [{
        type: 'script',
        value: { type: 'script', id: 'legacy-mvu', enabled: true, content: 'MagicalAstrogy/MagVarUpdate/artifact/bundle.js' },
    }];
    decoded.card.data.character_book.entries[0].comment = '变量规则';
    decoded.card.data.character_book.entries[0].content = '<status_current_variables>\nReturn <UpdateVariable> commands.';

    const adaptation = adaptCardForMvuRuntime(decoded.card);
    const encoded = await codec.encodeRuntimeCard({ card: adaptation.card, sourceBuffer: decoded.runtimeCardBuffer });
    const roundTrip = await codec.decode({ buffer: encoded, format: 'png' });

    assert.equal(roundTrip.card.data.extensions.TavernHelper_scripts, undefined);
    assert.equal(roundTrip.card.data.extensions.tavern_helper.scripts[0].id, 'legacy-mvu');
    assert.equal(roundTrip.card.data.extensions.tavern_helper.scripts[0].enabled, false);
    assert.equal(roundTrip.card.data.extensions.nora_mvu_compatibility.managed_runtime, true);
    assert.match(roundTrip.card.data.character_book.entries[0].comment, /^\[mvu_update\]/i);
});

for (const fixture of [
    { filename: 'sanitized-regex-v3.json', declared: ['regex'], mvuSource: 'none' },
    { filename: 'sanitized-tavern-helper-v3.json', declared: ['tavern_helper'], mvuSource: 'none' },
    { filename: 'sanitized-managed-mvu-v3.json', declared: ['mvu', 'tavern_helper'], mvuSource: 'managed' },
    { filename: 'sanitized-embedded-mvu-v3.json', declared: ['mvu', 'tavern_helper'], mvuSource: 'managed' },
]) {
    test(`preserves the ${fixture.filename} capability boundary`, async () => {
        const card = JSON.parse(await fs.readFile(path.join(fixtureRoot, fixture.filename), 'utf8'));
        const report = inspectStCard(card);

        assert.deepEqual(report.declared_capabilities, fixture.declared);
        assert.equal(report.capabilities.mvu.runtime_source, fixture.mvuSource);
    });
}
