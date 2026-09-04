import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import sanitize from 'sanitize-filename';

import { isPathUnderParent } from '../util.js';
import { NoraWorldCoreError } from './errors.js';
import { adaptCardForMvuRuntime } from './st-backend-materializer.js';

function safeAvatar(value) {
    const avatar = String(value || '').trim();
    if (!avatar || path.basename(avatar) !== avatar) {
        throw new NoraWorldCoreError('NORA_WORLD_STORAGE_CORRUPT', 'World Runtime Card binding is invalid.');
    }
    return avatar;
}

function safeChatPath(directories, avatar, chatId) {
    const characterDirectory = avatar.replace(/\.png$/i, '');
    const fileName = sanitize(`${String(chatId || '').trim()}.jsonl`);
    const filePath = path.join(directories.chats, characterDirectory, fileName);
    if (!fileName || !isPathUnderParent(directories.chats, filePath)) {
        throw new NoraWorldCoreError('NORA_WORLD_STORAGE_CORRUPT', 'World Story Session binding is invalid.');
    }
    return filePath;
}

function worldbookFiles(directories, plan) {
    return (plan.knowledge || []).map(resource => {
        const name = String(resource?.binding?.name || '').trim();
        if (!name) return null;
        const fileName = sanitize(`${name}.json`);
        const filePath = path.join(directories.worlds, fileName);
        if (!fileName || !isPathUnderParent(directories.worlds, filePath)) {
            throw new NoraWorldCoreError('NORA_WORLD_STORAGE_CORRUPT', 'World Knowledge Resource binding is invalid.');
        }
        return { name, filePath };
    }).filter(Boolean);
}

function projectRuntimeWorldbookBinding(character, plan) {
    const worldbookName = String(plan?.knowledge?.[0]?.binding?.name || '').trim();
    if (!worldbookName) return character;
    const projected = structuredClone(character);
    const data = projected?.data && typeof projected.data === 'object' ? projected.data : projected;
    const extensions = data?.extensions && typeof data.extensions === 'object' && !Array.isArray(data.extensions)
        ? data.extensions
        : {};
    data.extensions = { ...extensions, world: worldbookName };
    return projected;
}

/**
 * Avoid sending the card's embedded Character Book twice when the materialized
 * ST Worldbook still contains the exact same original payload. The client
 * restores the card field before handing the snapshot to the ST runtime.
 * Diverged/user-edited Worldbooks intentionally keep both copies.
 */
function deduplicateEmbeddedWorldbook(character, worldbooks) {
    const data = character?.data && typeof character.data === 'object' ? character.data : character;
    const embeddedBook = data?.character_book;
    if (!embeddedBook || typeof embeddedBook !== 'object') {
        return { character, binding: null };
    }
    const source = worldbooks.find(worldbook => (
        worldbook?.data?.originalData
        && isDeepStrictEqual(worldbook.data.originalData, embeddedBook)
    ));
    if (!source) return { character, binding: null };

    const compactCharacter = structuredClone(character);
    const compactData = compactCharacter?.data && typeof compactCharacter.data === 'object'
        ? compactCharacter.data
        : compactCharacter;
    delete compactData.character_book;
    return {
        character: compactCharacter,
        binding: Object.freeze({ name: source.name }),
    };
}

function nowMs() {
    return Number(process.hrtime.bigint()) / 1e6;
}

async function measured(name, operation, timings, clock = nowMs) {
    const startedAt = clock();
    try {
        return await operation();
    } finally {
        timings[name] = Math.round((clock() - startedAt) * 10) / 10;
    }
}

async function fileRevision(label, filePath, stat = fs.stat) {
    try {
        const value = await stat(filePath, { bigint: true });
        return `${label}:${value.size}:${value.mtimeNs}`;
    } catch (error) {
        if (error?.code === 'ENOENT') return `${label}:missing`;
        throw error;
    }
}

let endpointReadersPromise;

async function endpointReaders() {
    endpointReadersPromise ??= Promise.all([
        import('../endpoints/characters.js'),
        import('../endpoints/chats.js'),
        import('../endpoints/worldinfo.js'),
    ]).then(([characters, chats, worldinfo]) => Object.freeze({
        character: characters.getCharacterByAvatar,
        chat: chats.getChatWindowData,
        worldbook: worldinfo.readWorldInfoFile,
    }));
    return endpointReadersPromise;
}

export async function getActivationSnapshotRevision(plan, directories, { stat = fs.stat } = {}) {
    const avatar = safeAvatar(plan?.runtime_card?.binding?.avatar);
    const chatId = String(plan?.session?.binding?.chat_id || '').trim();
    const files = [
        ['character', path.join(directories.characters, avatar)],
        ['session', safeChatPath(directories, avatar, chatId)],
        ...worldbookFiles(directories, plan).map(({ name, filePath }) => [`worldbook:${name}`, filePath]),
    ];
    const fileRevisions = await Promise.all(files.map(([label, filePath]) => fileRevision(label, filePath, stat)));
    return crypto.createHash('sha256')
        .update(JSON.stringify({ worldId: plan.world_id, worldRevision: plan.world_revision, fileRevisions }))
        .digest('hex');
}

export async function readActivationSnapshot(plan, directories, {
    revision = null,
    chatWindow = 40,
    readers = null,
    clock = nowMs,
} = {}) {
    const timings = {};
    const avatar = safeAvatar(plan?.runtime_card?.binding?.avatar);
    const chatId = String(plan?.session?.binding?.chat_id || '').trim();
    const books = worldbookFiles(directories, plan);
    const activeReaders = readers || await endpointReaders();
    const chatPath = safeChatPath(directories, avatar, chatId);
    const [character, chat, worldbooks] = await Promise.all([
        measured('character', () => activeReaders.character(directories, avatar), timings, clock),
        measured('chat', () => activeReaders.chat(chatPath, { limit: chatWindow }), timings, clock),
        measured('worldbooks', () => Promise.all(books.map(async ({ name }) => ({
            name,
            data: await activeReaders.worldbook(directories, name, true),
        }))), timings, clock),
    ]);
    if (!character) {
        throw new NoraWorldCoreError('NORA_WORLD_NOT_READY', 'World Runtime Card is unavailable.', {
            details: { worldId: plan.world_id },
        });
    }
    const runtimeCharacter = adaptCardForMvuRuntime(projectRuntimeWorldbookBinding(character, plan)).card;
    const compacted = deduplicateEmbeddedWorldbook(runtimeCharacter, worldbooks);
    const resolvedRevision = revision || await measured(
        'revision',
        () => getActivationSnapshotRevision(plan, directories),
        timings,
        clock,
    );
    return Object.freeze({
        snapshot: Object.freeze({
            schema: 'nora-world-snapshot/v1',
            revision: resolvedRevision,
            plan,
            character: compacted.character,
            chat,
            worldbooks,
            ...(compacted.binding ? { embedded_worldbook_binding: compacted.binding } : {}),
        }),
        timings: Object.freeze(timings),
    });
}
