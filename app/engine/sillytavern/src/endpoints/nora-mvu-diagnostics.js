import express from 'express';
import { traceConfig, appendTrace } from '../nora-mvu-trace.js';

import {
    mvuDiagnosticStore,
    normalizeMvuDiagnostic,
} from '../nora-mvu-diagnostics.js';

export const router = express.Router();

router.get('/trace-config', async (request, response) => {
    response.set('Cache-Control', 'no-store').json(await traceConfig(request.user?.directories));
});

router.post('/trace', async (request, response) => {
    const config = await traceConfig(request.user?.directories);
    if (!config.enabled) return response.sendStatus(204);
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) return response.sendStatus(400);
    try {
        await appendTrace(request.user.directories, request.body, request.user.profile?.handle, config);
        return response.sendStatus(204);
    } catch { return response.sendStatus(500); }
});

router.post('/report', async (request, response) => {
    const event = normalizeMvuDiagnostic(request.body, {
        user: request.user?.profile?.handle || 'unknown',
        receivedAt: new Date().toISOString(),
    });
    if (!event) return response.sendStatus(400);
    try {
        await mvuDiagnosticStore.append(request.user.directories, event);
        console.warn(`[Nora MVU diagnostic] code=${event.code} stage=${event.stage} chat=${event.chatId || 'unknown'} attempt=${event.attempt ?? 'unknown'} commands=${event.commandCount ?? 'unknown'} duration=${event.durationMs ?? 'unknown'}ms summary=${event.summary}`);
        return response.sendStatus(204);
    } catch (error) {
        console.error('[Nora MVU diagnostic] Could not persist diagnostic:', error);
        return response.sendStatus(500);
    }
});

router.get('/recent', async (request, response) => {
    try {
        const events = await mvuDiagnosticStore.recent(request.user.directories, request.query.limit);
        return response.json({ events });
    } catch (error) {
        console.error('[Nora MVU diagnostic] Could not read diagnostics:', error);
        return response.status(500).json({ error: 'nora_mvu_diagnostics_failed' });
    }
});
