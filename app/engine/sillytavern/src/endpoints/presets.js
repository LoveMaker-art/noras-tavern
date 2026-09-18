import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { getDefaultPresetFile, getDefaultPresets } from './content-manager.js';
import { listPresetTemplates, readPresetTemplate, savePresetTemplate, importPresetTemplate } from '../nora-preset-library.js';
import { encodePresetFile } from '../../public/scripts/nora-worlds/preset-file.js';

/**
 * Gets the folder and extension for the preset settings based on the API source ID.
 * @param {string} apiId API source ID
 * @param {import('../workspace.js').UserDirectoryList} directories User directories
 * @returns {{folder: string?, extension: string?}} Object containing the folder and extension for the preset settings
 */
function getPresetSettingsByAPI(apiId, directories) {
    switch (apiId) {
        case 'kobold':
        case 'koboldhorde':
            return { folder: directories.koboldAI_Settings, extension: '.json' };
        case 'novel':
            return { folder: directories.novelAI_Settings, extension: '.json' };
        case 'textgenerationwebui':
            return { folder: directories.textGen_Settings, extension: '.json' };
        case 'openai':
            return { folder: directories.openAI_Settings, extension: '.json' };
        case 'instruct':
            return { folder: directories.instruct, extension: '.json' };
        case 'context':
            return { folder: directories.context, extension: '.json' };
        case 'sysprompt':
            return { folder: directories.sysprompt, extension: '.json' };
        case 'reasoning':
            return { folder: directories.reasoning, extension: '.json' };
        default:
            return { folder: null, extension: null };
    }
}

export const router = express.Router();

for (const [route, operation] of Object.entries({
    'nora-list': directory => ({ names: listPresetTemplates(directory) }),
    'nora-read': (directory, input) => readPresetTemplate(directory, input.name),
    'nora-save': savePresetTemplate,
    'nora-import': importPresetTemplate,
})) {
    router.post(`/${route}`, (request, response) => {
        try {
            return response.json(operation(request.user.directories.openAI_Settings, request.body));
        } catch (error) {
            const code = /^NORA_PRESET_/.test(error.code || '') ? error.code : 'NORA_PRESET_INVALID';
            return response.status(code === 'NORA_PRESET_TOO_LARGE' ? 413 : /STALE|CONFLICT/.test(code) ? 409 : 400).json({ error: { code, message: 'Preset operation rejected; inspect the target before retrying.' } });
        }
    });
}

router.post('/save', function (request, response) {
    const name = sanitize(request.body.name);
    if (!request.body.preset || !name) {
        return response.sendStatus(400);
    }

    const settings = getPresetSettingsByAPI(request.body.apiId, request.user.directories);
    const filename = name + settings.extension;

    if (!settings.folder) {
        return response.sendStatus(400);
    }

    const fullpath = path.join(settings.folder, filename);
    let encoded;
    try {
        encoded = request.body.apiId === 'openai' ? encodePresetFile(request.body.preset) : JSON.stringify(request.body.preset, null, 4);
    } catch { return response.status(413).json({ error: { code: 'NORA_PRESET_TOO_LARGE' } }); }
    writeFileAtomicSync(fullpath, encoded, 'utf-8');
    return response.send({ name });
});

router.post('/delete', function (request, response) {
    const name = sanitize(request.body.name);
    if (!name) {
        return response.sendStatus(400);
    }

    const settings = getPresetSettingsByAPI(request.body.apiId, request.user.directories);
    const filename = name + settings.extension;

    if (!settings.folder) {
        return response.sendStatus(400);
    }

    const fullpath = path.join(settings.folder, filename);

    if (fs.existsSync(fullpath)) {
        fs.unlinkSync(fullpath);
        return response.sendStatus(200);
    } else {
        return response.sendStatus(404);
    }
});

router.post('/restore', function (request, response) {
    try {
        const settings = getPresetSettingsByAPI(request.body.apiId, request.user.directories);
        const name = sanitize(request.body.name);
        const defaultPresets = getDefaultPresets(request.user.directories);

        const defaultPreset = defaultPresets.find(p => p.name === name && p.folder === settings.folder);

        const result = { isDefault: false, preset: {} };

        if (defaultPreset) {
            result.isDefault = true;
            result.preset = getDefaultPresetFile(defaultPreset.filename) || {};
        }

        return response.send(result);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});
