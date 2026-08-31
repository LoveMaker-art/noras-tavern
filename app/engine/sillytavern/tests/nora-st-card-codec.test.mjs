import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createStCardCodec } from '../src/nora-world-core/st-card-codec.js';
import { inspectStCard } from '../src/nora-world-core/st-backend-materializer.js';

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
            && /V1 JSON cards require canonical ST conversion/.test(error.message),
    );
});

for (const fixture of [
    { filename: 'sanitized-regex-v3.json', declared: ['regex'], mvuSource: 'none' },
    { filename: 'sanitized-tavern-helper-v3.json', declared: ['tavern_helper'], mvuSource: 'none' },
    { filename: 'sanitized-managed-mvu-v3.json', declared: ['mvu', 'tavern_helper'], mvuSource: 'managed' },
    { filename: 'sanitized-embedded-mvu-v3.json', declared: ['mvu', 'tavern_helper'], mvuSource: 'embedded' },
]) {
    test(`preserves the ${fixture.filename} capability boundary`, async () => {
        const card = JSON.parse(await fs.readFile(path.join(fixtureRoot, fixture.filename), 'utf8'));
        const report = inspectStCard(card);

        assert.deepEqual(report.declared_capabilities, fixture.declared);
        assert.equal(report.capabilities.mvu.runtime_source, fixture.mvuSource);
    });
}
