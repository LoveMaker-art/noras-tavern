import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createNoraWorldCore } from '../src/nora-world-core/index.js';
import { createStBackendMaterializer } from '../src/nora-world-core/st-backend-materializer.js';

// HTTP saves may start an asynchronous story-memory projection. Isolate its
// Python state/memory targets for the entire test process, including teardown.
// Restoring ambient env per fixture would let a late child reach user files.
const projectionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nora-storage-projection-'));
Object.assign(process.env, {
    TAVERN_APP_DIR: fileURLToPath(new URL('../../../', import.meta.url)), TAVERN_STATE_DIR: path.join(projectionRoot, 'profile'),
    TAVERN_HERMES_MEMORIES_DIR: path.join(projectionRoot, 'memories'),
    TAVERN_HERMES_STATE_DB: path.join(projectionRoot, 'missing.db'),
});
process.once('exit', () => fsSync.rmSync(projectionRoot, { recursive: true, force: true }));

// Synthetic card codec: image encoding is outside the storage lifecycle seam.
// World identities, materialization, manifests and deletion use production code.
export async function storageFixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nora-storage-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const directories = { root };
    for (const name of ['characters', 'chats', 'worlds', 'backups']) {
        directories[name] = path.join(root, name);
        await fs.mkdir(directories[name]);
    }
    const stagingRoot = path.join(root, 'nora-world-core', 'staging');
    await fs.mkdir(stagingRoot, { recursive: true });
    const card = { spec: 'chara_card_v3', spec_version: '3.0', data: {
        name: '同名测试世界', description: 'Synthetic fixture', personality: '', scenario: '',
        first_mes: '', mes_example: '', extensions: {},
    } };
    const buffer = Buffer.from(JSON.stringify(card));
    const materializer = createStBackendMaterializer({ directories, stagingRoot, cardCodec: {
        async decode() { return { card: structuredClone(card), runtimeCardBuffer: buffer }; },
        async encodeRuntimeCard({ card: value }) { return Buffer.from(JSON.stringify(value)); },
    } });
    const core = createNoraWorldCore({ root: path.join(root, 'nora-world-core'), materializer });
    async function create(key) {
        const file = path.join(stagingRoot, `${key}.json`);
        await fs.writeFile(file, buffer);
        return (await core.createWorld({ name: card.data.name, persona: { name: '玩家', description: '' },
            source: { type: 'character-card', sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
                original_name: 'fixture.json', format: 'json' },
            payload: { staged_card: { path: file, format: 'json' } },
        }, { idempotencyKey: `fixture:${key}` })).world;
    }
    async function chat(world) {
        const file = path.join(directories.chats, path.basename(world.runtime_card.binding.avatar, '.png'),
            `${world.sessions.items[0].binding.chat_id}.jsonl`);
        return (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
    }
    async function backup(name, lines) {
        const content = typeof lines === 'string' ? lines : lines.map(line => JSON.stringify(line)).join('\n');
        await fs.writeFile(path.join(directories.backups, name), content);
        return content;
    }
    return { root, directories, core, create, chat, backup };
}
