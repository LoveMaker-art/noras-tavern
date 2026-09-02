import crypto from 'node:crypto';
import { removeSessionLedger } from '../nora-story-ledger/state-file.js';
import { requestStoryProjection } from '../nora-story-ledger/profile-projection.js';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
    adaptCardForMvuRuntime,
    inspectMvuCompatibility,
    normalizeTavernHelperScripts,
} from '../../public/scripts/nora-compat/mvu-compatibility.js';
import { cloneJson, sha256, stableStringify } from './domain.js';
import { NoraWorldCoreError } from './errors.js';
import { KeyedLock } from './locks.js';
import { createStCardCodec } from './st-card-codec.js';

export { adaptCardForMvuRuntime };

const INTERNAL_BLANK_RUNTIME_BASE = 'Nora_Blank_World--nora-internal';

const ENTRY_DEFAULTS = Object.freeze({
    key: [],
    keysecondary: [],
    comment: '',
    content: '',
    constant: false,
    vectorized: false,
    selective: true,
    selectiveLogic: 0,
    addMemo: false,
    order: 100,
    position: 0,
    disable: false,
    ignoreBudget: false,
    excludeRecursion: false,
    preventRecursion: false,
    matchPersonaDescription: false,
    matchCharacterDescription: false,
    matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false,
    matchScenario: false,
    matchCreatorNotes: false,
    delayUntilRecursion: 0,
    probability: 100,
    useProbability: true,
    depth: 4,
    outletName: '',
    group: '',
    groupOverride: false,
    groupWeight: 100,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    useGroupScoring: null,
    automationId: '',
    role: 0,
    sticky: null,
    cooldown: null,
    delay: null,
    triggers: [],
});

