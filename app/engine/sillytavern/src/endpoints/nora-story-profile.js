import express from 'express';
import { runStoryProfileAdapter as runAdapter } from '../nora-story-profile-adapter.js';

import { getCharacterByAvatar } from './characters.js';
import {
    loadStoryProfileReflectionContext,
    loadStoryProfileProgress,
    loadStoryProfileCard,
    readAgentUserId,
    readStoryProfileState,
    resolveStoryProfileStateDirectory,
} from '../nora-story-profile.js';
import { readSettingsPayload } from './settings.js';
import { readSecret, SECRET_KEYS } from './secrets.js';
import { createPreferenceCheckpointCoordinator } from '../../../../story_profile_runtime/adapters/nora/preference-checkpoint.js';
import { readActiveNoraTextModel } from '../../../../story_profile_runtime/adapters/nora/model-config.js';

export const router = express.Router();
export const compatibilityRouter = express.Router();

const checkpointCoordinators = new Map();

async function actorCard(request) {
    return loadStoryProfileCard({
        directories: request.user.directories,
        getCharacterFn: getCharacterByAvatar,
    });
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
        }),
    };
}

async function runReflectionAdapter(request, context) {
    const result = await runAdapter('reflect', modelEnvelope(request, { context }));
    if (result.code !== 0 || result.value?.ok === false) {
        throw new Error(result.value?.error || result.stderr || 'Story Profile reflection failed.');
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
            loadProgress: worldId => loadStoryProfileProgress({ directories, worldId }),
            loadContext: worldId => reflectionContext(request, worldId),
            runReflection: context => runReflectionAdapter(request, context),
        });
        checkpointCoordinators.set(key, coordinator);
    }
    return coordinator;
}

router.get('/card', async (request, response) => {
    try {
        const card = await actorCard(request);
        response.set('Cache-Control', 'no-store');
        return response.json(card);
    } catch (error) {
        console.error('[Nora Story Profile]', error);
        return response.status(500).json({ error: 'story_profile_unavailable' });
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
        console.error('[Nora Story Profile checkpoint]', error);
        return response.status(500).json({ error: 'story_profile_checkpoint_unavailable' });
    }
});

router.get('/checkpoint/:worldId', (request, response) => {
    response.set('Cache-Control', 'no-store');
    return response.json(checkpointCoordinator(request).status(request.params.worldId));
});

router.post('/reflect-preview', async (request, response) => {
    try {
        const context = await reflectionContext(request, request.body?.world_id);
        if (!context) return response.status(404).json({ error: 'world_not_found' });
        const result = await runAdapter(
            'reflect-preview',
            modelEnvelope(request, { context }),
        );
        return response.status(result.code === 0 ? 200 : 502).json(result.value);
    } catch (error) {
        console.error('[Nora Story Profile preview]', error);
        return response.status(500).json({ error: 'story_profile_preview_unavailable' });
    }
});

router.post('/reflect', async (request, response) => {
    try {
        const context = await reflectionContext(request, request.body?.world_id);
        if (!context) return response.status(404).json({ error: 'world_not_found' });
        const result = await runAdapter('reflect', modelEnvelope(request, { context }));
        return response.status(result.code === 0 ? 200 : 502).json(result.value);
    } catch (error) {
        console.error('[Nora Story Profile reflect]', error);
        return response.status(500).json({ error: 'story_profile_reflection_unavailable' });
    }
});

router.post('/learn', async (request, response) => {
    try {
        const result = await runAdapter('learn', modelEnvelope(request, request.body || {}));
        return response.status(result.code === 0 ? 200 : 502).json(result.value);
    } catch (error) {
        console.error('[Nora Story Profile learn]', error);
        return response.status(500).json({ error: 'story_profile_learning_unavailable' });
    }
});

router.post('/refresh', async (request, response) => {
    try {
        const result = await runAdapter('refresh-taste', modelEnvelope(request));
        return response.status(result.code === 0 ? 200 : 502).json(result.value);
    } catch (error) {
        console.error('[Nora Story Profile refresh]', error);
        return response.status(500).json({ error: 'story_profile_refresh_unavailable' });
    }
});

// Compatibility surface consumed by the original actor.js. Keeping these
// routes shallow lets the migrated UI remain unchanged while Nora owns data.
compatibilityRouter.get('/api/actor_card', async (request, response) => {
    try {
        const card = await actorCard(request);
        response.set('Cache-Control', 'no-store');
        return response.json(card);
    } catch (error) {
        console.error('[Nora Story Profile]', error);
        return response.status(500).json({ error: 'story_profile_unavailable' });
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
