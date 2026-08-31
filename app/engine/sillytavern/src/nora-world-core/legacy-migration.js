import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { read as readCharacterCard } from '../character-card-parser.js';
import { writeJsonAtomic } from './atomic-json.js';
import { deriveStableId, validateWorldManifest } from './domain.js';
import { NoraWorldCoreError } from './errors.js';
import { inspectStCard } from './st-backend-materializer.js';
import { WorldStore } from './store.js';

const LEGACY_SCHEMA = 'nora-world/v1';
const REPORT_SCHEMA = 'nora-world-migration/v1';
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,191}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const REPAIR_ISSUES = new Set([
    'binding_mismatch',
    'duplicate_binding',
    'missing_runtime_card',
    'missing_chat',
    'missing_worldbook',
    'source_digest_mismatch',
    'corrupt_linked_chat',
    'session_binding_mismatch',
]);

function text(value) {
    return String(value ?? '').trim();
}

function unique(values) {
    return [...new Set(values.map(text).filter(Boolean))];
}

function validDate(value, fallback) {
    const normalized = text(value);
    return Number.isFinite(Date.parse(normalized)) ? normalized : fallback;
}

function normalizedChatId(value) {
    return text(value).replace(/\.jsonl$/i, '');
}

function safeFileName(value) {
    const normalized = text(value);
    return normalized && path.basename(normalized) === normalized ? normalized : '';
}

function bindingKey(value) {
    return JSON.stringify([text(value?.avatar), normalizedChatId(value?.chat_id)]);
}

function bindingEqual(left, right) {
    return bindingKey(left) === bindingKey(right);
}

