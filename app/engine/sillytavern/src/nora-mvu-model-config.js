import fs from 'node:fs';
import path from 'node:path';

import { sync as writeFileAtomicSync } from 'write-file-atomic';

export const NORA_MVU_MODEL_FILE = 'nora-mvu-model.json';
export const NORA_MVU_MODEL_PROXY_URL = 'https://nora-mvu.invalid/v1';

export class NoraMvuModelConfigError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'NoraMvuModelConfigError';
        this.code = code;
    }
}

function requiredText(value, field, maximum = 500) {
    const text = String(value ?? '').trim();
    if (!text) throw new NoraMvuModelConfigError('invalid_mvu_model_config', `${field} is required.`);
    if (text.length > maximum) throw new NoraMvuModelConfigError('invalid_mvu_model_config', `${field} is too long.`);
    return text;
}

export function normalizeMvuModelBaseUrl(value) {
    const parsed = new URL(requiredText(value, 'base_url', 2000));
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new NoraMvuModelConfigError('invalid_mvu_model_config', 'base_url must use HTTP or HTTPS.');
    }
    parsed.hash = '';
    parsed.search = '';
    parsed.pathname = parsed.pathname.replace(/\/(?:chat\/completions)?\/*$/i, '') || '/';
    return parsed.toString().replace(/\/$/, '');
}

export function isNoraMvuModelProxyUrl(value) {
    return String(value ?? '').replace(/\/$/, '') === NORA_MVU_MODEL_PROXY_URL;
}

export class NoraMvuModelConfig {
    constructor(rootDirectory) {
        this.filePath = path.join(rootDirectory, NORA_MVU_MODEL_FILE);
    }

    read() {
        if (!fs.existsSync(this.filePath)) return null;
        try {
            const value = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            return Object.freeze({
                schema: 'nora-mvu-model/v1',
                base_url: normalizeMvuModelBaseUrl(value?.base_url),
                model: requiredText(value?.model, 'model'),
            });
        } catch (error) {
            if (error instanceof NoraMvuModelConfigError) throw error;
            throw new NoraMvuModelConfigError('invalid_mvu_model_config', 'Stored MVU model configuration is invalid.');
        }
    }

    save(value) {
        const config = {
            schema: 'nora-mvu-model/v1',
            base_url: normalizeMvuModelBaseUrl(value?.base_url),
            model: requiredText(value?.model, 'model'),
        };
        writeFileAtomicSync(this.filePath, JSON.stringify(config, null, 4), 'utf8');
        return Object.freeze(config);
    }
}

export function resolveNoraMvuModelRequest(directories, customUrl) {
    if (!isNoraMvuModelProxyUrl(customUrl)) return null;
    const config = new NoraMvuModelConfig(directories.root).read();
    if (!config) {
        throw new NoraMvuModelConfigError('mvu_model_not_configured', 'MVU variable model is not configured.');
    }
    return config;
}
