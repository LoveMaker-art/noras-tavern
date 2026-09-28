import crypto from 'node:crypto';

/** Hash exactly the committed JSONL, including its metadata header. */
export function getChatRevision(chatData) {
    return crypto.createHash('sha256')
        .update(chatData.map(message => JSON.stringify(message)).join('\n'))
        .digest('hex');
}
