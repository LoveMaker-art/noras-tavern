import crypto from 'node:crypto';
import { normalizeStoryContext } from '../../public/scripts/nora-worlds/story-context.js';
import { normalizeWorldTheme } from '../../public/scripts/nora-worlds/world-theme.js';

import { NoraWorldCoreError } from './errors.js';

export const WORLD_SCHEMA_VERSION = 2;
export const WORLD_LIFECYCLE_STATUSES = Object.freeze(['CREATING', 'READY', 'FAILED', 'DELETING', 'DELETED']);
export const CAPABILITY_STATUSES = Object.freeze(['PENDING', 'READY', 'DEGRADED']);
export const RESOURCE_OWNERSHIP = Object.freeze(['owned', 'shared', 'external']);
export const OPERATION_STAGES = Object.freeze(['RECEIVED', 'VALIDATED', 'MATERIALIZED', 'WORLD_COMMITTED', 'COMPLETED']);
export const OPERATION_STATUSES = Object.freeze(['RUNNING', 'FAILED', 'COMPLETED']);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,191}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function invalid(message, details = {}) {
    throw new NoraWorldCoreError('NORA_WORLD_INVALID', message, { details });
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value, field) {
    if (!isRecord(value)) invalid(`${field} must be an object.`, { field });
    return value;
}

function requireString(value, field, { allowEmpty = false } = {}) {
    const normalized = String(value ?? '').trim();
    if (!allowEmpty && !normalized) invalid(`${field} is required.`, { field });
    return normalized;
}

function requireId(value, field) {
    const normalized = requireString(value, field);
    if (!ID_PATTERN.test(normalized)) invalid(`${field} is not a valid opaque identity.`, { field });
    return normalized;
}

function normalizeBinding(value, field) {
    const binding = requireRecord(value, field);
    if (!Object.keys(binding).length) invalid(`${field} cannot be empty.`, { field });
    return cloneJson(binding);
}

function normalizeOwnership(value, field) {
    const normalized = String(value || 'external');
    if (!RESOURCE_OWNERSHIP.includes(normalized)) invalid(`${field} has an unsupported ownership value.`, { field });
    return normalized;
}

function normalizeTimestamp(value, field, { allowNull = true } = {}) {
    if ((value === null || value === undefined || value === '') && allowNull) return null;
    const normalized = requireString(value, field);
    if (!Number.isFinite(Date.parse(normalized))) invalid(`${field} must be an ISO date.`, { field });
    return normalized;
}

function normalizeDuration(value, field) {
    if (value === null || value === undefined) return null;
    const normalized = Number(value);
    if (!Number.isFinite(normalized) || normalized < 0) invalid(`${field} must be a non-negative duration.`, { field });
    return Math.round(normalized * 10) / 10;
}

function normalizeCapabilityError(value, field) {
    if (value === null || value === undefined) return null;
    const error = requireRecord(value, field);
    return {
        code: requireString(error.code, `${field}.code`),
        message: requireString(error.message, `${field}.message`),
        retryable: Boolean(error.retryable),
    };
}

function normalizeCapabilityItem(value, field) {
    const item = requireRecord(value, field);
    if (!CAPABILITY_STATUSES.includes(item.status)) invalid(`${field}.status is invalid.`, { field });
    const attempts = Number(item.attempts ?? 0);
    if (!Number.isInteger(attempts) || attempts < 0) invalid(`${field}.attempts must be a non-negative integer.`, { field });
    const attemptId = item.attempt_id ? requireId(item.attempt_id, `${field}.attempt_id`) : null;
    const evidence = item.evidence === null || item.evidence === undefined
        ? null
        : cloneJson(requireRecord(item.evidence, `${field}.evidence`));
    const error = normalizeCapabilityError(item.error, `${field}.error`);
    if (item.status === 'READY' && (!evidence || !Object.keys(evidence).length)) {
        invalid(`${field}.evidence is required when the capability is READY.`, { field });
    }
    if (item.status === 'DEGRADED' && !error) {
        invalid(`${field}.error is required when the capability is DEGRADED.`, { field });
    }
    return {
        status: item.status,
        attempts,
        attempt_id: attemptId,
        started_at: normalizeTimestamp(item.started_at, `${field}.started_at`),
        updated_at: normalizeTimestamp(item.updated_at, `${field}.updated_at`),
        duration_ms: normalizeDuration(item.duration_ms, `${field}.duration_ms`),
        error,
        evidence,
    };
}

