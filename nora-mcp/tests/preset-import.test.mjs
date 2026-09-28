import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NoraControlPlane } from '../dist/nora-control-plane.js';
import { allowedTool } from '../dist/tool-policy.js';

test('preset file tool transfers JSON outside control parameters and rejects unsafe, invalid and oversized files', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nora-preset-file-'));
    t.after(() => fs.rm(root, { force: true, recursive: true }));
    const uploadRoot = path.join(root, 'uploads');
    await fs.mkdir(uploadRoot);
    const calls = [];
    const nora = new NoraControlPlane({ uploadRoot }, { post: async (...args) => { calls.push(args); return { saved: true }; } });
    const filePath = path.join(uploadRoot, 'authored.json');
    const json = JSON.stringify({ prompts: [{ content: 'x'.repeat(2100000) }], extensions: { untouched: true } });
    await fs.writeFile(filePath, json);
    assert.equal((await nora.importPreset({ filePath, name: 'Authored' })).saved, true);
    assert.deepEqual(calls[0], ['/api/presets/nora-import', { name: 'Authored', json }]);
    assert.equal(allowedTool('nora.preset.import', 'operator'), true);
    assert.equal(allowedTool('nora.preset.import', 'read-only'), false);
    const outside = path.join(root, 'outside.json');
    await fs.writeFile(outside, '{}');
    await fs.symlink(outside, path.join(uploadRoot, 'escape.json'));
    for (const filePath of [outside, path.join(uploadRoot, 'escape.json')]) {
        await assert.rejects(nora.importPreset({ filePath, name: 'No' }), { code: 'NORA_IMPORT_PATH_DENIED' });
    }
    await fs.writeFile(filePath, Buffer.from([0xff]));
    await assert.rejects(nora.importPreset({ filePath, name: 'No' }), { code: 'NORA_PRESET_INVALID' });
    await fs.writeFile(filePath, ' '.repeat(10 * 1024 * 1024 + 1));
    await assert.rejects(nora.importPreset({ filePath, name: 'No' }), { code: 'NORA_PRESET_TOO_LARGE' });
    assert.equal(calls.length, 1);
});
