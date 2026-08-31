import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import express from 'express';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { DEFAULT_USER, PUBLIC_DIRECTORIES, UPLOADS_DIRECTORY, USER_DIRECTORY_TEMPLATE } from './constants.js';
import { extensionsEnabledFeatureGuard } from './endpoints/extensions.js';
import { IMMUTABLE_ASSET_CACHE_CONTROL, REVALIDATED_ASSET_CACHE_CONTROL } from './nora-static-assets.js';
import { color, getConfigValue, invalidateFirefoxCache, isPathUnderParent } from './util.js';

/**
 * @typedef {Object} User
 * @property {string} handle
 * @property {string} name
 * @property {number} created
 * @property {string} password
 * @property {string} salt
 * @property {boolean} enabled
 * @property {boolean} admin
 */

/**
 * @typedef {Object} UserDirectoryList
 * @property {string} root
 * @property {string} thumbnails
 * @property {string} thumbnailsBg
 * @property {string} thumbnailsAvatar
 * @property {string} thumbnailsPersona
 * @property {string} worlds
 * @property {string} user
 * @property {string} avatars
 * @property {string} userImages
 * @property {string} chats
 * @property {string} characters
 * @property {string} backgrounds
 * @property {string} novelAI_Settings
 * @property {string} koboldAI_Settings
 * @property {string} openAI_Settings
 * @property {string} textGen_Settings
 * @property {string} themes
 * @property {string} movingUI
 * @property {string} extensions
 * @property {string} instruct
 * @property {string} context
 * @property {string} assets
 * @property {string} comfyWorkflows
 * @property {string} files
 * @property {string} backups
 * @property {string} sysprompt
 * @property {string} reasoning
 */

const COOKIE_SECRET_PATH = 'cookie-secret.txt';
let workspaceDirectories;

/** @returns {UserDirectoryList} */
export function getUserDirectories() {
    if (workspaceDirectories) return workspaceDirectories;

    const directories = structuredClone(USER_DIRECTORY_TEMPLATE);
    for (const key in directories) {
        directories[key] = path.join(globalThis.DATA_ROOT, DEFAULT_USER.handle, USER_DIRECTORY_TEMPLATE[key]);
    }
    workspaceDirectories = directories;
    return directories;
}

/** @returns {Promise<UserDirectoryList[]>} */
export async function getUserDirectoriesList() {
    return [getUserDirectories()];
}

/** @returns {{profile: User, directories: UserDirectoryList}} */
export function getSingleUserContext() {
    return {
        profile: DEFAULT_USER,
        directories: getUserDirectories(),
    };
}

/** @returns {Promise<UserDirectoryList[]>} */
export async function ensurePublicDirectoriesExist() {
    for (const directory of Object.values(PUBLIC_DIRECTORIES)) {
        fs.mkdirSync(directory, { recursive: true });
    }

    const directories = getUserDirectories();
    for (const directory of Object.values(directories)) {
        fs.mkdirSync(directory, { recursive: true });
    }
    return [directories];
}

export function cleanUploads() {
    try {
        const uploadsPath = path.join(globalThis.DATA_ROOT, UPLOADS_DIRECTORY);
        if (!fs.existsSync(uploadsPath)) return;

        const uploads = fs.readdirSync(uploadsPath);
        if (uploads.length > 0) {
            console.debug(`Cleaning uploads folder (${uploads.length} files)`);
        }
        for (const file of uploads) {
            fs.unlinkSync(path.join(uploadsPath, file));
        }
    } catch (error) {
        console.error(error);
    }
}

export async function verifySecuritySettings() {
    const { listen, basicAuthMode, whitelistMode } = globalThis.COMMAND_LINE_ARGS;
    if (!listen || basicAuthMode || whitelistMode) return;

    console.error(color.red('The Nora workspace is listening beyond localhost without whitelisting or basic authentication.'));
    if (getConfigValue('securityOverride', false, 'boolean')) {
        console.warn(color.red('Security has been overridden. Use this only on a trusted network.'));
        return;
    }
    process.exit(1);
}

