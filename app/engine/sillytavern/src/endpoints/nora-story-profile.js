import path from 'node:path';
import express from 'express';
import { parse as parseYaml } from 'yaml';
import { runStoryProfileAdapter as runAdapter, resolveStoryProfileProxy } from '../nora-story-profile-adapter.js';

import { getCharacterByAvatar } from './characters.js';
import {
    loadStoryProfileReflectionContext,
    loadStoryProfileProgress,
    loadStoryProfileCard,
    loadStoryProfileStoryProgress,
    loadStoryProfileStoryRead,
    readAgentUserId,
    readStoryProfileState,
    resolveStoryProfileStateDirectory,
} from '../nora-story-profile.js';
import { readSettingsPayload } from './settings.js';
import { readSecret, SECRET_KEYS } from './secrets.js';
import { createPreferenceCheckpointCoordinator, readPreferenceSettings, writePreferenceSettings, PREFERENCE_CONSENT_VERSION } from '../../../../story_profile_runtime/adapters/nora/preference-checkpoint.js';
import { readActiveNoraTextModel } from '../../../../story_profile_runtime/adapters/nora/model-config.js';

export const router = express.Router();
export const compatibilityRouter = express.Router();

const checkpointCoordinators = new Map();

async function actorCard(request) {
    const card = await loadStoryProfileCard({ directories: request.user.directories, getCharacterFn: getCharacterByAvatar });
    return { ...card, reflection_status: checkpointCoordinator(request).statuses() };
}

async function reflectionContext(request, worldId) {
    return loadStoryProfileReflectionContext({
        directories: request.user.directories,
        worldId,
        getCharacterFn: getCharacterByAvatar,
    });
}

function modelEnvelope(request, value = {}) {
    return {
        ...value,
        model: readActiveNoraTextModel(request.user.directories, {
            readSettings: directories => readSettingsPayload(directories, 'runtime'),
            readApiKey: directories => readSecret(directories, SECRET_KEYS.CUSTOM),
            parseYaml,
            resolveProxy: resolveStoryProfileProxy,
        }),
    };
}

function preferenceSettingsOptions(request) {
    return { preferenceFile: path.join(request.user.directories.root, 'story_profile_preferences.json') };
}

async function runReflectionAdapter(request, context, { automatic = false } = {}) {
    const result = await runAdapter('reflect', modelEnvelope(request, { context,
        ...(automatic ? { automatic_preference_file: preferenceSettingsOptions(request).preferenceFile } : {}) }));
    if (result.code !== 0 || result.value?.ok === false) {
        throw Object.assign(new Error(result.value?.error || 'Story Profile reflection failed.'), {
            code: result.value?.code || 'STORY_PROFILE_EXECUTION_FAILED', result: result.value,
        });
    }
    return result.value;
}

function checkpointCoordinator(request) {
    const directories = request.user.directories;
    const stateDirectory = resolveStoryProfileStateDirectory();
    const key = [stateDirectory, directories.root, directories.chats].join('\u0000');
    let coordinator = checkpointCoordinators.get(key);
    if (!coordinator) {
        coordinator = createPreferenceCheckpointCoordinator({
            stateDirectory,
            preferenceFile: preferenceSettingsOptions(request).preferenceFile,
            loadProgress: worldId => loadStoryProfileProgress({ directories, worldId }),
            loadContext: worldId => reflectionContext(request, worldId),
            runReflection: (context, options) => runReflectionAdapter(request, context, options),
        });
        checkpointCoordinators.set(key, coordinator);
    }
    return coordinator;
}


function sendFailure(response, error, fallback) {
    const code = error?.code || fallback;
    console.error('[Nora Story Profile]', code);
    const status = code === 'WORLD_NOT_FOUND' ? 404
        : code === 'STORY_PROFILE_CONSENT_REQUIRED' ? 400
            : /STORAGE|COMMIT_PENDING|UNREADABLE/.test(code) ? 503 : 500;
    return response.status(status).json({ ok: false, code, error: error?.message || '故事档案操作未完成；原数据已保留。' });
}
async function runWriter(request, command, payload) {
    const result = await runAdapter(command, modelEnvelope(request, payload));
    if (!result.value || typeof result.value.ok !== 'boolean') throw Object.assign(new Error('档案操作没有返回可核验结果。'), { code: 'STORY_PROFILE_RESULT_INVALID' });
    return result.value;
}
router.get('/settings', (request, response) => {
    response.set('Cache-Control', 'no-store');
    try { return response.json(readPreferenceSettings(resolveStoryProfileStateDirectory(), preferenceSettingsOptions(request))); } catch (error) { return sendFailure(response, error, 'STORY_PROFILE_SETTINGS_UNAVAILABLE'); }
});
router.post('/settings', (request, response) => {
    response.set('Cache-Control', 'no-store');
    try { return response.json(writePreferenceSettings(resolveStoryProfileStateDirectory(), request.body, preferenceSettingsOptions(request))); } catch (error) { return sendFailure(response, error, 'STORY_PROFILE_SETTINGS_UNAVAILABLE'); }
});