function aggregateCapabilityStatus(items) {
    const values = Object.values(items);
    if (!values.length) return 'READY';
    if (values.some(item => item.status === 'DEGRADED')) return 'DEGRADED';
    if (values.some(item => item.status === 'PENDING')) return 'PENDING';
    return 'READY';
}

function normalizeResource(value, field, { requireSourceKey = false } = {}) {
    const resource = requireRecord(value, field);
    const normalized = {
        resource_id: requireId(resource.resource_id, `${field}.resource_id`),
        engine: requireString(resource.engine, `${field}.engine`),
        binding: normalizeBinding(resource.binding, `${field}.binding`),
        ownership: normalizeOwnership(resource.ownership, `${field}.ownership`),
    };
    if (requireSourceKey) normalized.source_key = requireString(resource.source_key, `${field}.source_key`);
    return normalized;
}

export function cloneJson(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function canonicalize(value, seen = new Set()) {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
    if (value === undefined) return null;
    if (typeof value !== 'object') invalid('World command must contain JSON-compatible values.');
    if (seen.has(value)) invalid('World command cannot contain cyclic values.');
    seen.add(value);
    const result = Array.isArray(value)
        ? value.map(item => canonicalize(item, seen))
        : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key], seen)]));
    seen.delete(value);
    return result;
}

