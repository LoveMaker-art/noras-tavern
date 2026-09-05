import fs from 'node:fs/promises';
import express from 'express';

import { NoraWorldCoreError } from '../nora-world-core/index.js';
import { getActivationSnapshotRevision, readActivationSnapshot } from '../nora-world-core/activation-snapshot.js';
import { resolveNoraWorldCore, worldCorePaths } from '../nora-world-core/runtime.js';
import { normalizeIdempotencyKey, operationIdForKey } from '../nora-world-core/domain.js';
import { stageBlankWorld, stageLibraryCard, stageStCardImport } from '../nora-world-core/st-import-staging.js';
import { validateThemeAssets, importThemeBackground } from '../nora-world-core/theme-assets.js';

function defaultResolveCore(request) {
    return resolveNoraWorldCore(request.user.directories);
}

function publicOperation(operation) {
    if (!operation) return null;
    return {
        schema: operation.schema,
        operation_id: operation.operation_id,
        type: operation.type,
        world_id: operation.world_id,
        stage: operation.stage,
        status: operation.status,
        attempts: operation.attempts,
        result: operation.result ?? null,
        error: operation.error,
        created_at: operation.created_at,
        updated_at: operation.updated_at,
    };
}

function errorStatus(error) {
    if (error?.code === 'NORA_OPERATION_NOT_FOUND' || error?.code === 'NORA_WORLD_NOT_FOUND') return 404;
    if (error?.code === 'NORA_OPERATION_CONFLICT' || error?.code === 'NORA_WORLD_REVISION_CONFLICT'
        || error?.code === 'NORA_CAPABILITY_ATTEMPT_CONFLICT' || error?.code === 'NORA_WORLD_NEEDS_REPAIR') return 409;
    if (error?.code === 'NORA_CARD_STAGING_INVALID' || error?.code === 'NORA_CARD_INVALID'
        || error?.code === 'NORA_CARD_FORMAT_UNSUPPORTED' || error?.code === 'NORA_CARD_UNSUPPORTED_ASSETS'
        || error?.code === 'NORA_WORLD_INVALID' || error?.code === 'NORA_WORLD_NOT_READY'
        || error?.code === 'NORA_CAPABILITY_NOT_DECLARED') return 400;
    return 500;
}

function sendError(response, error) {
    const normalized = error instanceof NoraWorldCoreError
        ? error
        : new NoraWorldCoreError('NORA_WORLD_V2_FAILED', 'The World v2 request failed.', { cause: error });
    if (errorStatus(normalized) >= 500) console.error('[Nora Worlds v2]', error);
    return response.status(errorStatus(normalized)).json({
        error: {
            code: normalized.code,
            message: normalized.message,
            retryable: normalized.retryable,
            operation_id: normalized.details?.operationId || null,
            world_id: normalized.details?.worldId || null,
        },
        detail: normalized.message,
    });
}

async function unlinkUpload(file) {
    if (file?.path) await fs.unlink(file.path).catch(() => {});
}

