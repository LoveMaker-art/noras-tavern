import express from 'express';
import { resolveStoryLedger } from '../nora-story-ledger/runtime.js';
import { getChatRevision } from '../chat-revision.js';
import { readSettingsPayload } from './settings.js';
import { chatBackupWarning } from '../chat-backup-runtime.js';

export const router = express.Router();
// Separate read contract: no model scheduling, state repair or memory projection.
router.post('/inspect', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    try {
        const scope = { worldId: request.body?.worldId, sessionId: request.body?.sessionId };
        const runtime = resolveStoryLedger(request.user.directories, { recoverProjection: false });
        await runtime.resolve(scope);
        const status = await runtime.plugin.inspect(scope, { offset: request.body?.offset ?? 0, limit: request.body?.limit ?? 0 });
        let model = null;
        try {
            const payload = readSettingsPayload(request.user.directories, 'runtime');
            const settings = typeof payload.settings === 'string' ? JSON.parse(payload.settings) : payload.settings;
            const configured = settings?.oai_settings;
            const projected = settings?.extension_settings?.nora_ui?.lastWorldId;
            if ((!projected || projected === scope.worldId) && configured?.chat_completion_source === 'custom') {
                const capacity = Number(configured.openai_max_context);
                model = { name: String(configured.custom_model || ''), contextLimit: Number.isSafeInteger(capacity) && capacity >= 512 ? capacity : null };
            }
        } catch { /* Missing model configuration must not hide the ledger settings. */ }
        return response.json({ ...status, model });
    } catch (error) {
        return response.status(error.status || 400).json({ code: error.code || 'NORA_LEDGER_REQUEST_FAILED', error: 'Story ledger inspection failed.' });
    }
});
// Auth/CSRF are supplied by the same authenticated /api stack as World Core.
for (const action of ['status', 'configure', 'compress', 'edit', 'checkpoint', 'reset']) {
    router.post(`/${action}`, async (request, response) => {
        response.set('Cache-Control', 'no-store');
        try {
            const scope = { worldId: request.body?.worldId, sessionId: request.body?.sessionId };
            const runtime = resolveStoryLedger(request.user.directories);
            await runtime.resolve(scope);
            if (action === 'reset') {
                if (request.body.confirm !== true) return response.status(400).json({ code: 'NORA_LEDGER_RESET_CONFIRM_REQUIRED' });
                return response.json(await runtime.reset(scope, request.body));
            }
            if (action === 'checkpoint') return response.json(await runtime.checkpoint(scope, request.body));
            if (action === 'edit') {
                const chat = await runtime.edit(scope, request.body);
                return response.json({ chat, revision: getChatRevision(chat), ledger: await runtime.plugin.status(scope),
                    backupWarning: chatBackupWarning(request.user.directories, scope) });
            }
            if (action === 'configure') {
                const { enabled, expectedRevision, contextLimitOverride, outputTokenLimit, timeoutSeconds } = request.body;
                return response.json(await runtime.configure(scope, Object.fromEntries(Object.entries({ enabled, expectedRevision, contextLimitOverride, outputTokenLimit, timeoutSeconds }).filter(([, value]) => value !== undefined))));
            }
            // Reading status must not silently start a billable model request.
            if (action === 'compress') void runtime.plugin.schedule(scope, { retry: true });
            return response.json(await runtime.plugin.status(scope));
        } catch (error) {
            return response.status(error.status || 400).json({ code: error.code || 'NORA_LEDGER_REQUEST_FAILED', error: 'Story ledger request could not be completed.' });
        }
    });
}