export function stableStringify(value) {
    return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function deriveStableId(namespace, key, prefix) {
    return `${prefix}:${sha256(`${namespace}\u0000${key}`).slice(0, 32)}`;
}

export function operationIdForKey(idempotencyKey) {
    return `operation:${sha256(idempotencyKey).slice(0, 32)}`;
}

function resourceId(operation, resource, sourceKey, ownedResourceId = null) {
    if (resource.ownership === 'owned') {
        return ownedResourceId || deriveStableId(operation.operation_id, sourceKey, 'resource');
    }
    return deriveStableId(
        'shared-resource',
        stableStringify({ engine: resource.engine, binding: resource.binding }),
        'resource',
    );
}

export function normalizeIdempotencyKey(value) {
    const key = requireString(value, 'idempotencyKey');
    if (key.length > 512) invalid('idempotencyKey is too long.', { field: 'idempotencyKey' });
    return key;
}

export function normalizeCreateCommand(value) {
    const command = requireRecord(value, 'command');
    const source = requireRecord(command.source || { type: 'manual' }, 'command.source');
    const sourceSha = requireString(source.sha256, 'command.source.sha256', { allowEmpty: true }).toLowerCase();
    if (sourceSha && !SHA256_PATTERN.test(sourceSha)) invalid('command.source.sha256 must be a SHA-256 digest.');
    const persona = requireRecord(command.persona || {}, 'command.persona');
    const normalized = {
        name: requireString(command.name, 'command.name'),
        persona: {
            name: requireString(persona.name, 'command.persona.name', { allowEmpty: true }),
            description: requireString(persona.description, 'command.persona.description', { allowEmpty: true }),
        },
        source: {
            type: requireString(source.type || 'manual', 'command.source.type'),
            sha256: sourceSha,
            original_name: requireString(source.original_name, 'command.source.original_name', { allowEmpty: true }),
            format: requireString(source.format, 'command.source.format', { allowEmpty: true }),
        },
        payload: cloneJson(requireRecord(command.payload || {}, 'command.payload')),
    };
    stableStringify(normalized);
    return normalized;
}

export function commandDigest(command) {
    return sha256(stableStringify(command));
}

export function normalizeMaterialization(value) {
    const result = requireRecord(value, 'materialization');
    const runtimeCard = requireRecord(result.runtimeCard, 'materialization.runtimeCard');
    const defaultSession = requireRecord(result.defaultSession, 'materialization.defaultSession');
    const knowledge = Array.isArray(result.knowledge) ? result.knowledge : [];
    const sourceKeys = new Set();
    const normalizedKnowledge = knowledge.map((item, index) => {
        const resource = requireRecord(item, `materialization.knowledge[${index}]`);
        const sourceKey = requireString(resource.sourceKey, `materialization.knowledge[${index}].sourceKey`);
        if (sourceKeys.has(sourceKey)) invalid('Knowledge resource source keys must be unique.', { sourceKey });
        sourceKeys.add(sourceKey);
        return {
            sourceKey,
            engine: requireString(resource.engine, `materialization.knowledge[${index}].engine`),
            binding: normalizeBinding(resource.binding, `materialization.knowledge[${index}].binding`),
            ownership: normalizeOwnership(resource.ownership, `materialization.knowledge[${index}].ownership`),
        };
    });
    return {
        worldName: requireString(result.worldName, 'materialization.worldName', { allowEmpty: true }),
        runtimeCard: {
            engine: requireString(runtimeCard.engine, 'materialization.runtimeCard.engine'),
            binding: normalizeBinding(runtimeCard.binding, 'materialization.runtimeCard.binding'),
            ownership: normalizeOwnership(runtimeCard.ownership, 'materialization.runtimeCard.ownership'),
        },
        defaultSession: {
            engine: requireString(defaultSession.engine, 'materialization.defaultSession.engine'),
            binding: normalizeBinding(defaultSession.binding, 'materialization.defaultSession.binding'),
            openingState: ['empty', 'message'].includes(defaultSession.openingState) ? defaultSession.openingState : 'empty',
        },
        knowledge: normalizedKnowledge,
        declaredCapabilities: [...new Set((result.declaredCapabilities || [])
            .map(value => String(value || '').trim()).filter(Boolean))].sort(),
    };
}

export function createWorldManifest({ operation, command, materialization, now }) {
    const createdAt = String(operation.created_at || now());
    const declared = [...materialization.declaredCapabilities].sort();
    const capabilityItems = Object.fromEntries(declared.map(capability => [capability, {
        status: 'PENDING',
        attempts: 0,
        attempt_id: null,
        started_at: null,
        updated_at: null,
        duration_ms: null,
        error: null,
        evidence: null,
    }]));
    return validateWorldManifest({
        schema_version: WORLD_SCHEMA_VERSION,
        world_id: operation.world_id,
        revision: 0,
        name: materialization.worldName || command.name,
        persona: command.persona,
        lifecycle: { status: 'READY', error: null },
        source: {
            ...command.source,
            import_operation_id: operation.operation_id,
            import_command_digest: operation.command_digest,
        },
        runtime_card: {
            resource_id: resourceId(operation, materialization.runtimeCard, 'runtime-card', operation.runtime_card_resource_id),
            ...materialization.runtimeCard,
        },
        sessions: {
            default_session_id: operation.session_id,
            items: [{
                session_id: operation.session_id,
                engine: materialization.defaultSession.engine,
                binding: materialization.defaultSession.binding,
                opening_state: materialization.defaultSession.openingState,
            }],
        },
        knowledge: materialization.knowledge.map(resource => ({
            resource_id: resourceId(operation, resource, resource.sourceKey),
            source_key: resource.sourceKey,
            engine: resource.engine,
            binding: resource.binding,
            ownership: resource.ownership,
        })),
        capabilities: {
            declared,
            status: declared.length ? 'PENDING' : 'READY',
            items: capabilityItems,
        },
        created_at: createdAt,
        updated_at: String(now()),
    });
}

export function validateWorldManifest(value) {
    const manifest = requireRecord(value, 'manifest');
    if (manifest.schema_version !== WORLD_SCHEMA_VERSION) invalid('Unsupported World manifest schema version.');
    const lifecycle = requireRecord(manifest.lifecycle, 'manifest.lifecycle');
    if (!WORLD_LIFECYCLE_STATUSES.includes(lifecycle.status)) invalid('Unsupported World lifecycle status.');
    const runtimeCard = normalizeResource(manifest.runtime_card, 'manifest.runtime_card');
    const sessions = requireRecord(manifest.sessions, 'manifest.sessions');
    const items = Array.isArray(sessions.items) ? sessions.items.map((item, index) => {
        const session = requireRecord(item, `manifest.sessions.items[${index}]`);
        return {
            session_id: requireId(session.session_id, `manifest.sessions.items[${index}].session_id`),
            engine: requireString(session.engine, `manifest.sessions.items[${index}].engine`),
            binding: normalizeBinding(session.binding, `manifest.sessions.items[${index}].binding`),
            opening_state: ['empty', 'message'].includes(session.opening_state) ? session.opening_state : 'empty',
        };
    }) : invalid('manifest.sessions.items must be an array.');
    const defaultSessionId = requireId(sessions.default_session_id, 'manifest.sessions.default_session_id');
    if (!items.some(item => item.session_id === defaultSessionId)) invalid('The default Story Session is missing.');
    if (new Set(items.map(item => item.session_id)).size !== items.length) invalid('Story Session identities must be unique.');
    const knowledge = Array.isArray(manifest.knowledge)
        ? manifest.knowledge.map((item, index) => normalizeResource(item, `manifest.knowledge[${index}]`, { requireSourceKey: true }))
        : invalid('manifest.knowledge must be an array.');
    const resourceIds = [runtimeCard.resource_id, ...knowledge.map(resource => resource.resource_id)];
    if (new Set(resourceIds).size !== resourceIds.length) invalid('Resource identities must be unique within one World.');
    if (new Set(knowledge.map(resource => resource.source_key)).size !== knowledge.length) invalid('Knowledge source keys must be unique.');
    const capabilities = requireRecord(manifest.capabilities, 'manifest.capabilities');
    if (!CAPABILITY_STATUSES.includes(capabilities.status)) invalid('Unsupported Capability Set status.');
    if (!Array.isArray(capabilities.declared)) invalid('manifest.capabilities.declared must be an array.');
    const declaredCapabilities = [...new Set(capabilities.declared.map(value => String(value || '').trim()).filter(Boolean))].sort();
    const rawCapabilityItems = requireRecord(capabilities.items || {}, 'manifest.capabilities.items');
    const undeclaredCapability = Object.keys(rawCapabilityItems).find(capability => !declaredCapabilities.includes(capability));
    if (undeclaredCapability) invalid(`Capability ${undeclaredCapability} is not declared.`);
    const capabilityItems = {};
    for (const capability of declaredCapabilities) {
        capabilityItems[capability] = normalizeCapabilityItem(
            rawCapabilityItems[capability],
            `manifest.capabilities.items.${capability}`,
        );
    }
    if (!declaredCapabilities.length && capabilities.status !== 'READY') invalid('A World without declared capabilities must be capability-ready.');
    const aggregateStatus = aggregateCapabilityStatus(capabilityItems);
    if (capabilities.status !== aggregateStatus) {
        invalid(`Capability Set status must be ${aggregateStatus}.`);
    }
    const source = requireRecord(manifest.source || {}, 'manifest.source');
    const sourceSha = requireString(source.sha256, 'manifest.source.sha256', { allowEmpty: true }).toLowerCase();
    if (sourceSha && !SHA256_PATTERN.test(sourceSha)) invalid('manifest.source.sha256 must be a SHA-256 digest.');
    const importOperationId = source.import_operation_id
        ? requireId(source.import_operation_id, 'manifest.source.import_operation_id')
        : '';
    const importCommandDigest = requireString(
        source.import_command_digest,
        'manifest.source.import_command_digest',
        { allowEmpty: true },
    ).toLowerCase();
    if (Boolean(importOperationId) !== Boolean(importCommandDigest)) {
        invalid('Import operation identity and command digest must be stored together.');
    }
    if (importCommandDigest && !SHA256_PATTERN.test(importCommandDigest)) {
        invalid('manifest.source.import_command_digest must be a SHA-256 digest.');
    }
    const persona = requireRecord(manifest.persona || {}, 'manifest.persona');
    const revision = Number(manifest.revision);
    if (!Number.isInteger(revision) || revision < 0) invalid('manifest.revision must be a non-negative integer.');
    const createdAt = requireString(manifest.created_at, 'manifest.created_at');
    const updatedAt = requireString(manifest.updated_at, 'manifest.updated_at');
    if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) invalid('Manifest timestamps must be ISO dates.');
    return {
        schema_version: WORLD_SCHEMA_VERSION,
        world_id: requireId(manifest.world_id, 'manifest.world_id'),
        ...(manifest.ui === undefined ? {} : { ui: normalizeWorldTheme(manifest.ui) }),
        ...(manifest.story_context === undefined ? {} : { story_context: normalizeStoryContext(manifest.story_context) }),
        revision,
        name: requireString(manifest.name, 'manifest.name'),
        persona: {
            name: requireString(persona.name, 'manifest.persona.name', { allowEmpty: true }),
            description: requireString(persona.description, 'manifest.persona.description', { allowEmpty: true }),
        },
        lifecycle: {
            status: lifecycle.status,
            error: lifecycle.error ? cloneJson(lifecycle.error) : null,
        },
        source: {
            type: requireString(source.type || 'manual', 'manifest.source.type'),
            sha256: sourceSha,
            original_name: requireString(source.original_name, 'manifest.source.original_name', { allowEmpty: true }),
            format: requireString(source.format, 'manifest.source.format', { allowEmpty: true }),
            ...(importOperationId ? {
                import_operation_id: importOperationId,
                import_command_digest: importCommandDigest,
            } : {}),
        },
        runtime_card: runtimeCard,
        sessions: { default_session_id: defaultSessionId, items },
        knowledge,
        capabilities: {
            declared: declaredCapabilities,
            status: capabilities.status,
            items: capabilityItems,
        },
        created_at: createdAt,
        updated_at: updatedAt,
    };
}