export function createNoraWorldsV2Router({
    resolveCore = defaultResolveCore,
    stageImport = stageStCardImport,
    stageBlank = stageBlankWorld,
    stageLibrary = stageLibraryCard,
    cleanupUpload = unlinkUpload,
    getSnapshotRevision = getActivationSnapshotRevision,
    readSnapshot = readActivationSnapshot,
} = {}) {
    const router = express.Router();

    router.post('/backgrounds/import', async (request, response) => {
        try {
            if (!request.file?.path) throw new NoraWorldCoreError('NORA_WORLD_INVALID', 'One uploaded background image is required.');
            const image = await importThemeBackground(request.file.path, request.user.directories.backgrounds);
            return response.json(image);
        } catch (error) { return sendError(response, error); } finally { await cleanupUpload(request.file); }
    });
    router.post('/worlds/:worldId/theme', async (request, response) => {
        try {
            if (!Object.hasOwn(request.body || {}, 'ui')) throw new NoraWorldCoreError('NORA_WORLD_INVALID', 'An explicit ui object is required; use an empty object to clear overrides.');
            const ui = await validateThemeAssets(request.body?.ui, request.user.directories.backgrounds);
            const world = await resolveCore(request).setWorldTheme(request.params.worldId, ui, { expectedRevision: request.body?.expected_revision });
            response.setHeader('Cache-Control', 'no-store');
            return response.json({ world });
        } catch (error) { return sendError(response, error); }
    });

    router.get('/status', (request, response) => {
        response.setHeader('Cache-Control', 'no-store');
        return response.json({ enabled: true, schema: 2, userDataRoot: request.user?.directories?.root ?? null });
    });

    router.post('/imports', async (request, response) => {
        try {
            if (!request.file) throw new NoraWorldCoreError('NORA_CARD_STAGING_INVALID', 'One uploaded character card is required.');
            const directories = request.user.directories;
            const { stagingRoot } = worldCorePaths(directories);
            const command = await stageImport({
                uploadedFile: request.file,
                idempotencyKey: request.body?.idempotency_key,
                persona: {
                    name: request.body?.persona_name,
                    description: request.body?.persona_description,
                },
                worldName: request.body?.name,
                stagingRoot,
            });
            const result = await resolveCore(request).submitWorld(command, {
                idempotencyKey: request.body?.idempotency_key,
            });
            return response.status(result.operation.status === 'COMPLETED' ? 200 : 202).json({
                operation: publicOperation(result.operation),
                world: result.world,
                reused: result.reused,
            });
        } catch (error) {
            return sendError(response, error);
        } finally {
            await cleanupUpload(request.file);
        }
    });

    router.post('/library-imports', async (request, response) => {
        try {
            const idempotencyKey = normalizeIdempotencyKey(request.body?.idempotency_key);
            const avatar = request.body?.avatar;
            const core = resolveCore(request);
            const { stagingRoot } = worldCorePaths(request.user.directories);
            // Replay the immutable original command, even after the source card is edited/deleted.
            const existing = await core.getOperation(operationIdForKey(idempotencyKey));
            if (existing && (existing.type !== 'CREATE_WORLD' || existing.command?.payload?.library_avatar !== avatar)) {
                throw new NoraWorldCoreError('NORA_OPERATION_CONFLICT', '此创建请求已用于另一张角色卡。');
            }
            const command = existing?.command || await stageLibrary({ avatar, idempotencyKey, stagingRoot,
                charactersRoot: request.user.directories.characters });
            const result = existing?.status === 'FAILED' && existing.error?.retryable
                ? await core.retryOperation(existing.operation_id)
                : await core.submitWorld(command, { idempotencyKey });
            return response.status(result.operation.status === 'COMPLETED' ? 200 : 202).json({
                operation: publicOperation(result.operation), world: result.world, reused: result.reused,
            });
        } catch (error) { return sendError(response, error); }
    });

    router.post('/worlds', async (request, response) => {
        try {
            const directories = request.user.directories;
            const { stagingRoot } = worldCorePaths(directories);
            const command = await stageBlank({
                idempotencyKey: request.body?.idempotency_key,
                persona: {
                    name: request.body?.persona_name,
                    description: request.body?.persona_description,
                },
                worldName: request.body?.name,
                stagingRoot,
            });
            const result = await resolveCore(request).submitWorld(command, {
                idempotencyKey: request.body?.idempotency_key,
            });
            return response.status(result.operation.status === 'COMPLETED' ? 200 : 202).json({
                operation: publicOperation(result.operation),
                world: result.world,
                reused: result.reused,
            });
        } catch (error) {
            return sendError(response, error);
        }
    });

    router.get('/operations/:operationId', async (request, response) => {
        try {
            const core = resolveCore(request);
            const operation = await core.getOperation(request.params.operationId);
            if (!operation) throw new NoraWorldCoreError('NORA_OPERATION_NOT_FOUND', 'World operation was not found.');
            const world = operation.status === 'COMPLETED' ? await core.getWorld(operation.world_id) : null;
            return response.json({ operation: publicOperation(operation), world });
        } catch (error) {
            return sendError(response, error);
        }
    });

    router.post('/operations/:operationId/retry', async (request, response) => {
        try {
            const result = await resolveCore(request).retryOperation(request.params.operationId);
            return response.json({ operation: publicOperation(result.operation), world: result.world, reused: result.reused });
        } catch (error) {
            return sendError(response, error);
        }
    });

    router.get('/worlds', async (request, response) => {
        try {
            return response.json({ worlds: await resolveCore(request).listWorlds() });
        } catch (error) {
            return sendError(response, error);
        }
    });

    router.post('/worlds/:worldId/capabilities/:capability/attempts', async (request, response) => {
        try {
            const result = await resolveCore(request).beginCapabilityAttempt(
                request.params.worldId,
                request.params.capability,
            );
            return response.status(201).json(result);
        } catch (error) {
            return sendError(response, error);
        }
    });

    router.patch('/worlds/:worldId', async (request, response) => {
        try {
            const world = await resolveCore(request).updateWorld(request.params.worldId, request.body?.patch,
                { expectedRevision: request.body?.expected_revision });
            response.setHeader('Cache-Control', 'no-store');
            return response.json({ world });
        } catch (error) { return sendError(response, error); }
    });

    router.put('/worlds/:worldId/capabilities/:capability/attempts/:attemptId', async (request, response) => {
        try {
            const world = await resolveCore(request).settleCapabilityAttempt(
                request.params.worldId,
                request.params.capability,
                request.params.attemptId,
                request.body,
            );
            return response.json({ world });
        } catch (error) {
            return sendError(response, error);
        }
    });

    router.get('/worlds/:worldId/open-plan', async (request, response) => {
        try {
            return response.json({ plan: await resolveCore(request).prepareOpen(request.params.worldId) });
        } catch (error) {
            return sendError(response, error);
        }
    });

    router.get('/worlds/:worldId/snapshot', async (request, response) => {
        try {
            const planStartedAt = performance.now();
            const plan = await resolveCore(request).prepareOpen(request.params.worldId);
            const planDuration = performance.now() - planStartedAt;
            const revisionStartedAt = performance.now();
            const revision = await getSnapshotRevision(plan, request.user.directories);
            const revisionDuration = performance.now() - revisionStartedAt;
            const etag = `"${revision}"`;
            response.setHeader('Cache-Control', 'private, no-cache');
            response.setHeader('ETag', etag);
            const knownTags = String(request.headers?.['if-none-match'] || '').split(',').map(value => value.trim());
            if (knownTags.includes(etag)) {
                response.setHeader('Server-Timing', `nora_plan;dur=${planDuration.toFixed(1)}, nora_revision;dur=${revisionDuration.toFixed(1)}`);
                return response.status(304).end();
            }
            const result = await readSnapshot(plan, request.user.directories, { revision });
            const timingParts = [
                `nora_plan;dur=${planDuration.toFixed(1)}`,
                `nora_revision;dur=${revisionDuration.toFixed(1)}`,
                ...Object.entries(result.timings || {}).map(([name, duration]) => `nora_${name};dur=${Number(duration).toFixed(1)}`),
            ];
            response.setHeader('Server-Timing', timingParts.join(', '));
            return response.json({ snapshot: result.snapshot });
        } catch (error) {
            return sendError(response, error);
        }
    });

    router.post('/worlds/:worldId/repair', async (request, response) => {
        try {
            const result = await resolveCore(request).repairWorld(request.params.worldId, {
                idempotencyKey: request.body?.idempotency_key,
            });
            return response.json({ operation: publicOperation(result.operation), world: result.world, reused: result.reused });
        } catch (error) {
            return sendError(response, error);
        }
    });

    router.delete('/worlds/:worldId', async (request, response) => {
        try {
            const result = await resolveCore(request).deleteWorld(request.params.worldId, {
                idempotencyKey: request.body?.idempotency_key,
            });
            return response.json({ operation: publicOperation(result.operation), world: result.world, reused: result.reused });
        } catch (error) {
            return sendError(response, error);
        }
    });

    return router;
}

export const router = createNoraWorldsV2Router();
