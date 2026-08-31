import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { stageStCardImport } from '../src/nora-world-core/st-import-staging.js';

test('concurrent different uploads cannot overwrite the same immutable operation artifact', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tavern-staging-race-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const uploads = await Promise.all(['first', 'second'].map(async name => {
        const file = path.join(root, `${name}.json`);
        await fs.writeFile(file, JSON.stringify({ name }));
        return { path: file, originalname: `${name}.json` };
    }));
    const results = await Promise.allSettled(uploads.map(uploadedFile => stageStCardImport({ uploadedFile, idempotencyKey: 'same-request', stagingRoot: path.join(root, 'staging') })));
    assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(results.find(item => item.status === 'rejected')?.reason.code, 'NORA_OPERATION_CONFLICT');
    const winner = results.find(item => item.status === 'fulfilled').value;
    assert.equal(createHash('sha256').update(await fs.readFile(winner.payload.staged_card.path)).digest('hex'), winner.source.sha256);
    assert.equal((await fs.readdir(path.join(root, 'staging'))).length, 1);
});
