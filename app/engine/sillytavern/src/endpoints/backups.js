import express from 'express';
import fs, { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import sanitize from 'sanitize-filename';
import { CHAT_BACKUPS_PREFIX, getChatInfo } from './chats.js';
import { inspectChatBackups } from '../nora-world-core/storage-inventory.js';
import { chatBackupStore, chatBackupStatus } from '../chat-backup-runtime.js';
import { resolveStoryLedger } from '../nora-story-ledger/runtime.js';

export const router = express.Router();
const inventoryRequests = new Map();
const managedId = name => /^chat_nora1_([a-f0-9-]{36})\.jsonl$/i.exec(String(name))?.[1]?.toLowerCase();

function backupError(response, error) {
    const code = error.code || 'NORA_BACKUP_OPERATION_FAILED';
    const status = error.status || (code === 'ENOENT' ? 404 : code.startsWith('NORA_BACKUP_INVALID_') ? 400
        : code.startsWith('NORA_BACKUP_RESTORE_') || ['NORA_BACKUP_PROTECTED', 'NORA_BACKUP_CHANGED', 'NORA_BACKUP_UNSAFE_PATH', 'NORA_BACKUP_UNSAFE_FILE'].includes(code) ? 409 : 500);
    return response.status(status).json({ error: code });
}

router.post('/chat/managed', async (request, response) => {
    try {
        response.set('Cache-Control', 'no-store');
        const directories = request.user.directories;
        return response.json({ ...await chatBackupStore(directories).list(), status: chatBackupStatus(directories) });
    } catch (error) { return backupError(response, error); }
});

router.post('/chat/read', async (request, response) => {
    try {
        response.set('Cache-Control', 'no-store');
        const { id, sha256, offset, limit } = request.body || {};
        return response.json(await chatBackupStore(request.user.directories).inspect({ id, sha256, offset, limit }));
    } catch (error) { return backupError(response, error); }
});

router.post('/chat/restore-preview', async (request, response) => {
    try {
        response.set('Cache-Control', 'no-store');
        const { id, worldId, sessionId } = request.body || {};
        return response.json(await chatBackupStore(request.user.directories).previewRestore({ id, worldId, sessionId }));
    } catch (error) { return backupError(response, error); }
});

router.post('/chat/restore', async (request, response) => {
    try {
        response.set('Cache-Control', 'no-store');
        const { id, worldId, sessionId, sha256, expectedRevision } = request.body || {};
        const runtime = resolveStoryLedger(request.user.directories, { recoverProjection: false });
        return response.json(await runtime.restore({ worldId, sessionId }, { id, sha256, expectedRevision }));
    } catch (error) { return backupError(response, error); }
});

router.post('/chat/protect', async (request, response) => {
    try {
        return response.json(await chatBackupStore(request.user.directories).protect(request.body.id, request.body.protected, request.body.sha256));
    } catch (error) { return backupError(response, error); }
});

router.post('/chat/remove', async (request, response) => {
    try {
        return response.json(await chatBackupStore(request.user.directories).remove(request.body.id, request.body.sha256));
    } catch (error) { return backupError(response, error); }
});

router.post('/chat/snapshot', async (request, response) => {
    try {
        const data = await chatBackupStore(request.user.directories).download(request.body.id, request.body.sha256);
        response.set('Cache-Control', 'no-store');
        response.attachment(`chat_nora1_${request.body.id}.jsonl`);
        return response.send(data);
    } catch (error) { return backupError(response, error); }
});

// Separate metadata contract: preserve ST's /chat/get array and restore flow.
// Concurrent requests for the same authenticated user share one bounded scan.
router.post('/chat/inventory', async (request, response) => {
    const directories = request.user.directories;
    const key = path.resolve(directories.root);
    try {
        if (!inventoryRequests.has(key)) {
            inventoryRequests.set(key, inspectChatBackups(directories).finally(() => inventoryRequests.delete(key)));
        }
        return response.json(await inventoryRequests.get(key));
    } catch (error) {
        console.warn('[Backup inventory] Failed:', error?.code || 'READ_FAILED');
        return response.status(500).json({ error: 'NORA_BACKUP_INVENTORY_UNAVAILABLE' });
    }
});

router.post('/chat/get', async (request, response) => {
    try {
        const backupModels = [];
        const backupFiles = await fsPromises
            .readdir(request.user.directories.backups, { withFileTypes: true })
            .then(d => d.filter(d => d.isFile() && path.extname(d.name) === '.jsonl' && d.name.startsWith(CHAT_BACKUPS_PREFIX)).map(d => d.name));

        for (const name of backupFiles) {
            const filePath = path.join(request.user.directories.backups, name);
            const info = await getChatInfo(filePath);
            if (!info || !info.file_name) {
                continue;
            }
            backupModels.push(info);
        }

        return response.json(backupModels);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/chat/delete', async (request, response) => {
    try {
        const { name } = request.body;
        if (typeof name !== 'string' || name !== sanitize(name) || !name.endsWith('.jsonl')) return response.sendStatus(400);
        if (managedId(name)) {
            await chatBackupStore(request.user.directories).remove(managedId(name));
            return response.sendStatus(200);
        }
        const filePath = path.join(request.user.directories.backups, sanitize(name));

        if (!path.parse(filePath).base.startsWith(CHAT_BACKUPS_PREFIX)) {
            console.warn('Attempt to delete non-chat backup file:', name);
            return response.sendStatus(400);
        }

        if (!fs.existsSync(filePath)) {
            return response.sendStatus(404);
        }

        await fsPromises.unlink(filePath);
        return response.sendStatus(200);
    } catch (error) {
        return backupError(response, error);
    }
});

router.post('/chat/download', async (request, response) => {
    try {
        const { name } = request.body;
        if (typeof name !== 'string' || name !== sanitize(name) || !name.endsWith('.jsonl')) return response.sendStatus(400);
        if (managedId(name)) {
            const data = await chatBackupStore(request.user.directories).download(managedId(name));
            response.attachment(String(name));
            return response.send(data);
        }
        const filePath = path.join(request.user.directories.backups, sanitize(name));

        if (!path.parse(filePath).base.startsWith(CHAT_BACKUPS_PREFIX)) {
            console.warn('Attempt to download non-chat backup file:', name);
            return response.sendStatus(400);
        }

        if (!fs.existsSync(filePath)) {
            return response.sendStatus(404);
        }

        return response.download(filePath);
    } catch (error) {
        return backupError(response, error);
    }
});
