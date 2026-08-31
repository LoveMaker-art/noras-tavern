import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

import { normalizeIdempotencyKey, sha256 } from './domain.js';
import { NoraWorldCoreError } from './errors.js';

const MAX_CARD_BYTES = 100 * 1024 * 1024;
const SUPPORTED_FORMATS = new Set(['png', 'json', 'charx']);
const BLANK_RUNTIME_CARD_NAME = 'Nora 空白世界';

function cardFormat(fileName) {
    const format = path.extname(String(fileName || '')).slice(1).toLowerCase();
    if (!SUPPORTED_FORMATS.has(format)) {
        throw new NoraWorldCoreError(
            'NORA_CARD_FORMAT_UNSUPPORTED',
            `Character card format ${format || '<empty>'} is not supported.`,
        );
    }
    return format;
}

async function persistImmutable(filePath, buffer) {
    try {
        const stat = await fs.lstat(filePath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
            throw new NoraWorldCoreError('NORA_CARD_STAGING_INVALID', 'The staged card target is not a regular file.');
        }
        const existing = await fs.readFile(filePath);
        if (!existing.equals(buffer)) {
            throw new NoraWorldCoreError(
                'NORA_OPERATION_CONFLICT',
                'The idempotency key was already staged with a different character card.',
            );
        }
        return;
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let handle;
    try {
        handle = await fs.open(temporary, 'wx', 0o600);
        await handle.writeFile(buffer);
        await handle.sync();
        await handle.close();
        handle = null;
        // rename() replaces an existing file on POSIX. Publish without replacing
        // the winner of a concurrent request carrying the same operation key.
        await fs.link(temporary, filePath);
        await fs.unlink(temporary);
    } catch (error) {
        await handle?.close().catch(() => {});
        await fs.unlink(temporary).catch(() => {});
        if (error?.code === 'EEXIST') return persistImmutable(filePath, buffer);
        throw error;
    }
}

async function stageCardBuffer({
    buffer,
    originalName,
    sourceType,
    idempotencyKey,
    persona,
    worldName,
    stagingRoot,
    payload = {},
}) {
    const key = normalizeIdempotencyKey(idempotencyKey);
    const format = cardFormat(originalName);
    if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_CARD_BYTES) {
        throw new NoraWorldCoreError('NORA_CARD_STAGING_INVALID', 'The character card has an invalid size.');
    }
    const root = path.resolve(String(stagingRoot || ''));
    if (!path.isAbsolute(String(stagingRoot || ''))) {
        throw new NoraWorldCoreError('NORA_CARD_STAGING_INVALID', 'The card staging root must be absolute.');
    }
    await fs.mkdir(root, { recursive: true });
    const stagedPath = path.join(root, `${sha256(key).slice(0, 40)}.${format}`);
    await persistImmutable(stagedPath, buffer);
    const requestedName = String(worldName || '').trim();
    return {
        name: requestedName || path.parse(originalName).name,
        persona: {
            name: String(persona?.name || '').trim(),
            description: String(persona?.description || '').trim(),
        },
        source: {
            type: sourceType,
            sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
            original_name: originalName,
            format,
        },
        payload: {
            staged_card: { path: stagedPath, format },
            world_name_source: requestedName ? 'explicit' : 'card',
            ...payload,
        },
    };
}

export async function stageStCardImport({
    uploadedFile,
    idempotencyKey,
    persona = {},
    worldName = '',
    stagingRoot,
}) {
    const sourcePath = path.resolve(String(uploadedFile?.path || ''));
    const originalName = path.basename(String(uploadedFile?.originalname || ''));
    if (!sourcePath || !originalName) {
        throw new NoraWorldCoreError('NORA_CARD_STAGING_INVALID', 'One uploaded character card is required.');
    }
    const buffer = await fs.readFile(sourcePath).catch(error => {
        throw new NoraWorldCoreError('NORA_CARD_STAGING_INVALID', 'The uploaded character card cannot be read.', { cause: error });
    });
    return stageCardBuffer({
        buffer,
        originalName,
        sourceType: 'character-card',
        idempotencyKey,
        persona,
        worldName,
        stagingRoot,
    });
}

// Read only a regular card in the authenticated user's library. Preserve all card bytes.
export async function stageLibraryCard({ avatar, charactersRoot, idempotencyKey, stagingRoot }) {
    if (typeof avatar !== 'string' || !avatar || /[\\/\0]/.test(avatar)
        || path.basename(avatar) !== avatar || path.extname(avatar).toLowerCase() !== '.png'
        || !path.isAbsolute(String(charactersRoot || ''))) {
        throw new NoraWorldCoreError('NORA_CARD_STAGING_INVALID', '请选择有效的角色卡。');
    }
    let handle;
    try {
        handle = await fs.open(path.join(charactersRoot, avatar), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size < 1 || stat.size > MAX_CARD_BYTES) throw new Error('Invalid library file');
        const buffer = await handle.readFile();
        return await stageCardBuffer({ buffer, originalName: avatar, sourceType: 'character-card',
            idempotencyKey, stagingRoot, payload: { library_avatar: avatar } });
    } catch (error) {
        if (error instanceof NoraWorldCoreError) throw error;
        throw new NoraWorldCoreError('NORA_CARD_STAGING_INVALID', '角色卡不存在或无法读取，请刷新角色卡库。', { cause: error });
    } finally {
        await handle?.close();
    }
}

export async function stageBlankWorld({ idempotencyKey, persona = {}, worldName, stagingRoot }) {
    const name = String(worldName || '').trim();
    if (!name) throw new NoraWorldCoreError('NORA_WORLD_INVALID', 'A blank World name is required.');
    const card = {
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data: {
            name: BLANK_RUNTIME_CARD_NAME,
            description: '',
            personality: '',
            scenario: '',
            first_mes: '',
            mes_example: '',
            creator_notes: '',
            system_prompt: '',
            post_history_instructions: '',
            alternate_greetings: [],
            tags: [],
            creator: 'Nora',
            character_version: '1',
            extensions: { nora_internal: { kind: 'blank-world-runtime' } },
        },
    };
    return stageCardBuffer({
        buffer: Buffer.from(JSON.stringify(card)),
        originalName: 'nora-blank-world.json',
        sourceType: 'blank-world',
        idempotencyKey,
        persona,
        worldName: name,
        stagingRoot,
        payload: { runtime_card_kind: 'nora-internal-blank' },
    });
}
