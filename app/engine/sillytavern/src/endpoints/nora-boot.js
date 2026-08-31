import express from 'express';

import { listCharacters } from './characters.js';
import { readSecretState } from './secrets.js';
import { readSettingsPayload } from './settings.js';
import { createBootstrapPayload } from '../nora-bootstrap.js';
import { readAgentUserId } from '../nora-story-profile.js';
import { normalizeClientMetricPayload, noraTelemetryWriter } from '../nora-performance-telemetry.js';
import { getVersion } from '../util.js';

const MAX_PAYLOAD_BYTES = 96 * 1024;
const ALLOWED_PHASES = new Set([
    'app-ready',
    'nora-ui-hydrated',
    'nora-runtime-ready',
    'nora-usable',
    'first-interaction',
    'world-selected',
    'early-world-selected',
    'extensions-ready',
    'nora-startup-failed',
    'world-selection-failed',
]);
export const router = express.Router();
let versionPromise;

router.get('/bootstrap', async (request, response) => {
    const csrfToken = typeof request.csrfToken === 'function' ? request.csrfToken() : 'disabled';
    try {
        return response.json(await createBootstrapPayload({
            csrfToken,
            directories: request.user.directories,
            listCharactersFn: listCharacters,
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

    const knownPhase = ALLOWED_PHASES.has(payload.phase);
    const event = normalizeClientMetricPayload({
        ...payload,
        phase: knownPhase ? payload.phase : 'runtime-event',
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
        console.info(`[Nora telemetry] ${event.phase} trace=${event.traceId} captured=${event.metrics.capturedAt ?? 'unknown'}ms`);
        return response.sendStatus(204);
    } catch (error) {
        console.error('[Nora telemetry] Could not persist client summary:', error);
        return response.sendStatus(500);
    }
});
