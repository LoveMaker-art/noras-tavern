import { chat, getGeneratingApi } from '../script.js';
import { getStringHash } from './utils.js';
import { decodeTextTokens, getTokenizerBestMatch } from './tokenizers.js';

const MAX_MESSAGE_LOGPROBS = 100;

/** @typedef {[string, number]} Candidate */

/**
 * @typedef {Object} TokenLogprobs
 * @property {string} token
 * @property {Candidate[]} topLogprobs
 */

/**
 * @typedef {Object} MessageLogprobData
 * @property {number} created
 * @property {number} hash
 * @property {number} messageId
 * @property {number} swipeId
 * @property {string} api
 * @property {TokenLogprobs[]} messageLogprobs
 * @property {string | null} continueFrom
 */

/** @type {Map<number, MessageLogprobData>} */
const messageLogprobs = new Map();

/**
 * Retains token-probability data for compatibility without exposing ST's viewer UI.
 * @param {TokenLogprobs[]} logprobs
 * @param {string | null} continueFrom
 */
export function saveLogprobsForActiveMessage(logprobs, continueFrom) {
    if (!logprobs || chat.length === 0) return;

    if (getGeneratingApi() === 'novel') {
        convertTokenIdLogprobsToText(logprobs);
    }

    const messageId = chat.length - 1;
    const message = chat[messageId];
    const data = {
        created: Date.now(),
        api: getGeneratingApi(),
        messageId,
        swipeId: message.swipe_id,
        messageLogprobs: logprobs,
        continueFrom,
        hash: getMessageHash(message),
    };
    messageLogprobs.set(data.hash, data);

    const expired = Array.from(messageLogprobs.values())
        .sort((a, b) => b.created - a.created)
        .slice(MAX_MESSAGE_LOGPROBS);
    for (const item of expired) messageLogprobs.delete(item.hash);
}

/**
 * Returns the stored probability data for the active message.
 * @returns {MessageLogprobData | null}
 */
export function getLogprobsForActiveMessage() {
    if (chat.length === 0) return null;
    return messageLogprobs.get(getMessageHash(chat[chat.length - 1])) ?? null;
}

function getMessageHash(message) {
    return getStringHash(JSON.stringify({
        name: message.name,
        mid: chat.indexOf(message),
        text: message.mes,
    }));
}

function convertTokenIdLogprobsToText(input) {
    const api = getGeneratingApi();
    if (api !== 'novel') {
        throw new Error('convertTokenIdLogprobsToText should only be called for NovelAI');
    }

    const tokenizerId = getTokenizerBestMatch(api);
    const tokenIds = Array.from(new Set(input.flatMap(logprobs =>
        logprobs.topLogprobs.map(([token]) => token).concat(logprobs.token),
    )));
    const { chunks } = decodeTextTokens(tokenizerId, tokenIds);
    const tokenIdText = new Map(tokenIds.map((id, index) => [id, chunks[index]]));

    input.forEach(logprobs => {
        logprobs.token = tokenIdText.get(logprobs.token);
        logprobs.topLogprobs = logprobs.topLogprobs.map(([token, logprob]) =>
            [tokenIdText.get(token), logprob],
        );
    });
}