function record(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cardData(card) {
    return record(card?.data && typeof card.data === 'object' ? card.data : card);
}

function bindRuntimeCardWorldbook(card, worldbookName) {
    const name = String(worldbookName || '').trim();
    if (!name) return card;
    const projected = cloneJson(card);
    const data = cardData(projected);
    data.extensions = { ...record(data.extensions), world: name };
    return projected;
}

function capabilityInspection(card, books) {
    const data = cardData(card);
    const regexScripts = Array.isArray(data.extensions?.regex_scripts) ? data.extensions.regex_scripts : [];
    const scripts = normalizeTavernHelperScripts(card);
    const mvu = inspectMvuCompatibility({ card, books, helperScripts: scripts });
    const declared = [];
    if (mvu.declared) declared.push('mvu');
    if (regexScripts.length) declared.push('regex');
    if (scripts.length || mvu.declared) declared.push('tavern_helper');
    return {
        declared: declared.sort(),
        items: {
            regex: { script_count: regexScripts.length },
            tavern_helper: { script_count: scripts.length },
            mvu: {
                declared: mvu.declared,
                runtime_source: mvu.runtimeSource,
                update_protocol: mvu.updateProtocol,
                split_model_supported: mvu.splitModelSupported,
                update_entry_ids: [...mvu.updateEntryIds],
                reasons: [...mvu.reasons],
            },
        },
    };
}

function safeEngineName(value, fallback) {
    const safe = String(value || '')
        .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
        .replace(/[. ]+$/g, '')
        .trim()
        .slice(0, 120);
    return safe && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(safe) ? safe : fallback;
}

function assertIdentity(value, field) {
    const normalized = String(value || '').trim();
    if (!normalized) throw new NoraWorldCoreError('NORA_WORLD_INVALID', `${field} is required by the ST backend adapter.`);
    return normalized;
}

function isoDate(value) {
    const normalized = String(value || '');
    if (!Number.isFinite(Date.parse(normalized))) throw new NoraWorldCoreError('NORA_WORLD_INVALID', 'Materialization clock returned an invalid date.');
    return normalized;
}

function inside(root, target) {
    const relative = path.relative(root, target);
    return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function fileDigest(filePath) {
    return bufferDigest(await fs.readFile(filePath));
}

function bufferDigest(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

async function writeAtomic(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    let handle;
    try {
        handle = await fs.open(temporary, 'wx', 0o600);
        await handle.writeFile(value);
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.rename(temporary, filePath);
    } catch (error) {
        await handle?.close().catch(() => {});
        await fs.unlink(temporary).catch(() => {});
        throw error;
    }
}

async function ensureFile(filePath, value) {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    const expectedDigest = bufferDigest(buffer);
    try {
        const existing = await fs.readFile(filePath);
        if (bufferDigest(existing) !== expectedDigest) {
            throw new NoraWorldCoreError(
                'NORA_ST_RESOURCE_CONFLICT',
                `ST resource ${path.basename(filePath)} already exists with different content.`,
                { details: { filePath } },
            );
        }
        return { created: false, digest: expectedDigest };
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    await writeAtomic(filePath, buffer);
    return { created: true, digest: expectedDigest };
}

function worldbookDocumentDigest(worldbookData) {
    const copy = cloneJson(worldbookData);
    if (copy.extensions?.nora_resource) {
        delete copy.extensions.nora_resource;
        if (!Object.keys(copy.extensions).length) delete copy.extensions;
    }
    return sha256(stableStringify(copy));
}

function isNoraWorldbook(worldbookData, digest) {
    return worldbookData?.extensions?.nora_resource?.schema === 1
        && worldbookData.extensions.nora_resource.content_sha256 === digest
        && worldbookDocumentDigest(worldbookData) === digest;
}

export function convertEmbeddedBook(characterBook) {
    const entries = Array.isArray(characterBook?.entries) ? characterBook.entries : [];
    const result = { entries: {}, originalData: cloneJson(characterBook) };
    entries.forEach((rawEntry, index) => {
        const entry = record(rawEntry);
        const extensions = record(entry.extensions);
        const id = entry.id ?? index;
        result.entries[id] = {
            ...ENTRY_DEFAULTS,
            uid: id,
            key: Array.isArray(entry.keys) ? cloneJson(entry.keys) : [],
            keysecondary: Array.isArray(entry.secondary_keys) ? cloneJson(entry.secondary_keys) : [],
            comment: String(entry.comment || ''),
            content: String(entry.content || ''),
            constant: Boolean(entry.constant),
            selective: Boolean(entry.selective),
            order: Number.isFinite(Number(entry.insertion_order)) ? Number(entry.insertion_order) : 100,
            position: extensions.position ?? (entry.position === 'before_char' ? 0 : 1),
            excludeRecursion: extensions.exclude_recursion ?? false,
            preventRecursion: extensions.prevent_recursion ?? false,
            delayUntilRecursion: extensions.delay_until_recursion ?? false,
            disable: entry.enabled === false,
            addMemo: Boolean(entry.comment),
            displayIndex: extensions.display_index ?? index,
            probability: extensions.probability ?? 100,
            useProbability: extensions.useProbability ?? true,
            depth: extensions.depth ?? 4,
            selectiveLogic: extensions.selectiveLogic ?? 0,
            outletName: extensions.outlet_name ?? '',
            group: extensions.group ?? '',
            groupOverride: extensions.group_override ?? false,
            groupWeight: extensions.group_weight ?? 100,
            scanDepth: extensions.scan_depth ?? null,
            caseSensitive: extensions.case_sensitive ?? null,
            matchWholeWords: extensions.match_whole_words ?? null,
            useGroupScoring: extensions.use_group_scoring ?? null,
            automationId: extensions.automation_id ?? '',
            role: extensions.role ?? 0,
            vectorized: extensions.vectorized ?? false,
            sticky: extensions.sticky ?? null,
            cooldown: extensions.cooldown ?? null,
            delay: extensions.delay ?? null,
            matchPersonaDescription: extensions.match_persona_description ?? false,
            matchCharacterDescription: extensions.match_character_description ?? false,
            matchCharacterPersonality: extensions.match_character_personality ?? false,
            matchCharacterDepthPrompt: extensions.match_character_depth_prompt ?? false,
            matchScenario: extensions.match_scenario ?? false,
            matchCreatorNotes: extensions.match_creator_notes ?? false,
            extensions: cloneJson(extensions),
            triggers: Array.isArray(extensions.triggers) ? cloneJson(extensions.triggers) : [],
            ignoreBudget: extensions.ignore_budget ?? false,
        };
    });
    return result;
}

function normalizeEmbeddedBook(card) {
    const data = cardData(card);
    const book = data.character_book;
    if (!book?.entries || Array.isArray(book.entries) || typeof book.entries !== 'object') {
        return { card, changed: false };
    }
    const projected = cloneJson(card);
    const projectedBook = cardData(projected).character_book;
    projectedBook.entries = Object.entries(projectedBook.entries).map(([key, value], index) => ({
        ...record(value),
        id: value?.id ?? (/^-?\d+$/.test(key) ? Number(key) : index),
    }));
    return { card: projected, changed: true };
}

export function prepareStRuntimeCard(card) {
    const mvu = adaptCardForMvuRuntime(card);
    const worldbook = normalizeEmbeddedBook(mvu.card);
    return Object.freeze({
        card: worldbook.card,
        changed: mvu.changed || worldbook.changed,
        mvu: mvu.plan,
    });
}

function inspectPreparedStCard(card) {
    const data = cardData(card);
    const name = String(data.name || card?.name || '').trim();
    if (!name) throw new NoraWorldCoreError('NORA_CARD_INVALID', 'The character card has no name.');
    const version = card?.spec === 'chara_card_v3' ? 3 : (card?.spec === 'chara_card_v2' ? 2 : 1);
    const firstMessage = String(Object.hasOwn(data, 'first_mes') ? (data.first_mes ?? '') : (card?.first_mes ?? ''));
    const alternateGreetings = Array.isArray(data.alternate_greetings)
        ? data.alternate_greetings.map(value => String(value || '')).filter(value => value.trim())
        : [];
    const embeddedBook = data.character_book && Array.isArray(data.character_book.entries)
        ? data.character_book
        : null;
    const books = embeddedBook ? [embeddedBook] : [];
    const capabilities = capabilityInspection(card, books);
    const projectedBook = embeddedBook;
    const worldbooks = (projectedBook ? [projectedBook] : []).map((book, index) => {
        const converted = convertEmbeddedBook(book);
        return {
            source_key: `embedded-worldbook:${index}`,
            preferred_name: safeEngineName(book.name, `${name} Lorebook`),
            entry_count: book.entries.length,
            content_sha256: worldbookDocumentDigest(converted),
            converted,
        };
    });
    return Object.freeze({
        spec_version: version,
        character_name: name,
        opening_state: firstMessage.trim() || alternateGreetings.length ? 'message' : 'empty',
        first_message: firstMessage,
        alternate_greetings: Object.freeze(alternateGreetings),
        worldbooks: Object.freeze(worldbooks),
        declared_capabilities: Object.freeze(capabilities.declared),
        capabilities: Object.freeze(capabilities.items),
    });
}

export function inspectStCard(card) {
    return inspectPreparedStCard(prepareStRuntimeCard(card).card);
}

function initialChat({ command, identities, report, avatar, worldbookName, timestamp }) {
    const metadata = {
        nora_world: {
            id: identities.worldId,
            version: 2,
            name: command.name,
            persona: cloneJson(command.persona),
        },
        nora_session: { id: identities.sessionId, version: 1 },
        ...(worldbookName ? { world_info: worldbookName } : {}),
    };
    const chat = [{
        user_name: command.persona?.name || 'User',
        character_name: report.character_name,
        create_date: timestamp,
        chat_metadata: metadata,
    }];
    const greetings = [report.first_message, ...report.alternate_greetings].filter(value => String(value).trim());
    if (greetings.length) {
        const message = {
            name: report.character_name,
            is_user: false,
            is_system: false,
            send_date: timestamp,
            mes: greetings[0],
            extra: {},
        };
        if (report.alternate_greetings.length > 0) {
            message.swipe_id = 0;
            message.swipes = greetings;
            message.swipe_info = greetings.map(() => ({ send_date: timestamp, extra: {} }));
        }
        chat.push(message);
    }
    return `${chat.map(item => JSON.stringify(item)).join('\n')}\n`;
}

async function resolveWorldbook({ directory, report, sourceSha256, operationId }) {
    const book = report.worldbooks[0];
    if (!book) return null;
    const candidates = [
        book.preferred_name,
        `${book.preferred_name}--nora-${book.content_sha256.slice(0, 10)}`,
        `${book.preferred_name}--nora-${book.content_sha256.slice(0, 10)}-${sha256(operationId).slice(0, 6)}`,
    ];
    for (const name of candidates) {
        const filePath = path.join(directory, `${name}.json`);
        try {
            const existing = JSON.parse(await fs.readFile(filePath, 'utf8'));
            if (worldbookDocumentDigest(existing) === book.content_sha256) {
                return {
                    name,
                    filePath,
                    created: false,
                    digest: await fileDigest(filePath),
                    ownership: isNoraWorldbook(existing, book.content_sha256) ? 'shared' : 'external',
                };
            }
        } catch (error) {
            if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
            if (error?.code === 'ENOENT') {
                const worldbookData = {
                    ...book.converted,
                    extensions: {
                        ...(book.converted.extensions || {}),
                        nora_resource: {
                            schema: 1,
                            content_sha256: book.content_sha256,
                            source_sha256: sourceSha256,
                        },
                    },
                };
                const text = `${JSON.stringify(worldbookData, null, 4)}\n`;
                const persisted = await ensureFile(filePath, text);
                return { name, filePath, ...persisted, ownership: 'shared' };
            }
        }
    }
    throw new NoraWorldCoreError(
        'NORA_ST_RESOURCE_CONFLICT',
        `No collision-safe ST Worldbook name is available for ${book.preferred_name}.`,
    );
}

async function compensate(created, protectedRoots) {
    for (const resource of [...created].reverse()) {
        try {
            if (await fileDigest(resource.filePath) === resource.digest) await fs.unlink(resource.filePath);
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
    }
    for (const directory of [...new Set(created.map(resource => path.dirname(resource.filePath)))]) {
        if (!protectedRoots.has(directory)) await fs.rmdir(directory).catch(() => {});
    }
}

function requireDirectories(directories) {
    const result = {};
    for (const name of ['characters', 'chats', 'worlds']) {
        const value = String(directories?.[name] || '');
        if (!path.isAbsolute(value)) throw new NoraWorldCoreError('NORA_WORLD_INVALID', `ST ${name} directory must be absolute.`);
        result[name] = path.resolve(value);
    }
    const userImages = String(directories?.userImages || '');
    if (userImages) {
        if (!path.isAbsolute(userImages)) throw new NoraWorldCoreError('NORA_WORLD_INVALID', 'ST userImages directory must be absolute.');
        result.userImages = path.resolve(userImages);
    }
    return result;
}

function auxiliaryAssetTarget(asset, roots, characterName) {
    const fileName = `${safeBindingName(asset?.baseName, 'CHARX asset')}.${safeBindingName(asset?.ext || 'png', 'CHARX extension')}`;
    if (asset?.storageCategory === 'sprite') return path.join(roots.characters, characterName, fileName);
    if (asset?.storageCategory === 'background') return path.join(roots.characters, characterName, 'backgrounds', fileName);
    if (asset?.storageCategory === 'misc' && roots.userImages) return path.join(roots.userImages, characterName, fileName);
    throw new NoraWorldCoreError('NORA_CARD_UNSUPPORTED_ASSETS', 'The CHARX asset has no safe ST storage target.');
}

async function materializeAuxiliaryAssets(decoded, roots, characterName, created) {
    const assets = Array.isArray(decoded?.auxiliaryAssets) ? decoded.auxiliaryAssets : [];
    if (!assets.length) return;
    if (!(decoded.extractedAssetBuffers instanceof Map)) {
        throw new NoraWorldCoreError('NORA_CARD_INVALID', 'The CHARX asset payload is unavailable.');
    }
    for (const asset of assets) {
        const buffer = decoded.extractedAssetBuffers.get(asset.zipPath);
        if (!Buffer.isBuffer(buffer)) throw new NoraWorldCoreError('NORA_CARD_INVALID', `CHARX asset ${asset.zipPath} is missing.`);
        const filePath = auxiliaryAssetTarget(asset, roots, characterName);
        const persisted = await ensureFile(filePath, buffer);
        if (persisted.created) created.push({ filePath, digest: persisted.digest });
    }
}

function safeBindingName(value, field, { stripJsonl = false } = {}) {
    const original = String(value || '').trim();
    const normalized = stripJsonl ? original.replace(/\.jsonl$/i, '') : original;
    if (!normalized || path.basename(normalized) !== normalized || normalized === '.' || normalized === '..') {
        throw new NoraWorldCoreError('NORA_ST_BINDING_INVALID', `ST ${field} binding is unsafe.`);
    }
    return normalized;
}

function stPaths(world, roots) {
    const avatar = safeBindingName(world?.runtime_card?.binding?.avatar, 'Runtime Card');
    const runtimeCard = path.join(roots.characters, avatar);
    const chatDirectory = path.join(roots.chats, path.parse(avatar).name);
    const sessions = world.sessions.items.map(session => {
        const sessionAvatar = safeBindingName(session?.binding?.avatar || avatar, 'Story Session Runtime Card');
        if (sessionAvatar !== avatar) {
            throw new NoraWorldCoreError('NORA_ST_BINDING_INVALID', 'Story Session and Runtime Card bindings disagree.');
        }
        const chatId = safeBindingName(session?.binding?.chat_id, 'Story Session', { stripJsonl: true });
        return { session, filePath: path.join(chatDirectory, `${chatId}.jsonl`) };
    });
    const knowledge = world.knowledge.map(resource => ({
        resource,
        filePath: path.join(roots.worlds, `${safeBindingName(resource?.binding?.name, 'Knowledge Resource')}.json`),
    }));
    return { avatar, runtimeCard, chatDirectory, sessions, knowledge };
}

async function inspectRegularFile(filePath, issue, issues) {
    try {
        const stat = await fs.lstat(filePath);
        if (!stat.isFile() || stat.isSymbolicLink()) issues.push(issue);
    } catch (error) {
        if (error?.code === 'ENOENT') issues.push(issue);
        else throw error;
    }
}

async function unlinkRegularFile(filePath) {
    try {
        const stat = await fs.lstat(filePath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
            throw new NoraWorldCoreError('NORA_ST_RESOURCE_UNSAFE', `Refusing to delete non-regular ST resource ${path.basename(filePath)}.`);
        }
        await fs.unlink(filePath);
        return true;
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    }
}

export function createStBackendMaterializer({
    directories,
    stagingRoot,
    cardCodec = createStCardCodec(),
    now = () => new Date().toISOString(),
    checkpoint = () => {},
    locks = new KeyedLock(),
} = {}) {
    const roots = requireDirectories(directories);
    const staging = path.resolve(String(stagingRoot || ''));
    if (!path.isAbsolute(String(stagingRoot || ''))) {
        throw new NoraWorldCoreError('NORA_WORLD_INVALID', 'ST card staging root must be absolute.');
    }
    if (typeof cardCodec?.decode !== 'function') throw new NoraWorldCoreError('NORA_WORLD_INVALID', 'ST card codec is required.');

    return Object.freeze({
        async inspect(world) {
            const issues = [];
            let paths;
            try {
                paths = stPaths(world, roots);
            } catch (error) {
                return { ready: false, issues: [{ code: error.code || 'NORA_ST_BINDING_INVALID', message: error.message }] };
            }
            await inspectRegularFile(paths.runtimeCard, {
                code: 'NORA_WORLD_RUNTIME_CARD_MISSING',
                message: 'The World Runtime Card is missing or unsafe.',
            }, issues);
            for (const { session, filePath } of paths.sessions) {
                try {
                    const source = await fs.readFile(filePath, 'utf8');
                    const lines = source.split(/\r?\n/).filter(line => line.trim());
                    const header = lines.length ? JSON.parse(lines[0]) : null;
                    const projectedWorldId = header?.chat_metadata?.nora_world?.id;
                    const projectedSessionId = header?.chat_metadata?.nora_session?.id;
                    if (projectedWorldId !== world.world_id
                        || projectedSessionId !== session.session_id) {
                        issues.push({
                            code: 'NORA_WORLD_SESSION_BINDING_MISMATCH',
                            message: `Story Session ${session.session_id} does not project the expected World identity.`,
                        });
                    }
                } catch (error) {
                    issues.push({
                        code: error?.code === 'ENOENT' ? 'NORA_WORLD_SESSION_MISSING' : 'NORA_WORLD_SESSION_CORRUPT',
                        message: `Story Session ${session.session_id} is missing or corrupt.`,
                    });
                }
            }
            for (const { resource, filePath } of paths.knowledge) {
                try {
                    const value = JSON.parse(await fs.readFile(filePath, 'utf8'));
                    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid Worldbook data.');
                } catch (error) {
                    issues.push({
                        code: error?.code === 'ENOENT' ? 'NORA_WORLD_KNOWLEDGE_MISSING' : 'NORA_WORLD_KNOWLEDGE_CORRUPT',
                        message: `Knowledge Resource ${resource.resource_id} is missing or corrupt.`,
                    });
                }
            }
            return { ready: issues.length === 0, issues };
        },
        async deleteResources(world, plan) {
            const paths = stPaths(world, roots);
            const deleted = [];
            const sessionPlan = new Map((plan?.sessions || []).map(item => [item.session_id, Boolean(item.delete)]));
            const knowledgePlan = new Map((plan?.knowledge || []).map(item => [item.resource_id, Boolean(item.delete)]));
            for (const { session, filePath } of paths.sessions) {
                if (!sessionPlan.get(session.session_id)) continue;
                if (await unlinkRegularFile(filePath)) deleted.push({ kind: 'session', id: session.session_id });
                if (directories.root && removeSessionLedger(directories.root, { worldId: world.world_id, sessionId: session.session_id })) {
                    void requestStoryProjection(directories);
                }
            }
            await fs.rmdir(paths.chatDirectory).catch(error => {
                if (!['ENOENT', 'ENOTEMPTY'].includes(error?.code)) throw error;
            });
            if (plan?.runtime_card?.delete && world.runtime_card.ownership === 'owned') {
                if (await unlinkRegularFile(paths.runtimeCard)) deleted.push({ kind: 'runtime_card', id: world.runtime_card.resource_id });
            }
            for (const { resource, filePath } of paths.knowledge) {
                if (!knowledgePlan.get(resource.resource_id) || resource.ownership !== 'owned') continue;
                if (await unlinkRegularFile(filePath)) deleted.push({ kind: 'knowledge', id: resource.resource_id });
            }
            return { deleted };
        },
        async release(command) {
            const sourcePath = path.resolve(String(command?.payload?.staged_card?.path || ''));
            const relative = path.relative(staging, sourcePath);
            if (!sourcePath || !relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
                throw new NoraWorldCoreError('NORA_CARD_STAGING_INVALID', 'The staged card release target is outside the configured root.');
            }
            try {
                const stat = await fs.lstat(sourcePath);
                if (!stat.isFile() || stat.isSymbolicLink()) {
                    throw new NoraWorldCoreError('NORA_CARD_STAGING_INVALID', 'The staged card release target is not a regular file.');
                }
                await fs.unlink(sourcePath);
            } catch (error) {
                if (error?.code !== 'ENOENT') throw error;
            }
        },
        async materialize(command, identities) {
            const operationId = assertIdentity(identities?.operationId, 'operationId');
            const worldId = assertIdentity(identities?.worldId, 'worldId');
            const sessionId = assertIdentity(identities?.sessionId, 'sessionId');
            assertIdentity(identities?.runtimeCardResourceId, 'runtimeCardResourceId');
            const stagedCard = record(command?.payload?.staged_card);
            const sourcePath = path.resolve(String(stagedCard.path || ''));
            let realStaging;
            let realSourcePath;
            try {
                [realStaging, realSourcePath] = await Promise.all([fs.realpath(staging), fs.realpath(sourcePath)]);
            } catch (error) {
                throw new NoraWorldCoreError('NORA_CARD_STAGING_INVALID', 'The staged card path cannot be resolved.', { cause: error });
            }
            if (!inside(realStaging, realSourcePath)) {
                throw new NoraWorldCoreError('NORA_CARD_STAGING_INVALID', 'The staged card is outside the configured staging root.');
            }
            const format = String(stagedCard.format || command?.source?.format || '').toLowerCase();
            const commandFormat = String(command?.source?.format || '').toLowerCase();
            if (commandFormat && format !== commandFormat) {
                throw new NoraWorldCoreError('NORA_CARD_FORMAT_MISMATCH', 'The staged card format does not match the World command.');
            }
            const sourceBuffer = await fs.readFile(realSourcePath).catch(error => {
                throw new NoraWorldCoreError('NORA_CARD_STAGING_INVALID', 'The staged card cannot be read.', { cause: error });
            });
            const actualSourceSha = bufferDigest(sourceBuffer);
            if (actualSourceSha !== command?.source?.sha256) {
                throw new NoraWorldCoreError('NORA_CARD_SOURCE_MISMATCH', 'The staged card does not match the World command source digest.');
            }
            let decoded;
            try {
                decoded = await cardCodec.decode({ buffer: sourceBuffer, format, sourcePath: realSourcePath });
            } catch (error) {
                if (error instanceof NoraWorldCoreError) throw error;
                throw new NoraWorldCoreError('NORA_CARD_INVALID', 'The staged character card could not be decoded.', { cause: error });
            }
            if (!Buffer.isBuffer(decoded?.runtimeCardBuffer)) {
                throw new NoraWorldCoreError('NORA_CARD_INVALID', 'The ST card codec did not produce a Runtime Card artifact.');
            }
            const prepared = prepareStRuntimeCard(decoded.card);
            const report = inspectPreparedStCard(prepared.card);
            const timestamp = isoDate(now());
            const created = [];
            try {
                const internalBlank = command?.payload?.runtime_card_kind === 'nora-internal-blank';
                const runtimeBase = internalBlank
                    ? INTERNAL_BLANK_RUNTIME_BASE
                    : `${safeEngineName(report.character_name, 'Character')}--nora-${sha256(worldId).slice(0, 10)}`;
                const avatar = `${runtimeBase}.png`;
                const runtimePath = path.join(roots.characters, avatar);

                const worldbook = await locks.run(
                    `st-worldbook:${report.worldbooks[0]?.preferred_name || '<none>'}`,
                    () => resolveWorldbook({
                        directory: roots.worlds,
                        report,
                        sourceSha256: actualSourceSha,
                        operationId,
                    }),
                );
                await checkpoint('WORLDBOOK_CREATED');

                const projectedCard = bindRuntimeCardWorldbook(prepared.card, worldbook?.name);
                const requiresEncoding = prepared.changed || Boolean(worldbook);
                if (requiresEncoding && typeof cardCodec.encodeRuntimeCard !== 'function') {
                    throw new NoraWorldCoreError(
                        'NORA_CARD_CODEC_UNAVAILABLE',
                        'The ST card codec cannot project Runtime Card compatibility metadata.',
                    );
                }
                const runtimeCardBuffer = requiresEncoding
                    ? await cardCodec.encodeRuntimeCard({
                        card: projectedCard,
                        sourceBuffer: decoded.runtimeCardBuffer,
                    })
                    : decoded.runtimeCardBuffer;
                const runtimePersisted = await ensureFile(runtimePath, runtimeCardBuffer);
                if (runtimePersisted.created) created.push({ filePath: runtimePath, digest: runtimePersisted.digest });
                await checkpoint('RUNTIME_CARD_CREATED');

                await locks.run(
                    `st-character-assets:${report.character_name}`,
                    () => materializeAuxiliaryAssets(decoded, roots, safeEngineName(report.character_name, 'Character'), created),
                );
                await checkpoint('AUXILIARY_ASSETS_CREATED');

                const chatId = `nora-${sha256(sessionId).slice(0, 16)}`;
                const chatPath = path.join(roots.chats, runtimeBase, `${chatId}.jsonl`);
                const chatText = initialChat({
                    command,
                    identities: { operationId, worldId, sessionId },
                    report,
                    avatar,
                    worldbookName: worldbook?.name || '',
                    timestamp,
                });
                const chatPersisted = await ensureFile(chatPath, chatText);
                if (chatPersisted.created) created.push({ filePath: chatPath, digest: chatPersisted.digest });
                await checkpoint('SESSION_CREATED');

                return {
                    worldName: command?.payload?.world_name_source === 'card' ? report.character_name : command.name,
                    runtimeCard: {
                        engine: 'sillytavern',
                        binding: { avatar },
                        ownership: internalBlank ? 'shared' : 'owned',
                    },
                    defaultSession: {
                        engine: 'sillytavern',
                        binding: { avatar, chat_id: chatId },
                        openingState: report.opening_state,
                    },
                    knowledge: worldbook ? [{
                        sourceKey: report.worldbooks[0].source_key,
                        engine: 'sillytavern',
                        binding: { name: worldbook.name },
                        ownership: worldbook.ownership,
                    }] : [],
                    declaredCapabilities: [...report.declared_capabilities],
                };
            } catch (error) {
                await compensate(created, new Set(Object.values(roots))).catch(cleanupError => {
                    if (error && typeof error === 'object') error.cleanupError = cleanupError;
                });
                throw error;
            }
        },
    });
}