export function getCookieSecret(dataRoot) {
    const cookieSecretPath = path.join(dataRoot, COOKIE_SECRET_PATH);
    if (fs.existsSync(cookieSecretPath) && fs.statSync(cookieSecretPath).size > 0) {
        return fs.readFileSync(cookieSecretPath, 'utf8');
    }

    const oldSecret = getConfigValue('cookieSecret');
    if (oldSecret) {
        writeFileAtomicSync(cookieSecretPath, oldSecret, { encoding: 'utf8' });
        return oldSecret;
    }

    console.warn(color.yellow('Cookie secret is missing from data root. Generating a new one...'));
    const secret = crypto.randomBytes(64).toString('base64');
    writeFileAtomicSync(cookieSecretPath, secret, { encoding: 'utf8' });
    return secret;
}

export function getCookieSessionName() {
    const hostname = os.hostname() || 'localhost';
    const suffix = crypto.createHash('sha256').update(hostname).digest('hex').slice(0, 8);
    return `session-${suffix}`;
}

export function getSessionCookieAge() {
    const configValue = getConfigValue('sessionTimeout', -1, 'number');
    if (configValue > 0) return configValue * 1000;
    if (configValue < 0) return 400 * 24 * 60 * 60 * 1000;
    return undefined;
}

export function setUserDataMiddleware(request, _response, next) {
    request.user = getSingleUserContext();
    return next();
}

function createRouteHandler(directoryFn) {
    return async (request, response) => {
        try {
            const directory = directoryFn(request);
            const filePath = decodeURIComponent(request.params[0]);
            const fullPath = path.join(directory, filePath);
            if (!isPathUnderParent(directory, path.resolve(fullPath))) {
                return response.sendStatus(403);
            }
            if (!fs.existsSync(fullPath)) {
                return response.sendStatus(404);
            }
            invalidateFirefoxCache(filePath, request, response);
            return response.sendFile(filePath, { root: directory });
        } catch {
            return response.sendStatus(500);
        }
    };
}

function createExtensionsRouteHandler(directoryFn, { immutable = false } = {}) {
    return async (request, response) => {
        try {
            const filePath = decodeURIComponent(request.params[0]);
            for (const directory of [directoryFn(request), PUBLIC_DIRECTORIES.globalExtensions]) {
                const fullPath = path.join(directory, filePath);
                if (!isPathUnderParent(directory, path.resolve(fullPath))) {
                    return response.sendStatus(403);
                }
                if (fs.existsSync(fullPath)) {
                    return response.sendFile(filePath, {
                        root: directory,
                        etag: true,
                        lastModified: true,
                        headers: {
                            'Cache-Control': immutable
                                ? IMMUTABLE_ASSET_CACHE_CONTROL
                                : REVALIDATED_ASSET_CACHE_CONTROL,
                        },
                    });
                }
            }
            return response.sendStatus(404);
        } catch {
            return response.sendStatus(500);
        }
    };
}

export function createVersionedExtensionsRouter() {
    const versionedRouter = express.Router();
    versionedRouter.use(
        '/scripts/extensions/third-party/*',
        extensionsEnabledFeatureGuard,
        createExtensionsRouteHandler(request => request.user.directories.extensions, { immutable: true }),
    );
    return versionedRouter;
}

export const router = express.Router();
router.use('/backgrounds/*', createRouteHandler(request => request.user.directories.backgrounds));
router.use('/characters/*', createRouteHandler(request => request.user.directories.characters));
router.use('/User%20Avatars/*', createRouteHandler(request => request.user.directories.avatars));
router.use('/assets/*', createRouteHandler(request => request.user.directories.assets));
router.use('/user/images/*', createRouteHandler(request => request.user.directories.userImages));
router.use('/user/files/*', createRouteHandler(request => request.user.directories.files));
router.use('/scripts/extensions/third-party/*', extensionsEnabledFeatureGuard, createExtensionsRouteHandler(request => request.user.directories.extensions));
