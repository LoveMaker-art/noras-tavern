import express from 'express';

import { readSecretState } from './secrets.js';
import { readSettingsPayload } from './settings.js';
import { createBootstrapPayload, createShellPayload } from '../nora-bootstrap.js';
import { readAgentUserId } from '../nora-story-profile.js';
import { normalizeClientMetricPayload, noraTelemetryWriter } from '../nora-performance-telemetry.js';
import { resolveNoraWorldCore } from '../nora-world-core/runtime.js';
import { getVersion } from '../util.js';

const MAX_PAYLOAD_BYTES = 96 * 1024;
const PERSISTED_PHASES = new Set([
    'nora-usable',
    'first-interaction',
    'nora-startup-failed',
    'world-selection-failed',
    'boot-resource-failed',
    'boot-resource-stalled',
    'boot-stage-timeout',
    'boot-runtime-error',
    'boot-runtime-rejection',
]);
export const router = express.Router();
let versionPromise;

router.get('/shell', async (request, response) => {
    try {
        response.setHeader('Cache-Control', 'no-store');
        return response.json(await createShellPayload({
            assetRelease: request.app.get('noraAssetRelease'),
            listWorldsFn: () => resolveNoraWorldCore(request.user.directories).listWorlds(),
        }));
    } catch (error) {
        console.error('[Nora shell] Failed to load World summaries:', error);
        return response.status(500).json({ error: 'Nora World summaries could not be loaded.' });
    }
});

router.get('/bootstrap', async (request, response) => {
    const csrfToken = typeof request.csrfToken === 'function' ? request.csrfToken() : 'disabled';
    try {
        return response.json(await createBootstrapPayload({
            csrfToken,
            directories: request.user.directories,
            assetRelease: request.app.get('noraAssetRelease'),
            readRuntimeSettingsFn: directories => readSettingsPayload(directories, 'runtime'),
            readSecretStateFn: readSecretState,
            readVersionFn: () => versionPromise ??= getVersion(),
            readAgentUserIdFn: readAgentUserId,
        }));
    } catch (error) {
        console.error('[Nora bootstrap] Failed to load startup data:', error);
        return response.status(500).json({ error: 'Nora startup data could not be loaded.' });
    }
});

router.post('/metrics', async (request, response) => {
    const payload = request.body;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return response.sendStatus(400);
    }

    if (!PERSISTED_PHASES.has(payload.phase)) return response.sendStatus(204);
    const event = normalizeClientMetricPayload({
        ...payload,
        phase: payload.phase,
    }, {
        receivedAt: new Date().toISOString(),
        user: request.user?.profile?.handle || 'unknown',
    });
    if (!event) return response.sendStatus(400);
    if (Buffer.byteLength(JSON.stringify(event), 'utf8') > MAX_PAYLOAD_BYTES) {
        return response.sendStatus(413);
    }
    try {
        await noraTelemetryWriter.append(request.user.directories, event);
        return response.sendStatus(204);
    } catch (error) {
        console.error('[Nora telemetry] Could not persist client summary:', error);
        return response.sendStatus(500);
    }
});