function digest(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function worldIdentity(legacyId) {
    const normalized = text(legacyId);
    return ID_PATTERN.test(normalized)
        ? normalized
        : deriveStableId('legacy-world-id', normalized, 'world');
}

function resourceIdentity(worldId, kind, binding, ownership) {
    const namespace = ownership === 'owned' ? worldId : 'legacy-shared-resource';
    return deriveStableId(namespace, JSON.stringify({ kind, binding }), 'resource');
}

function sessionIdentity(candidate) {
    return deriveStableId(candidate.world_id, bindingKey(candidate.binding), 'session');
}

function chatPathFor(candidate, directories) {
    return path.join(
        directories.chats,
        candidate.binding.avatar.replace(/\.png$/i, ''),
        `${candidate.binding.chat_id}.jsonl`,
    );
}

async function directoryEntries(directory) {
    try {
        return await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
    }
}

async function fileExists(filePath) {
    try {
        return (await fs.stat(filePath)).isFile();
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    }
}

async function readFirstJsonLine(filePath) {
    const handle = await fs.open(filePath, 'r');
    try {
        const buffer = Buffer.alloc(1024 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const line = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/, 1)[0];
        if (!line.trim()) throw new SyntaxError('Chat header is empty.');
        return JSON.parse(line);
    } finally {
        await handle.close();
    }
}

async function countChatMessages(filePath) {
    const source = await fs.readFile(filePath, 'utf8');
    const lines = source.split(/\r?\n/).filter(line => line.trim());
    if (!lines.length) return 0;
    for (const line of lines) JSON.parse(line);
    return Math.max(0, lines.length - 1);
}

async function projectSessionIdentity(candidate, manifest, directories) {
    if (manifest?.source?.type !== 'legacy-migration' || manifest?.lifecycle?.status !== 'READY') {
        return 'skipped';
    }
    const session = manifest.sessions?.items?.find(item => item.session_id === manifest.sessions.default_session_id);
    if (!session) throw new NoraWorldCoreError('NORA_WORLD_INVALID', `Migrated World ${manifest.world_id} has no default Story Session.`);
    const filePath = chatPathFor(candidate, directories);
    const source = await fs.readFile(filePath, 'utf8');
    const newline = source.indexOf('\n');
    const headerSource = newline >= 0 ? source.slice(0, newline).replace(/\r$/, '') : source;
    const header = JSON.parse(headerSource);
    const metadata = header?.chat_metadata && typeof header.chat_metadata === 'object'
        ? header.chat_metadata
        : {};
    const projectedWorldId = text(metadata.nora_world?.id);
    const projectedSessionId = text(metadata.nora_session?.id);
    if (projectedWorldId !== manifest.world_id || (projectedSessionId && projectedSessionId !== session.session_id)) {
        throw new NoraWorldCoreError(
            'NORA_WORLD_SESSION_BINDING_MISMATCH',
            `Story Session ${session.session_id} conflicts with the legacy chat projection.`,
        );
    }
    if (projectedSessionId === session.session_id) return 'already_present';
    header.chat_metadata = {
        ...metadata,
        nora_session: {
            ...(metadata.nora_session && typeof metadata.nora_session === 'object' ? metadata.nora_session : {}),
            id: session.session_id,
            version: 1,
        },
    };
    const suffix = newline >= 0 ? source.slice(newline) : '\n';
    const temporary = path.join(
        path.dirname(filePath),
        `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    const mode = (await fs.stat(filePath)).mode & 0o777;
    let handle;
    try {
        handle = await fs.open(temporary, 'wx', mode);
        await handle.writeFile(`${JSON.stringify(header)}${suffix}`, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.rename(temporary, filePath);
    } catch (error) {
        await handle?.close().catch(() => {});
        await fs.unlink(temporary).catch(() => {});
        throw error;
    }
    return 'applied';
}

function registryRecord(legacyWorld, sourceFile) {
    if (legacyWorld?.schema !== LEGACY_SCHEMA || !text(legacyWorld?.id)) {
        throw new TypeError('Legacy registry record has an unsupported schema or no World identity.');
    }
    const avatar = safeFileName(legacyWorld?.runtime?.character_avatar);
    const chatId = normalizedChatId(legacyWorld?.runtime?.chat_id);
    if (!avatar || !chatId || path.basename(chatId) !== chatId) {
        throw new TypeError('Legacy registry record has an unsafe Runtime Card or chat binding.');
    }
    return {
        origin: 'registry',
        origin_file: sourceFile,
        legacy_world_id: text(legacyWorld.id),
        name: text(legacyWorld.name) || '未命名世界',
        persona: {
            name: text(legacyWorld?.persona?.name),
            description: String(legacyWorld?.persona?.description || ''),
        },
        binding: { avatar, chat_id: chatId },
        worldbooks: unique(legacyWorld?.runtime?.worldbook_names || []),
        owned_card: Boolean(legacyWorld?.ownership?.character_card),
        owned_worldbooks: unique(legacyWorld?.ownership?.worldbooks || []),
        source: {
            sha256: text(legacyWorld?.source?.sha256).toLowerCase(),
            original_name: text(legacyWorld?.source?.file_name),
            format: text(legacyWorld?.source?.format),
        },
        created_at: text(legacyWorld.created_at),
        updated_at: text(legacyWorld.updated_at),
    };
}

function chatRecord(header, { avatar, chatId, sourceFile, modifiedAt }) {
    const metadata = header?.chat_metadata && typeof header.chat_metadata === 'object'
        ? header.chat_metadata
        : {};
    const projection = metadata.nora_world && typeof metadata.nora_world === 'object'
        ? metadata.nora_world
        : null;
    const legacyProductionId = text(metadata.nora_legacy_production_id);
    const legacyWorldId = text(projection?.id || (legacyProductionId ? `legacy:${legacyProductionId}` : ''));
    if (!legacyWorldId) return null;
    return {
        origin: 'chat_metadata',
        origin_file: sourceFile,
        legacy_world_id: legacyWorldId,
        name: text(projection?.name || header?.character_name) || '未命名世界',
        persona: {
            name: text(projection?.persona?.name || header?.user_name),
            description: String(projection?.persona?.description || ''),
        },
        binding: { avatar, chat_id: chatId },
        worldbooks: unique(Array.isArray(metadata.world_info) ? metadata.world_info : [metadata.world_info]),
        owned_card: false,
        owned_worldbooks: [],
        source: { sha256: '', original_name: avatar, format: 'png' },
        created_at: text(header?.create_date) || modifiedAt,
        updated_at: modifiedAt,
    };
}

async function scanRegistry(directory, corruptRecords) {
    const records = [];
    for (const entry of (await directoryEntries(directory)).sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const filePath = path.join(directory, entry.name);
        try {
            records.push(registryRecord(JSON.parse(await fs.readFile(filePath, 'utf8')), filePath));
        } catch (error) {
            corruptRecords.push({ source: 'registry', file: filePath, error: text(error?.message) || 'Invalid JSON.' });
        }
    }
    return records;
}

async function scanChats(directory, corruptRecords) {
    const records = [];
    for (const characterEntry of (await directoryEntries(directory)).sort((left, right) => left.name.localeCompare(right.name))) {
        if (!characterEntry.isDirectory()) continue;
        const avatar = `${characterEntry.name}.png`;
        const chatDirectory = path.join(directory, characterEntry.name);
        for (const chatEntry of (await directoryEntries(chatDirectory)).sort((left, right) => left.name.localeCompare(right.name))) {
            if (!chatEntry.isFile() || !chatEntry.name.endsWith('.jsonl')) continue;
            const filePath = path.join(chatDirectory, chatEntry.name);
            try {
                const header = await readFirstJsonLine(filePath);
                const stat = await fs.stat(filePath);
                const record = chatRecord(header, {
                    avatar,
                    chatId: normalizedChatId(chatEntry.name),
                    sourceFile: filePath,
                    modifiedAt: stat.mtime.toISOString(),
                });
                if (record) records.push(record);
            } catch (error) {
                corruptRecords.push({ source: 'chat', file: filePath, error: text(error?.message) || 'Invalid chat header.' });
            }
        }
    }
    return records;
}

function mergeRecords(legacyWorldId, records) {
    const registry = records.find(record => record.origin === 'registry');
    const preferred = registry || records[0];
    const bindings = [...new Map(records.map(record => [bindingKey(record.binding), record.binding])).values()];
    const issues = new Set();
    if (bindings.length > 1) issues.add('binding_mismatch');
    const chatProjection = records.find(record => record.origin === 'chat_metadata' && bindingEqual(record.binding, preferred.binding));
    return {
        legacy_world_id: legacyWorldId,
        world_id: worldIdentity(legacyWorldId),
        name: preferred.name,
        persona: preferred.persona,
        binding: preferred.binding,
        worldbooks: unique(records.flatMap(record => record.worldbooks)),
        owned_card: records.some(record => record.owned_card),
        owned_worldbooks: unique(records.flatMap(record => record.owned_worldbooks)),
        source: { ...preferred.source },
        created_at: preferred.created_at,
        updated_at: preferred.updated_at,
        origins: records.map(record => ({ type: record.origin, file: record.origin_file, binding: record.binding })),
        orphan_chat: !registry && Boolean(chatProjection || records.some(record => record.origin === 'chat_metadata')),
        issues,
    };
}

async function inspectLegacyRuntimeCard(filePath) {
    const cardBuffer = await fs.readFile(filePath);
    const card = JSON.parse(readCharacterCard(cardBuffer));
    return {
        sha256: digest(cardBuffer),
        declaredCapabilities: [...inspectStCard(card).declared_capabilities],
    };
}

async function inspectCandidate(candidate, directories, corruptRecords, inspectCard) {
    const avatarPath = path.join(directories.characters, candidate.binding.avatar);
    const chatPath = chatPathFor(candidate, directories);
    const [hasCard, hasChat] = await Promise.all([fileExists(avatarPath), fileExists(chatPath)]);
    let openingState = 'empty';
    let declaredCapabilities = [];
    if (!hasCard) {
        candidate.issues.add('missing_runtime_card');
    } else {
        try {
            const inspection = await inspectCard(avatarPath);
            const actualDigest = text(inspection?.sha256).toLowerCase();
            if (!SHA256_PATTERN.test(actualDigest)) throw new TypeError('Runtime Card inspection returned no SHA-256 digest.');
            if (candidate.source.sha256 && !SHA256_PATTERN.test(candidate.source.sha256)) {
                candidate.issues.add('source_digest_mismatch');
            } else if (candidate.source.sha256 && candidate.source.sha256 !== actualDigest) {
                candidate.issues.add('source_digest_mismatch');
            }
            candidate.source.sha256 = actualDigest;
            candidate.source.original_name ||= candidate.binding.avatar;
            candidate.source.format ||= 'png';
            declaredCapabilities = unique(inspection?.declaredCapabilities || []);
        } catch (error) {
            const cardBuffer = await fs.readFile(avatarPath).catch(() => null);
            if (cardBuffer) {
                const actualDigest = digest(cardBuffer);
                candidate.source.sha256 = actualDigest;
                candidate.source.original_name ||= candidate.binding.avatar;
                candidate.source.format ||= 'png';
                corruptRecords.push({
                    source: 'runtime_card_capability_inspection',
                    file: avatarPath,
                    world_id: candidate.world_id,
                    error: text(error?.message) || 'Card capability inspection failed.',
                });
            } else {
                candidate.issues.add('missing_runtime_card');
                corruptRecords.push({ source: 'runtime_card', file: avatarPath, world_id: candidate.world_id, error: text(error?.message) });
            }
        }
    }
    if (!hasChat) {
        candidate.issues.add('missing_chat');
    } else {
        try {
            const header = await readFirstJsonLine(chatPath);
            const projectedSessionId = text(header?.chat_metadata?.nora_session?.id);
            if (!projectedSessionId) candidate.issues.add('missing_session_projection');
            else if (projectedSessionId !== sessionIdentity(candidate)) candidate.issues.add('session_binding_mismatch');
            const messageCount = await countChatMessages(chatPath);
            openingState = messageCount > 0 ? 'message' : 'empty';
            candidate.empty_chat = messageCount === 0;
        } catch (error) {
            candidate.issues.add('corrupt_linked_chat');
            corruptRecords.push({ source: 'chat', file: chatPath, world_id: candidate.world_id, error: text(error?.message) });
        }
    }
    const missingWorldbooks = [];
    for (const name of candidate.worldbooks) {
        if (!await fileExists(path.join(directories.worlds, `${name}.json`))) missingWorldbooks.push(name);
    }
    if (missingWorldbooks.length) candidate.issues.add('missing_worldbook');
    candidate.missing_worldbooks = missingWorldbooks;
    candidate.opening_state = openingState;
    candidate.declared_capabilities = declaredCapabilities;
}

function addCrossCandidateIssues(candidates) {
    const bindings = new Map();
    const sources = new Map();
    for (const candidate of candidates) {
        const key = bindingKey(candidate.binding);
        if (!bindings.has(key)) bindings.set(key, []);
        bindings.get(key).push(candidate);
        if (candidate.source.sha256) {
            if (!sources.has(candidate.source.sha256)) sources.set(candidate.source.sha256, []);
            sources.get(candidate.source.sha256).push(candidate);
        }
    }
    for (const group of bindings.values()) {
        if (group.length > 1) group.forEach(candidate => candidate.issues.add('duplicate_binding'));
    }
    return {
        duplicateBindings: [...bindings.values()].filter(group => group.length > 1),
        sameSourceWorlds: [...sources.values()].filter(group => group.length > 1),
    };
}

function capabilitySet(declared) {
    const items = Object.fromEntries([...declared].sort().map(capability => [capability, {
        status: 'PENDING',
        attempts: 0,
        attempt_id: null,
        started_at: null,
        updated_at: null,
        duration_ms: null,
        error: null,
        evidence: null,
    }]));
    return {
        declared: Object.keys(items),
        status: Object.keys(items).length ? 'PENDING' : 'READY',
        items,
    };
}

function manifestFor(candidate, generatedAt) {
    const repairIssues = [...candidate.issues].filter(issue => REPAIR_ISSUES.has(issue)).sort();
    const lifecycle = repairIssues.length
        ? {
            status: 'FAILED',
            error: {
                code: 'NORA_WORLD_NEEDS_REPAIR',
                message: 'Legacy World migration found bindings that require explicit repair.',
                retryable: false,
                issues: repairIssues,
            },
        }
        : { status: 'READY', error: null };
    const createdAt = validDate(candidate.created_at, generatedAt);
    const updatedAt = validDate(candidate.updated_at, createdAt);
    const cardOwnership = candidate.owned_card ? 'owned' : 'external';
    const runtimeBinding = { avatar: candidate.binding.avatar };
    const sessionBinding = { avatar: candidate.binding.avatar, chat_id: candidate.binding.chat_id };
    return validateWorldManifest({
        schema_version: 2,
        world_id: candidate.world_id,
        revision: 0,
        name: candidate.name,
        persona: candidate.persona,
        lifecycle,
        source: {
            type: 'legacy-migration',
            sha256: SHA256_PATTERN.test(candidate.source.sha256) ? candidate.source.sha256 : '',
            original_name: candidate.source.original_name,
            format: candidate.source.format,
        },
        runtime_card: {
            resource_id: resourceIdentity(candidate.world_id, 'runtime-card', runtimeBinding, cardOwnership),
            engine: 'sillytavern',
            binding: runtimeBinding,
            ownership: cardOwnership,
        },
        sessions: {
            default_session_id: sessionIdentity(candidate),
            items: [{
                session_id: sessionIdentity(candidate),
                engine: 'sillytavern',
                binding: sessionBinding,
                opening_state: candidate.opening_state,
            }],
        },
        knowledge: candidate.worldbooks.map((name, index) => {
            const ownership = candidate.owned_worldbooks.includes(name) ? 'owned' : 'external';
            const binding = { name };
            return {
                resource_id: resourceIdentity(candidate.world_id, 'knowledge', binding, ownership),
                source_key: `legacy-worldbook:${index}`,
                engine: 'sillytavern',
                binding,
                ownership,
            };
        }),
        capabilities: capabilitySet(candidate.declared_capabilities),
        created_at: createdAt,
        updated_at: updatedAt,
    });
}

function publicCandidate(candidate, manifest) {
    const issues = [...candidate.issues].sort();
    const repairIssues = issues.filter(issue => REPAIR_ISSUES.has(issue));
    return {
        legacy_world_id: candidate.legacy_world_id,
        world_id: candidate.world_id,
        name: candidate.name,
        binding: { ...candidate.binding },
        source_sha256: candidate.source.sha256,
        origins: candidate.origins,
        disposition: repairIssues.length ? 'needs_repair' : 'normal',
        issues,
        missing_worldbooks: [...candidate.missing_worldbooks],
        empty_chat: Boolean(candidate.empty_chat),
        orphan_chat: Boolean(candidate.orphan_chat),
        manifest_lifecycle: manifest.lifecycle.status,
    };
}

function compareManifest(candidate, manifest) {
    const session = manifest?.sessions?.items?.find(item => item.session_id === manifest.sessions.default_session_id);
    const binding = {
        avatar: text(manifest?.runtime_card?.binding?.avatar),
        chat_id: normalizedChatId(session?.binding?.chat_id),
    };
    return bindingEqual(candidate.binding, binding);
}

function categoryIds(candidates, predicate) {
    return candidates.filter(predicate).map(candidate => candidate.world_id).sort();
}

export async function migrateLegacyWorlds({
    directories,
    worldCoreRoot = path.join(directories?.root || '', 'nora-world-core'),
    legacyRegistryRoot = directories?.noraWorlds,
    apply = false,
    now = () => new Date().toISOString(),
    store = null,
    reportPath = null,
    inspectCard = inspectLegacyRuntimeCard,
} = {}) {
    for (const field of ['root', 'characters', 'chats', 'worlds', 'noraWorlds']) {
        if (!path.isAbsolute(text(directories?.[field]))) {
            throw new NoraWorldCoreError('NORA_WORLD_INVALID', `Legacy migration requires an absolute ${field} directory.`);
        }
    }
    if (!path.isAbsolute(text(worldCoreRoot)) || !path.isAbsolute(text(legacyRegistryRoot))) {
        throw new NoraWorldCoreError('NORA_WORLD_INVALID', 'Legacy migration roots must be absolute.');
    }
    const generatedAt = now();
    const corruptRecords = [];
    const [registryRecords, chatRecords, characterEntries] = await Promise.all([
        scanRegistry(legacyRegistryRoot, corruptRecords),
        scanChats(directories.chats, corruptRecords),
        directoryEntries(directories.characters),
    ]);
    const grouped = new Map();
    for (const record of [...registryRecords, ...chatRecords]) {
        if (!grouped.has(record.legacy_world_id)) grouped.set(record.legacy_world_id, []);
        grouped.get(record.legacy_world_id).push(record);
    }
    const candidates = [...grouped.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([legacyWorldId, records]) => mergeRecords(legacyWorldId, records));
    for (const candidate of candidates) await inspectCandidate(candidate, directories, corruptRecords, inspectCard);
    const { duplicateBindings, sameSourceWorlds } = addCrossCandidateIssues(candidates);
    const manifests = new Map(candidates.map(candidate => [candidate.world_id, manifestFor(candidate, generatedAt)]));
    const worldStore = store || new WorldStore({ root: worldCoreRoot });
    await worldStore.load();
    const before = await worldStore.list();
    const applied = [];
    const alreadyPresent = [];
    const bindingMismatch = [];
    const projectedSessions = [];
    const existingSessionProjections = [];
    for (const candidate of candidates) {
        const existing = await worldStore.get(candidate.world_id);
        if (existing) {
            alreadyPresent.push(candidate.world_id);
            if (!compareManifest(candidate, existing)) {
                bindingMismatch.push(candidate.world_id);
            } else if (apply) {
                const projection = await projectSessionIdentity(candidate, existing, directories);
                if (projection === 'applied') projectedSessions.push(candidate.world_id);
                if (projection === 'already_present') existingSessionProjections.push(candidate.world_id);
            }
            continue;
        }
        if (apply) {
            const manifest = manifests.get(candidate.world_id);
            const projection = await projectSessionIdentity(candidate, manifest, directories);
            if (projection === 'applied') projectedSessions.push(candidate.world_id);
            if (projection === 'already_present') existingSessionProjections.push(candidate.world_id);
            await worldStore.put(manifest, { expectedRevision: 0 });
            applied.push(candidate.world_id);
        }
    }
    const after = await worldStore.list();
    const afterIds = new Set(after.map(world => world.world_id));
    const candidateIds = new Set(candidates.map(candidate => candidate.world_id));
    const missingInV2 = candidates.filter(candidate => !afterIds.has(candidate.world_id)).map(candidate => candidate.world_id);
    const v2Only = after.filter(world => !candidateIds.has(world.world_id)).map(world => world.world_id);
    const unexplained = [
        ...bindingMismatch.map(worldId => ({ world_id: worldId, reason: 'v1_v2_binding_mismatch' })),
        ...(apply ? missingInV2.map(worldId => ({ world_id: worldId, reason: 'migration_not_committed' })) : []),
    ];
    const referencedCards = new Set(candidates.map(candidate => candidate.binding.avatar));
    const orphanCards = characterEntries
        .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.png') && !referencedCards.has(entry.name))
        .map(entry => entry.name)
        .sort();
    const publicCandidates = candidates.map(candidate => publicCandidate(candidate, manifests.get(candidate.world_id)));
    const report = {
        schema: REPORT_SCHEMA,
        generated_at: generatedAt,
        mode: apply ? 'apply' : 'analyze',
        roots: {
            legacy_registry: path.resolve(legacyRegistryRoot),
            world_core: path.resolve(worldCoreRoot),
        },
        summary: {
            legacy_registry_records: registryRecords.length,
            chat_projection_records: chatRecords.length,
            candidate_worlds: candidates.length,
            normal: publicCandidates.filter(candidate => candidate.disposition === 'normal').length,
            needs_repair: publicCandidates.filter(candidate => candidate.disposition === 'needs_repair').length,
            applied: applied.length,
            already_present: alreadyPresent.length,
            v2_before: before.length,
            v2_after: after.length,
            corrupt_records: corruptRecords.length,
        },
        categories: {
            normal: categoryIds(candidates, candidate => ![...candidate.issues].some(issue => REPAIR_ISSUES.has(issue))),
            duplicate_binding: duplicateBindings.map(group => group.map(candidate => candidate.world_id).sort()),
            same_source_multiple_worlds: sameSourceWorlds.map(group => group.map(candidate => candidate.world_id).sort()),
            orphan_card: orphanCards,
            orphan_chat: categoryIds(candidates, candidate => candidate.orphan_chat),
            missing_runtime_card: categoryIds(candidates, candidate => candidate.issues.has('missing_runtime_card')),
            missing_chat: categoryIds(candidates, candidate => candidate.issues.has('missing_chat')),
            missing_worldbook: categoryIds(candidates, candidate => candidate.issues.has('missing_worldbook')),
            empty_chat: categoryIds(candidates, candidate => candidate.empty_chat),
            corrupt_record: corruptRecords,
            missing_session_projection: categoryIds(candidates, candidate => candidate.issues.has('missing_session_projection')),
            session_binding_mismatch: categoryIds(candidates, candidate => candidate.issues.has('session_binding_mismatch')),
        },
        worlds: publicCandidates,
        migration: {
            applied,
            already_present: alreadyPresent,
            session_projections_applied: projectedSessions,
            session_projections_already_present: existingSessionProjections,
        },
        reconciliation: {
            matched: candidates.filter(candidate => afterIds.has(candidate.world_id) && !bindingMismatch.includes(candidate.world_id)).map(candidate => candidate.world_id),
            needs_repair: publicCandidates.filter(candidate => candidate.disposition === 'needs_repair').map(candidate => candidate.world_id),
            missing_in_v2: missingInV2,
            v2_only: v2Only,
            binding_mismatch: bindingMismatch,
            unexplained,
        },
    };
    if (reportPath) await writeJsonAtomic(path.resolve(reportPath), report);
    return report;
}
