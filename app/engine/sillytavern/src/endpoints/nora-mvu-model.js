import express from 'express';

import { NoraMvuModelConfig, NoraMvuModelConfigError } from '../nora-mvu-model-config.js';
import { readSecret, SECRET_KEYS, writeSecret } from './secrets.js';

export const router = express.Router();

function store(request) {
    return new NoraMvuModelConfig(request.user.directories.root);
}

function publicConfig(request, config = store(request).read()) {
    return {
        base_url: config?.base_url ?? '',
        model: config?.model ?? '',
        context: config?.context ?? 128000,
        max_tokens: config?.max_tokens ?? 20000,
        has_api_key: Boolean(readSecret(request.user.directories, SECRET_KEYS.NORA_MVU)),
    };
}

function handleError(response, error) {
    if (error instanceof NoraMvuModelConfigError) {
        return response.status(400).send({ error: error.code, detail: error.message });
    }
    console.error('[Nora MVU Model]', error);
    return response.status(500).send({ error: 'nora_mvu_model_failed' });
}

router.post('/config', (request, response) => {
    try {
        return response.send(publicConfig(request));
    } catch (error) {
        return handleError(response, error);
    }
});

router.post('/configure', (request, response) => {
    try {
        const apiKey = String(request.body?.api_key ?? '').trim();
        const existingKey = readSecret(request.user.directories, SECRET_KEYS.NORA_MVU);
        if (!apiKey && !existingKey) {
            return response.status(400).send({
                error: 'mvu_model_key_required',
                detail: 'An API key is required for the independent MVU model.',
            });
        }
        const config = store(request).save(request.body);
        if (apiKey) writeSecret(request.user.directories, SECRET_KEYS.NORA_MVU, apiKey);
        return response.send(publicConfig(request, config));
    } catch (error) {
        return handleError(response, error);
    }
});
