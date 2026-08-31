import express from 'express';
import { resolveStoryLedger } from '../nora-story-ledger/runtime.js';

export const router = express.Router();
// Separate read contract: no model scheduling, state repair or memory projection.
router.post('/inspect', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    try {
        const scope = { worldId: request.body?.worldId, sessionId: request.body?.sessionId };
        const runtime = resolveStoryLedger(request.user.directories, { recoverProjection: false });
        await runtime.resolve(scope);
        return response.json(await runtime.plugin.inspect(scope, { offset: request.body?.offset ?? 0, limit: request.body?.limit ?? 0 }));
    } catch (error) {
        return response.status(error.status || 400).json({ code: error.code || 'NORA_LEDGER_REQUEST_FAILED', error: 'Story ledger inspection failed.' });
    }
});
// Auth/CSRF are supplied by the same authenticated /api stack as World Core.
for (const action of ['status', 'configure', 'compress', 'edit']) {
    router.post(`/${action}`, async (request, response) => {
        response.set('Cache-Control', 'no-store');
        try {
            const scope = { worldId: request.body?.worldId, sessionId: request.body?.sessionId };
            const runtime = resolveStoryLedger(request.user.directories);
            await runtime.resolve(scope);
            if (action === 'edit') return response.json({ chat: await runtime.edit(scope, request.body), ledger: await runtime.plugin.status(scope) });
            if (action === 'configure') {
                return response.json(await runtime.plugin.configure(scope, { enabled: request.body.enabled }));
            }
            // Opening a session resumes eligible interrupted work after restart.
            // A status request itself never waits for a model.
            void runtime.plugin.schedule(scope, { retry: action === 'compress' });
            return response.json(await runtime.plugin.status(scope));
        } catch (error) {
            return response.status(error.status || 400).json({ code: error.code || 'NORA_LEDGER_REQUEST_FAILED', error: 'Story ledger request could not be completed.' });
        }
    });
}