export function beginWorldCapabilityAttempt(value, capability, { attemptId, now }) {
    const world = validateWorldManifest(value);
    const normalizedCapability = requireString(capability, 'capability');
    if (!world.capabilities.declared.includes(normalizedCapability)) {
        throw new NoraWorldCoreError(
            'NORA_CAPABILITY_NOT_DECLARED',
            `Capability ${normalizedCapability} is not declared by this World.`,
            { details: { worldId: world.world_id, capability: normalizedCapability } },
        );
    }
    const normalizedAttemptId = requireId(attemptId, 'attemptId');
    const timestamp = normalizeTimestamp(now(), 'now', { allowNull: false });
    const items = cloneJson(world.capabilities.items);
    const previous = items[normalizedCapability];
    items[normalizedCapability] = {
        status: 'PENDING',
        attempts: previous.attempts + 1,
        attempt_id: normalizedAttemptId,
        started_at: timestamp,
        updated_at: timestamp,
        duration_ms: null,
        error: null,
        evidence: null,
    };
    return validateWorldManifest({
        ...world,
        capabilities: {
            declared: [...world.capabilities.declared],
            status: aggregateCapabilityStatus(items),
            items,
        },
        updated_at: timestamp,
    });
}

export function settleWorldCapabilityAttempt(value, capability, result, { attemptId, now }) {
    const world = validateWorldManifest(value);
    const normalizedCapability = requireString(capability, 'capability');
    const item = world.capabilities.items[normalizedCapability];
    if (!item) {
        throw new NoraWorldCoreError(
            'NORA_CAPABILITY_NOT_DECLARED',
            `Capability ${normalizedCapability} is not declared by this World.`,
            { details: { worldId: world.world_id, capability: normalizedCapability } },
        );
    }
    const normalizedAttemptId = requireId(attemptId, 'attemptId');
    if (item.attempt_id !== normalizedAttemptId || item.status !== 'PENDING') {
        throw new NoraWorldCoreError(
            'NORA_CAPABILITY_ATTEMPT_CONFLICT',
            `Capability ${normalizedCapability} attempt is stale.`,
            { retryable: true, details: { worldId: world.world_id, capability: normalizedCapability } },
        );
    }
    const update = requireRecord(result, 'result');
    if (!['READY', 'DEGRADED'].includes(update.status)) invalid('A capability attempt must settle as READY or DEGRADED.');
    const timestamp = normalizeTimestamp(now(), 'now', { allowNull: false });
    const items = cloneJson(world.capabilities.items);
    items[normalizedCapability] = normalizeCapabilityItem({
        ...item,
        status: update.status,
        updated_at: timestamp,
        duration_ms: update.duration_ms,
        error: update.error,
        evidence: update.evidence,
    }, `manifest.capabilities.items.${normalizedCapability}`);
    return validateWorldManifest({
        ...world,
        capabilities: {
            declared: [...world.capabilities.declared],
            status: aggregateCapabilityStatus(items),
            items,
        },
        updated_at: timestamp,
    });
}

export function materializationFromWorld(value) {
    const world = validateWorldManifest(value);
    const defaultSession = world.sessions.items.find(item => item.session_id === world.sessions.default_session_id);
    return normalizeMaterialization({
        worldName: world.name,
        runtimeCard: {
            engine: world.runtime_card.engine,
            binding: world.runtime_card.binding,
            ownership: world.runtime_card.ownership,
        },
        defaultSession: {
            engine: defaultSession.engine,
            binding: defaultSession.binding,
            openingState: defaultSession.opening_state,
        },
        knowledge: world.knowledge.map(resource => ({
            sourceKey: resource.source_key,
            engine: resource.engine,
            binding: resource.binding,
            ownership: resource.ownership,
        })),
        declaredCapabilities: world.capabilities.declared,
    });
}