// Existing main-branch clients use enabled rather than auto_enabled. Both
// surfaces resolve and save the same choice, leaving the legacy document intact.
function automaticPreferences(request) {
    const settings = readPreferenceSettings(resolveStoryProfileStateDirectory(), preferenceSettingsOptions(request));
    let model = null;
    try { model = { name: modelEnvelope(request).model?.model || '', source: 'tavern-text-model' }; }
    catch { /* The choice remains available before a model is configured. */ }
    return { enabled: settings.auto_enabled, consentRequired: false, model };
}
router.get('/automatic-preferences', (request, response) => {
    response.set('Cache-Control', 'no-store');
    try { return response.json(automaticPreferences(request)); } catch (error) { return sendFailure(response, error, 'STORY_PROFILE_SETTINGS_UNAVAILABLE'); }
});
router.post('/automatic-preferences', (request, response) => {
    response.set('Cache-Control', 'no-store');
    try {
        writePreferenceSettings(resolveStoryProfileStateDirectory(), { auto_enabled: request.body?.enabled,
            consent_version: PREFERENCE_CONSENT_VERSION }, preferenceSettingsOptions(request));
        return response.json(automaticPreferences(request));
    } catch (error) { return sendFailure(response, error, 'STORY_PROFILE_SETTINGS_UNAVAILABLE'); }
});
router.get('/status', async (request, response) => {
    try {
        const card = await actorCard(request), coordinator = checkpointCoordinator(request), current = coordinator.statuses();
        const worlds = card.reflection_worlds.map(world => ({ ...coordinator.status(world.world_id, world), ...world }));
        response.set('Cache-Control', 'no-store');
        return response.json({ settings: readPreferenceSettings(resolveStoryProfileStateDirectory(), preferenceSettingsOptions(request)), ...current, worlds,
            record_count: card.intimacy.log, taste_profile_stale: card.taste_profile_stale,
            profile_storage_state: card.profile_storage_state });
    } catch (error) { return sendFailure(response, error, 'STORY_PROFILE_STATUS_UNAVAILABLE'); }
});

router.get('/card', async (request, response) => {
    try {
        const card = await actorCard(request);
        response.set('Cache-Control', 'no-store');
        return response.json(card);
    } catch (error) {
        return sendFailure(response, error, 'STORY_PROFILE_UNAVAILABLE');
    }
});

router.get('/progress', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    const { world_id: worldId = '', session_id: sessionId = '' } = request.query;
    if (typeof worldId !== 'string' || typeof sessionId !== 'string') {
        return response.status(400).json({ code: 'STORY_PROGRESS_SCOPE_INVALID', error: '故事与会话标识必须为单个文本值。' });
    }
    try {
        const storyProgress = await loadStoryProfileStoryProgress({ directories: request.user.directories,
            worldId: worldId.trim(), sessionId: sessionId.trim() });
        return response.json({ story_progress: storyProgress });
    } catch (error) {
        const code = error?.code || 'STORY_PROGRESS_UNAVAILABLE';
        const missing = ['WORLD_NOT_FOUND', 'STORY_SESSION_NOT_FOUND'].includes(code);
        console.error('[Nora Story Progress]', code);
        return response.status(missing ? 404 : 503).json({ code, error: missing ? '找不到指定故事或会话。' : '故事进度读取失败；原故事、偏好和档案已保留。' });
    }
});

router.post('/read', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    try {
        return response.json(await loadStoryProfileStoryRead({ directories: request.user.directories, payload: request.body }));
    } catch (error) {
        const code = error?.code || 'STORY_READ_UNAVAILABLE';
        const invalid = /^STORY_READ_(OPTIONS_INVALID|SCOPE_CONFLICT|CURSOR_)/.test(code);
        return response.status(invalid ? 400 : 503).json({ schema: 'nora-story-read/1', read_only: true, model_called: false,
            status: 'unavailable', code, error: invalid ? error.message : '故事来源暂时无法核验；没有修改故事或记忆。' });
    }
});

router.post('/checkpoint', async (request, response) => {
    try {
        const worldId = String(request.body?.world_id || '').trim();
        if (!worldId) return response.status(400).json({ error: 'world_id_required' });
        const result = await checkpointCoordinator(request).checkpoint(worldId);
        response.set('Cache-Control', 'no-store');
        return response.status(result.scheduled ? 202 : 200).json(result);
    } catch (error) {
        return sendFailure(response, error, 'STORY_PROFILE_CHECKPOINT_UNAVAILABLE');
    }
});

router.get('/checkpoint/:worldId', async (request, response) => {
    try { const progress = await loadStoryProfileProgress({ directories: request.user.directories, worldId: request.params.worldId }); response.set('Cache-Control', 'no-store'); return response.json(checkpointCoordinator(request).status(request.params.worldId, progress)); } catch (error) { return sendFailure(response, error, 'STORY_PROFILE_CHECKPOINT_UNAVAILABLE'); }
});

router.post('/reflect-preview', async (request, response) => {
    try {
        const result = await checkpointCoordinator(request).runAction('preview', async () => {
            const context = await reflectionContext(request, request.body?.world_id);
            if (!context) throw Object.assign(new Error('找不到指定世界。'), { code: 'WORLD_NOT_FOUND' });
            return runWriter(request, 'reflect-preview', { context });
        });
        return response.status(result.ok === false ? 502 : 200).json(result);
    } catch (error) { return sendFailure(response, error, 'STORY_PROFILE_PREVIEW_UNAVAILABLE'); }
});
router.post('/reflect', async (request, response) => {
    try {
        const result = await checkpointCoordinator(request).reflect(request.body?.world_id, { retry: request.body?.retry === true });
        return response.status(result.ok === false ? 502 : 200).json(result);
    } catch (error) { return sendFailure(response, error, 'STORY_PROFILE_REFLECTION_UNAVAILABLE'); }
});
router.post('/learn', async (request, response) => {
    try {
        const result = await checkpointCoordinator(request).runAction('learn', () => runWriter(request, 'learn', request.body || {}));
        return response.status(result.ok === false ? 502 : 200).json(result);
    } catch (error) { return sendFailure(response, error, 'STORY_PROFILE_LEARNING_UNAVAILABLE'); }
});
router.post('/recover', async (request, response) => {
    try {
        const result = await checkpointCoordinator(request).runAction('recover', async () => {
            const reply = await runAdapter('recover-profile', {});
            if (!reply.value || typeof reply.value.ok !== 'boolean') {
                throw Object.assign(new Error('档案恢复没有返回可核验结果。'), { code: 'STORY_PROFILE_RESULT_INVALID' });
            }
            return reply.value;
        });
        return response.status(result.ok === false ? 503 : 200).json(result);
    } catch (error) { return sendFailure(response, error, 'STORY_PROFILE_RECOVERY_UNAVAILABLE'); }
});
router.post('/refresh', async (request, response) => {
    try {
        const coordinator = checkpointCoordinator(request);
        const result = await coordinator.runAction('refresh', () => runWriter(request, 'refresh-taste', {}));
        if (result.ok !== false && readStoryProfileState().profile?.taste_profile_stale === false) coordinator.summaryRecovered();
        return response.status(result.ok === false ? 502 : 200).json(result);
    } catch (error) { return sendFailure(response, error, 'STORY_PROFILE_REFRESH_UNAVAILABLE'); }
});

// Compatibility surface consumed by the original actor.js. Keeping these
// routes shallow lets the migrated UI remain unchanged while Nora owns data.
compatibilityRouter.get('/api/actor_card', async (request, response) => {
    try {
        const card = await actorCard(request);
        response.set('Cache-Control', 'no-store');
        return response.json(card);
    } catch (error) {
        return sendFailure(response, error, 'STORY_PROFILE_UNAVAILABLE');
    }
});

compatibilityRouter.get('/api/identity', (_request, response) => {
    const { identity } = readStoryProfileState();
    response.set('Cache-Control', 'no-store');
    return response.json({
        ...identity,
        agent_user_id: readAgentUserId(),
    });
});

compatibilityRouter.get('/api/personality', async (_request, response) => {
    try {
        const result = await runAdapter('personality-read');
        response.set('Cache-Control', 'no-store');
        return response.status(result.code === 0 ? 200 : 500).json(result.value);
    } catch (error) {
        console.error('[Nora Story Profile personality]', error);
        return response.status(500).json({ error: 'personality_unavailable' });
    }
});

compatibilityRouter.post('/api/personality', async (request, response) => {
    try {
        const result = await runAdapter('personality-write', request.body || {});
        const status = result.code === 0 ? 200 : (result.value.code === 'revision_conflict' ? 409 : 400);
        return response.status(status).json(result.value);
    } catch (error) {
        console.error('[Nora Story Profile personality]', error);
        return response.status(500).json({ error: 'personality_unavailable' });
    }
});

compatibilityRouter.get('/actor', (request, response) => {
    const query = request.originalUrl.includes('?') ? request.originalUrl.slice(request.originalUrl.indexOf('?')) : '';
    return response.redirect(307, `/actor.html${query}`);
});

compatibilityRouter.get('/story-profile.html', (request, response) => {
    const query = request.originalUrl.includes('?') ? request.originalUrl.slice(request.originalUrl.indexOf('?')) : '';
    return response.redirect(307, `/actor${query}`);
});
